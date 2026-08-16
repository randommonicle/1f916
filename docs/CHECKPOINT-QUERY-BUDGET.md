# CHECKPOINT — the judgment subrequest-budget wave (D-036/D-037/D-038/D-041)

Builder log for the wave commissioned in
`docs/BRIEF-JUDGMENT-QUERY-BUDGET.md` (project root). Per-commit entries,
one concern each; the load-bearing red-proofs are pasted here as evidence
for the D-018 re-gate.

Baseline probed at HEAD `05c352f`: `git status -sb` clean and level with
`origin/main`; `npm test` 573/573 pass exit 0; `npm run typecheck` clean
exit 0; `git diff dfc3988..HEAD --stat -- migrations/ schema.sql` EMPTY.

Note on placement: the brief's Custody section names project-root
`docs/CHECKPOINT.md`; the commission ROLE says keep the per-commit log
"in the repo" with default `society/docs/CHECKPOINT-QUERY-BUDGET.md`.
Resolved in favour of in-repo so the log travels with the commits for the
gate to re-derive, and so nothing outside `society/` is edited. Flagged in
the final report.

---

## Commit 1 — the subrequest-counting proof seam (test infrastructure)

**What it did.** Added the seam THE PROOF is built on: every D1 statement
AND every outbound `fetch()` counted against one shared 50-subrequest
budget, throwing before the 51st.

- `test/helpers/local-d1.ts`: `createLocalD1()` gains an optional
  `{ onExec }` hook, called once per `first()`/`all()`/`run()` and once per
  statement inside `batch()`, BEFORE the statement runs. Every existing
  caller passes nothing and is byte-for-byte unaffected; seeding via
  `d1.raw` stays uncounted (scaffolding, not code under test).
- `test/helpers/subrequest-counter.ts` (new): `installSubrequestCounter`
  wraps `globalThis.fetch` and shares one `consume(kind)` closure with the
  D1 hook. `consume` increments and throws before executing subrequest
  `limit+1`, AND latches a `breached` flag so a throw swallowed by
  production try/catch (callAnthropic converts a fetch throw to ok:false;
  runJudgmentWake logs a scan throw; scheduled() has a backstop catch)
  cannot read as green. Plus response-shaped bodies for the two real fetch
  shapes (Anthropic judgment/clerk by pinned model name; Base RPC balance).
- `test/subrequest-counter.test.ts` (new): 4 tests pinning the seam —
  D1+fetch share one counter; each batch statement counts individually;
  the 51st THROWS before executing, proven for a D1 statement AND for a
  fetch (a proof that only fails on "query 51" would miss the fetch case).

**Key decision.** The verdict for the e2e proofs is `total() <= 50 &&
!breached()`, not "did it throw" — because production code legitimately
catches throws, so a swallowed budget breach must still fail the test. The
throw still fires (simulating the platform killing the 51st op); the flag
is the durable evidence.

**Latitude.** The brief named `local-d1.ts:36-47` as "the seam"; the actual
execution methods are the `statement()` closure and `batch()` body, so the
hook lives there. No behaviour change to any existing path.

**Red-proof.** The seam's own can-it-fail is the `assert.rejects` at the
51st subrequest, proven for both a D1 statement and a fetch (see the test
file). Full suite 577/577 (573 + 4), typecheck clean.
