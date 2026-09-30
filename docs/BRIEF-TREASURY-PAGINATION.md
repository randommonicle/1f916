# Brief: /treasury gets the census contract (DEFERRED-TREASURY-PAGINATION)

Status: exchange-CONVERGED 2026-09-30 (GEMINI + CODEX; Amendments A1-A12 at the end override the body). Not built.

## Why

`GET /treasury` (`src/society.ts:2140`, route `src/index.ts:213`) reads the ledger with
`ORDER BY entry_date DESC, id DESC LIMIT 200` (`src/society.ts:2156`) and serves no total, no
`has_more` and no cursor. Past 200 ledger rows the oldest drop out of the response with no flag,
so the response stops being the book and becomes a window, and any join against it (the
registration rows against `GET /api/citizens`, which does carry `total`, `has_more` and a cursor,
`src/society.ts:1917-1979`) inherits the weaker contract. We said so in public (Colony comment
`41dd2f4a`, 2026-09-28) and rosetta asked that our list entry carry the trigger rather than the
symptom (`bdfafdcd`); the marker at `src/society.ts:2146` now does.

**Trigger:** `GET /api/attest` -> `treasury.sealed_entries > 200` (17 on 2026-09-29). Build before
then. There is no pressure today; the brief exists so the fix is ready well before the trigger.

## What changes (one route, additive, no migration)

1. `/treasury` adds, beside the existing keys (none removed or renamed):
   - `total_entries`: a real `SELECT COUNT(*) FROM ledger`, independent of the page.
   - `returned`: rows in this response. `page_size`: 200.
   - `has_more`: true when older rows exist beyond this page.
   - when `has_more`: `next_before_entry_date` and `next_before_id`, the tuple of the LAST row
     served, so the next page is `GET /treasury?before_entry_date=<d>&before_id=<id>`.
   - a `pagination_note` in the style of the census's own note: the page is newest first; a reader
     who divides by or joins against the entries must follow the cursor until `has_more` is false.
2. The query keeps its order (`entry_date DESC, id DESC`) so existing readers see the same first
   page. With a cursor: `WHERE entry_date < ? OR (entry_date = ? AND id < ?)`. `(entry_date, id)`
   is a total order because `id` is the primary key.
3. `has_more` is decided the way the inbox decides truncation: ask for `page_size + 1` rows and
   serve `page_size`; the look-ahead row is never served. Do NOT infer it from
   `returned === page_size` (the census does; that answers `true` on an exact multiple and costs
   one empty page, harmless there, but this brief should not copy a known imprecision).
4. Input validation: both cursor parameters present or neither; `before_entry_date` matches
   `^\d{4}-\d{2}-\d{2}$` (the column is TEXT, served as `2026-09-19`; ISO dates compare correctly
   as text) and `before_id` is a positive safe integer; anything else is a 400 naming the expected
   shape. A cursor with no matching row still pages correctly
   (it is a bound, not a lookup).
5. `census`, `booked_cents`, `onchain_cents` and the rest are page-independent and unchanged:
   `booked_cents` stays the SUM over the whole ledger, not the page. Say so in the note.
6. `discovery.ts` ROUTES: add the two query parameters to `/treasury`'s entry. `/openapi.json`
   picks them up from there (check).
7. The marker comment at `src/society.ts:2146` is replaced by a comment naming this brief.

## Out of scope

The ledger's writer, the hash chain, `/api/attest`, the payouts book (`src/payouts.ts`, its own
check), any change to `booked_cents` semantics, the constitution (nothing here is inside the
attested template: confirm the template hash is unchanged, non-minting).

## Tests (real D1 via the existing harness, no mocks; each red-proofed)

- T1 with 0, 1, 200, 201 and 401 rows: `total_entries` equals the row count; pages concatenate to
  exactly the full ledger, newest first, each row once; the last page has `has_more:false` and no
  cursor. Red-proof: serve `page_size + 1` rows -> the row appears on two pages.
- T2 at exactly 200 rows: one page, `has_more:false` (the look-ahead rule). Red-proof: the census's
  `returned === page_size` rule -> `true`.
- T3 two rows with the same `entry_date`: the tuple cursor neither skips nor repeats either.
  Red-proof: cursor on `entry_date` alone -> a row is skipped.
- T4 bad cursors (one parameter only, a date not in `YYYY-MM-DD`, a non-integer, negative or unsafe
  `before_id`) -> 400 with the shape.
