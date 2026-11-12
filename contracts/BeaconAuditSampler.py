# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
from datetime import datetime, timezone
import hashlib
import json
import re


QUICKNET = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
GENESIS = 1692803367
PERIOD = 3
MIN_LEAD = 90
MAX_LEAD = 1800
RELEASE_GRACE = 12
MIRRORS = ("https://api.drand.sh", "https://drand.cloudflare.com")
DOMAIN = b"beacon-audit-sampler/v1\x00"


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def sha(data):
    return hashlib.sha256(data).digest()


def digest(value):
    return sha(canonical(value).encode("utf-8")).hex()


def fail(message):
    raise gl.vm.UserError("[EXPECTED] " + message)


def now():
    return int(datetime.now(timezone.utc).timestamp())


def release_time(round_number):
    return GENESIS + (round_number - 1) * PERIOD


def hex_text(value, length):
    return isinstance(value, str) and len(value) == length and re.fullmatch(r"[0-9a-fA-F]+", value)


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate beacon JSON key")
        result[key] = value
    return result


def normalize_pulse(data, round_number):
    if not isinstance(data, dict) or type(data.get("round")) is not int or data["round"] != round_number:
        raise ValueError("Unexpected beacon round")
    signature, randomness = data.get("signature"), data.get("randomness")
    if not hex_text(signature, 96) or not hex_text(randomness, 64):
        raise ValueError("Invalid beacon encoding")
    if sha(bytes.fromhex(signature)).hex() != randomness.lower():
        raise ValueError("Invalid beacon randomness digest")
    return {"round": round_number, "signature": signature.lower(), "randomness": randomness.lower()}


def acquire(round_number):
    def evaluate():
        pulses = []
        try:
            for mirror in MIRRORS:
                response = gl.nondet.web.get(f"{mirror}/{QUICKNET}/public/{round_number}")
                if response.status != 200 or not 1 <= len(response.body) <= 2048:
                    raise ValueError("Unexpected beacon response")
                body = json.loads(response.body.decode("utf-8"), object_pairs_hook=unique_keys)
                pulses.append(normalize_pulse(body, round_number))
            if pulses[0] != pulses[1]:
                raise ValueError("Beacon mirrors disagreed")
        except Exception:
            raise gl.vm.UserError("[BEACON_ERROR] Exact Quicknet round unavailable or inconsistent")
        return pulses[0]

    def validator(result):
        if not isinstance(result, gl.vm.Return):
            return False
        try:
            return canonical(evaluate()) == canonical(result.calldata)
        except Exception:
            return False

    pulse = gl.vm.run_nondet_unsafe(evaluate, validator)
    try:
        if canonical(pulse) != canonical(normalize_pulse(pulse, round_number)):
            raise ValueError("Unexpected consensus pulse")
    except Exception:
        raise gl.vm.UserError("[BEACON_ERROR] Invalid consensus pulse")
    return pulse


def sample_indices(commitment, randomness, row_count, sample_count):
    seed = sha(DOMAIN + bytes.fromhex(commitment) + bytes.fromhex(randomness))
    swaps, selected = {}, []
    counter = 0
    space = 1 << 256
    for position in range(sample_count):
        remaining = row_count - position
        cutoff = space - space % remaining
        for _ in range(64):
            word = int.from_bytes(sha(seed + counter.to_bytes(8, "big")), "big")
            counter += 1
            if word < cutoff:
                break
        else:
            fail("Sampling rejection limit reached")
        index = position + word % remaining
        selected.append(swaps.get(index, index))
        swaps[index] = swaps.get(position, position)
    return selected


def row_leaf(index, row):
    return sha(b"\x00" + index.to_bytes(4, "big") + sha(row))


def inclusion(root, row_count, index, row, siblings):
    depth = (row_count - 1).bit_length()
    if len(siblings) != 64 * depth or not re.fullmatch(r"[0-9a-f]*", siblings):
        return False
    node = row_leaf(index, row)
    for level in range(depth):
        neighbor = bytes.fromhex(siblings[64 * level:64 * (level + 1)])
        pair = neighbor + node if (index >> level) & 1 else node + neighbor
        node = sha(b"\x01" + pair)
    return node.hex() == root


class BeaconAuditSampler(gl.Contract):
    commitments: TreeMap[str, str]
    draws: TreeMap[str, str]

    def __init__(self):
        pass

    @gl.public.write
    def register(self, batch: str, root: str, row_count: int, sample_count: int, round_number: int) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", batch):
            fail("Invalid batch key")
        if not hex_text(root, 64) or root != root.lower():
            fail("Invalid Merkle root")
        if type(row_count) is not int or not 2 <= row_count <= 1048576:
            fail("Invalid row count")
        if type(sample_count) is not int or not 1 <= sample_count <= min(row_count, 32):
            fail("Invalid sample count")
        if type(round_number) is not int or not 1 <= round_number < 1 << 53:
            fail("Invalid beacon round")
        context = {"contract": str(gl.message.contract_address), "chain_id": int(gl.message.chain_id),
                   "publisher": str(gl.message.sender_address), "batch": batch}
        audit_id = digest(context)
        if audit_id in self.commitments:
            fail("Batch already committed")
        registered_at = now()
        scheduled_at = release_time(round_number)
        if not MIN_LEAD <= scheduled_at - registered_at <= MAX_LEAD:
            fail("Round must be 90 to 1800 seconds ahead")
        commitment = {"audit_id": audit_id, **context, "root": root, "row_count": row_count,
                      "sample_count": sample_count, "quicknet": QUICKNET, "round": round_number,
                      "registered_at": registered_at, "scheduled_at": scheduled_at}
        commitment["commitment"] = digest(commitment)
        self.commitments[audit_id] = canonical(commitment)
        return audit_id

    @gl.public.view
    def get_audit(self, audit_id: str) -> dict:
        if audit_id not in self.commitments:
            fail("Unknown audit")
        commitment = json.loads(self.commitments[audit_id])
        result = json.loads(self.draws[audit_id]) if audit_id in self.draws else None
        return {"commitment": commitment, "draw": result}

    @gl.public.write
    def draw(self, audit_id: str) -> list[int]:
        record = self.get_audit(audit_id)
        if record["draw"] is not None:
            fail("Audit already drawn")
        commitment = record["commitment"]
        if now() < commitment["scheduled_at"] + RELEASE_GRACE:
            fail("Beacon round is not ready")
        pulse = acquire(commitment["round"])
        selected = sample_indices(commitment["commitment"], pulse["randomness"],
                                  commitment["row_count"], commitment["sample_count"])
        self.draws[audit_id] = canonical({"pulse": pulse, "selected": selected})
        return selected

    @gl.public.view
    def verify_row(self, audit_id: str, index: int, row: str, siblings: str) -> bool:
        record = self.get_audit(audit_id)
        if record["draw"] is None:
            fail("Audit has no draw")
        if type(index) is not int or index not in record["draw"]["selected"]:
            return False
        data = row.encode("utf-8")
        if not 1 <= len(data) <= 1024:
            return False
        commitment = record["commitment"]
        return inclusion(commitment["root"], commitment["row_count"], index, data, siblings)
