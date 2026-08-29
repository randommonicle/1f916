# D-018 gate record — public-key + intent-binding wave (PARTIAL)

Provenance: Opus gate agent, commissioned 2026-08-29 small hours over the nine-commit wave
`46aed5b..e981b57` (ahead of origin, undeployed). The operator's usage window closed
mid-review; the agent was instructed to stop and return everything verified so far. The
report below is its return, verbatim (transport HTML entities normalised to literal
characters, nothing else altered). **A PARTIAL is not a gate decision: no push, no deploy
until a full DEPLOYABLE verdict exists.** Tomorrow's gate resumes from §3.

---

VERDICT: PARTIAL — NOT A GATE DECISION

I was stopped mid-review. Everything below is verified first-hand; nothing is taken from
the checkpoint or the prior reviews (I did not read the two exchange review files at all).

## 1. What I verified first-hand

**Baseline.** `npm test` in `C:\Users\bengr\Projects\AI domain and social network\society`:
**tests 1016, pass 1016, fail 0**, exit code 0, duration 2363ms. `npm run typecheck`:
**clean**, `tsc` emitted nothing. Matches the claimed numbers.

**Wave shape.** `git log --oneline origin/main..HEAD` = 9 commits, `46aed5b` (oldest)
through `e981b57`. Status: `## main...origin/main [ahead 9]`, working tree carries exactly
one uncommitted file, `docs/CHECKPOINT-INTENT-BINDING.md` (the briefed docs edit).
Diffstat: **19 files, +2696 / −51**. Repo left untouched; all my scratch files are under
the temp scratchpad.

**Diff hunks I read in full:** `src/keyauth.ts` (whole file, 339 lines), `src/society.ts`
diff (both halves), `src/governance.ts`, `src/wallets.ts`, `src/payouts.ts`,
`src/maintainer/judgment.ts`, `src/index.ts`, `src/mcp.ts`, `src/discovery.ts`,
`src/register-gate.ts`, `schema.sql`, `migrations/0012_public_key_registration.sql`,
`test/discovery.test.ts`. Plus the surrounding non-diff context for `createProposal`,
`castBallot`, `moderateContent`, `recordLedger`, `recordPayout`, `normalizeAddress`,
`bearer()`, `callTool`'s secret resolution, and `renderLlmsTxt`. Read D-056 in full and
the D-055 tail; design doc §1–§4.

**Attacks completed.**

(a) *Captured assertion into a bound op, static trace of all seven paths.* For each of
ballot (`src/governance.ts:1057`), proposal (`src/governance.ts:917`), moderate
(`src/society.ts:1237`), wallet (`src/wallets.ts:45`), payout (`src/payouts.ts:99`),
ledger (`src/society.ts:1885`) and rotate (`src/society.ts:800-810`), the binding check
sits after pure shape validation and **before the first D1 write**. No write, no chain
append, no cap consumption precedes it. `refusesDisguisedFirstLawsAmendment` is
synchronous and pure, so the proposal path has no earlier side effect either.

(b) *Transport bypass.* `grep -rn` over `src/` for every one of the seven handlers: every
transport call site passes the credential (`src/index.ts:193,199,351,361,372,473,480`;
`src/mcp.ts:367,386,396,400`). The only null-credential callers are
`src/maintainer/judgment.ts:1068` and `:1514`, both server-internal. MCP parity confirmed
at `src/mcp.ts:323` — `const secret = typeof args.secret === "string" ? args.secret :
headerSecret` is resolved **once** and the same string reaches both `authenticate()` and
the handler, so `credentialBinding`'s parse-without-reverify is sound. HTTP `bearer()`
(`src/index.ts:80-83`) likewise passes the identical string. **No bypass found.**

(c) *`encodeIntentParts` injectivity.* 200,000-iteration fuzz over an adversarial alphabet
(`,`, `:`, digits, empty string, multibyte, the `"12:"` and `"0:"` traps), 1–4 parts:
**104,839 distinct encodings, 0 collisions.** Cross-shape disjointness confirmed
empirically in both directions: no binding for any member of `INTENT_OPS` passes
`checkPublicKeyShape` (the `:` is outside the base64url alphabet), and a bare key can
never equal `"<op>:<hex>"`. The rotate-vs-intent confusion is structurally closed.

(d) *`authenticateByAssertion` ordering.* Read at `src/society.ts:265-338`: audience →
freshness → citizen lookup → `verifyAssertion` → nonce INSERT → GC. A wrong-audience or
bad-signature assertion cannot consume a nonce. I also checked the GC/window interaction
arithmetically: `expires_at = issuedAt + 120000`, deleted only when `expires_at < now`,
i.e. strictly after the assertion has gone stale — **no window in which a GC'd nonce is
still replayable.** I did *not* execute this as a live D1 test of my own.

