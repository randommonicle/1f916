# D-018 focused adversarial gate: hardening-2 wave + review closeout (`39628f6..570b4ed`)

Date: 2026-08-10. Reviewer: a fresh Claude Opus agent (read-only, scratch
clones for red-proof re-runs; ~210k tokens, 67 tool calls, ~18 minutes),
commissioned under the society's D-018 rule: authority-bearing governance
machinery deploys only after a focused adversarial review at a different
tier from its builder. Range: ten commits — the six hardening-2 wave
commits (`39628f6`, `c6e67dd`, `d63c7e8`, `0216f94`, `57dc610`, `e3c0589`)
and the four review-closeout commits (`f86b15e`, `4d2712e`, `72e6f93`,
`570b4ed`). The closeout's own findings came from a converged external
review by Codex and Gemini (operator-side exchange records) plus the
architect's line review; every load-bearing claim below was re-derived by
the gate reviewer independently, red-proofs re-run against pre-fix parents
in a scratch clone.

Path conventions: `src/...` and `test/...` are this repository.
References to `docs/BRIEF-*`, `docs/CHECKPOINT.md` and `exchange/...` are
the operator-side project records outside this repository; the substance
they carry is summarised where load-bearing.

Working-tree discipline: verified clean at `570b4ed` before and after; no
`*.local.*` file opened; all scratch work outside the project tree.

---

## VERDICT: DEPLOYABLE

Every load-bearing claim in the wave re-derived from source and
independently red-proved against its own pre-fix parent; the
authority-path behaviour is correct under verbatim real-workerd D1 error
strings and `meta` shapes; no migration, config or dependency change;
371/371 and typecheck clean at HEAD. The six findings below are
non-blocking: one is a pre-existing residue already live at `574e067` that
this wave neither creates nor worsens, one is a scope gap in a test-only
gate, and four are documentation, message-accuracy or latent-parser items.

## Findings, ranked

### 1. F1's sibling window is still open: a resumed stale claimant that wins the race against a re-claimer writes its stale tally to the permanent chain

**Severity: Medium (pre-existing, already live, not reachable given Worker
lifetimes).**

`src/governance.ts:911` gates the outcome batch on `status = 'tallying'`
only. The claim UPDATE at `:1001-1007` stamps `tallied_at = now`, but the
gate never checks it. So the gate cannot distinguish "still tallying under
MY claim" from "still tallying under someone else's re-claim".

Failure scenario: A claims and stalls. Past `STALE_CLAIM_MS`, B re-claims
(status stays `'tallying'`). A resumes BEFORE B commits. A's gate passes,
A's batch commits A's stale tally, and B then gets `claimed_elsewhere`.
The F1 fix covers only the resumed-after-commit case.

Evidence (reproduced in the scratch clone, real local-D1 harness):

```
A reports          : [{"proposal_id":1,"outcome":"executed"}]
committed row      : {"status":"executed","eligible_count":4,...}   <-- 4 = A's STALE census; fresh read = 5
sealed public event: proposal 1 (set_split) executed: yes=2 no=0 abstain=0 eligible=4
```

The wrong verdict reaches the hash-chained public record, not merely the
HTTP report. The asymmetry worth recording: F1 stops a stale claimant
REPORTING a wrong outcome, and this window lets a stale claimant COMMIT
one.

Not a blocker: the gate was introduced by `a31a6b5` and is already
deployed at `574e067`, so blocking this wave does not close it; and it
requires a >= 15-minute in-request stall followed by resumption, which
`src/governance.ts:976-978` argues exceeds any real Worker request
lifetime. That argument is the same premise the F1 fix itself rests on, so
if F1 was worth building, this is worth queueing.

Minimal fix (its own briefed commit, its own red-proof, not slipped into
this deploy): bind the claimant's own stamp into both gated statements,
`... AND status = 'tallying' AND tallied_at = ?` with the caller's `now`,
at `src/governance.ts:911` and the status UPDATE at `:1096`. A's resumed
batch then no-ops and returns `claimed_elsewhere` through the path that
already exists.

### 2. The L-002 gate's allowlist exempts its tokens file-wide and by basename suffix, so planted residue in `doc.ts` passes silently

**Severity: Low-Medium (control scope, test-only, corpus currently
clean).**

`test/l002-residue.test.ts:205-207`:

```ts
return ALLOWLIST.some((a) => hit.file.endsWith(a.file) && hit.match.includes(a.match));
```

