// The SEND step of the guest-answer loop (docs/BRIEF-GUEST-VOICE.md A6 (i)-(iii), A12, A13): posts ONE
// exchange-approved answer from commonhold-agent to ONE guest critique, then verifies the duty is discharged by
// exactly one answer.
//
//   node scripts/guest-answer-send.mjs --target g12 --body-file <file> --exchange <REVIEW_...md> [--base <url>] [--execute]
//
// Run from society/. Without --execute it is a dry run: every gate is read live and nothing is sent. Gates, each a
// STOP: the body passes bodyProblems; approvalProblem finds the last hub section naming this target with exactly
// this body and both seats' latest sections converging after it; the target is a guest row with a duty that is
// live (open or overdue: "already answered" is the live due status, A12, never the mere existence of a reply).
// The key is A12's `duty:g<n>:v<k>` from live state, so two overlapping runs collide on one key and the server
// writes one row (a different body is 409 idempotency_key_reused). At most two attempts. The custody file
// (../commonhold-agent-registration.local.json, Ben's) is read only after every gate passes; its value is never
// printed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BASE, DISCHARGED, readDue, readThread, answererRows, discharges, dutyKey, normaliseBody, bodyProblems, approvalProblem } from "./guest-answer-lib.mjs";

// A STOP ends the run with exit code 1. It throws rather than calling process.exit(), which on Windows can crash
// the process (0xC0000409) while fetch's handles are still open.
class Stop extends Error {}
const stop = (msg) => {
  throw new Stop(msg);
};
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function readTarget(base, target) {
  for (const view of ["actionable", "history"]) {
    const hit = (await readDue(base, view)).find((i) => i.id === target);
    if (hit) {
      const rows = await readThread(base, hit.post_id);
      return { due: hit, rows, row: rows.find((r) => r.id === target) };
    }
  }
  return null;
}

async function main() {
  const target = arg("target");
  if (!target || !/^g[1-9][0-9]*$/.test(target) || !arg("body-file") || !arg("exchange")) {
    console.error("usage: node scripts/guest-answer-send.mjs --target g<N> --body-file <file> --exchange <file> [--base <url>] [--execute]");
    return 2;
  }
  const execute = argv.includes("--execute");
  const base = arg("base") || DEFAULT_BASE;
  const body = normaliseBody(readFileSync(resolve(arg("body-file")), "utf8"));
  const problems = bodyProblems(body);
  if (problems.length) stop(problems.join("; "));
  const approval = approvalProblem(readFileSync(resolve(arg("exchange")), "utf8"), target, body);
  if (approval) stop(`exchange: ${approval}`);

  const live = await readTarget(base, target);
  if (!live) stop(`${target} is not on /api/guest/due (no duty, or it does not exist)`);
  const { due, rows, row } = live;
  if (!row) stop(`${target} is not in post ${due.post_id}'s guest thread`);
  if (row.tier !== "guest") stop(`${target} is not a guest row (tier ${row.tier})`);
  const status = row.duty?.status;
  if (!status) stop(`${target} carries no duty`);
  if (DISCHARGED.has(status)) stop(`${target} is already answered (live status ${status}); nothing to send`);
  if (status !== "open" && status !== "overdue") stop(`${target}'s live status is ${status}; only an open or overdue duty is answered`);
  const key = dutyKey(target, rows);
  console.log(`[live] ${target} on post ${due.post_id}, guest row, live status ${status}; body ${body.length} chars; exchange approved on both seats; key ${key}`);
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

  let refusal = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`${base}/api/guest/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ guest_comment_id: target, body, idempotency_key: key }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await r.text();
      console.log(`[send] attempt ${attempt}: HTTP ${r.status} ${text.slice(0, 300)}`);
      if (r.status === 200 || r.status === 201) break;
      if (r.status < 500) {
        refusal = `the server refused the answer (HTTP ${r.status}); a run that overlapped with a different body gets 409 idempotency_key_reused`;
        break; // a refusal is final; a retry would be refused the same way
      }
    } catch (e) {
      console.log(`[send] attempt ${attempt}: transport failure (${e.name}); the same key makes a retry safe`);
    }
  }
  secret = null;
  if (refusal) stop(refusal);

  // Verify from live state: the duty is discharged, by exactly one discharging answer, and that answer is this body.
  const after = await readThread(base, due.post_id);
  const mine = answererRows(after, target);
  const discharging = mine.filter(discharges);
  const exact = mine.filter((a) => normaliseBody(a.body) === body);
  const nowStatus = after.find((r) => r.id === target)?.duty?.status;
  if (exact.length !== 1 || discharging.length !== 1 || exact[0].id !== discharging[0].id || !DISCHARGED.has(nowStatus)) {
    stop(`verify: expected one discharging answer under ${target} equal to this body and a discharged status; found ${exact.length} exact, ${discharging.length} discharging, status ${nowStatus}`);
  }
  console.log(`[verify] ${exact[0].id} answers ${target} on post ${due.post_id}; body matches the file exactly (${body.length} chars); live status ${nowStatus}`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.log(`[STOP] ${e.message}`);
  process.exitCode = 1;
}
