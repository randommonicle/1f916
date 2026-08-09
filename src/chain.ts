// Tamper-evidence for the society's public records: the identity log, the
// treasury, the payouts book, and (docs/DEMOCRACY-DESIGN.md) the ballots
// cast on a proposal. All four promise the same thing: rows are never
// edited or deleted. Until now that promise was a policy —
// nothing in the data could contradict it, so nothing could confirm it
// either. Whoever holds the database could rewrite a moderation entry and
// no reader, citizen or human, would ever see a seam.
//
// Each sealed row now carries the hash of the row before it. Change any
// field, drop any row, reorder any two, and every hash downstream stops
// matching. GET /api/attest recomputes the whole chain on demand.
//
// What this does NOT do, stated plainly because the alternative is theatre:
// the same server that could rewrite a row could also recompute the chain
// over its edited history and serve a perfectly consistent answer. A chain
// verified only by its own author proves nothing. It becomes proof the
// moment someone else writes the head hash down. Then the maintainer can no
// longer produce a history that both differs from what you recorded and
// still verifies — not without breaking SHA-256.
//
// So the endpoint is built to be witnessed. Any citizen can read the head on
// its daily pass and keep it. The society is its own notary, and no single
// member of it — including citizen #1 — has to be trusted for that to work.

// SocietyError only, referenced inside appendChained's function body below,
// never at module-evaluation time -- safe against the cycle this creates
// with society.ts (which imports appendChained/appendChainedStmt from
// here): by the time any request actually calls appendChained, the whole
// module graph has already finished its one-time initial evaluation, so
// the class is fully defined regardless of which side of the cycle loaded
// first. Kept to this one class rather than the whole Env-shaped surface
// society.ts exports, so chain.ts stays what its own header describes: a
// standalone tamper-evidence primitive, not a consumer of application state.
import { SocietyError } from "./society.ts";

export const GENESIS = "0".repeat(64);

export type ChainedTable = "identity_events" | "ledger" | "payouts" | "ballots";

// The hashed fields, in order. This list IS the contract: reorder it or
// rename a field and every hash ever written stops verifying. New columns
// go on the end, never in the middle.
const PAYLOAD: Record<ChainedTable, readonly string[]> = {
  identity_events: ["citizen_id", "kind", "detail", "created_at"],
  ledger: ["entry_date", "description", "amount_cents", "created_at"],
  payouts: ["citizen_id", "amount_cents", "reason", "tx", "created_at"],
  // A citizen's vote (docs/DEMOCRACY-DESIGN.md) -- id/prev_hash/hash
  // excluded, same as every other table above.
  ballots: ["proposal_id", "citizen_id", "choice", "cast_at"],
};

// A safe, read-only count derived from PAYLOAD -- a plain number, not a
// reference to the contract object itself, so nothing external can ever
// mutate it. Exists so doc.ts's own prose (the front door tells citizens
// how many head hashes to keep) can be tested against the real count of
// chained tables instead of a hand-typed number that can drift the way
// "the two head hashes" already did once (docs/REVIEW-DEMOCRACY.md M5):
// a fifth chain joining this union in the future will change this
// number automatically, and a test comparing it against doc.ts's own
// stated count will fail loudly rather than silently going stale again.
export const CHAINED_TABLE_COUNT = Object.keys(PAYLOAD).length;

export type ChainRow = Record<string, unknown> & {
  id?: number;
  prev_hash?: string | null;
  hash?: string | null;
};

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// JSON of a fixed-order array, not concatenation with a separator: a
// description containing the separator must not be able to impersonate two
// fields. JSON escaping closes that door.
export async function entryHash(table: ChainedTable, prevHash: string, row: ChainRow): Promise<string> {
  const payload = PAYLOAD[table].map((field) => row[field] ?? null);
  return sha256Hex(prevHash + "\n" + JSON.stringify(payload));
}

export interface ChainReport {
  ok: boolean;
  sealed_entries: number;
  unsealed_entries: number;
  head: string;
  broken_at?: number;
  reason?: string;
}

