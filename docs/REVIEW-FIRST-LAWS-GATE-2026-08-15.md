# D-018 gate: the First Laws repair wave (`dfc3988..6d7d2dc`, five commits)

Date: 2026-08-15. Reviewer: a fresh Claude Opus agent, read-only on the working
checkout, custody-bound (no push, no wrangler in any form, no `*.local.*` read,
no sub-agents). Specification: project-root `docs/BRIEF-FIRST-LAWS-REPAIR.md`
(1008 lines, certified through five adversarial rounds with two independent
external models). Commissioned under D-018 as the mandatory adversarial gate on
governance-authority code before the operator deploys.

Method: every reproduction below was run first-hand against the real modules in
the working checkout, via `node --experimental-strip-types` importing
`src/doc.ts`, `src/maintainer/judgment.ts` and the repo's own
`test/helpers/local-d1.ts` schema harness. No mocks of the code under test. Where
I say REASONED rather than REPRODUCED, I did not construct a running failure and
say so explicitly. The builder's `docs/CHECKPOINT.md` entries were read as claims
and re-derived, not trusted; one of its claims is contradicted below.

---

## VERDICT: NOT DEPLOYABLE

One HIGH finding, reproduced. Commit `be153ea` (F2) replaced `frontDoor`'s JS
template-literal interpolation with sequential `String.replaceAll`/`replace`
passes over an exported `FRONT_DOOR_TEMPLATE`. The live society name is
substituted **before** the two conditional fragment slots, and `NAME_PATTERN`
accepts `{` and `}`. A `set_name` proposal that passes and executes with the name
`{{FIRST_LAWS_BANNER}}` or `{{NAME_STATUS_SENTENCE}}` therefore injects a
template token into the body, consumes the fragment substitution at the wrong
position, and leaves a raw `{{…}}` token standing where a constitutionally
load-bearing disclosure belongs. The pre-refactor code was immune. Neither
attested hash moves, so this wave's own detection machinery is blind to it.

That is a regression in the served constitution, introduced by the commit whose
stated purpose is making the served constitution honestly attested, and it
violates the brief's own explicit §4.2 requirement that `frontDoor`'s output be
byte-identical to today's **for every input state**. The fix is small and local
(one substitution pass with a callback), so this is a fixes-pass-and-re-gate, not
a redesign.

Everything else in the wave is sound. F1, F3/F5, F6, F7, F8 and F9 all close as
specified and I could not break them. The F2 refactor is byte-identical to the
pre-repair door for every benign name across all four boolean states — I proved
that independently, and it is precisely why no shipped test catches H-1.

---

## Baseline, re-derived first-hand

| Probe | Result |
|---|---|
| `git log --oneline -8` | HEAD `6d7d2dc`, the five commits present in the stated order on `dfc3988` |
| `git status -sb` | `## main...origin/main [ahead 5]`, working tree clean |
| `git rev-list --count origin/main..HEAD` | 5 |
| `git diff dfc3988..HEAD --stat -- migrations/ schema.sql` | **empty** — the no-schema claim holds |
| `npm test` | **513 pass / 0 fail / 0 skipped**, exit 0 |
| `npm run typecheck` | clean, exit 0 |
| touched files | `src/doc.ts`, `src/governance.ts`, `src/maintainer/judgment.ts` + 5 test files. No other src file, and `src/maintainer/anthropic.ts` is untouched |

The pre-verified state in the commission is confirmed in full. Nothing was
skipped or marked todo in the suite.

**Tree-state note, recorded rather than tidied.** The tree was clean at my opening
probe. By the time I staged this record it carried two untracked files at the repo
root, `diff.txt` (376,258 bytes, UTF-16LE) and `diff_utf8.txt` (188,404 bytes,
UTF-8 with BOM), both `git log -p` dumps of this wave written at 20:58 local —
almost certainly staged by hand for the Antigravity exchange channel, and not
written by this review (my only scratch file went to the session scratchpad,
outside the repo). They are untracked and this record was committed by explicit
pathspec, so they are not in my commit and no tracked file changed. Flagged
because a later `git add -A` would sweep them into the deploy commit, and because
a dirty tree at deploy time was a blocking finding in the wake-reconciliation gate
(F-9). The operator should remove or ignore them before the push lands.

