# Adversarial review: the democratic mechanism (97584ad..87c1c4c)

Independent second review, D-018 tier. Read-only. No repo file was edited,
no push, no deploy, no `--remote`, no network call, no `*.local.*` file
read. Baseline re-established first: `npm test` 320/320, `npm run
typecheck` clean, `git status -sb` shows `main...origin/main [ahead 6]`
and nothing else, before and after.

Every finding below that says "reproduced" was reproduced by running the
real `src/` modules against the real `schema.sql` through
`test/helpers/local-d1.ts`, from scratch scripts outside the repo.
Node's `DatabaseSync` was verified to enforce foreign keys by default, so
the harness is FK-faithful (probed directly, not assumed).

---

## Verdict: DEPLOYABLE WITH FIXES

Three fixes gate the deploy. Nothing here needs a redesign; the tally
arithmetic, the claim-then-act shape, the payload floors and the
sweep's write surface all survived everything I threw at them.

**Gating (must land before this reaches the live Worker):**

1. **H1** Recover a proposal stranded in `'tallying'`. Any throw between
   the claim and the outcome commit parks a proposal in a status no code
   path ever reads again. Reproduced twice.
2. **H2** Freeze the eligibility rule per proposal. The planned flip of
   `REGISTRATION_MODE` from `invite_only` to `open` turns a vote that
   FAILED on quorum into one that EXECUTES a rename, on the identical
   ballots. Reproduced.
3. **H3** Apply migration 0005 remotely and verify it BEFORE the code
   deploy, as an ordered gate, not a note. Pre-migration code takes down
   `GET /`, `GET /api/official`, `GET /api/attest` and the MCP `official`
   tool. Broader than the architect's flag: `/api/attest` was not on it.

**Strongly recommended in the same pass** (M2, M3, M4, M5): the policing
test does not police what it claims, and the front door states four facts
that a passed vote has already superseded.

Counts: **3 High, 7 Medium, 9 Low, 9 killed.**

---

## High

### H1. A crash between claim and commit strands a proposal in `'tallying'` forever

`src/governance.ts:733` (claim), `:711-728` (`commitOutcome`),
`:797-811` (`runGovernanceSweep`), `:804-808` (the per-proposal catch).

**Scenario.** `claimTallyAndExecuteOne` stamps `status='tallying'`
(`:733`). Between that stamp and the atomic outcome batch there are five
more D1 round trips plus the chained append. Anything that throws in
that span leaves the row at `'tallying'`. The sweep's own due query is
`SELECT id FROM proposals WHERE status = 'open' AND closes_at <= ?`
(`:798`), so the next sweep does not see it. Grepping `src/` for
`tallying` returns exactly two writes and zero reads: nothing anywhere
recovers it.

Realistic triggers, none exotic:
- `commitOutcome` exhausting its 4 attempts (`:727`). The chain it
  appends to is `identity_events`, shared with registration, key
  rotation, model correction, wallet declaration and every moderation
  action. Four appends landing during one sweep exhaust the loop.
- Any transient D1 error on any of the six statements.
- Worker eviction, CPU limit, or the free plan's per-request subrequest
  ceiling. The sweep costs roughly 7-8 subrequests per due proposal and
  is unbounded in how many it processes in one call. (I could not
  measure the live plan's ceiling without a network call, so treat this
  trigger as plausible rather than proven; H1 does not depend on it.)

**Reproduced.** Three yes ballots on an advisory `resolution` that would
have passed. One `batch()` failure (`"Network connection lost."`):

```
sweep 1: results:[{proposal_id:1, outcome:"error", error:"Error: Network connection lost."}]
proposal row: {status:"tallying", tally_yes:null, tallied_at:null}
sweep 2 (60s later):        due:0  -> status still "tallying"
sweep 3 (400 days later):   due:0  -> status still "tallying"
```

Separately reproduced through the documented retry path: force every
`batch()` to raise a `UNIQUE` error, the 4-attempt loop exhausts, same
outcome.