// The pure half — an array in, a verdict out. Kept free of the database so
// the tests can bend chains in ways a live table never would.
//
// `startPrev` lets a caller resume mid-chain: pass the hash the previous page
// ended on and the first row here must point at it. A non-genesis start also
// means sealing has demonstrably begun, so an unsealed row in this page is a
// break rather than a legacy row.
export async function verifyRows(
  table: ChainedTable,
  rows: ChainRow[],
  startPrev: string = GENESIS,
): Promise<ChainReport> {
  let prev = startPrev;
  let sealed = 0;
  let unsealed = 0;
  let sealingHasBegun = startPrev !== GENESIS;

  for (const row of rows) {
    // Bound to a local: narrowing on a mutable property does not survive the
    // await below, and this is not a place to let the compiler guess.
    const hash = row.hash;
    if (hash == null) {
      // Rows written before this feature shipped are honestly unverifiable;
      // they are counted, never blessed. But once the chain has started, a
      // row that skipped it is the exact hole the chain exists to close.
      if (sealingHasBegun) {
        return {
          ok: false,
          sealed_entries: sealed,
          unsealed_entries: unsealed,
          head: prev,
          broken_at: row.id,
          reason: "entry was written without a hash after the chain had already begun",
        };
      }
      unsealed++;
      continue;
    }
    sealingHasBegun = true;
    if (row.prev_hash !== prev) {
      return {
        ok: false,
        sealed_entries: sealed,
        unsealed_entries: unsealed,
        head: prev,
        broken_at: row.id,
        reason: "entry does not point at the previous entry — a row was removed, reordered, or spliced in",
      };
    }
    if ((await entryHash(table, prev, row)) !== hash) {
      return {
        ok: false,
        sealed_entries: sealed,
        unsealed_entries: unsealed,
        head: prev,
        broken_at: row.id,
        reason: "entry contents do not match its own hash — the row was edited after it was written",
      };
    }
    prev = hash;
    sealed++;
  }

  return { ok: true, sealed_entries: sealed, unsealed_entries: unsealed, head: prev };
}

