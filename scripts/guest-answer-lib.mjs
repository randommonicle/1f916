// Shared, read-only helpers for the guest-answer loop (docs/BRIEF-GUEST-VOICE.md A6, A12, A13; G4b option A).
// No custody file is read here and no request here writes: every fetch is a GET. The draft step
// (guest-due-draft.mjs) imports only this; the send step (guest-answer-send.mjs) adds the one write.

// The one third-party import: the reference CommonMark parser (devDependency commonmark, pinned; never imported by src/).
import { Parser } from "commonmark";

export const DEFAULT_BASE = "https://commonhold.randommonicle.workers.dev";
export const ANSWERER = "commonhold-agent";
export const MIN_ANSWER_LEN = 80; // GUEST_DUTY_MIN_ANSWER_LEN (src/guest-core.ts): a shorter answer discharges nothing
export const MAX_ANSWER_LEN = 2000;
export const IDEM_KEY_MAX = 64; // GUEST_IDEM_KEY_MAX_LEN (src/guest-core.ts)
export const DISCHARGED = new Set(["answered", "answered_late"]);

export async function getJson(url) {
  const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (r.status !== 200) throw new Error(`HTTP ${r.status} reading ${url}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`unparseable JSON from ${url}`);
  }
}

// Every duty row in one view ("actionable": open and overdue; "history": answered, answered_late, waived), all pages.
export async function readDue(base, view = "actionable") {
  const items = [];
  let after = null;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ view });
    if (after) q.set("after", after);
    const doc = await getJson(`${base}/api/guest/due?${q}`);
    if (!Array.isArray(doc.items)) throw new Error("/api/guest/due carried no items array");
    items.push(...doc.items);
    if (!doc.has_more) return items;
    if (!doc.next_cursor) throw new Error("/api/guest/due said has_more with no next_cursor");
    after = doc.next_cursor;
  }
  throw new Error(`/api/guest/due (${view}) did not end within 100 pages`);
}

// Every row of a post's guest thread, all pages.
export async function readThread(base, postId) {
  const rows = [];
  let after = null;
  for (let page = 0; page < 1000; page++) {
    const q = new URLSearchParams({ post_id: String(postId) });
    if (after) q.set("after", after);
    const doc = await getJson(`${base}/api/guest/thread?${q}`);
    if (!Array.isArray(doc.guest_thread)) throw new Error(`/api/guest/thread for post ${postId} carried no guest_thread array`);
    rows.push(...doc.guest_thread);
    if (doc.guest_thread_next == null) return rows;
    after = doc.guest_thread_next;
  }
  throw new Error(`/api/guest/thread for post ${postId} did not end within 1000 pages`);
}

// The answerer's rows directly under guest row `gid`, and which of them discharge it (the G4 predicate:
// not moderated, at least MIN_ANSWER_LEN characters).
export function answererRows(rows, gid, handle = ANSWERER) {
  return rows.filter((r) => r.parent && r.parent.kind === "thread" && r.parent.id === gid && r.tier === "citizen" && r.author === handle);
}
// Characters as SQLite's length() counts them on TEXT, which is what the discharge predicate uses
// (src/guest-core.ts FIRST_DISCHARGE_SQL): code points, never JS UTF-16 units (an astral character is one, not two),
// and only up to the first U+0000, where SQLite's length() stops. bodyProblems refuses a NUL outright.
export function charLength(text) {
  const s = String(text);
  const nul = s.indexOf("\u0000");
  return [...(nul < 0 ? s : s.slice(0, nul))].length;
}
export function discharges(row) {
  return row.mod_state == null && typeof row.body === "string" && charLength(row.body) >= MIN_ANSWER_LEN;
}

// A12: the key is derived from live state, `duty:g<n>:v<k>`, k = 1 + the answerer's NON-discharging answers on that
// row. Two overlapping runs compute the same key, so the server writes one row (a different body is 409
// idempotency_key_reused); after a non-discharging answer, a fresh answer is still possible.
export function dutyKey(gid, rows) {
  const nonDischarging = answererRows(rows, gid).filter((r) => !discharges(r)).length;
  return `duty:${gid}:v${1 + nonDischarging}`;
}

export function normaliseBody(text) {
  return String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

// Refusals for a body before anything is sent; [] means it may go. A body line may not look like exchange
// structure (a section header, a marker, a fence), so the answer block cannot be confused with a verdict.
export function bodyProblems(body) {
  const p = [];
  const n = charLength(body);
  if (n < MIN_ANSWER_LEN) p.push(`body is ${n} characters; under ${MIN_ANSWER_LEN} it discharges nothing`);
  if (n > MAX_ANSWER_LEN) p.push(`body is ${n} characters; over ${MAX_ANSWER_LEN}`);
  if (/[–—]/.test(body)) p.push("body carries an en or em dash");
  if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(body)) p.push("body carries a control character (NUL included)");
  if (body.split("\n").some((l) => /^\s*(## \[|\[\[|```|~~~)/.test(l))) p.push("a body line starts with '## [', '[[' or a fence");
  return p;
}

