# CHECKPOINT — pre-gate fixes wave

Builder log for a three-commit wave closing the two HIGHs and the
contention finding from Codex's combined-deploy pre-gate
(`exchange/REVIEW_combined-deploy-pregate_2026-08-16.md` `## [CODEX round 1]`;
the contention verification is `exchange/REVIEW_query-budget-brief_2026-08-15.md`'s
last `## [CODEX round 1]`). Each finding was REPRODUCED by Codex; each fix is
re-derived at source and red-proved at the same boundary Codex used.

Baseline probed at HEAD `9fe6705`: `git status -sb` clean, `main` ahead 13 of
`origin/main`; `npm --prefix society test` 617/617 pass exit 0;
`npm --prefix society run typecheck` clean exit 0.

---

## Commit 1 — HIGH 1: throttle backstop accepts the one-over (money-touching)

**What it did.** D-042's original ruling made the pre-settle throttle
precheck (`assertRegistrationNotThrottled`, called from `register-gate.ts`
step 3, before `buildPaymentRequirements`) the primary gate, but
`register()` (`society.ts`) kept its own call to the SAME function as a
"backstop" running AFTER settle. Codex proved this backstop unsound: two
same-IP rows seed the precheck at count 2 (under the 3/hour limit), the
precheck passes, a THIRD same-IP row lands during the facilitator's
`/verify` round trip (a genuinely concurrent second registration), settle
proceeds and the ledger is written, then `register()`'s own COUNT-and-throw
finds the count now at 3 and throws 429 — wrapped into the paid-but-failed
500, exactly the defect D-042 existed to close, just moved one layer in.

**Fix.** Ben's same-day D-042 amendment (recorded in `DECISIONS.md`):
accept the one-over. Removed the `await assertRegistrationNotThrottled(env, ip)`
call from `register()` entirely — the pre-settle precheck in
`register-gate.ts` is now the SOLE gate for the throttle. The `reg_log`
INSERT and the 24h-prune DELETE stay exactly where they were in
`register()`, running unconditionally on every successful, settled
registration, so a future count still sees this one. `assertValidModel`
stays as a genuine backstop in `register()` (pure, deterministic, no race
possible — the exact distinction the fix turns on). Planted the grep-able
marker `FORWARD(D-042): accept-one-over; a future society may replace this
with atomic quota reservation for strict enforcement.` at the changed site.
Updated the two comments that had asserted the now-false claim ("register()
still calls it as a backstop") in `society.ts` (both
`assertRegistrationNotThrottled`'s header and `register()`'s own body) and
in `register-gate.ts` (step 3's comment) — grepped `backstop` across `src/`
to find every site asserting this fact before editing, not just the two
obvious ones.

**Red-proof (pasted, run against the UNFIXED code first).** New test in
`test/register-gate-d1.test.ts`: seeds 2 same-IP `reg_log` rows (under the
limit), lets `register-gate.ts`'s precheck pass, then inserts a THIRD
same-IP row from inside the stubbed facilitator's `/verify` callback —
Codex's own interleaving, not a contrived direct call. Against the unfixed
code:

```
{"level":"error","event":"registration_paid_but_failed","payer":"0x00000000000000000000000000000000000abc","tx":"0xfeedfeedfeed","amount_cents":100,"handle_attempted":"one-over-citizen","ledger_receipt":"9d59a871caacd8596cd8094da1250d70f2eee646823e07f2e3ff1a7ea8966f70","reason":"Too many registrations from your address this hour. One identity is usually enough."}
✖ RED-PROOF (D-042 amendment, HIGH 1): a third same-IP registration lands during the /verify callback -- register() must accept the one-over, never paid-refuse (33.5404ms)
  Error: Your $1 payment settled (tx 0xfeedfeedfeed) but registration then failed: Too many registrations from your address this hour. One identity is usually enough.. This is logged for the maintainer to see and put right by hand: GET /api/official names how to reach it. Your payment is already in the books: GET /treasury.
      at handleRegisterGate (src/register-gate.ts:173:11)
    status: 500
```

Settle genuinely ran (verify + settle both called, ledger written per the
log line) before the refusal — the exact shape Codex described. After the
fix, the same test: 201 citizen created, `verifyCalls===1`,
`settleCalls===1` (settle ran exactly once, not retried), one ledger entry,
and `reg_log` carries 4 rows for the IP (2 seeded + 1 raced + register()'s
own insert) — the one-over is recorded, not refused.

**Kept, unchanged, still green:** the existing "a payer whose IP is already
at the 3/hour registration limit is refused BEFORE settle" test
(`register-gate-d1.test.ts`) — proves a payer already OVER the limit AT
PRECHECK TIME is still refused pre-settle, settle never called. This is
the case the task asked to keep proven; it required no changes since the
fix touches only `register()`'s post-settle path, never the pre-settle
gate.

**Behaviour preserved.** The offender-scan test ("register() is called
only from register-gate.ts, nowhere else in src/") stayed green throughout
— no new caller was introduced. Full suite 618/618 (617 + 1 new), typecheck
clean. Three touched files (`src/society.ts`, `src/register-gate.ts`,
`test/register-gate-d1.test.ts`) NUL-clean (red-proofed against a scratch
file carrying a real NUL byte first: `tr -d '\0' < f | cmp -s - f` correctly
exits 1 on the NUL scratch file and 0 on all three touched files), no
backslash-u escape notation anywhere. `git diff dfc3988..HEAD --stat --
migrations/ schema.sql` still empty.

Commit `<filled after this commit lands>`.

---
