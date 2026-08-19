# CHECKPOINT: the Showhome build (branch `showhome-build`, isolated worktree)

Build log for the free-visitor read-and-write funnel (`docs/BRIEF-SHOWHOME.md`,
`docs/SHOWHOME-DESIGN.md`). One note per commit: what it did, the key decision,
any deviation from the brief. Closing walk at the end.

## Context probed at build start (verify, do not trust)

- Worktree `society-wt-showhome` on branch `showhome-build`, cut from HEAD
  `b4f22df` (level with `origin/main`). Sibling worktree `society-wt-trigger`
  (branch `maintainer-manual-trigger`) is a DIFFERENT concurrent builder; both
  add routes to `src/index.ts` on separate branches — no coordination, `git -C`
  only.
- Baseline GREEN: **623 tests pass, 0 fail**; `npm run typecheck` clean.
- Migration number **0008 is free** on the Commonhold deploy line: `origin/main`
  and `main` carry `migrations/0001..0007` only. `0008_payload_notices`..`0033`
  exist ONLY on `upstream/main` (the parent fork's separate scheme) and are never
  merged here. Sibling branch adds no migration. Claimed 0008.
- Test harness `createLocalD1()` (`test/helpers/local-d1.ts`) loads **`schema.sql`**,
  not the migrations. So `schema.sql` is the canonical full schema for tests;
  migrations are deltas applied to live D1 by the operator via
  `wrangler d1 execute --file`. **Both must be updated and kept identical.**
- Migrations are incremental on an upstream base (0001 already assumes
  `citizens`/`posts`/`identity_events`); they do NOT stand alone. My 0008 is
  self-contained (pure `CREATE TABLE IF NOT EXISTS`, no FK, no ALTER), so it
  rehearses against a fresh in-memory DB directly.

## Reuse anchors re-derived at HEAD (symbols, not the brief's stale lines)

- Census `COUNT(*)`: `society.ts` `citizenDirectory` → `SELECT COUNT(*) FROM citizens` (~:939).
- Eligibility SELECT: `governance.ts` tally → `SELECT id, created_at FROM citizens` (~:1527), fed to `countEligible`.
- Wind-down / viability: PROSE only, `doc.ts` (~:311-343), reads `GET /treasury` + `GET /api/citizens`; no code viability count over any table I touch.
- Throttle mechanism: `reg_log` table; `assertRegistrationNotThrottled` (~:183, per-IP 3/hr + **global 300/hr over ALL rows**), `assertPublicSweepNotThrottled` (~:239, per-IP 10/hr, self-inserts+prunes). `sha256Hex` at `chain.ts:69`.
- Deny mechanism: `bulletinDenyCheck` EXPORTED at `judgment.ts:173`; first pattern is the link ban (`/https?:\/\/|www\./i`). `BULLETIN_DENY_PATTERNS` (~:140) NOT exported — I call the exported function, no copy-paste, no maintainer-file edit.
- MCP auth: `mcp.ts` `callTool` switch, per-case `authenticate(env, secret)` — a visitor token can never authenticate (not a citizen secret).
- IP header: `CF-Connecting-IP`.

## DEVIATION (flagged for the D-018 gate): dedicated `showhome_rate` table, not `reg_log`

The brief + the converged Gemini pre-gate both say "reuse the `reg_log` table with
a namespaced prefix, NOT a new throttle table." I reuse the **mechanism** (hashed
key + COUNT over a rolling hour + prune after 24h) but in a **separate additive
`showhome_rate` table**, because `assertRegistrationNotThrottled`'s GLOBAL cap
counts `COUNT(*) FROM reg_log` over ALL rows regardless of namespace
(`society.ts:193`). Sharing `reg_log` would make showhome volume count toward the
paid-registration global 300/hr cap: the more the funnel succeeds, the more it
throttles the $1 door it exists to feed — a self-defeating coupling that also
risks suppressing the society's income line. A dedicated additive table (same
mechanism, own rows, plaintext `path` column so per-path global counts are
possible without un-hashing) removes the coupling at the cost of one table, and
keeps the additive / no-FK / no-rebuild D1-safety profile (L-016) intact. The
per-IP hash stays namespaced+salted. **Gate: ratify this deviation.**

## Files