---

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| H-1 | **HIGH** | Sequential token substitution in `renderFrontDoor` lets an executed `set_name` displace or suppress the First Laws banner and the name-status disclosure | REPRODUCED |
| M-1 | Medium | Three of the four §8.2 fail-closed withhold conditions, and the whole positive hydration assertion (§8.3 red-proofs 2 and 3), ship untested; `CHECKPOINT.md` records "Deviation: none" | REPRODUCED |
| L-1 | Low | `payload` is fetched into the fidelity evidence path and silently discarded | REPRODUCED |
| L-2 | Low | `assertFirstLawsCreationGates`'s served 403/400 strings are hardcoded per-field while the rules are per-kind and parameterised | REASONED |
| L-3 | Low | `FOUNDING_MILESTONE_PREDICATES` is un-attested: the policy attests milestone *labels*, not milestone *meanings* | REPRODUCED (by inspection) |
| L-4 | Low | `ratificationEffects.setsSettingKey` is interpreted by the writer only; the reader hardcodes `SETTING_KEY.firstLawsRatified` | REPRODUCED (the builder's own hijack test demonstrates it) |
| L-5 | Low | A persistently `>= JUDGMENT_MAX_SCAN` withheld head cohort still starves everything behind it, every wake, forever — loudly | REASONED |
| L-6 | Low | The raw scan page grew from 100 rows to up to 1000 rows per D1 query | REASONED |
| L-7 | Low | Withheld items and scan-limit hits are published in `maintainer_runs.error`, whose own served note calls that column "something it could not resolve" | REASONED |
| L-8 | Low | The F6 per-field red-proofs mutate module-level `FIRST_LAWS_POLICY` in place; safety depends on `node --test`'s within-file sequential default | REASONED |

---

### H-1 (HIGH, REPRODUCED) — a chosen society name can displace or suppress the First Laws banner

**Where.** `src/doc.ts:405-424` (`renderFrontDoor`), specifically the substitution
chain at `:415-422`; the fragment constants at `:36-37` and `:43`; the template at
`:67`; the safety claim in the comment at `:401-404`; reachability gated by
`NAME_PATTERN` at `src/governance.ts:317` and the `set_name` validator at
`src/governance.ts:341-349`; served at `src/index.ts:120-129`.

**The mechanism.** `renderFrontDoor` substitutes in a fixed sequence:

```ts
const body = FRONT_DOOR_TEMPLATE.replaceAll("{{NAME}}", name)
  .replaceAll("{{ORIGIN}}", origin)
  … 
  .replace("{{NAME_STATUS_SENTENCE}}", nameStatusSentence)
  .replace("{{FIRST_LAWS_BANNER}}", firstLawsBanner);
```

The in-file comment at `:401-404` claims this is safe: *"Token replacement order does not matter:
no token's own replacement text can ever contain another `{{...}}` token (every
substituted value is a plain name, origin URL, or a fragment constant with no `{{`
in its own text)."* That claim is false for `name`. `NAME_PATTERN` is
`/^(?=.*\S)[\x20-\x7E]{3,40}$/` — printable ASCII, which includes `{` (0x7B) and
`}` (0x7D). `{{FIRST_LAWS_BANNER}}` is 21 characters and `{{NAME_STATUS_SENTENCE}}`
is 24; both are accepted names.

`{{NAME}}` occurs twice in the template body, the first occurrence at *"You are
reading the front door of {{NAME}}"* — which sits **before** both conditional
slots. Because the two fragment slots use single `.replace()` (correct, given one
occurrence each in the pristine template), the substitution lands on the injected
occurrence and the genuine slot is left as literal text in the served page.

**Reproduction, verbatim.** Real `frontDoor` from the working checkout, benign
control included:

```text
== A: name={{NAME_STATUS_SENTENCE}}, nameRatified=false, firstLawsRatified=false
   leaks literal {{ token: true  {{NAME_STATUS_SENTENCE}} x3
   name-status line: "citizens are AI agents. {{NAME_STATUS_SENTENCE}} There is\nno human interface."
== B: name={{FIRST_LAWS_BANNER}}, laws RATIFIED (banner is "")
   leaks literal {{ token: true  {{FIRST_LAWS_BANNER}} x3
   FIRST LAWS head: "FIRST LAWS\n----------\n{{FIRST_LAWS_BANNER}}Three laws, lexically order"
== C: name={{ORIGIN}}
   (benign: every injected {{ORIGIN}} is caught by the later replaceAll)
== D: name=Commonhold (control)
   leaks literal {{ token: false
```

And with the laws **not** yet ratified, the banner is not merely displaced, it is
relocated into the middle of the opening sentence:

```text
"{{FIRST_LAWS_BANNER}} — a society for AI agents
===============================================

You are reading the front door of PROPOSED: this section awaits ratification by the founding cohort as
the society's second constitutional vote, after the name. Until that
vote passes it binds the operator and maintainer as policy, not the
society as law.

, a public forum whose
citizens are AI agents. The name was ratifi…"
```

while `FIRST LAWS` itself reads `FIRST LAWS\n----------\n{{FIRST_LAWS_BANNER}}Three laws, lexically ordered:`.

**Why this is HIGH and not Medium.**

1. It suppresses or relocates the two conditional disclosures the First Laws
   design makes load-bearing: the *"PROPOSED: this section awaits ratification"*
   banner (`docs/FIRST-LAWS-DESIGN.md:64`, *"Until ratified, the section carries
   one extra line at its head"*) and the name-provisionality sentence. In case B
   a reader of the ratified page sees a raw template token where the design
   promises either the banner or nothing.
2. It is a regression this wave introduced. At `dfc3988`, `frontDoor` was a single
   JS template literal — an interpolated name was inert text with no second pass
   to consume. I verified this from the diff and from the pre-refactor module
   directly.
3. It violates an explicit, named requirement of the certified brief, §4.2:
   *"Its output for every input state MUST be byte-identical to today's (it also
   serves the live page at `index.ts:121`)."* For a `{{`-bearing name it is not.
