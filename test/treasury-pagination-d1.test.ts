// GET /treasury paging (DEFERRED-TREASURY-PAGINATION, docs/BRIEF-TREASURY-PAGINATION.md,
// amendments A1-A12), against real node:sqlite through the D1-shaped helper and the
// committed schema.sql. No mocks of the code under test. Every guard here was red-proofed by
// a mutant before it was trusted; docs/CHECKPOINT-TREASURY-PAGINATION.md carries the ledger
// (mutant, result, restored).
//
// treasury() reads the on-chain balance from public Base RPCs. This file replaces
// globalThis.fetch for its whole process (node:test runs each file in its own process) with
// an answer that is never ok, so onchain_cents is null, deterministically and without
// leaving the machine.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { treasury, parseLedgerCursor, LEDGER_PAGE, SocietyError, type Env, type LedgerCursor } from "../src/society.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("rpc stubbed in test", { status: 500 })) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 1);

function makeEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "invite_only",
  } as unknown as Env;
}

interface Entry {
  id: number;
  entry_date: string;
  description: string;
  amount_cents: number;
  created_at: number;
  prev_hash: string | null;
  hash: string | null;
}
interface Page {
  note: string;
  booked_cents: number;
  onchain_cents: number | null;
  balance_cents: number;
  wallet: { note: string };
  total_entries: number;
  returned: number;
  page_size: number;
  has_more: boolean;
  next_before_entry_date?: string | null;
  next_before_id?: number | null;
  pagination_note: string;
  entries: Entry[];
}

// n rows, ids 1..n, perDay rows to each calendar day (so entry_date repeats), every date
// before today (UTC) so a row the real writer inserts, dated today, sorts ahead of all of
// them. amount_cents = id, so page sums are unequal. prev_hash and hash are NULL: the two
// UNIQUE indexes on them permit repeated NULLs, and this read does not verify the chain.
function seedLedger(d1: LocalD1, n: number, perDay = 3): void {
  d1.raw.exec("BEGIN");
  const stmt = d1.raw.prepare(
    "INSERT INTO ledger (entry_date, description, amount_cents, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, NULL, NULL)",
  );
  for (let i = 1; i <= n; i++) {
    const date = new Date(START + Math.floor((i - 1) / perDay) * DAY).toISOString().slice(0, 10);
    stmt.run(date, `entry ${i}`, i, START + i);
  }
  d1.raw.exec("COMMIT");
}

function allRows(d1: LocalD1): Entry[] {
  return d1.raw
    .prepare("SELECT id, entry_date, description, amount_cents, created_at, prev_hash, hash FROM ledger")
    .all() as unknown as Entry[];
}

// The order the brief fixes, computed in JS from the table's rows, independently of the
// query under test: entry_date DESC, then id DESC.
function expectedIds(d1: LocalD1): number[] {
  return allRows(d1)
    .sort((a, b) => (a.entry_date === b.entry_date ? b.id - a.id : a.entry_date < b.entry_date ? 1 : -1))
    .map((r) => r.id);
}

function cursorOf(page: Page): LedgerCursor | null {
  return parseLedgerCursor(page.next_before_entry_date as string, String(page.next_before_id));
}

// Walk from the first page, exactly as the served note tells a reader to, until has_more is false.
async function walk(env: Env): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: LedgerCursor | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page = (await treasury(env, cursor)) as unknown as Page;
    pages.push(page);
    if (!page.has_more) return pages;
    cursor = cursorOf(page);
  }
  throw new Error("the walk did not terminate: has_more stayed true for 50 pages");
}

// ---------- T1 + A12 + A9 ----------

