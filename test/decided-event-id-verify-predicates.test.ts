// scripts/verify-decided-event-id.sql, one predicate at a time (D-078 item 3, code exchange F2). Every case starts from a VALID non-NULL pointer (the migration run on good data), corrupts exactly one
// property, and runs ONLY the verification SQL. Each must return exactly that proposal. Before this file, the wrong-event fixtures all began from a NULL pointer, so `decided_event_id IS NULL`
// failed them whatever the other predicates said.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";

const ROOT = join(import.meta.dirname, "..");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const MIGRATION = norm(readFileSync(join(ROOT, "migrations", "0023_decided_event_id.sql"), "utf8"));
const VERIFY = norm(readFileSync(join(ROOT, "scripts", "verify-decided-event-id.sql"), "utf8"));

const DETAIL = (id: number) => `proposal ${id} (resolution) passed: yes=4 no=0 abstain=1 eligible=5`;
let seq = 0;

type Fx = { d1: LocalD1; id: number; ev: number; who: number; other: number; at: number };
function validFixture(): Fx {
  const d1 = createLocalD1();
  d1.raw.exec("ALTER TABLE proposals DROP COLUMN decided_event_id");
  const who = insertCitizen(d1);
  const other = insertCitizen(d1);
  const at = 7_000_000;
  const id = insertProposal(d1, { kind: "resolution", status: "passed", proposer_id: who });
  d1.raw.prepare("UPDATE proposals SET tally_yes = 4, tally_no = 0, tally_abstain = 1, eligible_count = 5, tallied_at = ? WHERE id = ?").run(at, id);
  seq++;
  const ev = Number(
    d1.raw
      .prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, 'proposal_decided', ?, ?, ?, ?)")
      .run(who, DETAIL(id), at, `vp${seq}`, `vh${seq}`).lastInsertRowid,
  );
  d1.raw.exec(MIGRATION);
  return { d1, id, ev, who, other, at };
}
const offenders = (d1: LocalD1) => (d1.raw.prepare(VERIFY).all() as { id: number }[]).map((r) => r.id);

test("baseline: a valid non-NULL pointer verifies clean", () => {
  const f = validFixture();
  try {
    assert.notEqual((f.d1.raw.prepare("SELECT decided_event_id AS p FROM proposals WHERE id = ?").get(f.id) as { p: number | null }).p, null);
    assert.deepEqual(offenders(f.d1), []);
  } finally {
    f.d1.close();
  }
});

const corruptions: Record<string, (f: Fx) => void> = {
  "event actor is not the proposer": (f) => f.d1.raw.prepare("UPDATE identity_events SET citizen_id = ? WHERE id = ?").run(f.other, f.ev),
  "event detail counts differ": (f) => f.d1.raw.prepare("UPDATE identity_events SET detail = ? WHERE id = ?").run(`proposal ${f.id} (resolution) passed: yes=3 no=0 abstain=1 eligible=5`, f.ev),
  "event detail names another proposal kind": (f) => f.d1.raw.prepare("UPDATE identity_events SET detail = ? WHERE id = ?").run(`proposal ${f.id} (set_name) passed: yes=4 no=0 abstain=1 eligible=5`, f.ev),
  "event detail records another outcome": (f) => f.d1.raw.prepare("UPDATE identity_events SET detail = ? WHERE id = ?").run(`proposal ${f.id} (resolution) failed: yes=4 no=0 abstain=1 eligible=5`, f.ev),
  "event is unsealed (hash NULL)": (f) => f.d1.raw.prepare("UPDATE identity_events SET hash = NULL WHERE id = ?").run(f.ev),
  "a tally field is NULL": (f) => f.d1.raw.prepare("UPDATE proposals SET tally_abstain = NULL WHERE id = ?").run(f.id),
  "event created_at is not tallied_at": (f) => f.d1.raw.prepare("UPDATE identity_events SET created_at = created_at + 1 WHERE id = ?").run(f.ev),
  "a second candidate event exists while the pointer stays": (f) => {
    seq++;
    f.d1.raw
      .prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, 'proposal_decided', ?, ?, ?, ?)")
      .run(f.who, DETAIL(f.id), f.at, `vp${seq}`, `vh${seq}`);
  },
  "the pointer names an event of another kind": (f) => f.d1.raw.prepare("UPDATE identity_events SET kind = 'key_rotation' WHERE id = ?").run(f.ev),
  "the pointer is NULL on a decided row": (f) => f.d1.raw.prepare("UPDATE proposals SET decided_event_id = NULL WHERE id = ?").run(f.id),
  "the pointer names no event": (f) => f.d1.raw.prepare("UPDATE proposals SET decided_event_id = 999999 WHERE id = ?").run(f.id),
};

for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`verification, one predicate at a time: ${name} returns exactly that proposal`, () => {
    const f = validFixture();
    try {
      assert.deepEqual(offenders(f.d1), [], "starts valid");
      corrupt(f);
      assert.deepEqual(offenders(f.d1), [f.id]);
    } finally {
      f.d1.close();
    }
  });
}
