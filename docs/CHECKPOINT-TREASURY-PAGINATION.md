# Checkpoint log: /treasury paging (docs/BRIEF-TREASURY-PAGINATION.md, A1-A12)

Branch `treasury-pagination-2026-10-02`, base `678ae407`. Builder: Sonnet 5.5. Worker-only, no migration,
non-minting, nothing pushed or deployed. Baseline at base: 1508/1508, tsc 0. Final: 1523/1523, tsc 0.

## Commit 1 `3f3e8b16`: the paged read, the cursor parser, the route, ROUTES

- `src/society.ts`: `LEDGER_PAGE = 200`, `LedgerCursor`, `parseLedgerCursor(rawDate, rawId)` (pure, SocietyError 400),
  `treasury(env, cursor = null)`. The read asks for `LEDGER_PAGE + 1` rows and serves 200 (look-ahead rule, not
  `returned === page_size`). New keys beside the old ones: `total_entries` (a separate `SELECT COUNT(*)`),
  `returned`, `page_size`, `has_more`, `next_before_entry_date` / `next_before_id` (spread only when `has_more`,
  omitted never null: A9), `pagination_note` (walk semantics A1, per-request aggregates A11). `wallet.note` rewritten
  (A6). The DEFERRED marker comment replaced by a comment naming the brief. `booked_cents`, `onchain_cents`,
  `census` untouched (page-independent).
- `src/index.ts`: the route line keeps the exact substring `path === "/treasury" && method === "GET"` (A8); it now
  passes `parseLedgerCursor(url.searchParams.get("before_entry_date"), url.searchParams.get("before_id"))`. The
  SocietyError from a bad cursor is thrown before any DB read and reaches the router's existing catch (400).
- `src/discovery.ts`: `/treasury` gains `queryParams` (`before_entry_date` string, `before_id` integer, both
  optional) and a `note`; `renderOpenApi` derives the parameters from there, so `/openapi.json`, `/api/surface`
  and `/llms.txt` follow.
- Decisions: presence of a cursor parameter is `!== null`, never truthiness and never `parseNumberParam` (which
  maps `""` to absent): a present-but-empty value is a malformed cursor, answered 400, so a silently ignored cursor
  cannot serve page 1 to a walker who thinks it is on page 2. One 400 message per failure mode (pairing, date
  shape, id shape), each naming the shape. `before_id` is typed `integer` in ROUTES (it is one), the date `string`.
  `before_id` accepted shape is `^\d{1,16}$` and `Number.isSafeInteger` and `>= 1`.