Consequences: the vote never passes, never fails, never writes a
`proposal_decided` event. `GET /api/proposal/:id` serves `status:
"tallying"` with null tallies indefinitely. `officialFacts`'s
`open_proposals` counts only `'open'`, so it silently drops off the
public count. The proposer's 1-open-proposal rate cap also counts only
`'open'`, so the strand is invisible from every angle except reading the
row. The only remedy is a hand-written `UPDATE` against the live
database, i.e. exactly the out-of-band write on the governance record
that `test/governance-policing.test.ts` exists to forbid.

A cron-fired strand leaves only a `console.log` (`src/index.ts:244-248`);
there is no `maintainer_runs` row and no public surface for it.

**Severity: High.** A passed vote does not execute, unattended, with no
recovery and no alarm.

**Minimal fix.** Make a stale claim re-claimable, without reopening the
double-execution race the claim closed:

- Add a claim stamp (reuse `tallied_at`, which the final UPDATE
  overwrites anyway) and widen the due query to
  `status='open' OR (status='tallying' AND tallied_at <= now - STALE_MS)`
  with `STALE_MS` comfortably beyond any Worker lifetime (15 min is
  ample). Re-claim conditionally on the same predicate.
- Belt: make the settings statement share the state UPDATE's guard, so
  both statements in the batch are conditional on the row still being
  `'tallying'`, e.g.
  `INSERT INTO governance_settings (...) SELECT ?,?,?,?,? WHERE EXISTS
  (SELECT 1 FROM proposals WHERE id=? AND status='tallying') ON CONFLICT ...`.
  With that guard a re-claim is safe even with no timeout, because a
  second committer writes nothing.
- Report strands: include stranded ids in the sweep's return value so
  `POST /api/governance/sweep` names them instead of them being visible
  only row by row.

---

### H2. Flipping `REGISTRATION_MODE` mid-vote turns a FAILED vote into an EXECUTED rename

`src/governance.ts:744-750` (ballot counts, no eligibility filter),
`:754-765` (census computed at close from `env.REGISTRATION_MODE`),
`:281-304` (`assertEligible`, mode check at `:294`), `:559` (the same env
read at cast time). `wrangler.jsonc:42` currently holds
`"REGISTRATION_MODE": "invite_only"`.

**Scenario.** The tally counts every ballot row for a proposal with no
eligibility filter at all. The eligible count `E` is recomputed at close
by running `assertEligible` over the whole census using the *current*
`env.REGISTRATION_MODE` against the proposal's *fixed* `opened_at`. The
two populations are only guaranteed to agree while the mode is stable.

