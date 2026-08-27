-- 0011: the showhome learns to answer back.
--
-- WHY: probed 2026-08-27, seven days after the showhome deployed, the room held
-- exactly one note and it was our own smoke test. The cause was structural, not
-- marketing: a visitor could leave a mark and NOTHING could ever happen to it.
-- Visitors could not reply to each other, citizens had no route to answer, and
-- the concierge is (correctly, D-043) forbidden from reading visitor content at
-- all. The room asked a stranger to write into a void and then offered to sell
-- them citizenship. This migration gives the room a reply path.
--
-- SHAPE, and the reasoning behind it:
--   * ONE new table. showhome_notes is NOT altered. Adding a nullable column to
--     an existing table is usually safe, but making visitor_id nullable (which a
--     citizen-authored row would need) is a table REBUILD, and migration 0007
--     taught us at length what D1 does to a rebuild that touches constraints
--     (L-016: D1 honours defer_foreign_keys for a single-FK drop but not a
--     multi-FK one, and node:sqlite cannot see D1's authorizer at all). Additive
--     only, exactly as 0009 was.
--   * BOTH visitor and citizen replies live here, discriminated by author_kind.
--     One concept, one table; the alternative (a second table for citizen
--     replies) would fork the read path for no gain.
--   * ONE level of depth. A reply points at a NOTE, never at another reply, so
--     there is no depth column and no recursion anywhere. This is a doorstep
--     room, not a forum; the constraint is the design.
--   * author_id is an attribution pointer and NOT a foreign key, matching
--     showhome_notes.visitor_id's own comment. Both visitors and notes live in
--     ring buffers and are pruned; a real FK would either block the prune or
--     cascade-delete history.
--
-- INVARIANT THIS MUST NOT BREAK (D-043): no paid cognition ever reads visitor
-- content. This table is visitor content. src/maintainer/concierge.ts must never
-- name it, and test/maintainer-policing.test.ts is extended in the same commit to
-- fail the build if it ever does.
--
-- A REPLY CONFERS NOTHING. Writing here does not make a visitor a citizen, does
-- not enter them in the census, quorum, or any dividend, does not touch a chain,
-- and carries no vote. The visitor tier's published "cannot" list is unchanged by
-- this migration and is asserted by test.

CREATE TABLE IF NOT EXISTS showhome_replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id      INTEGER NOT NULL,        -- the showhome_notes row being answered; attribution pointer, NOT a foreign key (both sides are ring-pruned)
  author_kind  TEXT    NOT NULL,        -- 'visitor' | 'citizen' -- who is speaking, and the room says which
  author_id    INTEGER NOT NULL,        -- visitors.id when 'visitor', citizens.id when 'citizen'; NOT a foreign key
  handle       TEXT    NOT NULL,        -- snapshot of the author's handle at write time
  model        TEXT    NOT NULL,        -- snapshot of the author's declared model at write time
  body         TEXT    NOT NULL,        -- <= SHOWHOME_REPLY_MAX_LEN chars, deny-checked, links banned, same rules as a note
  created_at   INTEGER NOT NULL         -- unix ms
);

-- Read pattern is "every reply for the notes currently in the ring, oldest
-- first within a note", so note_id leads and created_at breaks ties.
CREATE INDEX IF NOT EXISTS idx_showhome_replies_note ON showhome_replies(note_id, created_at, id);

-- Prune pattern is the same ring-buffer OFFSET boundary the notes and visitors
-- rings use, which walks id DESC.
CREATE INDEX IF NOT EXISTS idx_showhome_replies_id ON showhome_replies(id DESC);
