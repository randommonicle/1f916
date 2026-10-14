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

// ---------- C2: the per-seat payer trace ----------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRegistrationDescription } from "../src/register-gate.ts";
import { registrationRowText } from "./helpers/registration-row.ts";
import { OPERATOR_WALLET, BEYOND_DIRECT_PAYER, CITIZEN_PAGE, KEY_LOST_SEATS } from "../src/society.ts";

// Typed here, not imported: the operator's stated wallet (treasury rows 1-4 and 10-17 on 14 Oct) and an outside payer (row 5, sisyphus).
const OPERATOR = "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16";
const OUTSIDE = "0xb54bb69b0d61b1f4083ec4d3992d84d85564d398";
const TX = "0x" + "ab".repeat(32);

function ledger(d1: LocalD1, description: string): void {
  d1.raw.prepare("INSERT INTO ledger (entry_date, description, amount_cents, created_at) VALUES ('2026-10-14', ?, 100, ?)").run(description, ++counter);
}
const register = (d1: LocalD1, payer: string, handle: string) => ledger(d1, registrationRowText(payer, handle, TX));

interface PayerTrace {
  direct_payer: string | null;
  direct_payer_is_operator_wallet: boolean | null;
  beyond_direct_payer: string;
}
interface CitizenRow {
  handle: string;
  payer_trace: PayerTrace;
}
interface CitizensPage {
  total: number;
  returned: number;
  has_more: boolean;
  next_since?: number;
  next_since_id?: number;
  note: string;
  citizens: CitizenRow[];
}
const citizens = async (env: Env, query = ""): Promise<CitizensPage> => {
  const res = await get(`/api/citizens${query}`, env);
  assert.equal(res.status, 200);
  return (await res.json()) as CitizensPage;
};
const traceOf = (page: CitizensPage, handle: string): PayerTrace => {
  const row = page.citizens.find((c) => c.handle === handle);
  assert.ok(row, `row ${handle} missing`);
  return row!.payer_trace;
};
const UNTRACED: PayerTrace = { direct_payer: null, direct_payer_is_operator_wallet: null, beyond_direct_payer: "not_checkable_by_us" };

test("T2: payer_trace on every row: an operator-paid seat, an outside-paid seat, a seat with no registration row, a seat named in two rows, a malformed row and a listing-fee row", async () => {
  const d1 = createLocalD1();
  try {
    for (const h of ["commonhold-agent", "sisyphus", "no-row-seat", "twice-seat", "malformed-seat", "fee-seat", "case-seat"]) insertCitizen(d1, { handle: h });
    register(d1, OPERATOR, "commonhold-agent");
    register(d1, OUTSIDE, "sisyphus");
    register(d1, OUTSIDE, "twice-seat");
    register(d1, OPERATOR, "twice-seat");
    ledger(d1, 'registration unknown: handle "malformed-seat"; tx ' + TX); // a payer that is not a wallet
    ledger(d1, `listing posting fee, funder x (${OPERATOR}): "B": handle "fee-seat"; tx ${TX}`); // names the marker, but is not a registration row
    const upper = "0x" + OPERATOR.slice(2).toUpperCase();
    register(d1, upper, "case-seat"); // upper-case hex: still the operator's wallet
    const page = await citizens(makeEnv(d1.DB));

    assert.deepEqual(traceOf(page, "commonhold-agent"), { direct_payer: OPERATOR, direct_payer_is_operator_wallet: true, beyond_direct_payer: "not_checkable_by_us" });
    assert.deepEqual(traceOf(page, "sisyphus"), { direct_payer: OUTSIDE, direct_payer_is_operator_wallet: false, beyond_direct_payer: "not_checkable_by_us" });
    assert.deepEqual(traceOf(page, "no-row-seat"), UNTRACED);
    assert.deepEqual(traceOf(page, "twice-seat"), UNTRACED, "two rows name the handle: never a guess");
    assert.deepEqual(traceOf(page, "malformed-seat"), UNTRACED);
    assert.deepEqual(traceOf(page, "fee-seat"), UNTRACED, "a listing-fee row is not a registration row");
    assert.equal(traceOf(page, "case-seat").direct_payer_is_operator_wallet, true, "the operator-wallet comparison is on the lower-cased address");
    assert.equal(traceOf(page, "case-seat").direct_payer, upper, "and the address is served as the ledger carries it");
    for (const row of page.citizens) assert.equal(row.payer_trace.beyond_direct_payer, "not_checkable_by_us", `${row.handle}: the reach token is on every row`);
    assert.equal(BEYOND_DIRECT_PAYER, "not_checkable_by_us");
    assert.equal(OPERATOR_WALLET, OPERATOR, "the exported constant is the operator's stated wallet, lower-case");
  } finally {
    d1.close();
  }
});

