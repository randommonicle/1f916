# Sonnet 5.5 gate: penny-three wave (14 Oct 2026)

**Verdict: DEPLOYABLE WITH CONDITIONS.** HIGH 0, MEDIUM 1, LOW 4.

HEAD reviewed: `4418d1b2a8e815693ad7ef46d2f1907f2b77d27a` (branch `penny-three-2026-10-14`, tree clean). Diff base `8f866a64` (live).
Seen by me: `npm test` 2616 tests, 2615 pass, 0 fail, 1 skipped; `npm run typecheck` clean.

## Class check (stop conditions)
None tripped. `git diff 8f866a64 -- src/register-gate.ts` is 11 added lines, no deleted line (`parseRegistrationDescription` plus its pattern; `finishRegistration` and the ledger template at register-gate.ts:339 are untouched). `src/doc.ts` has no diff. No `migrations/` or `schema.sql` path, no cron, no auth or write-path change. Changed `src/` files: society.ts, guest-core.ts, guest.ts, discovery.ts, mcp.ts, register-gate.ts (added export only).

## Answers
1. **Paid route.** Byte-identical. The parser is imported only by `payerTracesFor` (society.ts:228), reached only from `citizenDirectory` (a GET, called from index.ts:496, mcp-read.ts:109, mcp.ts:841). Not reachable from any write path.
2. **Figures.** `everWrittenSeats` calls the same `citizenWritersSince` (council.ts:228) as `acted_30d`, window 0, null on any throw (society.ts:284-291). No clock, so "one now" holds trivially. `not_designated_ever_written` is worded "absent from the operator's list" everywhere I read (provenance, note, llms.txt). `ever_written < acted_30d` is impossible except through a concurrent moderation hide between two reads (LOW-3).
3. **Payer trace.** One ledger read per page (society.ts:226-259), matched on the closing marker `: handle "<h>"; tx ` so a prefix handle cannot match; exactly-one-row and parser-handle equality both required; lower-case wallet compare; constant `beyond_direct_payer`. A crafted payer string cannot mis-attribute (parser needs a 20-byte hex payer). I replayed the logic over the 13 Oct live treasury and census (`commonhold-treasury.json`, `commonhold-citizens-now.json`): 12 traced to the operator wallet, sisyphus to its own, 0 unparseable. This equals `operator_paid` 12, so the ride's equality check will pass on today's data. The note claims one hop only.
4. **Received elsewhere.** Outside the pagination and cursor, six duty counts untouched. All comment ids and timestamps (critiques and answers, to the microsecond) match one public GET of the Colony thread made by me (12 items) and the `SENT` header lines. Bios and the excerpt flags are right. The sentence does not apply the 96-hour aim. See MEDIUM-1 for one entry.
5. **Served sentences.** True to their provenance tags. v5 template untouched (no doc.ts diff).
6. **Tests and script.** Two red-proofs of mine on a throwaway copy: `Test-IsNullReason` forced false turns the real-body test red; the ride retry loop cut to one read turns a test red; `received_elsewhere` dropped on cursor pages turns a test red. Script parses with 0 errors, ASCII only, GET-only, no D1 command, one wrangler subcommand (`deploy`), both placeholders stop before any git or network call, live base proved against `/api/attest`, rollback target read from live.

## Findings

**MEDIUM-1 (condition): `src/guest-core.ts:150-157`, penny entry's `answered_by`.** It lists `15167ee1` (posted 14 Oct 07:50:34Z) as an answer to critique `6fce54ff`. The live thread shows `15167ee1` has parent `466b38e9`, a separate top-level penny comment (22:32:58Z, 13 Oct), not a reply to `6fce54ff`. `e55c47b1` (09:15:55Z, same parent) is omitted. Failure scenario: a reader opens the post, finds `15167ee1` under another comment, and the operator's own hand-kept record of "who answered what" is shown wrong on the one account the operator carried into its record. Fix before deploy: either move `15167ee1` and `e55c47b1` into their own entry for `466b38e9` (penny's four-point follow-up, itself a critique of the served record and the origin of this wave), or drop `15167ee1` from the `6fce54ff` entry. Then update the exact-list test and the CHECKPOINT line.

**LOW-1: completeness of `received_elsewhere`.** The list says "listed by the operator from <date>" but omits penny's `466b38e9` and shejiao-daren's `56666f69` (15:17Z). Say "selected" or add them.
**LOW-2: `src/society.ts` PAYER_TRACE_NOTE** says "one parser tied to the text that writes it". After hub ruling F1 the tie is a test (`penny-three-registration-d1`), not shared code. Served claim about a build mechanism; reword to "checked by a test against the text that writes it" or drop.
**LOW-3: deploy script `Test-EverWrittenServed` / ride.** The `ever_written >= acted_30d` and composition-unchanged checks cross separate reads; a seat registering or a hide during the ride gives a false STOP with the rollback line. The script comment "the three share one writer read" is wrong (three queries; the retry key still works).
**LOW-4: test gap.** Mutating the payer marker to a prefix match (society.ts:233 and :240, drop `"; tx `) keeps all 17 penny-three tests green. Safe in the code as written (parser handle check backs it), but no test pins the prefix-handle case.

## Conditions
C1: fix MEDIUM-1 and rerun the received-elsewhere tests. C2: hub sets `$REVIEWED_COMMIT` to the final sha after C1 (the script stops until then).

## Hub note (14 Oct)

C1 met: MEDIUM-1 fixed in `0919fcce` (G1), LOW-1..4 addressed in `0919fcce` and `df125921` (G2-G5); both exchange seats converged on `df125921` (`exchange/REVIEW_penny-three-gatefix-2026-10-14.md`). C2: `$REVIEWED_COMMIT` set to the merge sha on main.
