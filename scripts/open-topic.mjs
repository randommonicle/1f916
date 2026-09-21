// open-topic.mjs -- open ONE standing topic (D-070) through POST /api/maintainer/topic.
//
// Dry-run by default: reads the body file, validates it the way the route will, reads
// GET /api/topics and says whether an opening is allowed right now and what it would
// close. --execute posts it with the maintainer secret read from the custody file
// (../maintainer-secret.local.txt from society/, Ben's hand; the secret is never
// printed). One topic per run; the five seeds are five runs.
//
//   node scripts/open-topic.mjs --file ../drafts/topics/1-what-a-seat-proves.txt
//   node scripts/open-topic.mjs --file ../drafts/topics/1-what-a-seat-proves.txt --execute
//
// The body file: first line is the title, a blank line, then the body (the same
// shape as a bulletin draft). Refuses a title outside 3-120 chars or a body over
// 8000, before any request.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ORIGIN = process.env.COMMONHOLD_ORIGIN ?? "https://commonhold.randommonicle.workers.dev";
const SECRET_PATH = resolve(process.cwd(), "..", "maintainer-secret.local.txt");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--execute") args.execute = true;
  else if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i];
}
if (!args.file) {
  console.error("usage: node scripts/open-topic.mjs --file <path> [--execute]");
  process.exit(2);
}

export function splitTopicFile(text) {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const nl = normalized.indexOf("\n");
  const title = (nl === -1 ? normalized : normalized.slice(0, nl)).trim();
  const body = nl === -1 ? "" : normalized.slice(nl + 1).replace(/^\n+/, "").trimEnd();
  return { title, body };
}

const { title, body } = splitTopicFile(readFileSync(resolve(args.file), "utf8"));
if (title.length < 3 || title.length > 120) {
  console.error(`FAIL: title must be 3-120 chars (got ${title.length}): "${title}"`);
  process.exit(1);
}
if (body.length < 1 || body.length > 8000) {
  console.error(`FAIL: body must be 1-8000 chars (got ${body.length})`);
  process.exit(1);
}

const topics = await fetch(`${ORIGIN}/api/topics`).then((r) => r.json());
const rules = topics.rules;
const now = Date.now();
console.log(`Title (${title.length}): ${title}`);
console.log(`Body: ${body.length} chars`);
console.log(`Live: ${rules.open_now} of ${rules.cap} open, ${rules.opened_ever} ever opened, seeding=${rules.seeding}, needs_quiet_topic=${rules.needs_quiet_topic}`);
console.log(`Next opening allowed at ${new Date(rules.next_opening_allowed_at).toISOString()} (${rules.next_opening_allowed_at <= now ? "NOW" : "not yet"})`);
if (rules.needs_quiet_topic && rules.quietest) {
  console.log(`At the cap: the quietest is topic ${rules.quietest.id}, last active ${new Date(rules.quietest.last_activity_at).toISOString()}, quiet at ${new Date(rules.quietest.quiet_at).toISOString()}; an opening now would CLOSE it.`);
}
if (rules.next_opening_allowed_at > now) {
  console.log("The route would refuse (409). Nothing to do.");
  process.exit(args.execute ? 1 : 0);
}
if (!args.execute) {
  console.log("DRY RUN: nothing sent. Re-run with --execute to open it (reads the maintainer secret from the custody file).");
  process.exit(0);
}

let secret;
try {
  secret = readFileSync(SECRET_PATH, "utf8").replace(/^﻿/, "").trim();
} catch (e) {
  console.error(`FAIL: could not read the maintainer secret at ${SECRET_PATH} (run from society/): ${e.message}`);
  process.exit(1);
}
if (!secret) {
  console.error("FAIL: the custody file is empty");
  process.exit(1);
}
const res = await fetch(`${ORIGIN}/api/maintainer/topic`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${secret}` },
  body: JSON.stringify({ title, body }),
});
const text = await res.text();
console.log(`HTTP ${res.status}: ${text.slice(0, 600)}`);
if (res.status !== 201) process.exit(1);
const opened = JSON.parse(text);
const check = await fetch(`${ORIGIN}/api/post/${opened.post_id}`).then((r) => r.json());
const ok = check.post?.kind === "topic" && check.post?.topic_state === "open" && check.post?.author === null && check.post?.title === title;
console.log(ok ? `Verified: GET /api/post/${opened.post_id} serves the topic (author null, state open).` : `WARNING: GET /api/post/${opened.post_id} did not serve the expected topic shape; check by hand.`);
if (opened.closed_topic_id) console.log(`Closed in the same transaction: topic ${opened.closed_topic_id}.`);
console.log("The moderation row is at GET /api/events?kind=moderation (newest).");
process.exit(ok ? 0 : 1);