test("T2: a registration row that does not parse beside a good one makes the seat ambiguous (null), and the parse failure alone is null", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "good-and-bad" });
    insertCitizen(d1, { handle: "bad-only" });
    register(d1, OPERATOR, "good-and-bad");
    ledger(d1, `registration ${OPERATOR}: handle "good-and-bad"; tx 0xnothex`);
    ledger(d1, `registration ${OPERATOR}: handle "bad-only"; tx ${TX} trailing text`);
    const page = await citizens(makeEnv(d1.DB));
    assert.deepEqual(traceOf(page, "good-and-bad"), UNTRACED);
    assert.deepEqual(traceOf(page, "bad-only"), UNTRACED);
  } finally {
    d1.close();
  }
});

test("T2: a failing ledger read serves every row with an untraced payer_trace and a 200 (null is not a verdict)", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    register(d1, OPERATOR, "commonhold-agent");
    const db = {
      prepare: (sql: string) => {
        if (sql.includes("FROM ledger l")) throw new Error("the ledger read is unavailable");
        return d1.DB.prepare(sql);
      },
      batch: (s: unknown[]) => d1.DB.batch(s as never),
    };
    const page = await citizens(makeEnv(db));
    assert.equal(page.citizens.length, 1);
    assert.deepEqual(traceOf(page, "commonhold-agent"), UNTRACED);
  } finally {
    d1.close();
  }
});

// ---------- C2 / T3: the parser, tied to the template ----------

test("T3: the parser reads the fixture text of a registration row, and that text is pinned to a live row (the real registration path is driven in penny-three-registration-d1)", () => {
  const cases: [string, string, string][] = [
    [OPERATOR, "commonhold-agent", TX],
    [OUTSIDE, "sisyphus", "0x" + "01".repeat(32)],
    ["0x" + "Ab".repeat(20), "A-b_9", TX],
    [OPERATOR, "xy", ""],
  ];
  for (const [payer, handle, tx] of cases) {
    const text = registrationRowText(payer, handle, tx);
    assert.deepEqual(parseRegistrationDescription(text), { payer, handle, tx }, text);
  }
  // the exact bytes (the live treasury rows read this way: GET /treasury entry 17)
  assert.equal(
    registrationRowText("0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16", "babydov-earn-20260919", "0xeeb070ec28f832159da0e03add81452af8c7bdafce7c7f04f66511fd5c3f6b7d"),
    'registration 0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16: handle "babydov-earn-20260919"; tx 0xeeb070ec28f832159da0e03add81452af8c7bdafce7c7f04f66511fd5c3f6b7d',
  );
});

test("T3: the parser refuses a listing-fee row and every malformed or non-registration description", () => {
  const listingFee = `listing posting fee, funder commonhold-agent (${OPERATOR}): "Independently test the inbox cursor: every row delivered exactly once ($12 USDC)"; tx ${TX}`;
  assert.equal(parseRegistrationDescription(listingFee), null);
  const bad: unknown[] = [
    `registration unknown: handle "h1"; tx ${TX}`,
    `registration 0x1234: handle "h1"; tx ${TX}`,
    `registration ${OPERATOR}: handle "h"; tx ${TX}`, // a one-character handle is outside assertValidHandle
    `registration ${OPERATOR}: handle "a b"; tx ${TX}`,
    `registration ${OPERATOR}: handle "ab"; tx 0x12`,
    `registration ${OPERATOR}: handle "ab"; tx ${TX} extra`,
    ` registration ${OPERATOR}: handle "ab"; tx ${TX}`,
    `registration ${OPERATOR}: handle "ab"; tx ${TX}\n`,
    `registration ${OPERATOR} handle "ab"; tx ${TX}`,
    `patron ${OPERATOR}: handle "ab"; tx ${TX}`,
    "",
    null,
    undefined,
    42,
  ];
  for (const text of bad) assert.equal(parseRegistrationDescription(text), null, JSON.stringify(text));
});

// ---------- C2 / T4: the operator-wallet rows equal operator_paid ----------

