-- Catalogue read for migrations/0028_maintainer_declines.sql. Used by scripts/rehearse-parked-list.ps1 (scratch D1) and scripts/deploy-parked-list.ps1 (prod). A READ: it writes nothing.
-- One row per fact the migration must have produced, in a fixed order (ORDER BY kind, name):
--   column   every column of maintainer_declines as <table>.<column> with type|notnull|pk (pragma_table_info);
--   fk       each foreign key, as <from column> and <table>.<to column> (pragma_foreign_key_list);
--   table    maintainer_declines with its columns in order;
--   unique   every unique index on maintainer_declines, as <table>:<origin>:<columns> (origin pk = the primary key (queue_id, run_id)).
-- Before the migration this returns no rows: the table is absent, and the deploy script reads that as ABSENT (apply), the full set as COMPLETE (skip), and anything between as PARTIAL (STOP).
-- Single line after full-line comments are stripped, single quotes only.
-- REAL D1 (found by the scratch rehearsal of 0027, 15 Nov 2026): each term names its table itself and no term joins sqlite_master to a pragma table under an OR (D1 refuses that with SQLITE_AUTH), and a compound
-- SELECT has at most five terms on D1: this one has four.
SELECT 'column' AS kind, 'maintainer_declines.' || c.name AS name, c.type || '|' || c.[notnull] || '|' || c.pk AS detail
FROM pragma_table_info('maintainer_declines') AS c
UNION ALL
SELECT 'fk', f.[from], f.[table] || '.' || f.[to]
FROM pragma_foreign_key_list('maintainer_declines') AS f
UNION ALL
SELECT 'table', m.name, (SELECT group_concat(c.name, ',') FROM pragma_table_info(m.name) AS c)
FROM sqlite_master AS m
WHERE m.type = 'table' AND m.name = 'maintainer_declines'
UNION ALL
SELECT 'unique', l.name, 'maintainer_declines:' || l.origin || ':' || (SELECT group_concat(i.name, ',') FROM pragma_index_info(l.name) AS i)
FROM pragma_index_list('maintainer_declines') AS l
WHERE l.[unique] = 1
ORDER BY 1, 2;
