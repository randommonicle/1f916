# Gate: operator_funded scope wording (Sonnet 5.5, text-only), 2026-10-13

HEAD 7b7ffb9a3ee6bc13de64ea5f28b1f020dbe13925 (branch funding-label-2026-10-13), base d6a5cd7829a14c3a91d962f85ce13d0330b532af.
npm test: 2533 tests, 2532 pass, 0 fail, 1 skipped. npm run typecheck: clean.

VERDICT: DEPLOYABLE (no conditions). HIGH 0, MEDIUM 0, LOW 2.

Scope checks
- Q1 Sentence true against evidence: treasury rows 1-4, 10 (the five operator-controlled seats) and 8 sponsored seats' rows all name 0x3f2950...; only sisyphus (row 5) was paid from another wallet and is neither flag. Roster: 5 operator_controlled with operator_funded:false, 7 operator_funded:true. Reaches provenance.operator_funded.check, composition note, /api/citizens note, /llms.txt, door note (own clause). grep of src/ finds no other definition/count surface (skill.md, MCP tools, heartbeat do not mention the flag).
- Q2 doc.ts has ONE hunk (line 639, compositionDoorNote), template (src/doc.ts:164-508) untouched; no change to flags/counts, schema.sql, migrations/, money routes.
- Q3 Mutation in a throwaway copy (removed the sentence from llms.txt, citizens note, provenance check): 3 of 5 tests went red, each with its message. Door clause test is a literal match.
- Q4 Script parses clean (PowerShell parser, 0 errors, ASCII only). Pins stop before any git/network (lines 224-227); live-base proved vs attest (322); template byte-compare (263-266); no-migration diff (268-270); one wrangler call (343); v5 re-asserted after (359); no D1 command; ride is GET-only and hits none of the counted door paths (/skill.md, /heartbeat.md, MCP); sentence read from src/society.ts (282-285, min length, regex rejects backslashes); poll cannot pass without the sentence. Test accepts placeholder or 40 lower-case hex only (test lines 116, 131-136).
- Q5 Only string constants and concatenation added; nothing Node-specific.

LOW
1. src/doc.ts:801 lobbyDoorNote defines "operator-FUNDED" without the scope sentence. Not misleading (it says "sponsored seat"), but it is the one definition not reworded.
2. The sentence states "paid from the operator's wallet" as fact on the citizens note and llms.txt; the "operator's own statement" qualifier sits in neighbouring text (provenance check, official note), not in the sentence itself.

Precondition (not a finding): $REVIEWED_COMMIT still holds the placeholder; the hub must set it, and the script stops until then.
