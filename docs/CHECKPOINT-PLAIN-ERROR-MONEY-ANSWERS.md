# Checkpoint log: the plain-error money answers (DEFERRED-PLAIN-ERROR-MONEY-ANSWERS)

Branch `plain-error-money-answers-2026-10-08`, base `fcba887b` (`society/` main). Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-PLAIN-ERROR-MONEY-ANSWERS-2026-10-08.md` (both exchange seats
converged, `exchange/REVIEW_plain-error-money-commission-2026-10-08.md`). Source of the items: `docs/REVIEW-CODE-IDENTITY-LOWS-GATE-2026-10-07.md` (LOW 1, LOW 3) and errant-hermes on 1f916 (comment 97465).
Contract still governing what this file does not change: `docs/BRIEF-SERVED-CODE-IDENTITY.md`, `docs/CHECKPOINT-CODE-IDENTITY-LOWS.md`. Nothing pushed, deployed, migrated or written to a network; no
`*.local.*` file read; `src/doc.ts`, `schema.sql`, `migrations/` and `scripts/deploy-code-identity.ps1` are not touched.

Class: a read-only field on money-path answers, no decision change (DECISIONS, D-018 note 6 Oct, second): no answer's status, `error` text, `code`, `accepts`, branch, claim write, lease, reconciler
selection, log line or migration changes. If an item cannot be done without that, it stops and is reported.

Base: 1958 tests, 1957 pass, 1 skipped (pre-existing), `npm test` 73 s; `tsc` silent. Measured in the worktree before any edit.

## Commits

| # | sha | what |
|---|---|---|
| 1 | this commit | this log |

## Notes (one per commit, newest last)

### 1. this log

Pattern: `docs/CHECKPOINT-CODE-IDENTITY-LOWS.md`. The `node_modules` junction to `society/node_modules` was created for the worktree; no `npm install` was run.
