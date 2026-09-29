# Brief: x402 settle honesty and PayAI discovery (wave B), 2026-09-28

Hub-written (HANDOVER.md Addendum 74). Branch `x402-settle-honesty-2026-09-28`, worktree
`scratch/wt-x402-honesty`, from `origin/main` = `04d51c17`. MONEY PATH: the D-018 Opus gate reviews
it before any deploy, and a HIGH stops the deploy. Ben chose "PayAI discovery metadata" for this
session on the condition that the recon's PayAI claims were re-derived first; re-deriving them found
the defect in F1, which is the reason this wave exists. No migration; non-minting (nothing in
`src/doc.ts` changes).

## Findings (re-derived by the hub at the primary sources, 2026-09-28)

**F1 (money path; pre-existing; class L-089).** PayAI documents that `POST /settle` waits at most
100 seconds for the on-chain outcome and then answers **HTTP 200** with
`{"success": false, "errorReason": "settlement_pending", "transaction": ...}`, and says of it: "It
is **not a verdict**. The settlement job keeps running after the response is sent -- the payment
may still land on-chain. Do not treat `settlement_pending` as a failure, and do not treat it as a
success." On EVM (Base) `transaction` carries the broadcast hash when the transaction was already
broadcast (https://docs.payai.network/x402/facilitators/capacity-and-limits.md, "The
settlement_pending response"). Our shared core treats every `success !== true` as a refusal
(`src/x402.ts:223-231`; its own comment at `:212` says "An explicit `success: false` is still a
refusal"). Consequences today, if a settlement is slow:
- registration, patronage and listing creation answer 402 with `error: "settlement_pending"`,
  inviting a second signed payment while the first may still land: a dollar taken with no seat,
  no ledger line, no listing;
- the listing pay route releases its reservation (`src/listings.ts:800-810`, "A refused settle is
  an ANSWER"), so a second payment can be reserved and settled: the funder pays twice;
- the operator's pay script sees a non-200, asks the chain at once, finds the nonce not yet
  executed and writes a `refused` tombstone (`scripts/pay-listing.mjs:622-633`), a label the
  landing transfer then falsifies. (A 502 `settlement_unconfirmed` is already recognised first,
  `:607-616`, which is the path this wave moves `settlement_pending` onto.)
L-089 (24 Sept) closed the case of an answer with no boolean `success`; this is a well-formed
answer that is not a verdict.

**F2 (money path).** The same page's table ("Read the status and response body together"): 409
`duplicate_settlement` means "the same operation is already in flight or has a replay marker";
"5xx, transport timeout, or lost response: the outcome may be unknown"; 400/401/403 are "invalid
input, missing/invalid credentials, or a policy refusal"; "200 with `success: false`: inspect
`errorReason`: it may be pending or a recorded failure". `facilitator()` (`src/x402.ts:70-97`)
keeps no HTTP status once a body parses, so a JSON 409 or 5xx carrying `success: false` is read as
a refusal too.

**F3 (honesty, no money moves).** A non-2xx JSON answer to `/verify` has no `isValid: true`, so it
is served as 402 "payment invalid" (`src/x402.ts:183-191`), which misstates the cause when the
facilitator refused service or failed. PayAI's pricing page (Free Credits,
https://docs.payai.network/x402/facilitators/pricing.md): free credits are counted per receiving
wallet, 1,000 for life by default ("Some older receiving wallets retain a legacy allowance of
10,000 credits"; "Settlements made before 21 September 2026 count as 1 credit each"; a Base
settlement costs about 2.31 credits after that), and "Requests from shared hosts or IP addresses
(e.g. shared cloud platforms) also draw from a shared pool, so those deployments may reach the
limit sooner". This Worker runs on a shared platform. **What PayAI answers when the allowance is
spent is documented on none of its 37 pages** (llms.txt index, all fetched 2026-09-28); the
recon's "403 `free_tier_exhausted`" has no primary source. So nothing below keys on a guessed
reason string: the fix names the facilitator's own HTTP status and reason.

**F4 (discovery).** We are not in PayAI's catalogue because our requirements carry no declaration.
PayAI (https://docs.payai.network/x402/facilitators/bazaar.md): "x402 v1 servers declare through
`outputSchema.input` on the payment requirements themselves (with `type` and `method` required)";
a verify-only first listing of a POST resource "is deferred with `resource_needs_settlement` until
its first settled payment", so the next organic registration lists us; "A `404`/`405` from a
`POST` ... resource is inconclusive and changes nothing" (our GET on `/api/register` is 404); "A
rejected or missing declaration never affects the payment itself". A live v1 Base entry is listed
with nothing more than `{"input":{"type":"http","method":"POST","discoverable":true},"output":null}`
(recon, channel 4).

## B1. `facilitator()` keeps the HTTP status

It returns `{ status: number; body: Record<string, unknown> }` for a parsed JSON object. The
unreadable-body behaviour is unchanged (the path-aware 502s at `:93-96`).

## B2. Classifying the `/settle` answer

In this order, first match wins. "Unknown" means the existing unknown-outcome path: throw the
`SocietyError(502, ...)`, logged as `x402_settle_outcome_unknown` (`:219-221`), so
`handlePayListing` keeps its reservation and answers `settlement_unconfirmed`
(`src/listings.ts:771-799`) and every other caller answers 502.

1. HTTP status 500-599, any body: unknown.
2. HTTP 409, any body: unknown (`duplicate_settlement`: in flight or replayed).
3. No boolean `success`: unknown (unchanged, L-089).
4. `success: true`: settled if the status is 2xx; any other status with `success: true` is unknown.
5. `success: false` and `errorReason === "settlement_pending"`: unknown. When `transaction` is a
   non-empty string, the log line carries it as `broadcast_tx` and the 502 message names it.
6. `success: false` with `errorReason` absent, blank (empty or whitespace only after trimming) or not a string: unknown (not classifiable). (Amended after build review round 1: the brief said "empty"; a whitespace-only reason records no failure either.)
7. A refusal ONLY in the two combinations PayAI documents as definitive (amended after CODEX round
   1, exchange `REVIEW_x402-settle-honesty-brief-2026-09-28.md`): HTTP **200** with
   `success: false` and a non-blank string `errorReason` other than `settlement_pending` ("a
   recorded failure"); or HTTP **400, 401 or 403** with `success: false` and a non-blank string
   `errorReason` ("invalid input, missing/invalid credentials, or a policy refusal"). It stays a
   refusal (the pay route releases its own reservation as today), and the 402 body's `error` names
   the facilitator's status and reason instead of the bare reason.
8. Anything else is unknown: every other 4xx (404, 408, 410, 422, 429 ...), every 2xx other than
   200, any 1xx or 3xx final status. A synthetic `408 {"success": false, "errorReason":
   "upstream_timeout"}` must keep the reservation: nothing documents it as a definitive refusal.

The 502 message for rule 5 (hub words): `The facilitator has not yet settled this payment
(settlement_pending): it may still land on-chain.${tx ? ` It reports the broadcast transaction
${tx}.` : ""} Whether the money moved is unknown until the chain is checked; do not sign again.`

The 402 `error` for rule 7 (hub words): `The facilitator reports that this settlement failed (HTTP
${status}, reason: ${reason}). By its account no money moved.` (reason clipped to 200 characters).

Update the comment at `:196-212` to state the new rules and cite PayAI's page; update the comment
at `src/listings.ts:800-807` ("A refused settle is an ANSWER") to "a recorded failure is an
answer; a pending or unreadable one is not (x402.ts)". The `settlement_unconfirmed` message at
`src/listings.ts:795` says "no settlement result was read"; with rule 5 a result WAS read and was
not a verdict: change "and no settlement result was read (${reason})" to "and no settlement
verdict was returned (${reason})". Make the matching one-phrase change in
`scripts/pay-listing.mjs:616` ("could not read the facilitator's answer" becomes "did not receive
a settlement verdict from the facilitator") and its test. (Amended after build review round 1: neither
sentence now opens with a delivery claim. A `/settle` request that fails in transit may never have
left, so the route says "No settlement verdict was returned for the settle request (${reason})" and
the script "The server did not receive a settlement verdict from the facilitator (HTTP ...)".)

**B2b. The operator's registration script (CODEX round 1, finding 2; pre-existing).** When the
signed POST's `fetch` rejects, `scripts/register-maintainer.mjs:402-406` prints "The facilitator
was never reached with this signature. It is safe to just run this script again." A request can
be delivered, verified and settled and its response lost, so that is false, and a re-run can pay a
second dollar if the first registration did not complete. The two other registration scripts refuse a blind re-run but send the payer to the wrong check
(amended after CODEX round 2): `scripts/lobby-sponsor.mjs:313-314` says "Check GET /treasury and
GET /api/citizens for this handle before any re-run" and `scripts/keyauth-ride.mjs:361` says
"re-run only if no keyholder citizen and no new registration payment appear". Neither proves
anything: an unknown settle outcome throws before the ledger insert and before registration
(`src/register-gate.ts:168-184`), so both records are empty while the payment is pending or has
landed. (`post-listing.mjs` and `pay-listing.mjs` already keep a tombstone and reconcile on-chain;
leave them.)

In all three registration scripts (`register-maintainer.mjs`, `lobby-sponsor.mjs`,
`keyauth-ride.mjs`), on a rejected signed `fetch` AND on any second-leg answer that is not a
verdict (amended after build review round 1: every 5xx, every status other than the expected 201
that is not a 4xx, and a body that cannot be read; a 4xx stays a refusal), print the signed authorisation's `from`, `nonce` and `validBefore`, and
this warning (hub words):

`Outcome unknown: the payment may have settled. Do not sign again until the original authorisation's outcome has been reconciled on-chain: after validBefore, EIP-3009 authorizationState(from, nonce) on Base USDC reads true if it was executed. Missing treasury or citizen records do not prove that no payment occurred.`

Use one shared helper if the scripts already share a module (`lobby-sponsor.mjs` and
`keyauth-ride.mjs` import from `register-maintainer.mjs`); otherwise identical text. Tests: a
rejected second `fetch`, a second-leg 5xx and an unreadable second-leg body each print the warning and the three identifiers, and
never "safe to"; a test that asserted only the absence of "safe to" would pass with the warning
deleted, so assert the warning itself.

## B3. Classifying the `/verify` answer

1. Body not a JSON object: unchanged (502, "Your money was not taken").
2. 2xx and `isValid === true`: proceed.
3. 2xx and not valid: unchanged (402 with `invalidReason`, fallback "payment invalid").
4. 4xx: 402 whose `error` is (hub words) `The payment facilitator refused to verify this payment
   (HTTP ${status}, reason: ${reason}). No money moved: nothing that could settle was sent.`
5. 5xx: `SocietyError(502, ...)` with (hub words) `The payment facilitator failed to verify this
   payment (HTTP ${status}, reason: ${reason}). No money moved: nothing that could settle was
   sent. Try again later.`
`reason` is the first string among `invalidReason`, `errorReason`, `error`, `message`, clipped to
200 characters, else `"none given"`. `/settle` is never called after rules 1, 3, 4 or 5.

## B4. The PayAI discovery declaration (register only)

`PaymentRequirements` gains an optional `outputSchema?: Record<string, unknown>`;
`buildPaymentRequirements` takes an optional `outputSchema` and includes the key ONLY when given,
so the patron, listing-create and listing-pay requirements stay byte-identical (existing tests and
the operator's pay scripts depend on that). Only `src/register-gate.ts:154` passes it:

```json
{
  "input": {
    "type": "http",
    "method": "POST",
    "discoverable": true,
    "bodyType": "json",
    "bodyFields": {
      "handle": { "type": "string", "required": true, "description": "2-32 characters: ASCII letters, digits, _ or -, and not already taken" },
      "model": { "type": "string", "required": true, "description": "your self-declared model: not blank, at most 64 characters (UTF-16 code units)" },
      "public_key": { "type": "string", "required": false, "description": "optional base64url raw Ed25519 public key, 32 bytes; when sent, the 201 returns no secret" }
    }
  },
  "output": null
}
```

The two descriptions restate `assertValidHandle` (`src/society.ts:469-473`) and `assertValidModel`
(`:483-487`); if either rule differs from its description, stop and report. `output` is `null`
deliberately: an example body could drift from the served 201.

## B5. Deferred markers (comments, no behaviour)

- `DEFERRED-LANDED-PAYMENT-NO-SEAT`, at the register gate where an unknown settle outcome
  propagates: when a registration's outcome is unknown and the money later lands, the payer has
  paid with no seat and no route completes the registration from the landed payment; the operator
  sees `x402_settle_outcome_unknown` in the log and a gap between the treasury's booked and
  on-chain totals. Pre-existing on the unreadable-body path. Ben's decision.
- `DEFERRED-PAYAI-ALLOWANCE`, beside `FACILITATOR_URL` handling in `src/x402.ts`: the treasury's
  free allowance (1,000 or a legacy 10,000 credits, drawn also from a shared pool for shared
  hosts) cannot be read from outside; topping up at merchant.payai.network is Ben's hand; after it
  is spent, verify or settle refusals are now named honestly (B2 rule 7, B3 rule 4).

## B6. Tests and red-proofs

Through the routes, with the repo's `globalThis.fetch` facilitator stubs
(`test/wallet-pin-route-d1.test.ts:50-72` is the pattern):
- Pay route, each unknown case (200 `settlement_pending` with and without `transaction`; 409
  `{"success": false, "errorReason": "duplicate_settlement"}` -- the stub MUST carry
  `success: false`, or the existing no-boolean rule answers 502 and masks rule 2 (GEMINI round 1);
  500 `{"success": false, "errorReason": "x"}`; 200 `{"success": false}`; 403
  `{"success": true}`; 408 `{"success": false, "errorReason": "upstream_timeout"}`; 429
  `{"success": false, "errorReason": "rate_limited"}`; 202 `{"success": false, "errorReason":
  "x"}`): 502 `settlement_unconfirmed`, the listing still `paying` with its pinned pair, no
  payment row, and a retry never reaches `/settle` again. The pending-with-tx case: the message
  names the tx.
- Pay route, recorded failure (200 `insufficient_funds`, existing; add 403 and 400
  `{"success": false, "errorReason": "policy"}`): released, 402 naming the status and reason.
- Register route: 200 `settlement_pending` answers 502 and creates no citizen and no ledger row;
  200 `insufficient_funds` answers 402 and creates nothing.
- Verify: 403 JSON answers 402 naming 403 and the reason; 503 JSON answers 502; neither calls
  `/settle`; 200 `{"isValid": false, "invalidReason": "x"}` unchanged.
- Discovery: the register 402's `accepts[0].outputSchema` deep-equals the object above; the patron
  and listing 402s carry no `outputSchema` key; `scripts/register-maintainer.mjs`'s exported
  `validatePaymentRequirements` accepts the new register requirements.
Red-proof every new test by breaking the rule it guards (for example, delete rule 5; let 409 fall
through; drop the `outputSchema` guard) and see its own assertion fail, not an exception (L-096).
Restore byte-exact.

## B7. The deploy script (last commit; written and parsed, never run)

`scripts/deploy-x402-settle-honesty.ps1`, modelled on `scripts/deploy-heartbeat-inbox.ps1` (its
`-DryRun`, main-level-with-origin check, test run, propagation poll, `--max-time`, status-reading
helpers). Worker-only. Ride: `POST /api/register` with body
`{"handle":"ride-probe-<yyyymmddHHmm>","model":"ride-probe"}` and no payment answers 402 whose
`accepts[0].outputSchema.input.discoverable` is `true` (nothing is written before a 402:
`register()` and its `reg_log` insert run only after settlement); `POST /api/patron` with no payment
answers 402 with no `outputSchema`; attest v5 `fa11788d` and all four chains verified. It must say
in its output that the settle and verify classifications cannot be ridden without a real payment:
the tests prove them, and the next real payment's log line is their first ride.

## Process

As in any wave here: `git -C "<worktree>"` only; never touch the main checkout; no push, no
deploy, no remote `wrangler`; small commits with tests; `docs/CHECKPOINT-X402-SETTLE-HONESTY.md`
updated per commit with a red-proof table; counts only from output in view; stop and report
anything false in this brief.

## Out of scope (staged for Ben, not built)

- Answering 402 to a bare POST before body validation (the recon's gap 1, x402scan's probe): it
  changes the door's refuse-before-pay order. A decision for Ben.
- `/openapi.json`'s missing paid route (non-money; wave C).
- Re-POSTing the payload to reconcile a pending settlement inside the request (PayAI: normally a
  409 while the first attempt is in flight, so it adds nothing).
- Enumerating refusal reason STRINGS: rule 7 keys on the two status-and-shape combinations PayAI
  documents, never on a list of reason names. Also out: x402 v2; the CDP facilitator.

## F8/F9 amendment (build review round 3, CODEX)

Three rules, as built (docs/CHECKPOINT-X402-SETTLE-HONESTY.md, section "F8/F9 (build review round 3, CODEX)" has the finding, the tests and the red-proofs).

1. No inner text after payment (F8a). Registration's paid-but-failed 500 (`src/register-gate.ts`) never contains the inner error's message. It is one of two hub-worded messages, chosen by whether the request supplied a public key: with a key it says a citizen may still have been created and names GET /api/citizens (and how to page it: `has_more`, `next_since`, `next_since_id`, `?since=...&since_id=...`) as the place to check; without one it says no credential was delivered. Both say the payment settled, name the tx, say not to sign again and point at GET /treasury. The inner reason is in the `registration_paid_but_failed` log line only.
2. A created citizen's credential is never withheld (F8b, invite mode only). A failure of the `invite_redeemed` append after `register()` is logged once as `invite_redeemed_unrecorded` (the code's hash, never the code) and the caller still gets their 201. The cost, recorded for Ben: the code is not marked spent, so one more paid registration could redeem it, the same blast radius the file already accepts for the concurrent race.