- Tests (new file `test/treasury-pagination-d1.test.ts`, real node:sqlite via `createLocalD1`, `globalThis.fetch`
  stubbed to a non-ok answer so `onchain_cents` is null and nothing leaves the machine): T1 (0, 1, 200, 201, 401
  rows) with A12 (page cap) and A9 (absent cursor keys), T2, A2 (a fixture whose boundary falls inside one
  entry_date, asserted as a precondition), T4 with A10 (parser), T5 with A4 (unequal page sums, both pages equal the
  whole-ledger sum), T6 (17 rows, entries byte-identical to the original query's output via `JSON.stringify`),
  A7.

## Commit 2 `20527870`: router-level tests and the served sentences (test only)

- A5: both parameters reach `treasury()` through `worker.fetch`; a valid cursor matching no row (id 9999) pages as a
  bound (oracle computed in JS from the table's rows, not from the query under test); malformed cursors are 400
  with the shape in the body (8 spellings, including both parameters present and empty); `/openapi.json` lists both
  parameters on `/treasury`, optional, in the query, with the right types.
- A6 and A1/A11: `wallet.note` and `pagination_note` asserted as served.
- The `pagination_note` sentence "every ledger writer today takes entry_date from the server clock" is a claim
  about the code, so it is enforced by a source scan: every `entry_date:` in `src/` is the server-clock expression
  or a type annotation, there are exactly five writers (recordLedger `society.ts`, registration `register-gate.ts`,
  payout `payouts.ts`, listing fee `listings.ts`, patron `x402.ts`), and nothing inserts into `ledger` by raw SQL.
  A sixth writer, or a writer-supplied date, turns this red and sends its author to the note.

## Commit 3 `99a790dd`: T7 / A3 (test only)

- Fixture rows are dated 2025 (before today, UTC). Page 1, then `recordLedger` (the real writer, maintainer id 1,
  bearer credential `null` so `requireSignedIntent` returns early) inserts a row dated today, then page 2 from page
  1's cursor: the new row is not on page 2, no id repeats, the walk saw exactly the 250 original rows, page 2's
  `total_entries` is page 1's plus one, `booked_cents` moved by the new row (A11), and a fresh walk starts with it.

## Commit 4 (this one): checkpoint log and a comment reword

- The source comment that replaced the DEFERRED marker was reworded so a grep for the flag no longer lands on a
  closed deferral (the brief file keeps the name). No behaviour change; suite re-run.

## Mutants (each applied to the committed code, the new test file run, then `git checkout --` and the file's sha256
re-read: restored byte-identical in every case)

| # | Mutant | Red tests |
|---|---|---|
| M1 | `fetched.slice(0, LEDGER_PAGE + 1)` (serve 201 rows) | T1/A12/A9, T2, A5 walk |
| M2 | cursor from `entries[length - 2]` (a row repeats) | T1, T2, A2, T5, A5 walk, T7 |
| M3 | `has_more = served.length === LEDGER_PAGE` (census rule) | T2, A2 |
| M4 | cursor on `entry_date` alone (`... AND id < ? AND 0`) | T1, T2, A2, T5, A5 walk, A5 no-row cursor, T7 |
| M5 | cursor ignored (no WHERE, no bind args) | T1, T2, A2, T5, A7, A5 walk, A5 no-row cursor, T7 |
| M6 | `booked_cents` summed over the page | T5/A4, A7, T7 |
| M7a | `ORDER BY ... ASC` | T1, T2, A2, T5, T6, A5 walk, A5 no-row cursor, T7 |
| M7b | two columns swapped in the entries SELECT | T6 only (byte equality) |
| M8 | cursor keys `null` instead of omitted on the last page | T1/A9, A7 |
| M9 | cursor from the look-ahead row | T1, T2, A2, T5, A5 walk, T7 |
| M10 | `total_entries = entries.length` | T1, A7, A5 walk, A5 no-row cursor, T7 |
| M11 | `wallet.note` back to "rehashes from the entries below" | A6 |
| M12a | `pagination_note` without "Pages are separate reads" | A1/A11 |
| M12b | without the per-request aggregates sentence | A1/A11 |
| M12c | without the equal-count caveat | A1/A11 |
| M13a | parser: pairing check removed | T4/A10, A5/T4 |
| M13b | parser: date regex unanchored | T4/A10 |
| M13c | parser: `id < 1` removed | T4/A10, A5/T4 |
| M13d | parser: unsafe integer accepted (`isSafeInteger` -> `isNaN`) | T4/A10, A5/T4 |
| M13e | parser: present-but-empty read as absent | T4/A10, A5/T4 |
| M13f | parser: `Number(rawId)` with no shape regex | T4/A10 |
| M14 | route drops the cursor arguments | A5 walk, A5 no-row cursor, A5/T4 |
| M15a | ROUTES: `before_id` renamed | A5 openapi |
| M15b | ROUTES: `before_id` typed string | A5 openapi |
| M15c | ROUTES: `before_entry_date` required | A5 openapi |
| M16 | a writer (x402 patron) takes `entry_date` from elsewhere | A1 writers scan |

The brief's T1 red-proof ("serve page_size + 1 rows -> the row appears on two pages") does not hold as worded: with
the cursor taken from the last row served, the 201st row is served once, on page 1, and not repeated. M1 is caught by
A12 (the page cap), exactly as A12's own text says; the repeated-row shape is M2.

## Non-minting evidence

- `src/doc.ts` is untouched (`git diff 678ae407 --stat -- src/doc.ts` is empty). `test/doc.test.ts`'s eight golden
  front-door hashes pass unchanged. `GET /` and the attested template read nothing this branch edited.
- llms.txt, `/api/surface` and `/openapi.json` are derived from `ROUTES`, outside `FRONT_DOOR_TEMPLATE`.

## D-061 secret-literal guard (`test/secret-literal-guard.test.ts`)

- Pinned baseline read at base and again at the end: 76 secret-literals, 23 wire tokens, 53 prose. Unmoved: none of
  the strings added contains the word "secret". The guard stays green with no baseline edit.
- Finding, not changed here: the test's header comment still says "66 secret-literals, 22 wire, 44 prose, 43
  allowlist entries"; the asserted numbers (76/23/53) have moved since and the comment did not.

## Brief citations that had drifted (read from code at base, not from the brief)

- At base `678ae407`: `treasury()` is `src/society.ts:2171` (brief: 2140), its DEFERRED marker `:2177` (brief: 2146); the route is
  `src/index.ts:214` (brief: 213); wallet.note was at `:2225` (brief: 2190-2199).
- The brief's A1 writer lines at base are: recordLedger `society.ts:2264`, registration `register-gate.ts:320`,
  payout `payouts.ts:115`, listing fee `listings.ts:472`, patron `x402.ts:1146` (brief: x402.ts:574, listings.ts:401,
  register-gate.ts:220, society.ts:2233). All five set `entry_date` from `new Date(now).toISOString().slice(0, 10)`.

## Ride (for the deploy, not run here)

`GET /treasury` shows the new keys with `total_entries` 17 and `has_more` false and no `next_before_*` keys;
`GET /treasury?before_entry_date=2000-01-01&before_id=1` answers `returned` 0 with `total_entries` 17;
`GET /treasury?before_id=1` answers 400.
