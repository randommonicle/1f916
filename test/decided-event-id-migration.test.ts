// Migration 0023, decided_event_id (D-078 item 3; drafts/BRIEF-DECIDED-EVENT-ID-2026-11-03.md B2, A2, T5). Real SQLite (node:sqlite) over the committed
// schema.sql with the new column dropped again, then the REAL migration file applied, then scripts/verify-decided-event-id.sql run. Each red-proofed in
// docs/CHECKPOINT-DECIDED-EVENT-ID.md. It proves: the six prod-shaped proposals are linked and nothing else; a decoy `proposal 12 (` event, wrong counts,
// wrong kind, wrong outcome, a missing event, duplicate candidates, a wrong actor and an unsealed event never get linked and the verification names them;
// the legitimate amendment transition (executed now, tallied passed) links and verifies; the verification catches a wrong pointer and a pointer on an open row;
// the backfill is idempotent; schema.sql carries the column last.
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

let seq = 0;
function preMigration(): LocalD1 {
  const d1 = createLocalD1();
  d1.raw.exec("ALTER TABLE proposals DROP COLUMN decided_event_id");
  return d1;
}
function addEvent(d1: LocalD1, citizen: number, createdAt: number, detail: string, opts: { kind?: string; sealed?: boolean } = {}): number {
  seq++;
  const sealed = opts.sealed !== false;
  const r = d1.raw
    .prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)")
    .run(citizen, opts.kind ?? "proposal_decided", detail, createdAt, sealed ? `p${seq}` : null, sealed ? `h${seq}` : null);
  return Number(r.lastInsertRowid);
}
function decidedProposal(d1: LocalD1, proposer: number, kind: string, status: string, t: [number, number, number, number], at: number): number {
  const id = insertProposal(d1, { kind, status, proposer_id: proposer });
  d1.raw
    .prepare("UPDATE proposals SET tally_yes = ?, tally_no = ?, tally_abstain = ?, eligible_count = ?, tallied_at = ? WHERE id = ?")
    .run(t[0], t[1], t[2], t[3], at, id);
  return id;
}
const detailOf = (id: number, kind: string, status: string, t: [number, number, number, number]) =>
  `proposal ${id} (${kind}) ${status}: yes=${t[0]} no=${t[1]} abstain=${t[2]} eligible=${t[3]}`;
const pointer = (d1: LocalD1, id: number) => (d1.raw.prepare("SELECT decided_event_id AS p FROM proposals WHERE id = ?").get(id) as { p: number | null }).p;
const offenders = (d1: LocalD1) => d1.raw.prepare(VERIFY).all() as { id: number }[];

test("0023 on the real six (proposals 1, 2, 5, 6, 7, 8 with events 6, 12, 16, 20, 25, 37) links exactly the decided rows, leaves the open one null, and the verification returns zero rows (mutant: the prefix pattern ' (%' widened to '%')", () => {
  const d1 = preMigration();
  try {
    const who = insertCitizen(d1);
    // The real six: proposals 1, 2, 5, 6, 7, 8 (3 and 4 are gaps) and their events 6, 12, 16, 20, 25, 37, in the real order.
    const spec: Record<number, [string, string, [number, number, number, number], number]> = {
      1: ["resolution", "passed", [4, 0, 1, 5], 6],
      2: ["set_name", "failed", [0, 0, 0, 5], 12],
      5: ["set_name", "failed", [1, 0, 0, 1], 16],
      6: ["set_name", "executed", [4, 0, 0, 5], 20],
      7: ["first_laws_ratify", "executed", [4, 0, 0, 5], 25],
      8: ["resolution", "failed", [0, 0, 5, 13], 37],
    };
    const ids: number[] = [];
    const evs: number[] = [];
    for (let want = 1; want <= 8; want++) {
      const s = spec[want];
      if (!s) {
        insertProposal(d1, { kind: "resolution", status: "open", proposer_id: who });
        continue;
      }
      const at = 1_000_000 + want;
      const id = decidedProposal(d1, who, s[0], s[1], s[2], at);
      assert.equal(id, want);
      let lastEvent = (d1.raw.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM identity_events").get() as { m: number }).m;
      while (lastEvent < s[3] - 1) lastEvent = addEvent(d1, who, 500_000 + lastEvent, "unrelated event", { kind: "key_rotation" });
      const ev = addEvent(d1, who, at, detailOf(id, s[0], s[1], s[2]));
      assert.equal(ev, s[3], `proposal ${id}'s event is the real event ${s[3]}`);
      ids.push(id);
      evs.push(ev);
    }
    d1.raw.exec("DELETE FROM proposals WHERE id IN (3, 4)");
    // A decoy sharing the first proposal's timestamp, whose detail begins `proposal 12 (`: with the id 1 prefix 'proposal 1%' it would match too.
    addEvent(d1, who, 1_000_001, "proposal 12 (resolution) passed: yes=9 no=9 abstain=9 eligible=9");
    const open = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: who });

    d1.raw.exec(MIGRATION);

    ids.forEach((id, i) => assert.equal(pointer(d1, id), evs[i], `proposal ${id} points at its own event`));
    assert.equal(pointer(d1, open), null, "the open proposal stays null");
    assert.deepEqual(offenders(d1), [], "the verification passes");
    assert.ok(
      (d1.raw.prepare("SELECT name FROM pragma_table_info('proposals')").all() as { name: string }[]).some((c) => c.name === "decided_event_id"),
      "the column exists",
    );
  } finally {
    d1.close();
  }
});

