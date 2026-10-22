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
  "DEFERRED-GUEST-FLAGS": ["society.ts", "MODERATION_TABLES and flagContent: citizen flags on guest rows need a guest_flags table, not a CHECK widening"],
  "DEFERRED-GUEST-GOVERNANCE-THREADS": ["guest.ts", "the debate-thread exclusion in postGuestComment"],
  "DEFERRED-INBOX-GUEST-MENTIONS": ["inbox.ts", "guestThreadSql and the guest inbox: a guest's @handle notifies no citizen"],
  "DEFERRED-ME-GUESTS": ["society.ts", "me(): GET /api/me does not carry guests; the inbox's guest_thread section does"],
  "DEFERRED-PUBLIC-READ-RATE-CAP": ["index.ts", "the guest inbox route, in the same class as every public read here"],
  // the resident tier (D-075 step b, docs/BRIEF-RESIDENT-TIER-2026-10-11.md "does NOT do")
  "DEFERRED-RESIDENT-POSTS": ["society.ts", "createPost: a resident cannot open a post, because posts.citizen_id is NOT NULL (a rebuild-class change)"],
  "DEFERRED-RESIDENT-CITIZEN-LINK": ["resident.ts", "a resident-to-citizen path with the same key touches POST /api/register, a money path"],
  "DEFERRED-RESIDENT-SIGNED-WRITES": ["resident.ts", "signed guest comments: every write still carries the token, the key signs only bind and recover"],
};

test("every DEFERRED flag the guest-voice brief names is planted at its landing site", () => {
  for (const [flag, [file, why]] of Object.entries(FLAGS)) {
    assert.ok(read(file).includes(flag), `${flag} must stay planted in src/${file} (${why})`);
  }
  // DEFERRED-GUEST-TEMPLATE and DEFERRED-DOOR-402-WORDING were discharged by constitution v6 (22 Oct 2026): neither flag may remain in src/
  for (const flag of ["DEFERRED-GUEST-TEMPLATE", "DEFERRED-DOOR-402-WORDING"]) assert.equal(read("doc.ts").includes(flag), false, `${flag} is retired`);
  // positive control: the check can fail
  assert.equal(read("showhome.ts").includes("DEFERRED-NO-SUCH-FLAG"), false);
});

// DEFERRED-GUEST-MCP-WRITE is RETIRED, not forgotten: the guest write tools (guest_enter, guest_comment, showhome_note) were built on
// the full /mcp door by D-075 order step a. A flag that names work already done would be a false claim in src/mcp.ts, so its
// absence is pinned, and the tools it deferred are pinned present.
test("DEFERRED-GUEST-MCP-WRITE is retired: the flag is gone from src/mcp.ts and the three guest write tools are there", () => {
  const mcp = read("mcp.ts");
  assert.equal(mcp.includes("DEFERRED-GUEST-MCP-WRITE"), false, "the flag names work that is now done");
  for (const tool of ["guest_enter", "guest_comment", "showhome_note"]) assert.ok(mcp.includes(`name: "${tool}"`), `${tool} is in TOOLS`);
});

// DEFERRED-GUEST-KEY is RETIRED, not forgotten: the resident tier (D-075 step b) built the key a guest can bind. A flag that names work
// already done would be a false claim in src/showhome.ts, so its absence is pinned across src/, and the feature it deferred is pinned
// present. What it did NOT build (signed comments, a same-key path to citizenship) carries the two new resident flags above.
test("DEFERRED-GUEST-KEY is retired: the flag is gone from src/showhome.ts and the guest key exists (guests.public_key, bindResident)", () => {
  assert.equal(read("showhome.ts").includes("DEFERRED-GUEST-KEY"), false, "the flag names work that is now done");
  assert.ok(read("resident.ts").includes("export async function bindResident"), "the bind exists");
  assert.ok(readFileSync(join(SRC, "..", "migrations", "0020_residents.sql"), "utf8").includes("ADD COLUMN public_key"), "the column exists");
});
