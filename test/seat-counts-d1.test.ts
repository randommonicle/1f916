// The seat counts wave (14 Oct 2026; brief drafts/BRIEF-SEAT-COUNTS-2026-10-14.md with amendments A1-A8; commission
// drafts/BUILDER-COMMISSION-SEAT-COUNTS-2026-10-14.md): composition.act_capable, acted_30d, operator_paid, `independent` as a marked
// object, and GET /api/treasury. Real rows in the D1 harness (test/helpers/local-d1.ts, the committed schema.sql); expected values are typed
// here, never computed by the code under test.
//
// Run just this file: node --experimental-strip-types --test "test/seat-counts-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { officialFacts, actedWritersSince, outsideWritersSince, COMPOSITION_PROVENANCE, KEY_LOST_SEATS, OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES, type Env } from "../src/society.ts";
import { citizenWritersSince } from "../src/council.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = "https://example.test";

function makeEnv(db: unknown): Env {
  return { DB: db, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open", MAINTAINER_SECRET: "seat-counts-secret-for-tests" } as unknown as Env;
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const fetchWorker = (req: Request, env: Env) => (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(req, env, ctx);
const get = (path: string, env: Env) => fetchWorker(new Request(`${ORIGIN}${path}`), env);

// ---------- fixture: one citizen per write arm, so each arm is counted (or not) on its own ----------

let counter = 0;
const ARMS = ["post", "comment", "ballot", "guest_thread", "council_thread", "council_ballots"] as const;
type Arm = (typeof ARMS)[number];

// A board post for the comment arm and a proposal for the ballot arm to hang off (pointers, not foreign keys, except posts.citizen_id and ballots.proposal_id's own table).
function seedBoard(d1: LocalD1): { board: number } {
  const owner = insertCitizen(d1, { handle: "board-owner-not-counted" });
  const r = d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at) VALUES (?, 't', 'b', 'board-h', ?)").run(owner, 1);
  return { board: Number(r.lastInsertRowid) };
}

// Writes ONE row of the given arm for `citizen`, `at` epoch ms. `hidden` marks the row moderated where the table has a moderation column.
function write(d1: LocalD1, arm: Arm, citizen: number, handle: string, board: number, at: number, hidden = false): void {
  const mod = hidden ? "removed" : null;
  const n = ++counter;
  switch (arm) {
    case "post":
      d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, mod_state, created_at) VALUES (?, 'a post', 'b', ?, ?, ?)").run(citizen, `seat-h${n}`, mod, at);
      return;
    case "comment":
      d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, mod_state, created_at) VALUES (?, ?, 'a comment', 0, ?, ?)").run(board, citizen, mod, at);
      return;
    case "ballot":
      d1.raw.prepare("INSERT OR IGNORE INTO proposals (id, kind, title, body, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, post_id, created_at) VALUES (900, 'resolution', 't', 'b', 1, 1, 2, 'open', 'open', 0, ?, 1)").run(board);
      d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (900, ?, 'abstain', ?)").run(citizen, at);
      return;
    case "guest_thread":
      d1.raw
        .prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, kind, body, mod_state, created_at) VALUES (?, 0, 'citizen', ?, ?, 'test-model', 'comment', 'an answer', ?, ?)")
        .run(board, citizen, handle, mod, at);
      return;
    case "council_thread":
      d1.raw.prepare("INSERT INTO council_thread (parent_id, author_kind, author_id, handle, body, created_at) VALUES (NULL, 'citizen', ?, ?, 'hello', ?)").run(citizen, handle, at);
      return;
    case "council_ballots":
      d1.raw.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (?, 'citizen', ?, 'yes', ?)").run(n, citizen, at);
      return;
  }
}

const seat = (d1: LocalD1, handle: string) => insertCitizen(d1, { handle });

// ---------- C1 / T2: one write definition, the window edge, both counts from the same rows ----------

