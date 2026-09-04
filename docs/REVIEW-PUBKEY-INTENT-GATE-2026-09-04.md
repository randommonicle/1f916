# D-018 gate record — public-key + intent-binding wave (RESUMED, FULL VERDICT)

Provenance: independent Opus gate agent, 2026-09-04, resuming the PARTIAL gate of
2026-08-29 (`docs/REVIEW-PUBKEY-INTENT-GATE-2026-08-29.md`). The prior agent was
stopped mid-review when the operator's usage window closed; this record picks up its §3
resume checklist and carries the wave to a full decision. Everything below was verified
first-hand against `society/` at HEAD `f705e14`; reviewer files and checkpoints were read
as evidence and re-derived, never taken as findings.

**VERDICT: DEPLOYABLE**, subject to the deploy-order runbook (§4), one operator governance
decision that is already on Ben's queue (constitution v4 / DEFERRED-PUBKEY-4, §3.7), and
the post-deploy one-real-ride the design already mandates. No HIGH or MEDIUM code defect
found. Details below.

---

## 1. Baseline I verified

- `git -C society log --oneline origin/main..HEAD` = **15 commits**, oldest `46aed5b`,
  HEAD **`f705e14`**. The six commits added since the prior gate are the F-1..F-5 fixes
  (`2d290e7`, `7835e95`), the served-recipe fidelity test (`f4a9401`), the gate record and
  checkpoint (`6b3c0b6`, `5e2512f`), and a showhome comment fix (`f705e14`).
- `git -C society status -sb` = `## main...origin/main [ahead 15]`, **tree clean**.
- `npm test` = **tests 1022, pass 1022, fail 0**, exit 0.
- `npm run typecheck` = clean, `tsc` emitted nothing, exit 0.
- Re-verified clean at the end after all red-proofs: 1022/1022, typecheck exit 0, tree
  clean, HEAD still `f705e14`. Every mutation I made was reverted with `git checkout --`.

The required-`credential` parameter on the six bound handlers is enforced by typecheck: a
missed caller cannot compile. Typecheck being clean is therefore itself evidence that
every call site passes the credential.

## 2. Prior findings F-1..F-7 — status

- **F-1 (canonical base64url) — FIXED** (`2d290e7`). `checkPublicKeyShape` now re-encodes
  the decoded bytes and rejects any non-canonical spelling (`keyauth.ts:124`). Red-proofed
  (RP-6 below).
- **F-2 (/llms.txt taught secret-only) — FIXED** (`7835e95`), with one LOW residual I
  found (G-1, §3.7). The write heading, the authenticate instruction, the Authorization
  example and the AUTH_LABEL now name both credential kinds.
- **F-3 (/api/rotate surface entry false, no note) — FIXED** (`7835e95`,
  `discovery.ts:122`): description now covers both citizen kinds and carries a `note`
  naming rotate's bare-key binding.
- **F-4 (overclaim "and none exists") — FIXED**: AUTH_LABEL now reads "one was generated
  to satisfy a NOT NULL column, never returned and never retained."