Two gaps. The entry `{ file: "doc.ts", match: "1f916-ai" }` exempts that
token ANYWHERE in `doc.ts`, not just the ON THE SOURCE attribution its
comment describes; `doc.ts` is the served front door and the likeliest
host for a fifth L-002 instance. And `endsWith` matches any path whose
basename merely ends with the entry, so a future `src/apidoc.ts` inherits
the exemption.

Evidence (scratch clone, both reproduced, tree restored after each):

- Planted `// Incident numbering in this deployment follows the 1f916-ai
  tracker.` at `src/doc.ts` line 2. Gate result: **3/3 pass, green.**
- Created `src/apidoc.ts` carrying `1f916-ai`. Gate result: **3/3 pass,
  green.**
- Control, same text in `src/apihelper.ts`: gate **fails**, 2 pass / 1
  fail.

The closeout's red-proof (disabling `isAllowlisted` wholesale) proves the
entries are REACHED, not that they are NARROW; those are different
properties.

Minimal fix: compare basenames exactly (`basename(hit.file) === a.file`)
and pin the expected occurrence count per entry, or require the matched
line to carry the attribution phrase (`with thanks`).

### 3. The wave's own record misstates the empty-batch / absent-meta outcome, and the wave newly makes a public endpoint emit a raw TypeError

**Severity: Low (safety conclusion holds; the stated mechanism does not).**

The closeout's exchange record (CLAUDE round 2 §3.1, echoed in the
operator-side checkpoint) says the empty-batch TypeError "leaves the row
at `'tallying'` for H1's stale-claim re-entry". Reproduced at HEAD with
`batch()` returning `[]`:

```
sweep result: [{"proposal_id":1,"outcome":"error","error":"TypeError: Cannot read properties of undefined (reading 'meta')"}]
stranded    : []
proposal row: {"status":"passed","tallied_at":...}   decided evts: 1
```

The row is TERMINAL and CORRECT. There is no strand and no H1 re-entry,
because `await env.DB.batch(...)` at `src/governance.ts:941` has already
committed before the dereference at `:942` throws. The same run against
pre-wave `574e067` reports `[{"proposal_id":1,"outcome":"passed"}]`. So
the disposition's conclusion (safe, recoverable, no data harm) survives;
its reasoning does not.

Two consequences worth recording. First, the wave is internally
inconsistent on the same driver-corruption class: `meta:{}` (changes
absent) yields a quiet `claimed_elsewhere`, while `meta` absent entirely
yields a public `outcome:"error"`. Second, `src/governance.ts:1146` puts
`String(e)` for non-`SocietyError` into the response of the
unauthenticated `POST /api/governance/sweep` (`src/index.ts:236`), so the
raw JS message is publicly readable. The catch predates the wave; this
error class reaching it does not.

Either fix is defensible: `logRes?.meta?.changes !== 1` at `:942`, landing
the sibling case on the conservative path the wave already blessed; or
leave the code and correct the two records. [Adjudicated post-gate:
records corrected; code unchanged this deploy — see the exchange record's
round 3.]

### 4. The F5 clause can serve three false statements at once under the F3 anomaly

**Severity: Low.**

`src/governance.ts:708-714`. Reproduced with `changes` stripped from the
ballots INSERT only (the write proceeds underneath):

```
SERVED MESSAGE: 409: proposal 1 is no longer open for balloting: it was claimed for tallying
while this ballot was in flight. Not recorded -- the tally already ran without it.
You had also already cast a ballot on this proposal; only your original ballot counts.
ballot rows actually written: 1 | proposal status: open
```

The proposal is open, the ballot WAS recorded, and the "already cast"
clause refers to the ballot this very call just cast. F5 existed to make
this message accurate; the new clause is what turns merely-wrong into
self-contradictory. Under normal driver behaviour (`changes` 0 or 1) the
message is correct, so this needs the same anomaly F3 defends against.

Minimal fix: have `hasExistingBallot` also return `cast_at` and append the
clause only when it differs from this call's `now`.

### 5. `parseUniqueColumns` truncates at the first non-qualified token, and honours the first marker occurrence

**Severity: Low, not reachable on the present schema or SQL.**

`src/chain.ts:296-304`. Adversarial table run through the real
`appendChainedGated`:

