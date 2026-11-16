// The parked list (D-083; drafts/BRIEF-PARKED-LIST-2026-11-16.md; migration 0028): a judgment refusal is RECORDED, an item pending with PARK_AFTER recorded declines is PARKED (not offered to the model again),
// and GET /api/maintainer/parked serves the record. Real local D1 (node:sqlite over schema.sql) and the real router and wake; the only stub is fetch (the model), as in test/judgment-refusal-skip-d1.test.ts.
// Each block names the mutant that turns it red; docs/CHECKPOINT-PARKED-LIST-2026-11-16.md records each one run and restored.
//
// Run: npm test

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { call, guestEnv } from "./helpers/guest.ts";
import { installSubrequestCounter, judgmentDecisionText, rpcBalanceResponse } from "./helpers/subrequest-counter.ts";
import { runJudgmentWake, scanPendingQueueBatch, countPendingQueue, CURSOR_TRIGGER_PENDING } from "../src/maintainer/judgment.ts";
import { PARK_AFTER, PARKED_SINCE, PARKED_NOTE, recordDecline } from "../src/maintainer/parked.ts";
import { detectConstitutionChange } from "../src/governance.ts";
import type { Env } from "../src/society.ts";

const ROOT = join(import.meta.dirname, "..");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const cache = () => ({ pairKey: null, versionRow: null });
const makeEnv = (d1: LocalD1) => ({ DB: d1.DB, ANTHROPIC_API_KEY: "k", TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "invite_only" }) as unknown as Env;
const DAY = 86_400_000;

before(async () => {
  const warm = createLocalD1();
  try {
    await detectConstitutionChange({ DB: warm.DB, TREASURY_ADDRESS: "0x0", REGISTRATION_MODE: "invite_only" } as unknown as Env, Date.now());
  } finally {
    warm.close();
  }
});

// ---------- scaffolding ----------

function base(d1: LocalD1) {
  assert.equal(insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" }), 1);
  return Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at, finished_at) VALUES ('clerk', ?, ?)").run(Date.now() - DAY, Date.now() - DAY + 5).lastInsertRowid);
}
let seq = 0;
function addItem(d1: LocalD1, clerkRun: number, over: Partial<{ kind: string; note: string; status: string; created_at: number; decided_at: number | null; decided_reason: string | null; target_type: string | null; target_id: number | null; source_ref: string | null }> = {}): number {
  const o = { kind: "bulletin_draft", note: `Digest ${seq}\nBody number ${seq}, all quiet.`, status: "pending", created_at: Date.now() - 50_000 + ++seq, decided_at: null, decided_reason: null, target_type: null, target_id: null, source_ref: null, ...over };
  return Number(
    d1.raw
      .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status, decided_at, decided_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(clerkRun, o.created_at, o.kind, o.target_type, o.target_id, o.source_ref, o.note, o.status, o.decided_at, o.decided_reason).lastInsertRowid,
  );
}
// n recorded declines for an item, each in its own (finished) judgment wake.
function declines(d1: LocalD1, queueId: number, n: number, finished = true): number[] {
  const runs: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = 1_000_000 + queueId * 1000 + i * 10;
    const run = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at, finished_at) VALUES ('judgment', ?, ?)").run(at, finished ? at + 1 : null).lastInsertRowid);
    d1.raw.prepare("INSERT INTO maintainer_declines (queue_id, run_id, declined_at) VALUES (?, ?, ?)").run(queueId, run, at + 2);
    runs.push(run);
  }
  return runs;
}
const statusOf = (d1: LocalD1, id: number) => (d1.raw.prepare("SELECT status FROM maintainer_queue WHERE id = ?").get(id) as { status: string }).status;
const declineCount = (d1: LocalD1, id: number) => Number((d1.raw.prepare("SELECT COUNT(*) AS c FROM maintainer_declines WHERE queue_id = ?").get(id) as { c: number }).c);
const lastJudgment = (d1: LocalD1) => d1.raw.prepare("SELECT * FROM maintainer_runs WHERE kind = 'judgment' ORDER BY id DESC LIMIT 1").get() as Record<string, any>;