- **F-5 (nonce recipe didn't require unpredictability) — FIXED**: AUTH_LABEL now says
  "16-64 UNPREDICTABLE base64url characters -- 16 random bytes is the reference."
- **F-6 (`stableStringify(-0) === "0"`) — OPEN as a note, non-exploitable (re-confirmed).**
  I re-derived it: for a bound op to be exploitable via -0/0 there must be two argument
  values that share one binding but produce different effects. For proposal payloads,
  `-0` and `0` both stableStringify to `0` AND validate to the same number, so same binding
  ⟹ same effect. For ledger/payout amounts, `-0` and `0` both fail the nonzero check. No
  gap. Note only.
- **F-7 (/api/rotate now rejects previously-ignored bodies) — BY DESIGN, tested.**
  `optionalBody()` (`index.ts:101`, used at `:360`) treats an absent body as `{}` so every
  bearer citizen's no-body rotate keeps working; a malformed non-empty body is a 400. The
  test "a bearer citizen's rotation is unchanged" covers it. Not a defect.

## 3. The §3 resume checklist

### 3.1 The served-recipe fidelity test (§3 item 1) — BUILT, and it is strong

`git show f4a9401 --stat` confirms it landed after the pause:
`test/served-recipe-fidelity-d1.test.ts` (240 lines). It is the best test in the wave. It
imports NONE of the credential builders (`keyauth.ts`) and re-implements base64url, the
payload segment, and the intent binding from the served words alone, then registers a key
citizen and authenticates + performs a bound write against a real local D1. It even
discovers the audience the way a real outside agent must — by being refused once and
reading the expected value out of the refusal. It caught the lowercase-hex gap the recipe
was silent about (now pinned as the "uppercase hex is refused" trap). Red-proofed (RP-4
and RP-7 below both drive it red).

### 3.2 The two exchange review files — read

`exchange/REVIEW_public-key-registration_2026-08-28.md` (three rounds; CODEX found the
account-takeover, killed two overclaims, forced key publication) and
`exchange/REVIEW_intent-binding_2026-08-29.md` (GEMINI converged in one round on the D-056
implementation). Read as evidence. The load-bearing claims I re-derived first-hand:
- CODEX's account-takeover: re-proved end-to-end (RP-3 / §3.4).
- The scope decision — bind the six irreversible writes only, social writes stay unbound —
  is **D-056, Ben's ruling**, not something this gate reopens. CODEX round 2 argued for
  binding *every* authenticated write; Ben ruled narrower. I assess the residual that
  leaves (the `model` write) in §3.8; it is within the ruling.

### 3.3 Red-proofs — the core of this gate. Every new guard proven able to fail.

Each: mutate the guard in source, run the targeted test file, observe RED, revert with
`git checkout --`. Command form throughout:
`node --experimental-strip-types --test <file>`.

| # | Guard broken | File / mutation | Result |
|---|---|---|---|
| RP-1 | `requireSignedIntent` enforcement | `society.ts:250`, inserted `return;` at top of body | `intent-binding-d1.test.ts`: **9 fail / 1 pass** (every refusal test saw the write land) — matches the checkpoint's recorded 9/10 |
| RP-2 | bearer exclusion `AND public_key IS NULL` | `society.ts:208`, removed the clause | `public-key-auth-d1.test.ts`: **1 fail** — "the bearer query excludes public-key citizens by SQL" |
| RP-3 | rotation binding `if (bound !== next)` | `society.ts:808`, `if (false)` | `public-key-auth-d1.test.ts`: **3 fail** — incl. "CODEX HIGH: a captured assertion that committed to nothing CANNOT rotate the key" (the takeover lands with the guard off) |
| RP-4 | audience check `if (a.audience !== expectedAudience)` | `society.ts:290`, `if (false)` | `public-key-auth` + `served-recipe-fidelity`: **6 fail** — 3 audience tests + 3 fidelity tests (their audience-discovery depends on wrong-aud refusal) |
| RP-5 | verify-before-nonce ordering | `society.ts`, moved the nonce INSERT above `verifyAssertion` | `public-key-auth-d1.test.ts`: **1 fail** — "a BAD signature consumes no nonce" |
| RP-6 | canonical base64url (F-1) | `keyauth.ts:124`, `if (false)` | `keyauth.test.ts`: **1 fail** — "only the canonical base64url spelling of a key is accepted" |
| RP-7 | served-recipe drift guard | `discovery.ts:175`, dropped "LOWERCASE" from the recipe | `served-recipe-fidelity-d1.test.ts`: **1 fail** — "the served text still teaches every fact this hand-rolled client relied on" |
| RP-8 | migration column identity | `migrations/0012`, `public_key` → `public_key_x` | `public-key-migration-d1.test.ts`: **2 fail** — column-order and additive tests |
| RP-9 | directory publishes `public_key` (governance-d1 diff) | `society.ts:1625`, dropped `public_key` from the SELECT | `governance-d1` + `public-key-auth`: **2 fail** — the key-set assertion and "the citizen directory PUBLISHES the public key" |

Every one went green again on revert; the final full-suite run (1022/1022) is the proof
the reverts were exact. The "prove a new check can fail" standard, which the prior record
called UNMET for every new test, is now MET for every new test file in the wave.

### 3.4 The account-takeover, executed end-to-end against real local D1

The attack the design's own author flagged (CODEX round 1 HIGH): a captured assertion
committing to nothing, raced into `/api/rotate` with an attacker's key, permanently seizing
the citizenship. RP-3 IS that attack run end-to-end: with the shipped guard removed, the
test "a captured assertion that committed to nothing CANNOT rotate the key" **fails** —
i.e. the captured assertion successfully rotates `citizens.public_key` to the attacker's
key. With the guard in place (real code), it is a 400 and custody does not move. The fix
(a signed `b` claim carrying the replacement key, checked at `society.ts:808` before the
UPDATE at `:817`) genuinely blocks it. The companion cross-shape test confirms the two
`b` shapes can never be confused: a rotate `b` is a bare base64url key (no `:`), an intent
`b` is `<op>:<hex>` (`:` is outside base64url), so neither verifier accepts the other's.

Placement re-verified for all six ops: the intent check sits after cheap shape validation
and before the first write/chain-append/rate-spend in every case —
ballot (`governance.ts:1057`, write at `:1147`), proposal (`governance.ts:922`, INSERT at
`:966`, debate post at `:977`), moderate (`society.ts:1238`, UPDATE at `:1243`),
wallet (`wallets.ts:45`, INSERT at `:61`), payout (`payouts.ts:99`, the `commitPayout`
helper only called at `:111`), ledger (`society.ts:1889`, `appendChained` at `:1891`).
The parts each op binds pin the effect (I checked the `String(Number(amount))` /
`stableStringify(payload)` cases for same-binding-different-effect pairs and found none).

### 3.5 Design doc §5–§10 (the author's "attack this hardest")

`docs/DESIGN-PUBLIC-KEY-REGISTRATION.md` read in full incl. §10 and the §14 outcomes
table. The six attacks the author invited (burned preimage, replay/nonce, unbound
assertion, clock skew, Ed25519-in-workerd, eligibility) are each addressed in code and
recorded in §14. Re-derived first-hand: the burned-preimage claim (secret_hash NOT NULL
holding an unheld hash) holds because `authenticate`'s only bearer read is an equality
match plus `AND public_key IS NULL`, and no path mints a secret onto a key row
(rotateKey branches; register's key path returns and retains nothing). Eligibility is
untouched — credential type is not an input to any franchise/weight/quorum/standing branch.

### 3.6 CHECKPOINT-PUBLIC-KEY.md — read

`docs/CHECKPOINT-PUBLIC-KEY.md` (project root, not `society/docs`). It records the build
log for commits 1–6, the migration rehearsal on real D1, and the reviewer weighting. No
claim in it contradicts the code as it now stands.

### 3.7 L-002 overclaim scan of doc.ts / FRONT_DOOR_TEMPLATE

`grep -n "secret" src/doc.ts` and a read of the constitution template. Findings:

- **DEFERRED-PUBKEY-4 (governance decision, Ben's) — the constitution still describes
  secret-only identity.** `FRONT_DOOR_TEMPLATE` / `JoinFragments` carry: "Register (once,
  save the secret shown in the reply)" (`doc.ts:79,98`), "Identity is a secret key, issued
  once at registration ... Whoever holds the key IS the citizen" (`:142-143`), "Then
  authenticate every write with your secret: Authorization: Bearer commonhold_sk_..."
  (`:173-175`), "Rotate your secret" (`:186`), "Add it to your MCP client config with your
  secret" (`:203-204`). All of these are hashed into the attested constitution's
  `template_hash`, so fixing them mints constitution version 4 — an operator act reserved
  to Ben (D-048, D-056 ruling 4). The flag is already planted at `doc.ts:87` and the open
  decision is written up in the checkpoint ("THE OPEN DECISION FOR BEN"). **This is not a
  code defect the builder or this gate can fix; it is a documented governance decision.**
  Its consequence: once the wave deploys AND a key citizen registers, the attested
  constitution actively describes only one of two identity kinds, on a society whose whole
  pitch is checkable records. The honest how-to surfaces (discovery.ts, the register/rotate
  responses) ARE corrected, so a key citizen following served instructions still succeeds
  — the incompleteness is in the constitution's narrative, not in the machine-readable
  path. Ranked MEDIUM as a ship-coordination item (§3 findings), non-blocking for the code
  gate but to be settled by Ben in the deploy sequence and before betweenwakes-uk is
  pointed at it (design §13 already orders it that way).

- **G-1 (LOW) — a residual F-2-class instance the F-2 fix did not reach.**
  `discovery.ts:249-250`, the /llms.txt prose for the /mcp/read door: "Writes need a
  **citizen secret** over ${origin}/mcp." The corrected Write section right below
  (`:269-284`) says "citizen credential ... Two kinds" and shows both `commonhold_sk_` and
  `ch1.` forms, and the machine-readable route entry at `:99` was updated — but this prose
  blurb still says "secret". It is the exact self-contradiction F-2 named ("prose still
  told every reader to authenticate with a secret while the route table below it had
  already been corrected"), on a copy the fix missed — this project's recurring
  fix-one-of-N blast-radius failure. Severity LOW: it does not stop a key citizen
  authenticating (the authoritative surfaces and the full Write section are correct), but
  it is a served inaccuracy of the class this wave exists to close. One-line fix
  ("secret" → "credential") in the same spirit as F-2.

### 3.8 Migration additivity, judgment.ts, concierge/showhome write paths

- **Migration 0012 is additive and never rebuilds `citizens`.** `ALTER TABLE citizens ADD
  COLUMN public_key TEXT` + `CREATE TABLE IF NOT EXISTS auth_nonces` + one index. No table
  rebuild, no FK on the hot path (auth_nonces.citizen_id is an attribution pointer, not an
  FK — the whole L-016 point). `public-key-migration-d1.test.ts` proves migrate(pre-0012)
  == fresh schema.sql column-for-column, that public_key is the appended final column, that
  re-apply fails loudly, and that auth_nonces carries no FK. RP-8 red-proofed it. The prod
  `--remote` rehearsal from prod's dumped DDL remains the operator's deploy-time step
  (L-016: node:sqlite cannot see D1's authorizer/FK-defer), already rehearsed clean per the
  checkpoint.
- **judgment.ts beyond its two changed lines.** The only wave change is that its two
  `moderateContent` calls (`:1068`, `:1514`) now pass `null` as the credential. Both are
  the maintainer moderating on its own cron wake — server-internal, no transport
  credential, exempt by D-056 ruling 3. `requireSignedIntent(null, ...)` returns
  immediately. This exemption is unreachable from any transport: index.ts and mcp.ts both
  call `authenticate()` with the same credential they pass the handler, and `authenticate()`
  throws 401 on a null/empty credential before the handler runs, so no unauthenticated
  caller can supply `null` to a bound handler.
- **Concierge / showhome write paths carry no unbound irreversible write.** A full caller
  sweep (`grep` for all six handlers across `src/`) returns only index.ts (HTTP), mcp.ts
  (the 3 governance/moderation tools), and judgment.ts (the 2 null calls). Concierge writes
  a `createComment` (social write, unbound by D-056) plus a `concierge_engagement`
  disclosure row to identity_events (`concierge.ts:479`) — both as the maintainer,
  server-side, no assertion. Showhome writes no bound op. Nothing there meets D-056's
  irreversibility criterion while going unbound.
- **The one accepted residual, noted not filed as a finding:** `model` (correctModel) is a
  social write left unbound. Per CODEX round 2, a Commonhold-facing MCP host that legitimately
  receives a citizen's assertion for `me` could race it once into any unbound write,
  including `model`. D-056 ruled the social writes unbound this wave (reversible, capped,
  logged; DEFERRED-INTENT-1 flags the next wave). `model` is the closest-to-the-line of
  that set because it writes the identity log, but it is reversible and 1/day-capped, so it
  is within the ruling. Audience binding already stops the *cross-service* version of this;
  the residual is bounded to one reversible act per captured assertion by a Commonhold MCP
  host. Accepted per D-056, flagged here so the ruling's cost is visible.

## 4. Deploy-order cross-check — the HARD ORDER still holds

Confirmed in current code:
- `authenticate()` bearer query reads `... AND public_key IS NULL` (`society.ts:208`).
- `authenticateByAssertion()` selects `public_key` (`society.ts:306`).
- `register()` INSERTs `public_key` (`society.ts:690`).
- `citizenDirectory()` selects `public_key` (`society.ts:1625`).

Therefore: **migration 0012 must be applied to the prod D1 BEFORE the worker deploys.**
Deploy-first means `no such column: public_key` on every authenticated request and on
`/api/register` and `/api/citizens` — a total auth + registration + directory outage. The
reverse (migrate-then-deploy) is safe and reversible: the migration is additive and the
CURRENT live worker's code references no such column, so prod can sit migrated-but-deploy-
pending indefinitely with zero behavioural change. Re-applying 0012 is not a no-op and
fails loudly with `duplicate column name` (by design). Post-deploy, the one-real-ride must
prove Ed25519 on the production edge (verified in local workerd only): register a throwaway
key citizen, authenticate once with a signed assertion, confirm a bound write (a `wallet`
declaration is the cheapest) refuses unbound and succeeds bound.

## 5. VERDICT: DEPLOYABLE

No HIGH or MEDIUM code defect. The account-takeover the wave was built to close is
genuinely closed (proven by removing the guard end-to-end). Intent binding is enforced on
all six irreversible writes with no side effect before the check; the auth path orders
audience and signature verification before the nonce insert; the migration is additive and
never rebuilds the 11-FK `citizens` table; the served recipe is faithful enough that a
hand-rolled outside client authenticates and performs a bound write. Every new guard is
red-proofed.

Ship conditions (none is a code change this gate blocks on; all are already on the
project's own list):

1. **Runbook, hard:** apply migration 0012 to prod D1 BEFORE deploying the worker (§4).
2. **Ben's governance decision, before/with deploy and before betweenwakes-uk is told:**
   settle DEFERRED-PUBKEY-4 — mint constitution v4, or ship with the constitution
   knowingly silent on public-key identity (option (b) in the checkpoint). The code is
   honest on the discovery surfaces regardless; the constitution narrative is the gap.
3. **Post-deploy one-real-ride:** Ed25519 on the production edge, a real key citizen
   registers → authenticates → bound write refuses-unbound-then-succeeds-bound (§4).

Non-blocking cleanups worth folding in whenever the wave is next touched:
- **G-1 (LOW):** `discovery.ts:250` "citizen secret" → "citizen credential" (residual F-2).
- **F-6 (note):** stableStringify(-0) — non-exploitable, leave documented.
- **DEFERRED-INTENT-2 (accepted):** rotate's 400 vs the six ops' 403 — cosmetic.

## Tree state on exit

`git -C society status -sb` = `## main...origin/main [ahead 15]`, clean. HEAD `f705e14`,
unchanged. 1022/1022, typecheck exit 0. Every red-proof mutation was reverted; the repo is
left exactly as found. Nothing was pushed, deployed, or written to prod; no secret or
`*.local.*` file was opened.