// Guest text is untrusted: it enters an exchange file only as ONE JSON-encoded line, which cannot start a
// section header, a marker line or a fence.
export function encodeGuestText(text) {
  return JSON.stringify(text == null ? null : String(text));
}


const HEADER = /^## \[(CLAUDE|GEMINI|CODEX) ([^\]]*)\]\s*$/;
// Text that reads as a section header whatever the heading's form (a setext heading, extra spaces, closing hashes).
const HEADER_TEXT = /^\[(?:CLAUDE|GEMINI|CODEX) [^\]]*\]$/;
// Fence lines as CommonMark reads them: an opener is up to three spaces, then three or more of ONE character; a fence
// closes only on a line of the SAME character, at least as long, with nothing after it. Used only to tell a top-level
// fence that closed from one that ran to the end of the file; the block structure itself comes from the parser.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// Characters this reader does not interpret make the file ambiguous outright (CODEX guest-answer r4 HIGH): a bare CR is a
// CommonMark line ending that split("\n") misses, and U+2028/U+2029/U+0085 or any other control character can end a
// line or a regex dot somewhere the reader does not expect. Fail closed rather than chase each one; tab and LF only.
const UNINTERPRETED = /[\u0000-\u0008\u000B-\u001F\u007F\u0085\u2028\u2029]/;

// The exchange file is read by the reference CommonMark parser (commonmark.js, spec 0.31.2; D-074 note 4 Oct), never by
// a hand-written line scanner: nine constructs (a fence or HTML comment that one reader saw and the other did not) made
// the hand parser disagree with CommonMark about whether a verdict line was live. The document's top-level nodes are
// the only thing read: a quotation, list item, fence or HTML block is one node, so what sits inside it is never a header
// and never a verdict.

// The text of an inline subtree, for comparing a heading with the raw line it came from.
function textOf(node) {
  let s = "";
  for (let c = node.firstChild; c; c = c.next) {
    if (c.type === "text" || c.type === "code") s += c.literal;
    else if (c.type === "softbreak" || c.type === "linebreak") s += "\n";
    else s += textOf(c);
  }
  return s;
}

// The exact text of a one-line paragraph made only of plain text, else null. commonmark.js splits `[[X]]` into several
// sibling text nodes (`[`, `[`, `X`, `]`, `]`), so "only text" means every child is a text node and the concatenation is
// the string. The raw source line (trailing spaces and tabs stripped) must equal it too: an escape (`\[`), an entity
// (`&#91;`) or an indent (` [[CONVERGED]]`) renders as the marker but is not the line the protocol writes, and the
// strict side fails closed.
function plainLine(node, lines) {
  if (node.type !== "paragraph") return null;
  let s = "";
  for (let c = node.firstChild; c; c = c.next) {
    if (c.type !== "text") return null;
    s += c.literal;
  }
  const [[first], [last]] = node.sourcepos;
  if (first !== last) return null;
  return lines[first - 1].replace(/[ \t]+$/, "") === s ? s : null;
}

