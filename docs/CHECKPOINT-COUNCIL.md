# Checkpoint log: the council (D-075 order step c)

Branch `council-2026-10-12`, base `3ac29289` (`society/` main = origin, waves a and b live as worker `c819e378`). Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-COUNCIL-2026-10-12.md` with amendments CA1-CA11 (CA3 and CA7 superseded by CA10); contract: `drafts/BRIEF-COUNCIL-2026-10-11.md` with K1-K9. Rulings: DECISIONS D-075 and its notes of 11 and 12 Oct.
Nothing pushed, deployed, migrated or written to a network. No `*.local.*` file read. `FRONT_DOOR_TEMPLATE` (`src/doc.ts`) is not edited. The only new migration is `0021_council.sql`. No sub-agent was used.

Class: no money path, no register-path change, no model call, no mint, ONE additive migration (0021). Council motions have no binding effect (K1). Gate: Sonnet. The one permitted edit to citizen authentication is CA5's narrowing check in `authenticateByAssertion`; the gate examines it as a security change.

Base measured in the worktree before any edit: see "Baseline" below.

## Decisions taken while building (each is recorded again where it lands)

1. The operator seat's recusal is derived on read (CA10): `eligible_json` is the whole membership at open, operator seat included. The effective denominator drops the seat for an advice motion, a motion the seat proposed, and a flagged motion; its ballot on such a motion is kept and served as set aside. The ballot INSERT carries the same exclusion in its WHERE, so a flag landing between the read and the write refuses atomically.
2. Derived status is never stored. A motion's verdict is a pure function of rows that cannot change after `closes_at` (ballots and flags are refused at or after it, atomically), so the verdict is stable. Residual: the rule is code, so a later deploy that changes it would re-read old motions under the new rule. Each motion serves `rule: "council-v1"`.
3. Auth on the mixed routes follows `/api/showhome/reply`: an `Authorization: Bearer` credential takes the citizen branch (`authenticate`, unchanged); otherwise the body `token` takes the resident branch (`authenticateGuest` plus a seat). A resident ballot instead carries `{number, assertion}`, as token recovery does: the bound key is the identity and the assertion commits to the act.
4. The council uses its own rate-limit paths in `showhome_rate` (`ShowhomeRatePath` is widened with `council_challenge`, `council_claim`, `council`), with their own refusal wording.

## Commits

| # | sha | what |
|---|---|---|
| 1 | this commit | this log |

## Baseline

2184 tests, 2183 pass, 0 fail, 1 skipped (75 s); `tsc` silent. Measured in the worktree before any edit.

## Notes per commit

### Commit 2: C1 migration 0021 and C2 membership

- `migrations/0021_council.sql` (five tables, no foreign key, `IF NOT EXISTS`, so unlike 0020 it can be re-applied) and the same block appended to `schema.sql` byte for byte (`test/council-migration-d1.test.ts`). CA11 columns: `council_motions` carries `operator_flagged_at`, `operator_flagged_by_kind`, `operator_flagged_by_id` and no `concerns_operator`; an all-or-none CHECK ties the three flag columns together, `closes_at > opened_at` is CHECKed, and `record_body` is CHECKed to 2000 characters. Deviation in detail only: the commission lists `council_thread` and `council_ballots` columns without CHECKs; I added `author_kind`, `member_kind` and `choice` CHECKs because every other table in the repo with an enumerated column has one.
- `src/council-core.ts` is the leaf: constants, served sentences, the pure motion verdict. `src/council.ts` holds membership (`councilMembers`, `citizenRule`, the one classifier the roster and every later write gate share) and `GET /api/council`. Last write is two statements however many members there are (correlated scalar subqueries, no bound ids: D1 allows 100 binds a statement). A citizen's guest-thread answers count as comments in its last write.
- Two existing pins moved because this commit appends to `schema.sql`: `test/resident-migration-d1.test.ts` (the 0020 block was the end of schema.sql; it is now "carried, and only the council header follows it", and the migrated-versus-fresh comparison applies 0021 too) and `test/guest-cognition-blindness.test.ts` (`council.ts` joins `GUEST_READERS` with `guest_thread` and `guests`, its reason written beside the entry). The word "denominator" is on the L-002 upstream-handle list (`test/l002-residue.test.ts`), so src says "effective count" instead.
- `test/council-isolation-d1.test.ts` pins D-043 (nothing under `src/maintainer/` names a council table or imports a council module) and that `council.ts` alone names the tables. Red-proofed by planting a maintainer file and a src file that name a table.
- `test/helpers/council.ts` replaces `globalThis.fetch` with a function that throws, so a test that reaches the network fails; the pinned 1f916 fixtures are copied unchanged into `test/fixtures/1f916/` (cmp-verified).
- Full suite after this commit: 2203 tests, 2202 pass, 0 fail, 1 skipped; `tsc` silent.
