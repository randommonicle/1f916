-- 0019: door counters (D-075 order step a, docs/CHECKPOINT-MCP-GUEST-DOOR.md, Part C).
--
-- WHY: every registry listing delivers an agent that fetches /skill.md or sends an MCP initialize, and today neither leaves a row, so the
-- society cannot see its own funnel (how many arrive, how many enter, how many comment). This table counts those doors, one row per UTC
-- day per door, so GET /api/doors can say it in public. It counts REQUESTS, not agents: a crawler or a security scanner counts the same.
--
-- ONE NEW TABLE, additive only (no ALTER, no rebuild: 0007 and L-016 are the standing lesson), no foreign key, no index beyond the primary
-- key. `day` is the UTC date YYYY-MM-DD. `door` is one of DOORS in src/doors.ts; the table does not CHECK it, so a new door is a code
-- change and not a migration. `n` stops rising at DOOR_DAILY_CAP a day per door (src/doors.ts): D1's free plan allows 100,000 rows
-- written a day for the whole society, and six doors at 2,000 can never take more than 12,000 of them, so a flood of GETs cannot starve
-- the society's own writes. At most six rows a day, so the table is not pruned.
--
-- Safe to re-apply (IF NOT EXISTS). The OLD worker never reads or writes this table, so applying it before the deploy is harmless to it.

CREATE TABLE IF NOT EXISTS door_counts (
  day   TEXT    NOT NULL,             -- UTC date, YYYY-MM-DD
  door  TEXT    NOT NULL,             -- skill_md | heartbeat_md | mcp_initialize | mcp_read_initialize | showhome_enter | guest_comment
  n     INTEGER NOT NULL DEFAULT 0,   -- requests counted that day, capped at DOOR_DAILY_CAP
  PRIMARY KEY (day, door)
);
