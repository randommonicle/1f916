# D-018 gate brief: the server-side wallet pin (money path)

You are the D-018 Opus gate for a money-path wave of Commonhold, a public AI-agent society
(Cloudflare Worker + D1, USDC on Base via x402). Your verdict decides whether the operator may
deploy. Assume the wave is broken and find where. An approval is worth nothing; a reproducible
defect, cited to file:line with a concrete failure scenario, is worth everything. If an area is
genuinely clean, say so plainly rather than manufacturing a finding.

## Target

- Worktree: `C:\Users\bengr\Projects\AI domain and social network\scratch\wt-wallet-pin`
- Branch `wallet-pin-2026-09-24`; base `4066677c`. See the change with
  `git -C "<worktree>" diff 4066677c..HEAD` and `git -C "<worktree>" log --oneline 4066677c..HEAD`.
  Use `git -C` on the worktree for every git command; never `cd` into or touch the main checkout at
  `...\society` except to READ the format reference below.
- Design: `docs/BRIEF-SERVER-SIDE-WALLET-PIN.md` in the worktree. Its "Amendments after exchange
  round 1" (A1-A9) OVERRIDE the body where they conflict.
- Build record: `docs/CHECKPOINT-WALLET-PIN.md` in the worktree (every commit's claims, deviations,
  red-proofs, the prod dry run and the scratch rehearsal).
- Operator rulings (binding): the pin is REQUIRED on every pay request; A4's local x402 payload
  check ships in the same wave and covers every caller of `payAndSettle`.

## Files to read (exact paths, in the worktree)

- `src/listings.ts`: `parseWalletPin`, `assertWalletPinCurrent`, `handlePayListing` (the reservation
  UPDATE, the release, the 502 path, the paid batch, the 500 path, the success body),
  `getListingDetail` (A7 `payee_wallet_row`, A6 served pair), `listingPaymentsPage`, the notes
  `WALLET_ROW_BOOK_NOTE` / `PAYEE_WALLET_ROW_NOTE`, `listingsGuide` step 4.
- `src/x402.ts`: `assertPayloadMatchesRequirements` and its call inside `payAndSettle` (callers:
  `handlePatron` in the same file, `src/register-gate.ts`, `handleCreateListing` and
  `handlePayListing` in `src/listings.ts`).
- `src/society.ts` (`SocietyError.code`, `errorBody`), `src/index.ts` (the catch that serialises
  errors), `src/wallets.ts` (`walletAddressFromRow`, `walletLogEntry`, `declareWallet`, `walletFor`).
- `migrations/0016_wallet_pin.sql`, `schema.sql` (listings and listing_payments).
- `src/discovery.ts` (the pay route entry; `llms.txt` is built from it).
- `scripts/pay-listing.mjs` (the operator's pay script) and `scripts/deploy-wallet-pin.ps1`.
- Tests: `test/wallet-pin-d1.test.ts`, `test/wallet-pin-route-d1.test.ts`, `test/x402.test.ts`,
  `test/register-gate-d1.test.ts`, `test/listings-d1.test.ts`, `test/listings-policing.test.ts`,
  `test/pay-listing.test.ts`, `test/helpers/wallet-pin.ts`, `test/helpers/x402-payload.ts`.

## Questions you must answer (each with evidence)

1. Can any path settle money to an address other than the one the pinned wallet row names? Walk
   check 1, the requirements, A4, the reservation, and settlement.
2. Can a stale, foreign or tampered pin pass check 1 or check 2? Consider races between check 1
   and the reservation, and the two non-atomic wallet writes in `declareWallet`.
3. Does A4 refuse any LEGITIMATE payer on any of the four routes? Consider checksum-cased
   addresses (is `env.TREASURY_ADDRESS` in `wrangler.jsonc` checksummed?), value types, and what the
   operator's own scripts (`scripts/register-maintainer.mjs` `buildAuthorization`,
   `scripts/lobby-sponsor.mjs`, `scripts/post-listing.mjs`, `scripts/pay-listing.mjs`) send.
4. Is every served sentence true of the code: the two notes, the guide's step 4, the discovery
   entry, the 502 message, and the error messages' "Nothing was issued or settled" claims?
5. A6: is the checked pair recorded, kept and cleared correctly on EVERY exit (release, paid, 502,
   500)? What does `GET /api/listing/:id` serve for a listing left `paying` by the 500 path?
6. The deploy script: order (0016 strictly before the worker), fail-fast on every step, partial
   states, PowerShell 5.1 traps (case-insensitive variable names, `-notmatch` on arrays filtering
   instead of testing, one-element results), and the refusal-only ride (is the bearer ever
   printed or logged; is the POST truly refused before any state change other than the throttle's
   record-first row).
7. Tests: can each new test fail when its guarded behaviour breaks? Name any vacuous assertion.
8. Anything the brief requires that the build does not do, or does differently without saying so.

## Constraints (hard)

- READ-ONLY on the repo and on every live system. No git writes (no commit, no branch, no stash),
  no push, no deploy, no `wrangler` command of any kind, no network calls to the live site. You may
  run `npm test` and `npm run typecheck` inside the worktree.
- NEVER read any file whose name contains `.local.` anywhere on this machine, even filtered. They
  are custody files.
- Write exactly ONE file: `docs/REVIEW-WALLET-PIN-GATE-2026-09-24.md` in the worktree. Do not commit
  it; the hub reviews and commits it.
- Format reference (read only): `C:\Users\bengr\Projects\AI domain and social network\society\docs\REVIEW-STANDING-TOPICS-GATE-2026-09-22.md`.

## Output

The record opens with a one-line verdict: DEPLOYABLE, DEPLOYABLE WITH CONDITIONS (list each
condition), or NOT DEPLOYABLE. Then findings, most severe first, each with: severity
(HIGH/MEDIUM/LOW), file:line, the defect in one sentence, a concrete failure scenario (inputs or
state leading to a wrong outcome), whether you reproduced it (a test you ran, or reasoning only),
and the smallest fix. Then a short section answering questions 1-8 in order. Then what you did NOT
check. Your final message back is a summary of the verdict and the findings with their file:line.
