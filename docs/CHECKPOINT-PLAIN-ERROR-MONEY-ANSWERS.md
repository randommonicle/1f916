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
| 1 | `e1cda83b` | this log |
| 2 | `554c27a8` | P1: `markMoneyAnswer` / `carriesMoneyMark`, the two marked throws, the router rule, unit and router tests, the call-site sweep |
| 3 | `d72f7195` | P3: the route-level read-backs with stability (`test/plain-error-money-routes-d1.test.ts`) |
| 4 | `070632b8` | P2: the served sentence in `/api/attest`'s description, its tests |
| 5 | `abddc5ad` | comments: the flag block rewritten, the router and SocietyError comments, the flag pin |
| 6 | this commit | the close: red-proofs, decision invariance, checklist walk, differences |

## Notes (one per commit, newest last)

### 1. this log

Pattern: `docs/CHECKPOINT-CODE-IDENTITY-LOWS.md`. The `node_modules` junction to `society/node_modules` was created for the worktree; no `npm install` was run.

### 2. P1: the mark on the two plain Errors, and the router rule

**Mechanism.** `src/society.ts` gains `markMoneyAnswer(err)` (defines `moneyAnswer: true` on the object, non-enumerable, non-writable, non-configurable: SocietyError's own descriptor, and returns the Error so a
throw site reads `throw markMoneyAnswer(new Error(...))`) and `carriesMoneyMark(e)` (`e instanceof Error && e.moneyAnswer === true`; a non-Error throw, or a bare object that merely has the property, is not marked). The
router's non-`SocietyError` branch (`src/index.ts`) keeps its `console.log` line and the generic body and the 500 exactly, and builds `{ error: <generic>, answered_by }` only when `carriesMoneyMark(e)`; `answered_by` LAST.
The `SocietyError` branch is untouched (it still reads `e.moneyAnswer === true` itself).

**Sites marked** (the throws stay plain `Error`s, same message, so every catch and log line behaves as before):

| site | what |
|---|---|
| `src/x402.ts:769` | `payAndSettle`, rule-7 first refusal: the claim cannot be read back after the refusal write ("could not be read back after its refusal write; the outcome is unknown") |
| `src/x402.ts:1215` | `ledgerReceipt`: the treasury row a claim recorded does not exist ("ledger row N recorded in the claim does not exist") |