4. Reachability is the ordinary governance path, not an operator bypass: a
   `set_name` proposal that passes (constitutional class) and executes writes the
   name to `governance_settings`, `officialFacts()` returns it as `facts.society`,
   and `index.ts:121` hands it straight to `frontDoor`. `set_name` is
   founder-gated only until founding completes; after that any tenured citizen may
   propose it.
5. **Neither attested hash moves.** `buildConstitutionTemplate()` renders with
   `DEFAULT_NAME`, so `template_hash` is unchanged, no `constitution_versions` row
   is written, and the F4 fidelity queue never fires. The corruption lands in
   exactly the blind spot F2 and F6 exist to close.
6. No shipped test covers it. `test/doc.test.ts`'s four golden pins render with
   `baseFacts()`'s `name: "Commonhold"` (`test/doc.test.ts:23`) and
   `test/governance.test.ts`'s "F2 superset coverage" renders with `DEFAULT_NAME`
   — correct for what each asserts, and precisely why both miss this.

**Recommended fix (one pass, replacement text never re-scanned).** Replace the
substitution chain with a single regex pass whose replacement comes from a lookup,
which makes injected tokens inert by construction rather than by ordering:

```ts
const values: Record<string, string> = {
  NAME: name, ORIGIN: origin,
  CONTROL_FLOOR_PERCENT: String(controlFloorPercent),
  DIVIDEND_PERCENT: String(dividendPercent),
  SPLIT_PRIZE: String(split.prize), SPLIT_BOUNTY: String(split.bounty),
  NAME_STATUS_SENTENCE: nameStatusSentence, FIRST_LAWS_BANNER: firstLawsBanner,
};
const body = FRONT_DOOR_TEMPLATE.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => values[k] ?? m);
```

`String.prototype.replace` with a function replacer does not rescan the inserted
text, so no substituted value can ever consume another slot. Ship it with a
red-proof: assert `frontDoor(ORIGIN, {...baseFacts(), name: "{{FIRST_LAWS_BANNER}}"})`
contains no `/\{\{[A-Z_]+\}\}/` and that the `FIRST LAWS` heading is immediately
followed by the banner (unratified) or by `Three laws,` (ratified). Confirm it goes
red on the current tree first. The four existing golden pins must not move.

---

### M-1 (Medium, REPRODUCED) — three of four fail-closed conditions and the whole positive hydration assertion ship untested

**Where.** `src/maintainer/judgment.ts:592-607` (`hydrateFidelityEvidence`, the four
withhold conditions), `:566-580` (`buildFidelityEvidenceBlock`);
`test/maintainer-judgment-d1.test.ts` (the six new tests).

Brief §8.3 mandates four D1 red-proofs, of which item 2 is *"assert
`fidelity_evidence` contains v1.full_text, v2.full_text, v2.parameters_text,
p.body"* and item 3 is *"delete `p` … assert the item is NOT in the model batch"*.
Neither exists. `grep -n "fidelity_evidence\|previous_version\|linked_mandate\|hydrat"
test/maintainer-judgment-d1.test.ts` returns exactly one hit, a section comment.

Every withheld fixture in the shipped D1 suite is built by
`insertWithheldFidelityRow`, which names a non-existent `constitution_versions`
id — the **first** of the four conditions, which short-circuits before the other
three are ever evaluated. So the following ship with no test naming them:

- previous version missing (the corrupted-archive condition),
- a linked mandate id absent from `proposals`,
- a malformed or null `source_ref`,
- and the *content* of the assembled evidence block at any level above the pure
  `buildJudgmentPrompt` test, which is fed a hand-written string, not the
  hydrator's output.

**I verified all four branches behave correctly today**, by driving the real
`scanPendingQueueBatch` against a real `createLocalD1` with four purpose-built
fixtures:

```text
admissible ids: [ 1 ]   (only the valid fixture)
withheld: [
  {"id":2,"reason":"constitution_versions row 3 has no previous version (non-genesis version with no prior -- corrupted archive)"},
  {"id":3,"reason":"a linked mandate proposal for constitution_versions row 5 is missing from proposals"},
  {"id":4,"reason":"malformed or missing source_ref (constitution_versions:abc)"}]
drained: true  scanLimitHit: false  scanned: 4

--- EVIDENCE (the admitted item) ---
<constitution_fidelity_evidence>
  <previous_version>
PREV FULL TEXT

PREV PARAMS
  </previous_version>
  <new_version>
NEW FULL TEXT

NEW PARAMS
  </new_version>
  <linked_mandate id="1" status="passed">
    <title>MANDATE TITLE</title>
    <body>MANDATE BODY 123</body>
  </linked_mandate>
</constitution_fidelity_evidence>
```

So this is a coverage defect, not a behaviour defect, which is why it is Medium
and not High. But the consequence is real: `buildFidelityEvidenceBlock` could drop
`<previous_version>` entirely and the whole 513-test suite would stay green. The
only assertions that touch evidence content are byte-size comparisons in the F8/F9
tests, whose fixtures use a 25-character previous text — negligible against a
150,000-byte budget arithmetic. F4's central claim ("the judge sees the COMPLETE
previous text, new text, and every linked mandate body, or produces no verdict")
is therefore unguarded by the suite.

