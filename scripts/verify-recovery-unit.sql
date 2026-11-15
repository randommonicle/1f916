-- Catalogue read for migrations/0027_resident_recoveries.sql. Used by scripts/rehearse-recovery-unit.ps1 (scratch D1) and scripts/deploy-recovery-unit.ps1 (prod). A READ: it writes nothing.
-- One row per fact the migration must have produced, in a fixed order (ORDER BY kind, name):
--   column       the two new guests columns and every column of commit_days as <table>.<column> with type|notnull|pk (pragma_table_info);
--   default      the DEFAULT of guests.recoveries (0), which type|notnull|pk does not show;
--   guests_tail  the last three guests columns in order (resident_at, then the two new ones appended by ALTER);
--   table        commit_days with its columns in order;
--   unique       every unique index on commit_days, as <table>:<origin>:<columns> (origin pk = the primary key (day, code_commit)).
-- Before the migration this returns only the guests_tail row; the deploy script sorts the three objects into absent, complete or partial from the column and table rows.
-- Single line after full-line comments are stripped, single quotes only.
-- REAL D1 (found by the scratch rehearsal, 15 Nov 2026; node:sqlite accepts both forms): the column term names its two tables itself and never joins sqlite_master to pragma_table_info under an OR. That join made the
-- planner call pragma_table_info on every table, D1's own internal ones included, and D1 refused the statement (not authorized: SQLITE_AUTH). D1 also allows at most five terms in a compound SELECT, so the term is not split in two.
SELECT 'column' AS kind, n.tn || '.' || c.name AS name, c.type || '|' || c.[notnull] || '|' || c.pk AS detail
FROM (SELECT 'commit_days' AS tn UNION ALL SELECT 'guests') AS n, pragma_table_info(n.tn) AS c
WHERE n.tn = 'commit_days' OR c.name IN ('recoveries', 'last_recovered_at')
UNION ALL
SELECT 'default', 'guests.' || c.name, COALESCE(c.dflt_value, '')
FROM pragma_table_info('guests') AS c
WHERE c.name = 'recoveries'
UNION ALL
SELECT 'guests_tail', 'guests', (SELECT group_concat(x.name, ',') FROM (SELECT name FROM (SELECT name, cid FROM pragma_table_info('guests') ORDER BY cid DESC LIMIT 3) ORDER BY cid) AS x)
UNION ALL
SELECT 'table', m.name, (SELECT group_concat(c.name, ',') FROM pragma_table_info(m.name) AS c)
FROM sqlite_master AS m
WHERE m.type = 'table' AND m.name = 'commit_days'
UNION ALL
SELECT 'unique', l.name, t.name || ':' || l.origin || ':' || (SELECT group_concat(i.name, ',') FROM pragma_index_info(l.name) AS i)
FROM sqlite_master AS t, pragma_index_list(t.name) AS l
WHERE t.type = 'table' AND t.name = 'commit_days' AND l.[unique] = 1
ORDER BY 1, 2;