**Where each can reach the router, and every wrap on the way** (read from source, not from the hub's pre-check):

- `x402.ts:769` is reached through `payAndSettle` by three callers with NO try around the call, so the mark survives to the router: `register-gate.ts:258` (register), `x402.ts:1382` (patron),
  `listings.ts:442` (listing create). The fourth caller, `listings.ts:908` (listing pay), is inside the try whose catch (`listings.ts:928`, `if (!reservedByMe) throw e;` then the 502 `settlement_unconfirmed`
  with `answered_by`) CONVERTS it when this request reserved the listing: the mark is not used there, the answer already carries the identity. When the request did NOT reserve, the same catch rethrows `e`
  unchanged, and the mark survives to the router (unreachable in practice: the refusal branch is reached only after `afterVerify` ran, which is what sets `reservedByMe`).
- `x402.ts:1215` (`ledgerReceipt`) has three callers. `register-gate.ts:338` (`finishRegistration`) and `listings.ts:501` (`finishListingCreate`) call it OUTSIDE any try (the register try begins at `:346`; the
  listing-create try wraps only the listing INSERT below it), so the mark reaches the router through `finishUnderOwnLease` (rethrows `e` unchanged after releasing the lease, `x402.ts:1199-1208`) or, for the
  reconciler, `settlement-reconcile.ts:313` (logs `reason`, serves nothing). The third, `x402.ts:1299` inside `recordSettledPayment`, is INSIDE the try whose catch (`:1301-1317`) logs
  `payment_settled_unrecorded` and throws a NEW `SocietyError(500, ..., undefined, true)`: it was already a marked, identity-carrying answer, so the mark on the inner Error is dropped there and is harmless.
  `listings.ts` pay (`finishPayListingBooking`, `:1016-1063`) never calls `ledgerReceipt`.
- **Wraps that drop the mark:** only that one (`x402.ts:1301-1317`, deliberately). Rethrowing without wrapping: `finishUnderOwnLease` (`x402.ts:1199-1208`), `register-gate.ts:308` (rethrows a non-SocietyError as is;
  it re-wraps a `SocietyError` only), the `payAndSettle` `catch (e) { ... throw e; }` after `noteUnknown` (`x402.ts` ~:735, a different error). No other catch on these paths builds a new error from these two.
- **No catch branches on the mark or on the class of these two errors.** The log sites that read the message are `register-gate.ts:478` (`e instanceof SocietyError ? e.message : String(e)`, a plain Error gives
  `String(e)` as before), `x402.ts` ~:1309 and `listings.ts` pay/create catches (`e instanceof Error ? e.message : String(e)`), `settlement-reconcile.ts:313` (the same): none reads the mark, and a
  non-enumerable property changes no `String(e)`, `e.message`, `instanceof` or `JSON.stringify` result.

**Not marked, stated plainly:**

- A raw D1 or runtime throw outside these two sites (the gate's LOW 3): e.g. `getClaim` itself throwing at `x402.ts:768`, a D1 error in `replayForClaim`'s `getClaim` (`x402.ts:1195`), any other statement.
  It stays the generic 500 with no `answered_by`; this wave's negative control pins that.
- The x402 402 challenge bodies (protocol shape: `x402.ts` ~:782-788, `accepts`), untouched.
- The society's refusals before settlement (the gate's LOW 1: the `afterVerify` refusals, validators, throttles, the 409 handle-taken before any payment): never marked, so a stranger's free refusal never carries
  the identity.

**Tests** (`test/plain-error-money-d1.test.ts`, parts 1, 2 and the sweep): the mark's descriptor and invisibility (`Object.keys`, `JSON.stringify`, spread, `Object.entries`, `String(e)`, class, a failed
re-set), `carriesMoneyMark` on every shape of thrown value, the router serving a marked and an unmarked plain Error side by side (body byte for byte; the log line byte for byte, written out, identical for
both), the `SocietyError` branch unchanged, a bare object `{ moneyAnswer: true }` and a thrown string NOT marked, and a source sweep pinning exactly two `markMoneyAnswer(` call sites, both in `x402.ts`.
The existing `test/code-identity-lows-d1.test.ts` sweep (marked `new SocietyError(` counts per file) is untouched and green: the new helper is not a `new SocietyError(` call.

### 3. P3: the read-backs through the routes, with stability across re-sends