| message | result |
|---|---|
| `...failed: ballots.proposal_id, ballots.citizen_id, oops` | DUPLICATE_VOTE(409) after 1 call |
| `D1_ERROR: near "UNIQUE constraint failed: ballots.proposal_id, ballots.citizen_id": syntax error; real: UNIQUE constraint failed: ballots.prev_hash` | DUPLICATE_VOTE(409) after 1 call |
| `...failed: ballots.proposal_id, ballots.citizen_id, ballots.choice` (Fix 1's case) | RETRY_THEN_503 (correct) |
| reordered, superset, `main.`-qualified, quoted, uppercase, NBSP-after-colon, no-space-after-colon | all unrecognised (safe) |

The first row is Fix 1's exact defect re-opened for a list whose extra
element is unqualified; the second is the "marker inside quoted data"
case. Neither is reachable: SQLite always fully qualifies every element
(verified), and the only SQL text is `chain.ts`'s own literal with `?`
placeholders plus a hardcoded gate string, so no user data can reach the
message (`choice` is validated to an enum at `src/governance.ts:602`
before any bind).

Minimal fix if wanted: anchor the match to a terminator,
`(?=$|[^A-Za-z0-9_.,\s])`, or scan the last marker rather than the first.

Also observed, pre-existing and unchanged by this wave: a lower-cased
`unique constraint failed:` is rethrown rather than retried, because the
retry predicate is `String(e).includes("UNIQUE")` (`src/chain.ts:339`,
`:185`, `src/governance.ts:962`).

### 6. The F4 attempt-0 ordering fact is index-creation-order dependent, and the comment presents it as a property of SQLite

**Severity: Low, informational.**

`src/chain.ts:262-283` and `test/governance-d1.test.ts:175-186` state that
when one INSERT violates both indexes, SQLite reports only `prev_hash`.
True for this schema, but the cause is reverse-creation order, not a fixed
rule. Probe, sqlite 3.51.3:

```
A: schema.sql order (proposal_citizen :233, prev :234, hash :235)
   double-violation -> UNIQUE constraint failed: ballots.prev_hash
B: creation order reversed (prev, hash, proposal_citizen)
   double-violation -> UNIQUE constraint failed: ballots.proposal_id, ballots.citizen_id
```

Benign today, and benign if it ever flips: both classifications reach a
correct 409, because `duplicate_vote` only fires when the
`(proposal_id, citizen_id)` pair genuinely collides. The comment should
say the ordering is not contractual rather than resting the two-attempt
claim on it.

## Findings killed by the reviewer's own reproduction

- "A false `claimed_elsewhere` harms a consumer." Killed. `commitOutcome`
  has exactly one caller (`src/governance.ts:1102`),
  `claimTallyAndExecuteOne` exactly one (`:1141`), `runGovernanceSweep`
  two (`src/index.ts:236` returns it as JSON, `:286` discards it). Nothing
  branches on a specific final status.
- "Holding `created_at` fixed can loop or collide." Killed.
  `schema.sql:84-85` puts UNIQUE only on `identity_events.prev_hash`/
  `.hash`; each retry re-reads the head so `prev_hash` differs. Two
  claimants producing byte-identical row content is unreachable: the claim
  UPDATE admits exactly one winner, and the only path to a second
  concurrent claimant is stale re-claim, which forces a >= 15-minute gap
  between their `now` values and therefore different `created_at` and
  `detail`.
- "A chain-head race can be spoofed into `duplicate_vote`, or the
  reverse." Killed against real workerd D1 (below).
- "`castVote`'s `!== 1` can refuse a legitimate first vote." Killed. Real
  D1 returns `changes: 1` for a fresh `INSERT OR IGNORE`; the test harness
  reports genuine `Number(result.changes)` from node:sqlite
  (`test/helpers/local-d1.ts:91`). Cap accounting is consistent: the
  duplicate writes no `votes` row (PK `(citizen_id, target_type,
  target_id)`, `schema.sql:53`) so it is cap-exempt, which is exactly why
  the free-karma hole was unbounded.
- "Schema-qualified column names would silently disable the duplicate-vote
  fast path." Killed. SQLite emits bare `ballots.x` even for
  `INSERT INTO main.ballots` and for ATTACHed schemas.
- "The wave weakened or removed a test." Killed. The only deletions in
  `test/` across the range are the N6 title, comment and one assertion,
  all replaced with a stronger pair (`test/governance-d1.test.ts:1216-1220`).
- TODO/FIXME/XXX/"for now" in added lines: none.

## Confirmed closed

Each red-proved by the gate reviewer independently, by checking out the
pre-fix parent's source into a scratch clone and running the committed
regression at HEAD against it.

| Item | Evidence |
|---|---|
| F1 (stale claimant publishes an uncommitted outcome) | vs `574e067`: `actual: 'executed', expected: 'claimed_elsewhere'` |
| F2 (phantom hash) | Structural: `commitOutcome` (`src/governance.ts:910`) can no longer return `{hash}` on any non-`1` path; behaviourally covered by the F1 divergent test asserting `doesNotMatch(detail, /executed/)` |
| F3 (absent `changes` fails open) | vs `39628f6`: `actual: { prev_hash: '000…', hash: '22b3b30e…' }, expected: null` |
| F4 (duplicate burns four retries, false 503) | vs `c6e67dd`: `chain head for ballots moved four times running… retrying may succeed` |
| F5 (409 names only the closure) | vs `c6e67dd`: `proposal 1 is no longer open for balloting… tally already ran without it` (no duplicate clause) |
| F6 (`created_at` drifts from `tallied_at`) | vs `574e067`: `actual: 1786395285461, expected: 1893456000000` |
| Fix 1 (substring to exact parse) | vs `e3c0589`: sole failure `a ballot UNIQUE superset is unrecognised and never becomes an already-voted 409` |
| Fix 2 (L-002 claim narrowed) | Title, failure message, scanner comment (`test/l002-residue.test.ts:118-129`) and boundary fixture all state contiguous-raw-source; the fixture carries a contiguous control so it fails in both directions. No residual over-promise found in the file's wording. |
| Finding A (`=== 0` fails open in `commitOutcome`) | vs `e3c0589`: `actual: 'passed', expected: 'claimed_elsewhere'` |
| castVote fix (free-karma hole) | vs `72e6f93`: `Missing expected rejection` and karma moved; at HEAD refused with karma held |

**Real-workerd D1 verification** (miniflare 5.20260730.0-alpha, matching
the pinned workerd 1.20260730.1, entirely local, no wrangler and no
network):

```
gate PASSES      -> {"changes":1,"changed_db":true,"rows_written":5}
gate REFUSES     -> {"changes":0,"changed_db":false,"rows_written":0}   (no throw)
batch(refused)   -> [{"changes":0,...},{"changes":0,...}]               (in order, lockstep)
dup violation    -> D1_ERROR: UNIQUE constraint failed: ballots.proposal_id, ballots.citizen_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)
prev violation   -> D1_ERROR: UNIQUE constraint failed: ballots.prev_hash: …
double violation -> D1_ERROR: UNIQUE constraint failed: ballots.prev_hash: …
```

Those verbatim strings through the real `appendChainedGated`: dup gives
409 in one attempt, prev and hash take the retry path. This closes the
long-standing "F4 attempt-0 on real workerd" open item and confirms
`!== 1` costs nothing on the real path.

## Unverified, stated plainly

- Genuine CONCURRENT D1 writers. Every race here, as in every prior
  review, ran against a serialising SQLite. The guards' logic was
  exercised; true parallelism was not.
- Production (remote) D1 versus miniflare's local D1. The probes above ran
  against workerd's D1 implementation locally. Cloudflare's hosted D1
  could in principle differ in `meta` shape or error wrapping; the
  `!== 1` guards are precisely the defence against that.
- Finding 1's window under production timing: whether a Cloudflare Worker
  can stall 15 minutes mid-request and resume was not tested;
  `src/governance.ts:976-978` argues it cannot.

## Suite status (run by the gate reviewer at HEAD `570b4ed`)

```
npm test          ->  tests 371 | pass 371 | fail 0 | cancelled 0 | skipped 0 | todo 0
npm run typecheck ->  tsc, exit 0, no diagnostics
```

Range touches `src/chain.ts`, `src/governance.ts`, `src/mcp.ts`,
`src/society.ts` and five test files only: no migration, no
`wrangler.jsonc`, no `package.json`, no `schema.sql`.

## Post-deploy queue recommended by the gate

In order: finding 1 as its own briefed commit with its own red-proof (the
only one touching authority-path behaviour); finding 2 as a one-line
tightening of the gate's allowlist; findings 3 and 4 as record corrections
plus optional one-line changes; findings 5 and 6 as comment-accuracy items
riding any later chain.ts work.
