# Checkpoint: heartbeat and inbox (D-072 direction 1)

Branch `heartbeat-inbox-2026-09-26`. Built from `docs/BRIEF-HEARTBEAT-INBOX.md` plus its
amendments A1-A20 (e4281b23 is the latest brief commit read before any code here) and
`docs/HEARTBEAT-SKILL-TEXT.md` (hub-authored served text, rendered word for word).

## File list

- `src/inbox.ts` (new): `inbox()`, the mention matcher, `renderHeartbeatMd`,
  `renderSkillMd`, `heartbeatDoorNote`, `SKILL_VERSION`, `INBOX_SECTION_LIMIT`.
- `test/inbox-d1.test.ts` (new): brief tests 1-7, A13, A19, A20.
- `test/helpers/local-d1.ts` (edit): `batch()` learns to run a `SELECT` statement with
  `.all()` and carry its rows as `.results`, alongside the existing `.meta`-only path for
  writes. Additive: no existing caller reads `.results` off a batch element.
- `src/topics.ts` (edit): export `serveTopic` (A2: "projected through topics.ts's own
  serveTopic, the single source") and `ACTIVITY_SQL` (reused, not retyped, for the posts
  candidate query's `last_activity_at` column).
- `src/register-gate.ts` (edit): export `REGISTRATION_PRICE_CENTS` so `${PRICE}` renders
  from that module's own constant, never a second literal (brief's own instruction).
- `src/discovery.ts` (edit): export `AUTH_LABEL`; add `RouteQueryParam.required?: boolean`
  and honour it in `renderOpenApi` (A12); mark `/api/inbox`'s `handle` required and
  `/api/changes`'s `since` required; `.md` routes render `text/markdown` in
  `renderOpenApi`; add `ROUTES` entries for `GET /api/inbox`, `GET /heartbeat.md`,
  `GET /skill.md` with `grepFor`; add `handleHeartbeatMd`/`handleSkillMd`; extend
  `handleSurface` with `heartbeat: {url, sha256}` / `skill: {url, version, sha256}`
  (D7), computed over the exact text the same origin serves, without changing
  `renderSurface`'s existing sync signature (kept for its existing tests).
- `src/mcp.ts` / `src/mcp-read.ts` (edit): the `inbox` tool (A16).
- `src/society.ts` (edit): the `changes()` cursor_note gains A8's sentence;
  `DEFERRED-CHANGES-CURSOR-RACE` planted at the `now = Date.now()` line (F1 deferred,
  not fixed, per A8).
- `src/index.ts` (edit): dispatch `GET /api/inbox`, `GET /heartbeat.md`, `GET /skill.md`;
  `DEFERRED-PUBLIC-READ-RATE-CAP` planted at the inbox dispatch line (A14).
- `test/mcp-read.test.ts` (edit): `inbox` added to `EXPECTED_READ_TOOL_NAMES`; the
  `tools.length === 8` sanity assertion becomes 9.
- `test/served-auth-both-path.test.ts` (edit): heartbeat.md/skill.md added to `SURFACES`
  (brief test 13: this file enumerates served surfaces by hand, so a new one must be
  added by hand too).
- `scripts/deploy-heartbeat-inbox.ps1` (new): worker-only, house pattern, written but
  never run.

## Deviations from D9's "registration points only" list, disclosed up front

D9 names four files (`index.ts`, `discovery.ts`, `mcp.ts`, `mcp-read.ts`) as the wave's
touch points beyond `src/inbox.ts`. Three more turned out to be unavoidable:

1. **`src/topics.ts`** -- A2 explicitly mandates reusing `serveTopic` as "the single
   source" for topic projection; that function is module-private today.
2. **`src/register-gate.ts`** -- the served `${PRICE}` must come from that module's own
   constant, which is module-private today.
3. **`src/society.ts`** -- A8 explicitly asks for the sentence and the deferred flag on
   `changes()`, which lives there.
4. **`test/helpers/local-d1.ts`** -- see the import-direction and batch() notes below.
5. **`test/mcp-read.test.ts`** / **`test/served-auth-both-path.test.ts`** -- both are
   brief-named registration points (A16 names the first by file; test 13 names the
   second by its own "enumerates by hand" property).

## Two design decisions worth recording before the code lands

**Import direction (avoiding the codebase's first cycle).** `renderHeartbeatMd` needs the
ballot route's own served note and `renderSkillMd` needs `AUTH_LABEL.citizen_secret`,
both of which live in `discovery.ts`. But D7 requires `/api/surface` (served from
`discovery.ts`) to hash the exact heartbeat/skill text, which means `discovery.ts` must
import the render functions from `inbox.ts`. Importing the other way (inbox.ts ->
discovery.ts) would make a cycle -- this codebase's own stated discipline is a strict DAG
rooted at `society.ts` (governance.ts's header comment states the reverse edge would be
its first circular import). Fix: `renderHeartbeatMd`/`renderSkillMd` take the ballot note
and the auth label as plain parameters; `discovery.ts` supplies them from its own local
`ROUTES`/`AUTH_LABEL` at both call sites (`handleHeartbeatMd`/`handleSkillMd` and
`handleSurface`), so the two callers are guaranteed to pass identical facts and the sha256
is genuinely of what the same origin serves.

**`env.DB.batch()` and the local D1 helper.** A17 requires the candidate query and its
`MAX(id)` snapshot to run "in ONE `env.DB.batch([...])` ... one transaction, so one
snapshot". `test/helpers/local-d1.ts`'s `batch()` was built only for write-batches
(chain.ts/topics.ts/governance.ts's own callers): it always executes each statement with
`.run()` and returns only `{meta}`, discarding any rows a `SELECT` would produce. Real D1's
`batch<T>()` returns `D1Result<T>[]`, i.e. `{success, meta, results}` per statement,
whatever the statement was -- so the fix is to make the local shim match that for a
`SELECT` specifically (detected by the statement's own leading keyword), additively: every
existing caller only ever batches writes and only ever reads `.meta`, so nothing already
green can regress.

## Commit log

(each commit below adds its own entry here, in order, before the commit lands)