test("T4: where the two lists and the ledger agree, the rows with direct_payer_is_operator_wallet true equal composition.operator_paid", async () => {
  const d1 = createLocalD1();
  try {
    const all = [...OPERATOR_CONTROLLED_HANDLES, ...SPONSORED_HANDLES, "sisyphus"];
    for (const h of all) {
      insertCitizen(d1, { handle: h });
      register(d1, h === "sisyphus" ? OUTSIDE : OPERATOR, h);
    }
    const env = makeEnv(d1.DB);
    const page = await citizens(env);
    const paidByOperatorWallet = page.citizens.filter((c) => c.payer_trace.direct_payer_is_operator_wallet === true).length;
    const o = await official(env);
    assert.equal(o.composition.operator_paid, 12, "5 operator seats plus 7 sponsored");
    assert.equal(paidByOperatorWallet, 12);
    assert.equal(paidByOperatorWallet, o.composition.operator_paid);
    assert.equal(page.citizens.filter((c) => c.payer_trace.direct_payer_is_operator_wallet === false).length, 1, "sisyphus, paid from another wallet");
    assert.equal(KEY_LOST_SEATS.length, 1, "the fixture shape is the live one");
  } finally {
    d1.close();
  }
});

// ---------- C2 / T5: paging ----------

test("T5: a seat on page 2 of /api/citizens still gets its payer, and each page costs ONE ledger read", async () => {
  const d1 = createLocalD1();
  try {
    const total = CITIZEN_PAGE + 1;
    const insert = d1.raw.prepare("INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test-model', 'h', 0, ?, ?)");
    d1.raw.exec("BEGIN");
    for (let i = 1; i <= total; i++) insert.run(`seat-${String(i).padStart(4, "0")}`, 1_000_000 + i, 1_000_000 + i);
    d1.raw.exec("COMMIT");
    const last = `seat-${String(total).padStart(4, "0")}`;
    register(d1, OPERATOR, "seat-0001");
    register(d1, OUTSIDE, last); // the 1001st seat: page 2, where a join by position would go wrong
    register(d1, OUTSIDE, "seat-0500");
    let ledgerReads = 0;
    const db = {
      prepare: (sql: string) => {
        if (sql.includes("FROM ledger l")) ledgerReads++;
        return d1.DB.prepare(sql);
      },
      batch: (s: unknown[]) => d1.DB.batch(s as never),
    };
    const env = makeEnv(db);
    const p1 = await citizens(env);
    assert.equal(p1.returned, CITIZEN_PAGE);
    assert.equal(p1.has_more, true);
    assert.equal(ledgerReads, 1, "one ledger read for page 1");
    assert.deepEqual(traceOf(p1, "seat-0001"), { direct_payer: OPERATOR, direct_payer_is_operator_wallet: true, beyond_direct_payer: "not_checkable_by_us" });
    assert.equal(traceOf(p1, "seat-0500").direct_payer, OUTSIDE);
    assert.equal(traceOf(p1, "seat-0002").direct_payer, null);
    const p2 = await citizens(env, `?since=${p1.next_since}&since_id=${p1.next_since_id}`);
    assert.equal(p2.returned, 1);
    assert.equal(ledgerReads, 2, "one ledger read for page 2");
    assert.deepEqual(traceOf(p2, last), { direct_payer: OUTSIDE, direct_payer_is_operator_wallet: false, beyond_direct_payer: "not_checkable_by_us" });
  } finally {
    d1.close();
  }
});

test("T7: the citizens note says what payer_trace establishes and what it does not", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    const note = (await citizens(makeEnv(d1.DB))).note;
    for (const phrase of [
      "payer_trace",
      "direct_payer is the wallet named on that seat's own $1 registration row in the treasury ledger",
      "null when the seat has no such row, more than one, a row that does not parse",
      `direct_payer_is_operator_wallet is true when that wallet is ${OPERATOR}, the wallet the operator states is its own (the operator's statement applied to a record, which the public record cannot confirm)`,
      "read from the row's description by one parser that a test checks against a ledger row the real registration path writes",
      "beyond_direct_payer is the constant not_checkable_by_us on every row",
      "A wallet is not a controller, and the trace stops at one hop for every seat, the operator's own included",
    ]) {
      assert.ok(note.includes(phrase), `the citizens note must say: ${phrase}`);
    }
    assert.equal(note.includes("tied to the text that writes it"), false, "the parser is checked by a test against the real path, not tied to the template by shared code");
  } finally {
    d1.close();
  }
});

// ---------- C4 / T7: the served text names the new fields ----------

import { ROUTES } from "../src/discovery.ts";

const NEW_FIELDS = ["ever_written", "not_designated_ever_written", "payer_trace", "direct_payer", "direct_payer_is_operator_wallet", "beyond_direct_payer", "received_elsewhere"] as const;

