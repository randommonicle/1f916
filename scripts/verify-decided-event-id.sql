-- Verification for migrations/0023_decided_event_id.sql (A2). Returns the OFFENDING proposal rows: zero rows passes.
-- A decided row (passed, failed, executed) is offending unless: no tally field or tallied_at is NULL, exactly one event carries its id prefix at
-- its tallied_at, decided_event_id is that event, and that event is kind proposal_decided, sealed (hash not NULL), written by the proposer, at
-- tallied_at, with the complete canonical detail (a currently executed first_laws_amendment or text_amendment was tallied `passed`).
-- A row that is not decided is offending if it carries a pointer. Chain integrity is checked separately: GET /api/attest.
SELECT p.id, p.status, p.decided_event_id,
       (SELECT COUNT(*) FROM identity_events c WHERE c.kind = 'proposal_decided' AND c.created_at = p.tallied_at AND c.detail LIKE 'proposal ' || p.id || ' (%') AS candidates
FROM proposals p
WHERE (p.status IN ('passed', 'failed', 'executed') AND (
         p.decided_event_id IS NULL
         OR p.tallied_at IS NULL OR p.tally_yes IS NULL OR p.tally_no IS NULL OR p.tally_abstain IS NULL OR p.eligible_count IS NULL
         OR (SELECT COUNT(*) FROM identity_events c WHERE c.kind = 'proposal_decided' AND c.created_at = p.tallied_at AND c.detail LIKE 'proposal ' || p.id || ' (%') <> 1
         OR NOT EXISTS (
              SELECT 1 FROM identity_events e
              WHERE e.id = p.decided_event_id
                AND e.kind = 'proposal_decided'
                AND e.created_at = p.tallied_at
                AND e.citizen_id = p.proposer_id
                AND e.hash IS NOT NULL
                AND e.detail = 'proposal ' || p.id || ' (' || p.kind || ') '
                  || CASE WHEN p.status = 'executed' AND p.kind IN ('first_laws_amendment', 'text_amendment') THEN 'passed' ELSE p.status END
                  || ': yes=' || p.tally_yes || ' no=' || p.tally_no || ' abstain=' || p.tally_abstain || ' eligible=' || p.eligible_count))
      )
   OR (p.status NOT IN ('passed', 'failed', 'executed') AND p.decided_event_id IS NOT NULL);
