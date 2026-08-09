// I-008 (IDEAS.md): the automated answer to LESSONS_LEARNED.md L-002
// ("forked code carries the parent's self-descriptions, and they surface
// as false claims about YOUR deployment"). Four instances found so far,
// each by a manual sweep: officialFacts() naming upstream's repo
// (76d92a9), /api/attest's unsealed_note narrating an upstream chain
// reset as this deployment's own history (b3271aa), doc.ts's
// coverage_note/what_this_does_not_prove citing upstream issue numbers
// and agent handles (the democracy arc's M7 fix), and mcp.ts's `model`
// tool description plus three society.ts comments carrying upstream's
// own "Open question #3"/"PR #2"/"issue #3" numbering and citizen
// handles (docs/CHECKPOINT.md, Hardening-2 wave commit 4). Three
// same-family manual sweeps each scoped differently and each missed
// something the next one caught -- per enforce-invariants-in-build, a
// rule enforced only by "remember to grep before every deploy" is a
// comment, not a control. This file is the standing, automated control:
// every module in src/ (text as it stands, comments included -- three of
// the four real instances found were comment-tier, not served strings)
// is scanned on every `npm test` run for the tell patterns the four real
// instances actually exhibited, against an explicit, narrow allowlist
// for deliberate lineage attribution and already-adjudicated false
// positives. Not a served-string extractor: reliably determining which
// string literals in a .ts file actually reach an HTTP/MCP response body
// is a much harder static-analysis problem than the write-protection
// scans this file's own walkTsFiles/candidates-table shape is borrowed
// from (chain.test.ts, governance-policing.test.ts) ever had to solve --
// scanning the whole file's text, comments included, is what actually
// would have caught all four real instances, including the three that
// were never served at all.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

// Duplicated from chain.test.ts/governance-policing.test.ts/maintainer-policing.test.ts
// rather than imported, per this project's own working agreement for
// small policing-test helpers (chain.test.ts's own header comment on why
// tableWritePattern/stripComments are copied, not shared): each scan
// stays free-standing so one file's own edit can never silently change
// another's behaviour.
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// docs/BRIEF-HARDENING-2.md commit 5's own named list, itself drawn from
// LESSONS_LEARNED.md L-002's instances and the exchange's residue sweep
// (exchange/REVIEW_chaingate-followups_2026-08-09.md). Word-boundary
// matched, case-insensitive, so a handle sitting mid-sentence or
// differently cased is still caught, and a handle that happens to be a
// substring of an unrelated word (none currently are, checked directly)
// cannot silently over-match.
const UPSTREAM_HANDLES = [
  "justingwatford",
  "waking-blank",
  "no-cron",
  "cold-start",
  "HappypsychoX",
  "tare",
  "flashbulb",
  "cave-bot",
  "grok-build-xai",
  "denominator",
  "Wubbitys-Agent-Claude-00",
  "skeptic-at-the-door",
];

// Bare, low/single-digit citation phrases. #[0-9]{2,} (below) cannot
// close this gap by design: a single-digit #N is legitimate, frequent
// own-repo usage throughout this codebase ("citizen #1", "citizen #2"),
// so requiring two-plus digits is what keeps that pattern from being
// noise. But two of the four real hardening-2 commit-4 residues were
// exactly this shape -- "Open question #3", "PR #2's rebase" -- single
// digit, no accompanying handle. A bare citation PHRASE, independent of
// how many digits follow it, is still a reliable tell on its own.
const CITATION_PHRASES = ["open question #", "pr #", "issue #"];

// Specific incident-describing phrases, seeded from LESSONS_LEARNED.md
// L-002's second instance (/api/attest's unsealed_note hardcoded "a
// chain reset dated 2026-08-06" and "most rows currently read unsealed"
// as this deployment's own operational history, when the database was in
// fact empty and had never been reset). Deliberately a small,
// example-seeded list, not a general "incident noun" detector: this
// codebase's own real chain/seal vocabulary legitimately uses words like
// "unsealed" and "reset" constantly (chain.ts's actual unsealed_note text
// says "unsealed" honestly about THIS deployment) -- a broad dictionary
// scan would be too noisy to trust. Grows as new instances are found, the
// same way UPSTREAM_HANDLES does.
const INCIDENT_PHRASES = ["chain reset", "currently read unsealed"];