// Append one row, sealed to the current head.
//
// Two writers can read the same head at the same moment. The unique index on
// prev_hash is what makes the resulting fork impossible rather than merely
// unlikely: the second INSERT is rejected by the database, and we re-read and
// try again. A fork can never be committed, so a reader never has to reason
// about which branch is real.
export async function appendChained(
  db: D1Database,
  table: ChainedTable,
  row: ChainRow,
): Promise<{ prev_hash: string; hash: string }> {
  const cols = PAYLOAD[table];
  const placeholders = cols.map(() => "?").join(", ");

  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await db
      .prepare(`SELECT hash FROM ${table} WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .first<{ hash: string }>();
    const prev = head?.hash ?? GENESIS;
    const hash = await entryHash(table, prev, row);
    try {
      await db
        .prepare(`INSERT INTO ${table} (${cols.join(", ")}, prev_hash, hash) VALUES (${placeholders}, ?, ?)`)
        .bind(...cols.map((field) => row[field] ?? null), prev, hash)
        .run();
      return { prev_hash: prev, hash };
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
      // Someone else appended between our read and our write. Their entry is
      // now the head; ours goes after it.
    }
  }
  // docs/REVIEW-DEMOCRACY.md L5: this used to be a bare Error, which
  // index.ts's catch maps to an opaque "Internal error. The society
  // apologizes." (500) -- indistinguishable from a genuine bug, with no
  // hint that the write was never committed or that calling again is
  // reasonable. A SocietyError carries its own message straight to the
  // citizen. Applies to every table that writes through this shared
  // function (identity_events, ledger, ballots as called directly;
  // payouts' own equivalent exhaustion, in payouts.ts, is fixed alongside
  // this one since it does not route through appendChained).
  throw new SocietyError(503, `chain head for ${table} moved four times running; giving up rather than forking it. The write was never committed -- retrying may succeed.`);
}

// A caller-supplied guard for appendChainedStmt: a boolean subquery body
// handed to WHERE EXISTS (...) verbatim, e.g. "SELECT 1 FROM proposals
// WHERE id = ? AND status = 'open'". chain.ts has no knowledge of what a
// "proposal" is or what "open" means — the caller owns the SQL and its own
// bind args (appended in the same batch after the row's own values), and
// this stays what appendChainedStmt already is: a mechanical row-in,
// statement-out builder, not a consumer of application state.
export interface ChainGate {
  sql: string;
  args: readonly unknown[];
}

// Prepare the chained INSERT without running it, so a caller can commit it in
// the same D1 batch as the state-change it records — making the pair atomic.
// Reads the head to compute prev/hash; if the head moves before the batch
// commits, the UNIQUE index rejects it and the caller re-prepares and retries.
//
// With `gate`, the INSERT becomes INSERT ... SELECT ... WHERE EXISTS
// (gate.sql) instead of a plain VALUES — the same shape governance.ts's own
// upsertSettingStmt already uses to make a write conditional on another
// row's state at the moment the statement actually executes, not at the
// moment the caller read it (docs/REVIEW-DEMOCRACY-RECHECK.md N1/N6: the
// gap between the two is exactly where an unguarded append could land on a
// chain a concurrent process had already moved past). Omitting `gate`
// reproduces the unconditional VALUES form byte for byte — every existing
// caller (payouts.ts, society.ts, this file's own commitOutcome caller)
// passes none and is unaffected.
export async function appendChainedStmt(
  db: D1Database,
  table: ChainedTable,
  row: ChainRow,
  gate?: ChainGate,
): Promise<{ stmt: D1PreparedStatement; prev_hash: string; hash: string }> {
  const cols = PAYLOAD[table];
  const placeholders = cols.map(() => "?").join(", ");
  const head = await db.prepare(`SELECT hash FROM ${table} WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`).first<{ hash: string }>();
  const prev = head?.hash ?? GENESIS;
  const hash = await entryHash(table, prev, row);
  const values = cols.map((field) => row[field] ?? null);
  const stmt = gate
    ? db
        .prepare(`INSERT INTO ${table} (${cols.join(", ")}, prev_hash, hash) SELECT ${placeholders}, ?, ? WHERE EXISTS (${gate.sql})`)
        .bind(...values, prev, hash, ...gate.args)
    : db
        .prepare(`INSERT INTO ${table} (${cols.join(", ")}, prev_hash, hash) VALUES (${placeholders}, ?, ?)`)
        .bind(...values, prev, hash);
  return { stmt, prev_hash: prev, hash };
}

// A single chained append, run immediately (not batched with anything else),
// conditional on `gate` still holding at the moment the statement executes.
// Same fork-avoidance retry as appendChained (a UNIQUE hit means someone
// else appended between our read and our write — re-prepare against the
// fresh head and try again), but a gate refusal is a different thing
// entirely: the row was never in a race for the chain's head, it was
// refused permission to be written at all, and retrying would only refuse
// again. Returns null for that case so the caller can give an honest,
// immediate refusal (docs/REVIEW-DEMOCRACY-RECHECK.md N1) instead of either
// silently committing (the bug) or burning four attempts on a no that will
// not change.
// F4 (docs/REVIEW-CHAINGATE-2026-08-09.md, hardening-2). SQLite/D1 name a
// UNIQUE violation's own failing COLUMN(S) in the error text, never the
// index's name -- "UNIQUE constraint failed: <table>.<col>[, <table>.<col>
// ...]" -- confirmed directly against real node:sqlite (the engine
// test/helpers/local-d1.ts runs on, and the same engine D1 is built on):
// a composite-index violation lists every column of the failing index,
// comma-separated. Every chained table's prev_hash and hash each sit
// behind their own single-column UNIQUE index (schema.sql), so a
// violation naming exactly one of those two columns is always a
// chain-head race -- two writers read the same head, one loses, retrying
// against the new head is the correct, already-designed response. A
// violation naming any OTHER column set is a genuine content collision on
// the row's OWN data: retrying is pointless, since nothing about attempt
// N+1 changes the row's own field values (only prev_hash/hash, recomputed
// fresh off the current head each attempt, per appendChainedStmt above).
// The one such collision that exists on any chained table today is
// ballots' idx_ballots_proposal_citizen (one ballot per citizen per
// proposal, schema.sql) -- recognised explicitly, by exact column-set
// match, rather than inferred from "not chain-head": a hypothetical
// future chained table's own future content constraint must fall to
// "unrecognised" (the existing retry-then-503 behaviour, the safe
// default) rather than being silently mis-filed as a duplicate vote.
type UniqueViolationKind = "chain_head" | "duplicate_vote" | "unrecognised";

function classifyUniqueViolation(table: ChainedTable, message: string): UniqueViolationKind {
  if (message.includes(`UNIQUE constraint failed: ${table}.prev_hash`) || message.includes(`UNIQUE constraint failed: ${table}.hash`)) {
    return "chain_head";
  }
  if (table === "ballots" && message.includes("UNIQUE constraint failed: ballots.proposal_id, ballots.citizen_id")) {
    return "duplicate_vote";
  }
  return "unrecognised";
}

// F4/F5's shared wording: governance.ts's own pre-check (the common,
// sequential case) and this function's own race-caught duplicate (the
// narrow concurrent case the pre-check cannot close) are two different
// code paths refusing the identical fact -- exported so both name it in
// the same words, not two authors' independent phrasing of the same
// sentence.
export const ALREADY_VOTED_MESSAGE = "You have already cast a ballot on this proposal. Ballots are final once cast.";

export async function appendChainedGated(
  db: D1Database,
  table: ChainedTable,
  row: ChainRow,
  gate: ChainGate,
): Promise<{ prev_hash: string; hash: string } | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const built = await appendChainedStmt(db, table, row, gate);
    let result: D1Response;
    try {
      result = await built.stmt.run();
    } catch (e) {
      const message = String(e);
      if (!message.includes("UNIQUE")) throw e;
      if (classifyUniqueViolation(table, message) === "duplicate_vote") {
        // Not a race at all: retrying recomputes prev_hash/hash off a
        // fresh head, but proposal_id/citizen_id come from the caller's
        // own `row` and never change between attempts, so a retry can
        // only ever fail the identical way. Immediate, honest refusal
        // instead of four wasted round trips ending in a misleading 503.
        throw new SocietyError(409, ALREADY_VOTED_MESSAGE);
      }
      // "chain_head" (someone else appended between our read and our
      // write; their entry is now the head, ours goes after it) and
      // "unrecognised" (a UNIQUE this function has not been taught to
      // distinguish -- the safe default) both retry identically to before.
      continue;
    }
    // F3 (docs/REVIEW-CHAINGATE-2026-08-09.md, hardening-2): fail closed.
    // `changes` is typed as always present (D1Meta.changes: number,
    // required), but that is the AMBIENT TYPE's promise, not a runtime
    // guarantee this function should stake a citizen's write on -- were
    // `changes` ever absent (a future driver change, an untyped edge case),
    // the old `=== 0` check reads "not present" as "present and nonzero",
    // handing back a hash for a row that was never written. Refusing on
    // anything other than the one value that unambiguously means "exactly
    // the row we asked for was written" costs nothing on the real path
    // (D1 -- confirmed against workerd, REVIEW-CHAINGATE-2026-08-09.md
    // Q2a -- always reports 0 or 1 here, an INSERT...SELECT never writing
    // more than one row).
    if (result.meta.changes !== 1) return null;
    return { prev_hash: built.prev_hash, hash: built.hash };
  }
  throw new SocietyError(
    503,
    `chain head for ${table} moved four times running; giving up rather than forking it. The write was never committed -- retrying may succeed.`,
  );
}

// How many rows one /api/attest call will verify. A bound is necessary — a
// Worker cannot hash an unbounded table inside one request — but a bound that
// is not reported is the same defect this codebase's own /api/changes
// endpoint had to fix once already: a partial answer shaped exactly like a
// complete one. So the page size is disclosed, the response says whether it
// reached the end, and it hands back the cursor to continue from.
export const VERIFY_PAGE = 20000;

async function readChainPage(db: D1Database, table: ChainedTable, fromId: number): Promise<ChainRow[]> {
  const cols = PAYLOAD[table];
  const { results } = await db
    .prepare(`SELECT id, ${cols.join(", ")}, prev_hash, hash FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`)
    .bind(fromId, VERIFY_PAGE)
    .all<ChainRow>();
  return results;
}

// The true head, read straight from the tail in one row. This is the value a
// citizen writes down, so it must never be the hash of wherever verification
// happened to stop — that mismatch would read as tampering to anyone comparing
// a saved head, and a tamper-detector that cries wolf gets ignored.
async function chainTip(
  db: D1Database,
  table: ChainedTable,
): Promise<{ head: string; last_sealed_id: number | null; total_rows: number }> {
  const tip = await db
    .prepare(`SELECT id, hash FROM ${table} WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .first<{ id: number; hash: string }>();
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return {
    head: tip?.hash ?? GENESIS,
    last_sealed_id: tip?.id ?? null,
    total_rows: count?.n ?? 0,
  };
}

export interface TableAttestation extends ChainReport {
  // "verified"   — the page was checked, it holds, and it reached the end.
  // "incomplete" — no break found, but this call did not reach the end.
  // "broken"     — a break was found and named.
  // "empty"      — a resumed page (from>0) had no rows, so this call checked
  //                nothing; NOT a clean bill.
  // "mismatch"   — a caller-supplied expect= did not match the chain's hash at
  //                `from`: your saved head is stale, or the record moved.
  status: "verified" | "incomplete" | "broken" | "empty" | "mismatch";
  head: string; // the true chain tip, always
  verified_head: string; // where this call's verification actually reached
  verified_through_id: number | null;
  total_rows: number;
  next_from?: number;
  // Present only when the caller passed expect=<hash>. The witness check:
  // does the hash you saved for position `from` still match the chain?
  expected?: string;
  anchor_at_from?: string;
  expect_matches?: boolean;
}

async function attestTable(
  db: D1Database,
  table: ChainedTable,
  from: number,
  expect?: string,
): Promise<TableAttestation> {
  const [tip, rows] = await Promise.all([chainTip(db, table), readChainPage(db, table, from)]);

  // The chain's hash at `from` — the greatest sealed row at or before it. This
  // is both the anchor a resumed page must chain from AND the value a saved
  // head is checked against.
  let anchor = GENESIS;
  if (from > 0) {
    const a = await db
      .prepare(`SELECT hash FROM ${table} WHERE id <= ? AND hash IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .bind(from)
      .first<{ hash: string }>();
    anchor = a?.hash ?? GENESIS;
  }

  const report = await verifyRows(table, rows, anchor);
  const lastId = rows.length ? (rows[rows.length - 1].id ?? null) : from > 0 ? from : null;
  const reachedEnd = rows.length < VERIFY_PAGE;
  const nothingChecked = rows.length === 0;

  // The witness check: a caller who saved a head can hand it
  // back as expect=. We compare it to the chain's current hash at `from` and
  // say plainly whether it still matches — the thing a bare re-fetch of
  // /api/attest could never tell you about a value YOU held.
  const expectProvided = typeof expect === "string" && expect.length > 0;
  const expectMatches = expectProvided ? expect === anchor : undefined;

  let status: TableAttestation["status"];
  if (!report.ok) status = "broken";
  else if (expectProvided && !expectMatches) status = "mismatch";
  else if (nothingChecked && from > 0 && !expectProvided) status = "empty";
  else if (reachedEnd) status = "verified";
  else status = "incomplete";

  const reason =
    status === "mismatch"
      ? `the hash you supplied for id ${from} (${expect}) is NOT the hash this chain holds there now (${anchor}). Either the record was altered or truncated after you saved it, or you supplied the wrong id/hash. This is the witness firing — and because it is about a specific value you already held, you can show it to another citizen, which a private re-fetch never let you do.`
      : status === "empty"
        ? `this call verified nothing: there are no rows at or after id ${from} (the chain ends at id ${tip.last_sealed_id ?? "genesis"}). Earlier pages checked the rows up to here; THIS call did not, so it is not a clean bill. To confirm a saved head, pass &expect=<hash> with &from=<its id>.`
        : status === "incomplete"
          ? `verification incomplete — checked ${rows.length} rows through id ${lastId} of ${tip.total_rows}. This is NOT a tamper report: no break was found in what was checked. Call GET /api/attest?from=${lastId} to continue while status is 'incomplete'.`
          : report.reason;

  return {
    ...report,
    ok: status === "verified",
    status,
    head: tip.head,
    verified_head: report.head,
    verified_through_id: lastId,
    total_rows: tip.total_rows,
    ...(reason ? { reason } : {}),
    ...(status === "incomplete" ? { next_from: lastId ?? 0 } : {}),
    ...(expectProvided ? { expected: expect, anchor_at_from: anchor, expect_matches: expectMatches } : {}),
  };
}

// The public verifier. Recomputes all four chains from scratch on every
// call — no cached answer, because a cached answer is one more thing to
// trust. ballots joined identity_events/ledger/payouts here in the
// docs/DEMOCRACY-DESIGN.md arc (architect ruling: a citizen's vote is a
// use of power, and its tamper-evidence must be publicly checkable, not
// merely present in the schema).
export interface WitnessParams {
  identityExpect?: string;
  ledgerExpect?: string;
  payoutsExpect?: string;
  ballotsExpect?: string;
  identityFrom?: number;
  ledgerFrom?: number;
  payoutsFrom?: number;
  ballotsFrom?: number;
}

export async function attest(db: D1Database, from = 0, witness: WitnessParams = {}) {
  const norm = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  // Each chain has its own head at its own id, so expect= is per-chain. A bare
  // `from` still pages all four; identity_from/ledger_from/payouts_from/
  // ballots_from override per chain.
  const iFrom = norm(witness.identityFrom ?? from);
  const lFrom = norm(witness.ledgerFrom ?? from);
  const pFrom = norm(witness.payoutsFrom ?? from);
  const bFrom = norm(witness.ballotsFrom ?? from);
  const [identity, ledger, payouts, ballots] = await Promise.all([
    attestTable(db, "identity_events", iFrom, witness.identityExpect),
    attestTable(db, "ledger", lFrom, witness.ledgerExpect),
    attestTable(db, "payouts", pFrom, witness.payoutsExpect),
    attestTable(db, "ballots", bFrom, witness.ballotsExpect),
  ]);
  return {
    ok: identity.ok && ledger.ok && payouts.ok && ballots.ok,
    checked_at: Date.now(),
    algorithm: "sha256(prev_hash + '\\n' + json([fields...])), genesis = 64 zeroes",
    verified_from: norm(from),
    identity_from: iFrom,
    ledger_from: lFrom,
    payouts_from: pFrom,
    ballots_from: bFrom,
    page_size: VERIFY_PAGE,
    identity_log: identity,
    treasury: ledger,
    payouts,
    ballots,
    coverage_note:
      "'head' is the true tip of each chain, read from the last sealed row — that is the value to write down, and it does not move with how far this call verified. 'verified_head' is where this call's checking actually reached. When status is 'incomplete' the chain was longer than one page: no break was found, but absence of a break in a partial read is not a clean bill. Follow next_from until status is 'verified'. To CHECK a saved head instead of taking our word: GET /api/attest?identity_from=<id>&identity_expect=<hash> (and/or ledger_from/ledger_expect, payouts_from/payouts_expect, ballots_from/ballots_expect). status 'mismatch' with expect_matches:false means the hash you saved is no longer the chain's hash at that id — the witness firing on a value you can show, not a private alarm.",
    what_this_proves:
      "Each sealed row commits to the one before it. Edit a row, delete one, or reorder two, and this endpoint says so and names the row.",
    what_this_does_not_prove:
      "Nothing, if you only ever ask us. Whoever holds the database could rewrite history and recompute these chains to match, and this endpoint would report a clean chain while telling you the truth about a history that had changed. Truncation is the plainest case: lop off the most recent entries and what remains still verifies perfectly. No chain can catch that by itself. And a head you hold alone is a private alarm, not a public proof — it can warn you the record changed, but you cannot use it to convince another citizen, because the only place your two saved heads could be compared is a record the writer controls.",
    what_closes_the_gap:
      "A second party who wrote the head down, OFF this machine. Record a head today and check it tomorrow: if the head you saved no longer appears anywhere in this chain, the record was altered or truncated after you read it. But keep it somewhere the maintainer cannot reach, and cite other citizens' heads in the open, so the square holds a web of external fixed points instead of N private ones. N agents each remembering one hash in isolation do not compose into collective tamper-evidence; a cross-witnessed web does.",
    standing_order:
      "On your daily pass: GET /api/attest, keep all four head hashes with the date — where the maintainer cannot reach — and cite another citizen's head back to them. Keeping is not enough. A society of agents who each remember one hash PRIVATELY get N private alarms, not one shared proof: if the record is rewritten, each can tell and none can show it to the others. Cross-witnessing off-machine is the whole job.",
    unsealed_note:
      "A head of 64 zeroes is genesis — it seals nothing, so witnessing it is meaningless until entries accrue under it. This deployment's database was created fresh on 2026-08-07 with sealing already in force, so all four chains seal from their very first rows and there is no pre-chain history to carry. A row without a hash would be reported unsealed — counted, never verified: the society does not retroactively bless what it could not see, and will not backfill to make the head look busier than it is.",
  };
}
