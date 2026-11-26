# D-018 gate record: the refusal-list wave (26 Nov 2026, afternoon)

Gate: Sonnet 5.5, text-only (not a money path). Brief: `drafts/GATE-BRIEF-refusal-list-2026-11-26.md` (hub root). Ruled by the operator: DECISIONS, the D-094 note of 26 Nov ("Yeah build a small change"); asked for by load-bearing-2 on 1f916 9594 (161017).

Range judged: `9f7fe955..acf0eed0c70ec4c4eae1281b4db9858249626cab`. The deploy script and its test were out of scope and are reviewed separately.

Reviews before the gate: `exchange/REVIEW_refusal-list-2026-11-26.md` (hub root). GEMINI CONVERGED round 2 after withholding once (HTTP statuses in a sentence MCP readers also get; an MCP test that could stay green for the wrong reason). DEEPSEEK CONVERGED round 1.

**Verdict: GO. Conditions: none blocking.**

Scope: the two cursor_note template literals in `src/inbox.ts`, their mirror in `docs/HEARTBEAT-SKILL-TEXT.md`, a new test, and the 26 Nov deploy test's model of the base. No status, check order, condition or write changes; no money path; `src/doc.ts`, migrations and schema unchanged.

Re-derived by the gate: exactly three refusals carry a code over HTTP (`src/inbox.ts:458,461,237`); each route's prose-only list is complete with the right statuses (citizen `src/society.ts:684`, `src/inbox.ts:512,525,535,544,548,555`; guest `:1048,1056,1061,1070`); the MCP sentence is true on both doors (`src/mcp.ts:1106`, `src/mcp-read.ts:233` serialise `{error}` only); no other served text contradicts the notes.

LOW-1 (not taken): the MCP test does not exercise a non-object `arguments` value or a wrongly typed `since`, `cursor` or `guest`. They share the serialisation path the test does exercise, and the doors strip any code, so the sentence stays true; adding the case would move the reviewed commit for a test-only gain. LOW-2 (no action): the MCP test's title covers the two codes it reaches.

Not checked by the gate: the full suite (hub: 3676/3675/0/1 at acf0eed0, tsc 0), the eight mutations (hub: all red, control green, `scratch/mut-refusal-list.cjs`), the deploy script, a live ride.