const refusalBody = () => new Response(JSON.stringify({ content: [], stop_reason: "refusal", usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200 });
const okBody = (prompt: string) => new Response(JSON.stringify({ content: [{ type: "text", text: judgmentDecisionText(prompt) }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 40 } }), { status: 200 });
const promptOf = (init: { body?: unknown } | undefined) => (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
function model(refuse: (prompt: string) => boolean) {
  let n = 0;
  const prompts: string[] = [];
  const c = installSubrequestCounter((url, init) => {
    if (!url.includes("anthropic")) return rpcBalanceResponse();
    n++;
    const p = promptOf(init);
    prompts.push(p);
    return refuse(p) ? refusalBody() : okBody(p);
  });
  return { c, calls: () => n, prompts };
}
async function withWake<T>(refuse: (p: string) => boolean, fn: (d1: LocalD1, m: ReturnType<typeof model>) => Promise<T>): Promise<T> {
  const m = model(refuse);
  const d1 = createLocalD1({ onExec: m.c.consume });
  try {
    return await fn(d1, m);
  } finally {
    m.c.restore();
    d1.close();
  }
}
const route = async (d1: LocalD1, qs = "") => (await call(guestEnv(d1), "GET", `/api/maintainer/parked${qs}`)).body;

// ---------- the migration ----------

test("P1 migration: 0028 applied to the pre-0028 schema lands on what schema.sql builds, a second apply fails loudly, and the schema.sql tail is the migration's block byte for byte (mutant: one character differs)", () => {
  const full = norm(readFileSync(join(ROOT, "schema.sql"), "utf8"));
  const mig = norm(readFileSync(join(ROOT, "migrations", "0028_maintainer_declines.sql"), "utf8"));
  const cut = full.indexOf("-- The parked list (migrations/0028_maintainer_declines.sql");
  assert.ok(cut > 0, "schema.sql carries the 0028 header");
  const block = mig.slice(mig.indexOf("CREATE TABLE maintainer_declines"));
  const tail = full.slice(full.indexOf("CREATE TABLE maintainer_declines", cut));
  assert.equal(tail, block);
  assert.notEqual(tail.replace("declined_at INTEGER", "declined_at  INTEGER"), block, "a one-character drift fails the comparison");
  assert.ok(!/IF NOT EXISTS/i.test(block), "plain CREATE TABLE: a second apply must fail");

  const migrated = new DatabaseSync(":memory:");
  const built = new DatabaseSync(":memory:");
  try {
    migrated.exec(full.slice(0, cut));
    assert.equal((migrated.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'maintainer_declines'").get() as { c: number }).c, 0, "the pre-0028 schema has no such table");
    migrated.exec(mig);
    built.exec(full);
    const info = (db: DatabaseSync) => db.prepare("SELECT name, type, \"notnull\" AS nn, dflt_value AS d, pk FROM pragma_table_info('maintainer_declines')").all().map((r) => ({ ...r }));
    assert.deepEqual(info(migrated), info(built), "the migration lands on what schema.sql builds");
    assert.deepEqual(info(migrated).map((c: any) => [c.name, c.pk]), [["queue_id", 1], ["run_id", 2], ["declined_at", 0]]);
    const fks = (db: DatabaseSync) => db.prepare("SELECT \"table\" AS t, \"from\" AS f FROM pragma_foreign_key_list('maintainer_declines') ORDER BY f").all().map((r) => ({ ...r }));
    assert.deepEqual(fks(migrated), fks(built));
    assert.deepEqual(fks(migrated), [{ t: "maintainer_queue", f: "queue_id" }, { t: "maintainer_runs", f: "run_id" }]);
    assert.throws(() => migrated.exec(mig), /already exists/i, "a second apply fails loudly");
  } finally {
    migrated.close();
    built.close();
  }
});

// ---------- P1: record each decline ----------

test("P1: a refusal writes exactly one decline row for that item and wake; a refusal on a later wake writes a second (mutant: the refusal branch writes nothing, or writes twice)", async () => {
  await withWake(() => true, async (d1) => {
    const id = addItem(d1, base(d1));
    await runJudgmentWake(makeEnv(d1), cache());
    const run1 = lastJudgment(d1);
    assert.equal(declineCount(d1, id), 1);
    const row = d1.raw.prepare("SELECT * FROM maintainer_declines WHERE queue_id = ?").get(id) as Record<string, any>;
    assert.equal(row.run_id, run1.id, "the decline names the wake that received it");
    assert.ok(row.declined_at >= run1.started_at);
    assert.equal(statusOf(d1, id), "pending", "a decline is not a verdict");
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(declineCount(d1, id), 2);
    assert.deepEqual((d1.raw.prepare("SELECT run_id FROM maintainer_declines WHERE queue_id = ? ORDER BY run_id").all(id) as any[]).map((r) => r.run_id), [run1.id, lastJudgment(d1).id]);
  });
});

test("P1: a second write for the same (item, run) writes nothing and does not throw (mutant: ON CONFLICT DO NOTHING removed)", async () => {
  const d1 = createLocalD1();
  try {
    const id = addItem(d1, base(d1));
    const run = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('judgment', 5)").run().lastInsertRowid);
    await recordDecline({ DB: d1.DB }, id, run, 111);
    await recordDecline({ DB: d1.DB }, id, run, 222);
    const rows = d1.raw.prepare("SELECT declined_at FROM maintainer_declines WHERE queue_id = ?").all(id) as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].declined_at, 111, "the first write stands");
  } finally {
    d1.close();
  }
});

test("P1: a failing decline insert does not fail the wake: the item stays pending, the other item is still judged, and the failure is named in the same error line (mutant: the insert is not caught)", async () => {
  await withWake((p) => p.includes("Digest A"), async (d1, m) => {
    const run = base(d1);
    const a = addItem(d1, run, { note: "Digest A\nBody." });
    const b = addItem(d1, run, { note: "Digest B\nBody." });
    d1.raw.exec("CREATE TRIGGER boom BEFORE INSERT ON maintainer_declines BEGIN SELECT RAISE(ABORT, 'decline store down'); END;");
    await runJudgmentWake(makeEnv(d1), cache());
    const r = lastJudgment(d1);
    assert.ok(r.finished_at, "the wake finished");
    assert.equal(m.calls(), 2, "the wake went on to the second item");
    assert.equal(statusOf(d1, a), "pending");
    assert.equal(statusOf(d1, b), "approved");
    assert.equal(declineCount(d1, a), 0);
    assert.match(String(r.error), new RegExp(`bulletin_draft item ${a} not judged \\(the model declined\\); skipped this wake; the decline could not be recorded \\(.*decline store down`));
    assert.equal((String(r.error).match(/not judged/g) ?? []).length, 1, "one line, not two");
  });
});

test("P1: a decline whose run is never finalised is still counted, parks the item and is served (mutant: the count or the route joins on finished runs)", async () => {
  const d1 = createLocalD1();
  try {
    const id = addItem(d1, base(d1));
    const runs = declines(d1, id, 2, false);
    const body = await route(d1);
    assert.equal(body.total, 1);
    const row = body.items[0];
    assert.equal(row.declines, 2);
    assert.deepEqual(row.declining_runs, runs);
    assert.equal(row.parked, true);
    assert.equal((d1.raw.prepare("SELECT finished_at FROM maintainer_runs WHERE id = ?").get(runs[0]) as any).finished_at, null);
    assert.match(body.note, /a declining run may be unfinished/);
  } finally {
    d1.close();
  }
});

// ---------- P2: park ----------

test("P2 threshold: with PARK_AFTER 2, one recorded decline leaves the item eligible (the model is called); two park it (no call) (mutant: the threshold is off by one either way)", async () => {
  assert.equal(PARK_AFTER, 2);
  await withWake(() => true, async (d1, m) => {
    const id = addItem(d1, base(d1));
    declines(d1, id, 1);
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(m.calls(), 1, "one decline: still offered");
    assert.equal(declineCount(d1, id), 2, "and it was declined again");
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(m.calls(), 1, "two declines: parked, no model call");
    assert.equal(declineCount(d1, id), 2);
  });
});

test("P2 site 1 (queue scan, no cursor): parked rows ahead of an eligible one do not consume maxScan and the eligible row is reached (mutant: the scan WHERE is a plain status = 'pending')", async () => {
  const d1 = createLocalD1();
  try {
    const run = base(d1);
    for (let i = 0; i < 4; i++) declines(d1, addItem(d1, run), PARK_AFTER);
    const eligible = addItem(d1, run);
    const out = await scanPendingQueueBatch(makeEnv(d1), null, 1, 3);
    assert.deepEqual(out.admissible.map((r) => r.id), [eligible]);
    assert.equal(out.drained, true, "a short page proves the table is drained of eligible pending rows");
  } finally {
    d1.close();
  }
});

test("P2 site 2 (queue scan, after the cursor wraps): the same holds with a cursor set before the parked block (mutant: only the no-cursor variant has the predicate)", async () => {
  const d1 = createLocalD1();
  try {
    const run = base(d1);
    const first = addItem(d1, run, { created_at: 1000 });
    for (let i = 0; i < 4; i++) declines(d1, addItem(d1, run, { created_at: 2000 + i }), PARK_AFTER);
    const eligible = addItem(d1, run, { created_at: 3000 });
    const out = await scanPendingQueueBatch(makeEnv(d1), { createdAt: 1000, id: first }, 1, 3);
    assert.deepEqual(out.admissible.map((r) => r.id), [eligible]);
  } finally {
    d1.close();
  }
});

test("P2 site 3 (overflow baseline): already parked rows contribute zero to overflow_dropped across successive wakes (mutant: the baseline counts every pending row)", async () => {
  await withWake(() => false, async (d1) => {
    const run = base(d1);
    for (let i = 0; i < 3; i++) declines(d1, addItem(d1, run), PARK_AFTER);
    addItem(d1, run);
    for (let w = 0; w < 2; w++) {
      if (w === 1) addItem(d1, run);
      await runJudgmentWake(makeEnv(d1), cache());
      const r = lastJudgment(d1);
      assert.equal(r.items_actioned, 1, `wake ${w}`);
      assert.equal(r.overflow_dropped, 0, `wake ${w}: three parked rows are not backlog`);
    }
  });
});

test("P2 site 3b: an item that reaches the threshold in THIS wake is subtracted once, not twice (mutant: refusedIds subtracted and the parked count subtracted)", async () => {
  await withWake((p) => p.includes("Digest hot"), async (d1) => {
    const run = base(d1);
    declines(d1, addItem(d1, run), PARK_AFTER); // already parked
    const hot = addItem(d1, run, { note: "Digest hot\nBody." });
    declines(d1, hot, PARK_AFTER - 1);
    addItem(d1, run, { note: "Digest ok\nBody." });
    await runJudgmentWake(makeEnv(d1), cache());
    const r = lastJudgment(d1);
    assert.equal(declineCount(d1, hot), PARK_AFTER, "it was declined again and is now parked");
    assert.equal(r.items_actioned, 1);
    assert.equal(r.overflow_dropped, 0);
  });
});

test("P2 site 4 (cursor trigger): 250 pending rows with one parked reads 249 eligible and does not arm the trigger; 250 eligible does (mutant: the trigger reads a raw pending count)", async () => {
  assert.equal(CURSOR_TRIGGER_PENDING, 250);
  for (const [eligible, armed] of [[CURSOR_TRIGGER_PENDING - 1, false], [CURSOR_TRIGGER_PENDING, true]] as const) {
    await withWake(() => false, async (d1) => {
      const run = base(d1);
      declines(d1, addItem(d1, run), PARK_AFTER);
      for (let i = 0; i < eligible; i++) addItem(d1, run);
      await runJudgmentWake(makeEnv(d1), cache());
      const err = String(lastJudgment(d1).error ?? "");
      assert.equal(/cursor trigger reached: pending_at_start=250/.test(err), armed, `${eligible} eligible + 1 parked: ${err.slice(0, 120)}`);
      if (!armed) assert.doesNotMatch(err, /cursor trigger reached/);
    });
  }
});

test("P2 site 5 (the 'nothing pending' skip): an all-parked queue makes no model call and its row says 'nothing eligible' with the parked count; an empty queue still says 'nothing pending' (mutant: the skip reads a raw count)", async () => {
  await withWake(() => false, async (d1, m) => {
    const run = base(d1);
    for (let i = 0; i < 3; i++) declines(d1, addItem(d1, run), PARK_AFTER);
    await runJudgmentWake(makeEnv(d1), cache());
    const r = lastJudgment(d1);
    assert.equal(m.calls(), 0);
    assert.equal(r.skipped_reason, "nothing eligible (3 parked)");
    assert.equal(r.overflow_dropped, 0);
    assert.deepEqual(await countPendingQueue(makeEnv(d1)), { eligible: 0, parked: 3 });
  });
  await withWake(() => false, async (d1, m) => {
    base(d1);
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(lastJudgment(d1).skipped_reason, "nothing pending");
    assert.equal(m.calls(), 0);
  });
});

test("P2: a parked item approved by hand is still completed by wake-start reconciliation (mutant: the reconciliation pass is filtered by the eligible cohort)", async () => {
  await withWake(() => false, async (d1) => {
    const run = base(d1);
    const id = addItem(d1, run, { note: "Parked digest\nBody that a person approved.", created_at: Date.now() - 2000 });
    declines(d1, id, PARK_AFTER);
    d1.raw.prepare("UPDATE maintainer_queue SET status = 'approved', decided_at = ?, decided_reason = 'approved by hand' WHERE id = ?").run(Date.now() - 1000, id);
    const postsBefore = Number((d1.raw.prepare("SELECT COUNT(*) AS c FROM posts").get() as any).c);
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(Number((d1.raw.prepare("SELECT COUNT(*) AS c FROM posts").get() as any).c), postsBefore + 1, "the approved row was executed");
    assert.equal(lastJudgment(d1).items_actioned, 1);
  });
});

test("P2: a parked bulletin_draft past seven days is rejected by the existing expiry and then reads parked false, status rejected; a parked item rejected by hand reads the same, with its decided_at (mutant: parked ignores status)", async () => {
  await withWake(() => false, async (d1) => {
    const run = base(d1);
    const stale = addItem(d1, run, { created_at: Date.now() - 9 * DAY });
    declines(d1, stale, PARK_AFTER);
    const hand = addItem(d1, run, { kind: "flag_review", target_type: "post", target_id: 1 });
    declines(d1, hand, PARK_AFTER);
    const stays = addItem(d1, run);
    declines(d1, stays, PARK_AFTER);
    assert.equal((await route(d1)).parked_now, 3);
    d1.raw.prepare("UPDATE maintainer_queue SET status = 'rejected', decided_at = 4242, decided_reason = 'rejected by hand' WHERE id = ?").run(hand);
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(statusOf(d1, stale), "rejected", "D-080 expiry decided the old bulletin");
    const body = await route(d1);
    const byId = new Map<number, any>(body.items.map((r: any) => [r.id, r]));
    assert.deepEqual([byId.get(stale).parked, byId.get(stale).status], [false, "rejected"]);
    assert.ok(byId.get(stale).decided_at > 0);
    assert.deepEqual([byId.get(hand).parked, byId.get(hand).status, byId.get(hand).decided_at], [false, "rejected", 4242]);
    assert.deepEqual([byId.get(stays).parked, byId.get(stays).status, byId.get(stays).decided_at], [true, "pending", null]);
    assert.equal(body.total, 3);
    assert.equal(body.parked_now, 1);
  });
});

test("P2 budget: a four-batch wake in which every item is refused stays inside the 50 subrequests with the decline writes, and one decline row per refused batch (mutant: a second decline statement per refusal pushes it over, or none is written)", async () => {
  await withWake(() => true, async (d1, m) => {
    const run = base(d1);
    const ids = [0, 1, 2, 3, 4].map(() => addItem(d1, run));
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(m.calls(), 4);
    assert.equal(m.c.breached(), false);
    assert.ok(m.c.total() <= 50, `saw ${m.c.total()}`);
    const written = ids.filter((id) => declineCount(d1, id) === 1);
    assert.equal(written.length, 4);
  });
});

// ---------- the route ----------

const ROW_KEYS = ["id", "kind", "first_declined_at", "last_declined_at", "declines", "declining_runs", "parked", "status", "decided_at"];
const TOP_KEYS = ["note", "since", "park_after", "total", "parked_now", "returned", "has_more", "next_cursor", "items"];

test("route: the key set is exactly the served list, and a marker in the item's text, target, source and reason is nowhere in the body (mutant: SELECT * or one extra field)", async () => {
  const d1 = createLocalD1();
  try {
    const run = base(d1);
    const id = addItem(d1, run, { kind: "registration_check", note: "MARKER-NOTE a citizen's text", target_type: "citizen", target_id: 77, source_ref: "MARKER-SRC", status: "rejected", decided_at: 9, decided_reason: "MARKER-REASON" });
    declines(d1, id, 1);
    const reply = await call(guestEnv(d1), "GET", "/api/maintainer/parked");
    assert.equal(reply.status, 200);
    assert.deepEqual(Object.keys(reply.body).sort(), [...TOP_KEYS].sort());
    assert.deepEqual(Object.keys(reply.body.items[0]).sort(), [...ROW_KEYS].sort());
    const text = JSON.stringify(reply.body);
    for (const bad of ["MARKER", "target_type", "target_id", "source_ref", "decided_reason", "created_at", "run_id\""]) assert.ok(!text.includes(bad), `no ${bad}`);
    assert.equal(reply.body.items[0].kind, "registration_check");
    assert.equal(reply.body.since, PARKED_SINCE);
    assert.equal(reply.body.park_after, PARK_AFTER);
  } finally {
    d1.close();
  }
});

test("route: total and parked_now match their definitions over pending, parked and decided rows, and paging by after loses and repeats no row (mutant: total counts only pending, or the cursor is >= not >)", async () => {
  const d1 = createLocalD1();
  try {
    const run = base(d1);
    const made: number[] = [];
    const states = ["pending1", "parked", "approved", "rejected", "parked", "pending1", "parked"];
    for (const s of states) {
      const id = addItem(d1, run, { status: s === "approved" ? "approved" : s === "rejected" ? "rejected" : "pending", decided_at: s === "approved" || s === "rejected" ? 5 : null });
      declines(d1, id, s === "pending1" ? 1 : PARK_AFTER + (s === "approved" ? 1 : 0));
      made.push(id);
    }
    addItem(d1, run); // never declined: not listed
    const all = await route(d1, "?limit=100");
    assert.equal(all.total, 7);
    assert.equal(all.parked_now, 3);
    assert.deepEqual(all.items.map((r: any) => r.id), made);
    assert.equal(all.has_more, false);
    assert.equal(all.next_cursor, null);
    assert.deepEqual(all.items.map((r: any) => r.declines), [1, 2, 3, 2, 2, 1, 2]);
    const seen: number[] = [];
    let after = "";
    for (let guard = 0; guard < 10; guard++) {
      const page = await route(d1, `?limit=3${after}`);
      assert.equal(page.total, 7, "totals are of the whole list, not the page");
      assert.equal(page.parked_now, 3);
      seen.push(...page.items.map((r: any) => r.id));
      if (!page.has_more) break;
      assert.equal(page.items.length, 3);
      after = `&after=${page.next_cursor}`;
    }
    assert.deepEqual(seen, made);
    assert.equal((await route(d1, "?limit=0")).items.length, 1, "limit floors at 1");
    assert.equal((await route(d1, "?limit=9999")).items.length, 7, "limit caps at 100");
  } finally {
    d1.close();
  }
});

test("route: the empty list is a 200 with the definitions and no rows", async () => {
  const d1 = createLocalD1();
  try {
    const body = await route(d1);
    assert.deepEqual([body.total, body.parked_now, body.returned, body.has_more, body.next_cursor, body.items], [0, 0, 0, false, null, []]);
  } finally {
    d1.close();
  }
});

test("served text: the note states each commissioned clause, and says only what the code does (mutant: any clause is dropped or reworded)", () => {
  const n = PARKED_NOTE;
  for (const s of [
    `Counts are of recorded declines since ${PARKED_SINCE}`,
    "a failed write can leave a decline unrecorded",
    `An item is parked (parked: true) while it is pending with at least ${PARK_AFTER} recorded declines; a parked item is not offered to the model again`,
    "A parked item waits for the operator, and no response time is promised",
    "by the model on a later wake (only while it is under 2 recorded declines), by a person, or, for a bulletin draft only, by the existing seven-day expiry",
    "This list does not say which",
    "a declining run may be unfinished",
    `Nothing before ${PARKED_SINCE} is listed: one item declined on 15 November 2026 is named only in that wake's row on GET /api/maintainer-runs`,
  ]) assert.ok(n.includes(s), s);
  assert.equal(PARKED_SINCE, "17 November 2026");
  assert.ok(!/will be (decided|reviewed|answered)/i.test(n), "no promise");
});

test("served on every surface: ROUTES, /llms.txt, /openapi.json (with a response schema) and /api/surface carry the route", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const llms = await (await (await import("../src/index.ts")).default.fetch(new Request("https://example.test/llms.txt"), env)).text();
    assert.ok(llms.includes("/api/maintainer/parked"));
    const doc = (await call(env, "GET", "/openapi.json")).body;
    const schema = doc.paths["/api/maintainer/parked"].get.responses["200"].content["application/json"].schema;
    assert.deepEqual([...schema.required].sort(), [...TOP_KEYS].sort());
    const surface = (await call(env, "GET", "/api/surface")).body;
    assert.ok(JSON.stringify(surface).includes("/api/maintainer/parked"));
  } finally {
    d1.close();
  }
});

test("DEFERRED-PARKED-HAND-DECISION-ROUTE marker is planted, and DEFERRED-JUDGMENT-REFUSAL-HELD-STATUS is resolved (a marker and its resolution are both greppable)", () => {
  const parked = readFileSync(join(ROOT, "src", "maintainer", "parked.ts"), "utf8");
  const judgment = readFileSync(join(ROOT, "src", "maintainer", "judgment.ts"), "utf8");
  assert.ok(parked.includes("DEFERRED-PARKED-HAND-DECISION-ROUTE"));
  assert.ok(!judgment.includes("DEFERRED-JUDGMENT-REFUSAL-HELD-STATUS"), "the old marker is gone from the code");
  assert.ok(judgment.includes("The parked list (D-083"));
});

test("the maintainer-runs note corrects the 'offered again' sentence and points at the new route", async () => {
  const d1 = createLocalD1();
  try {
    const note = (await call(guestEnv(d1), "GET", "/api/maintainer-runs")).body.note as string;
    assert.ok(!note.includes("offered again at the next wake"));
    assert.ok(note.includes("GET /api/maintainer/parked"));
  } finally {
    d1.close();
  }
});
