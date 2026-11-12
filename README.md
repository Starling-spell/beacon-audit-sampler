# BeaconAuditSampler

Use a future public randomness pulse to choose an audit sample from a dataset committed in advance. A publisher registers an ordered dataset's Merkle root, row count, sample size, and scheduled drand Quicknet round. Any account can request the draw after release. The result stores the pulse and the ordered list of selected row indexes.

Each GenLayer validator retrieves the exact round from the Protocol Labs and Cloudflare HTTPS relays. It checks the HTTP response, round, signature encoding, and SHA-256 of the signature, then requires both relays and the leader to agree on the full normalized pulse. The round's randomness feeds a partial Fisher–Yates shuffle. Rejection sampling avoids modulo bias, and sparse swaps keep the work proportional to the sample size. [GenLayer nondeterministic execution](https://docs.genlayer.com/developers/intelligent-contracts/features/non-determinism) · [drand HTTP relays](https://docs.drand.love/developer/http-api/)

The publisher chooses a batch key once per account and commits between 90 and 1,800 seconds before release. Auditors should identify the exact publisher and batch key before the round. A publisher can register different keys or use other accounts. The contract relies on the chain transaction timestamp, at least one honest reachable relay, and Quicknet's unpredictability. A mismatched or unavailable pulse leaves the draw pending for the same round. The proof script additionally verifies the recorded Quicknet BLS signature against the pinned public key offchain. The contract itself checks the signature digest and relay agreement.

## Use

1. Construct a tree from the ordered UTF-8 rows. Leaf `i` is `SHA256(0x00 || uint32_be(i) || SHA256(row_bytes))`. Pad the tree to the next power of two with indexed empty rows. Internal nodes are `SHA256(0x01 || left || right)`.
2. Call `register(batch, root, row_count, sample_count, round_number)`. Counts range from 2 to 1,048,576 rows and 1 to 32 samples, with sample count at most row count. The returned audit ID binds the chain, contract, publisher, and batch key.
3. After the round and a 12-second relay grace period, call `draw(audit_id)`. This records one immutable sample and can be triggered by any account.
4. Read `get_audit(audit_id)` and pass each sampled index, original UTF-8 row, and concatenated lowercase sibling hashes to `verify_row(audit_id, index, row, siblings)`. Siblings are ordered from leaf to root. The proof verifies bytes committed before the round. A separate auditor checks factual accuracy and completeness of the source inventory.

The seed is `SHA256("beacon-audit-sampler/v1" || 0x00 || commitment_digest || randomness)`. The digest is SHA-256 of the sorted-key compact ASCII JSON of the stored commitment before its digest field is added. Stream words are `SHA256(seed || uint64_be(counter))`, starting with counter zero. Each step samples an index from the unselected suffix and swaps it into the next output position.

```sh
python -m pip install -r requirements-dev.txt
genvm-lint check contracts/BeaconAuditSampler.py
python -m pytest tests -q
```

Tests cover both-relay verification, a forged pulse with a matching digest, rejection sampling, sparse/full shuffle agreement, timed writes, permissionless drawing, and index-bound Merkle proofs.

[StudioNet contract](https://explorer-studio.genlayer.com/address/0xaDE0DbE7a88Ebc44F6f74D7138980C9bE5BF831D) · [Live proof matrix](LIVE_PROOFS.md) · [Submission text](SUBMISSION.md)
