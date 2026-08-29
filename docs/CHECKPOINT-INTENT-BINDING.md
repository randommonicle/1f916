# Checkpoint — intent binding for the irreversible writes (D-056)

Work unit opened 2026-08-29, small hours. Architect session, Ben asleep after ruling.
Root DECISIONS.md D-056 is the governing ruling; this file is the live build log
(checkpoint-log discipline). The wave this extends is Addendum 38's public-key wave,
six commits ahead of origin at `c3e99bc`, nothing deployed, migration 0012 not applied.

## Ben's same-night approvals (per-action, this session only)

1. Binding scope: irreversible writes only (D-056).
2. Migration-0012 rehearsal may run unattended: read-only prod DDL export, scratch D1
   `commonhold-migtest` recreated and rehearsed against. No prod writes, no deploy, no push.
3. The D-018 Opus gate may be spent tonight, after build + red proofs.
4. Antigravity watcher left running: exchange/ pre-gate before the Opus gate.

Not approved and not happening tonight: push, deploy, prod migration, secret writes, cron
changes, any outward send.

## Plan (stated before code)

**New dependency count: zero.**

Files to change:
- `src/keyauth.ts` — intent vocabulary: `INTENT_OPS`, `buildIntentBinding(op, parts)`
  (length-prefixed encoding + sha256hex, `"<op>:<hex>"`), `stableStringify` for the one
  structured argument (proposal payload); parser prose at :139-147 aligned to the enforced
  boundary.
- `src/society.ts` — `requireSignedIntent(credential, op, parts)` beside
  `credentialBinding`; `moderateContent` + `recordLedger` take a REQUIRED
  `credential: string | null` and check intent; the served `authenticate_with` string
  (:681) corrected — it still teaches an `{h,t,n}` payload while the parser requires
  `aud` (found this session; a citizen following it verbatim is refused).
- `src/governance.ts` — `castBallot` + `createProposal` take required credential + check.
- `src/wallets.ts` — `declareWallet` likewise.
- `src/payouts.ts` — `recordPayout` likewise.
- `src/index.ts` — the six routes pass `bearer(request)` through.
- `src/mcp.ts` — `ballot`/`propose`/`moderate` pass `secret` through; tool descriptions
  and the shared `secret` field text name the binding requirement.
- `src/discovery.ts` — the six surface entries name signed intent for key citizens.
- `src/maintainer/judgment.ts` — its two `moderateContent` calls pass `null`
  (server-internal, no transport credential; exempt by design, D-056 ruling 3).

Tests (all real crypto, real local D1, no mocks; every new check red-proofed):
- `test/keyauth.test.ts` — builder unit tests: encoding injectivity (`["a,1:b"]` vs
  `["a","b"]` must differ), op prefix always contains `:` so no binding is ever a valid
  base64url key (cross-shape disjointness with rotate's bare-key binding, both directions).
- `test/intent-binding-d1.test.ts` (new) — per-op D1 proofs: unbound assertion refused
  with no side effect; binding for op A replayed into op B refused; same op with one
  argument changed refused (CODEX's swapped-`choice` case); correct binding succeeds;
  bearer citizens pass all six unchanged; rotate's bare-key `b` into ballot refused and
  a ballot binding into rotate refused; nonce burned on refusal (pins D-056 ruling 5);
  MCP transport parity for ballot (same handler, same refusal).
- Existing test call sites of the six handlers gain the explicit credential argument
  (typecheck enforces completeness — that is the point of the required parameter).

Commit plan:
1. `feat(keyauth): intent vocabulary` — keyauth.ts additions + unit tests + this file.
2. `feat(auth): six irreversible writes require signed intent from key citizens` —
   handlers, wiring, D1 red proofs, judgment.ts nulls, prose alignment.
3. `fix(served): assertion how-to catches up with the parser (aud), and the intent
   boundary is served` — society.ts:681, discovery.ts, mcp.ts descriptions.

Out of scope (flagged, not silent): binding the social writes (post/comment/vote/flag/
pin/model) — later design wave per D-056 ruling 6, grep-flag DEFERRED-INTENT-1 at the
boundary comment in keyauth.ts; listings/submissions economy writes — same flag;
docs/DESIGN-SIGNED-BALLOTS.md stays an independent draft; constitution v4 wording — Ben's
morning decision, drafted separately, never committed by this session.

## Progress log

- (opened) Plan above; baseline 1001/1001 + typecheck clean at `c3e99bc` before any edit.
- (commit 1) keyauth vocabulary: `INTENT_OPS`, `encodeIntentParts` (length-prefixed,
  injective), `buildIntentBinding` (`"<op>:<sha256hex>"`), `stableStringify`; parser prose
  aligned to the enforced boundary; 4 unit tests including the one-part-that-looks-like-two
  collision and rotate cross-shape disjointness. 20/20 in keyauth.test.ts.
- (commit 2) Enforcement: `requireSignedIntent` in society.ts; required credential param on
  all six handlers; index.ts six routes + mcp.ts three tools pass the credential through;
  judgment.ts's two server-side moderation calls pass null (the exemption, D-056 ruling 3).
  **Red-proof recorded: test/intent-binding-d1.test.ts was written first and run against
  the unbound handlers — 9/10 failed (each refusal test saw the write succeed); after
  enforcement, 10/10.** Two fixture corrections during the red→green walk were fixture
  bugs, not enforcement bugs (set_name's founder gate; the one-open-proposal cap needed a
  second citizen). Full suite 1015/1015 (was 1001), typecheck clean. Deviation from plan:
  none in mechanism; refusal status chosen as 403 where rotate's earlier binding refusal
  used 400 — deliberate (custody proven, authority insufficient), noted for reviewers.
- (commit 3) Served text catches the parser. The aud-drift was on TWO surfaces, not one:
  `authenticate_with` (society.ts) and the `citizen_secret` definition in discovery's
  AUTH_LABEL both still taught an {h,t,n} payload after the parser began requiring aud —
  a citizen following our own instructions verbatim was refused, and no test could see
  it. Both corrected; the six bound routes' surface notes carry their argument lists;
  the three MCP write tools' descriptions name their recipes. NEW GUARD: discovery.test.ts
  pins /llms.txt's recipe (aud + REQUIRED) and every INTENT_OPS note on /api/surface —
  red-proofed live twice (a broken ledger note failed it; so did pointing it at a surface
  that does not serve the definition, which is itself how the definition's real home,
  AUTH_LABEL via /llms.txt, was found). 1016/1016, typecheck clean.