`test/plain-error-money-routes-d1.test.ts` (8 tests, real router, real local D1, real SQLite triggers, `captureLog`). It imports nothing this wave added, so it also runs against the base source
(`PEM_RECORD=<path>` writes what each scenario served; the decision-invariance table in the close compares the two runs). Every case pins the exact status, the exact body TEXT (so key order), the router's one
log line (written out as a literal, not computed), the row counts after EACH send, and three identical sends. Fixtures: the claim's treasury row is deleted with `DELETE FROM ledger` after the first request
left a `settled_unbooked` claim (no triggers guard the ledger in `schema.sql`); "the claim vanishes after the refusal write" is an `AFTER UPDATE` trigger on `settlement_claims` that deletes the row the
first-refusal write just updated (a persistent fault; the write's own `changes` stays 1, so the code sees a refusal written and then no row); "one read finds nothing" is a DB wrapper that makes the
first claim `SELECT` after the first-refusal write return no row (a transient fault).

**Per case: the answer, whether it is stable across re-sends, and the state it leaves.**

| case | answer (all with the router's log line `{"level":"error","path":...,"message":"Error: ..."}`) | stable across 3 identical sends? | state left |
|---|---|---|---|
| (a) register, treasury row deleted | 500 `{"error":"Internal error. The society apologizes.","answered_by":{...}}` | yes, byte-identical text | claim `settled_unbooked` still pointing at the vanished row, lease released after every send; 0 citizens, 0 ledger rows, claim count 1; the facilitator was asked once (by the first request only) |
| (a) listing create, treasury row deleted | the same 500 + `answered_by` | yes | claim `settled_unbooked`, lease released; 0 listings, 0 ledger rows; facilitator asked once |
| (b) register, persistent fault | the same 500 + `answered_by`, log reason "could not be read back after its refusal write" | yes | NO claim row (the trigger deletes it each time); 0 citizens, 0 ledger, 0 claims. Each re-send is a fresh claim and a fresh `/verify` and `/settle`: the facilitator is asked once PER SEND (3 sends, 3 asks) because the claim that would have answered it is gone |
| (b) patron, persistent fault | the same | yes | no claim row; no treasury line; facilitator asked once per send |
| (b) listing create, persistent fault | the same | yes | no claim row; no listing, no treasury line; facilitator asked once per send |
| (b) register, TRANSIENT fault | first answer: the same 500 + `answered_by`; re-sends: 502 `settlement_unresolved` with `answered_by`, no `accepts`, the claim's own answer | NOT stable from the first answer to the second (500 then 502); stable from the first re-send on (re-send 1 = re-send 2 byte for byte) | after the first answer: claim `pending` holding the facilitator's refusal, lease released, 0 citizens, 0 ledger. Nothing invites a second signature at any point |
| (b) listing pay (regression) | first answer: 502 `settlement_unconfirmed` with the existing keys in the existing order (`error, listing_id, submission_id, paying_since, wallet_row_id, wallet_row_hash, message, answered_by`), `answered_by` LAST; unchanged by this wave (base run identical); re-sends: 409 `{"error":"listing N is paying, not open"}` | stable from the first re-send on | listing `paying` (reservation kept), claim `pending`; the re-sends never reach the claim because `loadPayableListing` refuses a reserved listing first, for free (`DEFERRED-PAY-LISTING-RESEND-REPLAY`, `listings.ts:851`): a pre-settlement refusal, never marked |
| (c) negative control, an unmarked plain throw (a raw D1 error on the claim read), on register, patron, listing create and listing pay | exactly `{"error":"Internal error. The society apologizes."}` with NO `answered_by`; the router's log line unchanged | yes (3 sends each) | nothing written, no facilitator call |

**Findings worth the hub's attention (none changes this wave's code).**

1. For the persistent-fault cases there is no claim for a re-send to be answered from, so each re-send asks the facilitator again and gets the same 500. That state needs a claim row that has vanished, and
   production never deletes one (`CHECKPOINT-CODE-IDENTITY-LOWS.md`, note on `x402.ts:1025`), so it is a synthetic worst case. The realistic way to reach the marked read-back is the transient shape (the
   write lands and one read finds no row), where the claim row exists and the re-sends are the claim's 502. A read that THROWS (a real D1 error) is not this error at all: it is a raw throw, unmarked (the
   residue that stays deferred), except on pay listing, whose catch turns any throw there into the same 502 `settlement_unconfirmed`.
