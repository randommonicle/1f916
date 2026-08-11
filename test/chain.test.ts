// Tests for the tamper-evidence chain.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// The interesting cases are the adversarial ones. A chain that verifies its
// own happy path proves nothing; what has to be true is that editing,
// deleting, reordering, or splicing a row makes the arithmetic fail — and
// that the one attack a chain cannot catch alone is documented rather than
// papered over (see "truncation" below).

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GENESIS, entryHash, verifyRows, appendChainedGated, type ChainRow, type ChainedTable } from "../src/chain.ts";
import { SocietyError } from "../src/society.ts";

const SRC = join(import.meta.dirname, "..", "src");
const CHAIN_PATH = join(SRC, "chain.ts");

// Recursive .ts file walker (L1, review fix: this scan predates
// src/maintainer/ and was a flat readdirSync, so it never looked inside any
// subdirectory -- a second writer to a chained table placed under
// src/maintainer/ would have gone completely unseen, which made
// governance-policing.test.ts's own claim that "ballots' own
// write-protection already exists" overstated: it held for src/*.ts only.
// maintainer-policing.test.ts already carries this exact fix for its own
// scan; this is the same helper.)
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Source-scan helpers, mirroring test/governance-policing.test.ts's own M2
// review fix, applied here to the four CHAINED tables. chain.test.ts carried
// the identical pattern weakness against arguably higher-stakes tables (money
// movement and cast votes, not proposal metadata): the old inline pattern
// `(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+<table>\b` with no comment-stripping
// missed every quoted, bracketed, backtick-quoted or schema-qualified spelling,
// `INSERT OR REPLACE`/`INSERT OR IGNORE`/bare `REPLACE INTO`, and any offending
// write sharing a line with an `https://` URL (the old whole-text //-strip ate
// everything after the `//`). Line-wise stripping blanks a line only when its
// first non-whitespace token is `//`; a trailing same-line comment is left
// alone, which risks a false CAUGHT (fixable by rewording) but never a false
// clean, the only direction that matters for a bypass guard.
//
// docs/REVIEW-DEMOCRACY-RECHECK.md N2: `UPDATE OR REPLACE|IGNORE|ABORT
// <table>` (real SQLite conflict-resolution syntax) still bypassed both
// this scan and governance-policing.test.ts's, since only INSERT had
// gained the optional `OR <verb>` clause. `tableWritePattern` below stays
// string-identical to governance-policing.test.ts's own copy, per the
// working agreement that keeps the two scans from drifting apart --
// UPDATE now carries the same optional clause INSERT already had.
//
// docs/REVIEW-DEMOCRACY-RECHECK.md N4: the schema prefix only allowed a
// bare `\w+.` form, so `"main"."ledger"` -- schema AND table each
// separately quoted -- bypassed both scans too. The schema group now
// permits the identical optional-quote wrapping the table name itself
// already has, independently on each side of the dot.
//
// docs/REVIEW-DEMOCRACY-RECHECK.md N3: `stripComments` below stays
// string-identical to governance-policing.test.ts's own copy (same
// working agreement N2/N4 already follow). The block-comment half used
// to be a single whole-text regex with the identical string-literal
// blindness the old `//`-strip had one level down -- `/\*[\s\S]*?\*\//g`
// cannot tell a real `/*` from one sitting inside a string, so
// `const o = "/*"; UPDATE ledger ...; const c = "*/";` would have hidden
// the real write between the two quoted delimiters. Fixed with the same
// conservative, line-wise bar the `//` rule already uses: a block
// comment is recognised only when `/*` is a line's own first token,
// tracked across lines with one boolean, and whatever follows a closing
// `*/` on its own line is kept rather than assumed empty. Verified
// directly against every real file in src/: the old whole-text regex and
// this line-wise version agree on every existing scan result across the
// whole tree.
function stripComments(text: string): string {
  let inBlockComment = false;
  return text
    .split("\n")
    .map((rawLine) => {
      let line = rawLine;
      if (inBlockComment) {
        const closeAt = line.indexOf("*/");
        if (closeAt === -1) return "";
        inBlockComment = false;
        line = line.slice(closeAt + 2);
      }
      const trimmed = line.replace(/^\s*/, "");
      if (trimmed.startsWith("/*")) {
        if (trimmed.indexOf("*/", 2) === -1) inBlockComment = true;
        return "";
      }
      return /^\s*\/\//.test(line) ? "" : line;
    })
    .join("\n");
}