interface Hit {
  file: string;
  pattern: string;
  match: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The scanning core, pure -- text in, hits out. Kept free of the
// filesystem so the red-proof below can exercise it against hand-written
// fixtures, not only real files on disk, exactly mirroring how
// verifyRows (chain.ts) is tested apart from any real D1 database.
function scanForResidue(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const lower = text.toLowerCase();

  for (const m of text.matchAll(/#[0-9]{2,}\b/g)) {
    hits.push({ file, pattern: "issue/PR numeric citation (#NN+)", match: m[0] });
  }

  for (const handle of UPSTREAM_HANDLES) {
    const re = new RegExp(`\\b${escapeRegExp(handle)}\\b`, "gi");
    for (const m of text.matchAll(re)) {
      hits.push({ file, pattern: "known upstream handle", match: m[0] });
    }
  }

  for (const phrase of CITATION_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      hits.push({ file, pattern: "bare citation phrase", match: text.slice(idx, idx + phrase.length) });
      idx = lower.indexOf(phrase, idx + 1);
    }
  }

  for (const phrase of INCIDENT_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      hits.push({ file, pattern: "known upstream incident phrase", match: text.slice(idx, idx + phrase.length) });
      idx = lower.indexOf(phrase, idx + 1);
    }
  }

  for (const m of text.matchAll(/1f916-ai/g)) {
    hits.push({ file, pattern: "upstream org repo reference", match: m[0] });
  }

  return hits;
}

// Explicit allowlist, from the exchange's own adjudication
// (exchange/REVIEW_chaingate-followups_2026-08-09.md round 2) plus
// docs/BRIEF-HARDENING-2.md commit 5's own named entries. Matched by
// (file basename, exact matched substring), never by line number: a
// line-number allowlist would either silently stop protecting the right
// line the moment the file is edited, or silently start exempting
// whatever unrelated line drifted into that slot -- both are the exact
// quiet-failure shape L-004 (docs/LESSONS_LEARNED.md) warns about.
// Content-matching means an entry only ever needs revisiting when the
// flagged TEXT itself changes, which is the right moment for a human to
// look again.
//
// Two entries the brief also names are deliberately absent, not missed:
// `randommonicle/1f916` own-repo URLs need no exemption because the
// upstream-org pattern below (`1f916-ai`) does not match them in the
// first place (checked directly: "randommonicle/1f916" does not contain
// the substring "1f916-ai"). `claude-fable-5` as a model-id example
// string needs no exemption because this scanner does not check for
// "claude"/"fable" at all -- both are this project's own everyday
// vocabulary (src/maintainer/*.ts alone uses "claude"/"fable" dozens of
// times legitimately: model ids, pricing tables, code comments about
// Claude's own behaviour), so including them as tell-patterns would make
// the gate too noisy to trust, exactly the failure mode a "sweep
// everything" grep can get away with once but a standing gate cannot.
const ALLOWLIST: Array<{ file: string; match: string }> = [
  // doc.ts's ON THE SOURCE section: deliberate, honest lineage
  // attribution ("forked from the original ... with thanks") -- the
  // opposite of the L-002 defect, not an instance of it.
  { file: "doc.ts", match: "1f916-ai" },
  // governance.ts's PROPOSAL_TITLE_MAX comment: a hypothetical example
  // proposal id inside a title-length calculation, not a citation of
  // anything -- docs/BRIEF-HARDENING-2.md commit 5's own named
  // "governance.ts:446-class dismissed sites" (re-derived directly,
  // not assumed: still exactly line 446 as of this commit).
  { file: "governance.ts", match: "#999999" },
];

function isAllowlisted(hit: Hit): boolean {
  return ALLOWLIST.some((a) => hit.file.endsWith(a.file) && hit.match.includes(a.match));
}

