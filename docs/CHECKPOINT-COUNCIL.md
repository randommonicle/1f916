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