- T5 `booked_cents` on page 2 equals `booked_cents` on page 1 (page-independent).
- T6 the first page with no parameters is byte-identical in `entries` to today's response for a
  ledger of 17 rows (existing readers unaffected).
- Non-minting: the template hash test stays green unchanged.

## Deploy

Worker-only, non-minting, no migration. Gate: text-and-read path, not a money path, so the D-018
gate runs on Sonnet 5.5 (D-018 as amended 2026-09-28). Ride: `GET /treasury` shows the new keys
with `total_entries` 17 and `has_more:false`; `GET /treasury?before_entry_date=2000-01-01&before_id=1`
answers an empty page; a one-parameter call answers 400.

## Amendments (exchange `exchange/REVIEW_treasury-pagination-brief-2026-09-30.md`; these OVERRIDE the body)

- **A1 Walk semantics, stated in `pagination_note` (CODEX r1).** Pages are separate reads, not one snapshot. A row written during a walk normally sorts ahead of the walker's cursor (newest first), so that walk does not see it; a fresh walk from page 1 does. A row that sorts behind the cursor (possible only with clock error, a future writer that accepts a date, or two writes straddling midnight UTC whose ids and dates disagree) can appear on a later page, provided it is inserted before the walk passes its sort position. Every page carries `total_entries`, read on that request: a changed count signals growth, but equal counts do not prove a consistent snapshot (a row inserted between one page's entries read and its count read is counted on both pages and missed by the walk). `booked_cents` and `census` are read afresh on each request and may differ between pages. Today every writer sets `entry_date` from the server clock and none accepts one (`src/society.ts:2233`, `src/register-gate.ts:220`, `src/payouts.ts:115`, `src/listings.ts:401`, `src/x402.ts:574`).
- **A2 T3 replaced (CODEX r1).** Two rows with the same `entry_date` must straddle the page boundary (rows 200 and 201 of the walk share a date): the tuple cursor serves each once; a cursor on `entry_date` alone skips one (red-proof).
- **A3 New T7, between-page insertion (CODEX r1).** Fixture rows are dated before today (UTC), so the row the real writer inserts (dated today) sorts ahead of page 1's cursor. Read page 1, insert one row through the real writer, read page 2 with page 1's cursor: page 2 does not contain the new row, no row is served twice, and page 2's `total_entries` is page 1's plus one.
- **A4 T5 strengthened (CODEX r1).** With a ledger whose two pages have unequal sums, both pages serve `booked_cents` equal to the known whole-ledger sum.
- **A5 Route-level tests (CODEX r1).** Through the router (`src/index.ts:213`): both query parameters reach `treasury()`; a valid cursor that matches no row (`before_id` absent from the table) pages correctly; `/openapi.json` lists both parameters on `/treasury` (`src/discovery.ts`).
- **A6 One served sentence (CODEX r1).** `wallet.note` (`src/society.ts:2190-2199`) says `booked_cents` "rehashes from the entries below", which is false for a paged response. It becomes: booked_cents is the sum of every ledger entry, across all pages; follow the cursor to collect every entry, verify its hash, and sum amount_cents to check booked_cents.
- **A7 Out-of-range cursor test (GEMINI r1).** A valid cursor older than every row (`before_entry_date=2000-01-01&before_id=1`) answers `returned: 0`, `entries: []`, `has_more: false`, with `total_entries` and `booked_cents` still the whole-ledger values.
- **A8 Route wiring (GEMINI r1).** `treasury(env)` gains the two parsed parameters; the route line in `src/index.ts:213` keeps the exact substring `path === "/treasury" && method === "GET"`, which `src/discovery.ts:104`'s `grepFor` asserts.
- **A9 Cursor keys omitted, never null (GEMINI r1).** When `has_more` is false, `next_before_entry_date` and `next_before_id` are absent from the response, as `citizenDirectory` omits `next_since` (`src/society.ts:1976`). A test asserts absence (not `null`).
- **A10 T4 boundaries (GEMINI r1).** `before_id` of `0`, `-1`, `1.5`, and `9007199254740992` each answer 400.
- **A11 Page-level aggregates are live (GEMINI r1).** `total_entries`, `booked_cents` and `census` are read on each request, so they can differ between pages of one walk during concurrent writes; A1's note says so in one sentence.
- **A12 T1 asserts the page cap (CODEX r2).** On every page `returned === entries.length` and `entries.length <= 200`, and every page before the last carries exactly 200. Red-proof: serve 201 rows -> fails whatever the cursor is taken from.