test("T2: citizenWritersSince counts every one of the six write arms; the exclusion list is the only difference between the two counts; the window edge is inclusive", async () => {
  const d1 = createLocalD1();
  try {
    const { board } = seedBoard(d1);
    const NOW = Date.now();
    const since = NOW - 30 * DAY_MS;
    assert.equal(await citizenWritersSince(d1.DB, since, []), 0, "nothing written yet");

    // operator-controlled seats: counted by the all-seats count, never by the outside count
    write(d1, "post", seat(d1, "commonhold-agent"), "commonhold-agent", board, NOW - DAY_MS);
    write(d1, "ballot", seat(d1, "ledger-watch"), "ledger-watch", board, NOW - DAY_MS);
    assert.equal(await actedWritersSince(d1.DB, since), 2);
    assert.equal(await outsideWritersSince(d1.DB, since), 0);

    // one outside citizen per arm, inside the window: each arm moves BOTH counts by one
    let acted = 2;
    let outside = 0;
    for (const arm of ARMS) {
      const handle = `inside-${arm}`;
      write(d1, arm, seat(d1, handle), handle, board, NOW - 29 * DAY_MS);
      acted += 1;
      outside += 1;
      assert.equal(await actedWritersSince(d1.DB, since), acted, `${arm} (29 days old) must count in acted`);
      assert.equal(await outsideWritersSince(d1.DB, since), outside, `${arm} (29 days old) must count in outside`);
    }

    // one outside citizen per arm, OUTSIDE the window: moves neither
    for (const arm of ARMS) {
      const handle = `outside-${arm}`;
      write(d1, arm, seat(d1, handle), handle, board, NOW - 31 * DAY_MS);
    }
    assert.equal(await actedWritersSince(d1.DB, since), acted, "writes 31 days old move nothing");
    assert.equal(await outsideWritersSince(d1.DB, since), outside);

    // the edge: a row stamped exactly `since` is inside (>=), one millisecond earlier is outside
    write(d1, "post", seat(d1, "on-the-edge"), "on-the-edge", board, since);
    write(d1, "post", seat(d1, "one-ms-early"), "one-ms-early", board, since - 1);
    acted += 1;
    outside += 1;
    assert.equal(await actedWritersSince(d1.DB, since), acted, "exactly at the window start counts; one ms earlier does not");
    assert.equal(await outsideWritersSince(d1.DB, since), outside);

    // the defining relation: the outside count is the all-seats count over the rows of seats not on the operator's list
    assert.equal(acted - outside, 2, "the only difference is the two operator-controlled seats");
    assert.equal(acted, 9);
    assert.equal(outside, 7);

    // a citizen with several arms counts once
    const multi = seat(d1, "writes-everything");
    for (const arm of ARMS) write(d1, arm, multi, "writes-everything", board, NOW - DAY_MS);
    assert.equal(await actedWritersSince(d1.DB, since), acted + 1, "counted once");
    assert.equal(await outsideWritersSince(d1.DB, since), outside + 1);
  } finally {
    d1.close();
  }
});

test("T2: with an empty exclusion list the clause is left out of the SQL (never NOT IN ()), with a list it is present and lower-cased", async () => {
  const d1 = createLocalD1();
  try {
    const seen: string[] = [];
    const db = {
      prepare: (sql: string) => {
        seen.push(sql);
        return d1.DB.prepare(sql);
      },
    } as unknown as D1Database;
    await citizenWritersSince(db, 0, []);
    await citizenWritersSince(db, 0, ["Ledger-Watch"]);
    assert.equal(seen.length, 2);
    assert.doesNotMatch(seen[0], /NOT IN/, "an empty list must not emit NOT IN");
    assert.match(seen[1], /lower\(ct\.handle\) NOT IN \(\?\)/);
    // the list is compared lower-cased on both sides: a mixed-case exclusion hides a lower-case handle
    const { board } = seedBoard(d1);
    write(d1, "post", seat(d1, "ledger-watch"), "ledger-watch", board, Date.now());
    assert.equal(await citizenWritersSince(d1.DB, 100, ["Ledger-Watch"]), 0);
    assert.equal(await citizenWritersSince(d1.DB, 100, []), 1);
  } finally {
    d1.close();
  }
});

// ---------- C2: the composition fields, through the real route ----------

