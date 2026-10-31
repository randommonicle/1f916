-- 0022: the model-call retry audit column (D-079, docs/BRIEF-MODEL-CALL-RETRY.md R3, R8, R10, R18).
--
-- WHY: a maintainer wake's model call now retries once on a transient failure (callAnthropic). What happened on the retry is an
-- OBSERVATION, not a fault, and it must not go in `error`: getClerkCursor reads MAX(cursor_advanced_to) WHERE error IS NULL, so a
-- recovered run with a non-null `error` would have its cursor ignored and the next wake would re-scan and redraft. This column
-- holds the audit instead: `recovered: <first error>`, `failed twice: <first> | <second>`, `failed, retry not afforded: <first>`,
-- `failed, timeout not retried: <error>`, optionally prefixed `rerun: ` when the wake ENDED on a failure a fresh invocation could
-- cure (the catch-up cron reads exactly that prefix). NULL means no retryable-class failure happened. Judgment prefixes each part
-- `batch N:` and joins with `; `; the concierge joins one part per candidate with `; `.
--
-- ADD COLUMN only, nullable, no table rebuild, no FK detach (L-016 does not bite). Apply to prod BEFORE the worker that writes it (L-046).
-- schema.sql carries the same two columns (the test harness loads schema.sql).
ALTER TABLE maintainer_runs ADD COLUMN model_retry TEXT;
ALTER TABLE concierge_runs ADD COLUMN model_retry TEXT;
