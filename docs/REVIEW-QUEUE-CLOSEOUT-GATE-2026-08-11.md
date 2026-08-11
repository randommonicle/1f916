# D-018 focused adversarial gate: the hardening-2 post-deploy queue closeout (`1cc2d32..4c6a7e2`)

Date: 2026-08-11. Reviewer: a fresh Claude Opus agent (read-only, scratch
clones for red-proof re-runs; ~118k tokens, 36 tool calls, ~10 minutes),
commissioned under the society's D-018 rule: authority-bearing governance
machinery deploys only after a focused adversarial review at a different
tier from its builder. This wave's builder was a Claude Fable agent, so
the tier separation holds builder-to-reviewer within one model family;
the converged EXTERNAL review pairing used by prior closeouts (Codex and
Gemini, operator-side exchange records) was not available this session --
stated plainly rather than papered over, per this repo's own
working-agreement on scope honesty. Range: five code commits closing the
post-deploy queue recommended by
`docs/REVIEW-HARDENING2-GATE-2026-08-10.md` -- `6a1c6e9` (finding 1),
`fb17694` (finding 2), `e616ae1` (finding 4), `b4ba446` (finding 3's
adjudicated optional line), `4c6a7e2` (findings 5+6). The range's base
commit `1cc2d32` is README-only and was out of the gate's scope.

Working-tree discipline: verified clean at `4c6a7e2` before and after; no
write to the repo tree; all scratch work outside the project tree.

---

## VERDICT: DEPLOYABLE

Every queued finding re-derived from source and independently red-proved
against its own pre-fix parent; the F1 claim stamp is bound into all
three (and only three) `status = 'tallying'`-gated statements with
correct bind arity; adversarial probes of both behaviour-changing paths
(invariant-violation recovery, empty-batch-without-commit) land on the
safe side; 376/376 and typecheck clean at HEAD. One new Low finding
(theoretical parser narrowing, no reachable real-driver message) and four
informational notes, none blocking, queued below.

## Per-commit red-proofs

Method: scratch clone, `git checkout <commit>~1 -- <source file>` with
HEAD's tests retained, committed regression run against the pre-fix
source.

| Commit | Regression | Pre-fix ACTUAL vs EXPECTED | At HEAD |
|---|---|---|---|
| `6a1c6e9` (queue finding 1) | mid-flight re-claim race | `actual: 'executed'` vs `expected: 'claimed_elsewhere'` -- A's stale tally committed | pass |
| `fb17694` (finding 2) | L-002 classification red-proof | each narrowing reverted separately: `endsWith` restored → red on the `apidoc.ts` fixture only; `lineContains` dropped → red on the `doc.ts` plant only | pass |
| `e616ae1` (finding 4) | own-write "already cast" clause | `doesNotMatch` failed on the served "You had also already cast a ballot..." | pass |
| `b4ba446` (finding 3) | empty batch result | `actual: 'error'` vs `expected: 'claimed_elsewhere'` (raw TypeError in the public sweep response) | pass |
| `4c6a7e2` (finding 5a) | unqualified trailing element | 409 in 1 call (truncated to the pair) instead of retry-then-503 | pass |
| `4c6a7e2` (finding 5b) | marker echoed in quoted data | a genuine chain-head race thrown as the already-voted 409 | pass |

Finding 2's original REAL-filesystem reproductions were additionally
re-run at HEAD, not only the pure-function fixtures: the planted doc.ts
line and a created `src/apidoc.ts` each fail the gate at HEAD (caught);
both were green pre-fix per the prior gate record. Clone restored, 3/3
green after.

## New findings, ranked

### F-A. The terminator lookahead treats whitespace and `.` as forbidden continuations, so a whitespace-terminated UNIQUE message becomes `unrecognised`

**Severity: Low, theoretical -- not reproduced against any real driver
string.**

`src/chain.ts` (COLUMN_LIST): the class `[^A-Za-z0-9_.,\s]` excludes
`\s`, so `UNIQUE constraint failed: ballots.proposal_id,
ballots.citizen_id ` with a trailing space or newline parses to null.
`classifyUniqueViolation` then returns `unrecognised` and
`appendChainedGated` burns 4 attempts into a 503 where F4 established an
immediate 409 -- F4's defect shape re-opened for that message shape
only. For `prev_hash`/`hash` the narrowing is inert (`chain_head` and
`unrecognised` both retry). Reachability: probed real node:sqlite 3.51.2
directly -- all four violation shapes emit exactly one marker and no
trailing whitespace; workerd's recorded strings continue with
`: SQLITE_CONSTRAINT...`, which the lookahead accepts; six real shapes
parse identically pre/post. The lookahead is the prior gate record's own
verbatim recommendation, so this is inherited, not invented.

Minimal fix if wanted (its own commit, its own red-proof): drop `\s`
from the excluded class -- `(?=$|[^A-Za-z0-9_.,])` -- which still
refuses the 5a `, oops` case, since `,` remains forbidden.

### F-B. Finding 4's efficacy assumes `cast_at` deserialises as a JS number on hosted D1

