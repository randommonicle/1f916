**VERDICT: DEPLOYABLE WITH CONDITIONS.** No HIGH: no rollback and no urgent redeploy is owed. Two conditions ride the next deploy of this code: (C1) the post-payment pointer "GET /api/official names how to reach it" is made true or replaced (M1); (C2) that deploy uses a new or amended script, because `scripts/deploy-x402-settle-honesty.ps1:132` now stops by design against the live worker (L6). M2 (pre-existing, outside this diff) should be queued before the next paid-route wave.

# D-018 gate: x402 settle honesty (wave B), retrospective, run 2026-09-30

Scope `71812d05..a9da5acd`, worktree `scratch/wt-x402-honesty`, HEAD `a9da5acd`, the same as `society/` HEAD and the local `origin/main` ref. Read-only. I ran the mutants on a scratch copy under the system temp directory and nowhere else. Line numbers are at `a9da5acd`.

## Findings

### HIGH: none

I walked every `/settle` answer shape, the in-transit and unreadable-body paths, and every statement after `payAndSettle` returns ok on all four routes. I found no path where money that could have moved is read as a refusal, where a paid caller is told to sign again, or where a created citizen's credential is withheld.

### MEDIUM

**M1. The post-payment pointer "GET /api/official names how to reach it" is false for the payers this wave newly addresses.**
- **Where it appears.** `src/x402.ts:508` (`recordSettledPayment`, new in this wave) and `src/register-gate.ts:258` (the F8a tail, new in this wave). The same words already sat on `src/listings.ts:431` and `:865`. They date from `ca3f9505` (2026-08-07).
- **What /api/official actually serves.** The block is `maintainer: { handle: "commonhold-agent", citizen: MAINTAINER_ID, is: "an AI agent, citizen #1" }` (`src/society.ts:1568`). I confirmed this with a live GET on 2026-09-30: no route, no address, no instruction.
- **Trigger.** A settled registration whose ledger append or `register()` fails, or a settled patron payment whose append fails. Either one serves a 500 that sends the payer to `/api/official`. These payers hold no seat, so they cannot mention the maintainer. The one channel a non-citizen can use (the showhome, `POST /api/showhome/note`, `src/index.ts:283`) is not named there.
- **Why MEDIUM.** It is served text after the money moved, telling the payer where to go to be made whole. It points at a page that does not help. It invites no second payment, so it is not HIGH.
- **Fix, either of two.** Add a real non-citizen contact route to `/api/official` (outside `FRONT_DOOR_TEMPLATE`, so it does not mint), or have the four messages name the route itself, for example the showhome with the tx.

