# Checkpoint log: the resident tier (D-075 order step b)

Branch `residents-2026-10-11`, base `d266a3ae` (`society/` main, wave a merged locally, NOT pushed). Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-RESIDENT-TIER-2026-10-11.md`; contract: `drafts/BRIEF-RESIDENT-TIER-2026-10-11.md` with amendments R1-R7. Ruling: DECISIONS D-075, order step (b).
Nothing pushed, deployed, migrated or written to a network; no `*.local.*` file read; `FRONT_DOOR_TEMPLATE` (`src/doc.ts`) is not edited. The only new migration is `0020_residents.sql`.

Class: no money path, no register-path change, no model call, no mint, ONE additive migration (0020). Gate: Sonnet. If an item needs an edit inside `FRONT_DOOR_TEMPLATE`, a table rebuild, a second migration, `POST /api/register`, or the citizen `authenticate`/`requireSignedIntent` path, it stops and is reported.

Base: 2093 tests (2092 pass, 0 fail, 1 skipped, 99 s) and `tsc` silent, measured in the worktree before any edit.

## Hub amendments (CODEX r1, GEMINI r1), binding, received mid-build

A1 `/mcp/read` stays exactly twelve; `resident_bind` and `resident_token` on `/mcp` only and added to `WRITE_OR_AUTH_TOOL_NAMES` in `test/mcp-read.test.ts`. A2 `readShowhome` gets an explicit resident rung (with a test). A3 readers join `guests` for `public_key`. A4 nonce-ordering red-proof (invalid signature with nonce N refused, then a valid signature with N succeeds). A5 the resident verifier enforces the freshness window and the canonical key spelling itself (tests: expired, future-dated, non-canonical key). A6 the counts test also pins `control_floor_percent`. A7 the deploy script's step 0 stops on EITHER placeholder before any remote read or write. A8 dead-token tests start from a real `enterShowhome` plus an accepted guest comment; the unpromoted-bind test uses a real zero-comment token. A9 `git -C` for every git command.

## Commits

(filled in as they land)

## Notes (one per commit, newest last)

### 1. this log

Decisions taken before the first edit, so a reviewer can see them:

- **Verifier order** (`src/resident.ts`): parse, audience (`ASSERTION_AUDIENCE ?? DEFAULT_AUDIENCE`, before any DB touch), freshness window (`withinWindow`), load the guest by `visitor_id`, `claims.h === guests.handle` (exact), `claims.b === expected`, signature (bind: against the SUPPLIED key after `checkPublicKeyShape`; recover: against the STORED key), and only then one `env.DB.batch` carrying the write and the nonce insert. It imports `encodeIntentParts` and `withinWindow` from `keyauth.ts` and never `authenticate`, `requireSignedIntent`, `buildIntentBinding` or `INTENT_OPS`.
- **Bindings**: `resident_bind:` + sha-256 hex over `encodeIntentParts([visitor_id, handle, public_key])` and `resident_recover:` + the same over `[visitor_id, handle]`; the prefixes differ so neither assertion can be presented as the other.
- **Nonce**: `resident_nonces.nonce` PRIMARY KEY; a replay is a UNIQUE violation inside the batch, which D1 rolls back whole. A lost race (`changes() = 0`) leaves the nonce burnt, as D-056's refusal-burn does.
- **Recovery and the `visitors` row**: R4 allows overwrite or removal; this build OVERWRITES the old `visitors.token_hash` with the new hash (the UPDATE is built in `showhome.ts`, the one module allowed to touch `visitors`), so the old token dies on the fallback path and the new token keeps working for showhome notes while the ring row survives.
- **Readers**: the resident flag is computed in SQL, once, in `dutyRowsSql` and in the citizen inbox's own guest-thread query, from `guests.public_key`.
- **MCP**: both tools are dispatched beside wave a's guest tools, before any citizen credential is computed.

