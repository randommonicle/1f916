# Checkpoint log: the MCP guest door, door counters, and skill.md as an invitation (D-075 order step a)

Branch `mcp-guest-door-2026-10-11`, base `07e9c57d` (`society/` main = origin/main). Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-MCP-GUEST-DOOR-2026-10-11.md`. Ruling: DECISIONS D-075, order step (a).
Nothing pushed, deployed, migrated or written to a network; no `*.local.*` file read; `src/doc.ts` is not edited. The only new migration is `0019_door_counts.sql`.

Class: no money path, no model call, no mint, ONE additive migration (0019). Gate: Sonnet (DECISIONS D-018 note 28 Sept). If an item needs an edit to `src/doc.ts`, a second migration or a money path, it stops and is reported.

Base: measured in the worktree before any edit (figures filled in below).

## Commits

| # | sha | what |
|---|---|---|
| 1 | this commit | this log |

## Notes (one per commit, newest last)

### 1. this log

Pattern: `docs/CHECKPOINT-CODE-IDENTITY-LOWS.md`. Differences from the commission are noted where they arise, in the commit's own note.

Decisions taken before the first edit, so a reviewer can see them:

- The three guest tools are dispatched from `handleMcp` ahead of `callTool`, through a separate `callGuestTool` that takes no credential at all; the `Authorization` header is extracted only on the non-guest branch. `callTool` and its `secret` line are untouched, so `test/mcp-tool-annotations.test.ts`'s scan of `callTool`'s own source (no tool that calls `authenticate(` is read-only) still reads the same function.
- The deploy script carries `--var CODE_COMMIT:<sha>` from `scripts/deploy-code-identity.ps1`. `scripts/deploy-guest-voice.ps1` (the pattern the commission names) predates served code identity, and a deploy without the flag would serve `commit_status: not_stamped` (each `wrangler deploy` replaces the version's vars). The new script is the guest-voice migration-first shape with the code-identity stamp, reviewed-source check and poll.
- `docs/HEARTBEAT-SKILL-TEXT.md` is the hub-authored source that `test/inbox-d1.test.ts` compares with `renderSkillMd` and `renderHeartbeatMd` byte for byte; the S1-S3 change and any heartbeat edit are made in that file in the same commit as the renderer.

### 2. M1-M4: the three guest tools on the full /mcp door

Base measured before any edit: 2045 tests (2044 pass, 0 fail, 1 skipped), `tsc` silent, in the worktree.

- `src/mcp.ts`: `guest_enter`, `guest_comment`, `showhome_note` in `TOOLS` (after `guest_inbox`), dispatched by `callGuestTool`, which `handleMcp` calls ahead of `callTool` for exactly those names. `callTool` and its `secret` line are untouched. `handleMcp` now extracts the `Authorization` header only on the non-guest branch, and reads `CF-Connecting-IP` on the guest branch, so no credential is computed for a guest tool and the address reaches `enterShowhome` / `postGuestComment` / `postShowhomeNote`, which meter it through the one `showhome_rate` table (M2: one cap across both doors).
- `guest_comment` builds its input from `post_id, kind, parent_kind, parent_id, body` only, the five fields `postGuestComment` reads; `token` is passed separately, as the REST route does.
- Descriptions carry "free, no account, no wallet, no payment", "shown once" and "only credential" (guest_enter), and point at `GET /skill.md` for caps and refusals; no cap number or refused-word list is restated. The word "secret" is avoided in them, so `test/secret-literal-guard.test.ts` needs no new prose entry and its baseline (79 / 24 / 55) does not move.
- The `guest_thread`, `guest_due`, `guest_inbox` descriptions gain one sentence each saying a guest writes with `guest_enter` / `guest_comment` on the full `/mcp` door (they are also served on `/mcp/read`, so the sentence says "full /mcp door"). Each still ends "No auth needed." (the `/mcp/read` cross-check). The comment above them that said there was deliberately no guest write tool, and the one at the old :631 ("a guest write is HTTP only"), are corrected.
- `DEFERRED-GUEST-MCP-WRITE` is retired: the work it deferred is done. `test/guest-deferred-flags.test.ts` drops it from its planted-flag table and pins its ABSENCE from `src/mcp.ts` plus the three tools' presence (a flag naming finished work would be a false claim).
- Existing parity tables updated, not bypassed: `test/mcp-tool-annotations.test.ts` (count 25 -> 28, titles, open-world hints, a new test for the three annotation sets); `test/mcp-read.test.ts` adds the three names to the list that `/mcp/read` must refuse on `tools/call`; its tools/list assertions stay at exactly twelve.
- `/mcp/read` needed no code change: its `callReadTool` switch is a closed set and `READ_TOOL_NAMES` does not name the three.

Tests: `test/mcp-guest-door-d1.test.ts` (real local D1, the real router; REST on one fresh database and MCP on another with the same fixture, rows and bodies compared).

Red-proofs (mutant, then the tests that went red; each restored from the index afterwards):
1. add `guest_comment` to `mcp-read.ts` `READ_TOOL_NAMES`: "/mcp lists the three ... /mcp/read lists none" red (the tools/call refusal test stays green: the two layers are independent, as designed).
2. pass `null` instead of the address from `guest_comment`: the M2 mixed-door cap test red (the eleventh call is refused by the per-guest day cap, not the address cap).
3. `args.token ?? args.secret` in `guest_comment`: both M3 tests red (behavioural and source-order).
4. drop `kind` from the built input: the guest_comment parity test red (the critique stops accruing a duty).
5. drop `parent_kind`: the same test red (the reply loses its parent).
6. make `guest_enter` throw a different message: the refusal-parity test red.
7. read the `Authorization` header before the guest branch: the M3 source-order test red.
8. the retired flag reappears in `src/mcp.ts`: the flag-retirement test red.
9. change a guest tool's title: the C5 titles test red.
10. mark `guest_enter` read-only: the new annotations test and the M1 annotations test red.
