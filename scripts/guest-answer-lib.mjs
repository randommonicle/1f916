// Shared, read-only helpers for the guest-answer loop (docs/BRIEF-GUEST-VOICE.md A6, G4b option A).
// No custody file is read here and no request here writes: every fetch is a GET. The draft step
// (guest-due-draft.mjs) imports only this; the send step (guest-answer-send.mjs) adds the one POST.
import { createHash } from "node:crypto";

export const DEFAULT_BASE = "https://commonhold.randommonicle.workers.dev";
export const ANSWERER = "commonhold-agent";
export const MIN_ANSWER_LEN = 80; // GUEST_DUTY_MIN_ANSWER_LEN (src/guest-core.ts): a shorter answer discharges nothing
export const MAX_ANSWER_LEN = 2000;
export const IDEM_KEY_MAX = 64; // GUEST_IDEM_KEY_MAX_LEN (src/guest-core.ts)

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

// Every actionable duty (open or overdue), all pages, in served order.
export async function readActionable(base) {
  const items = [];
  let after = null;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ view: "actionable" });
    if (after) q.set("after", after);
    const doc = await getJson(`${base}/api/guest/due?${q}`);
    if (!Array.isArray(doc.items)) throw new Error("/api/guest/due carried no items array");
    items.push(...doc.items);
    if (!doc.has_more) return { items, doc };
    if (!doc.next_cursor) throw new Error("/api/guest/due said has_more with no next_cursor");
    after = doc.next_cursor;
  }
  throw new Error("/api/guest/due did not end within 100 pages");
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

// The answerer's rows directly under guest row `gid` (the only rows that can discharge it).
export function answersTo(rows, gid, handle = ANSWERER) {
  return rows.filter((r) => r.parent && r.parent.kind === "thread" && r.parent.id === gid && r.tier === "citizen" && r.author === handle);
}

export function normaliseBody(text) {
  return String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

// Refusals for a body before anything is sent; [] means it may go.
export function bodyProblems(body) {
  const p = [];
  if (body.length < MIN_ANSWER_LEN) p.push(`body is ${body.length} characters; under ${MIN_ANSWER_LEN} it discharges nothing`);
  if (body.length > MAX_ANSWER_LEN) p.push(`body is ${body.length} characters; over ${MAX_ANSWER_LEN}`);
  if (/[–—]/.test(body)) p.push("body carries an en or em dash");
  return p;
}

// Deterministic per (target, body): a retry of the same answer replays; a different body is a different key.
export function idemKey(gid, body) {
  return `ga-${gid}-` + createHash("sha256").update(`${gid}\n${body}`).digest("hex").slice(0, 40);
}

// The exchange gate: the exact body appears in the file, and AFTER its last appearance both seats wrote a
// section that says [[CONVERGED]]. Returns null when converged, else the reason.
export function convergenceProblem(exchangeText, body) {
  const text = normaliseBody(exchangeText);
  const at = text.lastIndexOf(body);
  if (at < 0) return "the exact body does not appear in the exchange file";
  const sections = text.slice(at + body.length).split(/\n(?=## \[)/).filter((s) => s.startsWith("## ["));
  const converged = (seat) => sections.some((s) => s.startsWith(`## [${seat} `) && s.includes("[[CONVERGED]]"));
  const missing = ["GEMINI", "CODEX"].filter((seat) => !converged(seat));
  return missing.length ? `no [[CONVERGED]] from ${missing.join(" and ")} after the body's last appearance` : null;
}
