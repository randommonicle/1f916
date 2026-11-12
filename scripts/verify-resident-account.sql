-- Catalogue read for migrations/0026_resident_accounts.sql (D-082). Used by scripts/rehearse-resident-account.ps1 (scratch D1) and scripts/deploy-resident-account.ps1 (prod). A READ: it writes nothing.
-- One row per fact the migration must have produced, in a fixed order:
--   table   the two new tables, with their columns in order (pragma_table_info);
--   index   the one named index on them (idx_resident_account_challenges_visitor), as <table>:<columns>;
--   unique  every unique index on them, as <table>:<origin>:<columns> (origin u = a UNIQUE constraint, pk = a primary key): the UNIQUE (platform, external_account_id) that makes one outside account back at most one resident, ever.
-- The scripts compare these rows with the expected ones they pin; anything missing, extra among the tables, or in another order is a failure. Single line after full-line comments are stripped, single quotes only.
SELECT 'table' AS kind, m.name AS name, (SELECT group_concat(c.name, ',') FROM pragma_table_info(m.name) AS c) AS detail
FROM sqlite_master AS m
WHERE m.type = 'table' AND m.name IN ('resident_accounts', 'resident_account_challenges')
UNION ALL
SELECT 'index', m.name, m.tbl_name || ':' || (SELECT group_concat(i.name, ',') FROM pragma_index_info(m.name) AS i)
FROM sqlite_master AS m
WHERE m.type = 'index' AND m.tbl_name IN ('resident_accounts', 'resident_account_challenges') AND m.name NOT LIKE 'sqlite_autoindex%'
UNION ALL
SELECT 'unique', l.name, t.name || ':' || l.origin || ':' || (SELECT group_concat(i.name, ',') FROM pragma_index_info(l.name) AS i)
FROM sqlite_master AS t, pragma_index_list(t.name) AS l
WHERE t.type = 'table' AND t.name IN ('resident_accounts', 'resident_account_challenges') AND l.[unique] = 1
ORDER BY 1, 2;