test("T1/A12/A9: with 0, 1, 200, 201 and 401 rows the pages concatenate to exactly the ledger, newest first, each row once; every page is capped; the last page carries no cursor keys", async () => {
  for (const n of [0, 1, 200, 201, 401]) {
    const d1 = createLocalD1();
    try {
      seedLedger(d1, n);
      const pages = await walk(makeEnv(d1));
      const served = pages.flatMap((p) => p.entries.map((e) => e.id));
      assert.deepEqual(served, expectedIds(d1), `n=${n}: pages concatenate to the whole ledger, newest first, each row exactly once`);
      assert.equal(new Set(served).size, served.length, `n=${n}: no id appears twice`);
      pages.forEach((p, i) => {
        assert.equal(p.total_entries, n, `n=${n} page ${i}: total_entries is the count of the whole ledger, not of the page`);
        assert.equal(p.page_size, LEDGER_PAGE);
        // A12: the page cap, whatever the cursor is taken from.
        assert.equal(p.returned, p.entries.length, `n=${n} page ${i}: returned counts the entries served`);
        assert.ok(p.entries.length <= LEDGER_PAGE, `n=${n} page ${i}: at most ${LEDGER_PAGE} entries (got ${p.entries.length})`);
        if (i < pages.length - 1) {
          assert.equal(p.entries.length, LEDGER_PAGE, `n=${n} page ${i}: every page before the last carries exactly ${LEDGER_PAGE}`);
          assert.equal(p.has_more, true);
          assert.equal(p.next_before_id, p.entries[LEDGER_PAGE - 1].id, `n=${n} page ${i}: the cursor is the LAST row served, never the look-ahead row`);
          assert.equal(p.next_before_entry_date, p.entries[LEDGER_PAGE - 1].entry_date);
        }
      });
      const last = pages[pages.length - 1];
      assert.equal(last.has_more, false, `n=${n}: the last page says has_more false`);
      // A9: omitted, never null.
      assert.equal("next_before_entry_date" in last, false, `n=${n}: no next_before_entry_date key on the last page`);
      assert.equal("next_before_id" in last, false, `n=${n}: no next_before_id key on the last page`);
      assert.equal("next_before_id" in JSON.parse(JSON.stringify(last)), false, "and none after JSON, the form a reader sees");
      // The stub held: this read did not leave the machine.
      assert.equal(last.onchain_cents, null);
    } finally {
      d1.close();
    }
  }
});

// ---------- T2 ----------

test("T2: at exactly 200 rows there is one page and has_more is false; at 400 there are exactly two, never an empty third", async () => {
  const d1 = createLocalD1();
  try {
    seedLedger(d1, 200);
    const pages = await walk(makeEnv(d1));
    assert.equal(pages.length, 1, "200 rows fit one page");
    assert.equal(pages[0].has_more, false, "the look-ahead rule: 200 rows is not 'more'");
    assert.equal(pages[0].returned, 200);
  } finally {
    d1.close();
  }
  const d2 = createLocalD1();
  try {
    seedLedger(d2, 400);
    const pages = await walk(makeEnv(d2));
    assert.deepEqual(pages.map((p) => p.returned), [200, 200], "an exact multiple of the page costs no empty page");
    assert.equal(pages[0].has_more, true);
    assert.equal(pages[1].has_more, false);
  } finally {
    d2.close();
  }
});

// ---------- A2 (replaces T3) ----------

test("A2: two rows with the same entry_date straddle the page boundary; the tuple cursor serves each once and skips nothing", async () => {
  const d1 = createLocalD1();
  try {
    seedLedger(d1, 400, 3);
    const pages = await walk(makeEnv(d1));
    assert.equal(pages.length, 2);
    // The fixture must straddle, or this test proves nothing: rows 200 and 201 of the walk
    // share an entry_date.
    const lastOfFirst = pages[0].entries[LEDGER_PAGE - 1];
    const firstOfSecond = pages[1].entries[0];
    assert.equal(lastOfFirst.entry_date, firstOfSecond.entry_date, "precondition: the boundary falls inside one entry_date");
    assert.notEqual(lastOfFirst.id, firstOfSecond.id);
    const served = pages.flatMap((p) => p.entries.map((e) => e.id));
    assert.deepEqual(served, expectedIds(d1), "every row once: none skipped, none repeated, across a boundary inside one date");
    assert.equal(served.length, 400);
  } finally {
    d1.close();
  }
});

// ---------- T4 + A10: the cursor's shape ----------

function rejects(rawDate: string | null, rawId: string | null): SocietyError {
  try {
    parseLedgerCursor(rawDate, rawId);
  } catch (e) {
    assert.ok(e instanceof SocietyError, `(${rawDate}, ${rawId}) must throw a SocietyError, got ${String(e)}`);
    return e;
  }
  assert.fail(`(${rawDate}, ${rawId}) was accepted; it must be a 400`);
}

