import fs from 'node:fs';
import assert from 'node:assert/strict';

const proof = JSON.parse(fs.readFileSync('PROOFS.json', 'utf8'));
const {address, source_commit: commit, source, transactions, audit, before_draw: before} = proof;
assert(proof.verified && proof.offchain_bls_verified && source.source_match);
assert.deepEqual(transactions.map(t => t.step), ['deploy', 'register', 'draw']);
assert(transactions.every(t => t.receipt.committed && t.receipt.status === 'FINALIZED'));
assert(before.draw === null);
assert.deepEqual(before.commitment, audit.commitment);
assert.notEqual(transactions[1].signer, transactions[2].signer);
assert(proof.row_checks.length === audit.commitment.sample_count && proof.row_checks.every(row => row.valid));
assert(Object.values(proof.rejections).every(Boolean));

const repository = 'https://github.com/Starling-spell/beacon-audit-sampler';
const explorer = 'https://explorer-studio.genlayer.com';
const deployed = '[StudioNet contract](' + explorer + '/address/' + address + ')';
const sourceLink = '[Exact deployed source](' + repository + '/blob/' + commit + '/contracts/BeaconAuditSampler.py)';
const labels = {deploy: 'Deploy contract', register: 'Commit inventory before the beacon', draw: 'Draw from a different account'};
const txLink = t => '[' + labels[t.step] + '](' + explorer + '/tx/' + t.hash + ')';
const {round, scheduled_at: scheduled, registered_at: registered, root, audit_id: auditId} = audit.commitment;
const indexes = audit.draw.selected.join(', ');

fs.writeFileSync('LIVE_PROOFS.md', [
  '# StudioNet evidence', '',
  '- ' + deployed,
  '- ' + sourceLink,
  '- [Verified receipts and readbacks](PROOFS.json)',
  '- [Pinned synthetic inventory](' + repository + '/blob/' + commit + '/examples/inventory.json)',
  '- [Quicknet round ' + round + '](https://api.drand.sh/' + audit.commitment.quicknet + '/public/' + round + ')',
  '', '| Finalized transaction | Result | Validator agree votes |', '|---|---|---:|',
  ...transactions.map(t => '| ' + txLink(t) + ' | ' + t.receipt.execution + ' | ' + t.receipt.agree_votes + ' |'),
  '',
  'Audit ID **' + auditId + '**',
  '',
  'Merkle root **' + root + '**',
  '',
  'Deployed source SHA-256 **' + source.sha256 + '**',
  '',
  'The chain registered the inventory ' + (scheduled - registered) + ' seconds before the committed round. A different account triggered the draw, and the contract selected zero-based indexes **' + indexes + '**.',
  '',
  'The proof script independently verified the recorded Quicknet BLS signature against the pinned public key and reproduced the sample using a full shuffle. The contract checked the exact round and signature digest from both HTTPS relays.',
  '',
  '| Check | Result |', '|---|---|',
  ...proof.row_checks.map(row => '| Merkle proof at selected index ' + row.index + ' | Accepted |'),
  '| Altered row bytes | Rejected |',
  '| Altered Merkle path | Rejected |',
  '| Valid proof at unselected index | Rejected |', '',
].join('\n'));

const description = [
  'BeaconAuditSampler selects audit rows from a dataset committed before a future drand Quicknet round. A publisher fixes the Merkle root, row count, sample size, and round. After release, any account can trigger the draw.',
  'GenLayer validators independently fetch the exact pulse from two HTTPS relays and require exact agreement on the round, signature, and derived randomness. The contract uses rejection sampling and a partial Fisher–Yates shuffle to pick distinct row indexes. A Merkle proof binds each inspected row to its selected index and the original root.',
  'StudioNet verified a pre-round commitment, a draw by a second account, and ' + audit.commitment.sample_count +
    ' selected row proofs. Altered rows, altered paths, and unselected indexes were rejected. The live proof script independently verified the BLS signature offchain. The contract uses relay agreement and signature digest checks.',
].join('\n\n');
assert(description.length <= 1000);
fs.writeFileSync('SUBMISSION.md', [
  '# BeaconAuditSampler', '', '**Contribution type** Builder → Intelligent Contracts', '',
  '**Description**', '', description, '',
  '**Evidence**', '', '- [GitHub repository](' + repository + ')', '- ' + sourceLink, '- ' + deployed,
  '- [Live proof matrix](' + repository + '/blob/main/LIVE_PROOFS.md)',
  ...transactions.map(t => '- ' + txLink(t)), '',
].join('\n'));
