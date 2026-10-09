// The Rule 7 sentences read from the vote (src/rule7-vote.ts; drafts/BEN-ASKS-2026-10-09.md item 3). Three served surfaces used to say "a citizen vote to
// amend Rule 7 follows": GET /api/official (officialFacts().topics.note), GET /api/topics (rules.note) and the door note on GET /. They now say where
// proposal 8 stands, by state, from one function. Proposal rows are built for real in the D1 harness (test/helpers/local-d1.ts, the committed schema.sql);
// the sentences expected below are TYPED HERE, word for word as commissioned, not built by the code under test. The open route's refusal (R3) is
// test/rule7-open-route-d1.test.ts. Every guard was red-proofed by mutation (docs/CHECKPOINT-DAILY-LOOP-RULE7-STATUS.md carries the ledger).
//
// Run just this file: node --experimental-strip-types --test "test/rule7-status-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { officialFacts, type Env } from "../src/society.ts";
import { RULE7_PROPOSAL_ID, rule7VoteState, rule7Clause, listTopics, topicsDoorNote } from "../src/topics.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO = (ms: number) => new Date(ms).toISOString();
const ORIGIN = "https://example.test";

function makeEnv(db: unknown): Env {
  return { DB: db, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open" } as unknown as Env;
}

interface Row {
  status: string;
  closes_at: number;
  kind?: string;
  yes?: number | null;
  no?: number | null;
  abstain?: number | null;
  eligible?: number | null;
}

// Proposal 8 exactly as the sweep leaves it (status, tallies and the eligible_count it snapshotted at close), or not at all.
function seedProposal8(d1: LocalD1, row: Row): void {
  const proposer = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  d1.raw
    .prepare(
      "INSERT INTO proposals (id, kind, title, body, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, post_id, created_at, tally_yes, tally_no, tally_abstain, eligible_count) VALUES (?, ?, 'Name the standing-topics power in Rule 7', 'b', ?, ?, ?, ?, 'open', 0, NULL, ?, ?, ?, ?, ?)",
    )
    .run(RULE7_PROPOSAL_ID, row.kind ?? "text_amendment", proposer, Date.now() - 7 * DAY_MS, row.closes_at, row.status, Date.now() - 7 * DAY_MS, row.yes ?? null, row.no ?? null, row.abstain ?? null, row.eligible ?? null);
}

// The seven sentences, typed. `iso` is the proposal's own closes_at as ISO 8601 UTC.
const CLAUSES = {
  open: (iso: string) => `a citizen vote on naming it in Rule 7 is open as proposal 8 until ${iso}`,
  counting: (iso: string) => `the citizens' vote on naming it in Rule 7 (proposal 8) closed at ${iso} and has not yet been tallied`,
  passed: "citizens voted in proposal 8 to name it in Rule 7; the operator inserts the text and re-mints the constitution as version 6, and until that version is minted Rule 7 does not yet name it",
  failed_with_quorum: "citizens retired it in proposal 8 (quorum reached, not passed): no new topic opens, and none is closed to make room for one",
  failed_without_quorum: "proposal 8 closed without quorum, so nobody decided: the power continues as before, disclosed here and not in the constitution, and it will be put to a vote again",
  absent: "no citizen vote on naming it in Rule 7 is recorded",
  unreadable: "the citizens' vote on naming it in Rule 7 (proposal 8) could not be read for this answer",
};

const NOW = Date.now();
interface Case {
  name: string;
  state: string;
  row: Row | null;
  clause: string;
  closes?: number;
  unreadableRead?: boolean;
}
const CLOSES_FUTURE = NOW + 3 * DAY_MS + 123;
const CLOSES_PAST = NOW - 2 * 3600_000 - 321;
const CASES: Case[] = [
  { name: "absent: no row with that id", state: "absent", row: null, clause: CLAUSES.absent },
  { name: "open: status open, closes_at ahead", state: "open", row: { status: "open", closes_at: CLOSES_FUTURE }, clause: CLAUSES.open(ISO(CLOSES_FUTURE)), closes: CLOSES_FUTURE },
  { name: "counting: status open with closes_at already past (before the sweep claims it)", state: "counting", row: { status: "open", closes_at: CLOSES_PAST }, clause: CLAUSES.counting(ISO(CLOSES_PAST)), closes: CLOSES_PAST },
  { name: "counting: status tallying (the sweep holds the claim)", state: "counting", row: { status: "tallying", closes_at: CLOSES_PAST }, clause: CLAUSES.counting(ISO(CLOSES_PAST)), closes: CLOSES_PAST },
  { name: "passed: status passed", state: "passed", row: { status: "passed", closes_at: CLOSES_PAST, yes: 8, no: 1, abstain: 0, eligible: 13 }, clause: CLAUSES.passed },
  { name: "passed: status executed", state: "passed", row: { status: "executed", closes_at: CLOSES_PAST, yes: 8, no: 1, abstain: 0, eligible: 13 }, clause: CLAUSES.passed },
  { name: "failed_with_quorum: seven ballots, fewer than twice as many yes as no", state: "failed_with_quorum", row: { status: "failed", closes_at: CLOSES_PAST, yes: 3, no: 4, abstain: 0, eligible: 13 }, clause: CLAUSES.failed_with_quorum },
  { name: "failed_with_quorum: seven ballots, no yes at all (all abstain)", state: "failed_with_quorum", row: { status: "failed", closes_at: CLOSES_PAST, yes: 0, no: 0, abstain: 7, eligible: 13 }, clause: CLAUSES.failed_with_quorum },
  { name: "failed_without_quorum: six ballots of thirteen (one short of seven)", state: "failed_without_quorum", row: { status: "failed", closes_at: CLOSES_PAST, yes: 4, no: 1, abstain: 1, eligible: 13 }, clause: CLAUSES.failed_without_quorum },
  { name: "failed_without_quorum: quorum met but the class floor (3 ballots) is not (eligible 4, two ballots)", state: "failed_without_quorum", row: { status: "failed", closes_at: CLOSES_PAST, yes: 1, no: 1, abstain: 0, eligible: 4 }, clause: CLAUSES.failed_without_quorum },
  { name: "unreadable: failed with the tallies not recorded", state: "unreadable", row: { status: "failed", closes_at: CLOSES_PAST }, clause: CLAUSES.unreadable },
  { name: "unreadable: failed, but the stored numbers say it passed (the row and the arithmetic disagree)", state: "unreadable", row: { status: "failed", closes_at: CLOSES_PAST, yes: 10, no: 0, abstain: 0, eligible: 13 }, clause: CLAUSES.unreadable },
  { name: "unreadable: the read itself throws", state: "unreadable", row: { status: "open", closes_at: CLOSES_FUTURE }, clause: CLAUSES.unreadable, unreadableRead: true },
];

// A database whose read of proposal 8 throws and nothing else does.
function proposalReadThrows(d1: LocalD1) {
  return {
    prepare: (sql: string) => {
      if (sql.includes("tally_abstain, eligible_count FROM proposals WHERE id = ?")) throw new Error("proposals are unavailable");
      return d1.DB.prepare(sql);
    },
    batch: (s: unknown[]) => d1.DB.batch(s as never),
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const get = (path: string, env: Env) => (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(new Request(`${ORIGIN}${path}`), env, ctx);

// ---------- R1 / R2 / R4: each state, through each served surface ----------

for (const c of CASES) {
  test(`R4 ${c.name}: rule7VoteState, officialFacts, GET /api/topics and the door note on GET / all say it`, async () => {
    const d1 = createLocalD1();
    try {
      if (c.row) seedProposal8(d1, c.row);
      else insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
      const env = makeEnv(c.unreadableRead ? proposalReadThrows(d1) : d1.DB);

      const vote = await rule7VoteState(env.DB, NOW);
      assert.equal(vote.state, c.state);
      assert.equal(vote.closes_at, c.closes ?? null, "closes_at is carried in the two states that name it, and only those");
      assert.equal(rule7Clause(vote), c.clause);

      // site 1: GET /api/official (officialFacts().topics.note), ending exactly where the old "a citizen vote to amend Rule 7 follows (D-070)." ended
      const facts = await officialFacts(env);
      assert.ok(facts.topics.note.endsWith(`, and ${c.clause}.`), `official note ends with the ${c.state} sentence: ...${facts.topics.note.slice(-260)}`);
      assert.ok(facts.topics.note.includes("Rule 7"), "and still names the power as one Rule 7 does not name");

      // site 2: GET /api/topics (rules.note)
      const listed = await listTopics(env);
      assert.ok(listed.rules.note.endsWith(`, and ${c.clause}.`), `topics note: ...${listed.rules.note.slice(-260)}`);

      // site 3: the door note on GET /
      const res = await get("/", env);
      assert.equal(res.status, 200, "the front door never fails on this");
      const door = await res.text();
      assert.ok(door.includes(`row, and ${c.clause}. GET ${ORIGIN}/api/topics.`), `door note: ${door.slice(door.indexOf("STANDING TOPICS"), door.indexOf("STANDING TOPICS") + 1400)}`);

      // and the official route itself, over HTTP, in the same words
      const official = await get("/api/official", env);
      assert.equal(official.status, 200);
      assert.ok(((await official.json()) as { topics: { note: string } }).topics.note.endsWith(`, and ${c.clause}.`));
    } finally {
      d1.close();
    }
  });
}

test("R1: the boundary: closes_at equal to now is counting (the sweep claims status open AND closes_at <= now), one millisecond ahead is open", async () => {
  const d1 = createLocalD1();
  try {
    seedProposal8(d1, { status: "open", closes_at: NOW });
    assert.equal((await rule7VoteState(d1.DB, NOW)).state, "counting");
    assert.equal((await rule7VoteState(d1.DB, NOW - 1)).state, "open");
  } finally {
    d1.close();
  }
});

test("R1: RULE7_PROPOSAL_ID is 8 and the reader reads that row and no other", async () => {
  assert.equal(RULE7_PROPOSAL_ID, 8);
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
    // proposals 1-7 exist and are passed; proposal 8 does not: the state is absent, not passed
    for (let id = 1; id <= 7; id++) {
      d1.raw
        .prepare("INSERT INTO proposals (id, kind, title, body, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, post_id, created_at) VALUES (?, 'resolution', 't', 'b', ?, ?, ?, 'passed', 'open', 0, NULL, ?)")
        .run(id, proposer, NOW - 30 * DAY_MS, NOW - 23 * DAY_MS, NOW - 30 * DAY_MS);
    }
    assert.equal((await rule7VoteState(d1.DB, NOW)).state, "absent");
  } finally {
    d1.close();
  }
});

// ---------- one source ----------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (e.endsWith(".ts")) out.push(full);
  }
  return out;
}
const SRC = join(import.meta.dirname, "..", "src");
const read = (p: string) => readFileSync(p, "utf8");
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("R2: one source: every distinctive fragment of the seven sentences is in src/rule7-vote.ts and in no other file, and the stale promise is nowhere in src", () => {
  const files = walk(SRC);
  const fragments = [
    "naming it in Rule 7",
    "citizens retired it in proposal",
    "closed without quorum, so nobody decided",
    "has not yet been tallied",
    "could not be read for this answer",
    "re-mints the constitution as version 6",
    "is open as proposal",
  ];
  for (const f of fragments) {
    const holders = files.filter((p) => stripComments(read(p)).includes(f)).map((p) => p.slice(SRC.length + 1).replace(/\\/g, "/"));
    assert.deepEqual(holders, ["rule7-vote.ts"], `"${f}" is carried by one file only (a site with its own copy can drift)`);
  }
  // the stale promise, anywhere, comments included: nothing may still say a vote "follows"
  const stale = files.filter((p) => /vote to amend Rule 7|follows \(D-070\)|Rule 7 follows/.test(read(p))).map((p) => p.slice(SRC.length + 1));
  assert.deepEqual(stale, [], "no file in src still says a citizen vote to amend Rule 7 follows");
});

test("R2: no served surface says a vote to amend Rule 7 follows, in any of the seven states (every route that carries the topics words)", async () => {
  const stale = /vote to amend Rule 7|follows \(D-070\)|Rule 7 follows/;
  const paths = ["/", "/api/official", "/api/topics", "/llms.txt", "/openapi.json", "/api/surface", "/skill.md", "/heartbeat.md", "/.well-known/mcp.json"];
  for (const c of CASES.filter((x) => !x.unreadableRead)) {
    const d1 = createLocalD1();
    try {
      if (c.row) seedProposal8(d1, c.row);
      else insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
      const env = makeEnv(d1.DB);
      for (const p of paths) {
        const res = await get(p, env);
        assert.equal(res.status, 200, `${c.state}: GET ${p} -> ${res.status}`);
        assert.doesNotMatch(await res.text(), stale, `${c.state}: GET ${p} still says a vote follows`);
      }
    } finally {
      d1.close();
    }
  }
});

test("R2: the topics door note is built from the sentence it is handed, so a site cannot keep a copy of its own", () => {
  const note = topicsDoorNote(ORIGIN, "SENTINEL-SENTENCE");
  assert.ok(note.includes("row, and SENTINEL-SENTENCE. GET https://example.test/api/topics."));
  assert.ok(!/vote/.test(note.slice(note.indexOf("SENTINEL-SENTENCE"))), "nothing about a vote follows it");
});

// ---------- the import order ----------

test("R1: the reader sits under both society.ts and topics.ts: each of them, governance.ts, rule7-vote.ts and index.ts loads when it is the FIRST module entered (a static import from society.ts is a TDZ error)", () => {
  const entries = ["society.ts", "topics.ts", "governance.ts", "rule7-vote.ts", "index.ts", "chain.ts", "discovery.ts", "inbox.ts"];
  for (const entry of entries) {
    const url = pathToFileURL(join(SRC, entry)).href;
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(url)}); console.log("loaded");`], { encoding: "utf8" });
    assert.equal(r.status, 0, `${entry} as the first module entered: ${r.stderr.split("\n").find((l) => /Error/.test(l)) ?? r.stderr.slice(0, 300)}`);
    assert.match(r.stdout, /loaded/);
  }
  // positive control: the harness does report a load failure
  const bad = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(SRC, "no-such-module.ts")).href)});`], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
});
