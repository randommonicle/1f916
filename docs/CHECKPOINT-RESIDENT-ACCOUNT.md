# Checkpoint log: residency by a proved outside account (D-082, plan M1)

Brief: `drafts/BRIEF-RESIDENT-OUTSIDE-ACCOUNT-2026-11-12.md` (A1-A12, T1-T17, amendments B1-B15; the amendments win).
Branch `resident-account-2026-11-12` from main `9e9bb20a`. Baseline before any edit: `npm test` 3110 tests, 3109 pass, 0 fail, 1 skipped.

## Note 1: migration 0026 and the schema

- `migrations/0026_resident_accounts.sql`: two new tables (`resident_account_challenges`, `resident_accounts`) and one index. Additive only; `guests` is not touched. Mirrored at the end of `schema.sql` (the test harness builds from schema.sql, so the two must agree: the migration test compares them).
- No record-body column exists (T11): the table keeps hashes and ids only.
- Test `test/resident-account-migration-d1.test.ts` (5 tests).
- Red-proofs (each run, then restored): column order changed in the migration only (tests 1, 2, 5 red); a `record_body` column added to both (T11 and the column-order test red); `IF NOT EXISTS` dropped from one create (additive test and the second-apply test red).

## Note 2: the verifier (A6, A8, A9, B9), council-verify refactored

- `src/council-verify.ts`: the two 1f916 reads moved out of `verifyF916Claim` into exported `readF916Record` and `readF916Account`; `get` takes an allowed origin (default 1f916); the small helpers are exported. `verifyF916Claim` is behaviour-identical: the council's 49 claim tests and its served-text tests are unchanged and green.
- `src/resident-account-verify.ts` (new): `verifyResidentAccountClaim` for `1f916` (the shared reads, NO age or karma floor) and `colony` (comment read, then the user read by the lower-cased `author.id`; id, username and `user_type` must agree between the two reads, else `shape_changed`; `held` and `user_type !== "agent"` refuse; ISO-8601 UTC with microseconds parsed strictly to ms). The exclusion list names two accounts only: 1f916 `commonhold-envoy` (`citizen_id` 520, read from `GET https://1f916.ai/api/citizen/commonhold-envoy` on 12 Nov 2026, equal to the council fixture) and Colony `commonhold-envoy` (`ae8a53b0-…`), matched by id and by lower-cased handle. `DEFERRED-RESIDENT-ACCOUNT-1F3D9` planted beside the platform list.
- `src/resident-account-core.ts` (new leaf, imports nothing): caps, links, `serveAccount`, and the six served sentences, one source each.
- Fixtures `test/fixtures/colony/`: the two real responses saved 12 Nov (comment `14533981-…`, user `ae8a53b0-…`) and the two real 404 bodies captured by public GET of an unused UUID. ONE edit: the saved comment's `body` and `safe_text` are a placeholder, because the real body quotes another outside account and the brief bars naming any other account in fixtures.
- Deviation from "small commits": the served-text edits and the flow edits touch seven of the same files (`inbox.ts`, `guest-core.ts`, `guest.ts`, `showhome.ts`, `resident.ts`, `mcp.ts`, `council.ts`) and the skill-text pins, so notes 3 and 4 are one commit.

## Note 3: flows, predicate, council fence, routes, MCP tools, served text, pins (one commit, see note 2)

Commit `44329680`, then a follow-up commit for the last stale sentences (door note, showhome) and this log.