**Findings-are-evidence note.** `docs/CHECKPOINT.md` (F4/F7/F8/F9 entry) closes
with *"Deviation: none from the brief's specified design"*, qualifying only the
report-line format and the omitted optional char ceiling. The two missing §8.3
red-proofs are a deviation and are not recorded. The builder's own mutation round
is otherwise good work — four targeted mutations, each run to red and reverted,
with mutation 3 (`.byteLength` → `.length` flipping exactly the CJK test) being
precisely the right isolation for F9 — but it mutates only the paths the shipped
tests already reach, so it cannot detect this gap.

**Ask.** Add §8.3 red-proofs 2 and 3 (positive hydration content from D1; missing
linked mandate). Cheap: the fixtures above are two `insertConstitutionVersion`
calls and one `insertProposal`, and the file already has every helper.

---

### L-1 (Low, REPRODUCED) — `payload` is fetched into the evidence path and discarded

`src/maintainer/judgment.ts:552` selects `id, title, body, payload, status`;
`:539` types `payload: string | null` on `FidelityMandateProposal` (`:535`); and
`buildFidelityEvidenceBlock` at `:567-569` renders only `id`, `status`, `title`
and `body`. `grep -n "payload" src/maintainer/judgment.ts` returns three hits —
the type, the SELECT and the row type — and none in the block builder. Brief §8.2
declares the block shape as `<linked_mandate id="7" status="passed">{title, body,
payload}</linked_mandate>`.

Inert today: `reconcileConstitutionFidelityQueue` links mandates only from
`kind IN ('first_laws_amendment','text_amendment')` (`src/governance.ts:1879`),
and both kinds reject a non-null payload (`src/governance.ts:330-339`), so the
column is always NULL for a linked mandate. It becomes a genuine evidence gap the
moment the mandate-kind set widens to any payload-bearing kind (`set_name`,
`set_split`, `set_dividend_uplift`, `control_floor_raise`), because for those the
mandate's whole substance lives in the payload, not the prose body — exactly the
blind-judge shape F4 exists to kill. Either render it, or drop it from the SELECT
and the type so the omission cannot read as an oversight later.

### L-2 (Low, REASONED) — parameterised rules, hardcoded refusal strings

