// R3 of drafts/BRIEF-RECOVERY-UNIT-COMMIT-2026-11-15.md: which commit was live on which day. Migration 0027 adds commit_days(day, code_commit, first_seen_at) PRIMARY KEY (day, code_commit);
// countDoor writes it in ONE batch with its door_counts upsert (INSERT OR IGNORE, even at the cap); GET /api/doors serves commits_by_day. Real local D1 through the real router; the only
// scaffolding is raw SQL triggers that make one statement of the batch fail. Every block names the mutant that turns it red;
// docs/CHECKPOINT-RECOVERY-UNIT-COMMIT-2026-11-15.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call, count, freshIp } from "./helpers/guest.ts";
import { countDoor, doorsReport, utcDay, DOORS_NOTE, DOOR_DAILY_CAP, UNSTAMPED } from "../src/doors.ts";
import type { Env } from "../src/society.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const NOON = Date.UTC(2026, 10, 15, 12, 0, 0);
const DAY = utcDay(NOON);

function fresh(extra: Record<string, unknown> = {}) {
  const d1 = createLocalD1();
  seedCitizens(d1);
  return { d1, env: guestEnv(d1, extra) };
}
type D = ReturnType<typeof createLocalD1>;
const days = (d1: D) => (d1.raw.prepare("SELECT day, code_commit, first_seen_at FROM commit_days ORDER BY day, code_commit").all() as Array<{ day: string; code_commit: string; first_seen_at: number }>).map((r) => ({ ...r }));

test("R3 migration: 0027 creates commit_days(day TEXT NOT NULL, code_commit TEXT NOT NULL, first_seen_at INTEGER NOT NULL) with primary key (day, code_commit), no foreign key, and door_counts is not altered (mutant: the key is only day)", () => {
  const { d1 } = fresh();
  try {
    const cols = d1.raw.prepare("SELECT name, type, \"notnull\" AS nn, pk FROM pragma_table_info('commit_days') ORDER BY cid").all() as Array<{ name: string; type: string; nn: number; pk: number }>;
    assert.deepEqual(cols.map((c) => ({ ...c })), [
      { name: "day", type: "TEXT", nn: 1, pk: 1 },
      { name: "code_commit", type: "TEXT", nn: 1, pk: 2 },
      { name: "first_seen_at", type: "INTEGER", nn: 1, pk: 0 },
    ]);
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('commit_days')").get() as { n: number }).n, 0);
    assert.deepEqual((d1.raw.prepare("SELECT name FROM pragma_table_info('door_counts') ORDER BY cid").all() as Array<{ name: string }>).map((c) => c.name), ["day", "door", "n"], "door_counts is untouched: no count is split by commit");
  } finally {
    d1.close();
  }
});

test("R3: the first request writes the day's row, a repeat writes nothing new, a second stamp the same day adds a second entry (mutant: a plain INSERT, or the key lacks code_commit)", async () => {
  const one = fresh({ CODE_COMMIT: A });
  try {
    await countDoor(one.env, "skill_md", NOON);
    assert.deepEqual(days(one.d1), [{ day: DAY, code_commit: A, first_seen_at: NOON }]);
    await countDoor(one.env, "skill_md", NOON + 5000);
    await countDoor(one.env, "heartbeat_md", NOON + 9000);
    assert.deepEqual(days(one.d1), [{ day: DAY, code_commit: A, first_seen_at: NOON }], "repeats insert nothing and change nothing");
    assert.equal(count(one.d1, "SELECT n AS n FROM door_counts WHERE door = 'skill_md'"), 2, "the door count itself still counts");
    // a deploy lands mid-day: the same database, a new stamp
    await countDoor({ ...one.env, CODE_COMMIT: B } as Env, "skill_md", NOON + 60_000);
    assert.deepEqual(days(one.d1), [
      { day: DAY, code_commit: A, first_seen_at: NOON },
      { day: DAY, code_commit: B, first_seen_at: NOON + 60_000 },
    ]);
  } finally {
    one.d1.close();
  }
});

test("R3: an absent or malformed stamp is recorded as the literal 'unstamped' (and the bad value is never stored); a new UTC day is a new entry (mutant: null is stored, or the raw value)", async () => {
  for (const [label, extra] of [["absent", {}], ["malformed", { CODE_COMMIT: "not-a-commit" }], ["uppercase", { CODE_COMMIT: "A".repeat(40) }]] as const) {
    const { d1, env } = fresh(extra);
    try {
      await countDoor(env, "skill_md", NOON);
      assert.deepEqual(days(d1), [{ day: DAY, code_commit: UNSTAMPED, first_seen_at: NOON }], label);
      assert.equal(UNSTAMPED, "unstamped");
      await countDoor(env, "skill_md", NOON + 86_400_000);
      assert.equal(days(d1).length, 2, `${label}: the next UTC day gets its own entry`);
    } finally {
      d1.close();
    }
  }
});

test("R3: first_seen_at is the time carried by the first insert that landed: a later insert carrying an EARLIER timestamp leaves it unchanged (mutant: INSERT OR REPLACE, or MIN())", async () => {
  const { d1, env } = fresh({ CODE_COMMIT: A });
  try {
    await countDoor(env, "skill_md", NOON + 30_000);
    await countDoor(env, "skill_md", NOON + 1_000);
    assert.equal(days(d1)[0]!.first_seen_at, NOON + 30_000);
  } finally {
    d1.close();
  }
});