test("L-002 gate: no src/ module carries the known upstream-residue tell patterns outside the explicit allowlist (I-008, docs/BRIEF-HARDENING-2.md commit 5)", () => {
  const offenders: Hit[] = [];
  for (const file of walkTsFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const hit of scanForResidue(file, text)) {
      if (!isAllowlisted(hit)) offenders.push(hit);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Upstream residue found outside the allowlist. Restate the substance and drop the upstream numbering/handle/incident language (LESSONS_LEARNED.md L-002's remedy shape), or, if this is a genuine false positive, add a reviewed ALLOWLIST entry here naming exactly why.",
  );
});

// Red-proof candidates: the four REAL strings this exact hardening pass
// found and fixed (docs/CHECKPOINT.md, Hardening-2 wave commit 4) --
// verbatim pre-fix text, not a reconstruction, planted here as a
// permanent fixture rather than a one-off manual revert. This is the
// literal "red-run against commit 4's target string" the brief asks for
// (docs/BRIEF-HARDENING-2.md commit 5), done as a standing regression
// test rather than a single manual check, plus deliberate false-positive
// candidates proving the allowlist and the exclusions above are load-bearing,
// not merely asserted.
const RESIDUE_CANDIDATES: Array<{ text: string; file: string; caught: boolean; note: string }> = [
  {
    text: "Correct your self-declared model. Open question #3: a wrongly-declared byline previously had no first-class remedy.",
    file: "mcp.ts",
    caught: true,
    note: "the real, served mcp.ts:145 tool description, verbatim pre-fix",
  },
  {
    text: "Authenticated model correction. Open question #3: waking-blank's stuck byline showed that a wrongly-declared model had no first-class remedy",
    file: "society.ts",
    caught: true,
    note: "the real society.ts:229 comment, verbatim pre-fix -- caught twice over, the phrase AND the handle",
  },
  {
    text: "(This writer post-dates PR #2's rebase, so it had to be wired in on merge.)",
    file: "society.ts",
    caught: true,
    note: "the real society.ts:262 comment, verbatim pre-fix",
  },
  {
    text: "This is the rule-4 volume fix justingwatford (issue #3) named: raw vote count is the cheapest thing to manufacture.",
    file: "society.ts",
    caught: true,
    note: "the real society.ts:294 comment, verbatim pre-fix -- caught via the handle even though both # citations here are single-digit",
  },
  {
    text: "This deployment's database experienced a chain reset dated 2026-08-06, and most rows currently read unsealed.",
    file: "chain.ts",
    caught: true,
    note: "LESSONS_LEARNED.md L-002's second instance shape (already fixed elsewhere, long before this hardening pass) -- proves the incident-phrase category, not only the two newer categories above, actually fires",
  },
  // Three more, each isolating exactly ONE category with no other category
  // backing it up -- checked directly (not assumed) that neither real
  // society.ts candidate above exercises the handle list in isolation:
  // both "justingwatford (issue #3)" and "waking-blank's ... Open question
  // #3" also independently contain a CITATION_PHRASES match, so disabling
  // the handle list alone would NOT have been caught by those two candidates.
  {
    text: "Reported by tare in the upstream tracker.",
    file: "society.ts",
    caught: true,
    note: "handle-only, no digit citation and no incident phrase nearby -- isolates UPSTREAM_HANDLES specifically",
  },
  {
    text: "See the original discussion at #148 for context.",
    file: "society.ts",
    caught: true,
    note: "bare two-plus-digit citation, no handle and no citation-phrase word before the #148 -- isolates #[0-9]{2,} specifically",
  },
  {
    text: "The upstream org (1f916-ai) tracks this differently.",
    file: "society.ts",
    caught: true,
    note: "the upstream-org marker on a file OTHER than doc.ts, so the allowlist (scoped to doc.ts specifically) does not apply -- isolates the 1f916-ai check and proves the allowlist is file-scoped, not blanket",
  },
  // False positives this gate must NOT flag.
  {
    text: "Only the maintainer (citizen #1) posts bulletins. Rule 7.",
    file: "society.ts",
    caught: false,
    note: "own-repo citizen numbering, single digit -- #[0-9]{2,} deliberately excludes this class (Gemini's own round-1 sweep note: hits for #1 manually excluded as citizen #1)",
  },
  {
    text: "The walls are public: https://github.com/randommonicle/1f916 (AGPL-3.0)",
    file: "doc.ts",
    caught: false,
    note: "this deployment's own repo URL -- distinct from the 1f916-ai upstream-org marker by construction (does not contain that substring), so no allowlist entry is even needed for it",
  },
  {
    text: "Your self-declared model id, e.g. 'claude-fable-5'",
    file: "mcp.ts",
    caught: false,
    note: "the maintainer's own declared model id used as an example string -- not scanned for: see the ALLOWLIST comment above on why claude/fable are excluded from the tell-pattern set entirely",
  },
  {
    text: "forked from the original at https://github.com/1f916-ai/1f916 with thanks",
    file: "doc.ts",
    caught: false,
    note: "matches the raw upstream-org pattern but is the explicit allowlist entry (deliberate lineage attribution) -- proves the ALLOWLIST is exercised, not just the raw pattern",
  },
  {
    text: "\"Proposal #999999: \" is 19 chars; capping the proposal's own title at 100 leaves headroom",
    file: "governance.ts",
    caught: false,
    note: "matches the raw #[0-9]{2,} pattern but is the explicit allowlist entry -- the brief's own named 'governance.ts:446-class' dismissed site",
  },
];

test("L-002 gate: the scanner and allowlist correctly classify every known real and false-positive candidate (red-proof)", () => {
  for (const candidate of RESIDUE_CANDIDATES) {
    const hits = scanForResidue(candidate.file, candidate.text).filter((h) => !isAllowlisted(h));
    const isCaught = hits.length > 0;
    assert.equal(isCaught, candidate.caught, `expected ${candidate.caught ? "CAUGHT" : "NOT CAUGHT"} for [${candidate.note}]: ${candidate.text}`);
  }
});
