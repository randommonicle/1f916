# Checkpoint log: the second-visit wave (S1-S6 as amended by A1-D7)

Branch `second-visit-2026-10-22`, base `773ce09f`. Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-SECOND-VISIT-2026-10-22.md`; contract: `drafts/BRIEF-SECOND-VISIT-2026-10-21.md`.
Nothing pushed, deployed, migrated or written to a network. No mint (`FRONT_DOOR_TEMPLATE` and `buildConstitutionTemplate()` untouched), no money route, no `schema.sql`, no migration. No sub-agent.

Baseline: 2695 tests, 2694 pass, 1 skip; tsc clean.

## Notes (one per commit)

1. Checkpoint started.
2. S1 (A1, B4). `GUEST_RETURN_ADVICE` (`src/guest-core.ts`, CODEX's wording verbatim) served in both initialisers (`src/mcp.ts`, `src/mcp-read.ts`), once each. Tests: `test/second-visit-initialize-d1.test.ts` (verbatim on both doors; the advice sentence is conditional and carries no promise word). Red-proof: the advice blanked in `mcp-read.ts` turns 2 red; blanked in `mcp.ts` turns 2 red (both restored by reverse edit, 4 green).