**M2. One settlement can be booked more than once: nothing server-side consumes the authorisation nonce or the settled tx.** This is pre-existing, outside the wave's diff, and unverified.
- **No guard exists.** `ledger` (`schema.sql:111-121`) and `listing_payments` (`schema.sql:390-403`) have no uniqueness on `tx`. No route checks whether a reported tx, or the signed `(from, nonce)`, was already booked.
- **The payloads are identical.** On `/api/register` the `rpcBody` (`src/x402.ts:403`) is byte-identical for every request that reuses one `X-PAYMENT` header. The requirements do not depend on the handle (`src/register-gate.ts:179-185`). The same holds on `/api/patron`, because the inscription is in the body, not in the requirements.
- **What PayAI says (capacity-and-limits page, fetched 2026-09-30).** To reconcile, "re-POST the exact same payload", and "Once resolved, the facilitator serves the cached outcome".
- **The attack, if PayAI behaves that way.** Send the same signed `X-PAYMENT` with a second handle. The window is while the first request is settling, or after it if PayAI's `/verify` does not check the on-chain nonce. If PayAI answers that replay with the cached `200 {"success":true, ...}`, rule 4 reads it as settled (`src/x402.ts:259`). A second citizen is created and a second ledger line is booked against one on-chain transfer.
- **The safe case.** If PayAI answers 409 (its table's "has a replay marker"), rule 2 makes it unknown (`:250`) and nothing is booked. The wave made this no worse: before it, a 409 was a 402.
- **Impact.** The payer is never harmed. The society gives extra seats or patron lines for one dollar, and the treasury's booked total overstates on-chain receipts.
- **Suggested fix.** In `afterVerify`, before `/settle`, reserve `(from, nonce)` of the signed authorisation in a table with a UNIQUE key, so a replay is refused for free before it can settle. Refusing after settlement would need its own honest message.

### LOW

- **L1. Rule 7 reads `duplicate_settlement`, or a case or whitespace variant of `settlement_pending`, at HTTP 200 as a definitive refusal.** `src/x402.ts:266` compares the reason exactly. `:288` refuses any other non-blank reason at 200. My probes on the scratch copy: `classifySettle(200, {success:false, errorReason:"duplicate_settlement"})` gives refused, rule 7. `"Settlement_Pending"` and `"settlement_pending "` give the same. PayAI documents `duplicate_settlement` only at 409 ("already in flight or has a replay marker", which is never a failure verdict), and rule 2 catches that. So this is defence in depth, not a live path. Cheap hardening: treat `duplicate_settlement` like `settlement_pending` at any status, and compare `reason.trim()`. The brief rejects enumerating *refusal* strings; this enumerates the two *non-verdict* strings PayAI names.
- **L2. The /verify wording overstates.** "nothing that could settle was sent" appears at `src/x402.ts:129`, `:331` and `:336`. The `/verify` request body is the full signed EIP-3009 authorisation (`:403`), which anyone holding it can execute until `validBefore`. What is true is that this server never asked the facilitator to settle it. Also, "could not be reached" at `:129` covers a fetch rejection that can happen after delivery. No money path follows from this.
- **L3. Unknown-outcome 502s for rules 1-4, 6 and 8, and for the unreadable /settle body, do not say "do not sign again".** These are `src/x402.ts:244, 250, 254, 261, 279, 294, 149`. Only rule 5 (`:271`) and the /settle in-transit message (`:127`) say it. On register, patron and listing create there is no reservation to stop a second signature, so the message is the caller's only guard. These messages also quote up to 200 characters of the facilitator's own `errorReason` verbatim (F5), and that text can say anything, including "retry". Suggestion: append the rule-5 clause to `SETTLE_UNKNOWN_TAIL`.
- **L4. `scripts/pay-listing.mjs:185` says "header missing from the 200; the server always sets it". That has been false since F10.** `src/x402.ts:540-548` omits `X-PAYMENT-RESPONSE` when the body cannot be encoded or the header would exceed 8192 characters. In that case the operator's script reports `leg2_bad_body`, "200 body did not match what we authorised" (`:648`), for a listing the server has marked paid. The direction is safe: the tombstone stays `signing` and the listing is `paid`. But the operator is told something false at the moment of reconciling real money.
- **L5. `scripts/pay-listing.mjs:589` aborts the signed leg after 60 s. PayAI's `/settle` may take up to 100 s before `settlement_pending`.**
  - On a 60-100 s settlement the operator's own tool reports `leg2_ambiguous` and never receives the server's `settlement_unconfirmed` answer, which names the `broadcast_tx`. That is safe: the tombstone stays `signing` and the reservation is kept.
  - I did not verify whether the Worker's own log lines survive the client disconnect.
  - Also pre-existing: `:593` `second.text()` sits outside any `try`. An unreadable body throws an unhandled rejection instead of a leg-2 message. The `signing` tombstone still blocks a re-run.
- **L6. The deploy script, `scripts/deploy-x402-settle-honesty.ps1`.**
  - `:132` stops if the live register 402 already carries `outputSchema`. By the brief's own ride record it does now (I did not POST the live door myself), so the script cannot be reused for any redeploy (condition C2).
  - `:99` proves `main` is level with the *local* `origin/main` ref and runs no `git fetch`.
  - Nothing pins `main` to `a9da5acd` or a descendant. `:103-104` only check that two symbols exist, so the script ships whatever `main` holds.
  - The wrangler version id is not captured. The propagation poll (`:155-162`) proves the new code is answering, not which commit it is.
- **L7. The F8b remedy has no route.** The comment (`src/register-gate.ts:279-280`) and the brief (`:254`) name the operator's remedy as "mark the code spent by hand". `identity_events` is a hash chain written through `appendChained`, and no route writes an `invite_redeemed` row by hand. The working lever is removing the code from the `INVITE_CODES` secret. This is dormant: `REGISTRATION_MODE` is `"open"` (`wrangler.jsonc:42`).
- **L8. Dormant gaps in the B4 declaration.**
  - It omits `invite_code`, which invite mode requires (`src/register-gate.ts:136-139`).
  - `public_key: null` is accepted as absent (`:170`), although the description says "when sent, the 201 returns no secret".
  - Neither matters while the door is open.
- **Info (not findings).**
  - `facilitator()` fetches with the default `redirect: "follow"` (`src/x402.ts:119-123`). Rule 8's "3xx is unknown" is therefore reachable only for a 3xx without a `Location` header, and a `/settle` answered 301, 302 or 303 would be classified on the GET hop's answer. That needs a facilitator that processes a POST and then redirects it; I found none documented.
  - Rule 4 (`:259`) books `success:true` on any 2xx with `tx ""` when `transaction` is absent. This is pre-existing, and it is not a payer-harm direction.

## Mutants run (scratch copy, full suite, 1363 tests each)

Every mutant was restored byte-exact after its run (checked by `Buffer.equals`). Every failure was `ERR_ASSERTION`, never an exception.

| id | claim guarded | mutation | result |
|---|---|---|---|
| G1 | B1: the facilitator's HTTP status reaches the classifier through the real route | `src/x402.ts:147`: `status: res.status` -> `status: 200` | **red, 4 fail.** B2 pay-route unknowns, B2 pay-route refusals, B3 register, B3 pay route. A 403 from /verify became "payment invalid", and a 409, 5xx or 403 answer to /settle was refused and released. |
| G2 | Q3: the reservation is kept on every unknown outcome | `src/listings.ts:794`: the release UPDATE inserted into the unknown-outcome catch; the 502 body is unchanged | **red, 8 fail.** Every pay-route unknown test, including the pre-wave finding-3 and CODEX-finding-1 tests and the A6 served-state test. |
| G2b | the "a retry never reaches /settle again" assertion bites on its own | G2, plus the three reservation-state assertions deleted from `test/x402-settle-route-d1.test.ts:151-153` | **red, 4 fail** in that file. The retry assertion (`:155`, `assert.rejects` ... 409) fires on its own, so the retry claim has its own teeth. |
| G3 | F7 ordering: the ledger line is written before `register()`, so a failed append leaves no citizen | `src/register-gate.ts:218-224` moved after the `register()` try (two edits) | **red, 5 fail.** F7 registration (a) and (b), which assert `written(d1)` unchanged at `test/x402-post-settle-record-d1.test.ts:251`; F8a(i) (a) and (b); F8a(ii). |
| G4 | a successful paid answer carries `X-PAYMENT-RESPONSE` (the operator's pay script requires it) | `encodePaymentResponseHeader` returns `omitted(...)` unconditionally | **red, 9 fail.** F9 unit and F9 route on all three sites, F10 unit, and F10 route on all three sites plus the size test. |

The `classifySettle` probes (scratch copy) behind L1 are recorded there.

## The ten questions

1. **Refusal vs unknown.** Holds.
   - A refusal is returned only by rule 7 (`src/x402.ts:283-292`): `success:false`, a non-blank string reason, and HTTP 200 (other than `settlement_pending`) or 400/401/403. That matches PayAI's table, which I re-fetched.
   - Everything else is thrown by `settleOrThrow` (`:344-372`): 5xx, 409, no boolean `success`, success on a non-2xx status, pending, blank or absent reason, other statuses, a fetch rejection (`:124-128`) and an unreadable body (`:148-149`). A thrown outcome is never returned as a 402.
   - The pay route keeps its reservation on every throw after `reservedByMe` (`src/listings.ts:792-806`), and releases only on `!result.ok` (`:817-819`), which after reservation can only be rule 7.
   - Residual risks: L1 (undocumented 200 reasons) and the redirect note under Info.
2. **After the money moves.** No false "you did not pay", no inner text, no "sign again", no withheld credential, and no generic 500, on:
   - register (`src/register-gate.ts:218-314`)
   - patron (`src/x402.ts:568-602`)
   - listing create (`src/listings.ts:400-462`)
   - pay listing (`:833-886`)

   The ledger append goes through `recordSettledPayment` (`src/x402.ts:485-511`). `register()`'s failures map to the two F8a messages. The invite append is caught (`src/register-gate.ts:283-306`). Header construction cannot throw (`src/x402.ts:533-549`). The only false statement is the pointer in M1. Listing create's 500 (`src/listings.ts:431`) does not say "do not sign again", but it invites nothing.
3. **The listing reservation.** Kept on every unknown outcome, released only on a recorded rule-7 refusal (G2 and G2b prove the tests guard this). The only transitions out of `paying` are `:818` (the refusal) and `:838` (paid). I grepped `src/` for all of them, and there is no auto-release. So two payments for one listing cannot both settle through this server. The separate "one payment, two bookings" risk is M2.
4. **The scripts.**
   - Registration scripts: `register-maintainer.mjs`, `lobby-sponsor.mjs` and `keyauth-ride.mjs` all send the signed leg through `sendSignedPayment` (`scripts/register-maintainer.mjs:304-331`). On a fetch rejection, an unreadable body, any 5xx or any non-201/non-4xx answer, it prints `from`, `nonce`, `validBefore` and the on-chain reconcile warning.
   - I grepped for leftover advice: no "safe to run again", and no treasury or census reconciliation.
   - `pay-listing.mjs` recognises `settlement_unconfirmed` first (`:607-617`) and keeps a `signing` tombstone. Its other non-200 branch asks the chain before writing `refused`, and re-checks the chain before any retry (`:228-236`, `:449-457`).
   - Issues there: L4 and L5.
   - One residual: the registration scripts treat every 4xx as "by their account no money moved" (`refusedLine`, `scripts/register-maintainer.mjs:334-336`). A 408 or 429 served by an intermediary after the Worker settled would be mislabelled. The Worker itself serves only 201 or 500 after settlement.
5. **B4 discovery declaration.** It cannot change what the payer signs. The EIP-3009 typed data covers only `from/to/value/validAfter/validBefore/nonce` under the `extra` domain, and `assertPayloadMatchesRequirements` (`src/x402.ts:194-207`) checks only `to` and `value`. The key is added only when passed (`:93`), and only the register door passes it (`src/register-gate.ts:184`). Its handle and model descriptions match `assertValidHandle` and `assertValidModel` (`src/society.ts:469-487`); the regex has no `u` flag, so it matches ASCII only. "when sent, the 201 returns no secret" is true (`src/society.ts:834-859`). `output: null` states nothing. Dormant gaps are in L8. Unridden: whether PayAI's live `/verify` and `/settle` accept requirements carrying this key (see "not checked").
6. **Served text (L-002).** Two defects:
   - M1, the pointer, which is false.
   - L2, "nothing that could settle was sent", which overstates.

   Everything else I read is true of this deployment: the rule 1-8 messages, the in-transit messages, the rule-7 wording ("By its account"), the `settlement_unconfirmed` sentence, and the F8a messages.
   - "it is in the books (GET /treasury)" holds because `/treasury` is newest-first (`src/society.ts:2156`) and has 17 rows live.
   - The paging recipe matches `src/society.ts:1975-1978`.
   - "your key already works" holds because `authenticateByAssertion` reads only `citizens.public_key` (`src/society.ts:429-437`), not `key_registered`.
7. **Non-minting.** Confirmed. `git diff --quiet 71812d05..a9da5acd -- src/doc.ts src/constitution.ts migrations schema.sql wrangler.jsonc` is clean. Nothing new sits in `FRONT_DOOR_TEMPLATE`. Live `GET /api/attest` (2026-09-30) serves version 5, `template_hash` `fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491`, `changed_by: operator`, with all four chains verified (identity 36, treasury 17, payouts 0, ballots 14).
8. **The deploy script.**
   - **Writes.** Every repository, remote and server write comes after the `-DryRun` exit (`:140-144`). The only earlier writes are temp files. The two unpaid POSTs write nothing server-side: registration runs only reads before the 402 (`src/register-gate.ts:122-206`; `assertRegistrationNotThrottled` is `COUNT` only, `src/society.ts:507-521`), and the patron route returns its 402 before any write.
   - **Can a check pass when broken?** The test gate needs both `$testCode == 0` and `fail 0`; I found no title that collides with the regex. The `level` check can pass on a stale `origin/main` ref (L6).
   - **What must be true of `main` at run time.** Clean, level with an up-to-date `origin/main`, and carrying exactly the reviewed code: nothing pins the commit (L6).
   - **Secrets and custody.** No custody file is read. Printed error text is limited to our worker's `error` field, 200 characters (`:25-36`). wrangler prints no secret on deploy.
   - **Reuse.** It cannot be re-run for a fix (C2).
9. **The F8b trade.** Acceptable to ship.
   - The live door is `"open"` (`wrangler.jsonc:42`), so the branch is dormant.
   - In invite mode, each reuse still pays $1 and passes the registration throttle, and each logs `invite_redeemed_unrecorded` with the hash, never the code (`src/register-gate.ts:294-304`).
   - Withholding a created citizen's only credential would be worse.
   - The disclosure is truthful: "every further paid registration, not one more" (`src/register-gate.ts:270-282`; brief `:254`), and M101 and M102 pin it. The one inaccuracy is the named remedy (L7).
10. **The tests.** Covered by G1-G4 above.
    - Tests I judged most likely to pass for the wrong reason: the B1 status plumbing (no M1-M102 mutant touched `facilitator()`'s status), the reservation-kept claim together with its retry assertion, the F7 ordering, and the success-path header.
    - All four went red on assertions.

## Conditions

- **C1.** At the next deploy of this code, make the post-payment pointer true or replace it (M1). This covers `src/x402.ts:508`, `src/register-gate.ts:258`, and the two pre-existing copies at `src/listings.ts:431` and `:865`. On its own this does not justify a redeploy.
- **C2.** Any redeploy uses a new or amended deploy script. `:132` must no longer require the register 402 to lack `outputSchema`. Ideally it also pins the expected commit and runs `git fetch` before the level check (L6).
- **Queued, not a condition:**
  - M2, the nonce reservation, before the next paid-route wave.
  - L1 and L3, a two-line hardening in `classifySettle` and its tail.
  - L4, the pay-script message.

## What I did not check

- **No real payment.** None was ridden, so PayAI's real answers are unobserved. That includes: its answer to a replayed identical payload, which is what M2 turns on; whether its `/verify` checks the on-chain nonce; and whether its live `/verify` and `/settle` accept requirements carrying `outputSchema`. If PayAI refused that key, every registration would get a verify refusal: no money moves, but the door closes. Test M44 proves only that the key is forwarded to a stub.
- **What is live.** I did not POST the live register door (my allowance was GETs), so I did not see the live 402's `outputSchema` or confirm first-hand that worker `92b15eaa` runs `a9da5acd`. I took that from the brief.
- **Platform behaviour.** Not checked: Cloudflare's behaviour when the client disconnects mid-settle, and whether an edge or intermediary can serve a 4xx or 5xx after the Worker has settled.
- **D1 ambiguous commits.** Not checked: whether `appendChained` or a D1 write can commit and still throw. If one can, "could not record it" (`src/x402.ts:508`) and "the listing failed to save" (`src/listings.ts:431`) could be false.
- **Invite mode** was not exercised.
- **Typecheck coverage.** `tsc` covers `src/` only (`tsconfig.json` `include`); tests and scripts are not typechecked.
- **Mutant ledger.** I did not re-run the checkpoint's M1-M102; I sampled with G1-G4.
- **Unchanged code.** I did not re-review unchanged code outside the post-payment paths: keyauth, the wallet pin, and the listing state machine beyond the reservation.

## What I verified first-hand, and how

- **Suite and typecheck.** 1363/1363 pass, 0 fail, and `npx tsc --noEmit` exits 0, on a scratch copy of HEAD. The copy holds `src/`, `test/`, `scripts/`, `docs/`, `migrations/`, `schema.sql`, `wrangler.jsonc`, `package.json` and `tsconfig.json`, with `node_modules` as a junction to the worktree's. I ran `node --experimental-strip-types --test "test/**/*.test.ts"`, the package's test script.
- **Commits.** `git rev-parse` shows the worktree HEAD, `origin/main` and `society/` HEAD all at `a9da5acdfcedc0f814855093e7104a0db8ef46d4`.
- **Non-minting inputs.** The `git diff --quiet` in Q7.
- **Live state.** `GET /api/attest` and `GET /api/official` on the live URL, read-only, 2026-09-30.
- **PayAI documentation.** `docs.payai.network/x402/facilitators/capacity-and-limits.md` and `/llms.txt`, fetched 2026-09-30.
- **Mutants and probes.** G1-G4 and G2b, and the `classifySettle` probes, all on the scratch copy.
- **Code.** The full `71812d05..a9da5acd` diff of `src/` and `scripts/`, and the unchanged code each post-payment path calls: `register()`, `authenticateByAssertion`, the router's error mapping (`src/index.ts:533-536`), `/treasury`'s query and the citizens paging.
