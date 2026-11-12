# BeaconAuditSampler

**Contribution type** Builder → Intelligent Contracts

**Description**

BeaconAuditSampler selects audit rows from a dataset committed before a future drand Quicknet round. A publisher fixes the Merkle root, row count, sample size, and round. After release, any account can trigger the draw.

GenLayer validators independently fetch the exact pulse from two HTTPS relays and require exact agreement on the round, signature, and derived randomness. The contract uses rejection sampling and a partial Fisher–Yates shuffle to pick distinct row indexes. A Merkle proof binds each inspected row to its selected index and the original root.

StudioNet verified a pre-round commitment, a draw by a second account, and 3 selected row proofs. Altered rows, altered paths, and unselected indexes were rejected. The live proof script independently verified the BLS signature offchain. The contract uses relay agreement and signature digest checks.

**Evidence**

- [GitHub repository](https://github.com/Starling-spell/beacon-audit-sampler)
- [Exact deployed source](https://github.com/Starling-spell/beacon-audit-sampler/blob/b8b8c4d4b0968a504fbef6edb4e9a7175b5018a1/contracts/BeaconAuditSampler.py)
- [StudioNet contract](https://explorer-studio.genlayer.com/address/0xaDE0DbE7a88Ebc44F6f74D7138980C9bE5BF831D)
- [Live proof matrix](https://github.com/Starling-spell/beacon-audit-sampler/blob/main/LIVE_PROOFS.md)
- [Deploy contract](https://explorer-studio.genlayer.com/tx/0x760890945404d60d54794933700a4a4222b0c75688506bdb6db1e629018aa253)
- [Commit inventory before the beacon](https://explorer-studio.genlayer.com/tx/0xef3330fe9a5298c5d2114a24b849ffbd634d41eb7b08ab5d133c3471d2e9a918)
- [Draw from a different account](https://explorer-studio.genlayer.com/tx/0x57122dc4c4ed89816de0e2d0a70a23622811849ad97d4667493907409d01416f)