interface Comp {
  citizens: number;
  act_capable: number;
  acted_30d: number | null;
  operator_paid: number;
  operator_controlled: number;
  operator_funded: number;
  key_lost: number;
  not_designated_operator_controlled: number;
  independent: { deprecated_name?: boolean; count?: number; meaning?: string; use_instead?: string };
  provenance: Record<string, { source: string[]; check: string }>;
  note: string;
}
interface Official {
  composition: Comp;
  rule7_revote: { outside_writers_30d: number | null; met: boolean };
}
const official = async (env: Env): Promise<Official> => {
  const res = await get("/api/official", env);
  assert.equal(res.status, 200);
  return (await res.json()) as Official;
};

// The live shape of 14 Oct: the 5 operator seats, the 7 sponsored seats (one of them key-lost) and sisyphus, which is 13 citizens.
function seedLiveShape(d1: LocalD1): Map<string, number> {
  const ids = new Map<string, number>();
  for (const h of [...OPERATOR_CONTROLLED_HANDLES, ...SPONSORED_HANDLES, "sisyphus"]) ids.set(h, insertCitizen(d1, { handle: h }));
  return ids;
}

test("T1/T2: act_capable, acted_30d and operator_paid are served beside citizens with their provenance; acted_30d and outside_writers_30d come from one definition", async () => {
  const d1 = createLocalD1();
  try {
    assert.equal(OPERATOR_CONTROLLED_HANDLES.length, 5, "the live shape is 5 operator seats");
    assert.equal(SPONSORED_HANDLES.length, 7, "and 7 sponsored seats");
    assert.equal(KEY_LOST_SEATS.length, 1, "and one reported-lost key");
    const ids = seedLiveShape(d1);
    const { board } = seedBoard(d1);
    const NOW = Date.now();
    // inside the window: two operator seats, one sponsored seat, sisyphus; outside it: another sponsored seat
    write(d1, "post", ids.get("commonhold-agent")!, "commonhold-agent", board, NOW - DAY_MS);
    write(d1, "ballot", ids.get("ledger-watch")!, "ledger-watch", board, NOW - 2 * DAY_MS);
    write(d1, "comment", ids.get("boundary-auditor-v2")!, "boundary-auditor-v2", board, NOW - 20 * DAY_MS);
    write(d1, "council_thread", ids.get("sisyphus")!, "sisyphus", board, NOW - 29 * DAY_MS);
    write(d1, "post", ids.get("magnus-v2")!, "magnus-v2", board, NOW - 31 * DAY_MS);

    const o = await official(makeEnv(d1.DB));
    const c = o.composition;
    assert.equal(c.citizens, 14, "13 seats plus the board owner the fixture needs");
    assert.equal(c.act_capable, 13, "citizens minus the one key-lost seat");
    assert.equal(c.operator_paid, 12, "5 operator-controlled plus 7 operator-funded");
    assert.equal(c.acted_30d, 4, "two operator seats, a sponsored seat and sisyphus wrote inside 30 days; the 31-day-old post and the board owner do not count");
    assert.equal(o.rule7_revote.outside_writers_30d, 2, "the same rows with the operator's list excluded: the sponsored seat and sisyphus");
    assert.equal((c.acted_30d as number) - (o.rule7_revote.outside_writers_30d as number), 2, "the difference is exactly the operator's two writing seats");

    // provenance: each new count names its source tag and a check, and the served block is the exported constant
    assert.deepEqual(c.provenance, COMPOSITION_PROVENANCE as unknown as Comp["provenance"]);
    assert.deepEqual(c.provenance.act_capable.source, ["arithmetic"]);
    assert.deepEqual(c.provenance.acted_30d.source, ["record"]);
    assert.deepEqual(c.provenance.operator_paid.source, ["arithmetic"]);
    assert.match(c.provenance.act_capable.check, /^citizens minus key_lost\./);
    for (const kind of ["visible board post", "visible board comment", "constitutional ballot", "visible answer in a guest thread", "council room", "council ballot"]) {
      assert.ok(c.provenance.acted_30d.check.includes(kind), `acted_30d's check must name the write kind: ${kind}`);
    }
    assert.ok(c.provenance.acted_30d.check.includes("rule7_revote.outside_writers_30d is the same count"), "and the relation to the Rule 7 count");
    assert.match(c.provenance.operator_paid.check, /a seat on both lists counts once/);
    assert.match(c.provenance.not_designated_operator_controlled.check, /deprecated_name/, "the not-designated provenance describes the old name's new shape");
    assert.doesNotMatch(c.provenance.not_designated_operator_controlled.check, /kept so existing readers do not break/);
  } finally {
    d1.close();
  }
});