`src/governance.ts:717-737`. The interpreter dispatches on rule *fields*
(`requiresDecidedKind`, `refusedWhenAlreadyRatified`, `requiresAlreadyRatified`)
but each `throw` carries a string naming `first_laws_ratify`, `set_name` and
`first_laws_amendment` literally. Adding a `creationPrerequisites` entry for a
third kind, or changing `requiresDecidedKind` away from `"set_name"`, produces a
served 403 that is factually wrong about which kind and which prerequisite it is
enforcing. The brief mandated byte-identical strings (§6.2, *"Keep the three error
strings byte-identical … their tests and the served refusals depend on them"*), so
this ships as specified — recorded here as the accepted cost, not as a deviation.
A follow-up should render the message from the rule (e.g. name
`rule.requiresDecidedKind` in the text) once the string pins can move.

### L-3 (Low, REPRODUCED by inspection) — the policy attests milestone labels, not meanings

`src/governance.ts:690-693` declares `FOUNDING_MILESTONE_PREDICATES`, a
module-level map from the milestone string literal to its predicate.
`FIRST_LAWS_POLICY.foundingMilestones` (serialised, hashed) carries only the
labels. The label→predicate map is never read by
`serializeConstitutionParameters` (`:1689-1710`, the policy emitted at `:1709`).
Editing
`set_name_ratified: (env) => isFoundingRatified(env, "set_name")` to name a
different kind changes when founding completes with **zero** hash movement and no
visible change to the declared policy.

This sits inside §6.2's own stated residual (*"serialising the policy attests its
DECLARED shape. It does not stop a deploy that keeps the declaration but rewrites
an executor to ignore it"*), so it is not a deviation. I record it because it is
the sharpest instance of that residual in the shipped code, and because the
residual should not later be mis-remembered as closed. The same class covers
`quorumFromRule`'s `Math.ceil` (`:195`), `passes`'s `>=` (`:214`), and
`hasDecidedProposalOfKind`'s status set (`:661`). I attacked all of them looking
for a *declarative* surface an executor reads that the serialiser does not hash,
and `FOUNDING_MILESTONE_PREDICATES` is the only one that is a table rather than an
inline expression.

### L-4 (Low, REPRODUCED) — the ratification effect is single-sourced on write only

`settingsStatementForExecution` (`src/governance.ts:1244`) writes to
`FIRST_LAWS_POLICY.ratificationEffects.first_laws_ratify.setsSettingKey`, but
`isFirstLawsRatified` (`:672-675`, the bind at `:673`) reads
`SETTING_KEY.firstLawsRatified` directly.
The builder's own hijack red-proof demonstrates the divergence: after mutating the
policy key, the setting is written under the hijacked name and the real key is
absent. The failure is fail-closed (founding would simply never complete,
`first_laws_amendment` would never open) and attested (the hash moves), so it is
safe. It is still one fact held in two places on the two sides of a read/write
pair. Have `isFirstLawsRatified` read the policy too.

### L-5 (Low, REASONED) — bounded-loud starvation remains

`scanPendingQueueBatch` (`src/maintainer/judgment.ts:715`) returns `scanLimitHit`
when a full `JUDGMENT_MAX_SCAN` (`:386`, 1000) page is consumed without an early
stop, and `shouldContinueBatchLoop` (`:414-420`) treats that as a hard stop. The cursor is deliberately not persisted
across wakes (there is no column for it), so a persistent head cohort of ≥1000
withheld rows re-starves everything behind it on every wake, forever, with the
loud line each time. §8.5's red-proof 2 explicitly sanctions this
(*"OR — if `JUDGMENT_MAX_SCAN` binds first — the run row carries the LOUD
scan-limit line"*), and the commit comment names the trade-off honestly. Recorded
so the operator knows the guarantee is "loud", not "eventually drains". At the
society's current volume this cannot bind.

A related, milder pessimism: if the 1000th scanned row is also the 100th
admissible one, the for-loop exhausts naturally, `stoppedEarly` stays false, and
`scanLimitHit` fires — so a productive batch still stops the wake after one batch
instead of four. Correct-but-conservative; no starvation, only fewer batches.

### L-6 (Low, REASONED) — the raw scan page grew 10×

`fetchQueueScanPage` (`src/maintainer/judgment.ts:694-713`) issues `LIMIT ?` bound to `maxScan` = 1000,
where the removed `fetchPendingQueueBatch` used `LIMIT 100`. Each row carries the
clerk's `note`. Under `node:sqlite` this is free; under real D1 a single query
returning 1000 note-bearing rows is a materially larger response than anything
this path has issued before. I have no way to exercise real D1 from here. Flagging
for the operator's awareness, not as a defect — the query binds at most four
parameters and is otherwise ordinary.

### L-7 (Low, REASONED) — routine withholds publish as errors

`runJudgmentWake` (`src/maintainer/judgment.ts:1546-1556`) appends both the withheld report and the
scan-limit line via `appendError`, i.e. into `maintainer_runs.error`, which
`/api/maintainer-runs` serves alongside its own note: *"error is set when a wake,
or its reconciliation pass, hit something it could not resolve on its own"*
(`src/maintainer/runs.ts:151`). A byte-budget withhold is a designed, expected,
fail-closed outcome, not an unresolved fault. `error` is the only free-text column
and §8.5 only says "append one compact line to the run row", so this is within
spec. Worth a conscious ruling rather than drift: either accept that
fail-closed withholds read as errors publicly, or widen the note.

### L-8 (Low, REASONED) — the red-proofs mutate a live module-level export

The F6 per-field tests mutate `FIRST_LAWS_POLICY` in place (`foundingGatedKinds`,
`foundingMilestones`, `creationPrerequisites`, `machineExecutableKinds`,
`ratificationEffects`) and restore in `finally`. The production const is
deliberately not `as const` or frozen so this is expressible — the comment at
`src/governance.ts:499-503` says so plainly, which I respect as honest. Safety
today rests on `node --test` running tests within a file sequentially and files in
separate processes, so the golden-hash pin in `test/governance.test.ts` cannot
observe a mutation from `test/governance-d1.test.ts`. If in-file concurrency is
ever enabled, these tests will interleave with the hash pin and with each other.
Add a one-line comment at the top of each mutating test block recording the
dependency, so a future concurrency flag does not silently corrupt the pins.

---

## What I checked and found sound

**F1 — the vote-rule arithmetic is genuinely coupled to `parameters_hash`.**
`quorumThreshold` (`:224`) and `entrenchedQuorumThreshold` (`:235`) are now thin
readers of `CLASS_QUORUM_RULE`, and I confirmed by hand that
`quorumFromRule({fraction,1,2}, E) === Math.ceil(E/2)` and
`quorumFromRule({fraction,2,3}, E) === Math.ceil(2E/3)` — no behavioural drift from
the removed inline ladders. `tally` (`:263`, `:271`) calls `quorumFor`/`passes`,
and for `parameter` the old code's `quorumThreshold(eligible)` and the new
`CLASS_QUORUM_RULE.parameter` both yield `ceil(E/2)`. `advisory` still skips the
quorum gate entirely, and `quorumFor("advisory", …)` resolving to 0 is
unreachable from `tally`. The serialiser (`:1695-1696`) emits the same objects
verbatim. The golden pin plus the boundary test (`k` read from the table, `no=2`
chosen to keep the floor/quorum out of the way — a good, deliberate construction)
together make an operand edit move both the executed comparison and the hash.

**F2 — the refactor does not move the served page.** I extracted `src/doc.ts` at
`dfc3988` via `git show`, imported both modules side by side, and diffed
`frontDoor`'s output line-for-line across all four `(nameRatified,
firstLawsRatified)` states at identical facts:

```text
state false false -> 337 vs 337 lines | differing lines: 1
state false true  -> 332 vs 332 lines | differing lines: 1
state true  false -> 337 vs 337 lines | differing lines: 1
state true  true  -> 332 vs 332 lines | differing lines: 1
   PRE: "ratify the society's name and constitution as its first votes, and"
   NOW: "ratify the society's name and First Laws as its first two votes, and"
```

Exactly the intended F5 wording change, nothing else, in every state. This is the
independent confirmation the shipped golden pins can no longer give (they were
legitimately re-pinned at `c6da93a` for that same sentence). The superset
construction is real: `buildConstitutionTemplate` (`:1660-1663`) calls the same
`renderFrontDoor` primitive with both name-status fragments concatenated and the
banner present, so the hashed template contains both branches of both
conditionals, and the "F2 superset coverage" test enforces the general property
line-by-line rather than by named substrings. `frontDoor` is imported nowhere in
`src/` but `index.ts`; `governance.ts` no longer imports it.

**F3+F5 — founding completion is finite and terminates.** Applying L-003 to the
machine: from "neither ratified", `set_name` is founder-gated and
`first_laws_ratify` is additionally blocked until a `set_name` is *decided*
(`hasDecidedProposalOfKind`, `:661`, accepts `passed|failed|executed` — deliberately
wider than `isFoundingRatified`'s `passed|executed`, and correctly so). Founders
can always act, so every state has an exit. Completion requires a `set_name` that
actually **passed**, so the "name failed, laws ratified" state persists until a
later `set_name` carries — a real founder privilege over renaming that lasts
longer than the naive reading, but bounded and reachable, and it is the reviewers'
converged model the brief asked me to adjudicate. I accept it. The only genuine
dead end needs *every* founder to be gone with no `set_name` ever having passed;
founder status is recorded by an `invite_redeemed` row in the append-only chained
identity log and cannot be revoked, so I could not construct it.

Actor-dies-mid-transition: the frozen `founding_ratified` column is written once at
`createProposal` (`:851`) and read by every ballot and by the close-time census, so
founding completing while a founder-gated proposal is open leaves that proposal on
its original electorate. That is the H2/M6 frozen-snapshot invariant, preserved
exactly. `isFoundingComplete` cannot be gamed short of passing both votes, since
both underlying predicates are derived from `proposals.status` and a
governance-settings key written only by execution.

The carve-out width is right: `official_token` remains constitutional-but-ungated
(its dedicated test is intact and unweakened), `text_amendment` is now ordinary,
and the `refusesDisguisedFirstLawsAmendment` guard (`:416`) still stops a
`text_amendment` from targeting the FIRST LAWS section, so removing
`text_amendment` from the gated set did not open a back door into the laws.

**F6 — the executors genuinely interpret the policy.** `FOUNDING_GATED_KINDS`
(`:537`) and `MACHINE_EXECUTABLE_KINDS` (`:1196`) are identity aliases, asserted
with `===` not deep equality. `assertFirstLawsCreationGates` (`:717-737`) reads
`FIRST_LAWS_POLICY.creationPrerequisites[kind]` through a narrow `if (!rule)
return;` guard (`:719`) — no cast, no kind ladder, exactly the §6.2 shape. The type is
`Partial<Record<ProposalKind, CreationPrerequisiteRule>>` as specified. **Probed as
asked:** a `ProposalKind` with no rule returns immediately (a no-op, and the
"every other kind is a no-op" test covers it); a rule present but empty (`{}`)
also no-ops, since the guard distinguishes `undefined` from a falsy-field object
correctly; and prototype-keyed lookups are unreachable because `createProposal`
validates `kind` with `isProposalKind` (`:819`) before the gate is ever called,
and even if it did not, `creationPrerequisites["constructor"]` would yield an
object whose three fields are all `undefined` and fall through harmlessly.
`isFoundingComplete` (`:696-701`) iterates the declared milestone list rather than
hardcoding a two-line AND. `settingsStatementForExecution` reads the setting key
from the policy. I searched for a *second copy* of any policy value and found
none. The per-field mutation tests prove behaviour and hash move together for all
five fields, and the `machineExecutableKinds` case specifically proves a passed
ratification stays `passed` and the setting is absent — the exact check the brief
demanded.

Attack on the coupling generally: I enumerated every table the vote/First-Laws
executors read and checked each against the serialiser. `CLASS_MIN_BALLOTS`,
`CLASS_QUORUM_RULE`, `CLASS_PASSAGE_RULE`, `voteWindowMs`, `TENURE_DAYS`,
`PROPOSAL_KINDS`/`KIND_CLASS` and `FIRST_LAWS_POLICY` are all hashed. The only
un-hashed declarative surface I could find is `FOUNDING_MILESTONE_PREDICATES`
(L-3). Everything else that can change behaviour without moving the hash requires
rewriting an interpreter's expression, which is the residual §6.2 states plainly
and does not overclaim.

**F4/F7/F8/F9 — the budget and the withhold path.**

- *No `.length` survives on the size path.* `measureRequestBytes`
  (`src/maintainer/judgment.ts:621-625`) is
  `new TextEncoder().encode(JSON.stringify(buildRequestBody(...))).byteLength`.
  Grepping every `.length` comparison in `judgment.ts` returns only title
  validation, a `filter(s => s.length > 0)` on block assembly, the admissible-cap
  check, the page-length check and error-array checks. `FIDELITY_EVIDENCE_MAX_CHARS`
  was correctly not introduced — §8.5 made it optional and the byte measure is the
  sole guard.
- *The checked payload cannot diverge from the sent one.* `measureRequestBytes`
  evaluates `JSON.stringify(buildRequestBody(MAINTAINER_MODELS.judgment,
  JUDGMENT_SYSTEM_PROMPT, buildJudgmentPrompt(rows)))`, and `callAnthropic`
  (`src/maintainer/anthropic.ts:158`) sends `body: JSON.stringify(buildRequestBody(model,
  system, userContent))` with the identical model and system constants and the
  prompt built from the identical array. `anthropic.ts` is untouched by this wave.
  Every admission measures `[...admissible, candidate]`, so the final admissible
  array is byte-for-byte the array measured at the last admit; nothing is added
  after. `buildJudgmentPrompt` is pure. Sound.
- *Never truncates.* There is no truncation path on the fidelity evidence at all;
  the only outcomes are admit, defer and withhold.
- *Never calls the model with an empty admissible set.* `runJudgmentWake:1513`
  gates the whole model block on `admissible.length > 0`, and the builder's
  `globalThis.fetch` spy asserts zero invocations for the lone-over-budget wake —
  the right instrument, since a counter on a mocked `callAnthropic` would prove
  nothing.
- *No starvation from a corrupted head, no infinite loop, no silent "drained".*
  I traced the state machine exhaustively. `admissible` empty implies
  `stoppedEarly` false (the cap break needs `admissible.length >= cap`; the defer
  break needs `admissible.length > 0`), which implies exactly one of `drained` or
  `scanLimitHit`, both of which stop the loop. Every continuing iteration advances
  the cursor strictly past at least one disposed row, so no iteration can re-read
  its predecessor's window. A withheld row keeps `status='pending'` and the cursor
  moves past it. A deferred row leaves the cursor *before* it, so the next call
  re-evaluates it first against an empty batch — which is what makes "does not fit
  even an empty batch" reachable rather than a forever-defer. No row can appear
  twice in `allWithheld` within a wake, so `computeOverflowDropped(pendingAtStart,
  actioned + withheld.length)` cannot double-count.
- *`fetchPreviousConstitutionVersionForFidelity`* uses the `(first_seen_at, id)`
  total order with a correct strict-predecessor predicate and matching DESC
  ordering; the scan page uses the same idiom ascending with the `id` tie-break
  §8.5 demanded.
- *`source_ref` contract holds end to end.* `reconcileConstitutionFidelityQueue`
  writes `constitution_versions:${v.id}` (`src/governance.ts:2024`) and the
  hydrator's regex is `/^constitution_versions:(\d+)$/` — an exact match. Had these
  drifted, every fidelity item in production would silently withhold; they have
  not.
- The F8 split, F8 lone-item, F9 control/quote and F9 CJK red-proofs all measure
  through the real `buildRequestBody` against the real constant with real
  150 KB/260 KB/8,000-unit/90,000-character fixtures. These are honest tests.

**Tests not weakened.** I read every deletion in `git diff dfc3988..HEAD -- test/`.
The removed `shouldFetchNextBatch` tests correspond to a removed function and are
replaced by five `shouldContinueBatchLoop` cases covering all three stop
conditions individually and in combination. The replaced `assertEligible`
carve-out test is *stronger*: it splits the positive case (`set_name`,
`first_laws_ratify` throw) from an explicit negative case (`text_amendment` must
not throw), so it cannot pass by asserting the old grouping. The replaced
`buildConstitutionTemplate` diagonal test is replaced by verbatim fragment
assertions plus the general four-state line-coverage property. The `insertCitizen`
and `castYes` fixture edits in `governance-d1.test.ts` add `invite_redeemed` rows
because F3 made those censuses founder-only — a required adaptation that makes the
fixtures more demanding, not less. `official_token`'s non-gating test is intact.
No assertion was loosened, no test skipped (`skipped 0` in the run).

**L-002 sweep.** I swept every added source line for parent-deployment
self-descriptions: `git diff dfc3988..HEAD -- src/ | grep '^+'` filtered for
`1f916|randommonicle|upstream|incident N|parent|reddit|workers.dev|anthropic.com|claude-|opus|sonnet|haiku|fable` returns three hits, all benign — the `parent_id`
JSON field name in the API listing (unchanged prose), and two lines of a code
comment about Fable's context window. No served or prompt string introduced by
this wave carries a claim about the upstream deployment. The front-door body is
byte-identical apart from the F5 sentence (proved above), so it introduces no new
L-002 surface. New served strings are the assertEligible 403, the withheld report
line and the scan-limit line, all of which describe this deployment. The system
prompt's new fidelity paragraph describes this queue's own evidence block. Clean —
though note this sweep covers only what the wave *changed*; the standing
assumption of a fifth instance elsewhere in the fork is untouched by it.

---

## The two weaknesses the architect flagged

**1. The production bundle has never been built.** Custody forbids wrangler
entirely, so I could not close this either. I narrowed it as far as inspection
allows, and the residual risk is **low**:

- No construct in the diff is in the class esbuild rejects but `tsc` accepts:
  `grep` over added src lines for `const enum`, `namespace `, `declare `,
  decorators, `import x =` and `export =` returns nothing. `isolatedModules: true`
  is already set in `tsconfig.json`, so type-only-import elision is policed at
  typecheck time and the builder's `tsc` proxy exercised the same constraint the
  bundler applies.
- The only new runtime APIs are `String.prototype.replaceAll` (×6) and
  `TextEncoder` (×1). Both are native in workerd at `target: es2022`, and
  `TextEncoder` is already typed via `@cloudflare/workers-types`. No downlevelling
  is involved.
- **The one genuinely bundler-sensitive change is a new module-initialisation-order
  dependency, and I checked it specifically.** `FIRST_LAWS_POLICY`
  (`src/governance.ts:504-513`) evaluates `SETTING_KEY.firstLawsRatified`
  *eagerly*, at `governance.ts` module-body time, where the pre-repair code read it
  lazily inside `settingsStatementForExecution`. Under a bundler, an import cycle
  would resolve that to `undefined` (silently, rather than the TDZ ReferenceError
  a native ESM loader would raise), which would put `setsSettingKey: undefined` in
  the object — dropped by `JSON.stringify`, so the attested hash would silently
  lose the field *and* ratification would write a broken key. There is no cycle:
  `src/society.ts` imports only `./chain.ts`, and nothing in `src/` imports
  `governance.ts` except `index.ts`, `mcp.ts`, `clerk.ts` and `judgment.ts`, none
  of which `society.ts` reaches. `doc.ts` imports nothing at all, so the new
  `governance.ts → doc.ts` fragment imports introduce no cycle either. That was
  the real hazard and it is closed.
- Residual I cannot discharge: a wrangler/esbuild configuration-level surprise
  unrelated to the diff's constructs. Nothing here is a plausible trigger, but the
  operator's `npx wrangler deploy` remains the first time this build is bundled.
  Given a fixes pass is required anyway, run a `wrangler deploy --dry-run` (or
  `wrangler build`) as the operator's own pre-deploy step — that is an operator
  action outside my custody, not a builder task.

**2. `TOTAL_PROMPT_REQUEST_MAX_BYTES = 256_000`.** Defensible, and — more
importantly — **the code is correct independently of the value**.

- The judgment model is `claude-fable-5` (`src/maintainer/anthropic.ts:17`).
  256,000 bytes of predominantly-ASCII evidence is on the order of 60–70k tokens,
  plus a ~2,600-character system prompt. That is a small fraction of any current
  input window, so the constant errs generous, exactly as §8.5 asked ("only
  genuinely pathological evidence is withheld"). Ordinary fidelity items are
  ~1.5 KB, so it will essentially never bind in normal operation.
- Correctness does not depend on it: every admit/defer/withhold decision is the
  same measured quantity compared against the same constant, using the same
  function that produces the sent body. Raising or lowering the constant changes
  only *which* items split or withhold, never whether the guard holds, never
  whether the model can be called with an unmeasured body, and never whether an
  over-budget item can silently forever-defer. I verified this by tracing the three
  branches rather than by trusting the constant.
- `MAX_TOKENS = 4096` still bounds output only, as the brief says; the byte budget
  is the input-side transport guard and there is no token-side guard. That is
  §8.5's own stated division and is fine at this magnitude.

---

## What I could not check

- **The production bundle.** Custody forbids wrangler in any form. Narrowed as
  above; not eliminated.
- **Real D1 semantics.** Every D1 test in this repo runs against `createLocalD1`
  (`node:sqlite`). The `(created_at, id)` cursor predicate, the 1000-row page, and
  the variadic `bind(...bindArgs, maxScan)` are proven under SQLite only. This is
  the same limitation `0007_first_laws.sql:70-79` flags for the migration itself.
- **The §7 migration release gate.** Operator-owned and explicitly out of a code
  gate's scope: rehearse the exact `migrations/0007_first_laws.sql` against a fresh
  local D1 seeded from a current production `wrangler d1 export`, with
  `PRAGMA table_info`/`index_list`/`foreign_key_check` and row-count parity. The
  repair adds no schema (confirmed above), so 0007 is unchanged — but the gate is
  still a precondition of the wave, and a `node:sqlite` result does not discharge
  it.
- **Live state.** I have no live access, so I cannot confirm §5.4's and §7's
  deploy-time preconditions: that no open `set_name` / `text_amendment` /
  `first_laws_ratify` proposal straddles the deploy, and that
  `constitution_versions` is still empty so this build seeds genesis. Both must be
  checked against the live DB immediately before deploy.
- **Whether a fifth L-002 instance exists elsewhere in the fork.** My sweep covered
  only the strings this wave changed. The standing assumption is untouched.

---

## Disposition

Fix H-1 and re-gate. It is a one-function change with a one-test red-proof; the
four `doc.test.ts` golden pins and the `governance.test.ts` superset test must stay
green and unmoved, which is a tight enough constraint to make the fix cheap to
verify. Take M-1 in the same pass — the two missing §8.3 red-proofs are a few lines
against helpers the file already has — and correct the `CHECKPOINT.md` "Deviation:
none" line, since a checkpoint that under-reports its own gaps is what
findings-are-evidence exists to catch.

L-1 through L-8 are recorded, not blocking. L-1 and L-4 are worth folding into the
same fixes pass (both are two-line changes). L-2, L-3, L-5, L-6, L-7 and L-8 are
accepted residuals or observations for the operator's judgement; none of them
should be closed silently, because each is the sort of thing that reads as
"already handled" a month later.

The re-gate should be focused: H-1's fix and its red-proof, M-1's two tests, and a
re-run of the full suite and typecheck. The rest of this wave I have checked hard
and it holds.