test("0023: each wrong event is NOT linked and the verification names the row (wrong counts, wrong kind, wrong outcome, missing event, wrong actor, unsealed)", () => {
  const cases: Record<string, (d1: LocalD1, who: number, other: number, id: number, at: number) => void> = {
    "wrong counts": (d1, who, _o, id, at) => addEvent(d1, who, at, detailOf(id, "resolution", "passed", [3, 0, 1, 5])),
    "wrong kind": (d1, who, _o, id, at) => addEvent(d1, who, at, detailOf(id, "set_name", "passed", [4, 0, 1, 5])),
    "wrong outcome": (d1, who, _o, id, at) => addEvent(d1, who, at, detailOf(id, "resolution", "failed", [4, 0, 1, 5])),
    "missing event": () => {},
    "wrong actor": (d1, _w, other, id, at) => addEvent(d1, other, at, detailOf(id, "resolution", "passed", [4, 0, 1, 5])),
    unsealed: (d1, who, _o, id, at) => addEvent(d1, who, at, detailOf(id, "resolution", "passed", [4, 0, 1, 5]), { sealed: false }),
  };
  for (const [name, plant] of Object.entries(cases)) {
    const d1 = preMigration();
    try {
      const who = insertCitizen(d1);
      const other = insertCitizen(d1);
      const id = decidedProposal(d1, who, "resolution", "passed", [4, 0, 1, 5], 2_000_000);
      plant(d1, who, other, id, 2_000_000);
      d1.raw.exec(MIGRATION);
      assert.equal(pointer(d1, id), null, `${name}: not linked`);
      assert.deepEqual(offenders(d1).map((r) => r.id), [id], `${name}: the verification names the row`);
    } finally {
      d1.close();
    }
  }
});

test("0023: duplicate candidates at one timestamp link nothing and the verification names the row", () => {
  const d1 = preMigration();
  try {
    const who = insertCitizen(d1);
    const id = decidedProposal(d1, who, "resolution", "passed", [4, 0, 1, 5], 3_000_000);
    addEvent(d1, who, 3_000_000, detailOf(id, "resolution", "passed", [4, 0, 1, 5]));
    addEvent(d1, who, 3_000_000, detailOf(id, "resolution", "passed", [4, 0, 1, 5]));
    d1.raw.exec(MIGRATION);
    assert.equal(pointer(d1, id), null);
    assert.deepEqual(offenders(d1).map((r) => r.id), [id]);
  } finally {
    d1.close();
  }
});

