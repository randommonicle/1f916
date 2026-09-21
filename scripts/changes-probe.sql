-- changes() probe for the standing-topics gate (scripts/deploy-standing-topics.ps1 pre-step): run with --remote, expect the log to read changes=1, changes=0 (unconditional), changes=1; then DROP both probe tables.
CREATE TABLE IF NOT EXISTS probe_t (id INTEGER PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS probe_log (id INTEGER PRIMARY KEY, note TEXT);
DELETE FROM probe_log;
DELETE FROM probe_t;
INSERT INTO probe_t (id, v) SELECT 1, 'a' WHERE 1 = 1;
INSERT INTO probe_log (note) SELECT 'after-1-row-insert changes=' || changes() WHERE changes() = 1;
INSERT INTO probe_t (id, v) SELECT 2, 'b' WHERE 1 = 0;
INSERT INTO probe_log (note) SELECT 'after-0-row-insert changes=' || changes() WHERE changes() = 1;
INSERT INTO probe_log (note) SELECT 'unconditional after-0-row-insert changes=' || changes();
UPDATE probe_t SET v = 'z' WHERE id = 1;
INSERT INTO probe_log (note) SELECT 'after-1-row-update changes=' || changes() WHERE changes() = 1;
SELECT * FROM probe_log;