**Severity: Informational.** `prior.cast_at !== now` is strict: a driver
returning the INTEGER column as a string or BigInt would make the
comparison always true and silently revert to pre-fix behaviour
(degrades to the old defect, never worse). True for node:sqlite; not
verified against hosted D1.

### F-C. Finding 4's residual: the closure sentence itself is still false under the F3 anomaly

**Severity: Informational, adjudicated.** Under the anomaly the served
409 still says "Not recorded -- the tally already ran without it" while
the ballot landed and the proposal is open. This is the prior gate's
prescribed minimal fix (self-contradiction removed, not the whole
inaccuracy); the new test asserts the residue explicitly.

### F-D. `lineContains` anchors the L-002 allowlist to prose strings

**Severity: Informational, disclosed in the file itself.** Rewording
either anchored comment fails the gate closed (safe); residue planted on
a line that also fakes the context phrase passes (the declared lexical
boundary -- the committer remains the trust boundary).

### F-E. Version citation drift

**Severity: Trivial.** `src/chain.ts` cites "sqlite 3.51.3" (the prior
gate's probe); this repo's node ships node:sqlite on 3.51.2. The
reviewer re-derived the double-violation ordering claim on 3.51.2 in
both index orders; the fact holds, only the cited version is carried
over.

## Findings attempted and killed by the reviewer's own reproduction

- Unstamped `status='tallying'` statement falling out of lockstep:
  killed by enumeration -- exactly three gated statements, all stamped;
  the claim UPDATE is correctly unstamped (it is the stamper) and the
  due query is a read.
- Equal claim stamps across re-claims: killed by construction --
  re-claims require a >= STALE_CLAIM_MS (900000 ms) gap, every claim
  writes its own `now`.
- NULL `tallied_at` refusing the stamped gate forever: killed -- the
  claim UPDATE always writes a non-NULL stamp before any gate executes.
- One `now` across many due proposals breaking the gates: killed -- every
  gate is also keyed on the proposal PK.
- `invariant_violation` early-return stranding the row under stamped
  gates: killed by probe -- a later sweep re-claims and restamps; the
  documented perpetual-re-claim recovery loop is alive.
- Finding 3's `claimed_elsewhere` unsafe when `[]` came with NO commit:
  killed by probe -- row stays 'tallying', a later healthy sweep commits
  exactly one sealed outcome event.
- `lastIndexOf` breaking or harmfully mirroring a real message: killed --
  all real shapes carry exactly one marker; the constructed two-marker
  mirror misfiles toward `chain_head`, whose retry reaches the same 409
  one round trip later.
- ReDoS in the anchored regex: killed -- 20k-element adversarial lists
  match in ~5 ms, scaling linearly; separator and identifier classes are
  disjoint.
- Bind arity/order regression at the three stamped sites: killed by
  placeholder-vs-bind counts (7/7, 2/2, 8/8) plus typecheck.
- Pre-check `!= null` behaviour change: killed -- row object truthiness
  and the NOT NULL column make it identical.
- Same-millisecond genuine prior ballot suppressing the clause: killed as
  unreachable-and-conservative -- reaching the path requires the gate to
  have refused this call's own write; the worst case is one omitted
  sentence, declared in the code comment.
- A weakened/deleted test anywhere in the range: killed -- the only
  removed assert-shaped line across `git diff 1cc2d32..HEAD -- test/`
  is prose inside a replaced comment block.
- Allowlisted real sites not carrying their declared phrases: killed --
  both verified on their single physical lines; `1f916-ai` occurs exactly
  once in `src/`.
- Finding 6's ordering claim wrong: killed by independent re-derivation
  in both index-creation orders.

## Unverified, stated plainly

- Genuine CONCURRENT D1 writers (all races ran against serialising
  SQLite).
- Hosted Cloudflare D1 vs local: workerd strings and `meta` shapes taken
  from the prior gate's recorded verbatim outputs; the deserialised JS
  type of `cast_at` on hosted D1 is unverified (F-B).
- Whether a Worker can stall >= 15 minutes mid-request and resume -- the
  premise both F1 and queue finding 1 rest on, unchanged from every
  prior review.
- `docs/` prose accuracy beyond the prior gate record; commit `1cc2d32`
  (README) was out of scope.

## Suite status (run by the gate reviewer at HEAD `4c6a7e2`)

```
npm test          ->  tests 376 | pass 376 | fail 0 | cancelled 0 | skipped 0 | todo 0
npm run typecheck ->  tsc, exit 0, no diagnostics
```

Range touches `src/chain.ts`, `src/governance.ts` and three test files
only: no migration, no `schema.sql`, no `wrangler.jsonc`, no
`package.json`. (A separate docs-only commit on the same branch corrects
`wrangler.jsonc`'s stale judgment-day comment; it changes no
configuration value and was outside this gate's range.)

## Post-deploy queue recommended by the gate

F-A as an optional one-character widening with its own red-proof; F-B
worth a one-time probe against hosted D1 whenever other work touches it;
F-E as a comment-accuracy chip riding any later chain.ts work. F-C and
F-D are adjudicated/disclosed, no action.