// What an HTML block is. "comment": ONE complete `<!-- ... -->` and nothing after the first `-->` (the transport's
// metadata note is one). "partial": a terminated comment with more text after its `-->` on the same line (ordinary
// content, never a verdict). "open": a comment with no `-->` before the block ends. "other": `<pre>`, `<details>`,
// `<?php`, `<!DOCTYPE` and the rest of the raw HTML block starts.
// CODEX r8 round 5: an HTML reader tokenises a comment differently from CommonMark's block rule (`<!-->` and `<!--->` end an
// empty comment at once, `--!>` ends one too), so "comment" is only an INERT one: `<!--`, then text with no `<`, `>` or `--`,
// then `-->`, not starting with `>` or `->`. The transport's note has that shape. Any other comment block is "malformed".
const INERT_COMMENT = /^<!--(?![->])(?:[^<>-]|-(?!-))*-->$/;
function htmlBlockKind(node) {
  if (node.type !== "html_block") return null;
  const t = node.literal.replace(/^[ \t]+/, "").replace(/[ \t\n]+$/, "");
  if (!t.startsWith("<!--")) return "other";
  if (INERT_COMMENT.test(t)) return "comment";
  const i = t.indexOf("-->", 4);
  if (i < 0) return "open";
  return i + 3 === t.length ? "malformed" : "partial";
}

// Sections are delimited by top-level level-2 headings whose raw line is exactly a HEADER line; a section is the run of
// top-level nodes after its heading up to the next one. An ambiguous file approves nothing:
//  - a control or line-separator character the reader does not interpret (UNINTERPRETED);
//  - a HEADER-shaped raw line that is not the line of a top-level section heading (a seat quoting another section inside
//    a fence, list, blockquote or HTML block): a quotation can never become a section, and a real one can never be hidden;
//  - a top-level level-2 heading that reads as a section header but is not a HEADER line (setext, closing hashes);
//  - a top-level fence still open at the end of the file, or an HTML comment that never closes;
//  - a raw HTML block other than one complete comment standing alone, or any inline HTML (CODEX r8 round 3), at any depth: it changes what
//    CommonMark treats as a fence or a comment, and over-refusing is acceptable (an ambiguous exchange is answered by hand).
export function parseSections(text) {
  const body = normaliseBody(text);
  const lines = body.split("\n");
  const sections = [];
  let ambiguous = UNINTERPRETED.test(body);
  if (ambiguous) return Object.assign(sections, { ambiguous });
  const doc = new Parser().parse(body);
  const headingLines = new Set();
  let current = null;
  for (let n = doc.firstChild; n; n = n.next) {
    if (n.type === "heading" && n.level === 2) {
      const line = n.sourcepos[0][0];
      const m = n.sourcepos[1][0] === line ? HEADER.exec(lines[line - 1]) : null;
      if (m) {
        const round = /\bround (\d+)\b/.exec(m[2]);
        current = { handle: m[1], round: round ? Number(round[1]) : null, nodes: [], lines };
        sections.push(current);
        headingLines.add(line);
        continue;
      }
      if (HEADER_TEXT.test(textOf(n))) ambiguous = true;
    }
    if (current) current.nodes.push(n);
    if (n.type === "code_block") {
      const open = FENCE_OPEN.exec(lines[n.sourcepos[0][0] - 1]);
      if (open) {
        const [[start], [end]] = n.sourcepos;
        const close = end > start ? FENCE_CLOSE.exec(lines[end - 1]) : null;
        if (!close || close[1][0] !== open[1][0] || close[1].length < open[1].length) ambiguous = true;
      }
    }
  }
  lines.forEach((l, i) => {
    if (HEADER.test(l) && !headingLines.has(i + 1)) ambiguous = true;
  });
  // CODEX r8 round 3: CommonMark passes raw HTML through to an HTML reader unescaped, so the AST is not what a reader sees
  // once raw HTML can act: a comment block with more after its `-->` (a second `<!--` there hides everything after it) and
  // ANY inline HTML (`<script>`, a comment inside a paragraph) make the file ambiguous. Only a complete comment block
  // standing alone (the transport's note) is allowed.
  const walker = doc.walker();
  for (let ev = walker.next(); ev; ev = walker.next()) {
    if (!ev.entering) continue;
    if (ev.node.type === "html_inline") ambiguous = true;
    const kind = htmlBlockKind(ev.node);
    if (kind !== null && kind !== "comment") ambiguous = true;
  }
  return Object.assign(sections, { ambiguous });
}

