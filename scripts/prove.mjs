import fs from 'node:fs';
import {spawn, execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bls12_381} from '@noble/curves/bls12-381';
import {rpc, receipt, source, read, digest, sha} from './check.mjs';

const chain = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const publicKey = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';
const genesis = 1692803367;
const batch = 'inventory-demo-v1';
const code = 'contracts/BeaconAuditSampler.py';
const publisher = {name: 'studio-proof-deployer', address: '0x7a413BB4AB62E31d62d4cD9efC8C8a8Dae37FB42'};
const auditor = {name: 'fairresolve-demo', address: '0x34346773a22564cbcc5F1D67D1c1F9f196DaEA35'};
const journal = 'PROOFS.json';
const commit = process.argv[2];
const verifyOnly = process.argv.includes('--verify-only');
assert(/^[a-f0-9]{40}$/.test(commit ?? ''));
const proof = fs.existsSync(journal)
  ? JSON.parse(fs.readFileSync(journal, 'utf8'))
  : {network: 'StudioNet', source_commit: commit, transactions: []};
assert.equal(proof.source_commit, commit);
const save = () => fs.writeFileSync(journal, JSON.stringify(proof, null, 2) + '\n');

function send(args, signer, entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/run-cli.cjs', ...args], {
      windowsHide: true,
      env: {...process.env, BEACON_TEST_ACCOUNT: signer.name},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      const lines = (pending + chunk.toString()).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const matched = /^BROADCAST_HASH (0x[0-9a-f]{64})$/i.exec(line);
        if (matched) {
          entry.hash = matched[1];
          save();
          console.log(entry.step, entry.hash);
        }
      }
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
}

async function transaction(step, args, signer) {
  let entry = proof.transactions.find(item => item.step === step);
  if (!entry) {
    assert(!verifyOnly, 'Verification requires an original broadcast journal');
    const nonce = await rpc('eth_getTransactionCount', [signer.address, 'latest']);
    assert.equal(await rpc('eth_getTransactionCount', [signer.address, 'pending']), nonce);
    entry = {step, args, signer: signer.address, nonce};
    proof.transactions.push(entry);
    save();
    await send(args, signer, entry);
  }
  assert.deepEqual(entry.args, args);
  assert.equal(entry.signer, signer.address);
  assert(entry.hash, 'Broadcast status unknown. Inspect account history before any retry.');
  entry.receipt = await receipt(entry.hash);
  save();
  assert(entry.receipt.committed, 'Transaction did not commit');
  const native = await rpc('eth_getTransactionByHash', [entry.hash]);
  assert.equal(native.from_address.toLowerCase(), signer.address.toLowerCase());
  assert.equal(BigInt(native.nonce), BigInt(entry.nonce));
  assert.equal(BigInt(native.value), 0n);
  console.log(step, entry.receipt.status, entry.receipt.execution);
  return entry.receipt.address;
}

const hash = data => createHash('sha256').update(data).digest();
function merkle(rows) {
  const depth = Math.ceil(Math.log2(rows.length));
  const leaves = Array.from({length: 2 ** depth}, (_, i) => {
    const prefix = Buffer.alloc(5);
    prefix.writeUInt32BE(i, 1);
    return hash(Buffer.concat([prefix, hash(Buffer.from(rows[i] ?? '', 'utf8'))]));
  });
  const levels = [leaves];
  for (let current = leaves; current.length > 1; ) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hash(Buffer.concat([Buffer.from([1]), current[i], current[i + 1]])));
    }
    levels.push(next);
    current = next;
  }
  return {
    root: levels.at(-1)[0].toString('hex'),
    paths: rows.map((_, i) => levels.slice(0, -1)
      .map((level, height) => level[(i >> height) ^ 1].toString('hex')).join('')),
  };
}

function referenceSample(commitment, randomness) {
  const seed = hash(Buffer.concat([
    Buffer.from('beacon-audit-sampler/v1\0'),
    Buffer.from(commitment.commitment + randomness, 'hex'),
  ]));
  const deck = Array.from({length: commitment.row_count}, (_, index) => index);
  let counter = 0n;
  for (let i = 0; i < commitment.sample_count; i++) {
    const range = BigInt(deck.length - i);
    let word;
    do {
      const counterBytes = Buffer.alloc(8);
      counterBytes.writeBigUInt64BE(counter++);
      word = BigInt('0x' + sha(Buffer.concat([seed, counterBytes])));
    } while (word >= (1n << 256n) / range * range);
    const chosen = i + Number(word % range);
    [deck[i], deck[chosen]] = [deck[chosen], deck[i]];
  }
  return deck.slice(0, commitment.sample_count);
}

