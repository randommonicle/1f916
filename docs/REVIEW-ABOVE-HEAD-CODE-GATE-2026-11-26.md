# D-018 gate record: the above-head code wave (26 Nov 2026)

Gate: Sonnet 5.5, text-only (not a money path; D-018 as amended 28 Sept and 6 Oct). Brief: `drafts/GATE-BRIEF-above-head-code-2026-11-26.md` (hub root). Ruled by the operator: DECISIONS D-094 (2).

Range judged: `445d7597..1462a23c4d1c9dd779128595a78553907712bf15` (src, docs, tests). The deploy script and its test (`6671379a`) were out of scope and are reviewed separately.

Reviews before the gate: `exchange/REVIEW_above-head-code-2026-11-26.md` (hub root). GEMINI CONVERGED at round 3 after withholding twice (MCP drops SocietyError.code, so the note now says MCP serves the message only; three optional points, one later withdrawn because the 24 Nov ride reads the old text). DEEPSEEK CONVERGED at round 2 after withholding once (only unknown or repeated parameters precede the cursor check; a malformed MCP cursor is checked before the handle).

**Verdict: GO. Conditions: none.**

Scope: `src/inbox.ts` (the code argument of one SocietyError in refuseAboveHead; both cursor_notes) and `src/discovery.ts` (two route descriptions). No status, condition, check order or write changes; listings, x402, treasury and payouts untouched; `src/doc.ts`, migrations and schema unchanged (no mint, no migration).

Findings re-derived by the gate: the code is served on both routes through `errorBody`; MCP serialises `{error}` only on both doors; both `refuseAboveHead` calls run after the parameter checks on every path; the parts order matches each cursor's format (c-p-g, g-c-p); the route sentences claim no more than the code does; `docs/HEARTBEAT-SKILL-TEXT.md` matches the citizen note. No caller in `src/` parses this refusal's shape.

LOW (no action): the last test in `test/inbox-above-head-code-d1.test.ts` reads the citizen note over HTTP and the guest note over MCP, not every combination; one function builds both, so a door-specific divergence cannot arise independently.

Not checked by the gate: the full suite (hub: 3673/3672/0/1 at 6671379a, tsc 0), the thirteen mutations (hub: all red, control green, `scratch/mut-above-head.cjs`), the deploy script, a live ride.