(e) *Substitution-gap hunt, per-op parts vs actual effect.* `moderate`'s
`typeof reason === "string" ? reason : ""` collapse is only reachable on `restore`, where
`reason` is unused in the effect (`src/society.ts:1244`) — no gap. `wallet` binds
`String(address)` but `normalizeAddress` rejects non-strings first, so `String()` is
identity. `ledger`/`payout` bind `String(Number(amountCents))`; equal `Number` implies
equal effect. `ballot` canonicalises the path digits identically on both sides. No
exploitable "same binding, different effect" pair found.

(f) *Parser edge probes.* Duplicate JSON keys resolve last-wins and the signature is over
the received text, so no split-brain. A `__proto__` claim key does not pollute. Empty `b`
is rejected.

(g) *Migration 0012.* Read: single `ALTER TABLE citizens ADD COLUMN public_key TEXT`,
plus `CREATE TABLE IF NOT EXISTS auth_nonces` and one index. No table rebuild, no
`sqlite_sequence` write, no TEMP table, no FK on the hot path. `schema.sql:16` places
`public_key` last, matching `ADD COLUMN` append semantics. I found nothing D1 would
reject that node:sqlite would hide — but I did **not** re-run the rehearsal.

## 2. Findings so far

**F-1 — MEDIUM — `decodeBase64Url` accepts multiple spellings of one key, and its own
comment says it does not.**
`src/keyauth.ts:71-88`. The comment at :71-74 claims "accepting standard base64 here
would mean two different strings could denote the same key, and a credential with two
spellings is a credential you cannot index." I proved the strict-alphabet regex does not
achieve that: `atob` ignores non-canonical trailing bits, so for a 32-byte key **three
additional 43-char spellings decode to identical bytes** (verified: `…BwcHBwd`,
`…BwcHBwe`, `…BwcHBwf` all decode to the same 32 bytes as canonical `…BwcHBwc`).
*Failure scenario:* the register response's `warning` (`src/society.ts:~735`) instructs
the new citizen to compare the string at `/api/citizens` against the one it generated,
and to conclude "this citizenship is not yours" on a mismatch. A funder who registers the
citizen's own key in a non-canonical spelling triggers a **false alarm** on exactly the
custody check this wave exists to enable. It is not a takeover (the bytes are the same
key), so this is not a HIGH, but it degrades the one verification instruction the feature
ships.
*Clearing change:* in `checkPublicKeyShape` (`src/keyauth.ts:104-113`), after the length
check, add `if (encodeBase64Url(bytes) !== pk) return { ok: false, reason: "public_key
must be canonical base64url" }`, and correct the :71-74 comment.

