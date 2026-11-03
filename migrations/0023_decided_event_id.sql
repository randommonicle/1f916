-- 0023: decided_event_id on each proposal row (D-078 item 3, drafts/BRIEF-DECIDED-EVENT-ID-2026-11-03.md B1, B2, A2, A6).
--
-- WHY: a proposal row's status and tallies are written by the tally in the same batch as the chained `proposal_decided` identity event that
-- records the outcome. This column names that event, so a reader can join the row to its record without trusting a timestamp coincidence.
-- It points at the TALLY event and is never rewritten: constitution detection can later move a passed amendment to `executed`, which is
-- recorded separately in `constitution_changed`. NULL while a proposal is open or tallying.
--
-- No REFERENCES clause (A6): this wave leaves referential integrity to the writer and to scripts/verify-decided-event-id.sql; a foreign key
-- would enforce existence, not the semantic join (right kind, right proposal, right counts).
--
-- ADD COLUMN only, nullable, no table rebuild, no FK detach (L-016 does not bite). Apply to prod BEFORE the worker that writes it (L-046).
-- schema.sql carries the same column, last in the table (the test harness loads schema.sql).
--
-- The backfill below is idempotent and is re-run by scripts/deploy-decided-event-id.ps1 after worker activation (A5 step 6). It links a
-- decided row only when exactly one event carries its id prefix at its tallied_at AND that event's actor, seal and complete canonical detail
-- (format at src/governance.ts, the `detail` of claimTallyAndExecuteOne) match the row, with the amendment exception: a currently executed
-- first_laws_amendment or text_amendment was tallied `passed`. Anything else stays NULL and is caught by scripts/verify-decided-event-id.sql.
ALTER TABLE proposals ADD COLUMN decided_event_id INTEGER;

-- BACKFILL BEGIN
UPDATE proposals SET decided_event_id = (
  SELECT e.id FROM identity_events e
  WHERE e.kind = 'proposal_decided'
    AND e.created_at = proposals.tallied_at
    AND e.citizen_id = proposals.proposer_id
    AND e.hash IS NOT NULL
    AND e.detail = 'proposal ' || proposals.id || ' (' || proposals.kind || ') '
      || CASE WHEN proposals.status = 'executed' AND proposals.kind IN ('first_laws_amendment', 'text_amendment') THEN 'passed' ELSE proposals.status END
      || ': yes=' || proposals.tally_yes || ' no=' || proposals.tally_no || ' abstain=' || proposals.tally_abstain || ' eligible=' || proposals.eligible_count
)
WHERE status IN ('passed', 'failed', 'executed')
  AND decided_event_id IS NULL
  AND tallied_at IS NOT NULL AND tally_yes IS NOT NULL AND tally_no IS NOT NULL AND tally_abstain IS NOT NULL AND eligible_count IS NOT NULL
  AND (SELECT COUNT(*) FROM identity_events c
       WHERE c.kind = 'proposal_decided' AND c.created_at = proposals.tallied_at AND c.detail LIKE 'proposal ' || proposals.id || ' (%') = 1;
-- BACKFILL END