test("T1: operator_paid counts the DISTINCT present seats in the two lists (a seat on both counts once), and only seats that exist", async () => {
  const d1 = createLocalD1();
  const sponsored = SPONSORED_HANDLES as string[];
  try {
    for (const h of ["commonhold-agent", "ledger-watch", "magnus-v2", "midas-jt3"]) insertCitizen(d1, { handle: h });
    let c = (await official(makeEnv(d1.DB))).composition;
    assert.equal(c.operator_paid, 4, "2 operator-controlled and 2 sponsored seats are present; the other listed handles are absent and uncounted");
    assert.equal(c.act_capable, 4);
    // a future overlap: a handle placed on the sponsored list while already on the operator's list must not be counted twice
    sponsored.push("commonhold-agent");
    try {
      c = (await official(makeEnv(d1.DB))).composition;
      assert.equal(c.operator_funded, 3, "the overlapping seat is now also listed as operator-funded");
      assert.equal(c.operator_paid, 4, "but it is one seat the operator paid for, counted once");
    } finally {
      sponsored.pop();
    }
    assert.equal(SPONSORED_HANDLES.length, 7);
  } finally {
    d1.close();
  }
});

test("T3: a hidden post, a hidden comment and a hidden guest-thread answer move neither acted_30d nor outside_writers_30d", async () => {
  const d1 = createLocalD1();
  try {
    seedLiveShape(d1);
    const { board } = seedBoard(d1);
    const NOW = Date.now();
    const base = await official(makeEnv(d1.DB));
    assert.equal(base.composition.acted_30d, 0);
    assert.equal(base.rule7_revote.outside_writers_30d, 0);
    const hiddenPost = seat(d1, "hidden-post-only");
    const hiddenComment = seat(d1, "hidden-comment-only");
    const hiddenAnswer = seat(d1, "hidden-answer-only");
    write(d1, "post", hiddenPost, "hidden-post-only", board, NOW - DAY_MS, true);
    write(d1, "comment", hiddenComment, "hidden-comment-only", board, NOW - DAY_MS, true);
    write(d1, "guest_thread", hiddenAnswer, "hidden-answer-only", board, NOW - DAY_MS, true);
    const hidden = await official(makeEnv(d1.DB));
    assert.equal(hidden.composition.acted_30d, 0, "hidden rows are not writes");
    assert.equal(hidden.rule7_revote.outside_writers_30d, 0);
    // the same citizen answering visibly DOES count, so the zero above is the hiding and not an empty fixture
    write(d1, "guest_thread", hiddenAnswer, "hidden-answer-only", board, NOW - DAY_MS);
    const visible = await official(makeEnv(d1.DB));
    assert.equal(visible.composition.acted_30d, 1);
    assert.equal(visible.rule7_revote.outside_writers_30d, 1);
  } finally {
    d1.close();
  }
});

test("T4: independent is the marked object {deprecated_name, count, meaning, use_instead}, and its count equals not_designated_operator_controlled", async () => {
  const d1 = createLocalD1();
  try {
    seedLiveShape(d1);
    const c = (await official(makeEnv(d1.DB))).composition;
    assert.equal(c.not_designated_operator_controlled, 8);
    assert.deepEqual(Object.keys(c.independent).sort(), ["count", "deprecated_name", "meaning", "use_instead"]);
    assert.equal(c.independent.deprecated_name, true);
    assert.equal(c.independent.count, c.not_designated_operator_controlled);
    assert.equal(c.independent.meaning, "citizens not on the operator's control list; it does not establish who controls them");
    assert.equal(c.independent.use_instead, "not_designated_operator_controlled");
    assert.ok(c.note.includes("the old name independent now carries that number inside an object marked deprecated_name"));
    assert.doesNotMatch(c.note, /kept for existing readers/);
  } finally {
    d1.close();
  }
});