**F-2 — MEDIUM — `/llms.txt` prose still instructs every citizen to authenticate with a
secret, which a key citizen cannot do.**
`src/discovery.ts:269` (`## Write (citizen secret)`), `:279` ("Then authenticate every
write below with your secret:"), `:281` (`Authorization: Bearer commonhold_sk_...`), and
`:99` ("Writes need a citizen secret over /mcp"). The corrected `AUTH_LABEL` at `:175` is
served below these, so the document contradicts itself.
*Failure scenario:* `betweenwakes-uk` — the named intended reader, and the reason this
wave exists — reads `/llms.txt` top to bottom, follows `:279-281` verbatim, and cannot
authenticate. This is precisely the criterion the brief set ("a citizen following them
verbatim must succeed") and the same class of drift the wave's own commit `e981b57` was
written to close on a different surface.
*Clearing change:* amend the three literal strings in `renderLlmsTxt` at
`src/discovery.ts:269,279,281` (and the route description at `:99`) to name both
credential kinds.

**F-3 — MEDIUM — the `/api/rotate` route entry on `/api/surface` is factually false for a
key citizen and is the one bound op with no served binding recipe.**
`src/discovery.ts:122`: `description: "Issue a new secret; old key dies, identity
stays."` For a public-key citizen, rotation issues no secret, replaces the public key,
and **requires** the replacement key in `b`. The MCP tool description was updated
(`src/mcp.ts:151-160`); the HTTP surface entry was not. Every other bound op got a `note`
naming its binding; rotate did not.
*Clearing change:* add the second credential kind to the description and a `note` at
`src/discovery.ts:122` mirroring the other six.

**F-4 — LOW — overclaim, and it is the recurring one (L-029).**
`src/discovery.ts:175`, final sentence: "A citizen registered with a public key was never
issued a secret **and none exists**." A secret *was* generated and its sha-256 is stored
in `secret_hash` (`src/society.ts:~672`, `schema.sql:12`). The register and rotate
warnings were both carefully bounded after CODEX killed this exact absolute shape twice;
it has reappeared on a third served surface in the same wave.
*Clearing change:* replace with the register warning's own bounded wording ("one was
generated to satisfy a NOT NULL column, never returned and never retained").

**F-5 — LOW — the served nonce recipe does not require unpredictability, and
`auth_nonces.nonce` is a global primary key.**
`src/discovery.ts:175` teaches `"n":<16-64 base64url chars>` with no randomness
requirement; `migrations/0012_public_key_registration.sql` makes `nonce` the PK across
all citizens, not `(citizen_id, nonce)`. A client following the text with a counter
(`"0000000000000001"`) can be pre-burned by any other key citizen signing assertions with
those nonce values, giving a cheap targeted denial of service. Negligible against
`newNonce()`'s 16 random bytes; real against a literal reading of the served text.
*Clearing change:* say "16-64 **unpredictable** base64url characters (16 random bytes is
the reference)" at `src/discovery.ts:175`.

**F-6 — LOW — `stableStringify(-0) === stableStringify(0) === "0"`.**
`src/keyauth.ts:332-338`, verified by probe. Two distinct JSON payload values share one
binding. I found no proposal payload field where `-0` and `0` differ in effect, so I am
filing this as a note, not a gap. Verify with: `grep -n "validatePayload" -A 60
src/governance.ts`.

**F-7 — LOW — `/api/rotate` now rejects bodies it previously ignored.**
`src/index.ts:96-107` (`optionalBody`) plus `:361`. Before this wave the route never read
the body; now a non-empty body that is not a JSON object is a 400. Any existing bearer
client sending a non-object body loses its rotation path.

## 3. What I did NOT review — tomorrow's gate starts here

1. **The served-recipe fidelity test — the single most important remaining check.** I had
   the harness ready and did not run it: build an assertion by following `/llms.txt` +
   `/api/surface` **verbatim** (including the `b` recipe: `<utf8-byte-length>:<value>`
   joined by commas, sha256 hex, op prefix) and confirm it both authenticates and passes
   a bound write. Run against `test/helpers/local-d1.ts`. Note the recipe never states
   the hex must be **lowercase**; that is unverified and would be a real trap.
2. **The two exchange review files.** Not read.
   `exchange/REVIEW_public-key-registration_2026-08-28.md`,
   `exchange/REVIEW_intent-binding_2026-08-29.md`.
3. **The new test files.** I read only the header of `test/public-key-auth-d1.test.ts`.
   Not read at all: `test/intent-binding-d1.test.ts` (395 lines), `test/keyauth.test.ts`
   (320), `test/public-key-migration-d1.test.ts` (191), the `test/governance-d1.test.ts`
   diff. **No red-proof was re-derived by me** — the brief's "prove a new check can fail"
   standard is unmet for every new test in this wave.
4. **Live D1 attack execution.** All my attack conclusions in §1(a),(b),(d),(e) are
   static traces and pure-function probes, not executed end-to-end runs.
5. **Design doc §5–§10**, including the deferred items and the author's own "attack this
   hardest" section. Read only §1–§4.
6. **`docs/CHECKPOINT-PUBLIC-KEY.md`** (the first half's build log) — not opened.
7. **Overclaim scan of `src/doc.ts` / `FRONT_DOOR_TEMPLATE`** for claims made newly false
   by this wave. Not done. Run: `grep -n "secret" src/doc.ts`.
8. **Migration 0012 rehearsal** not re-run; `src/maintainer/judgment.ts` beyond its two
   changed lines not reviewed; the concierge and showhome paths not checked for unbound
   writes.

## 4. Runbook items already established

- **HARD ORDER: migration 0012 must be applied to prod D1 BEFORE the worker deploy.**
  `authenticate()`'s bearer query now reads `AND public_key IS NULL`
  (`src/society.ts:~205`) and `citizenDirectory` selects `public_key`
  (`src/society.ts:1625`). Deploying first means `no such column: public_key` on **every
  authenticated request** and a 500 on `/api/citizens` — a total write outage. The
  reverse order is safe and reversible: the migration is additive and the current live
  worker never references the column, so prod can sit migrated-but-not-deployed
  indefinitely.
- Re-apply of 0012 is **not** a no-op and will fail loudly with `duplicate column name:
  public_key`. That is by design; do not retry blindly on a partial-looking failure
  without checking `PRAGMA table_info(citizens)` first.
- Post-deploy one-real-ride, specific to this wave: **Ed25519 on the production edge is
  verified in local workerd only.** The first live check must be a real
  `crypto.subtle.importKey("raw", …, {name:"Ed25519"})` round trip on the deployed
  worker — register one throwaway key citizen, authenticate it once with a signed
  assertion, and confirm a bound write (a `wallet` declaration is the cheapest
  irreversible one) both refuses unbound and succeeds bound.
- Confirm `public_key` is the **last** column in prod's `PRAGMA table_info(citizens)`
  after the migration; `schema.sql:16` depends on it.
- D-056 ruling 1 flags **ledger** as added at build time under the criterion, not in
  Ben's enumerated five. That still needs his morning confirmation before this ships.
