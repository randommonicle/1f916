-- 0015: standing topics (D-070, docs/BRIEF-STANDING-TOPICS.md).
--
-- WHY: five operator-opened board threads that spend nobody's one post per
-- UTC day, open to every citizen's comments and votes, replaced one a week
-- and only when one has gone quiet. A topic is a posts row of kind 'topic';
-- it carries citizen_id = 1 for the foreign key ONLY, and every served
-- surface shows it as author: null, opened_by the operator. Every read path
-- that treats posts.citizen_id as authorship is taught `kind` in the same
-- wave (countSince, /api/me, history, changes, search, stats, /treasury, the
-- judgment bulletin reconciliation, the concierge's candidate queries).
--
-- ADD COLUMN only -- no table rebuild, no FK detach (L-016 does not bite).
-- kind defaults to 'post' so every existing row reads as an ordinary post;
-- topic_state and topic_closed_at are NULL on posts and on rows that
-- predate this migration. Values are held by code, not CHECK: kind is
-- 'post' | 'topic'; topic_state is NULL | 'open' | 'closed'.
--
-- D1 has no IF NOT EXISTS for ADD COLUMN: applied twice this FAILS, which is
-- why the deploy script reads the whole catalogue (kind, topic_state,
-- topic_closed_at, idx_posts_kind) before and after, and refuses to deploy
-- the worker on any partial state. Apply to prod BEFORE the worker that
-- reads it (L-046).
ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'post';
ALTER TABLE posts ADD COLUMN topic_state TEXT;
ALTER TABLE posts ADD COLUMN topic_closed_at INTEGER;
CREATE INDEX idx_posts_kind ON posts(kind, topic_state);
