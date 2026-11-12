import ast
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest


SOURCE = Path(__file__).resolve().parents[1] / "contracts/BeaconAuditSampler.py"
ROUND = 33877869
AT = 1692803367 + 3 * (ROUND - 1)
SIGNATURE = "a430a1a4698e3adfbe3f389ba3f47886fc645b72e55323eeea1c2a59d1d93c78bee80b210215fdfea926462df5d9420e"


def hashed(data):
    return hashlib.sha256(data).digest()


def pulse(signature=SIGNATURE):
    return {"round": ROUND, "signature": signature, "randomness": hashed(bytes.fromhex(signature)).hex()}


def fixture_tree(rows):
    depth = (len(rows) - 1).bit_length()
    padded = rows + [""] * (2**depth - len(rows))
    levels = [[hashed(bytes([0]) + i.to_bytes(4, "big") + hashed(row.encode()))
               for i, row in enumerate(padded)]]
    for _ in range(depth):
        previous = levels[-1]
        levels.append([hashed(bytes([1]) + previous[i] + previous[i + 1])
                       for i in range(0, len(previous), 2)])
    proofs = ["".join(level[(i >> j) ^ 1].hex() for j, level in enumerate(levels[:-1]))
              for i in range(len(rows))]
    return levels[-1][0].hex(), proofs


@pytest.fixture
def core():
    module = ast.parse(SOURCE.read_text(encoding="utf-8"))
    module.body = [node for node in module.body if not isinstance(node, ast.ClassDef)
                   and not (isinstance(node, ast.ImportFrom) and node.module == "genlayer")]
    ns = {}
    exec(compile(module, str(SOURCE), "exec"), ns)
    return ns


def test_callback_checks_both_relays_and_rejects_substituted_pulse(core):
    original = pulse()
    forged = pulse("ab" * 48)
    supplied = iter([original, original, original, original, original, original, original, forged])
    calls = []

    def get(url):
        calls.append(url)
        return SimpleNamespace(status=200, body=json.dumps(next(supplied)).encode())

    def run(leader, validator):
        result = leader()
        assert validator(SimpleNamespace(calldata=result))
        assert not validator(SimpleNamespace(calldata=forged))
        assert not validator(SimpleNamespace(calldata=result))
        return result

    core["gl"] = SimpleNamespace(
        nondet=SimpleNamespace(web=SimpleNamespace(get=get)),
        vm=SimpleNamespace(Return=SimpleNamespace, UserError=ValueError, run_nondet_unsafe=run),
    )
    assert core["acquire"](ROUND) == original
    assert calls == [f"{relay}/{core['QUICKNET']}/public/{ROUND}" for relay in core["MIRRORS"]] * 4


@pytest.mark.parametrize("override", [{"round": ROUND + 1}, {"round": str(ROUND)},
                                      {"randomness": "0" * 64}, {"signature": "1"}])
def test_invalid_pulse_rejected(core, override):
    with pytest.raises(ValueError):
        core["normalize_pulse"]({**pulse(), **override}, ROUND)


def test_sparse_draw_matches_full_shuffle(core):
    for row_count in [2, 3, 5, 8, 17, 127, 500]:
        for i in range(24):
            commitment = hashed(f"commitment {i}".encode()).hex()
            random = hashed(f"pulse {i}".encode()).hex()
            seed = hashed(core["DOMAIN"] + bytes.fromhex(commitment + random))
            count = min(row_count, 32)
            actual = core["sample_indices"](commitment, random, row_count, count)
            deck = list(range(row_count))
            counter = 0
            for position in range(count):
                bound = row_count - position
                while True:
                    word = int.from_bytes(hashed(seed + counter.to_bytes(8, "big")), "big")
                    counter += 1
                    if word < (1 << 256) // bound * bound:
                        break
                swap = position + word % bound
                deck[position], deck[swap] = deck[swap], deck[position]
            assert actual == deck[:count] and len(set(actual)) == count


def test_rejection_sampling_drops_the_biased_tail(core, monkeypatch):
    words = iter([b"\x55" * 32, b"\xff" * 32, bytes(32)])
    monkeypatch.setitem(core, "sha", lambda _: next(words))
    assert core["sample_indices"]("01" * 32, "02" * 32, 3, 1) == [0]
    with pytest.raises(StopIteration):
        next(words)


def test_merkle_proofs_bind_index_content_and_padding(core):
    rows = ["one", "two", "two", "four", "five"]
    root, proofs = fixture_tree(rows)
    for i, row in enumerate(rows):
        assert core["inclusion"](root, len(rows), i, row.encode(), proofs[i])
        assert not core["inclusion"](root, len(rows), i, (row + "!").encode(), proofs[i])
        assert not core["inclusion"](root, len(rows), i, row.encode(), proofs[i][64:])
    assert not core["inclusion"](root, len(rows), 2, b"two", proofs[1])


def test_live_workflow_in_direct_vm(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(str(SOURCE))
    rows = ["paper", "pen", "water", "cable", "bottle"]
    root, proofs = fixture_tree(rows)

    def warp(stamp):
        direct_vm.warp(datetime.fromtimestamp(stamp, timezone.utc).isoformat())

    direct_vm.sender = direct_alice
    warp(AT - 89)
    with direct_vm.expect_revert("Round must be 90 to 1800 seconds ahead"):
        contract.register("audit", root, 5, 3, ROUND)
    warp(AT - 90)
    audit = contract.register("audit", root, 5, 3, ROUND)
    assert contract.get_audit(audit)["draw"] is None
    with direct_vm.expect_revert("Batch already committed"):
        contract.register("audit", "0" * 64, 5, 3, ROUND + 1)
    with direct_vm.expect_revert("Audit has no draw"):
        contract.verify_row(audit, 0, rows[0], proofs[0])
    direct_vm.sender = direct_bob
    warp(AT + 11)
    with direct_vm.expect_revert("Beacon round is not ready"):
        contract.draw(audit)

    response = {"response": {"status": 200, "headers": {}, "body": json.dumps(pulse()).encode()},
                "method": "GET"}
    direct_vm.mock_web(r"https://(?:api\.drand\.sh|drand\.cloudflare\.com)/.*/public/" + str(ROUND), response)
    warp(AT + 12)
    drawn = contract.draw(audit)
    assert len(drawn) == len(set(drawn)) == 3
    record = contract.get_audit(audit)
    assert record["draw"] == {"pulse": pulse(), "selected": drawn}
    assert record["commitment"]["registered_at"] == AT - 90
    for i, row in enumerate(rows):
        assert contract.verify_row(audit, i, row, proofs[i]) == (i in drawn)
    with direct_vm.expect_revert("Audit already drawn"):
        contract.draw(audit)
