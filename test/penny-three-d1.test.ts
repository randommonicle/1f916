// The penny-three wave (14 Oct 2026, wave 2; brief drafts/BRIEF-PENNY-THREE-2026-10-14.md with amendments A1-A5; commission
// drafts/BUILDER-COMMISSION-PENNY-THREE-2026-10-14.md): composition.ever_written / not_designated_ever_written, payer_trace on each
// GET /api/citizens row, and received_elsewhere on GET /api/guest/due. Real rows in the D1 harness (test/helpers/local-d1.ts, the committed
// schema.sql); expected values are typed here, never computed by the code under test.
//
// Run just this file: node --experimental-strip-types --test "test/penny-three-d1.test.ts"

import test, { after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES, type Env } from "../src/society.ts";

// Nothing here may reach the network: any fetch is an answer that is never ok, so a test cannot leave the machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("network stubbed in test", { status: 500 })) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = "https://example.test";

function makeEnv(db: unknown): Env {
  return { DB: db, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open", MAINTAINER_SECRET: "penny-three-secret-for-tests" } as unknown as Env;
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const fetchWorker = (req: Request, env: Env) => (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(req, env, ctx);
const get = (path: string, env: Env) => fetchWorker(new Request(`${ORIGIN}${path}`), env);

// ---------- fixture: one citizen per write arm ----------

let counter = 0;
const ARMS = ["post", "comment", "ballot", "guest_thread", "council_thread", "council_ballots"] as const;
type Arm = (typeof ARMS)[number];

// A board post for the comment arm and a proposal for the ballot arm to hang off. The post is itself HIDDEN (mod_state 'removed') so its owner is not a writer: the ever-written
// count has no window, so an owner with a visible post would be counted.
function seedBoard(d1: LocalD1): { board: number } {
  const owner = insertCitizen(d1, { handle: "board-owner-not-counted" });
  const r = d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, mod_state, created_at) VALUES (?, 't', 'b', 'board-h', 'removed', ?)").run(owner, 1);
  return { board: Number(r.lastInsertRowid) };
}

// Writes ONE row of the given arm for `citizen`, `at` epoch ms. `hidden` marks the row moderated where the table has a moderation column.
function write(d1: LocalD1, arm: Arm, citizen: number, handle: string, board: number, at: number, hidden = false): void {
  const mod = hidden ? "removed" : null;
  const n = ++counter;
  switch (arm) {
    case "post":
      d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, mod_state, created_at) VALUES (?, 'a post', 'b', ?, ?, ?)").run(citizen, `p3-h${n}`, mod, at);
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

interface Comp {
  citizens: number;
  acted_30d: number | null;
  ever_written: number | null;
  not_designated_ever_written: number | null;
  operator_paid: number;
  operator_controlled: number;
  not_designated_operator_controlled: number;
  provenance: Record<string, { source: string[]; check: string }>;
  note: string;
}
interface Official {
  composition: Comp;
  rule7_revote: { outside_writers_30d: number | null };
}
const official = async (env: Env): Promise<Official> => {
  const res = await get("/api/official", env);
  assert.equal(res.status, 200);
  return (await res.json()) as Official;
};

// ---------- C1 / T1: the two ever-written counts ----------

test("T1: ever_written and not_designated_ever_written count all six arms with no window, leave out hidden rows, and the exclusion is the operator's list only", async () => {
  const d1 = createLocalD1();
  try {
    const { board } = seedBoard(d1);
    const OLD = Date.now() - 400 * DAY_MS; // far outside any 30-day window: only an unwindowed count sees it
    // six seats, one write arm each; the first is an operator seat
    const handles = ["commonhold-agent", "arm-comment", "arm-ballot", "arm-guest", "arm-council-thread", "arm-council-ballot"];
    const arms: Arm[] = ["post", "comment", "ballot", "guest_thread", "council_thread", "council_ballots"];
    handles.forEach((h, i) => write(d1, arms[i]!, insertCitizen(d1, { handle: h }), h, board, OLD));
    // a seat whose only writes are hidden does not count, and a seat that never wrote does not count
    const hiddenOnly = insertCitizen(d1, { handle: "hidden-only" });
    write(d1, "post", hiddenOnly, "hidden-only", board, OLD, true);
    write(d1, "comment", hiddenOnly, "hidden-only", board, OLD, true);
    write(d1, "guest_thread", hiddenOnly, "hidden-only", board, OLD, true);
    insertCitizen(d1, { handle: "never-wrote" });
    // a seat with several writes counts once
    write(d1, "post", insertCitizen(d1, { handle: "writes-twice" }), "writes-twice", board, OLD);
    write(d1, "comment", Number((d1.raw.prepare("SELECT id FROM citizens WHERE handle = 'writes-twice'").get() as { id: number }).id), "writes-twice", board, OLD);

    const c = (await official(makeEnv(d1.DB))).composition;
    assert.equal(c.ever_written, 7, "six arm seats plus the seat that wrote twice; the hidden-only seat, the never-wrote seat and the (hidden-post) board owner do not count");
    assert.equal(c.not_designated_ever_written, 6, "the same seven with the operator's one writing seat left out");
    assert.equal(c.acted_30d, 0, "every write is 400 days old: the 30-day figure sees none of them");
    assert.deepEqual(c.provenance.ever_written.source, ["record"]);
    assert.deepEqual(c.provenance.not_designated_ever_written.source, ["record"]);
    for (const key of ["ever_written", "not_designated_ever_written"] as const) {
      for (const kind of ["visible board post", "visible board comment", "constitutional ballot", "visible answer in a guest thread", "council room", "council ballot"]) {
        assert.ok(c.provenance[key]!.check.includes(kind), `${key}'s check must name the write kind: ${kind}`);
      }
      assert.match(c.provenance[key]!.check, /hidden/i, `${key}'s check says a hidden row does not count`);
    }
    assert.match(c.provenance.not_designated_ever_written.check, /does not establish who controls those seats/, "A1: bounded, never independent");
    assert.doesNotMatch(c.provenance.not_designated_ever_written.check, /independent/i);
  } finally {
    d1.close();
  }
});

test("T1: the note carries the ever-written sentence, bounded as 'absent from the operator's control list'", async () => {
  const d1 = createLocalD1();
  try {
    const { board } = seedBoard(d1);
    const NOW = Date.now();
    write(d1, "post", insertCitizen(d1, { handle: "commonhold-agent" }), "commonhold-agent", board, NOW);
    write(d1, "post", insertCitizen(d1, { handle: "sisyphus" }), "sisyphus", board, NOW);
    write(d1, "post", insertCitizen(d1, { handle: "boundary-auditor-v2" }), "boundary-auditor-v2", board, NOW);
    let c = (await official(makeEnv(d1.DB))).composition;
    assert.ok(
      c.note.includes(
        "Since the society began, 3 citizens have written at least once (ever_written, the same six kinds of write as acted_30d with no time limit), 2 of them absent from the operator's control list (not_designated_ever_written, which does not establish who controls those seats).",
      ),
      c.note,
    );
    assert.ok(c.note.indexOf("Since the society began") > c.note.indexOf("They count seats, not agents."), "after the seat counts sentence");
    assert.ok(c.note.indexOf("Since the society began") < c.note.indexOf("The other"), "and before the complement sentence");
    assert.doesNotMatch(c.note, /ever_written[^.]*independent/, "never called independent");
    void c;
  } finally {
    d1.close();
  }
});

test("T1: the ever-written sentence handles one writer, one outside seat, and none", async () => {
  const d1 = createLocalD1();
  try {
    const { board } = seedBoard(d1);
    let c = (await official(makeEnv(d1.DB))).composition;
    assert.ok(c.note.includes("Since the society began, no citizens have written at least once (ever_written, the same six kinds of write as acted_30d with no time limit), none of them absent from the operator's control list (not_designated_ever_written, which does not establish who controls those seats)."), c.note);
    write(d1, "post", insertCitizen(d1, { handle: "sisyphus" }), "sisyphus", board, Date.now());
    c = (await official(makeEnv(d1.DB))).composition;
    assert.ok(c.note.includes("Since the society began, 1 citizen has written at least once (ever_written, the same six kinds of write as acted_30d with no time limit), 1 of it absent from the operator's control list (not_designated_ever_written, which does not establish who controls that seat)."), c.note);
  } finally {
    d1.close();
  }
});

// ---------- C1 / T8: one shared writer-read failure ----------

test("T8 (A2): ONE failing writer read serves acted_30d, ever_written and not_designated_ever_written all as null, with a 200, and the note says so", async () => {
  const d1 = createLocalD1();
  try {
    const { board } = seedBoard(d1);
    for (const h of [...OPERATOR_CONTROLLED_HANDLES, ...SPONSORED_HANDLES, "sisyphus"]) write(d1, "post", insertCitizen(d1, { handle: h }), h, board, Date.now());
    const db = {
      prepare: (sql: string) => {
        if (sql.includes("FROM citizens ct")) throw new Error("the writer read is unavailable");
        return d1.DB.prepare(sql);
      },
      batch: (s: unknown[]) => d1.DB.batch(s as never),
    };
    const o = await official(makeEnv(db));
    assert.equal(o.composition.acted_30d, null);
    assert.equal(o.composition.ever_written, null);
    assert.equal(o.composition.not_designated_ever_written, null);
    assert.equal(o.rule7_revote.outside_writers_30d, null);
    assert.ok(o.composition.note.includes("How many citizens have ever written was unreadable for this response (ever_written, not_designated_ever_written)."), o.composition.note);
    assert.doesNotMatch(o.composition.note, /Since the society began/);
    assert.equal(o.composition.citizens, 14, "nothing else in the composition moves");
    // and with the read healthy the same fixture serves real numbers (the failure above is the db wrapper, not the fixture)
    const ok = await official(makeEnv(d1.DB));
    assert.equal(ok.composition.ever_written, 13);
    assert.equal(ok.composition.not_designated_ever_written, 8);
  } finally {
    d1.close();
  }
});
