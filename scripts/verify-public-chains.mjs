// Independent public-data witness: deliberately imports no application code.
// Node >= 22.6. Run with --live [snapshot-directory], a snapshot directory,
// or --self-test. All network requests are unauthenticated reads.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const origin = 'https://commonhold.randommonicle.workers.dev';
const genesis = '0'.repeat(64);
const chains = [
  { name: 'identity_log', file: 'events.json', key: 'events', path: '/api/events',
    fields: ['citizen_id', 'kind', 'detail', 'created_at'] },
  { name: 'treasury', file: 'treasury.json', key: 'entries', path: '/treasury',
    fields: ['entry_date', 'description', 'amount_cents', 'created_at'] },
];
const digest = (previous, payload) => createHash('sha256')
  .update(previous + '\n' + JSON.stringify(payload), 'utf8').digest('hex');

function verify(rows, published, fields) {
  assert.ok(Array.isArray(rows), 'rows must be an array');
  assert.ok(rows.length > 0, 'empty chain is not a useful witness');
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  let previous = genesis;
  let lastId = 0;
  for (const row of ordered) {
    assert.ok(Number.isSafeInteger(row.id) && row.id > lastId,
      `invalid or duplicate row id ${row.id}`);
    assert.equal(row.prev_hash, previous, `predecessor mismatch at row ${row.id}`);
    for (const field of fields) {
      assert.ok(Object.hasOwn(row, field), `missing ${field} at row ${row.id}`);
    }
    const calculated = digest(previous, fields.map(field => row[field] ?? null));
    assert.equal(calculated, row.hash, `hash mismatch at row ${row.id}`);
    previous = calculated;
    lastId = row.id;
  }
  assert.equal(ordered.length, published.total_rows, 'incomplete public row set');
  assert.equal(previous, published.head, `published head mismatch after row ${lastId}`);
  return { rows: ordered.length, through_id: lastId, head: previous, matches: true };
}

function checkSnapshot(attestation, data) {
  return Object.fromEntries(chains.map(chain => [chain.name,
    verify(data[chain.name][chain.key], attestation[chain.name], chain.fields)]));
}

async function get(path) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

function selfTest() {
  // A valid fixture plus changes that must fail; no server verifier involved.
  const fields = ['detail'];
  const first = { id: 1, detail: 'quote " / newline\n / unicode café 🤖', prev_hash: genesis };
  first.hash = digest(first.prev_hash, [first.detail]);
  const second = { id: 3, detail: null, prev_hash: first.hash };
  second.hash = digest(second.prev_hash, [second.detail]);
  const rows = [second, first]; // API order may be newest first; id gaps are allowed.
  const published = { total_rows: 2, head: second.hash };
  assert.equal(verify(rows, published, fields).through_id, 3);
  const cases = [
    ['altered payload', list => { list[1].detail += '!'; }, /hash mismatch at row 1/],
    ['broken link', list => { list[0].prev_hash = genesis; }, /predecessor mismatch at row 3/],
    ['missing row', list => { list.splice(1, 1); }, /predecessor mismatch/],
    ['duplicate id', list => { list[0].id = 1; }, /mismatch|duplicate/],
    ['missing field', list => { delete list[1].detail; }, /missing detail/],
  ];
  for (const [name, mutate, expected] of cases) {
    const copy = structuredClone(rows);
    mutate(copy);
    assert.throws(() => verify(copy, published, fields), expected, name);
  }
  assert.throws(() => verify(rows, { ...published, head: genesis }, fields), /head mismatch/);
  assert.throws(() => verify(rows, { ...published, total_rows: 3 }, fields), /incomplete/);
  assert.throws(() => verify([], { total_rows: 0, head: genesis }, fields), /empty chain/);
  console.log('PASS: valid fixture and 8 rejection cases');
}

async function main() {
  const [mode, destination] = process.argv.slice(2);
  if (mode === '--self-test') return selfTest();
  if (!mode) throw new Error('Usage: node scripts/verify-public-chains.mjs --live [directory] | directory | --self-test');
  let attestation;
  const data = {};
  if (mode === '--live') {
    const before = await get('/api/attest');
    for (const chain of chains) data[chain.name] = await get(chain.path);
    attestation = await get('/api/attest');
    for (const chain of chains) {
      assert.equal(before[chain.name].head, attestation[chain.name].head,
        `${chain.name} changed during collection; rerun for a consistent snapshot`);
    }
  } else {
    attestation = JSON.parse(await readFile(join(mode, 'attest.json'), 'utf8'));
    for (const chain of chains) {
      data[chain.name] = JSON.parse(await readFile(join(mode, chain.file), 'utf8'));
    }
  }
  const result = { verified_at: new Date().toISOString(), origin,
    attestation_checked_at: attestation.checked_at,
    chains: checkSnapshot(attestation, data),
    scope: 'Identity and treasury only. Internal consistency and a saved witness, not independent proof of historical truth or payment.' };
  if (mode === '--live' && destination) {
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'attest.json'), JSON.stringify(attestation, null, 2) + '\n');
    for (const chain of chains) {
      await writeFile(join(destination, chain.file), JSON.stringify(data[chain.name], null, 2) + '\n');
    }
    await writeFile(join(destination, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
