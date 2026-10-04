// Every DEFERRED flag docs/BRIEF-GUEST-VOICE.md names is planted, grep-able, at the place where the deferred work would land
// (flag-deferred-items): out-of-scope work with no flag at its landing site is forgotten work. A flag removed from its site
// fails this test, so a deferral cannot quietly evaporate.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

// flag -> [the file where the work would land, why that site]
const FLAGS: Record<string, [string, string]> = {
  "DEFERRED-GUEST-KEY": ["showhome.ts", "authenticateGuest, the guest authenticator: signed-key guests (G1 option C)"],
  "DEFERRED-GUEST-MCP-WRITE": ["mcp.ts", "beside the guest read tools: a guest write over /mcp would cross the showhome's no-escalation invariant"],
  "DEFERRED-GUEST-FLAGS": ["society.ts", "MODERATION_TABLES and flagContent: citizen flags on guest rows need a guest_flags table, not a CHECK widening"],
  "DEFERRED-GUEST-GOVERNANCE-THREADS": ["guest.ts", "the debate-thread exclusion in postGuestComment"],
  "DEFERRED-INBOX-GUEST-MENTIONS": ["inbox.ts", "guestThreadSql and the guest inbox: a guest's @handle notifies no citizen"],
  "DEFERRED-ME-GUESTS": ["society.ts", "me(): GET /api/me does not carry guests; the inbox's guest_thread section does"],
  "DEFERRED-GUEST-TEMPLATE": ["doc.ts", "beside DEFERRED-DOOR-402-WORDING: the v6 wording for the four sentences untrue of a guest"],
  "DEFERRED-PUBLIC-READ-RATE-CAP": ["index.ts", "the guest inbox route, in the same class as every public read here"],
};

test("every DEFERRED flag the guest-voice brief names is planted at its landing site", () => {
  for (const [flag, [file, why]] of Object.entries(FLAGS)) {
    assert.ok(read(file).includes(flag), `${flag} must stay planted in src/${file} (${why})`);
  }
  // the template flag sits beside its sibling, outside the template string
  const doc = read("doc.ts");
  assert.ok(Math.abs(doc.indexOf("DEFERRED-GUEST-TEMPLATE") - doc.indexOf("DEFERRED-DOOR-402-WORDING")) < 6000, "DEFERRED-GUEST-TEMPLATE is beside DEFERRED-DOOR-402-WORDING");
  assert.ok(doc.indexOf("DEFERRED-GUEST-TEMPLATE") < doc.indexOf("export const FRONT_DOOR_TEMPLATE"), "and above the template, never inside it");
  // positive control: the check can fail
  assert.equal(read("showhome.ts").includes("DEFERRED-NO-SUCH-FLAG"), false);
});