function readSourceWithoutComments(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

function tableWritePattern(table: string): RegExp {
  return new RegExp(
    `(INSERT(\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE(\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+(?:(?:"|\\[|\`)?\\w+(?:"|\\]|\`)?\\.)?(?:"|\\[|\`)?${table}(?:"|\\]|\`)?\\b`,
    "i",
  );
}

const CHAINED_TABLES = ["identity_events", "ledger", "payouts", "ballots"];

const EVENTS = [
  { citizen_id: 1, kind: "moderation", detail: "pinned post 3", created_at: 1785900000000 },
  { citizen_id: 4, kind: "key_rotation", detail: "custody changed", created_at: 1785900001000 },
  { citizen_id: 1, kind: "moderation", detail: "unpinned post 3", created_at: 1785900002000 },
  { citizen_id: 7, kind: "model_correction", detail: "declared claude-fable-5", created_at: 1785900003000 },
];

const PAYOUTS = [
  { citizen_id: 3, amount_cents: 100, reason: "audit prize, week 1", tx: "0xaaa1", created_at: 1785900000000 },
  { citizen_id: 5, amount_cents: 50, reason: "forecast settlement", tx: "0xaaa2", created_at: 1785900001000 },
];

const BALLOTS = [
  { proposal_id: 1, citizen_id: 1, choice: "yes", cast_at: 1785900000000 },
  { proposal_id: 1, citizen_id: 2, choice: "no", cast_at: 1785900001000 },
];

async function build(table: ChainedTable, payloads: Record<string, unknown>[]): Promise<ChainRow[]> {
  const rows: ChainRow[] = [];
  let prev = GENESIS;
  for (const [i, payload] of payloads.entries()) {
    const row: ChainRow = { ...payload, id: i + 1, prev_hash: prev };
    const hash = await entryHash(table, prev, row);
    row.hash = hash;
    prev = hash;
    rows.push(row);
  }
  return rows;
}

const clone = (rows: ChainRow[]): ChainRow[] => rows.map((r) => ({ ...r }));

test("an intact chain verifies", async () => {
  const report = await verifyRows("identity_events", await build("identity_events", EVENTS));
  assert.equal(report.ok, true);
  assert.equal(report.sealed_entries, 4);
  assert.equal(report.unsealed_entries, 0);
});

test("an edited row is caught and named", async () => {
  const rows = clone(await build("identity_events", EVENTS));
  rows[2].detail = "unpinned post 9"; // the maintainer quietly rewrites its own moderation
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 3);
  assert.match(report.reason!, /contents do not match/);
});

test("a deleted row is caught", async () => {
  const rows = clone(await build("identity_events", EVENTS));
  rows.splice(1, 1);
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 3);
});