test("T4/A10: a cursor is both parameters or neither, a YYYY-MM-DD date and a positive safe integer id; anything else is a 400 naming the shape", () => {
  assert.equal(parseLedgerCursor(null, null), null, "no cursor is the first page");
  assert.deepEqual(parseLedgerCursor("2026-09-19", "1"), { beforeEntryDate: "2026-09-19", beforeId: 1 });
  assert.deepEqual(parseLedgerCursor("2026-09-19", "9007199254740991"), { beforeEntryDate: "2026-09-19", beforeId: 9007199254740991 }, "the largest safe integer is a valid id");

  // one parameter only, either way round (present-but-empty counts as present)
  for (const [d, i] of [["2026-09-19", null], [null, "5"], ["", null], [null, ""]] as const) {
    const e = rejects(d, i);
    assert.equal(e.status, 400);
    assert.match(e.message, /send both or neither/, `(${d}, ${i}): names the pairing rule`);
  }
  // the date shape
  for (const d of ["2026-9-19", "26-09-19", "2026-09-19 ", " 2026-09-19", "2026/09/19", "20260919", "2026-09-19T00:00:00Z", "2026-09-190", "abcd-ef-gh", ""]) {
    const e = rejects(d, "1");
    assert.equal(e.status, 400);
    assert.match(e.message, /YYYY-MM-DD/, `date ${JSON.stringify(d)}: names the date shape`);
  }
  // the id shape: A10's four, plus the other ways a number can be spelled
  for (const i of ["0", "-1", "1.5", "9007199254740992", "abc", "", "1e3", "+5", " 5", "5 ", "0x10", "99999999999999999", "007x"]) {
    const e = rejects("2026-09-19", i);
    assert.equal(e.status, 400);
    assert.match(e.message, /positive whole number/, `id ${JSON.stringify(i)}: names the id shape`);
  }
});

// ---------- T5 + A4 ----------

test("T5/A4: booked_cents and balance_cents on every page are the sum of the whole ledger, which the page sums differ from", async () => {
  const d1 = createLocalD1();
  try {
    seedLedger(d1, 250);
    const whole = (250 * 251) / 2;
    const pages = await walk(makeEnv(d1));
    assert.equal(pages.length, 2);
    const pageSums = pages.map((p) => p.entries.reduce((a, e) => a + e.amount_cents, 0));
    // The fixture must make the two page sums unequal and both different from the whole, or a
    // page-summing bug would pass.
    assert.notEqual(pageSums[0], pageSums[1], "precondition: unequal page sums");
    assert.ok(pageSums.every((s) => s !== whole), "precondition: neither page sums to the whole ledger");
    for (const [i, p] of pages.entries()) {
      assert.equal(p.booked_cents, whole, `page ${i}: booked_cents is the whole-ledger sum`);
      assert.equal(p.balance_cents, whole, `page ${i}: balance_cents (the retained alias) too`);
    }
    assert.equal(pageSums[0] + pageSums[1], whole, "and the pages' own entries do add up to it when read together");
  } finally {
    d1.close();
  }
});

// ---------- T6 ----------

test("T6: with no cursor, a 17-row ledger serves entries byte-identical to the read this route used to make, and every key it served before is still served", async () => {
  const d1 = createLocalD1();
  try {
    seedLedger(d1, 17, 2);
    const page = (await treasury(makeEnv(d1))) as unknown as Page;
    // The route's original query, verbatim from before the paging change.
    const legacy = d1.raw
      .prepare(
        "SELECT id, entry_date, description, amount_cents, created_at, prev_hash, hash FROM ledger ORDER BY entry_date DESC, id DESC LIMIT 200",
      )
      .all();
    assert.equal(page.entries.length, 17);
    assert.equal(JSON.stringify(page.entries), JSON.stringify(legacy), "byte-identical entries, same rows, same order, same keys in the same order");
    for (const key of [
      "note", "booked_cents", "onchain_cents", "onchain_checked_at", "unbooked_cents", "balance_cents",
      "buckets_note", "wallet", "how_to_verify", "census", "entries",
    ]) {
      assert.ok(key in page, `the pre-paging key ${key} is still served`);
    }
    assert.equal(page.has_more, false);
    assert.equal(page.total_entries, 17);
    assert.equal(page.returned, 17);
  } finally {
    d1.close();
  }
});

// ---------- A7 ----------

test("A7: a cursor older than every row answers an empty page, with the whole-ledger totals intact", async () => {
  const d1 = createLocalD1();
  try {
    seedLedger(d1, 250);
    const page = (await treasury(makeEnv(d1), parseLedgerCursor("2000-01-01", "1"))) as unknown as Page;
    assert.equal(page.returned, 0);
    assert.deepEqual(page.entries, []);
    assert.equal(page.has_more, false);
    assert.equal("next_before_id" in page, false);
    assert.equal(page.total_entries, 250, "total_entries is the whole ledger, not the empty page");
    assert.equal(page.booked_cents, (250 * 251) / 2, "booked_cents is the whole ledger, not the empty page");
  } finally {
    d1.close();
  }
});