// A seat's verdict counts only as the protocol writes it, at the END of its section. Among the section's top-level
// nodes, ignoring HTML blocks that are one complete comment (the transport's trailing note), the last node is a
// paragraph that is exactly that seat's own [[END <SEAT> round N]] with N the header's round, and the node before it is
// a paragraph that is exactly [[CONVERGED]]. Two paragraphs are two nodes only if a blank line (or another block) sits
// between them, so a marker can never be a lazy continuation of a quotation, list item or paragraph; a marker inside a
// list, quotation, fence or comment is part of that node and never a top-level paragraph.
function sectionConverges(section) {
  if (section.round == null) return false;
  const nodes = section.nodes.filter((n) => htmlBlockKind(n) !== "comment");
  if (nodes.length < 2) return false;
  return (
    plainLine(nodes[nodes.length - 1], section.lines) === `[[END ${section.handle} round ${section.round}]]` &&
    plainLine(nodes[nodes.length - 2], section.lines) === "[[CONVERGED]]"
  );
}

// The approval gate (A6 ii, bound per CODEX/GEMINI review of ccca8490): the LAST hub section names the target in a
// top-level paragraph exactly `Target: <gid>` and carries the answer in ONE top-level ```answer fenced block equal to the
// body; each seat's LATEST section comes after that hub section and converges. Returns null when approved, else the reason.
// DEFERRED-APPROVAL-BINDS-BODY (hub, 7 Oct 2026, g2 exchange; LESSONS L-133): this gate reads POSITION, not what was approved. It passes when each seat's latest section
// sits after the last hub section and carries [[CONVERGED]], but nothing shows the seat read THAT hub section: a seat run started before a new hub round lands after it,
// so a convergence on an older body would approve a newer one the seat never saw (GEMINI r1 on g2 did exactly that, and withheld, so nothing was sent). Candidate fix:
// the seat quotes the hub's round number or the body's sha256 in its approving section, and the gate checks it. Until then: never append a hub round while a seat run is in flight.
export function approvalProblem(exchangeText, target, body) {
  const sections = parseSections(exchangeText);
  if (sections.ambiguous) return "the exchange file is ambiguous (a section header inside a fence, quotation or HTML block, a fence or comment left open, a raw HTML block other than a comment, or a control or line-separator character other than tab and LF); write a fresh exchange";
  const lastHub = sections.map((s) => s.handle).lastIndexOf("CLAUDE");
  if (lastHub < 0) return "no hub section";
  const hub = sections[lastHub];
  if (!hub.nodes.some((n) => plainLine(n, hub.lines) === `Target: ${target}`)) return `the last hub section does not name Target: ${target}`;
  const blocks = hub.nodes.filter((n) => n.type === "code_block" && n.info === "answer");
  if (blocks.length === 0) return "the last hub section has no closed ```answer block";
  if (blocks.length > 1) return "the last hub section has more than one ```answer block";
  if (blocks[0].literal !== body + "\n") return "the ```answer block in the last hub section is not exactly the body";
  for (const seat of ["GEMINI", "CODEX"]) {
    const last = sections.map((s) => s.handle).lastIndexOf(seat);
    if (last < lastHub) return `${seat} has not answered since the last hub section`;
    if (!sectionConverges(sections[last])) return `${seat}'s latest section does not converge`;
  }
  return null;
}