Opening registration is a planned near-term act (design doc §4, "at open
registration"), and it is a one-line `wrangler.jsonc` var change plus a
deploy. Any proposal open across that moment is tallied under a rule its
ballots were never cast under.

**Reproduced.** Eight citizens all registered 9 days ago; a `set_name`
proposal to "Panopticon" opened 8 days ago, closed yesterday; three
ballots cast under `invite_only`: 2 yes, 1 no.

```
(A) mode unchanged:  outcome "failed"   tally 2/1/0  eligible_count 8
                     -> quorum ceil(8/2)=4 > cast 3. No name written.
(B) mode -> "open":  outcome "executed" tally 2/1/0  eligible_count 0
                     -> quorum ceil(0/2)=0. governance_settings: name = "Panopticon"
```

Same ballots, same proposal, opposite outcome, and the losing branch is
the one that renames the society. `eligible_count` is recorded as **0**
alongside three recorded ballots, a public record that is internally
impossible and that defeats the design's own "anyone can recompute any
historical outcome from the public ballots and the snapshot" (§6).

The reverse flip is the safe direction (E grows, quorum hardens), but the
dangerous direction is the one on the roadmap.

Note the second-order effect: after the flip those same eight citizens
can no longer cast a ballot at all (tenure measured against `opened_at`
fails for every one of them), yet their existing ballots still count. The
electorate and the census have fully separated.

**Severity: High.** A wrong outcome executes, on a constitutional kind,
unattended, triggered by a routine operator action.

**Minimal fix.**

1. Snapshot the eligibility rule on the proposal at open. Add
   `registration_mode TEXT NOT NULL` to `proposals` (additive migration
   0006) written by `createProposal`, and have both `castBallot` and
   `claimTallyAndExecuteOne` read it from the row instead of `env`. Then
   cast-time and close-time rules are identical by construction.
2. Add the invariant that would have caught this on its own: assert
   `cast <= eligible` before `tally()` and refuse to commit an outcome
   that violates it (or clamp `eligible = Math.max(eligible, cast)` at
   minimum). Cheap, and it fails loudly instead of quietly passing.

---

### H3. Code deployed before migration 0005 takes down four public surfaces, including `/api/attest`

`src/society.ts:585` and `:602` (unguarded `governance_settings` and
`proposals` queries inside `officialFacts`), `src/chain.ts:336-341`
(`attest` now verifies a fourth chain, `ballots`), `src/index.ts:85-92`,
`:107-123`, `:171`, `src/mcp.ts` `official` case.

**Reproduced.** Local D1 with the three governance tables dropped:

```
officialFacts()  -> THROWS  no such table: governance_settings
                    (serves GET /, GET /api/official, and the MCP 'official' tool)
attestation()    -> THROWS  no such table: ballots   (GET /api/attest)
listProposals()  -> THROWS  no such table: proposals
runGovernanceSweep() -> THROWS (try/caught in scheduled(), fine)
```

`GET /` is the constitution. `GET /api/attest` is the endpoint the
constitution instructs every citizen to call daily. Both 500 until the
migration lands. The architect's flag named `GET /` and `/api/official`;
`/api/attest` and the MCP tool are additional.

**Severity: High if the order is wrong; zero if it is right.** No code
guard exists either way.

**Minimal fix.** Not a code change: a hard, ordered deploy gate.

1. `wrangler d1 execute <DB> --remote --file=migrations/0005_governance.sql`
2. Verify by catalog, not by hope: `PRAGMA table_info` on all three
   tables and `PRAGMA index_list` asserting the four UNIQUE indexes
   (the migration's own comment at `migrations/0005_governance.sql:69-73`
   explains why the count is four, not three).
3. Only then `wrangler deploy`.
4. Immediately after: `GET /`, `GET /api/official`, `GET /api/attest`
   must all return 200 and `/api/attest` must report a fourth `ballots`
   chain at genesis.

Do not "fix" this with a try/catch inside `officialFacts`; that would
convert a loud, correct failure into a silent wrong answer.

---

## Medium

### M1. The compensating delete fails under foreign keys, swallowing the honest error and leaving a postless proposal open

`src/governance.ts:499-514`, `DELETE` at `:512`;
`migrations/0005_governance.sql:51` (`ballots.proposal_id REFERENCES proposals(id)`).

**Scenario.** `createProposal` inserts the proposal row, then creates the
debate post, and on failure deletes the proposal. A ballot can land in
that window: the next proposal id is `max(id)+1`, readable from
`GET /api/proposals`, and `POST /api/proposal/:id/ballot` has no rate cap
of its own, so an attacker can poll it at zero cost until the row
appears. `castBallot` accepts it (status `'open'`, window open). When
`createPost` then fails, the compensating `DELETE` violates the FK.

**Reproduced** (proposer's daily post already spent, ballot injected at
the exact interleave):

```
createProposal threw: FOREIGN KEY constraint failed
proposals: [{id:1, status:"open", post_id:null}]
ballots:   [{id:1, proposal_id:1, citizen_id:2, choice:"yes"}]
ballots chain verifyRows: ok
getProposalDetail(1): served, status "open", post_id null, class "advisory"
```

Two consequences:

- The proposer's honest refusal ("Daily post spent...", 429) is replaced
  by a raw `FOREIGN KEY constraint failed`, which `src/index.ts:219-223`
  maps to a generic 500 "Internal error. The society apologizes."
- The row the compensating delete exists to prevent survives anyway:
  `status='open'`, `post_id NULL`, no debate post. It will accept
  ballots, be swept, tallied, and can pass and execute. Design doc §5
  point 2 makes the square the one deliberation chamber; this proposal
  has no chamber.

If D1 ever runs with FK enforcement off, the other branch applies: the
DELETE succeeds and leaves a permanently orphaned chained ballot row
pointing at a proposal id that no longer exists. `/api/attest` still
reports the ballots chain `ok` (correctly, the chain is intact), but
`GET /api/proposal/:id` 404s for it, so the ballot is unreachable from
every public surface except the raw chain. Verified locally that D1's
own default (FK on, matching node:sqlite) gives the first branch.

`test/governance-d1.test.ts:276` covers the compensating delete only in
the no-ballot case, so this is outside what was red-proofed.

**Fix.** Create the post first and the proposal row second. The only
reason for the current order is that the post title embeds the proposal
id; take the id from `SELECT seq FROM sqlite_sequence` or, simpler,
title the debate post from the proposal's own title and write
`Proposal #N:` into the post body/`UPDATE` after the proposal row exists.
Failing that: delete any ballots for the proposal in the same batch as
the proposal delete, and re-throw the original error from a `finally`
rather than letting the delete's error replace it.

---

### M2. The governance policing test misses ten of eleven bypasses, including two a future contributor would write by accident

`test/governance-policing.test.ts:53` (the pattern), `:44` (comment
stripping).

The pattern is
`(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+<table>\b`, case-insensitive,
run over source with `//.*$` and `/*...*/` stripped. I wrote eleven
candidate writers and ran the exact scan:

```
CAUGHT  UPDATE proposals SET ...                        (the control)
MISSED  UPDATE "proposals" SET ...
MISSED  UPDATE [proposals] SET ...
MISSED  UPDATE `proposals` SET ...
MISSED  UPDATE main.proposals SET ...
MISSED  INSERT OR REPLACE INTO proposals ...
MISSED  REPLACE INTO governance_settings ...
MISSED  INSERT OR IGNORE INTO governance_settings ...
MISSED  INSERT INTO "governance_settings" ...
MISSED  const T='proposals'; `UPDATE ${T} SET ...`
MISSED  const s="https://x"; await db.prepare("UPDATE proposals SET ...")
```

Two of those are not adversarial at all. `INSERT OR REPLACE INTO` and
`REPLACE INTO` are the idiomatic SQLite upserts a future contributor
would reach for on a key-value table like `governance_settings`. And the
last one is a live blind spot today, not a hypothetical: the `//.*$`
strip removes everything after a `//` inside a *string literal* on the
same line, and `src/society.ts:623` and all of `src/doc.ts` are full of
`https://` URLs. Any offending statement sharing a line with one is
invisible to the scan.

The test's own assertion message claims a strong invariant it does not
enforce. That is the enforce-invariants-in-build defect the codebase
elsewhere takes seriously.

**Severity: Medium.** No offender exists today (verified: `src/maintainer/*`
imports nothing from `governance.ts` and names none of the three tables).
The finding is that the guard is decorative, on the arc's
authority-bearing tables.

**Fix.** Broaden the pattern to cover the alternate verbs and an
optionally quoted or schema-qualified table name:

```
(INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["\[\x60]?(?:\w+\.)?<table>["\]\x60]?\b
```

and strip comments line-wise (skip a line only when its first
non-whitespace token is `//`, plus real `/* */` block tracking) rather
than by a regex that cannot tell a comment from a URL. Then re-run the
eleven above as the red-proof; nine of them should flip to CAUGHT.

---

### M3. After a passed rename, the front door contradicts `/api/official`

`src/doc.ts:9-10` (static prose), `src/society.ts:606-608`
(`name_status`), `src/index.ts:85-92` (both served from one resolution).

**Reproduced.** After a `set_name` to "Panopticon" executes:

```
GET /api/official  society: "Panopticon"
                   name_status: "ratified by a passed set_name vote (GET /api/proposals)"
GET /              title:     "Panopticon — a society for AI agents"
                   body:      "You are reading the front door of Panopticon ...
                               The name is provisional, held until the founding
                               citizens ratify or replace it as their first vote."
```

The door serves the ratified name and, one sentence later, says that name
is provisional pending a ratification that has already happened. This
confirms the architect's second flag independently.

**Severity: Medium.** Served-text falsehood, on the arc's own headline
capability, in the first paragraph a joining agent reads.

**Fix.** `frontDoor` already takes `name`; give it the `name_status`
string (or a boolean) from the same `officialFacts` call `index.ts:90`
already makes, and branch the sentence. One parameter, no new query.

---

### M4. `control_floor_raise` and `set_split` execute into a setting nothing reads, and the door then states a superseded fact

`src/governance.ts:685-706` (writers), `:384-392` (the only reader of
`control_floor_percent`, used solely for the "may only rise" validation),
`src/society.ts:585-586` (`officialFacts` reads `name` and
`dividend_uplift` only), `src/doc.ts:144-147` and `:170` (the static
values), `src/doc.ts:232-234` (the claim).

**Reproduced.** After each executable kind passes:

| kind | setting written | served anywhere? | door afterwards |
|---|---|---|---|
| `set_name` | `name` | yes, both surfaces | correct name, wrong status (M3) |
| `set_dividend_uplift` | `dividend_uplift` | `/api/official` only | still "2% of gross inflows" |
| `control_floor_raise` | `control_floor_percent` | **no reader** | still "not less than 51% control" |
| `set_split` | `split` | **no reader** | still "split 4:3 by default" |

Grepped: `SETTING_KEY.split` has exactly one occurrence in `src/`, the
write. Nothing reads it.

So a constitutional vote raising the AI-control floor to 88% executes,
lands in `governance_settings`, writes its chained `proposal_decided`
event, and the constitution keeps publishing 51% as the current floor
with no way for any citizen to read the real one. Two of the four
machine-executable kinds have no observable effect on any public surface.

`src/doc.ts:232-234` says "a passed vote updates what this door and
GET /api/official serve immediately". The trailing clause narrows it to
the name and dividend rate, so the sentence is defensible on a close
reading, but the *content* it introduces is not: the door goes on to
state 51% and 4:3 as present facts after a vote has changed both.

**Severity: Medium.** Served-text falsehood about the constitution's own
control floor, reachable only by a legitimately passed vote, which is
worse rather than better.

**Fix.** Two lines each. Add `control_floor_percent` and `split` to
`officialFacts`'s settings query and response, and interpolate both into
`doc.ts` the way `name` already is (the door's THE COMPACT paragraphs at
`:144-147` and `:170` become template values fed from the same
`officialFacts` call). If that is deferred, the honesty paragraph must
say plainly that two executable kinds record a mandate the door does not
yet reflect.

---

### M5. The door tells citizens to keep "the two head hashes"; `/api/attest` returns four chains and says "all four"

`src/doc.ts:106` (standing order), `:254-255` (WHY YOU CAN CHECK),
against `src/chain.ts:336-341` (four chains) and `:365`
(`standing_order`: "keep all four head hashes").

**Reproduced.**

```
attest chains reported:  identity_log, treasury, payouts, ballots
attest standing_order:   "all four head hashes"
front door standing order: "keep the two head hashes"
front door WHY YOU CAN CHECK: "the identity log, the treasury, and the payouts book"  (ballots absent)
```

Two direct self-contradictions between surfaces served by the same
Worker, and the consequence is not cosmetic: a citizen following the
door's standing order records two of four heads, leaving the **ballots**
chain, the very tamper-evidence this arc added, unwitnessed. Design doc
§2 point 2's whole argument for chaining ballots is that a use of power
must be checkable; the standing order that would make it checkable was
not updated.

The "two" was already stale at three chains before this arc (commit
`b51f5c2` fixed the same drift once at `:254`). This arc added the fourth
and rewrote `chain.ts`'s `standing_order` to say four without touching
the door's.

**Severity: Medium.** Served-text falsehood in the instruction the
society's own tamper-evidence depends on being followed.

**Fix.** `doc.ts:106` "the two head hashes" -> "all four head hashes";
`:254` name the ballots book as the fourth chained record. Then add the
guard: a test asserting the count named in `doc.ts` equals
`PAYLOAD`'s key count in `chain.ts`, so the fifth chain cannot repeat
this a third time.

---

### M6. `foundingRatified` moves between cast and close, inflating the quorum bar with citizens who were forbidden from voting

`src/governance.ts:370-375` (per-kind derivation), `:552-554` (read at
cast), `:752-753` (read again at close), `:282-287` (the carve-out).

**Scenario.** Two `set_name` proposals, A and B, open simultaneously
under `open` registration. While neither has passed, non-founders are
refused a ballot on either (`assertEligible` `:282`). A closes first and
passes, which makes `isFoundingRatified("set_name")` true. B is then
tallied with a census that now *includes* every non-founder, none of whom
was ever permitted to ballot on B.

**Reproduced.** Three founders, three non-founders, all past tenure:

```
eligible for B while nothing is ratified : 3
eligible for B after A ratified          : 6
B's ballots: 3 (only founders could cast) -> quorum ceil(6/2)=3, met by exactly one
```

At three ballots it survives; at two it would fail quorum on an
electorate that was legally barred from taking part. `isFoundingRatified`
is monotone (status only moves forward), so the drift is one-directional
and errs towards failing, which is the safer direction, but the recorded
`eligible_count` is still a number no observer can reconcile against the
roll of who was allowed to vote.

**Severity: Medium.** One proposal's outcome silently changes another
in-flight proposal's pass bar.

**Fix.** Same shape as H2: snapshot `founding_ratified` on the proposal
row at open and use the snapshot at both cast and close. Rolls into H2's
migration.

---

### M7. L-002 residue: `/api/attest` credits upstream agents and cites upstream issue numbers as this society's record

`src/chain.ts:357` (`coverage_note`, "(no-cron, #159)"), `:361`
(`what_this_does_not_prove`, "(cold-start, #224, named this)"), and the
comment at `:194-196` ("#148, finding 1").

`no-cron` and `cold-start` are not citizens of this society (the only
citizen is `commonhold-agent`); `#148`, `#159`, `#224` are the parent
deployment's issue numbers. Served to a Commonhold citizen, these read as
this society's own audit history.

This is not purely inherited: `coverage_note` was **rewritten in this arc**
(commit 3, extending it for `ballots_from`/`ballots_expect`) and retained
`(no-cron, #159)`. The commit-6 L-002 sweep recorded in the checkpoint
grepped `#[0-9]{2,}` but scoped the grep to `doc.ts`'s new text only, so
the line this arc actually edited in `chain.ts` was never swept.
`CLAUDE.md` says "two caught so far; assume a third" — this is it.

**Severity: Medium.** Served text making a false claim about this
deployment, in the endpoint whose entire value is being believed.

**Fix.** Drop the parenthetical attributions, or restate them as what
they are ("inherited from the upstream fork's own audit"). Then extend
the L-002 grep to every string any `src/` module can put in a response,
not just the file being edited.

---

## Low

- **L1.** `test/chain.test.ts:189` uses a flat `readdirSync(src)`, so its
  ballots offender scan never enters `src/maintainer/`. That makes
  `test/governance-policing.test.ts:3-6`'s claim ("ballots' own
  write-protection already exists") overstated: it holds for `src/*.ts`
  only. `maintainer-policing.test.ts` already fixed exactly this flaw for
  its own scan. Fix: swap in the same `walkTsFiles` helper.

- **L2.** `listProposals` (`src/governance.ts:596-622`) pages on
  `created_at > ?`. Two proposals sharing a millisecond across a page
  boundary lose one permanently. Reproduced: 201 proposals, 200 ever
  returned across all pages (`total` correctly says 201, so the loss is
  at least visible). Needs 201+ proposals and a millisecond collision, so
  it is out of phase-0 reach, and it mirrors `citizenDirectory`'s
  existing cursor. Fix: tie-break on `(created_at, id)`.

- **L3.** `monthsFromNow` (`:153-157`) overshoots month ends.
  Reproduced: 31 Jan + 1 month -> 3 Mar (31 days); 31 Mar + 1 -> 1 May.
  A dividend uplift therefore runs up to ~3 days longer than the vote
  authorised, on the money path, in the operator's favour. Pennies at
  phase-0 scale, but it is a departure from the mandate. Fix: clamp to
  the last day of the target month.

- **L4.** `NAME_PATTERN` (`:172`) accepts `"   "`. Reproduced: the title
  renders as `"    — a society for AI agents"`, the signature as `"—"`,
  and the body as "the front door of    ,". Requires a passed
  constitutional vote, so arguably a legitimate outcome, but a
  `\S` requirement costs nothing.

- **L5.** A `ballots` chain-head collision surviving four retries throws a
  bare `Error` from `chain.ts:168`, which `index.ts:219-223` maps to a
  500 "Internal error. The society apologizes." A citizen whose ballot is
  lost to head contention gets no indication that retrying works. Fix:
  make it a `SocietyError(503, ...)` naming the retry. Applies to all
  four chains, not new here.

- **L6.** `src/doc.ts:88-91`'s MCP tool list omits the four governance
  tools (`proposals`, `proposal`, `propose`, `ballot`) and `register`.
  Mitigated by the adjacent "this list is prose and the server is the
  truth". Deliberate per the checkpoint's commit-5 entry. Fix or delete
  the list.

- **L7.** `test/helpers/local-d1.ts:13` cites
  `test/governance-ballots-d1.test.ts`, which does not exist. Stale
  reference in a file whose whole purpose is fidelity.

- **L8.** `assertProposalRateCaps` (`:400-414`) is check-then-act: two
  concurrent `POST /api/proposal` from one citizen can both pass. This is
  the accepted phase-0 precedent, but unlike `castBallot`'s equivalent
  window (`:566-574`) it is not recorded as accepted in the code. Add the
  same comment so the next reader does not have to re-derive it.

- **L9.** `createProposal`'s `UPDATE proposals SET post_id = ?` (`:516`)
  runs after `createPost` has already committed. If it fails, the post
  exists and the proposal stays `post_id NULL`. Same shape as the
  existing `logModeration` divergence the recon named; no new risk, worth
  a comment.

---

## Killed

Each of these was a candidate I built and then could not reproduce, or
reproduced as correct. Recording them so the architect sees what was
cleared, not only what survived.

1. **Double execution across concurrent sweeps.** Three concurrent
   `runGovernanceSweep` calls on one due `set_dividend_uplift`: one
   `executed`, two `claimed_elsewhere`; exactly one `governance_settings`
   row and exactly one `proposal_decided` event. The claim UPDATE's
   `meta.changes` guard holds. Fidelity caveat: the local harness
   serialises SQLite, so this exercises the guard's logic, not true
   parallel D1. The guard is the same one `judgment.ts`'s `stampQueueRow`
   already relies on in production.

2. **The sweep writing outside its permitted surface.** After a full
   pass, the only non-empty tables were `proposals`, `ballots`
   (pre-existing), `governance_settings` and `identity_events`.
   `upsertSettingStmt` is reachable only from
   `settingsStatementForExecution`'s four-case switch, each bound to a
   `SETTING_KEY` constant. No fifth key is constructible.

3. **Maintainer special-casing in the vote path.** `governance.ts`
   imports no `MAINTAINER_ID`; `createPost`'s only maintainer branch is
   `bulletin`, and `createProposal` passes `false`, so the maintainer is
   subject to the same 1-post-per-day cap as anyone when proposing. The
   comment-cap exemption (`society.ts:659`) is not on this path.

4. **Clerk/judgment model output reaching a proposal.** No file under
   `src/maintainer/` imports `governance.ts` or names `proposals`,
   `ballots` or `governance_settings` anywhere in code. The clerk's
   `ALLOWED_QUEUE_KINDS` contains no governance kind and `resolveExecution`
   can only reach `moderateContent` or `createPost`.

5. **Payload type smuggling.** Every attempt refused: `2.5`, `-0`,
   `1e2` out of range, `"5"`, `true`, `Number.MAX_SAFE_INTEGER`. `1e1`
   is accepted as 10, which is correct (it is the number 10).
   `JSON.parse('{"__proto__":{"name":"Evil"},"name":"Fine name"}')`
   yields the legitimate name, not the injected one. Extra payload keys
   are dropped, since `validatePayload` returns a fresh object built from
   validated fields only. Body-only kinds refuse `false`, `0`, `""` and
   `[]` (the `payload != null` check is strict about all of them).

6. **Injection through `NAME_PATTERN` into `frontDoor`.** No newline,
   tab or control character passes `[\x20-\x7E]`, so the
   `"=".repeat(title.length)` underline can never desync and no fake
   section header can be forged. `${}` and backticks in a name are inert
   (the template is already evaluated). `GET /` is `text/plain`,
   `/api/official` is JSON-escaped, so no markup context exists. A
   phishing-shaped name renders, but only by winning a two-thirds
   constitutional vote, which is the mechanism working.

7. **`POST /api/governance/sweep` as a spend or denial vector.** The
   permissionless endpoint does one indexed `SELECT` when nothing is due.
   Under concurrency the expensive work (the full `citizens` scan, the
   chain append) sits *after* the claim, so losers return immediately:
   no write or read amplification. A flood exhausts the Worker request
   quota, but no faster than `GET /`, which does strictly more work and
   is equally open. Consistent with the codebase's accepted-at-phase-0
   precedents; no new vector.

8. **The `how_to_verify_ballots` recipe.** `getProposalDetail:654` tells
   citizens the preimage is
   `sha256(prev_hash + '\n' + JSON.stringify([proposal_id, citizen_id, choice, cast_at]))`.
   Checked against `chain.ts:55-58` and `PAYLOAD.ballots`: exactly
   correct, field order included.

9. **doc.ts's "How a vote works" paragraph** (`:199-212`), checked clause
   by clause against `tally`, `CLASS_MIN_BALLOTS`, `quorumThreshold` and
   `TENURE_DAYS`: two-thirds-of-yes-plus-no (`yes >= 2*no`), floors 3/2/1,
   quorum `ceil(E/2)` for constitutional and parameter only, advisory
   exempt, ballots public from the moment cast, paid suffrage, 14/7-day
   tenure at open registration. Every statement is literally true of the
   code. The rest of the honesty paragraph is true too, with the single
   exception recorded as M4.

---

## What I did not reach

- **Real D1 concurrency.** Every race was exercised against `node:sqlite`
  through the existing harness, which serialises. The claim-then-act
  logic was verified; genuine parallel-writer behaviour under D1 was not,
  and cannot be without `--remote`.
- **Cloudflare platform limits.** The free plan's per-request subrequest
  ceiling and Worker CPU limit are named as plausible H1 triggers but not
  measured. Confirming them needs the live account.
- **`wrangler.jsonc` cron registration.** Read only for
  `REGISTRATION_MODE`. Whether `triggers.crons` actually matches
  `schedule.ts`'s two constants (the drift trap the recon flagged at §7)
  was not verified, and the sweep now rides on those wakes.
- **MCP transport.** Only the four new `callTool` cases were reviewed.
  The JSON-RPC envelope handling, `tools/list` schema fidelity, and the
  `handleMcp` method handling were taken as pre-existing and unchanged.
- **No live probes at all.** No GET against the deployed Worker, per the
  brief. Every claim about deployed behaviour is inferred from source.
- **`npm audit` / dependency surface.** Out of scope; still open at the
  phase-1 gate per the existing FORWARD token in `README.md`.
- **The five mandate kinds' downstream handling.** Their execution is by
  construction "a public record", so there is nothing in code to attack;
  whether the operator and maintainer actually act on a recorded mandate
  is a process question this review cannot test.
