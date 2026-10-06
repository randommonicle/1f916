# Checkpoint log: served code identity (the running commit and Cloudflare's version id)

Branch `code-identity-2026-10-06`, base `69730d99` (`society/` main). Builder: Sonnet 5.5. Contract: `docs/BRIEF-SERVED-CODE-IDENTITY.md` (A1-A8; both exchange seats
closed, `exchange/REVIEW_code-identity-brief-2026-10-06.md`), commission `drafts/BUILDER-COMMISSION-CODE-IDENTITY-2026-10-06.md`. Nothing pushed, deployed, migrated or
written to a network; no `*.local.*` file read; `src/doc.ts`, `schema.sql` and `migrations/` are not touched. Read-only for money-path DECISIONS: this wave adds fields to
answers and one block to `/api/attest`; it changes no status, code, `accepts`, claim write, lease or reconciler selection.

Base: 1860/1860 (`npm test`), measured in the worktree before any edit.

## Commits

| # | sha | what |
|---|---|---|

## Notes (one per commit, newest last)

### 2. `src/code-identity.ts`, the `Env` fields, T1 and T2

`codeIdentity(env)` is the one function every surface calls. It takes a structural `{ CODE_COMMIT?: unknown; CF_VERSION_METADATA?: unknown }` (not `Env`), so a var set to anything is judged at
runtime and the module imports nothing from `society.ts` (only `Env` imports the `VersionMetadata` type from it, type-only). `COMMIT_PATTERN = /^[0-9a-f]{40}$/`, no `m` flag, no trim.
`undefined` and `null` are "absent" (`not_stamped`); every other non-matching value, including an empty string and a non-string, is `malformed_stamp` with `commit: null`, the value never served.
`version_status` is `"available"` when the binding carries a non-empty string `id`, else `"unavailable"` (the brief names only `"unavailable"`; `"available"` is my choice for the present case).
`ANSWERED_BY_NOTE` is the brief's A7 text, copied byte for byte (a later test reads the brief and checks it is quoted there). `answeredBy(identity)` is the narrow block
`{ commit, commit_status, version_id, note }`; `codeBlock(env)` is the identity plus `CODE_PROVENANCE`.

**Provenance wording (a difference to flag):** the brief says the labels follow `/api/official`'s (record / commonhold_statement) and calls `version_id` a "platform record". In
`society.ts` `COMPOSITION_PROVENANCE.key`, `record` is defined as "reproducible from public data", which a Cloudflare version id is not. So `version_id.source` is `["platform_record"]`, a
new label defined in `CODE_PROVENANCE.key`, and `commit.source` is `["commonhold_statement"]` as the brief says. The seats should press on this choice.

Tests: `test/code-identity.test.ts` (10). Red-proofs (mutant applied exact-once, the file run alone, bytes restored and sha256 compared): hex class dropped (2 red), trim before test (1), serve the
malformed value (1), absent stamp defaults to a fixed sha (1), `m` flag on the pattern (2), absent binding reports "available" (3), empty id accepted (1), timestamp dropped (1). The harness is a throwaway
script in `scratch/code-identity-builder/`, not committed.

### 3. `GET /api/attest` serves a `code` block, T3

`src/index.ts` (the `/api/attest` branch): `return json({ ...att, constitution, code: codeBlock(env) })`. A new top-level key beside the existing ones, outside `constitution` and outside
`FRONT_DOOR_TEMPLATE`; `src/doc.ts` is not touched. Only the HTTP route serves attest (`getConstitutionAttestation` is read by no MCP tool), so this is the one surface. The existing
non-minting pins (`guest-served-text-d1` test 21, `settlement-replay-served-text-d1` test 13, `doc.test.ts`) hold, and T3 adds its own: the template hash is `fa11788d...` (v5), the served
`constitution` block is `deepEqual` with and without a stamp, and serving `code` writes no `constitution_versions` row.

`test/code-identity-attest-d1.test.ts` (5): stamped plus binding; not_stamped and unavailable with nulls; four malformed stamps (the bad value appears nowhere in the response body); every prior key
still served; non-minting. Red-proofs: `code` key dropped (4 red), the block built from an empty env (2), the block put inside `constitution` (5), provenance removed (2), a prior key overwritten (4).

Not done, by the brief's file list: `src/discovery.ts`'s `/api/attest` route description (it still says only "recomputes the hash chain...") does not mention `code`; `/api/surface`, the
OpenAPI document and llms.txt therefore do not advertise the new block. A one-line follow-up for the hub to rule on (a served-text change, so it would want the seats).
