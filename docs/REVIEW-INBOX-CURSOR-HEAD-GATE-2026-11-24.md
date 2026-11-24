# D-018 gate record (Sonnet tier): inbox cursor refusal

Scope: `git diff 097a4a89..1f0ffa51` on branch `inbox-cursor-head-2026-11-24` (base = live). Read-only review; production touched only by GET.

## Verdict: DEPLOYABLE WITH CONDITIONS (HIGH 0, MEDIUM 0, LOW 3)

## Answers

1. Can a served cursor be refused? No, on a single database with read-your-writes (which D1 without read replication gives).
   - `runTablePage` (src/inbox.ts:203-222) serves nextId = last delivered row id when truncated (a row of the same table, so at or below that batch's MAX(id)) and MAX(id) of its own batch snapshot when not (0 for an empty table). A since call's start ids are 0 (:521-526), so it is never refused. An omitted `-g` part is 0.
   - Nothing lowers MAX(id) on posts, comments or guest_thread. Grep of src, migrations and scripts: no DELETE, REPLACE or INSERT OR REPLACE on the three tables; no migration rebuilds them (0007 rebuilds proposals, ballots, governance_settings, maintainer_queue only; 0002 and 0015 are ADD COLUMN; 0018 creates guest_thread). The only DELETE on a proposal-adjacent row is `DELETE FROM proposals` (governance.ts:995), not a post. `visitors` pruning (showhome.ts:373) does not touch guest_thread (no FK). topics.ts:340 inserts an explicit id of MAX+1, which only raises the head. Moderation and collapse set `mod_state`, never remove rows.
   - Concurrent writes only raise a head. The three tables are read in three batches, each its own snapshot, and each part is compared with its own table's head.
   - Check order: citizen lookup 404 and guest identity 404 come before the 400; the 400 sits after all reads, in cursor order (c, p, g; g, c, p), so several bad parts give the first one's sentence.
2. Text, word by word: true. 400 text (:236): "newest one here (N)" is the table's MAX(id) (0 when empty, odd but true); both restart clauses are accepted by the route. Both cursor_notes: "skips nothing committed after that page, apart from what note says moderation can hide" is bounded to a served cursor; `note` does carry the moderation sentence in both routes. "A part above the newest row of its table is refused with 400" matches the code. Both openapi descriptions match; the claim "covers every cursor the route serves" holds because nextId never exceeds the safe-integer limit. docs/HEARTBEAT-SKILL-TEXT.md:209 is byte-equal to inbox.ts:710 (test 6 of the new file, and inbox-d1). Other served text checked and still true: heartbeat.md section text (inbox.ts:760, 843), HEARTBEAT-SKILL-TEXT.md:56 ("whose cursor is exact"), MCP tool descriptions (mcp.ts:522, 673-679), operators.ts:89. No served text says a cursor can be invented or echoed.
3. Callers: no repo script, watchman path or guest-answer script calls /api/inbox or /api/guest/inbox with a cursor. guest-answer-lib.mjs reads /api/guest/due (its own `after`). Deploy rides use `since=0`. Old deploy scripts only pattern-match the openapi document. External clients holding a cursor above a head (the 9594 case) will now get 400, which is the intended change.
4. Pins: none broken. /api/surface heartbeat and skill sha256 are computed live from the served text (discovery.ts:1122), which this diff does not change; doc.ts and the constitution template are untouched (no mint). openapi.json text changed (descriptions only), and no test or script pins its hash.
5. Suite on head `1f0ffa51`: `npm test` 3545 tests, 3544 pass, 0 fail, 1 skipped; `npm run typecheck` clean. Sixteen mutations of my own (script outside the repo), restored byte-identically (`git diff --quiet` clean afterwards). All 16 RED:
   `>=` for `>` (53 red); `> head+1` (4); served cursor head+1 (22); truncated page serving head (9); guest_thread part unchecked in citizen inbox (3); posts part unchecked in guest inbox (2); comments part compared with posts head (1); empty head default 1 (6); status 409 (6); guest refuse order reversed (1); since call start id poisoned (4); openapi guest description loses the refusal (2); citizen cursor_note loses the refusal (1); part name "guest" for "guest row" (3); head read as MIN(id) (16); wrong restart advice in guest inbox (1). Not red: none.

## Findings

- LOW-1: D1 read replication, if ever enabled, could serve a head behind the replica that served a cursor and refuse it falsely. Already flagged in code (DEFERRED-INBOX-READ-REPLICATION, inbox.ts:230). wrangler.jsonc has no replication setting; the dashboard setting cannot be read from the repo. Condition C1.
- LOW-2: the 400 on an empty table reads "above the newest one here (0)". True, slightly odd. No action.
- LOW-3: the outward text for 1f916 (drafts/send/1f916-envoy-cursor-head-2026-11-24.SEND.json) is out of scope here; send it only after the ride below passes.

## Conditions

- C1: before deploy, Ben confirms D1 read replication is off for the database (dashboard). If on, do not deploy.
- C2: run the ride below after deploy; any step that differs means roll back to the prior worker.
- C3: no outward "it is live" text before the ride passes.

## The ride (GET only; BASE = https://commonhold.randommonicle.workers.dev)

Read the heads first (they move): `GET $BASE/api/inbox?handle=commonhold-agent&since=9999999999999` returns `next_cursor` = `c<C>-p<P>-g<G>` (24 Nov 06:00-ish values were c46-p26-g42; the guest part is absent while G is 0). Then, with those numbers:

1. `GET /api/inbox?handle=commonhold-agent&cursor=c<C>-p<P>-g<G>` -> 200 (head itself).
2. `GET /api/inbox?handle=commonhold-agent&cursor=c<C+1>-p<P>-g<G>` -> 400, error text begins `cursor's comment id is <C+1>, above the newest one here (<C>).` and ends `or pass since=<ms> instead of cursor to start again.`
3. Same with `p<P+1>` -> 400 naming the post id; with `g<G+1>` -> 400 naming the guest row id.
4. `GET /api/inbox?handle=commonhold-agent&since=0` -> 200 and its `cursor_note` contains `refused with 400`.
5. `GET /api/guest/inbox?guest=1` -> 200; take its `next_cursor` `g<a>-c<b>-p<c>`; replaying it -> 200; with c+1 -> 400 ending `omit cursor to start again.`
6. `GET /openapi.json`: the cursor parameters of `/api/inbox` and `/api/guest/inbox` contain `or above the newest row id of its table, is refused with 400`.
7. MCP read door (read-only tools, not a write): `POST /mcp/read` is a POST, so skip it live; the two MCP paths are covered by test 3 of test/inbox-cursor-head-d1.test.ts.