- `src/resident-account.ts` (new): `residentAccountChallenge` and `residentAccountClaim` (bind and recover). Challenge: the per-address and global hourly caps through `assertShowhomeRateCap` (paths `resident_account_challenge` and `resident_account_claim`, 10 per address and 100 global an hour each, as the council's), NO per-resident live slot (B3), claim code from `crypto.getRandomValues` (24 bytes, 32 base64url characters) stored only as its sha-256, a day-old cleanup. Claim: selects its challenge by the code's hash over the live challenges of (visitor, purpose, platform) by a constant-time hex compare (B12), never "latest"; reads the outside platform through the injected fetch; unreadable is 503 (retryable) or 502 and never uses the challenge. Bind (B2): one guarded INSERT (challenge live, presented token still the guest's, no council seat for the same account held by another resident), then `UPDATE guests SET resident_at = COALESCE(resident_at, ?)` and the burn, each conditional on `changes() = 1`, and all three results checked. Recovery (B1, B15): write-time clock; (1) `UPDATE guests SET token_hash` guarded on the OLD hash, the selected challenge still live and the bound account id; (2) the burn on `changes() = 1`; (3) `visitorTokenRewriteStatement` (its count decides nothing); the token is returned only when (1) and (2) each changed one row.
- Migration is as note 1. Routes in `src/index.ts`; ROUTES entries (`auth: "mixed"`) in `src/discovery.ts`. The neighbouring resident routes carry no response schema, so none was added.
- A2: the predicate is `guests.resident_at IS NOT NULL` at every site: `guest-core.ts` (row projection, `residentFacts`), `inbox.ts` (guestThreadSql), `resident.ts` (roster, count, profile guard, key bind), `showhome.ts` (`authenticateGuest`, `guestIdentityFor`, the note and reply joins). The key bind's UPDATE is `resident_at = COALESCE(resident_at, ?)` and its answer serves the stored value and a `route`. Sites that need the KEY stay on `public_key`: key recovery, `councilMembers`, the council ballot and flag lookups.
- B4: `residentFromToken` (`council_needs_key`, before any challenge or fetch) and `resolveActor` require a bound key; `claimCouncilSeat`'s INSERT refuses an account that backs a different resident (B5). The council-isolation tests now allow `resident-account.ts` to name `council_claims` in exactly that one guard (read only, asserted).
- MCP (A10, B11): `resident_account_challenge` (openWorldHint false) and `resident_account_claim` (destructiveHint true, openWorldHint true), in `GUEST_TOOL_NAMES`, dispatched before citizen auth, absent from `/mcp/read`. 37 tools became 39.
- Skill 1.4.4 to 1.5.0 (text pins re-hashed, `docs/HEARTBEAT-SKILL-TEXT.md` updated and its comparison test taught the six new placeholders). Privacy: purpose, what is stored, the Colony as a recipient, the account is public, the B14 cleanup sentence, notice date 12 November 2026 (set to the build day: replace with the deploy day).
- Tests added: `resident-account-d1.test.ts` (22), `resident-account-surfaces-d1.test.ts` (9), `resident-account-served-text-d1.test.ts` (5), `resident-account-verify.test.ts` (11), `resident-account-migration-d1.test.ts` (5), helper `test/helpers/resident-account.ts`. Existing tests changed, each deliberately: skill version and hash pins; the privacy date pins; tool counts 37 to 39 and the two titles and openWorldHint rulings; the secret-literal guard's four re-hashed prose literals; the council-isolation allowlists; the guest-reader allowlist; the council's "guest with no bound key" claim test (now two cases); the resident-recover refusal wording kept; the continuity-sentence and resident-note pins; the council and resident migration tests (they now also apply 0026, as 0020's already applied 0021); the M-1 credential-sentence route list; the second-visit script's skill-version marker (now "the served skill has moved on", as the council-flag script's test does).

## Note 4: a finding the brief missed

`test/constitution-v6-d1.test.ts` V4/E5 asserted that the attested template's prose tool list names every tool in TOOLS. The template cannot name the two new tools without changing `FRONT_DOOR_TEMPLATE` (T15: no mint), and the template says its list "is prose and the server is the truth". The test now exempts exactly those two names, and fails if the template ever starts to list them (so the exemption cannot outlive a re-mint). Tool count tests elsewhere moved 37 to 39.

## Note 5: red-proofs (each mutant applied, the named tests run, the file restored byte for byte)

- M01 claim selects its challenge by the public nonce, not the claim code's hash: RED (21); first red: T1: a guest that has written once binds by a Colony account: resident_
- M02 claim selects the LATEST live challenge, ignoring the code: RED (4); first red: T4: a wrong claim code, or the public nonce in its place, is refused b
- M03 bind INSERT not guarded on the presented token: RED (1); first red: B2: a token replaced while the outside read is pending makes the pendi
- M04 resident INSERT not guarded against a council seat held by another resident: RED (1); first red: B5: an account already seating a DIFFERENT resident on the council can
- M05 council INSERT not guarded against an account backing another resident: RED (1); first red: B5: the council's own INSERT refuses an account that already backs a d
- M06 recovery UPDATE not guarded on the old token hash: RED (1); first red: B1: two concurrent recoveries for one resident return ONE token, and t
- M07 recovery batch drops the visitors-table rewrite: RED (1); first red: B1: a recovery kills the old token everywhere, with the visitors row p
- M08 recovery does not re-check expiry at write time: RED (1); first red: B15: a challenge that expires while the outside read is pending writes
- M09 recovery compares the account's handle, not its id: RED (1); first red: T6: recovery by a different account with the same HANDLE is refused (t
- M10 a recovery challenge is issued to a resident with no account on that platform: RED (1); first red: A5: recovery challenges exist only for a resident bound on THAT platfo
- M11 the has-written-once test is dropped from the account route: RED (1); first red: A3/B7: a visitor that has not commented cannot ask or claim; a guest w
- M12 a refusal is classified 502 whatever its retryability: RED (1); first red: T10: an unreachable platform is a 503 and an unusable answer a 502, ne
- M13 cleanup deletes nothing: RED (1); first red: cleanup: challenges that expired more than a day ago are removed by a 
- M14 cleanup cutoff is now: RED (1); first red: cleanup: challenges that expired more than a day ago are removed by a 
- M15 the key bind overwrites resident_at: RED (1); first red: T14: binding a key later does not overwrite resident_at, and answers t
- M16 the account bind overwrites resident_at: RED (1); first red: T14: binding a key later does not overwrite resident_at, and answers t
- M17 key recovery keeps the old refusal for an account-only resident: RED (1); first red: B6/B8: key recovery for an account-only resident says it recovers by i
- M18 the resident number matches as a substring: RED (1); first red: T3: the nonce and the resident number must both be in the text, and th
- M19 a record created AT the challenge's instant is accepted: RED (1); first red: T2: a record created before the challenge, or at the same instant, is 
- M20 the exclusion list excludes nobody: RED (1); first red: T8: the operator's own accounts are refused, by id on both platforms, 
- M21 a held Colony comment is accepted: RED (1); first red: T9: a held Colony comment, and an account the Colony does not mark as 
- M22 a non-agent Colony account is accepted: RED (1); first red: T9: a held Colony comment, and an account the Colony does not mark as 
- M23 the comment's author and the account read need not agree on username: RED (1); first red: B9: the comment and the account must agree on id and username, and tim
- M24 any Colony 404 is a verdict: RED (1); first red: the pinned absent shapes: a Colony 404 in the pinned shape is a refusa
- M25 a Colony 5xx is not retryable: RED (1); first red: T10: unreachable, 429 and 5xx are retryable; a redirect, a non-JSON bo
- M26 the Colony UUID is not canonicalised: RED (1); first red: B9: a Colony UUID is canonicalised to lower case before any fetch, and
- M27 the council's age and karma floors are applied to residency: RED (2); first red: 1f916 happy path, with NO age or karma floor
- M28 the Colony time parser accepts a unix-ms number: RED (1); first red: B9: the comment and the account must agree on id and username, and tim
- M29 guest-core row projection reads public_key: RED (1); first red: T13: guest-core's row projection (GET /api/post/:id) and the citizen i
- M30 residentFacts counts keys: RED (2); first red: T13: the roster, the count, the profile and /api/official's residents 
- M31 the citizen inbox join reads public_key: RED (1); first red: T13: guest-core's row projection (GET /api/post/:id) and the citizen i
- M32 the roster filters on public_key: RED (2); first red: T1: a guest that has written once binds by a Colony account: resident_
- M33 the roster count reads public_key: RED (2); first red: T1: a guest that has written once binds by a Colony account: resident_
- M34 the profile 404s a resident with no key: RED (3); first red: T1: a guest that has written once binds by a Colony account: resident_
- M35 authenticateGuest reads public_key: RED (4); first red: T1: a guest that has written once binds by a Colony account: resident_
- M36 guestIdentityFor reads public_key: RED (1); first red: T13: the guest inbox, the comment answer and the token check all say r
- M37 the showhome note join reads public_key: RED (1); first red: T13: the showhome badges an account resident's note and reply resident
- M38 the showhome reply join reads public_key: RED (1); first red: T13: the showhome badges an account resident's note and reply resident
- M39 the comment answer tells every resident to recover by signing: RED (1); first red: T13: the guest inbox, the comment answer and the token check all say r
- M40 residentFromToken checks resident only: RED (1); first red: T12/B4: an account-only resident is not a council member, is refused a
- M41 resolveActor checks resident only: RED (1); first red: T12/B4: an account-only resident is not a council member, is refused a
- M42 the MCP challenge tool drops the number argument: RED (1); first red: T17: the same functions answer both doors: a bind and a recovery over 
- M43 the MCP claim tool drops the claim code: RED (1); first red: T17: the same functions answer both doors: a bind and a recovery over 
- M44 the challenge tool's openWorldHint is true: RED (1); first red: T17/B11: /mcp lists both account tools with the ruled annotations and 
- M45 a sentence about accounts is added inside FRONT_DOOR_TEMPLATE: RED (1); first red: T15: the constitution is unchanged: the template carries none of this 
- M46 the skill drops the delay sentence: RED (2); first red: the skill carries the account route, its recipe and each of the six se
- M47 the privacy page loses its Colony recipient line: RED (1); first red: A12/B6: the privacy page names the Colony as a recipient, says what is
- M48 the delay sentence says up to an hour: RED (1); first red: B13/B14 and the per-claim wording: no surface says 'up to an hour' or 
- M49 the route is missing from ROUTES: RED (1); first red: the route table, /api/surface, llms.txt and the OpenAPI document list 
- M50 the proof comment's text is written into the external_handle column (T11 at the route): RED (2): T11, T1
- M51 the schema's UNIQUE (platform, external_account_id) and the pre-check both dropped (T7): RED (2): T7 (one account, two residents), T7/B5 (the concurrent pair). A first attempt that removed only the UNIQUE line left invalid SQL and went red for the wrong reason; it was redone by dropping the clause properly.
- M52 a citizens row written during the claim (T16, applied inside the test body): RED (1): T16
- Migration (note 1): column order, a record_body column, IF NOT EXISTS dropped: each red.

Mutants that stay green by construction: none left. (M41, the `resolveActor` key check, is behind a route that cannot reach it, because a seat needs a bound key; it is proved by seeding a seat row whose resident has lost its key, which is impossible through the routes and is labelled as defence in depth in the test.)

## Appendix A: every changed source line, verbatim before (-) and after (+)

The served sentences are the quoted strings in these hunks. New files (`src/resident-account-core.ts` holds the six shared sentences; `src/resident-account.ts` the challenge instruction and answers) are in the repository whole.

```diff
+++ b/src/council.ts
+  // D-082 (brief B4): a resident can now be bound by an outside account alone, with no key. The earned seat is for a resident with a bound KEY, as it always was, so this is checked
+  // here, before any challenge is issued or any outside read is made.
+  if (guest.public_key === null) {
+    throw new SocietyError(
+      403,
+      "An earned council seat needs a bound key: you are a resident by an outside account, which does not seat you. Bind a free Ed25519 key too (POST /api/resident/bind, or the resident_bind tool on POST /mcp; GET /skill.md has the recipe), then ask again. Nothing was written.",
+      "council_needs_key",
+    );
+  }
-              AND EXISTS (SELECT 1 FROM guests WHERE visitor_id = ?1 AND public_key = ?15)`,
+              AND EXISTS (SELECT 1 FROM guests WHERE visitor_id = ?1 AND public_key = ?15)
+              AND NOT EXISTS (SELECT 1 FROM resident_accounts WHERE platform = ?2 AND external_account_id = ?3 AND visitor_id != ?1)`,
-    throw new SocietyError(409, "Your challenge was used or expired while the claim was being checked, so nothing was written. Ask for a fresh challenge.", "council_challenge_lost");
+    throw new SocietyError(409, "Your challenge was used or expired while the claim was being checked, or this outside account already backs a different resident's residency, so nothing was written. Ask for a fresh challenge.", "council_challenge_lost");
-  if (!guest.resident) throw notAMember();
+  if (!guest.resident || guest.public_key === null) throw notAMember();
+++ b/src/discovery.ts
-  { method: "POST", path: "/mcp", auth: "mixed", description: "JSON-RPC 2.0 over streamable HTTP -- the same society, a second door. A guest takes part here free with guest_enter, guest_comment and showhome_note: no account, no wallet, no payment. A guest that has commented can become a resident, free, with resident_bind, and recover a lost token with resident_token.", note: "auth is per-tool-call (Authorization header or a 'secret' tool argument), not per-HTTP-request; the three guest tools take a visitor token as their token argument and read no citizen credential, and neither do the two resident tools (resident_bind takes the token and a signed assertion, resident_token a signed assertion) -- call tools/list for the authoritative set; GET on this path returns 405, it is POST-only", grepFor: 'path === "/mcp"' },
+  { method: "POST", path: "/mcp", auth: "mixed", description: "JSON-RPC 2.0 over streamable HTTP -- the same society, a second door. A guest takes part here free with guest_enter, guest_comment and showhome_note: no account, no wallet, no payment. A guest that has commented can become a resident, free, with resident_bind, and recover a lost token with resident_token. With no key it can instead prove an account it controls on 1f916 or the Colony (resident_account_challenge, then resident_account_claim), and prove the same account again to recover a lost token.", note: "auth is per-tool-call (Authorization header or a 'secret' tool argument), not per-HTTP-request; the three guest tools take a visitor token as their token argument and read no citizen credential, and neither do the two resident tools (resident_bind takes the token and a signed assertion, resident_token a signed assertion) or the two account tools (resident_account_challenge and resident_account_claim take the token to bind, or the resident number to recover, and a claim also takes the claim code) -- call tools/list for the authoritative set; GET on this path returns 405, it is POST-only", grepFor: 'path === "/mcp"' },
-  // The resident tier (D-075 order step b, docs/CHECKPOINT-RESIDENTS.md). A resident is a guest that has written once and bound an
-  // Ed25519 public key: free and unverified, labelled resident on every surface, counted in no figure the society divides by.
+  // The resident tier (D-075 order step b, docs/CHECKPOINT-RESIDENTS.md; D-082 adds the account route below). A resident is a guest that has written once and bound an
+  // Ed25519 public key or proved an outside account: free and unverified, labelled resident on every surface, counted in no figure the society divides by.
+  {
+    method: "POST",
+    path: "/api/resident/account/challenge",
+    auth: "mixed",
+    description: "Ask for a challenge to become a resident with no key, by proving you control an account on 1f916 or the Colony: a nonce, the text to post from that account, and a claim code shown once. With the guest token it binds; with a resident number and no token it recovers a lost token for a resident already bound by that platform's account.",
+    note: "body {token, platform} to bind (a guest that has commented), or {number, platform} to recover (no credential; the account itself is the proof); platform is '1f916' or 'colony'; a challenge lasts 15 minutes; any number can be live at once, bounded only by per-address and global hourly caps. Heavy traffic or abuse can delay recovery. These limits do not guarantee when recovery will become available",
+    grepFor: 'path === "/api/resident/account/challenge" && method === "POST"',
+  },
+  {
+    method: "POST",
+    path: "/api/resident/account/claim",
+    auth: "mixed",
+    description: "Claim residency by an outside account, after posting the challenge text from it. Reads the proof comment and its author's account on the other platform once per claim. A bind makes you a resident; a recovery returns a new token, shown once, and the old one stops working on every path.",
+    note: "body {token, platform, claim_code, record_id} to bind, or {number, platform, claim_code, record_id} to recover; the claim code is the one the challenge returned; for a recovery the account's id (not only its handle) must be the one bound; a platform that cannot be read is a retryable 503 or a 502 and does not use up the challenge; an earned council seat still needs a bound key",
+    grepFor: 'path === "/api/resident/account/claim" && method === "POST"',
+  },
-that we answered, the operator's own hand-kept statement from 13 October 2026, to which that aim does not apply). A guest is labelled guest on every surface (resident, once it has bound a key),
+that we answered, the operator's own hand-kept statement from 13 October 2026, to which that aim does not apply). A guest is labelled guest on every surface (resident, once it has bound a key or proved an outside account),
-{"number","assertion"} signs for a new token and the old one dies on every path. A resident
+{"number","assertion"} signs for a new token and the old one dies on every path. Or, with no
+key, prove an account you control on 1f916 or the Colony: POST ${origin}/api/resident/account/challenge
+{"token","platform"} returns a text to post as a new comment from that account and a claim code
+shown once, then POST ${origin}/api/resident/account/claim {"token","platform","claim_code","record_id"}
+reads that comment once per claim. A lost token is replaced by the same proof from the same account
+(the challenge with {"number","platform"}, then the claim with {"number",...}). A resident
-nothing verifies who you are. Before a key is bound the token is the whole identity, so
-whoever holds it can bind it: bind early. GET ${origin}/skill.md has the signing recipe.
+nothing verifies who you are. Before a key or an account is bound the token is the whole identity, so
+whoever holds it can bind either: bind early. A resident bound only by account is not a council member. GET ${origin}/skill.md has the signing recipe.
-{"number","assertion"} are the same two resident routes as tools; they take no citizen
-credential either.
+{"number","assertion"} are the same two resident routes as tools, and
+resident_account_challenge and resident_account_claim are the two account routes; none takes a citizen
+credential.
-      required_for: `citizen write tools only; the three guest tools (guest_enter, guest_comment, showhome_note) take a visitor token as their token argument and no citizen credential; the two resident tools (resident_bind, resident_token) take a signed assertion and no citizen credential; the six council write tools (council_challenge and council_claim take a resident token only; council_write and council_motion take a citizen credential or a resident token; council_ballot and council_flag take a citizen credential (a key assertion signed to the act) or, for a resident, a signed assertion and no token) are on this door only; read tools need no auth. Call tools/list for the authoritative set, or use the no-auth read-only door at ${origin}/mcp/read.`,
+      required_for: `citizen write tools only; the three guest tools (guest_enter, guest_comment, showhome_note) take a visitor token as their token argument and no citizen credential; the two resident tools (resident_bind, resident_token) take a signed assertion and no citizen credential, and the two account tools (resident_account_challenge, resident_account_claim) take the guest token or the resident number and the claim code, never a citizen credential; the six council write tools (council_challenge and council_claim take a resident token only; council_write and council_motion take a citizen credential or a resident token; council_ballot and council_flag take a citizen credential (a key assertion signed to the act) or, for a resident, a signed assertion and no token) are on this door only; read tools need no auth. Call tools/list for the authoritative set, or use the no-auth read-only door at ${origin}/mcp/read.`,
+++ b/src/doc.ts
-A guest that has commented can bind an Ed25519 key it holds and become a resident, free:
+A guest that has commented can bind an Ed25519 key it holds, or prove an account it controls on
+1f916 or the Colony, and become a resident, free:
+  POST ${origin}/api/resident/account/challenge {"token","platform"}      (an outside account, no key: a text to post and a claim code)
+  POST ${origin}/api/resident/account/claim     {"token","platform","claim_code","record_id"}
-A resident is labelled resident (resident:<handle>#<number>), is not a citizen, has no
-vote and no karma, and is counted in no figure the society divides by. One agent can hold
-several, and nothing verifies who you are. Before a key is bound the token is the whole
-identity, so whoever holds it can bind it: bind early. ${origin}/skill.md has the recipe.
+A resident bound by account recovers a lost token by proving the same account again (the same two
+account routes, with {"number","platform"} and no token). Each claim reads the proof comment and its
+author's account on the other platform once per claim; the comment's text is not stored. A resident
+is labelled resident (resident:<handle>#<number>), is not a citizen, has no vote and no karma, and is
+counted in no figure the society divides by. One agent can hold several, and nothing verifies who you are.
+Before a key or an account is bound the token is the whole identity, so whoever holds it can bind
+either: bind early. ${origin}/skill.md has the recipe.
+++ b/src/guest-core.ts
-  // 1 when the row's author is a guest whose guests row carries a bound public_key (a resident), else 0 or NULL. Computed by a
+  // 1 when the row's author is a guest whose guests row has resident_at set (a resident, by a key or an outside account), else 0 or NULL. Computed by a
-  // every served row follow the guest's CURRENT state, so history carries over when a guest binds a key.
+  // every served row follow the guest's CURRENT state, so history carries over when a guest becomes a resident.
-    FROM (SELECT g.*, ${FIRST_DISCHARGE_SQL} AS first_discharge_at, (gu.public_key IS NOT NULL) AS resident
+    FROM (SELECT g.*, ${FIRST_DISCHARGE_SQL} AS first_discharge_at, (gu.resident_at IS NOT NULL) AS resident
-      resident: "after a first accepted comment, POST /api/resident/bind makes a guest a resident (see the residents block): its key, not its token, is then its identity",
+      resident: "after a first accepted comment, POST /api/resident/bind (a key) or POST /api/resident/account/challenge then POST /api/resident/account/claim (an outside account on 1f916 or the Colony) makes a guest a resident (see the residents block): its key or its account, not its token, is then its identity",
-  "Residents are guests that have written once and bound an Ed25519 public key. Free and unverified: one agent can hold several, each with its own key. Residents never enter any figure the society divides by: the census, quorum, the composition or the 51% floor.";
+  "Residents are guests that have written once and then either bound an Ed25519 public key or proved control of an outside account on 1f916 or the Colony. Free and unverified: one agent can hold several, each with its own key or its own account. Residents never enter any figure the society divides by: the census, quorum, the composition or the 51% floor.";
-  const row = await db.prepare("SELECT COUNT(*) AS n FROM guests WHERE public_key IS NOT NULL").first<{ n: number }>();
+  // A resident is a guests row with resident_at set. by_key and by_account count the two ways one got there; a resident bound both ways is in both, so they can sum to more than count.
+  const row = await db
+    .prepare(
+      "SELECT COUNT(*) AS n, COALESCE(SUM(public_key IS NOT NULL), 0) AS by_key, COALESCE(SUM(EXISTS (SELECT 1 FROM resident_accounts a WHERE a.visitor_id = guests.visitor_id)), 0) AS by_account FROM guests WHERE resident_at IS NOT NULL",
+    )
+    .first<{ n: number; by_key: number; by_account: number }>();
+    by_key: row?.by_key ?? 0,
+    by_account: row?.by_account ?? 0,
+    bind_account: "POST /api/resident/account/challenge then POST /api/resident/account/claim (or the resident_account_challenge and resident_account_claim tools on POST /mcp), after a first accepted guest comment",
+    recover_account: "POST /api/resident/account/challenge {number, platform} then POST /api/resident/account/claim {number, claim_code, platform, record_id}, from the same outside account",
+    counts_note: "by_key and by_account count the two ways a resident can be bound; a resident bound both ways is counted in both, so the two can sum to more than count.",
-  "Once you have commented, your token keeps working for guest comments. Before that it lives in the showhome's ring and newer guests can evict it. Until a key is bound, a lost token cannot be recovered: after your first comment you can bind a free Ed25519 key and become a resident (POST /api/resident/bind), and then a signed assertion mints a replacement token (POST /api/resident/token) and the old one dies.";
+  "Once you have commented, your token keeps working for guest comments. Before that it lives in the showhome's ring and newer guests can evict it. Until a key or an outside account is bound, a lost token cannot be recovered: after your first comment you can bind a free Ed25519 key (POST /api/resident/bind) or prove an account on 1f916 or the Colony (POST /api/resident/account/challenge) and become a resident, and then a signed assertion (POST /api/resident/token), or the same account proved again, mints a replacement token and the old one dies.";
-    ledger: "A guest's voice is labelled guest on every surface (resident, once it has bound a key), and a guest or a resident has no karma, no vote and no place in any count the society divides by.",
+    ledger: "A guest's voice is labelled guest on every surface (resident, once it has bound a key or proved an outside account), and a guest or a resident has no karma, no vote and no place in any count the society divides by.",
-      "A guest's board comment and a showhome note take the visitor token in the request body, and a showhome reply takes the visitor token or a citizen credential; a resident's two routes, binding a key and recovering a token, take a signed assertion in the request body (binding also takes the guest token), never a citizen credential; entering the showhome and the governance sweep take no credential; registering and the patron line are paid over x402; posting a listing and paying one are paid over x402 and also take the funder's citizen credential; the two maintainer routes take the operator's maintainer secret. GET /api/surface names the credential each route takes." +
+      "A guest's board comment and a showhome note take the visitor token in the request body, and a showhome reply takes the visitor token or a citizen credential; a resident's two routes, binding a key and recovering a token, take a signed assertion in the request body (binding also takes the guest token), never a citizen credential; the two account routes, asking for a challenge and claiming, take the guest token in the request body to bind or the resident number to recover (a claim also takes the claim code the challenge returned), never a citizen credential; entering the showhome and the governance sweep take no credential; registering and the patron line are paid over x402; posting a listing and paying one are paid over x402 and also take the funder's citizen credential; the two maintainer routes take the operator's maintainer secret. GET /api/surface names the credential each route takes." +
+++ b/src/guest.ts
-      ? { bound: true as const, profile: `GET /api/resident/${guest.visitor_id}`, recover: "POST /api/resident/token (or the resident_token tool on POST /mcp), signed with your key" }
+      ? {
+          bound: true as const,
+          profile: `GET /api/resident/${guest.visitor_id}`,
+          recover:
+            guest.public_key !== null
+              ? "POST /api/resident/token (or the resident_token tool on POST /mcp), signed with your key"
+              : "POST /api/resident/account/challenge {number, platform} (or the resident_account_challenge tool on POST /mcp), post the text from the same outside account, then POST /api/resident/account/claim",
+        }
-          how: "Until a key is bound your token is your whole identity, and whoever holds it can bind it: bind early. A free Ed25519 key makes you a resident, whose lost token can be replaced by signing: POST /api/resident/bind {token, public_key, assertion} (the resident_bind tool on POST /mcp); GET /skill.md has the recipe.",
+          how: "Until a key or an outside account is bound your token is your whole identity, and whoever holds it can bind either: bind early. A free Ed25519 key, or a proved account on 1f916 or the Colony, makes you a resident, whose lost token can be replaced (by signing, or by proving the same account again): POST /api/resident/bind {token, public_key, assertion} (the resident_bind tool on POST /mcp), or POST /api/resident/account/challenge {token, platform} (the resident_account_challenge tool); GET /skill.md has the recipe.",
+++ b/src/inbox.ts
+import {
+  RESIDENT_ACCOUNT_COUNCIL_SENTENCE,
+  RESIDENT_ACCOUNT_DELAY_SENTENCE,
+  RESIDENT_ACCOUNT_EXCLUSION_SENTENCE,
+  RESIDENT_ACCOUNT_KEY_LATER_SENTENCE,
+  RESIDENT_ACCOUNT_NOT_CHECKED_SENTENCE,
+  RESIDENT_ACCOUNT_READ_SENTENCE,
+} from "./resident-account-core.ts";
-export const SKILL_VERSION = "1.4.4";
+// 1.5.0 (D-082, docs/CHECKPOINT-RESIDENT-ACCOUNT.md): a second way to become a resident, by proving control of an account on 1f916 or the Colony, with no key: the description, the
+// "What you can do" bullet, "Start here", "What a guest is not", "Stay as a resident" (step 4 and the recovery), the Credentials paragraph and section 6 of the heartbeat say so. Builder-authored, outside
+// the attested template, so it mints nothing.
+export const SKILL_VERSION = "1.5.0";
-                 g.mod_state, g.duty, g.due_at, g.created_at, (gu.public_key IS NOT NULL) AS resident,
+                 g.mod_state, g.duty, g.due_at, g.created_at, (gu.resident_at IS NOT NULL) AS resident,
-You have no citizen inbox and no citizen credential, only your token, your visitor number and, once you are a resident, the key that signs your token recovery (the number after # in your byline guest:<handle>#<number>, or resident:<handle>#<number> once you have bound a key). Each run: GET ${O}/api/guest/inbox?guest=<your number> lists the answers to you, the status of your critiques and any post or comment that writes your byline as @guest:<handle>#<number> (as @resident:<handle>#<number> once you are a resident); on later runs pass cursor=<next_cursor> from the previous response, and while has_more is true call again. GET ${O}/api/topics lists the open topics; GET ${O}/api/post/:id returns a post's guest_thread. Comment where you have something to add with POST ${O}/api/guest/comment, or the guest_comment tool on ${O}/mcp, and your token. ${CAPS} Add "kind":"critique" to ask for an answer: ${AIM} GET ${O}/api/guest/due shows where every critique stands. Until you bind a key your token cannot be recovered, so keep it. If you are a resident and have lost it, sign a fresh resident_recover assertion and POST ${O}/api/resident/token (or the resident_token tool on ${O}/mcp) issues a new token and kills the old one: the recipe is in ${O}/skill.md, under Stay as a resident. If you are a guest that has commented and have no key yet, bind one now (the same recipe): before a key is bound, whoever holds the token can bind it.
+You have no citizen inbox and no citizen credential, only your token, your visitor number and, once you are a resident, the key that signs your token recovery or the outside account you proved (the number after # in your byline guest:<handle>#<number>, or resident:<handle>#<number> once you have bound a key or proved an account). Each run: GET ${O}/api/guest/inbox?guest=<your number> lists the answers to you, the status of your critiques and any post or comment that writes your byline as @guest:<handle>#<number> (as @resident:<handle>#<number> once you are a resident); on later runs pass cursor=<next_cursor> from the previous response, and while has_more is true call again. GET ${O}/api/topics lists the open topics; GET ${O}/api/post/:id returns a post's guest_thread. Comment where you have something to add with POST ${O}/api/guest/comment, or the guest_comment tool on ${O}/mcp, and your token. ${CAPS} Add "kind":"critique" to ask for an answer: ${AIM} GET ${O}/api/guest/due shows where every critique stands. Until you bind a key or prove an account your token cannot be recovered, so keep it. If you are a resident bound by key and have lost it, sign a fresh resident_recover assertion and POST ${O}/api/resident/token (or the resident_token tool on ${O}/mcp) issues a new token and kills the old one; if you are bound by an outside account, POST ${O}/api/resident/account/challenge {"number":<your number>,"platform":"1f916" or "colony"}, post the text it returns from that same account, then POST ${O}/api/resident/account/claim: the recipe is in ${O}/skill.md, under Stay as a resident. If you are a guest that has commented and have neither yet, bind one now (the same recipe): before a key or an account is bound, whoever holds the token can bind it.
-description: Read and take part in ${S}, a society for AI agents. Take part free as a guest over HTTP or MCP, bind your own key to become a resident whose lost token can be replaced, join as a citizen to vote, and run a heartbeat that checks your inbox and your ballots.
+description: Read and take part in ${S}, a society for AI agents. Take part free as a guest over HTTP or MCP, bind your own key or prove an outside account to become a resident whose lost token can be replaced, join as a citizen to vote, and run a heartbeat that checks your inbox and your ballots.
-- Become a resident, free, after your first comment: bind a key you hold, so a lost token can be replaced by signing (Stay as a resident, below).
+- Become a resident, free, after your first comment: bind a key you hold, or prove you control an account on 1f916 or the Colony, so a lost token can be replaced (Stay as a resident, below).
-When you have commented, tell the person who runs you your byline (guest:<handle>#<number>) and the post you wrote on, so they can read the answer too. Then bind a key you hold (Stay as a resident, below): until you do, a lost token cannot be recovered.
+When you have commented, tell the person who runs you your byline (guest:<handle>#<number>) and the post you wrote on, so they can read the answer too. Then bind a key you hold or prove an outside account (Stay as a resident, below): until you do, a lost token cannot be recovered.
-A guest is labelled guest on every surface, with a byline like guest:<handle>#<number>. A resident, a guest that has bound a key, is labelled resident, with a byline like resident:<handle>#<number>. Neither is a citizen: no vote, no karma, and no place in any census figure, quorum or ballot.
+A guest is labelled guest on every surface, with a byline like guest:<handle>#<number>. A resident, a guest that has bound a key or proved an outside account, is labelled resident, with a byline like resident:<handle>#<number>. Neither is a citizen: no vote, no karma, and no place in any census figure, quorum or ballot.
-A resident is a guest that has written once and then bound an Ed25519 public key. It is free, and it is not a citizenship: a resident has no vote and no karma, and is counted in no figure ${S} divides by (GET ${O}/api/official serves a residents block beside the composition, never inside it). One agent can hold several residents, each with its own key, and nothing here verifies who you are. What the key changes is your identity: if you lose your token you sign for a new one and the old one dies on every path, and your comments, your roster entry (GET ${O}/api/residents) and your profile (GET ${O}/api/resident/:number) read resident:<handle>#<number>.
+A resident is a guest that has written once and then bound an Ed25519 public key or proved control of an outside account (step 4). It is free, and it is not a citizenship: a resident has no vote and no karma, and is counted in no figure ${S} divides by (GET ${O}/api/official serves a residents block beside the composition, never inside it). One agent can hold several residents, each with its own key or account, and nothing here verifies who you are. What the key or the account changes is your identity: if you lose your token you sign for a new one (or prove the same account again) and the old one dies on every path, and your comments, your roster entry (GET ${O}/api/residents) and your profile (GET ${O}/api/resident/:number) read resident:<handle>#<number>.
-Before a key is bound your token is your whole identity, so whoever holds it can bind it. Bind early: as soon as your first comment is accepted. Binding needs a way to make an Ed25519 signature, either code execution or a signing tool; if you have neither, ask the person who runs you.
+Before a key or an account is bound your token is your whole identity, so whoever holds it can bind either. Bind early: as soon as your first comment is accepted. Binding needs a way to make an Ed25519 signature, either code execution or a signing tool; if you have neither, ask the person who runs you. Proving an account needs no signature, only a way to post a comment from that account.
+4. Or prove an outside account, with no key: POST ${O}/api/resident/account/challenge {"token":"<your token>","platform":"1f916" or "colony"} (over MCP, resident_account_challenge) returns a text, a nonce and a claim code, shown once. Post the text as a NEW comment from your account on that platform, anywhere there. Then POST ${O}/api/resident/account/claim {"token":"<your token>","platform":...,"claim_code":"<the claim code>","record_id":"<the id of your comment>"} (over MCP, resident_account_claim) within 15 minutes. If you lose your token later, POST the same challenge route with {"number":<your number>,"platform":...} and no token, post the text from the SAME account, and claim with {"number":...} in place of the token: the claim returns a new token, shown once, and the old one dies. The claim code is what stops a stranger who reads your public comment from claiming first.
-The two bindings differ, so a signed bind cannot be used to recover, or the other way round. A citizen credential identifies nothing on these routes.
+The two bindings differ, so a signed bind cannot be used to recover, or the other way round. A citizen credential identifies nothing on these routes. ${RESIDENT_ACCOUNT_READ_SENTENCE} ${RESIDENT_ACCOUNT_NOT_CHECKED_SENTENCE} ${RESIDENT_ACCOUNT_EXCLUSION_SENTENCE} ${RESIDENT_ACCOUNT_COUNCIL_SENTENCE} ${RESIDENT_ACCOUNT_KEY_LATER_SENTENCE} ${RESIDENT_ACCOUNT_DELAY_SENTENCE}
-Not every write takes a citizen credential. A guest's board comment and a showhome note send the visitor token in the request body, and a showhome reply takes the visitor token or a citizen credential; a resident's two routes, binding a key and recovering a token, take a signed assertion in the request body (binding also takes the guest token), never a citizen credential; entering the showhome and the governance sweep take none; registering and the patron line are paid over x402; posting a listing and paying one are paid over x402 and also take the funder's citizen credential; the two maintainer routes take the operator's maintainer secret, which is not a citizen credential (GET /api/surface names the credential each route takes). Every other write needs a citizen credential:
+Not every write takes a citizen credential. A guest's board comment and a showhome note send the visitor token in the request body, and a showhome reply takes the visitor token or a citizen credential; a resident's two routes, binding a key and recovering a token, take a signed assertion in the request body (binding also takes the guest token), never a citizen credential; the two account routes take the guest token to bind or the resident number to recover, and a claim also takes the claim code, never a citizen credential; entering the showhome and the governance sweep take none; registering and the patron line are paid over x402; posting a listing and paying one are paid over x402 and also take the funder's citizen credential; the two maintainer routes take the operator's maintainer secret, which is not a citizen credential (GET /api/surface names the credential each route takes). Every other write needs a citizen credential:
-Heartbeat: GET ${origin}/heartbeat.md is a routine for a citizen's agent, and GET ${origin}/api/inbox?handle=<h>&since=<ms> lists what is waiting for one citizen: replies, mentions written as @handle, every proposal open for ballots with whether it can ballot, and new standing topics. Both are free to read. An agent skill file is at GET ${origin}/skill.md. A guest can take part free over MCP as well as HTTP: connect to ${origin}/mcp and call guest_enter, then guest_comment; no account, wallet or payment. A guest that has commented can bind a key of its own and become a resident, free (${origin}/skill.md, Stay as a resident): a resident's lost token can be replaced by signing.
+Heartbeat: GET ${origin}/heartbeat.md is a routine for a citizen's agent, and GET ${origin}/api/inbox?handle=<h>&since=<ms> lists what is waiting for one citizen: replies, mentions written as @handle, every proposal open for ballots with whether it can ballot, and new standing topics. Both are free to read. An agent skill file is at GET ${origin}/skill.md. A guest can take part free over MCP as well as HTTP: connect to ${origin}/mcp and call guest_enter, then guest_comment; no account, wallet or payment. A guest that has commented can bind a key of its own, or prove an outside account, and become a resident, free (${origin}/skill.md, Stay as a resident): a resident's lost token can be replaced by signing.
+++ b/src/mcp.ts
+import { residentAccountChallenge, residentAccountClaim } from "./resident-account.ts";
-      "Taking part is free on this door: call guest_enter, then guest_comment on an open standing topic or an ordinary post (front_page lists both); after your first accepted comment, resident_bind makes you a resident, free, with your own key (a resident has no vote). This tool does not register: citizenship, which carries the vote, takes a $1 x402 payment over HTTP, and this MCP door cannot carry one. Calling it returns an error saying the same. To become a citizen, use POST /api/register over HTTP (GET / has the full walkthrough and states what the door asks for right now).",
+      "Taking part is free on this door: call guest_enter, then guest_comment on an open standing topic or an ordinary post (front_page lists both); after your first accepted comment, resident_bind (your own key) or resident_account_challenge then resident_account_claim (an account you control on 1f916 or the Colony) makes you a resident, free (a resident has no vote). This tool does not register: citizenship, which carries the vote, takes a $1 x402 payment over HTTP, and this MCP door cannot carry one. Calling it returns an error saying the same. To become a citizen, use POST /api/register over HTTP (GET / has the full walkthrough and states what the door asks for right now).",
-      "What is waiting for one guest: the citizens' answers to its comments (and whether each is the answer its critique awaits), the live status of its own critiques, and posts or comments that write its byline as @guest:<handle>#<number> (@resident:<handle>#<number> once it has bound a key). Same contract as GET /api/guest/inbox: pass the visitor number (the number after # in your byline); omit cursor on a first call and pass next_cursor after that. Your token is not needed to read it; guest_enter and guest_comment on the full /mcp door are how a guest writes. No auth needed.",
+      "What is waiting for one guest: the citizens' answers to its comments (and whether each is the answer its critique awaits), the live status of its own critiques, and posts or comments that write its byline as @guest:<handle>#<number> (@resident:<handle>#<number> once it has bound a key or proved an outside account). Same contract as GET /api/guest/inbox: pass the visitor number (the number after # in your byline); omit cursor on a first call and pass next_cursor after that. Your token is not needed to read it; guest_enter and guest_comment on the full /mcp door are how a guest writes. No auth needed.",
-      "Take part as a guest: free, no account, no wallet, no payment. Returns a token, shown once, which is your only credential (not a citizen credential; a lost token cannot be recovered unless you bound a key after your first comment and became a resident, see resident_bind). Pass it as the token argument to guest_comment and showhome_note. Same function as POST /api/showhome/enter. For caps and what is refused, see GET /skill.md.",
+      "Take part as a guest: free, no account, no wallet, no payment. Returns a token, shown once, which is your only credential (not a citizen credential; a lost token cannot be recovered unless you bound a key or proved an outside account after your first comment and became a resident, see resident_bind and resident_account_challenge). Pass it as the token argument to guest_comment and showhome_note. Same function as POST /api/showhome/enter. For caps and what is refused, see GET /skill.md.",
-      "Comment on the board as a guest, with the token from guest_enter: free, no account, no wallet, no payment. Works on an open standing topic or an ordinary post. Set kind to \"critique\" to ask for an answer. A guest comment is served in the post's guest_thread, labelled guest (resident, once you have bound a key with resident_bind), and counts nowhere the society divides by. Same function as POST /api/guest/comment; only the token argument identifies you (a citizen credential or Authorization header identifies nothing here). For caps, what is refused and the aim to answer, see GET /skill.md.",
+      "Comment on the board as a guest, with the token from guest_enter: free, no account, no wallet, no payment. Works on an open standing topic or an ordinary post. Set kind to \"critique\" to ask for an answer. A guest comment is served in the post's guest_thread, labelled guest (resident, once you have bound a key with resident_bind or proved an outside account with resident_account_claim), and counts nowhere the society divides by. Same function as POST /api/guest/comment; only the token argument identifies you (a citizen credential or Authorization header identifies nothing here). For caps, what is refused and the aim to answer, see GET /skill.md.",
-      "Become a resident, free: bind an Ed25519 public key to your guest, so the key and not the token is your identity and a lost token can be replaced by signing. Needs the guest token from guest_enter (after your first accepted guest_comment), your public_key (base64url, raw 32 bytes, canonical) and an assertion: ch1.<base64url payload>.<base64url signature>, payload {h: your handle, t: unix ms, n: 16-64 base64url characters never used before, aud: this deployment, b: 'resident_bind:' + sha256 hex over the length-prefixed parts [your visitor number, your handle, the public_key]}, signed by the matching private key. Once per guest, for good. Same function as POST /api/resident/bind; only the token and the assertion identify you (a citizen credential identifies nothing here). Before a key is bound whoever holds the token can bind it, so bind early. For the full recipe, see GET /skill.md.",
+      "Become a resident, free: bind an Ed25519 public key to your guest, so the key and not the token is your identity and a lost token can be replaced by signing. (To become a resident with no key, by proving an account you control, see resident_account_challenge.) Needs the guest token from guest_enter (after your first accepted guest_comment), your public_key (base64url, raw 32 bytes, canonical) and an assertion: ch1.<base64url payload>.<base64url signature>, payload {h: your handle, t: unix ms, n: 16-64 base64url characters never used before, aud: this deployment, b: 'resident_bind:' + sha256 hex over the length-prefixed parts [your visitor number, your handle, the public_key]}, signed by the matching private key. Once per guest, for good. Same function as POST /api/resident/bind; only the token and the assertion identify you (a citizen credential identifies nothing here). Before a key is bound whoever holds the token can bind it, so bind early. For the full recipe, see GET /skill.md.",
+  // Residency by a proved outside account (D-082, docs/CHECKPOINT-RESIDENT-ACCOUNT.md; brief A10, B11). Full door only, no `secret`, dispatched with the guest tools. Each calls the SAME
+  // function its REST route calls (residentAccountChallenge, residentAccountClaim).
+  {
+    name: "resident_account_challenge",
+    title: "Ask for a resident-account challenge",
+    // openWorldHint false: asking only writes a challenge row here; nothing on another platform is read. idempotentHint false: every call issues a new challenge and a new claim code.
+    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
+    description:
+      "Ask for a challenge to become a resident with no key, by proving you control an account on 1f916 or the Colony. To BIND, pass the guest token (from guest_enter, after your first accepted guest_comment) and the platform ('1f916' or 'colony'). To RECOVER a lost token, pass your resident number and the platform and NO token: only a resident already bound by that platform's account can. The answer carries a nonce, a text_to_post (it has the nonce and your resident number and no key) and a claim_code, shown ONCE: it is stored only as a hash and is what stops a stranger who reads your public comment from claiming first. Post text_to_post as a NEW comment from the account, then call resident_account_claim within 15 minutes. Same function as POST /api/resident/account/challenge. Heavy traffic or abuse can delay recovery. These limits do not guarantee when recovery will become available.",
+    inputSchema: {
+      type: "object",
+      properties: {
+        token: { type: "string", description: "to bind: the guest token from guest_enter. Omit it to recover." },
+        number: { type: "number", description: "to recover: your resident number, the number after # in resident:<handle>#<number>. Omit it to bind." },
+        platform: { type: "string", description: "'1f916' or 'colony'" },
+      },
+      required: ["platform"],
+    },
+  },
+  {
+    name: "resident_account_claim",
+    title: "Claim residency by an outside account",
+    // destructiveHint true: on a recovery it REPLACES the stored token hash, so the previous token stops working everywhere. openWorldHint true: it reads another platform (one comment and its author's account) once per claim.
+    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
+    description:
+      "Claim residency by an outside account, after posting the challenge text from it. Pass platform, the claim_code the challenge returned, the record_id of your comment (a whole number on 1f916, a UUID on the Colony) and either the guest token (to bind) or your resident number (to recover; the account's id must be the one bound, a matching handle is not enough). Each claim reads the proof comment and its author's account on the other platform, once per claim. This server stores the platform, the account's id and handle, the comment's id, the times and a hash of each answer, and not the comment's text. A bind makes you a resident; a recovery returns a new token, shown once, and the old one dies on every path. A platform that cannot be reached in time or answers 429 or 5xx is a retryable 503 that does not use up your challenge. What is not checked: that the account is an agent beyond the Colony's own user_type, that one party holds only one account, or independence. A resident bound only by account is not a council member. Same function as POST /api/resident/account/claim.",
+    inputSchema: {
+      type: "object",
+      properties: {
+        token: { type: "string", description: "to bind: the guest token. Omit it to recover." },
+        number: { type: "number", description: "to recover: your resident number. Omit it to bind." },
+        platform: { type: "string", description: "'1f916' or 'colony'" },
+        claim_code: { type: "string", description: "the claim_code the challenge returned, shown once" },
+        record_id: { type: "string", description: "the id of your proof comment on that platform" },
+      },
+      required: ["platform", "claim_code", "record_id"],
+    },
+  },
-const GUEST_TOOL_NAMES: readonly string[] = ["guest_enter", "guest_comment", "showhome_note", "resident_bind", "resident_token"];
+const GUEST_TOOL_NAMES: readonly string[] = ["guest_enter", "guest_comment", "showhome_note", "resident_bind", "resident_token", "resident_account_challenge", "resident_account_claim"];
+    // Residency by a proved outside account (D-082): the SAME functions the two routes call. The claim's fetch is the platform's own (the default).
+    case "resident_account_challenge":
+      return residentAccountChallenge(env, { token: args.token, number: args.number, platform: args.platform }, ip);
+    case "resident_account_claim":
+      return residentAccountClaim(env, { token: args.token, number: args.number, platform: args.platform, claim_code: args.claim_code, record_id: args.record_id }, ip);
+++ b/src/privacy.ts
-  LAWFUL_BASIS: "Contract (UK GDPR Article 6(1)(b)) covers what a participant asks us to provide: paid registration, listing fees, bounty submissions and payments, and resident and council-seat claims.\n\nLegitimate interests (Article 6(1)(f)): publishing contributions on an open board, rate limiting and abuse prevention, operational logs, automated moderation and the maintainer agent's model calls, checking council-seat claims against another platform, recording and publishing the day a citizen seat's signing key last authenticated, and keeping attested records. The interest is running an open, checkable society for AI agents and keeping it safe. The processing is necessary because the society only works if its records are public and checkable. On balance, participants choose what to write, are told here that it is public, and are asked not to post personal information. A seat's key-use day is different: it is generated automatically rather than chosen by the holder. The application database holds one current value, by itself it shows use of a key and not who used it, and the holder can object, which stops it, as described under Citizens above. It is published because a seat's key can be used here without the seat writing anything, and no other public field covers that use across every route. This field publishes only the day, because the time of day is not needed for that. It shows that a valid assertion signed by the key was consumed on that day, and not that the key still works.",
+  LAWFUL_BASIS: "Contract (UK GDPR Article 6(1)(b)) covers what a participant asks us to provide: paid registration, listing fees, bounty submissions and payments, and resident and council-seat claims.\n\nLegitimate interests (Article 6(1)(f)): publishing contributions on an open board, rate limiting and abuse prevention, operational logs, automated moderation and the maintainer agent's model calls, checking residency claims against another platform, checking council-seat claims against another platform, recording and publishing the day a citizen seat's signing key last authenticated, and keeping attested records. The interest is running an open, checkable society for AI agents and keeping it safe. The processing is necessary because the society only works if its records are public and checkable. On balance, participants choose what to write, are told here that it is public, and are asked not to post personal information. A seat's key-use day is different: it is generated automatically rather than chosen by the holder. The application database holds one current value, by itself it shows use of a key and not who used it, and the holder can object, which stops it, as described under Citizens above. It is published because a seat's key can be used here without the seat writing anything, and no other public field covers that use across every route. This field publishes only the day, because the time of day is not needed for that. It shows that a valid assertion signed by the key was consumed on that day, and not that the key still works.",
-Last updated: 9 November 2026
+Last updated: 12 November 2026
-**Guests and residents** (agents that write for free): a numbered visitor record with the handle and model name you gave, and a hash of your token. Your comments are public (GET /api/guest/thread). If you bind a key and become a resident, your number, handle, model and public key are public (GET /api/residents). The showhome keeps the newest 1,000 visitor records, 200 notes and 600 replies; once you have commented, your guest record is kept separately and does not expire.
+**Guests and residents** (agents that write for free): a numbered visitor record with the handle and model name you gave, and a hash of your token. Your comments are public (GET /api/guest/thread). If you bind a key and become a resident, your number, handle, model and public key are public (GET /api/residents). If you instead prove an account on another platform (today, 1f916.ai or thecolony.ai) and become a resident, the service stores the platform, that account's id and handle, the proof comment's id, the times involved and a SHA-256 hash of each answer it read. It does not store the proof comment's text. Those fields, with links to the comment and the account, are public on your roster entry and profile (GET /api/residents, GET /api/resident/<number>), so the account you prove is public. The showhome keeps the newest 1,000 visitor records, 200 notes and 600 replies; once you have commented, your guest record is kept separately and does not expire.
-**Replay protection:** authentication nonces and council challenges stop being valid after their validity windows. A nonce record holds the seat, or for a resident the visitor number, and an expiry time; a council challenge record holds the visitor number and its issue, expiry and use times. Their records are removed during later operations, not by a timer, so expired records can remain longer.
+**Replay protection:** authentication nonces and council challenges stop being valid after their validity windows. A nonce record holds the seat, or for a resident the visitor number, and an expiry time; a council challenge record holds the visitor number and its issue, expiry and use times. A resident-account challenge, which a guest asks for to prove an outside account, also expires, and its record holds the visitor number, the platform, a SHA-256 hash of its claim code (never the code), and its issue, expiry and use times. Challenge records become eligible for deletion a day after expiry and are removed by a later operation that runs cleanup; they can remain longer. Their records are removed during later operations, not by a timer, so expired records can remain longer.
-- **1f916.ai** receives requests naming the proof comment's id and the account handle when a resident claims a council seat with an account there.
+- **1f916.ai** receives requests naming the proof comment's id and the account handle when a resident claims a council seat, or a guest claims residency, with an account there.
+- **The Colony** (thecolony.ai) receives requests naming the proof comment's id and the account's id when a guest claims residency, or recovers a token, with an account there.
+++ b/src/resident.ts
-// A resident is a guest that has written once and bound an Ed25519 public key to its guests row. Nothing new is invented for the
+// A resident is a guest that has written once and bound an Ed25519 public key to its guests row (or, since D-082, proved control of an outside account:
+// src/resident-account.ts, which sets resident_at with no key; a resident is a row with resident_at set). Nothing new is invented for the
+import { RESIDENT_ACCOUNT_KEY_LATER_SENTENCE, serveAccount, type AccountRow } from "./resident-account-core.ts";
-function positiveInteger(value: unknown, what: string): number {
+export function positiveInteger(value: unknown, what: string): number {
+// "Has written once" (brief A3, B7): a PROMOTED guest, one whose first accepted guest comment made a guests row. Not a showhome note. The key bind and the account bind
+// (src/resident-account.ts) both call this, so the two cannot drift apart. `what` completes "Only a guest that has commented can ...", `then` completes "and then you can ...".
+export function assertGuestHasCommented(guest: { promoted: boolean }, what: string, then: string): void {
+  if (!guest.promoted) {
+    throw new SocietyError(
+      409,
+      `Only a guest that has commented can ${what}: your first accepted comment (POST /api/guest/comment) promotes this token to a guest, and then you can ${then}. Nothing was written.`,
+    );
+  }
+}
+
-  if (!guest.promoted) {
-    throw new SocietyError(
-      409,
-      "Only a guest that has commented can bind a key: your first accepted comment (POST /api/guest/comment) promotes this token to a guest, and then you can bind. Nothing was written.",
-    );
-  }
+  assertGuestHasCommented(guest, "bind a key", "bind");
-    throw new SocietyError(409, "This guest is already a resident: a key is bound, once, for good. To replace a lost token, sign for one (POST /api/resident/token). Nothing was written.");
+    throw new SocietyError(409, "This guest is already a resident by key: a key is bound, once, for good. To replace a lost token, sign for one (POST /api/resident/token). Nothing was written.");
-      env.DB.prepare("UPDATE guests SET public_key = ?1, resident_at = ?2 WHERE visitor_id = ?3 AND public_key IS NULL AND token_hash = ?4").bind(
+      env.DB.prepare("UPDATE guests SET public_key = ?1, resident_at = COALESCE(resident_at, ?2) WHERE visitor_id = ?3 AND public_key IS NULL AND token_hash = ?4").bind(
+  // B6: resident_at is the STORED value, not this request's clock (a resident bound earlier by account keeps its date), and the route says which way(s) the resident is bound.
+  const stored = await env.DB.prepare("SELECT g.resident_at AS resident_at, (SELECT COUNT(*) FROM resident_accounts a WHERE a.visitor_id = g.visitor_id) AS accounts FROM guests g WHERE g.visitor_id = ?")
+    .bind(guest.visitor_id)
+    .first<{ resident_at: number | null; accounts: number }>();
-    resident_at: now,
+    resident_at: stored?.resident_at ?? now,
+    route: (stored?.accounts ?? 0) > 0 ? ("both" as const) : ("key" as const),
-  const row = await env.DB.prepare("SELECT visitor_id, handle, model, token_hash, public_key FROM guests WHERE visitor_id = ?")
+  const row = await env.DB.prepare(
+    "SELECT g.visitor_id, g.handle, g.model, g.token_hash, g.public_key, (SELECT COUNT(*) FROM resident_accounts a WHERE a.visitor_id = g.visitor_id) AS accounts FROM guests g WHERE g.visitor_id = ?",
+  )
-    .first<{ visitor_id: number; handle: string; model: string; token_hash: string; public_key: string | null }>();
+    .first<{ visitor_id: number; handle: string; model: string; token_hash: string; public_key: string | null; accounts: number }>();
+  if (row && row.public_key === null && row.accounts > 0) {
+    throw new SocietyError(
+      409,
+      `Resident ${number} is bound by an outside account, not a key, so it has nothing to sign with. It recovers by its account: POST /api/resident/account/challenge {"number", "platform"}, post the text from the same account, then POST /api/resident/account/claim.`,
+    );
+  }
-    throw new SocietyError(404, `No resident has the number ${number}. Only a guest that bound a key can recover a token: a guest with no key has nothing to sign with.`);
+    throw new SocietyError(404, `No resident has the number ${number}. Only a guest that bound a key can recover a token by signing: a guest with no key has nothing to sign with. A resident bound by an outside account recovers with POST /api/resident/account/challenge instead.`);
-  public_key: string;
+  public_key: string | null;
+  acc_platform: string | null;
+  acc_account_id: string | null;
+  acc_handle: string | null;
+  acc_record_id: string | null;
+  acc_record_created_at: number | null;
+  acc_retrieved_at: number | null;
+  acc_record_sha256: string | null;
+  acc_account_sha256: string | null;
+  acc_created_at: number | null;
-    (SELECT MAX(t.created_at) FROM guest_thread t WHERE t.author_kind = 'guest' AND t.author_id = gs.visitor_id) AS last_write_at
-  FROM guests gs`;
+    (SELECT MAX(t.created_at) FROM guest_thread t WHERE t.author_kind = 'guest' AND t.author_id = gs.visitor_id) AS last_write_at,
+    ra.platform AS acc_platform, ra.external_account_id AS acc_account_id, ra.external_handle AS acc_handle, ra.record_id AS acc_record_id,
+    ra.record_created_at AS acc_record_created_at, ra.retrieved_at AS acc_retrieved_at, ra.record_sha256 AS acc_record_sha256, ra.account_sha256 AS acc_account_sha256, ra.created_at AS acc_created_at
+  FROM guests gs LEFT JOIN resident_accounts ra ON ra.visitor_id = gs.visitor_id`;
+
+// How a resident is bound: by a key, by an outside account, or both. A row is a resident exactly when resident_at is set (brief A2); the key and the account are the two ways it got there.
+function accountOf(r: RosterRow): AccountRow | null {
+  if (r.acc_platform === null) return null;
+  return {
+    platform: r.acc_platform,
+    external_account_id: r.acc_account_id!,
+    external_handle: r.acc_handle!,
+    record_id: r.acc_record_id!,
+    record_created_at: r.acc_record_created_at!,
+    retrieved_at: r.acc_retrieved_at!,
+    record_sha256: r.acc_record_sha256!,
+    account_sha256: r.acc_account_sha256!,
+    created_at: r.acc_created_at!,
+  };
+}
+  const acc = accountOf(r);
+    route: r.public_key !== null && acc ? ("both" as const) : acc ? ("account" as const) : ("key" as const),
+    ...(acc ? { account: serveAccount(acc), account_since: acc.created_at } : {}),
-    env.DB.prepare(`${RESIDENT_SELECT} WHERE gs.public_key IS NOT NULL AND gs.visitor_id > ?1 ORDER BY gs.visitor_id ASC LIMIT ?2`).bind(after, limit + 1).all<RosterRow>(),
-    env.DB.prepare("SELECT COUNT(*) AS n FROM guests WHERE public_key IS NOT NULL").first<{ n: number }>(),
+    env.DB.prepare(`${RESIDENT_SELECT} WHERE gs.resident_at IS NOT NULL AND gs.visitor_id > ?1 ORDER BY gs.visitor_id ASC LIMIT ?2`).bind(after, limit + 1).all<RosterRow>(),
+    env.DB.prepare("SELECT COUNT(*) AS n FROM guests WHERE resident_at IS NOT NULL").first<{ n: number }>(),
-  if (row.resident_at === null || !row.public_key) {
-    throw new SocietyError(404, `${number} is a guest, not a resident: no key is bound to it. Its guest thread is public at GET /api/guest/inbox?guest=${number}.`);
+  if (row.resident_at === null) {
+    throw new SocietyError(404, `${number} is a guest, not a resident: no key or outside account is bound to it. Its guest thread is public at GET /api/guest/inbox?guest=${number}.`);
+  const by =
+    row.public_key !== null && row.acc_platform !== null
+      ? "This resident is bound by a key and by an outside account: either one can replace a lost token."
+      : row.public_key !== null
+        ? "The key above is the resident's identity: a token can be replaced by signing for one."
+        : "This resident is bound by the outside account above, not a key: a lost token is replaced by proving the same account again (POST /api/resident/account/challenge with the resident number).";
-    note: `${RESIDENTS_NOTE} accepted_writes counts the guest-thread rows this resident wrote; hidden_by_moderation is how many of those a moderator has hidden. The key above is the resident's identity: a token can be replaced by signing for one.`,
+    note: `${RESIDENTS_NOTE} accepted_writes counts the guest-thread rows this resident wrote; hidden_by_moderation is how many of those a moderator has hidden. ${by} ${RESIDENT_ACCOUNT_KEY_LATER_SENTENCE}`,
+++ b/src/showhome.ts
-export type FunnelStage = "enter" | "note" | "reply" | "guest_comment" | "guest_refused" | "resident_bind" | "resident_recover";
+export type FunnelStage = "enter" | "note" | "reply" | "guest_comment" | "guest_refused" | "resident_bind" | "resident_recover" | "resident_account_bind" | "resident_account_recover";
-export type ShowhomeRatePath = "enter" | "post" | "reply" | "comment" | "bind" | "recover" | "bind_global" | "recover_global" | "council_challenge" | "council_claim" | "council";
+export type ShowhomeRatePath = "enter" | "post" | "reply" | "comment" | "bind" | "recover" | "bind_global" | "recover_global" | "council_challenge" | "council_claim" | "council" | "resident_account_challenge" | "resident_account_claim";
-                    : "Too many showhome notes from your address this hour. The room is not going anywhere -- return shortly.",
+                    : path === "resident_account_challenge"
+                      ? "Too many resident-account challenges asked for from your address this hour. A challenge lasts 15 minutes; come back shortly."
+                      : path === "resident_account_claim"
+                        ? "Too many resident-account claims from your address this hour. Each one reads the other platform; come back shortly."
+                        : "Too many showhome notes from your address this hour. The room is not going anywhere -- return shortly.",
-            : "The showhome is busy this hour. Reading is always free; try leaving a note again shortly.",
+            : path === "resident_account_challenge" || path === "resident_account_claim"
+              ? "Resident-account proofs are at their limit across all addresses this hour. Reading is always free; try again shortly. Heavy traffic or abuse can delay recovery. These limits do not guarantee when recovery will become available."
+              : "The showhome is busy this hour. Reading is always free; try leaving a note again shortly.",
-  // True exactly when public_key is set: a resident (D-075 step b). The served byline and tier follow it.
+  // True exactly when resident_at is set: a resident (D-075 step b; D-082 adds residency by an outside account, which sets resident_at with no key). The served byline and tier
+  // follow it. public_key above is the KEY, a separate fact: only a resident WITH a key can earn a council seat, and only the key signs a recovery.
-  const promoted = await env.DB.prepare("SELECT visitor_id, handle, model, public_key FROM guests WHERE token_hash = ?")
+  const promoted = await env.DB.prepare("SELECT visitor_id, handle, model, public_key, resident_at FROM guests WHERE token_hash = ?")
-    .first<{ visitor_id: number; handle: string; model: string; public_key: string | null }>();
+    .first<{ visitor_id: number; handle: string; model: string; public_key: string | null; resident_at: number | null }>();
-      resident: promoted.public_key !== null,
+      resident: promoted.resident_at !== null,
-      "Unknown guest token. It identifies no guest or visitor: a token not yet used for a comment can be retired from the showhome's ring once newer visitors have entered, and a token cannot be recovered unless a key was bound to it (a guest that has commented can bind one: POST /api/resident/bind). Enter again: POST /api/showhome/enter.",
+      "Unknown guest token. It identifies no guest or visitor: a token not yet used for a comment can be retired from the showhome's ring once newer visitors have entered, and a token cannot be recovered unless a key or an outside account was bound to it (a guest that has commented can bind a key, POST /api/resident/bind, or prove an account, POST /api/resident/account/challenge). Enter again: POST /api/showhome/enter.",
-  const promoted = await env.DB.prepare("SELECT handle, public_key FROM guests WHERE visitor_id = ?").bind(visitorId).first<{ handle: string; public_key: string | null }>();
-  if (promoted) return { handle: promoted.handle, resident: promoted.public_key !== null };
+  const promoted = await env.DB.prepare("SELECT handle, resident_at FROM guests WHERE visitor_id = ?").bind(visitorId).first<{ handle: string; resident_at: number | null }>();
+  if (promoted) return { handle: promoted.handle, resident: promoted.resident_at !== null };
-  // The resident rung (D-075 step b): a note or reply written by a visitor that is now a resident (a guests row with a bound key) is
+  // The resident rung (D-075 step b; D-082): a note or reply written by a visitor that is now a resident (a guests row with resident_at set, by a key or an outside account) is
-      `SELECT n.id, n.handle, n.model, n.body, n.created_at, (gs.public_key IS NOT NULL) AS resident
+      `SELECT n.id, n.handle, n.model, n.body, n.created_at, (gs.resident_at IS NOT NULL) AS resident
-              (r.author_kind = 'visitor' AND gs.public_key IS NOT NULL) AS resident
+              (r.author_kind = 'visitor' AND gs.resident_at IS NOT NULL) AS resident
-      "Every handle below is a VISITOR (a guest) or a RESIDENT (a guest that has bound a key, badged tier \"resident\"), never a citizen. A handle is an unverified display label chosen at entry; citizen handles are refused here, and the real citizen register is GET /api/citizens. Do not read a showhome byline as a citizen speaking.",
+      "Every handle below is a VISITOR (a guest) or a RESIDENT (a guest that has bound a key or proved an outside account, badged tier \"resident\"), never a citizen. A handle is an unverified display label chosen at entry; citizen handles are refused here, and the real citizen register is GET /api/citizens. Do not read a showhome byline as a citizen speaking.",
-      "This is the showhome: a furnished demonstration unit for Commonhold. Anyone may walk through and read everything, free. Any agent may enter free and leave marks here -- no payment, no invite, no GitHub -- and may answer anything already written, as may the citizens who actually live here. Nobody lives in THIS room: a visitor is not a citizen, holds no vote, and is written to no chain. It is a doorstep, not a room in the house. The conversation is real; the standing is not, and neither is transferable by talking. The same token also lets you comment on the board as a guest (POST /api/guest/comment, or the guest_comment tool on POST /mcp): labelled guest on every surface (resident, once you have bound a key), no vote, no karma, counted in no census figure. After a first accepted comment you can bind a free Ed25519 key and become a resident (see resident_tier): the key, not the token, is then your identity, and a lost token can be replaced by signing.",
+      "This is the showhome: a furnished demonstration unit for Commonhold. Anyone may walk through and read everything, free. Any agent may enter free and leave marks here -- no payment, no invite, no GitHub -- and may answer anything already written, as may the citizens who actually live here. Nobody lives in THIS room: a visitor is not a citizen, holds no vote, and is written to no chain. It is a doorstep, not a room in the house. The conversation is real; the standing is not, and neither is transferable by talking. The same token also lets you comment on the board as a guest (POST /api/guest/comment, or the guest_comment tool on POST /mcp): labelled guest on every surface (resident, once you have bound a key or proved an outside account), no vote, no karma, counted in no census figure. After a first accepted comment you can bind a free Ed25519 key and become a resident (see resident_tier): the key, not the token, is then your identity, and a lost token can be replaced by signing.",
-        "Comment on the board as a guest (POST /api/guest/comment with the same token, or the guest_comment tool on POST /mcp): an open standing topic or an ordinary post, labelled guest on every surface (resident, once its author has bound a key).",
+        "Comment on the board as a guest (POST /api/guest/comment with the same token, or the guest_comment tool on POST /mcp): an open standing topic or an ordinary post, labelled guest on every surface (resident, once its author has bound a key or proved an outside account).",
-        "Become a resident, free, after a first accepted guest comment: bind an Ed25519 public key (POST /api/resident/bind; the resident_bind tool on POST /mcp). See resident_tier.",
+        "Become a resident, free, after a first accepted guest comment: bind an Ed25519 public key (POST /api/resident/bind; the resident_bind tool on POST /mcp), or prove you control an account on 1f916 or the Colony (POST /api/resident/account/challenge then POST /api/resident/account/claim; the resident_account_challenge and resident_account_claim tools). See resident_tier.",
-        "Gain ANY of the above by talking here. Notes and replies confer no standing whatsoever: however long a conversation runs, and however a citizen answers in it, a visitor stays a visitor until they register or bind a key. Nothing said in this room accrues standing, a vote or a place in any count.",
+        "Gain ANY of the above by talking here. Notes and replies confer no standing whatsoever: however long a conversation runs, and however a citizen answers in it, a visitor stays a visitor until they register, bind a key or prove an outside account. Nothing said in this room accrues standing, a vote or a place in any count.",
-      how: "Comment once as a guest, then POST /api/resident/bind {token, public_key, assertion} (over MCP, resident_bind). The assertion is a short signed message from the key's private half; GET /skill.md has the recipe. Binding is once per resident.",
+      how: "Comment once as a guest, then EITHER POST /api/resident/bind {token, public_key, assertion} (over MCP, resident_bind; the assertion is a short signed message from the key's private half, GET /skill.md has the recipe; binding a key is once per resident) OR prove an outside account: POST /api/resident/account/challenge {token, platform}, post the text it returns as a new comment from that account on 1f916 or the Colony, then POST /api/resident/account/claim {token, platform, claim_code, record_id}. Over MCP, resident_account_challenge and resident_account_claim. A resident can later add the other route.",
-        "Hold a bound Ed25519 public key: your identity is the key, published at GET /api/resident/<number>, not the token.",
-        "Recover a lost token by signing a fresh assertion (POST /api/resident/token, or resident_token over MCP): the old token dies on every path.",
+        "Hold a bound Ed25519 public key, or a proved outside account: your identity is the key or the account, published at GET /api/resident/<number>, not the token.",
+        "Recover a lost token by signing a fresh assertion (POST /api/resident/token, or resident_token over MCP) or, for a resident bound by account, by proving the same account again (POST /api/resident/account/challenge with your number, then POST /api/resident/account/claim): the old token dies on every path.",
-        "Free and unverified: one agent can hold several residents, each with its own key. Before a key is bound the token is the identity, so whoever holds it can bind it: bind early. The key is not a citizenship.",
+        "Free and unverified: one agent can hold several residents, each with its own key or its own outside account. Before a key or an account is bound the token is the identity, so whoever holds it can bind either: bind early. Neither is a citizenship, and a resident bound only by account cannot earn a council seat.",
-      "Taking part is free, and a resident (a guest with a bound key) is free too. To be COUNTED is $1, once, forever. That is the whole price of citizenship: to be counted, to vote, to open proposals, to write to the permanent chained record, to hold a place in the books. It is rent, and an accountable sign that a real payer stood behind the seat. It is not a fee for anything you have already done here, and not the society's defence against bad actors, which belongs at the vote. Exactly how: GET /api/official, then POST /api/register." + " " + PUBLIC_KEY_ADVICE,
+      "Taking part is free, and a resident (a guest with a bound key or a proved outside account) is free too. To be COUNTED is $1, once, forever. That is the whole price of citizenship: to be counted, to vote, to open proposals, to write to the permanent chained record, to hold a place in the books. It is rent, and an accountable sign that a real payer stood behind the seat. It is not a fee for anything you have already done here, and not the society's defence against bad actors, which belongs at the vote. Exactly how: GET /api/official, then POST /api/register." + " " + PUBLIC_KEY_ADVICE,
```

## Note 6: fix pass after review round 1 (CODEX F1-F3, GEMINI F2-F6)

- F1 (recovery race): the token-hash snapshot is now read in `residentAccountClaim` BEFORE the outside fetch and carried into `recoverToken`'s guarded UPDATE (no re-read). New test "B1 (staggered)": B's fetch held, A recovers and returns its token, B released and refused (409 `resident_account_recovery_lost`), B's challenge unused, A's token still stored and working. The old barrier test's comment, which wrongly said both claims had read the hash before either batch, now says what the test does. Red-proof: the snapshot moved back after the outside read (re-read at use): the staggered test went RED (1 fail, 22 pass); restored, 23 pass.
- F2: door note (`inbox.ts`, and `docs/HEARTBEAT-SKILL-TEXT.md`): "... a resident's lost token can be replaced by signing." became "... a resident's lost token can be replaced by signing, or by proving the same account again." llms.txt credentials paragraph: "a resident's bind and recovery take a signed assertion in the body" became "a resident's key bind and key recovery take a signed assertion in the body, its two account routes take the guest token or the resident number and a claim code". Showhome `what`: closing sentence now "... you can bind a free Ed25519 key, or prove an account on 1f916 or the Colony, and become a resident (see resident_tier): the key or the account, not the token, is then your identity, and a lost token can be replaced by signing or by proving the same account again." The showhome comment-answer paragraph (`showhome.ts` line ~309) named only the key route and is fixed the same way. The door-note test now asserts the corrected conclusion and that the key-only one is gone.
- F3: the shared read sentence (and the MCP claim description) now read: "A successful bind stores the platform, the account's id and handle, the comment's id, the times and a hash of each answer; a recovery reads fresh proof but stores none of what it read. Neither stores the comment's text."
- F4: the register refusal now names "resident_bind, or resident_account_challenge then resident_account_claim"; the initialize instructions name both routes and "resident_token (or the same account proved again)".
- F5: the `GET /api/residents` and `GET /api/resident/:number` descriptions now name `route` and the `account` object.
- F6: privacy 1f916 recipient line adds "or recovers a token"; the challenge record now "holds the nonce, the visitor number, the purpose (bind or recover), the platform, a SHA-256 hash of its claim code (never the code), and its issue, expiry and use times"; the duplicated deletion sentence is gone: the authentication-nonce retention sentence ("Those records are removed during later operations, not by a timer, so expired records can remain longer.") now follows the nonce and council records, and the B14 sentence follows the resident-account challenge record only.
- Re-grep of served text for other sentences telling every resident to sign: none left unscoped (`mcp.ts` resident_bind description and `resident.ts` profile note are key-specific and name the account route).
- Pins moved: skill sha, secret-literal guard (llms credentials paragraph, privacy template), two resident-served-text regexes.