test("0023: a currently executed amendment (tallied passed, later moved to executed) links to its passed event and verifies; a first_laws_ratify executed is tallied executed", () => {
  const d1 = preMigration();
  try {
    const who = insertCitizen(d1);
    const a = decidedProposal(d1, who, "text_amendment", "executed", [4, 0, 0, 5], 4_000_000);
    const evA = addEvent(d1, who, 4_000_000, detailOf(a, "text_amendment", "passed", [4, 0, 0, 5]));
    const b = decidedProposal(d1, who, "first_laws_amendment", "executed", [4, 0, 0, 5], 4_000_001);
    const evB = addEvent(d1, who, 4_000_001, detailOf(b, "first_laws_amendment", "passed", [4, 0, 0, 5]));
    d1.raw.exec(MIGRATION);
    assert.equal(pointer(d1, a), evA);
    assert.equal(pointer(d1, b), evB);
    assert.deepEqual(offenders(d1), []);
  } finally {
    d1.close();
  }
});

test("verification catches a pointer at the wrong event and a pointer on an open row (mutant: drop the pointer-equality / non-decided clauses)", () => {
  const d1 = preMigration();
  try {
    const who = insertCitizen(d1);
    const a = decidedProposal(d1, who, "resolution", "passed", [4, 0, 1, 5], 5_000_000);
    const evA = addEvent(d1, who, 5_000_000, detailOf(a, "resolution", "passed", [4, 0, 1, 5]));
    const b = decidedProposal(d1, who, "resolution", "failed", [0, 0, 0, 5], 5_000_001);
    const evB = addEvent(d1, who, 5_000_001, detailOf(b, "resolution", "failed", [0, 0, 0, 5]));
    const open = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: who });
    d1.raw.exec(MIGRATION);
    assert.deepEqual(offenders(d1), []);
    d1.raw.prepare("UPDATE proposals SET decided_event_id = ? WHERE id = ?").run(evB, a);
    assert.deepEqual(offenders(d1).map((r) => r.id), [a], "a points at b's event");
    d1.raw.prepare("UPDATE proposals SET decided_event_id = ? WHERE id = ?").run(evA, a);
    d1.raw.prepare("UPDATE proposals SET decided_event_id = ? WHERE id = ?").run(evA, open);
    assert.deepEqual(offenders(d1).map((r) => r.id), [open], "an open row must not carry a pointer");
  } finally {
    d1.close();
  }
});

test("0023's backfill only fills NULL pointers: re-running it changes nothing, and a row filled later (a tally under the old worker) is repaired", () => {
  const d1 = preMigration();
  try {
    const who = insertCitizen(d1);
    const a = decidedProposal(d1, who, "resolution", "passed", [4, 0, 1, 5], 6_000_000);
    const evA = addEvent(d1, who, 6_000_000, detailOf(a, "resolution", "passed", [4, 0, 1, 5]));
    d1.raw.exec(MIGRATION);
    const m = /-- BACKFILL BEGIN\n([\s\S]*?)-- BACKFILL END/.exec(MIGRATION);
    assert.ok(m, "the migration marks its backfill");
    d1.raw.exec(m![1]);
    assert.equal(pointer(d1, a), evA);
    // an old-worker tally after the migration: decided, event written, pointer NULL
    const b = decidedProposal(d1, who, "resolution", "failed", [0, 0, 0, 5], 6_000_001);
    const evB = addEvent(d1, who, 6_000_001, detailOf(b, "resolution", "failed", [0, 0, 0, 5]));
    assert.deepEqual(offenders(d1).map((r) => r.id), [b]);
    d1.raw.exec(m![1]);
    assert.equal(pointer(d1, b), evB);
    assert.deepEqual(offenders(d1), []);
  } finally {
    d1.close();
  }
});

test("schema.sql carries decided_event_id as the LAST proposals column, as ADD COLUMN would leave it, with no REFERENCES", () => {
  const d1 = createLocalD1();
  try {
    const cols = (d1.raw.prepare("SELECT name FROM pragma_table_info('proposals')").all() as { name: string }[]).map((c) => c.name);
    assert.equal(cols[cols.length - 1], "decided_event_id");
    const fk = d1.raw.prepare("SELECT * FROM pragma_foreign_key_list('proposals') WHERE \"from\" = 'decided_event_id'").all();
    assert.equal(fk.length, 0);
    assert.doesNotMatch(MIGRATION.replace(/--.*\n/g, ""), /REFERENCES/i);
  } finally {
    d1.close();
  }
});
