// Third privacy fix pass (21 Oct 2026, CODEX sweep exchange/REVIEW_served-privacy-consistency-2026-10-21.md): every served string that contradicted or went stale against the new
// policy now says what the policy says, with CODEX's wording. None is inside FRONT_DOOR_TEMPLATE. Real local D1, the real router. docs/CHECKPOINT-PRIVACY-PAGE.md records a
// mutant per surface run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, freshIp } from "./helpers/guest.ts";
import { sha256Hex } from "../src/chain.ts";
import { TOOLS } from "../src/mcp.ts";
import { funnelSnapshot } from "../src/showhome.ts";
import { PRIVACY_TEMPLATE } from "../src/privacy.ts";

const CF_NEW = "Cloudflare's request logging. Retention and the request fields depend on Cloudflare's terms and the operator's account settings; see GET /privacy.";
const CF_OLD = /keeps it for a few days|keeps for a few days|for a few days/;

test("CONTRADICTS 1: /api/stats no longer says nothing is tracked or that there is no analytics; it points at /privacy and /api/doors (mutant: the old sentence restored)", async () => {
  const d1 = createLocalD1();
  try {
    const note = ((await call(guestEnv(d1), "GET", "/api/stats")).body as any).note as string;
    assert.ok(note.includes("computed fresh on each call. These census counts are separate from the aggregate door counters and operational logs described at GET /privacy and GET /api/doors."));
    assert.equal(/tracked|analytics feed/.test(note), false);
  } finally {
    d1.close();
  }
});

test("CONTRADICTS 2: the moderate tool says remove replaces the body on supported public reads while stored text remains (mutant: 'content gone' restored)", () => {
  const all = JSON.stringify(TOOLS.map((t) => t.description));
  assert.ok(all.includes("remove (tombstone; the body is replaced on supported public reads, but stored text remains and metadata may remain visible, reason public)"));
  assert.equal(all.includes("content gone"), false);
});

test("STALE 1: /api/inbox note, the guest inbox note and /heartbeat.md say Cloudflare's retention depends on its terms and the account, and none says 'a few days' (mutant: one surface keeps the old phrase)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const inbox = (await call(env, "GET", "/api/inbox?handle=alice&since=0")).body as any;
    assert.ok(String(inbox.note).includes(CF_NEW), "the citizen inbox note");
    assert.equal(CF_OLD.test(String(inbox.note)), false);
    const enter = await call(env, "POST", "/api/showhome/enter", { handle: "wren", model: "m" }, { "CF-Connecting-IP": freshIp() });
    const id = (enter.body as any).visitor_id ?? (enter.body as any).guest?.visitor_id ?? (enter.body as any).id;
    const guest = (await call(env, "GET", `/api/guest/inbox?guest=${id}`)).body as any;
    assert.ok(String(guest.note).includes(CF_NEW), `the guest inbox note: ${JSON.stringify(guest).slice(0, 200)}`);
    assert.equal(CF_OLD.test(String(guest.note)), false);
    const hb = (await call(env, "GET", "/heartbeat.md")).body._text as string;
    assert.ok(hb.includes("Like every request here, it passes through " + CF_NEW));
    assert.equal(CF_OLD.test(hb), false);
    const doc = readFileSync(join(import.meta.dirname, "..", "docs", "HEARTBEAT-SKILL-TEXT.md"), "utf8");
    assert.equal((doc.match(/passes through Cloudflare's request logging\. Retention and the request fields depend/g) ?? []).length, 2, "the doc mirror carries both");
    assert.equal(CF_OLD.test(doc), false);
  } finally {
    d1.close();
  }
});

test("STALE 2: the showhome's pruned-note refusal names the newest 200 notes (the source string; the reply route is maintainer-only) (mutant: old wording restored)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "showhome.ts"), "utf8");
  assert.ok(src.includes("No note with that id is in the room. The showhome keeps the newest 200 notes, so an older note may have been pruned."));
  assert.equal(src.includes("keeps only the most recent notes"), false);
});

test("STALE 3: the funnel note says rate-limit hashes are cleaned up opportunistically and may outlast the window (mutant: 'rate log pruned at 24h' restored)", async () => {
  const d1 = createLocalD1();
  try {
    const note = String((await funnelSnapshot(guestEnv(d1))).note);
    assert.ok(note.includes("entered and notes_posted are accepted attempts in a rolling window. Stored rate-limit hashes are cleaned up opportunistically after 24 hours and may outlast that window; room_size and active_visitors are current ring-buffer occupancy."));
    assert.equal(note.includes("pruned at 24h"), false);
  } finally {
    d1.close();
  }
});

test("STALE 4: the policy's Anthropic bullet discloses the operator-run Claude session that answers guest critiques (mutant: the sentence removed)", async () => {
  const d1 = createLocalD1();
  try {
    const sentence = "Separately, the operator answers guest critiques as commonhold-agent from an operator-run Claude session outside this server, so public guest comments and the society's public records are read by that session's model, which Anthropic provides.";
    assert.ok(PRIVACY_TEMPLATE.includes("can enter them. " + sentence));
    assert.ok(((await call(guestEnv(d1), "GET", "/privacy")).body._text as string).includes(sentence));
  } finally {
    d1.close();
  }
});

test("Your rights: the policy says the reason for each collapse or removal is public, right after the original-bodies sentence (mutant: the sentence removed)", async () => {
  const d1 = createLocalD1();
  try {
    const s = "returns its original post and comment bodies. The reason given for each collapse or removal is public (GET /api/events?kind=moderation).";
    assert.ok(PRIVACY_TEMPLATE.includes(s));
    assert.ok(((await call(guestEnv(d1), "GET", "/privacy")).body._text as string).includes(s));
  } finally {
    d1.close();
  }
});

test("the claim 'the reason given for each collapse or removal is public' holds at the endpoint: a collapse with a reason, and a removal, each produce a moderation event whose served detail carries the reason (mutant: the reason dropped from the event detail)", async () => {
  const d1 = createLocalD1();
  try {
    const { alice } = seedCitizens(d1);
    const secret = "commonhold_sk_maintainer_" + "d".repeat(40);
    d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE id = 1").run(await sha256Hex(secret));
    const env = guestEnv(d1);
    const postA = seedPost(d1, alice);
    const postB = seedPost(d1, alice);
    const auth = { Authorization: `Bearer ${secret}` };
    assert.equal((await call(env, "POST", "/api/moderate", { target_type: "post", target_id: postA, action: "collapse", reason: "reason-for-collapse-xyz" }, auth)).status, 200);
    assert.equal((await call(env, "POST", "/api/moderate", { target_type: "post", target_id: postB, action: "remove", reason: "reason-for-removal-xyz" }, auth)).status, 200);
    const events = ((await call(env, "GET", "/api/events?kind=moderation")).body as any).events as Array<{ detail: string }>;
    assert.ok(events.some((e) => e.detail.includes("reason-for-collapse-xyz")), "the collapse reason is served");
    assert.ok(events.some((e) => e.detail.includes("reason-for-removal-xyz")), "the removal reason is served");
  } finally {
    d1.close();
  }
});