2. The first answer to a transient read-back failure (the generic 500) differs from every later answer (the claim's 502 `settlement_unresolved`). That is existing behaviour, only now visible:
   the 500 carries no `code` and says nothing about the refusal that was written. This wave adds the identity to it and does not change what it says.
3. Pay listing's re-send after that first answer is the reservation's free 409 (no `answered_by`), as `DEFERRED-PAY-LISTING-RESEND-REPLAY` already says.

**Existing coverage of the pay-listing regression, as the commission asked me to say.** `test/settlement-replay-lease-d1.test.ts` ~:593-634 and ~:636-675 inject a refusal write that THROWS (not a read that finds no
row) and assert "not a 402, no `accepts`, reservation kept, claim state"; they do not assert the 502 body or `answered_by`. `test/refused-option-b-d1.test.ts` ~:250-315 case (b) injects a read-back that THROWS
and asserts 502 `settlement_unconfirmed` and the kept reservation, again without `answered_by` and not for a read that finds no row (the marked-Error path). So neither covers the byte-level answer; the new
listing-pay test does (exact key list and order, `answered_by` last, the message prefix, the router log empty, the claim `pending`).

### 4. P2: the exceptions stay visible in the served contract

One sentence appended to the `/api/attest` entry's description in `src/discovery.ts` (line 113), which feeds `/api/surface`, `/openapi.json` and `/llms.txt`; outside `FRONT_DOOR_TEMPLATE` (`src/doc.ts` not touched).
The v5 template-hash pins stay green (`test/code-identity-attest-d1.test.ts`, `test/guest-served-text-d1.test.ts`, `test/settlement-replay-served-text-d1.test.ts` assert `fa11788d`), which is the proof that
nothing minted. `discovery.test.ts`, `discovery-data.test.ts`, `doc.test.ts`, `x402-discovery-d1.test.ts`, `governance-constitution-d1.test.ts`, `served-recipe-fidelity-d1.test.ts` and the five served-text files all pass.

**The sentence as served** (after the code clause the description already had):

> On the paid routes `answered_by` carries the same identity on the facilitator's failure, an unknown settlement outcome, a payment settled but not recorded, a claim that could not be read back after a refusal was written, a claim whose recorded treasury row is missing, and every answer about a payment's claim. It is not on a success, on the x402 402 challenges issued where no claim exists, on the society's own refusals made before a claim is taken, or on any other internal failure.

**DIFFERENT FROM THE COMMISSION'S PROPOSED WORDING, and why.** The commission's sentence ended "the x402 402 challenges, refusals before any payment is settled, and any other internal failure do not". Read against the
code after this wave, two parts of that are false, so I corrected them (the commission allows the seats' correction; "it must be true of the code"):

1. "the x402 402 challenges ... do not": an `expired` claim, and a pre-option-B `refused` claim, are answered as a **402 with `accepts`** that DOES carry `answered_by` (`claimResponse` adds it to every claim
   answer; `test/code-identity-answers-d1.test.ts:96-128` asserts "and a 402 with accepts"). The challenges that do not carry it are the ones issued where **no claim exists** (the first 402 with no header, and the
   402 for a `/verify` refusal), so the sentence says that.
2. "refusals before any payment is settled ... do not": `settlement_claim_unavailable` (503, "nothing was sent to the facilitator's /settle"; `test/code-identity-answers-d1.test.ts:368-398`) and
   `settlement_claim_conflict` are refusals made before anything is settled and DO carry `answered_by`. The refusals that do not are the society's own refusals made **before a claim is taken** (validators,
   throttles, a handle already taken, a listing no longer open: the `afterVerify` hooks run before the claim is taken), so the sentence says that.
3. "a success" is added to the exclusions: a 200/201 success is not a claim answer and carries nothing (`test/code-identity-answers-d1.test.ts:218-226`); the proposed wording's opening ("Answers on the paid
   routes carry the same identity when ...") would have read as covering it.
4. The inclusion list ends with "every answer about a payment's claim", which is what the router and `claimResponse` already do for every claim answer (the replays, the unresolved, the contradiction, the
   conflict, the already-booked); the proposed wording left them to be inferred from the exclusions.

**Tests** (`test/plain-error-money-d1.test.ts`, P2): the sentence, written out in the test (not imported), is served verbatim after the code clause on `/llms.txt`, `/api/surface` and `/openapi.json`; and the
exclusions it names are exercised live through the router (an unpaid patron request is the 402 challenge with `accepts` and no `answered_by`; a register request with a payment header and an invalid handle is a
400 with none; neither reaches the facilitator). The inclusions are pinned by the marked-site tests (`code-identity-lows-d1.test.ts`, `code-identity-answers-d1.test.ts`) and this wave's P3 tests; the raw
D1 failure is P3 (c).

### 5. Comments

Comment-only in `src/` (the test is the flag pin):

- `src/x402.ts` (the refusal read-back in `payAndSettle`): the `DEFERRED-PLAIN-ERROR-MONEY-ANSWERS` block is rewritten. It now says what is MARKED (these two plain Errors, why they stay plain: the router logs a plain Error
  and not a SocietyError, and `register-gate.ts:478` logs `String(e)` for one; where the mark is dropped, harmlessly; that a catch which wraps either in a NEW error drops the mark), keeps errant-hermes's credit
  (1f916 97465) and records both of her points (served-contract visibility in `discovery.ts`; read-back tests with stability), and keeps the flag name for what is STILL deferred: every other plain throw on these paths, a raw
  D1 or runtime error, stays the generic 500 with no `answered_by`, with the reason (marking a catch-all would put the identity on a stranger's free failure) and the un-defer trigger.
- `src/x402.ts` (`ledgerReceipt`): a two-line note on the marked throw and its callers.
- `src/index.ts`: the SocietyError branch's contract comment gains a line naming the plain-Error path; the new plain-Error comment sits at the branch itself (added with P1).
- `src/society.ts`: `SocietyError.moneyAnswer`'s comment points at `markMoneyAnswer`.
- `test/plain-error-money-d1.test.ts`: one test pins that the flag is still planted once, beside the read-back, names the raw-throw residue and credits errant-hermes (flag-deferred-items).

### 6. The close

**Suite.** `npm test`: 1974 tests, 1973 pass, 0 fail, 1 skipped (the same pre-existing skip as the base: 1958 / 1957 / 1); +16 tests (`plain-error-money-d1.test.ts` 8, `plain-error-money-routes-d1.test.ts` 8).
`npm run typecheck` silent. The tree is clean. Every red-proof below was run with `scratch/plain-error-money-builder/redproof.sh` (applies a sed mutation, proves it changed the file, runs the tests, restores the file
from HEAD, checks the restore).

**Red-proofs (one line each; mutation -> what went red).**

1. `markMoneyAnswer` `enumerable: false` -> `true`: the P1 mark test (descriptor, `Object.keys`, `JSON.stringify`).
2. `markMoneyAnswer` `writable: false` -> `true`: the same P1 test.
3. `carriesMoneyMark` without `instanceof Error`: the P1 `carriesMoneyMark` test and the P1 router test (a bare `{ moneyAnswer: true }` would be served `answered_by`).
4. `carriesMoneyMark` always false: 9 red (the P1 mark and router tests, every P3 (a) and (b) generic-500 case, including the transient case's first answer).
5. `carriesMoneyMark` true for every Error: 4 red (P1 router, P1 `carriesMoneyMark`, P1 mark, P3 (c) negative control).
6. Router: `answered_by` first instead of last: 7 red (P1 router and every P3 generic-500 case).
7. Router: the log line gains a field: 9 red (P1 router tests, P3 (a), (b), (c)).
8. Router: the generic text "apologizes" -> "apologises": 9 red.
9. Router: status 503 for a marked error: 7 red.
10. Router: the SocietyError branch stops reading its mark (`answersMoney = false`): 15 red (the I1 marked-site tests in `code-identity-lows-d1.test.ts`) and the P1 SocietyError-branch test.
11. `x402.ts` read-back mark removed: the P1 sweep and every P3 (b) generic-500 case (the pay-listing regression stays green, as it should).
12. `ledgerReceipt` mark removed: the P1 sweep and both P3 (a) cases.
13. `ledgerReceipt` message edited: the P1 sweep and both P3 (a) cases (the router log line).
14. `x402.ts` read-back converted to `new SocietyError(500, ..., true)` (the rejected design): 6 red (the router no longer logs; the pay-listing catch no longer sees a plain throw; the sweep).
15. `discovery.ts`: one word of the served sentence changed: the P2 served-sentence test.
16. `discovery.ts`: the sentence removed: the P2 test.
17. Router: every SocietyError carries the identity: the P2 truth test (a free refusal grows `answered_by`) and the P1 unmarked-SocietyError case.
18. `x402.ts` line 533: the no-claim 402 challenge gains `answered_by`: the P2 truth test.
19. `x402.ts` flag: "still deferred" reworded; and the flag renamed: the flag pin (both).
20. `x402.ts` replay path no longer releases its lease: both P3 (a) cases (a re-send then meets the lease).
21. `listings.ts:960` the pay-listing 502 loses `answered_by`: the P3 (b) pay-listing regression.
22. `listings.ts` the pay-listing catch re-opens the listing after the unconfirmed 502: the same regression test (reservation kept).
23. Fixtures, so they cannot pass vacuously: the vanish trigger made inert (3 red: register, patron, listing create persistent cases); the treasury row not deleted (2 red: P3 (a)); the null read never armed (2 red:
    transient register, pay-listing regression); the control's injected throw removed (1 red: P3 (c)).

**Decision-invariance table** (base `fcba887b` vs this branch, from `PEM_RECORD` runs of `plain-error-money-routes-d1.test.ts` against each source; `scratch/plain-error-money-builder/compare-records.mjs`, 35 recorded
scenarios, 0 differences in status, `error`, `code`, `message`, the router log line or the log event names; the only difference is the `answered_by` key where marked). The non-comment source change is exactly:
`index.ts` (the generic 500 builds its body once and adds `answered_by` when marked), `society.ts` (the two helpers), `x402.ts` (the import and the two `markMoneyAnswer(...)` wrappers), `discovery.ts` (one
sentence). No claim write, lease, reconciler selection, `catch`, branch or migration is touched (`git diff fcba887b..HEAD -- src`, comment lines aside).

| answer | status before -> after | `error` text | `code` | router log line | `answered_by` |
|---|---|---|---|---|---|
| register / listing create re-send, the claim's treasury row missing | 500 -> 500 | generic -> same | none -> none | `...,"message":"Error: ledger row N recorded in the claim does not exist"` -> identical | absent -> added LAST |
| register / patron / listing create, claim unreadable after a refusal write | 500 -> 500 | generic -> same | none -> none | `...,"message":"Error: the settlement claim could not be read back after its refusal write; the outcome is unknown"` -> identical | absent -> added LAST |
| register, transient fault, first answer | 500 -> 500 | same | none | same line | absent -> added LAST |
| register, transient fault, the re-sends | 502 -> 502 | `settlement_unresolved` text, unchanged | `settlement_unresolved` | none (a Response) | present -> present |
| listing pay, claim unreadable after a refusal write | 502 -> 502 | `settlement_unconfirmed`, keys and order unchanged | n/a (`error` is the code) | none | present -> present |
| listing pay, the re-send | 409 -> 409 | `listing N is paying, not open` | none | none | absent -> absent |
| an UNMARKED plain throw on register, patron, listing create, listing pay | 500 -> 500 | generic -> same | none | `...,"message":"Error: D1_ERROR: injected unmarked plain failure"` -> identical | absent -> absent |
| the first request of the (a) cases (a marked SocietyError: registration / listing save failed) | 500 -> 500 | unchanged | none | none | present -> present |
| the x402 402 challenge where no claim exists; a society refusal before a claim is taken | 402 / 400 | unchanged | unchanged | unchanged | absent -> absent (P2 truth test, live) |

**Checklist walk (commission, order of work).** 1 checkpoint started: done. 2 P1 + unit tests: done (mark invisible, router marked vs unmarked, log line byte-identical). 3 P3 tests: done. 4 P2 + tests: done, with
the corrected sentence (note 4). 5 comments: done. 6 red-proofs: done, above. 7 full suite and typecheck green, tree clean, decision-invariance table: done. Nothing pushed, deployed, migrated, networked; no
`*.local.*` file read; no sub-agent; `src/doc.ts`, `schema.sql`, `migrations/`, `scripts/deploy-code-identity.ps1` untouched.

**Done differently from the commission, or beyond it.**

1. **The served sentence is not the hub's wording** (note 4): two of its exclusions are false against the code (an expired or pre-B refused claim is a 402 with `accepts` that carries `answered_by`;
   `settlement_claim_unavailable` and `settlement_claim_conflict` are refusals made before anything settles and carry it), so the exclusions are stated by mechanism (no claim exists; before a claim is taken),
   and "a success" is named.
2. `carriesMoneyMark` requires `e instanceof Error` (the commission did not say): a bare object that merely has the property is not marked.
3. The pay-listing regression asserts re-sends are the reservation's free 409 (not an answer from the claim): `loadPayableListing` refuses a reserved listing before the claim consult
   (`DEFERRED-PAY-LISTING-RESEND-REPLAY`, `listings.ts:851`). Recorded, not changed.
4. P3 (b) is exercised two ways: a persistent fault (a trigger deletes the claim after the refusal write) on register, patron and listing create, and a transient one (the write lands, one read finds
   nothing) on register and listing pay. The commission asked for the first; the second is the realistic shape and shows the first answer is not stable into the second (500, then the claim's 502).
5. An empty `python3 -` heredoc was started by mistake early in the session (no code in it, killed, nothing written); no interpreter heredoc was run after that.

**Points for the hub (not acted on).**

- The persistent-fault (b) case makes every re-send a fresh claim, `/verify` and `/settle`; production never deletes a claim row, so it is synthetic. The transient case is the realistic one and its re-sends are answered
  from the pending claim.
- A raw D1 throw at `getClaim` itself (`x402.ts`, the line before the marked throw), or anywhere else on these paths, is still the unmarked generic 500: the residue under `DEFERRED-PLAIN-ERROR-MONEY-ANSWERS`.
- Suggested DECISIONS entry: plain Errors on the paid path carry the mark rather than being converted to SocietyErrors, because the router logs a plain Error and `register-gate.ts:478` logs `String(e)` for one.
- Suggested LESSONS candidate: a hub-drafted served sentence passed two exchange seats and was still false twice against the code; the builder re-derived each clause from the source (findings-are-evidence).
  skill that should have prevented this: findings-are-evidence / none - new candidate. class: a served sentence's exclusions must be re-derived against every code path that builds a response, not against the categories the brief names.
