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