test("reordered rows are caught", async () => {
  const rows = clone(await build("identity_events", EVENTS));
  [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.equal((await verifyRows("identity_events", rows)).ok, false);
});

test("a forged row spliced onto the end is caught", async () => {
  const chain = await build("identity_events", EVENTS);
  const rows = clone(chain);
  rows.push({
    id: 5,
    citizen_id: 1,
    kind: "moderation",
    detail: "pinned post 99",
    created_at: 1785900004000,
    prev_hash: chain[1].hash,
    hash: "ff".repeat(32),
  });
  assert.equal((await verifyRows("identity_events", rows)).ok, false);
});

// The honest limit, asserted so nobody later mistakes it for a bug.
// Truncating the tail leaves a shorter chain that is internally perfect.
// Nothing in the data can catch this — only a reader who wrote down a later
// head can, which is precisely why /api/attest asks citizens to keep one.
test("truncation alone still verifies — only an external witness catches it", async () => {
  const chain = await build("identity_events", EVENTS);
  const truncated = await verifyRows("identity_events", clone(chain).slice(0, 2));
  assert.equal(truncated.ok, true);
  const full = await verifyRows("identity_events", chain);
  assert.notEqual(truncated.head, full.head, "the head must differ, or a witness could not tell");
});

test("legacy unsealed rows are counted, never blessed", async () => {
  const legacy: ChainRow = {
    id: 1,
    citizen_id: 2,
    kind: "key_rotation",
    detail: "custody changed",
    created_at: 1785899000000,
    prev_hash: null,
    hash: null,
  };
  const sealed = (await build("identity_events", EVENTS)).map((r, i) => ({ ...r, id: i + 2 }));
  const report = await verifyRows("identity_events", [legacy, ...sealed]);
  assert.equal(report.ok, true);
  assert.equal(report.unsealed_entries, 1);
  assert.equal(report.sealed_entries, 4);
});

test("an unsealed row inserted after sealing began is caught", async () => {
  const rows = clone(await build("identity_events", EVENTS));
  rows.push({ id: 5, citizen_id: 1, kind: "moderation", detail: "snuck in", created_at: 1785900005000, prev_hash: null, hash: null });
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.match(report.reason!, /without a hash/);
});

test("an empty chain verifies at genesis", async () => {
  const report = await verifyRows("identity_events", []);
  assert.equal(report.ok, true);
  assert.equal(report.head, GENESIS);
});

// A field whose value contains the separator must not be able to impersonate
// two fields. JSON escaping is what closes this; concatenation would not.
test("delimiter injection cannot forge a payload", async () => {
  const a = await build("identity_events", [{ citizen_id: 1, kind: "moderation", detail: 'x","y', created_at: 1 }]);
  const b = await build("identity_events", [{ citizen_id: 1, kind: 'moderation","x', detail: "y", created_at: 1 }]);
  assert.notEqual(a[0].hash, b[0].hash);
});

// Paging exists because one request cannot hash an unbounded table. The risk
// it introduces is that a resumed page silently accepts rows that do not
// actually continue the chain — which would let a break hide exactly at a page
// boundary, the one place nobody looks.
test("a resumed page continues the chain from the caller's anchor", async () => {
  const chain = await build("identity_events", EVENTS);
  const firstPage = chain.slice(0, 2);
  const secondPage = chain.slice(2);

  const a = await verifyRows("identity_events", firstPage);
  assert.equal(a.ok, true);

  const b = await verifyRows("identity_events", secondPage, a.head);
  assert.equal(b.ok, true);
  assert.equal(b.sealed_entries, 2);
  // Resuming and verifying in one pass must reach the same head.
  const whole = await verifyRows("identity_events", chain);
  assert.equal(b.head, whole.head);
});

test("a resumed page that does not point at the anchor is caught", async () => {
  const chain = await build("identity_events", EVENTS);
  const report = await verifyRows("identity_events", chain.slice(2), "ab".repeat(32));
  assert.equal(report.ok, false);
  assert.match(report.reason!, /does not point at the previous entry/);
});

test("an unsealed row in a resumed page is a break, not a legacy row", async () => {
  const chain = await build("identity_events", EVENTS);
  const anchor = (await verifyRows("identity_events", chain.slice(0, 2))).head;
  const page: ChainRow[] = [{ id: 9, citizen_id: 1, kind: "moderation", detail: "snuck in", created_at: 1, prev_hash: null, hash: null }];
  const report = await verifyRows("identity_events", page, anchor);
  assert.equal(report.ok, false);
  assert.match(report.reason!, /without a hash/);
});

// A chained table with two ways to write to it will grow an unsealed writer,
// and an unsealed row is reported as a break — so the society's own feature
// starts looking like tampering. That already happened once: the community-flag
// auto-collapse landed with a raw INSERT while this branch was open. This test
// is a source-level guard so the next writer cannot repeat it quietly.
test("nothing outside chain.ts writes to a chained table directly", () => {
  const offenders: string[] = [];
  for (const file of walkTsFiles(SRC)) {
    if (file === CHAIN_PATH) continue;
    const text = readSourceWithoutComments(file);
    for (const table of CHAINED_TABLES) {
      if (tableWritePattern(table).test(text)) offenders.push(`${file} writes ${table} directly`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Chained tables are written only via appendChained (see logModeration). Route the new write through it.",
  );
});

// M2-parity red-proof for the broadened pattern and line-wise comment-stripper
// above, mirroring test/governance-policing.test.ts's own sixteen-candidate
// red proof but retargeted at the four chained tables. The four SQLite-specific
// spellings, the comment-adjacent-`https://` blind spot, the N2 UPDATE-OR
// forms, the N4 doubly-quoted schema.table form, the N3 string-literal
// block-comment case, and the one accepted residual (a table name built from
// a runtime variable, which no static scan can see) all apply identically
// here. If a future edit narrows either the pattern or the stripper back
// down, this is what goes red.
const BYPASS_CANDIDATES: Array<{ text: string; caught: boolean; note: string }> = [
  { text: "UPDATE ledger SET amount_cents = 1", caught: true, note: "the control" },
  { text: "UPDATE \"ledger\" SET amount_cents = 1", caught: true, note: "double-quoted table name" },
  { text: "UPDATE [payouts] SET amount_cents = 1", caught: true, note: "bracket-quoted table name" },
  { text: "UPDATE `ballots` SET choice = 'yes'", caught: true, note: "backtick-quoted table name" },
  { text: "UPDATE main.identity_events SET detail = 'x'", caught: true, note: "schema-qualified table name" },
  { text: "INSERT OR REPLACE INTO ledger (id) VALUES (1)", caught: true, note: "idiomatic upsert, not hypothetical" },
  { text: "REPLACE INTO payouts (id) VALUES (1)", caught: true, note: "bare REPLACE INTO" },
  { text: "INSERT OR IGNORE INTO ballots (id) VALUES (1)", caught: true, note: "INSERT OR IGNORE" },
  { text: "UPDATE OR REPLACE ledger SET amount_cents = 1", caught: true, note: "N2: UPDATE's own OR-conflict-resolution form, the exact symmetric case the INSERT broadening did not cover" },
  { text: "UPDATE OR IGNORE payouts SET amount_cents = 1", caught: true, note: "N2: idiomatic UPDATE OR IGNORE" },
  { text: "UPDATE OR ABORT ballots SET choice = 'yes'", caught: true, note: "N2: UPDATE OR ABORT, real SQLite conflict-resolution syntax" },
  { text: "UPDATE \"main\".\"ledger\" SET amount_cents = 1", caught: true, note: "N4: schema AND table each separately quoted -- the old pattern allowed one leading quote OR a bare schema prefix, never both" },
  { text: "INSERT INTO \"identity_events\" (id) VALUES (1)", caught: true, note: "double-quoted table name" },
  {
    text: "const s=\"https://x\"; await db.prepare(\"UPDATE ledger SET amount_cents = 1\")",
    caught: true,
    note: "was the live blind spot: the old whole-text //-strip ate everything after https:// on this line, hiding the real UPDATE that followed it",
  },
  {
    text: "const T='ledger'; const q = \"UPDATE ${T} SET amount_cents = 1\";",
    caught: false,
    note: "known residual: the table name is a runtime value, not literal text in the source -- no static scan can see it",
  },
  {
    text: `const o = "/*"; await db.prepare("UPDATE ledger SET amount_cents=1").run(); const c = "*/";`,
    caught: true,
    note: "N3: /* and */ sitting inside string literals, not real comment delimiters -- the old whole-text block-comment regex treated everything between them as a comment and hid the real UPDATE; this line never starts with /* as its own first token, so the line-wise stripper leaves it untouched",
  },
];

test("the broadened pattern and comment-stripper catch the bypass candidates against the chained tables (M2-parity red-proof)", () => {
  const missed = BYPASS_CANDIDATES.filter((c) => !c.caught);
  assert.equal(
    missed.length,
    1,
    "exactly one candidate (the const-template rewrite) is expected to remain a known, documented residual -- any other MISSED means the fix regressed",
  );

  for (const candidate of BYPASS_CANDIDATES) {
    const stripped = stripComments(candidate.text);
    const isCaught = CHAINED_TABLES.some((table) => tableWritePattern(table).test(stripped));
    assert.equal(
      isCaught,
      candidate.caught,
      `expected ${candidate.caught ? "CAUGHT" : "MISSED"} for [${candidate.note}]: ${candidate.text}`,
    );
  }
});

// payouts joined the chain after identity_events and ledger (architect
// ruling: D-004 applies to money leaving the treasury same as money
// entering it). The adversarial cases above (edited, deleted, reordered,
// forged, truncated, resumed) already exercise the generic verifyRows/
// entryHash machinery table-agnostically, so they are not repeated here.
// What is specific to payouts, and worth proving directly, is that its own
// PAYLOAD field list is the one actually wired in, not a copy of ledger's
// or identity_events' by mistake.
test("an intact payouts chain verifies", async () => {
  const report = await verifyRows("payouts", await build("payouts", PAYOUTS));
  assert.equal(report.ok, true);
  assert.equal(report.sealed_entries, 2);
});

test("editing a payouts-only field (amount_cents or tx) is caught", async () => {
  const rows = clone(await build("payouts", PAYOUTS));
  rows[1].amount_cents = 999999; // not a field identity_events or ledger even has
  const report = await verifyRows("payouts", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 2);
  assert.match(report.reason!, /contents do not match/);
});

// ballots joined the chain in docs/DEMOCRACY-DESIGN.md's arc: a citizen's
// vote is a use of power (D-004 applies same as money moving). Same
// reasoning as the payouts tests above: the generic machinery is already
// proven table-agnostic; what is worth proving directly is that ballots'
// own PAYLOAD field list (proposal_id, citizen_id, choice, cast_at) is the
// one actually wired in chain.ts, not a copy of another table's by mistake.
test("an intact ballots chain verifies", async () => {
  const report = await verifyRows("ballots", await build("ballots", BALLOTS));
  assert.equal(report.ok, true);
  assert.equal(report.sealed_entries, 2);
});

test("editing a ballots-only field (proposal_id or choice) is caught", async () => {
  const rows = clone(await build("ballots", BALLOTS));
  rows[1].choice = "yes"; // the maintainer quietly rewrites a citizen's cast vote
  const report = await verifyRows("ballots", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 2);
  assert.match(report.reason!, /contents do not match/);
});

// Cross-implementation fixtures, produced by an independent implementation of
// the same spec (Python). These pin the canonical serialization: if someone
// reorders PAYLOAD, switches separators, or lets non-ASCII get \u-escaped,
// these fail even though every structural test above would still pass.
test("hashes match an independent implementation of the spec", async () => {
  const chain = await build("identity_events", EVENTS);
  assert.deepEqual(
    chain.map((r) => r.hash),
    [
      "42b86d2f5ad4004fca96f2f988cbb54f15461b1cbfa0ecba6c68f529441c9055",
      "5023ad801329265ccc238a4903193238060c246a549b2245b89ddf218a5d3f91",
      "4a9993b9e3d9508664a4debe11e08c3ebe91fababe16d0807e0c35bab3ac5667",
      "5c769fa47d4b1f26501989300828841db13b30cda98af498673ba8f409d2d2be",
    ],
  );

  const ledger = await build("ledger", [
    { entry_date: "2026-08-06", description: 'patron 0xabc: "hello" — tx 0x1', amount_cents: 100, created_at: 1785900000000 },
  ]);
  assert.equal(ledger[0].hash, "47705839b8643baac9b71e0cb6ca721cd47973c57d80385dfd9cce8db9d0fb8c");

  // Non-ASCII must be hashed as raw UTF-8, not escaped.
  const unicode = await build("identity_events", [{ citizen_id: 1, kind: "moderation", detail: "pinned 🤖", created_at: 1 }]);
  assert.equal(unicode[0].hash, "07dd6fe1ecba7f151e7fefdc8df511469ef12f777cfd7554c91febc9feb6f68e");
});

// ---------- appendChainedGated (hardening-2) ----------
//
// A minimal D1Database-shaped stand-in, deliberately NOT test/helpers/local-d1.ts's
// real-SQLite harness: real D1 (and real node:sqlite) always reports a
// well-formed `changes: number` -- the scenario F3 guards against is a
// hypothetical DEPARTURE from that promise, which only a spied/hand-built
// result can produce on demand. `prepare` returns the same object for
// every call regardless of the SQL text (this test never inspects SQL, it
// only controls what .run() reports back), matching how a "spy" test
// double is meant to work: minimal, and honest about testing one thing.
function spiedDb(runResult: unknown): D1Database {
  const stmt = {
    bind: (..._args: unknown[]) => stmt,
    first: async <T>(): Promise<T | null> => null,
    all: async <T>(): Promise<{ results: T[] }> => ({ results: [] }),
    run: async (): Promise<D1Response> => runResult as D1Response,
  };
  return { prepare: (_sql: string) => stmt } as unknown as D1Database;
}

test("appendChainedGated: F3 fail-closed -- a D1 result whose meta lacks `changes` is treated as a refusal, never a written row's hash (hardening-2, docs/REVIEW-CHAINGATE-2026-08-09.md finding 3)", async () => {
  // `changes` absent entirely -- the ambient D1Meta type promises it is
  // always present (`changes: number`, required), but that is the type's
  // promise, not a runtime guarantee this function should stake a
  // citizen's write on.
  const db = spiedDb({ meta: {} });
  const sealed = await appendChainedGated(db, "ballots", { proposal_id: 1, citizen_id: 1, choice: "yes", cast_at: 1 }, { sql: "SELECT 1", args: [] });
  assert.equal(sealed, null, "an absent `changes` must fail closed (refusal), never be read as a nonzero/successful write");
});

test("appendChainedGated: a genuine single-row write (changes: 1) still succeeds -- the fail-closed change does not also refuse the real success case", async () => {
  const db = spiedDb({ meta: { changes: 1 } });
  const sealed = await appendChainedGated(db, "ballots", { proposal_id: 1, citizen_id: 1, choice: "yes", cast_at: 1 }, { sql: "SELECT 1", args: [] });
  assert.notEqual(sealed, null, "changes: 1 is the one value that unambiguously means the row was written -- must still succeed");
});

test("appendChainedGated: a gate refusal (changes: 0) still returns null, unchanged by the fail-closed rewrite", async () => {
  const db = spiedDb({ meta: { changes: 0 } });
  const sealed = await appendChainedGated(db, "ballots", { proposal_id: 1, citizen_id: 1, choice: "yes", cast_at: 1 }, { sql: "SELECT 1", args: [] });
  assert.equal(sealed, null, "changes: 0 (the ordinary gate-refused case) must still refuse exactly as before");
});

// ---------- classifyUniqueViolation exactness (hardening-2 fixes pass) ----------
//
// The converged external review (exchange/REVIEW_hardening2-codex_2026-08-09.md,
// docs/BRIEF-HARDENING-2-REVIEW-FIXES.md Fix 1) caught the classifier's
// comment promising an exact column-set match while its implementation used
// an unbounded substring check: a future UNIQUE whose column list merely
// BEGINS with ballots.proposal_id, ballots.citizen_id would have been
// mis-filed as a duplicate ballot and 409'd instead of taking the safe
// unrecognised retry/503 path. These tests pin the exact-parse contract.
// Like spiedDb above, but scripted per attempt: each entry is either an
// error message for run() to throw, or a D1Response for it to return, and
// the call count is observable -- the classifier's whole point is which
// errors are worth spending retries on.
function scriptedDb(script: Array<string | { meta: { changes?: number } }>): { db: D1Database; calls: () => number } {
  let n = 0;
  const stmt = {
    bind: (..._args: unknown[]) => stmt,
    first: async <T>(): Promise<T | null> => null,
    all: async <T>(): Promise<{ results: T[] }> => ({ results: [] }),
    run: async (): Promise<D1Response> => {
      const step = script[n++];
      if (typeof step === "string") throw new Error(step);
      return step as D1Response;
    },
  };
  return { db: { prepare: (_sql: string) => stmt } as unknown as D1Database, calls: () => n };
}

const BALLOT_ROW: ChainRow = { proposal_id: 1, citizen_id: 1, choice: "yes", cast_at: 1 };
const GATE = { sql: "SELECT 1", args: [] as const };

test("appendChainedGated: exact ballot UNIQUE remains an immediate 409 without a retry", async () => {
  const { db, calls } = scriptedDb(["UNIQUE constraint failed: ballots.proposal_id, ballots.citizen_id"]);
  await assert.rejects(
    () => appendChainedGated(db, "ballots", BALLOT_ROW, GATE),
    (e: unknown) => e instanceof SocietyError && e.status === 409 && /already cast/i.test(e.message),
    "the exact two-column ballots list is the recognised duplicate vote: immediate honest 409",
  );
  assert.equal(calls(), 1, "a recognised duplicate vote must not burn a single retry");
});

test("appendChainedGated: a ballot UNIQUE superset is unrecognised and never becomes an already-voted 409", async () => {
  // A hypothetical future three-column UNIQUE that merely STARTS with the
  // duplicate-vote pair. Substring matching mis-files this as a duplicate
  // ballot; the exact-parse contract must leave it unrecognised (retry then
  // 503, the safe default that guesses nothing).
  const superset = "UNIQUE constraint failed: ballots.proposal_id, ballots.citizen_id, ballots.choice";
  const { db, calls } = scriptedDb([superset, superset, superset, superset]);
  await assert.rejects(
    () => appendChainedGated(db, "ballots", BALLOT_ROW, GATE),
    (e: unknown) => e instanceof SocietyError && e.status === 503 && !/already cast/i.test(e.message),
    "a superset column list is NOT a duplicate vote and must exhaust as unrecognised",
  );
  assert.equal(calls(), 4, "unrecognised UNIQUEs keep the full retry-then-503 default");

  // Reordered columns are equally unrecognised: the match is exact AND ordered.
  const reordered = "UNIQUE constraint failed: ballots.citizen_id, ballots.proposal_id";
  const second = scriptedDb([reordered, reordered, reordered, reordered]);
  await assert.rejects(
    () => appendChainedGated(second.db, "ballots", BALLOT_ROW, GATE),
    (e: unknown) => e instanceof SocietyError && e.status === 503 && !/already cast/i.test(e.message),
    "a reordered column list is not the recognised duplicate-vote shape",
  );
  assert.equal(second.calls(), 4);
});

test("appendChainedGated: trailing driver diagnostics do not change an exact ballot column list", async () => {
  // The real column list, wrapped in the kind of prefix/suffix noise a
  // driver layer can add. The parser must find the list and stop at its
  // end -- trailing diagnostics must not turn an exact match into a miss.
  const { db, calls } = scriptedDb(["D1_ERROR: UNIQUE constraint failed: ballots.proposal_id, ballots.citizen_id: SQLITE_CONSTRAINT"]);
  await assert.rejects(
    () => appendChainedGated(db, "ballots", BALLOT_ROW, GATE),
    (e: unknown) => e instanceof SocietyError && e.status === 409 && /already cast/i.test(e.message),
    "diagnostic wrapping around the exact list must still classify as the duplicate vote",
  );
  assert.equal(calls(), 1, "still zero retries once the exact list is recognised");
});

test("appendChainedGated: gate finding 5a -- a column list whose extra trailing element is UNqualified cannot truncate down to a recognised duplicate-vote pair", async () => {
  // The gate's first adversarial row (docs/REVIEW-HARDENING2-GATE-2026-08-10.md
  // finding 5): Fix 1's exact defect re-opened by one degree. The
  // pre-anchor parser stopped at the first non-qualified token, so
  // '..., oops' parsed down to exactly the duplicate-vote pair and 409'd
  // in one call. Anchored, the list must END cleanly (end of message, or
  // a non-identifier/dot/comma/whitespace continuation like the real
  // ': SQLITE_CONSTRAINT'), so this stays unrecognised: retry then 503,
  // the safe default. Not reachable today -- SQLite fully qualifies every
  // element -- pinned so the parser never quietly regains the behaviour.
  const trailing = "UNIQUE constraint failed: ballots.proposal_id, ballots.citizen_id, oops";
  const { db, calls } = scriptedDb([trailing, trailing, trailing, trailing]);
  await assert.rejects(
    () => appendChainedGated(db, "ballots", BALLOT_ROW, GATE),
    (e: unknown) => e instanceof SocietyError && e.status === 503 && !/already cast/i.test(e.message),
    "an unqualified trailing element makes the whole list unrecognised -- never a truncated-to-pair 409",
  );
  assert.equal(calls(), 4, "unrecognised keeps the full retry-then-503 default");
});

test("appendChainedGated: gate finding 5b -- a marker echoed inside quoted diagnostic data does not shadow the real trailing report", async () => {
  // The gate's second adversarial row: the marker appears twice, first
  // inside quoted data ('near \"...\": syntax error'), then as the real
  // report. The pre-fix parser honoured the FIRST occurrence and 409'd a
  // genuine chain-head race as a duplicate vote; parsing the LAST
  // occurrence classifies by the real report -- chain_head, one retry,
  // then success. Not reachable today (no user data reaches these
  // messages); pinned for the same reason as 5a.
  const shadowed =
    'D1_ERROR: near "UNIQUE constraint failed: ballots.proposal_id, ballots.citizen_id": syntax error; real: UNIQUE constraint failed: ballots.prev_hash';
  const { db, calls } = scriptedDb([shadowed, { meta: { changes: 1 } }]);
  const sealed = await appendChainedGated(db, "ballots", BALLOT_ROW, GATE);
  assert.notEqual(sealed, null, "the real trailing prev_hash report wins: a chain-head race, retried and sealed, never a false already-voted 409");
  assert.equal(calls(), 2, "exactly one retry -- the chain-head path, not the duplicate-vote short-circuit and not exhaustion");
});

test("appendChainedGated: exact prev_hash and hash collisions retain the chain-head retry path", async () => {
  const viaPrev = scriptedDb(["UNIQUE constraint failed: ballots.prev_hash", { meta: { changes: 1 } }]);
  const sealedPrev = await appendChainedGated(viaPrev.db, "ballots", BALLOT_ROW, GATE);
  assert.notEqual(sealedPrev, null, "a prev_hash collision is a chain-head race: retry against the fresh head, then succeed");
  assert.equal(viaPrev.calls(), 2, "exactly one retry after the chain-head collision");

  const viaHash = scriptedDb(["UNIQUE constraint failed: ballots.hash", { meta: { changes: 1 } }]);
  const sealedHash = await appendChainedGated(viaHash.db, "ballots", BALLOT_ROW, GATE);
  assert.notEqual(sealedHash, null, "a hash collision takes the same chain-head retry path");
  assert.equal(viaHash.calls(), 2);
});
