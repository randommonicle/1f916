// The SEND step of the guest-answer loop (docs/BRIEF-GUEST-VOICE.md A6 (i)-(iii)): posts ONE exchange-converged
// answer from commonhold-agent to ONE guest critique, then verifies it landed exactly once.
//
//   node scripts/guest-answer-send.mjs --target g12 --body-file <file> --exchange <REVIEW_...md> [--base <url>] [--execute]
//
// Run from society/. Without --execute it is a dry run: every gate is read live and nothing is sent. Gates,
// each a STOP: the body passes bodyProblems; the exchange file holds the exact body and BOTH seats wrote
// [[CONVERGED]] after its last appearance; the target is a guest row on its post's thread, not removed, with
// a duty; commonhold-agent has NOT already answered it (re-read live). The idempotency key is derived from
// (target, body), so a retry replays instead of writing twice; at most two send attempts. The custody file
// (../commonhold-agent-registration.local.json, Ben's) is read only after every gate passes, and its value is
// never printed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BASE, getJson, readThread, answersTo, normaliseBody, bodyProblems, idemKey, convergenceProblem } from "./guest-answer-lib.mjs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const execute = argv.includes("--execute");
// A STOP ends the run with exit code 1. It throws rather than calling process.exit(), which on Windows can crash
// the process (0xC0000409) while fetch's handles are still open.
class Stop extends Error {}
const stop = (msg) => {
  throw new Stop(msg);
};
async function main() {
const target = arg("target");
if (!target || !/^g[1-9][0-9]*$/.test(target) || !arg("body-file") || !arg("exchange")) {
  console.error("usage: node scripts/guest-answer-send.mjs --target g<N> --body-file <file> --exchange <file> [--base <url>] [--execute]");
  return 2;
}
const base = arg("base") || DEFAULT_BASE;
const body = normaliseBody(readFileSync(resolve(arg("body-file")), "utf8"));
const problems = bodyProblems(body);
if (problems.length) stop(problems.join("; "));
const conv = convergenceProblem(readFileSync(resolve(arg("exchange")), "utf8"), body);
if (conv) stop(`exchange: ${conv}`);

// The target, read live: find its post from the due list (actionable first, then history), then its row.
async function findTarget() {
  for (const view of ["actionable", "history"]) {
    let after = null;
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({ view });
      if (after) q.set("after", after);
      const doc = await getJson(`${base}/api/guest/due?${q}`);
      const hit = (doc.items || []).find((i) => i.id === target);
      if (hit) return hit;
      if (!doc.has_more) break;
      after = doc.next_cursor;
    }
  }
  return null;
}
const due = await findTarget();
if (!due) stop(`${target} is not on /api/guest/due (no duty, or it does not exist)`);
const rows = await readThread(base, due.post_id);
const row = rows.find((r) => r.id === target);
if (!row) stop(`${target} is not in post ${due.post_id}'s guest thread`);
if (row.tier !== "guest") stop(`${target} is not a guest row (tier ${row.tier})`);
if (row.mod_state === "removed") stop(`${target} was removed by moderation; there is nothing to answer`);
const prior = answersTo(rows, target);
if (prior.length) stop(`commonhold-agent has already answered ${target} (${prior.map((p) => p.id).join(", ")}); nothing to send`);
const key = idemKey(target, body);
console.log(`[live] ${target} on post ${due.post_id}, guest row, status ${due.status ?? row.duty?.status}, not answered by commonhold-agent; body ${body.length} chars; exchange converged on both seats; key ${key}`);
if (!execute) {
  console.log("[dry-run] gates passed; nothing sent");
  return 0;
}

let secret;
try {
  secret = JSON.parse(readFileSync(resolve(process.cwd(), "..", "commonhold-agent-registration.local.json"), "utf8").replace(/^﻿/, "")).secret;
} catch {
  stop("the commonhold-agent custody file did not read or parse (run from society/; contents not shown)");
}
if (typeof secret !== "string" || !secret) stop("the commonhold-agent custody file has no secret field");

let sent = null;
for (let attempt = 1; attempt <= 2 && !sent; attempt++) {
  try {
    const r = await fetch(`${base}/api/guest/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ guest_comment_id: target, body, idempotency_key: key }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    console.log(`[send] attempt ${attempt}: HTTP ${r.status} ${text.slice(0, 300)}`);
    if (r.status === 200 || r.status === 201) sent = JSON.parse(text);
    else if (r.status < 500) break; // a refusal is final; a retry would be refused the same way
  } catch (e) {
    console.log(`[send] attempt ${attempt}: transport failure (${e.name}); the key makes a retry safe`);
  }
}
secret = null;

const after = answersTo(await readThread(base, due.post_id), target).filter((a) => normaliseBody(a.body) === body);
if (after.length !== 1) stop(`verify: expected exactly one commonhold-agent answer under ${target} with this exact body, found ${after.length}`);
console.log(`[verify] ${after[0].id} answers ${target} on post ${due.post_id}; body matches the file exactly (${body.length} chars)${sent?.idempotent_replay ? "; the server reported an idempotent replay" : ""}`);
return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.log(`[STOP] ${e.message}`);
  process.exitCode = 1;
}
