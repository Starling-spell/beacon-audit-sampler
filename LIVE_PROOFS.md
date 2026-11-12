# StudioNet evidence

- [StudioNet contract](https://explorer-studio.genlayer.com/address/0xaDE0DbE7a88Ebc44F6f74D7138980C9bE5BF831D)
- [Exact deployed source](https://github.com/Starling-spell/beacon-audit-sampler/blob/b8b8c4d4b0968a504fbef6edb4e9a7175b5018a1/contracts/BeaconAuditSampler.py)
- [Verified receipts and readbacks](PROOFS.json)
- [Pinned synthetic inventory](https://github.com/Starling-spell/beacon-audit-sampler/blob/b8b8c4d4b0968a504fbef6edb4e9a7175b5018a1/examples/inventory.json)
- [Quicknet round 33887154](https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/33887154)

| Finalized transaction | Result | Validator agree votes |
|---|---|---:|
| [Deploy contract](https://explorer-studio.genlayer.com/tx/0x760890945404d60d54794933700a4a4222b0c75688506bdb6db1e629018aa253) | SUCCESS | 3 |
| [Commit inventory before the beacon](https://explorer-studio.genlayer.com/tx/0xef3330fe9a5298c5d2114a24b849ffbd634d41eb7b08ab5d133c3471d2e9a918) | SUCCESS | 3 |
| [Draw from a different account](https://explorer-studio.genlayer.com/tx/0x57122dc4c4ed89816de0e2d0a70a23622811849ad97d4667493907409d01416f) | SUCCESS | 3 |

Audit ID **5e3209e1ccaa48c63307a3cfad32de742e91f4e16377df8a6e808b6f1211a111**

Merkle root **bf3354b8f90ec64bad5bae9cdc118fdc17658a9bc178e5ad9f24012854c8ef1f**

Deployed source SHA-256 **64c0cce203a21729e39fb4ae5a3e0dd7302a14ec5c3245f8f4c414c7450d1d1a**

The chain registered the inventory 169 seconds before the committed round. A different account triggered the draw, and the contract selected zero-based indexes **4, 7, 1**.

The proof script independently verified the recorded Quicknet BLS signature against the pinned public key and reproduced the sample using a full shuffle. The contract checked the exact round and signature digest from both HTTPS relays.

| Check | Result |
|---|---|
| Merkle proof at selected index 4 | Accepted |
| Merkle proof at selected index 7 | Accepted |
| Merkle proof at selected index 1 | Accepted |
| Altered row bytes | Rejected |
| Altered Merkle path | Rejected |
| Valid proof at unselected index | Rejected |