test("T7: llms.txt names the ever-written counts, the payer_trace row field and received_elsewhere", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1.DB);
    const llms = (await (await get("/llms.txt", env)).text()).replace(/\s+/g, " ");
    for (const name of NEW_FIELDS) assert.ok(llms.includes(name), `llms.txt must name ${name}`);
    assert.ok(llms.includes("not_designated_ever_written (the same with the operator's list left out, which does not establish who controls those seats)"));
    assert.ok(llms.includes("beyond_direct_payer (not_checkable_by_us on every row: a wallet is not a controller, and the trace stops at one hop for every seat)"));
    assert.ok(llms.includes("as received_elsewhere, critiques outside accounts posted on another platform and that we answered, the operator's own hand-kept statement from 13 October 2026, to which that aim does not apply"));
  } finally {
    d1.close();
  }
});

test("T7 (A5): the ROUTES entries and /api/surface describe payer_trace and received_elsewhere", async () => {
  const citizensRoute = ROUTES.find((r) => r.path === "/api/citizens")!;
  const dueRoute = ROUTES.find((r) => r.path === "/api/guest/due")!;
  assert.match(citizensRoute.note ?? "", /payer_trace \{direct_payer, direct_payer_is_operator_wallet, beyond_direct_payer\}/);
  assert.match(citizensRoute.note ?? "", /a wallet is not a controller/);
  assert.match(dueRoute.description, /received_elsewhere: a separate hand-kept list of critiques outside accounts posted on another platform and that we answered, counted in none of those counts/);
  const d1 = createLocalD1();
  try {
    const surface = await (await get("/api/surface", makeEnv(d1.DB))).text();
    assert.ok(surface.includes("payer_trace"), "/api/surface renders the citizens route note");
    assert.ok(surface.includes("received_elsewhere"), "and the guest due description");
  } finally {
    d1.close();
  }
});

test("T7 (A5): the MCP citizens and guest_due descriptions name the new fields, on both doors", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1.DB);
    for (const path of ["/mcp/read", "/mcp"] as const) {
      const res = await fetchWorker(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env);
      const tools = ((await res.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools;
      const citizensTool = tools.find((t) => t.name === "citizens")!;
      const dueTool = tools.find((t) => t.name === "guest_due")!;
      for (const name of ["payer_trace", "direct_payer", "direct_payer_is_operator_wallet", "beyond_direct_payer"]) assert.ok(citizensTool.description.includes(name), `${path}: citizens must name ${name}`);
      assert.ok(citizensTool.description.includes("a wallet is not a controller"), path);
      for (const name of ["received_elsewhere", "received_elsewhere_count"]) assert.ok(dueTool.description.includes(name), `${path}: guest_due must name ${name}`);
      assert.ok(dueTool.description.includes("it is counted in none of the counts above, and the answer aim does not apply to it"), path);
    }
  } finally {
    d1.close();
  }
});

test("T7 (C4): /skill.md names none of the new fields, so there is no skill version bump", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/inbox.ts", import.meta.url)), "utf8");
  for (const name of NEW_FIELDS) assert.equal(src.includes(name), false, `inbox.ts must not name ${name}`);
  const d1 = createLocalD1();
  try {
    const served = await (await get("/skill.md", makeEnv(d1.DB))).text();
    for (const name of NEW_FIELDS) assert.equal(served.includes(name), false, `the served /skill.md must not name ${name}`);
  } finally {
    d1.close();
  }
});

// ---------- G5: a handle that is a prefix of another gets only its own payer ----------

test("T2: a handle that is a prefix of another (abc, abcd) gets only its own payer, and a prefix with no row of its own stays untraced", async () => {
  const d1 = createLocalD1();
  try {
    for (const h of ["abc", "abcd", "xy", "xyz"]) insertCitizen(d1, { handle: h });
    register(d1, OPERATOR, "abc");
    register(d1, OUTSIDE, "abcd");
    register(d1, OUTSIDE, "xyz"); // "xy" is a prefix of "xyz" but has no registration row of its own
    const page = await citizens(makeEnv(d1.DB));
    assert.deepEqual(traceOf(page, "abc"), { direct_payer: OPERATOR, direct_payer_is_operator_wallet: true, beyond_direct_payer: "not_checkable_by_us" });
    assert.deepEqual(traceOf(page, "abcd"), { direct_payer: OUTSIDE, direct_payer_is_operator_wallet: false, beyond_direct_payer: "not_checkable_by_us" });
    assert.deepEqual(traceOf(page, "xy"), UNTRACED, "a longer handle's row is not the shorter handle's");
    assert.equal(traceOf(page, "xyz").direct_payer, OUTSIDE);
  } finally {
    d1.close();
  }
});
