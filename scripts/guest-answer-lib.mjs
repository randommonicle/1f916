// Shared, read-only helpers for the guest-answer loop (docs/BRIEF-GUEST-VOICE.md A6, A12, A13; G4b option A).
// No custody file is read here and no request here writes: every fetch is a GET. The draft step
// (guest-due-draft.mjs) imports only this; the send step (guest-answer-send.mjs) adds the one write.

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
// Fences as CommonMark reads them (CODEX scripts r3): an opener is up to three spaces, then three or more of ONE
// character (backtick or tilde; a backtick opener's info string holds no backtick); the fence closes only on a line
// of the SAME character, at least as long, with nothing after it. So a four-backtick quotation holding a
// three-backtick block stays one fence.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// Sections by exact header lines, each line tagged with whether it sits inside a fenced block (the fence lines
// themselves included). A header-shaped line INSIDE a fence (a seat quoting another section) or a fence still open at
// the end makes the file AMBIGUOUS, and an ambiguous file approves nothing: a quotation can never become a section,
// and a real section can never be hidden.
export function parseSections(text) {
  const sections = [];
  let fence = null;
  let ambiguous = false;
  for (const line of normaliseBody(text).split("\n")) {
    const m = HEADER.exec(line);
    if (m && fence) ambiguous = true;
    if (m && !fence) {
      const round = /\bround (\d+)\b/.exec(m[2]);
      sections.push({ handle: m[1], round: round ? Number(round[1]) : null, lines: [] });
      continue;
    }
    let fenced = fence !== null;
    if (fence) {
      const c = FENCE_CLOSE.exec(line);
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
    } else {
      const o = FENCE_OPEN.exec(line);
      if (o && !(o[1][0] === "`" && o[2].includes("`"))) {
        fence = { ch: o[1][0], len: o[1].length };
        fenced = true;
      }
    }
    if (sections.length) sections[sections.length - 1].lines.push({ text: line, fenced });
  }
  if (fence) ambiguous = true;
  return Object.assign(sections, { ambiguous });
}

// A seat's verdict counts only as the protocol writes it, at the END of its section: outside every fence and
// blockquote, ignoring blank lines and the transport's HTML comments, the last line is exactly that seat's own
// [[END <SEAT> round N]] with N the header's round, and the line before it is exactly [[CONVERGED]] at column 0
// (an indented line is code or a quotation, never a verdict; only trailing whitespace is ignored).
function sectionConverges(section) {
  const ls = section.lines
    .filter((l) => !l.fenced)
    .map((l) => l.text.trimEnd())
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith(">") && !l.startsWith("<!--"));
  return section.round != null && ls.length >= 2 && ls[ls.length - 1] === `[[END ${section.handle} round ${section.round}]]` && ls[ls.length - 2] === "[[CONVERGED]]";
}

// The approval gate (A6 ii, bound per CODEX/GEMINI review of ccca8490): the LAST hub section names the target on a
// line exactly `Target: <gid>` and carries the answer in an ```answer fenced block equal to the body; each seat's
// LATEST section comes after that hub section and converges. Returns null when approved, else the reason.
export function approvalProblem(exchangeText, target, body) {
  const sections = parseSections(exchangeText);
  if (sections.ambiguous) return "the exchange file is ambiguous (a section header inside a fenced block, or a fence left open); write a fresh exchange";
  const lastHub = sections.map((s) => s.handle).lastIndexOf("CLAUDE");
  if (lastHub < 0) return "no hub section";
  const hub = sections[lastHub].lines.map((l) => l.text);
  if (!hub.includes(`Target: ${target}`)) return `the last hub section does not name Target: ${target}`;
  const open = hub.indexOf("```answer");
  const close = open < 0 ? -1 : hub.indexOf("```", open + 1);
  if (open < 0 || close < 0) return "the last hub section has no closed ```answer block";
  if (hub.slice(open + 1, close).join("\n") !== body) return "the ```answer block in the last hub section is not exactly the body";
  for (const seat of ["GEMINI", "CODEX"]) {
    const last = sections.map((s) => s.handle).lastIndexOf(seat);
    if (last < lastHub) return `${seat} has not answered since the last hub section`;
    if (!sectionConverges(sections[last])) return `${seat}'s latest section does not converge`;
  }
  return null;
}