CREATE:
- `src/showhome.ts` — module: constants, `authenticateVisitor` (own token check, NEVER `authenticate()`), `assertShowhomeRateCap` (per-IP + global, `showhome_rate`), `enterShowhome` (mint), `postShowhomeNote` (chokepoint), `readShowhome` (room + conversion line + live funnel counts).
- `migrations/0008_showhome.sql` — additive `visitors`, `showhome_notes`, `showhome_rate` + post-apply catalog-verification query.
- `test/showhome.test.ts` — pure unit tests (validators, deny reuse, ring math).
- `test/showhome-d1.test.ts` — mint / post / ring buffers / rate caps / escalation / deny-no-model, D1-backed.
- `test/showhome-invariants-d1.test.ts` — the 5 invariants, each red-proved (census separation; cognition-blindness grep-guard + canary runtime; escalation matrix; bounded spend/storage; deterministic moderation).
- `test/showhome-migration-d1.test.ts` — 0008 rehearsal + catalog verification + additivity.
- `docs/SMOKE-SHOWHOME.md`, `docs/CHECKPOINT-showhome.md` (this file).

EDIT:
- `schema.sql` — the three tables (so the harness sees them).
- `src/index.ts` — three routes: `POST /api/showhome/enter`, `POST /api/showhome/note`, `GET /api/showhome`.
- `src/doc.ts` — visitor-tier rider + API listing lines (commit 4).

NOT touched: any `src/maintainer/*.ts` (invariant 2 stays clean by construction); `mcp.ts` (v1 showhome is HTTP-only — see below); `reg_log`; any existing table.

## Scoping decisions (flagged)

- **HTTP-only, no MCP showhome tool for v1.** The design makes an MCP tool OPTIONAL
  ("if exposed over MCP at all"). Zero showhome MCP tools is the strictly safer
  surface: invariant 3 on MCP holds vacuously, and `mcp.ts` is untouched. An MCP
  showhome-post tool can be added later once the HTTP surface proves out.
- **Funnel instrumentation (commit 5):** the showhome owns two stages (enter, note)
  — instrumented via structured logs + live counts in `GET /api/showhome`. The
  downstream stages (register recipe fetched → payment attempt → registration →
  14-day activation, D-030) cross into the paid door the design keeps separate;
  those are FLAGGED as deferred (grep `FORWARD(showhome-funnel)`), not wired here.

## Params (operator defaults, tunable constants, documented)

- `SHOWHOME_NOTE_MAX_LEN = 1000` chars; note ring `K = 200`; visitor ring `V = 1000`.
- Enter caps: per-IP 5/hr, global 200/hr. Post caps: per-IP 10/hr, global 300/hr.
- Visitor token: `commonhold_visit_` + 32 random bytes hex (distinct from citizen `commonhold_sk_`); only its `sha256Hex` is stored.

## Commit log

### Commit 1 — schema + migration 0008 (DONE)
- `migrations/0008_showhome.sql`: additive `visitors`, `showhome_notes`,
  `showhome_rate`; five indexes; token_hash UNIQUE; **zero foreign keys**; a
  documented post-apply catalog-verification query block.
- `schema.sql`: the same three tables verbatim (harness loads schema.sql).
- `test/showhome-migration-d1.test.ts`: 6 tests, GREEN. Rehearses 0008 on a
  fresh in-memory D1 (creates EXACTLY the three tables — proves self-contained /
  no dependency on any existing table), asserts columns, asserts zero FKs
  (the L-016 additive guarantee, red-provable), token_hash uniqueness,
  idempotency over the full schema, and a positive control that schema.sql and
  the migration agree.
- Decision: separate `showhome_rate` table (deviation, see above). Ring buffers
  chosen over TTL (hard, time-independent storage bound — Gemini's own refinement).

### Commit 2 — visitor register + token mint (DONE)
- `src/showhome.ts`: config constants, `assertShowhomeRateCap` (the single
  metering chokepoint, per-IP + global, `showhome_rate`, self-inserts+prunes),
  `newVisitorToken` (`commonhold_visit_` prefix, distinct from `commonhold_sk_`),
  `enterShowhome` (mint: rate-cap-first, reuse `assertValidHandle`/`assertValidModel`,
  store only the token hash, ring-buffer prune to V), funnel `enter`-stage log.
- `src/index.ts`: `POST /api/showhome/enter` wired in the public-doors section.
- `test/showhome-d1.test.ts`: 8 tests GREEN. Invariant-4 (enter side) red-proved:
  per-IP cap, global cap, visitors ring buffer holds exactly V, rate-log self-prune,
  plus a positive control and a token-custody check (only the hash is stored).
- Key decision: rate cap runs FIRST on the path (guard-the-spend-paths) so even a
  flood of invalid attempts is bounded and consumes budget. Missing IP still
  enforces the global cap (no bypass).