assert.equal(await rpc('eth_chainId', []), '0xf22f');
proof.address = await transaction('deploy', ['deploy', '--contract', code], publisher);
proof.source = await source(proof.address);
save();

const safeDir = 'safe.directory=' + process.cwd().replaceAll('\\', '/');
const rows = JSON.parse(execFileSync('git', ['-c', safeDir, 'show', commit + ':examples/inventory.json'], {encoding: 'utf8'}));
const {root, paths} = merkle(rows);
const sampleCount = 3;
proof.round ??= Math.ceil((Date.now() / 1000 + 180 - genesis) / 3) + 1;
save();
const round = proof.round;
const scheduled = genesis + (round - 1) * 3;
assert.equal(await transaction('register', ['write', proof.address, 'register', '--args',
  batch, root, String(rows.length), String(sampleCount), String(round)], publisher), proof.address);
const context = {contract: proof.address, chain_id: 61999, publisher: publisher.address, batch};
const auditId = digest(context);
const preDraw = await read(proof.address, 'get_audit', [auditId]);
const committedAt = preDraw.commitment.registered_at;
const commitment = {audit_id: auditId, ...context, root, row_count: rows.length, sample_count: sampleCount,
  quicknet: chain, round, registered_at: committedAt, scheduled_at: scheduled};
assert(scheduled - committedAt >= 90 && scheduled - committedAt <= 1800);
assert.deepEqual(preDraw.commitment, {...commitment, commitment: digest(commitment)});
if (!proof.transactions.some(t => t.step === 'draw')) {
  assert.equal(preDraw.draw, null);
  proof.before_draw = preDraw;
}
save();

if (!proof.transactions.some(t => t.step === 'draw')) {
  assert(!verifyOnly);
  console.log('Waiting for scheduled Quicknet round', round);
  const readyAt = (scheduled + 15) * 1000;
  while (Date.now() < readyAt) {
    await new Promise(resolve => setTimeout(resolve, Math.min(15000, readyAt - Date.now())));
  }
}
assert.equal(await transaction('draw', ['write', proof.address, 'draw', '--args', auditId], auditor), proof.address);
const audit = await read(proof.address, 'get_audit', [auditId]);
proof.audit = audit;
save();
assert.deepEqual(audit.commitment, preDraw.commitment);
const {pulse, selected} = audit.draw;
assert.equal(pulse.round, round);
assert.match(pulse.signature, /^[0-9a-f]{96}$/);
assert.equal(pulse.randomness, sha(Buffer.from(pulse.signature, 'hex')));

// This verifies BLS for the evidence bundle. The contract uses HTTPS relay agreement.
const roundBytes = Buffer.alloc(8);
roundBytes.writeBigUInt64BE(BigInt(round));
assert(bls12_381.verifyShortSignature(pulse.signature, hash(roundBytes), publicKey, {
  DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
}));
proof.offchain_bls_verified = true;
assert.deepEqual(selected, referenceSample(audit.commitment, pulse.randomness));
assert.equal(new Set(selected).size, sampleCount);
proof.row_checks = [];
for (const index of selected) {
  const row = rows[index];
  const siblings = paths[index];
  const valid = await read(proof.address, 'verify_row', [auditId, index, row, siblings]);
  assert.equal(valid, true);
  proof.row_checks.push({index, row, siblings, valid});
  save();
}
const first = selected[0];
const unselected = rows.findIndex((_, index) => !selected.includes(index));
const path = paths[first];
const badPath = (path[0] === '0' ? '1' : '0') + path.slice(1);
proof.rejections = {
  altered_row: (await read(proof.address, 'verify_row', [auditId, first, rows[first] + '!', path])) === false,
  altered_path: (await read(proof.address, 'verify_row', [auditId, first, rows[first], badPath])) === false,
  unselected_row: (await read(proof.address, 'verify_row', [auditId, unselected, rows[unselected], paths[unselected]])) === false,
};
assert(Object.values(proof.rejections).every(Boolean));
const history = await rpc('sim_getTransactionsForAddress', [proof.address]);
assert.deepEqual(history.map(t => t.hash).sort(), proof.transactions.map(t => t.hash).sort());
proof.verified = true;
save();
console.log('Verified BLS, sampled indexes, all selected row proofs, and three negative checks.');