test("R3: a door row at its cap still records a new stamp, and the cap is not an error (mutant: the stamp insert is conditional on the count changing)", async () => {
  const { d1, env } = fresh({ CODE_COMMIT: A });
  try {
    d1.raw.prepare("INSERT INTO door_counts (day, door, n) VALUES (?, 'skill_md', ?)").run(DAY, DOOR_DAILY_CAP);
    await countDoor(env, "skill_md", NOON);
    assert.equal(count(d1, "SELECT n AS n FROM door_counts WHERE door = 'skill_md'"), DOOR_DAILY_CAP, "the count stays at the cap");
    assert.deepEqual(days(d1), [{ day: DAY, code_commit: A, first_seen_at: NOON }], "the saturated door still observed the stamp");
    await countDoor({ ...env, CODE_COMMIT: B } as Env, "skill_md", NOON + 1);
    assert.equal(days(d1).length, 2, "and a second stamp, too");
  } finally {
    d1.close();
  }
});

test("R3: a statement error in either half rolls back BOTH and countDoor still does not throw, and it logs one warn (mutant: the two statements run as separate writes)", async () => {
  for (const [label, trigger] of [
    ["commit_days fails", "CREATE TRIGGER boom BEFORE INSERT ON commit_days BEGIN SELECT RAISE(ABORT, 'forced'); END"],
    ["door_counts fails", "CREATE TRIGGER boom BEFORE INSERT ON door_counts BEGIN SELECT RAISE(ABORT, 'forced'); END"],
  ] as const) {
    const { d1, env } = fresh({ CODE_COMMIT: A });
    const realLog = console.log;
    const logged: string[] = [];
    try {
      d1.raw.exec(trigger);
      console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
      await assert.doesNotReject(countDoor(env, "skill_md", NOON), label);
      console.log = realLog;
      assert.equal(count(d1, "SELECT COUNT(*) AS n FROM door_counts"), 0, `${label}: no door row`);
      assert.equal(days(d1).length, 0, `${label}: no stamp row`);
      assert.equal(logged.filter((l) => l.includes("door_count_failed")).length, 1);
    } finally {
      console.log = realLog;
      d1.close();
    }
  }
});

test("R3: GET /api/doors serves commits_by_day over the 30-day window, ordered day DESC, first_seen_at ASC, commit ASC, and the note carries the stated sentence (mutant: the ordering or the window is dropped)", async () => {
  const { d1, env } = fresh();
  try {
    const now = Date.now();
    const today = utcDay(now);
    const old = utcDay(now - 40 * 86_400_000);
    const yesterday = utcDay(now - 86_400_000);
    const ins = d1.raw.prepare("INSERT INTO commit_days (day, code_commit, first_seen_at) VALUES (?, ?, ?)");
    ins.run(yesterday, "1".repeat(40), 500);
    ins.run(today, B, 200);
    ins.run(today, A, 200); // same first_seen_at: commit ASC breaks the tie
    ins.run(today, UNSTAMPED, 100);
    ins.run(old, A, 1);
    const r = await call(env, "GET", "/api/doors", undefined, { "CF-Connecting-IP": freshIp() });
    assert.equal(r.status, 200);
    const seen = (r.body.commits_by_day as Array<{ day: string; commit: string; first_seen_at: number }>).filter((c) => c.first_seen_at < 1000);
    assert.deepEqual(seen, [
      { day: today, commit: UNSTAMPED, first_seen_at: 100 },
      { day: today, commit: A, first_seen_at: 200 },
      { day: today, commit: B, first_seen_at: 200 },
      { day: yesterday, commit: "1".repeat(40), first_seen_at: 500 },
    ]);
    assert.ok(!r.body.commits_by_day.some((c: { day: string }) => c.day === old), "outside the window");
    assert.deepEqual(Object.keys(r.body.commits_by_day[0]), ["day", "commit", "first_seen_at"]);
    const report = await doorsReport(env);
    assert.deepEqual(report.commits_by_day, r.body.commits_by_day);
    for (const phrase of [
      "at least one completed door-counting attempt",
      "including attempts after that door's count had capped",
      "first_seen_at is the time carried by the first insert that landed, not necessarily the earliest such request",
      "the operator's stamp (a commonhold_statement, as /api/attest's provenance says), not proof of the running bytes",
      "A day may show several stamps",
      "a deployment without a completed door-counting attempt contributes no stamp observation",
      "not a complete deployment timeline",
      "does not say which /privacy response anyone received (/privacy is not a counted door)",
      "Days before this shipped have no entry",
    ]) assert.ok(DOORS_NOTE.includes(phrase), phrase);
    assert.equal(r.body.note, DOORS_NOTE);
  } finally {
    d1.close();
  }
});

test("R3: the stamp is taken from the live env on a real routed request, so a stamped worker's /skill.md fetch records its commit", async () => {
  const { d1, env } = fresh({ CODE_COMMIT: A });
  try {
    const r = await call(env, "GET", "/skill.md", undefined, { "CF-Connecting-IP": freshIp() });
    assert.equal(r.status, 200);
    assert.deepEqual(days(d1).map((d) => d.code_commit), [A]);
  } finally {
    d1.close();
  }
});