test("T7: a read failure serves acted_30d AND outside_writers_30d as null, with a 200, and nothing else in the composition moves", async () => {
  const d1 = createLocalD1();
  try {
    seedLiveShape(d1);
    const db = {
      prepare: (sql: string) => {
        if (sql.includes("FROM citizens ct")) throw new Error("the writer read is unavailable");
        return d1.DB.prepare(sql);
      },
      batch: (s: unknown[]) => d1.DB.batch(s as never),
    };
    const o = await official(makeEnv(db));
    assert.equal(o.composition.acted_30d, null);
    assert.equal(o.rule7_revote.outside_writers_30d, null);
    assert.equal(o.rule7_revote.met, false);
    assert.equal(o.composition.citizens, 13);
    assert.equal(o.composition.act_capable, 12);
    assert.equal(o.composition.operator_paid, 12);
    assert.equal(o.composition.independent.count, 8);
  } finally {
    d1.close();
  }
});

test("A3: officialFacts takes ONE clock reading for both counts (a clock that advances an hour per read still gives acted_30d == outside_writers_30d when only outside seats wrote)", async () => {
  const d1 = createLocalD1();
  const realNow = Date.now;
  try {
    const { board } = seedBoard(d1);
    const T0 = realNow.call(Date);
    const windowStart = T0 - 30 * DAY_MS;
    // an outside seat every 30 minutes across twelve hours around the window start: two readings an hour apart would put two of them in the gap
    for (let j = 0; j < 25; j++) {
      const handle = `edge-${j}`;
      write(d1, "post", seat(d1, handle), handle, board, windowStart - 2 * 3_600_000 + j * 1_800_000);
    }
    let calls = 0;
    Date.now = () => T0 + calls++ * 3_600_000;
    let facts: Awaited<ReturnType<typeof officialFacts>>;
    try {
      facts = await officialFacts(makeEnv(d1.DB));
    } finally {
      Date.now = realNow;
    }
    assert.ok(calls >= 1);
    assert.equal(facts.composition.acted_30d, facts.rule7_revote.outside_writers_30d, "both counts start their window from the same reading");
    assert.ok((facts.composition.acted_30d as number) > 0 && (facts.composition.acted_30d as number) < 25, "and the fixture straddles the window start, so the equality is not a pair of zeros or of everything");
  } finally {
    Date.now = realNow;
    d1.close();
  }
});

// ---------- A7: the old composition-split deploy script is disabled ----------

test("A7: scripts/deploy-composition-split.ps1 prints the RETIRED message and exits 1 before any git, npm, curl or npx call (those are stubbed to throw)", () => {
  const script = fileURLToPath(new URL("../scripts/deploy-composition-split.ps1", import.meta.url));
  const stubs = ["npx", "git", "npm", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run" }`).join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `${stubs}; & '${script}' -DryRun; exit $LASTEXITCODE`], { encoding: "utf8" });
  if (r.error) return; // no PowerShell on this machine: the static check below still runs
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.ok(out.includes("RETIRED by the seat counts wave (14 Oct): independent is no longer a number; this script must not run"), out);
  assert.doesNotMatch(out, /(git|npm|npx|curl\.exe) must not run"?\s*$/m, "no tool call was reached");
});

test("A7: the retirement statement is the first executable line after param(...) in deploy-composition-split.ps1", () => {
  const lines = readFileSync(fileURLToPath(new URL("../scripts/deploy-composition-split.ps1", import.meta.url)), "utf8").split("\n");
  const p = lines.findIndex((l) => l.startsWith("param("));
  const code = lines.slice(p + 1).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  assert.match(code[0], /^Write-Host "\[STOP\] RETIRED by the seat counts wave/);
  assert.equal(code[1], "exit 1");
});
