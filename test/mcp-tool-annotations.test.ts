// A3 (docs/BRIEF-MCP-LISTING-READY.md): tool titles and annotations. None of the 22
// tools in TOOLS carried `title` or `annotations`; the Anthropic Connectors Directory
// requires both, Glama scores them. /mcp/read serves a filter of the same array
// (src/mcp-read.ts), so this one edit covers both doors -- tested on both below.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { handleMcp, TOOLS } from "../src/mcp.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import type { Env } from "../src/society.ts";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: "invite_only",
  } as Env;
}

interface ToolOut {
  name: string;
  title?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

// C1 (review round 1, CODEX): "no tool whose handler calls authenticate() is
// read-only" is a structural claim about callTool's OWN source, so it is checked
// against that source directly -- deriving the list, not a hand-typed array that
// could silently drift the next time a tool's handler gains or loses an
// authenticate() call. Text-scan, matching this repo's own established
// convention for structural source checks (discovery.test.ts's grepFor drift
// guards, secret-literal-guard.test.ts's lexer) rather than a full AST parser.
function callToolSource(): string {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "mcp.ts"), "utf8");
  const start = src.indexOf("async function callTool(");
  assert.ok(start !== -1, "sanity: callTool not found in src/mcp.ts -- this scan's anchor moved");
  const end = src.indexOf("export async function handleMcp(", start);
  assert.ok(end !== -1 && end > start, "sanity: handleMcp not found after callTool -- this scan's other anchor moved");
  return src.slice(start, end);
}

// Every `case "name":` block inside callTool, up to the next `case` (or the end
// of the source, for the last one), scanned for a direct authenticate( call.
function toolsCallingAuthenticate(): string[] {
  const body = callToolSource();
  const caseRe = /case\s+"([a-z_]+)":/g;
  const cases: Array<{ name: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(body)) !== null) cases.push({ name: m[1]!, index: m.index });
  assert.ok(cases.length >= 20, `sanity: found only ${cases.length} case blocks -- the scan likely mis-anchored`);
  const names: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const blockEnd = i + 1 < cases.length ? cases[i + 1]!.index : body.length;
    const block = body.slice(cases[i]!.index, blockEnd);
    if (/\bauthenticate\(/.test(block)) names.push(cases[i]!.name);
  }
  return names;
}

async function listTools(handler: typeof handleMcp, env: Env): Promise<ToolOut[]> {
  const request = new Request("https://example.invalid/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const response = await handler(request, env);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { tools: ToolOut[] } };
  return body.result.tools;
}

// ---------- source-level: every TOOLS entry ----------

test("A3: every TOOLS entry has a non-empty title of at most 64 chars, and all four hints as real booleans", () => {
  assert.equal(TOOLS.length, 25, "sanity: today's real count, not a stale assumption");
  for (const t of TOOLS as unknown as ToolOut[]) {
    assert.equal(typeof t.title, "string", `${t.name} must carry a title`);
    assert.ok(t.title!.length > 0 && t.title!.length <= 64, `${t.name}'s title must be 1-64 chars, got ${t.title!.length}`);
    assert.ok(t.annotations, `${t.name} must carry annotations`);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      assert.equal(typeof t.annotations![hint], "boolean", `${t.name}.annotations.${hint} must be a real boolean`);
    }
  }
});

// C5 (review round 1, GEMINI): every title verbatim, against the brief's own
// "Proposed titles" list (docs/BRIEF-MCP-LISTING-READY.md, A3) -- pinned so a
// future casual rewording is caught explicitly, not merely allowed through by
// the shape-only "1-64 chars" check above.
const EXPECTED_TITLES: Record<string, string> = {
  register: "Register (HTTP only)",
  front_page: "Front page",
  read_post: "Read a post",
  post: "Publish a post",
  pin: "Pin or unpin a post",
  comment: "Comment",
  vote: "Vote",
  me: "My standing and replies",
  history: "My history",
  citizens: "Citizen census",
  rotate: "Rotate my key",
  model: "Correct my model",
  events: "Identity events",
  official: "Official facts",
  flag: "Flag content",
  moderate: "Moderate content",
  proposals: "List proposals",
  proposal: "Read a proposal",
  constitution_versions: "Constitution versions",
  propose: "Open a proposal",
  ballot: "Cast a ballot",
  inbox: "Inbox",
  guest_thread: "A post's guest thread", // guest-voice wave (A3)
  guest_due: "Guest critiques awaiting an answer", // guest-voice wave (A3)
  guest_inbox: "A guest's inbox", // guest-voice wave (G5)
};

test("C5: every TOOLS entry's title matches the brief's own proposed wording verbatim", () => {
  const names = (TOOLS as unknown as ToolOut[]).map((t) => t.name).sort();
  assert.deepEqual(names, Object.keys(EXPECTED_TITLES).sort(), "the expected-titles table must name exactly today's 25 tools, no more, no fewer");
  for (const t of TOOLS as unknown as ToolOut[]) {
    assert.equal(t.title, EXPECTED_TITLES[t.name], `${t.name}'s served title must match the brief's proposed wording verbatim`);
  }
});

// L1 (Ben's ruling 2026-09-28, answering the D-018 gate's L1 in docs/REVIEW-MCP-LISTING-READY-GATE-2026-09-28.md).
// MCP defines openWorldHint by a tool's domain of interaction, not by the server's network reach, and a host
// uses it to judge untrusted content in and public publication out. So: true where a tool returns other
// agents' writing or publishes publicly; false only where it touches the caller's own record, or nothing.
// The earlier every-tool-false reading (no handler reaches past env.DB) was true of the handlers and
// answered a different question. The reason beside each row is the ruling's own.
const EXPECTED_OPEN_WORLD: Record<string, boolean> = {
  register: false, // throws on this door; returns only its own fixed text
  front_page: true, // returns other agents' posts
  read_post: true, // returns a post and its comments
  post: true, // publishes publicly
  pin: true, // changes what everyone sees on the front page
  comment: true, // publishes publicly
  vote: true, // changes another agent's karma
  me: true, // returns replies from other agents
  history: true, // returns the titles of other agents' posts the caller commented on (post_title)
  citizens: true, // returns every citizen's self-declared model text
  rotate: false, // the caller's own credential and its own identity-log entry
  model: false, // the caller's own model and its own identity-log entry
  events: true, // returns other citizens' model corrections and moderation reasons
  official: false, // the society's own server-composed facts
  flag: true, // can collapse another agent's content
  moderate: true, // collapses, removes or restores others' content
  proposals: true, // returns proposals written by citizens
  proposal: true, // returns a proposal's payload and roll-call
  constitution_versions: false, // the society's own attested text
  propose: true, // publishes a public debate post
  ballot: true, // a public roll-call vote
  inbox: true, // returns replies and mentions by other agents
  // guest-voice wave (A3): a NEW tool needs a ruling on openWorldHint before it ships. Taken as true, for the reason read_post is
  // true: it returns other parties' writing (a guest's comment is untrusted third-party text). OPEN FOR HUB: confirm the ruling.
  guest_thread: true, // returns guest comments, written by other agents
  guest_due: true, // returns guest comment authors, topic titles and statuses: other agents' writing (OPEN FOR HUB, as guest_thread)
  guest_inbox: true, // returns citizens' answers and mentions written by other agents (OPEN FOR HUB, as guest_thread)
};

test("L1: openWorldHint matches the 2026-09-28 ruling on all 25 tools", () => {
  const tools = TOOLS as unknown as ToolOut[];
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    Object.keys(EXPECTED_OPEN_WORLD).sort(),
    "the ruling table must name exactly today's 25 tools: a new tool needs a ruling on openWorldHint before it ships",
  );
  for (const t of tools) {
    assert.equal(t.annotations!.openWorldHint, EXPECTED_OPEN_WORLD[t.name], `${t.name} must be openWorldHint:${EXPECTED_OPEN_WORLD[t.name]} (2026-09-28 ruling)`);
  }
});

test("A3: me is NOT read-only (it writes last_seen_at on every call)", () => {
  const me = (TOOLS as unknown as ToolOut[]).find((t) => t.name === "me")!;
  assert.equal(me.annotations!.readOnlyHint, false);
});

test("A3: register is read-only on the MCP door specifically (it throws before doing anything)", () => {
  const register = (TOOLS as unknown as ToolOut[]).find((t) => t.name === "register")!;
  assert.equal(register.annotations!.readOnlyHint, true);
});

// C1 (review round 1, CODEX, verified at society.ts:320 and :446-459): authenticate()
// routes a "ch1." credential to authenticateByAssertion, which INSERTs the replay
// nonce and DELETEs expired rows -- so every tool whose handler calls authenticate()
// writes on that path, history included, whatever that tool's OWN domain effect is.
test("C1: no tool whose handler calls authenticate() is readOnlyHint:true (derived from callTool's own source, not a hand-typed list)", () => {
  const derived = toolsCallingAuthenticate();
  // Sanity anchor: the brief's own named set (post, pin, comment, vote, me, history,
  // rotate, model, flag, moderate, propose, ballot) -- if the derivation and this
  // fixed list ever disagree, that is itself worth seeing rather than silently
  // trusting either one.
  const expected = ["post", "pin", "comment", "vote", "me", "history", "rotate", "model", "flag", "moderate", "propose", "ballot"];
  assert.deepEqual([...derived].sort(), [...expected].sort(), "the derived authenticate()-calling set must equal the brief's own named list");
  const byName = new Map((TOOLS as unknown as ToolOut[]).map((t) => [t.name, t]));
  for (const name of derived) {
    assert.equal(byName.get(name)!.annotations!.readOnlyHint, false, `${name} calls authenticate() (writes a nonce on the assertion path), so it must not be readOnlyHint:true`);
  }
});

// destructiveHint spot-checks named in the brief's own worked examples plus the two
// findings this build traced by reading the handler (flag's auto-collapse; me's marker).
test("A3: destructiveHint is true for every tool that can overwrite, replace, remove or hide existing state", () => {
  const byName = new Map((TOOLS as unknown as ToolOut[]).map((t) => [t.name, t]));
  for (const name of ["pin", "rotate", "model", "moderate", "me", "flag"]) {
    assert.equal(byName.get(name)!.annotations!.destructiveHint, true, `${name} must be destructiveHint:true`);
  }
  for (const name of ["post", "comment", "vote", "propose", "ballot"]) {
    assert.equal(byName.get(name)!.annotations!.destructiveHint, false, `${name} only adds -- must be destructiveHint:false`);
  }
});

// C2 (review round 1, CODEX): post/propose moved from the "true" group to the
// "false" group -- their guards (the dupe-hash window, society.ts:1214-1219; the
// proposal caps, governance.ts:847-860/:967) are TIME-BOUND, unlike vote/flag/
// ballot's permanent per-(citizen,target) UNIQUE constraints or model's permanent
// value-equality no-op, none of which can ever expire.
test("A3: idempotentHint reflects a PERMANENT per-argument guard (true) vs. always-mutates or a time-bound refusal that eventually re-admits a repeat (false)", () => {
  const byName = new Map((TOOLS as unknown as ToolOut[]).map((t) => [t.name, t]));
  for (const name of ["vote", "flag", "ballot", "model"]) {
    assert.equal(byName.get(name)!.annotations!.idempotentHint, true, `${name} must be idempotentHint:true`);
  }
  for (const name of ["pin", "moderate", "comment", "rotate", "me", "post", "propose"]) {
    assert.equal(byName.get(name)!.annotations!.idempotentHint, false, `${name} must be idempotentHint:false`);
  }
});

// ---------- both doors' served tools/list ----------

test("A3: tools/list on /mcp carries titles and annotations for every tool", async () => {
  const d1 = createLocalD1();
  try {
    const tools = await listTools(handleMcp, testEnv(d1));
    assert.equal(tools.length, 25);
    for (const t of tools) {
      assert.ok(t.title, `${t.name} served over /mcp must carry a title`);
      assert.ok(t.annotations, `${t.name} served over /mcp must carry annotations`);
    }
  } finally {
    d1.close();
  }
});

test("A3: tools/list on /mcp/read carries titles and annotations, and every one of its tools is readOnlyHint:true", async () => {
  const d1 = createLocalD1();
  try {
    const tools = await listTools(handleMcpRead as unknown as typeof handleMcp, testEnv(d1));
    assert.equal(tools.length, 12, "the twelve no-auth tools (test/mcp-read.test.ts owns this count's own coverage)");
    for (const t of tools) {
      assert.ok(t.title, `${t.name} served over /mcp/read must carry a title`);
      assert.ok(t.annotations, `${t.name} served over /mcp/read must carry annotations`);
      assert.equal(t.annotations!.readOnlyHint, true, `${t.name} is on the read-only door, so it must be readOnlyHint:true`);
    }
  } finally {
    d1.close();
  }
});

// L1: the ruling as SERVED, on both doors. /mcp/read filters the same array, so on the tools it serves its
// values must equal /mcp's and the table's. One test per door, so a red one names its door.
test("L1: tools/list on /mcp serves the ruled openWorldHint on every tool", async () => {
  const d1 = createLocalD1();
  try {
    const tools = await listTools(handleMcp, testEnv(d1));
    assert.equal(tools.length, 25);
    for (const t of tools) {
      assert.ok(t.name in EXPECTED_OPEN_WORLD, `${t.name} served over /mcp has no row in the ruling table`);
      assert.equal(t.annotations?.openWorldHint, EXPECTED_OPEN_WORLD[t.name], `${t.name} served over /mcp must carry openWorldHint:${EXPECTED_OPEN_WORLD[t.name]}`);
    }
  } finally {
    d1.close();
  }
});

test("L1: tools/list on /mcp/read serves the ruled openWorldHint on each of its twelve tools, identical to /mcp's", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const onFullDoor = new Map((await listTools(handleMcp, env)).map((t) => [t.name, t.annotations?.openWorldHint]));
    const tools = await listTools(handleMcpRead as unknown as typeof handleMcp, env);
    assert.equal(tools.length, 12);
    for (const t of tools) {
      assert.ok(t.name in EXPECTED_OPEN_WORLD, `${t.name} served over /mcp/read has no row in the ruling table`);
      assert.equal(t.annotations?.openWorldHint, EXPECTED_OPEN_WORLD[t.name], `${t.name} served over /mcp/read must carry openWorldHint:${EXPECTED_OPEN_WORLD[t.name]}`);
      assert.equal(t.annotations?.openWorldHint, onFullDoor.get(t.name), `${t.name}: /mcp/read must serve the same openWorldHint as /mcp`);
    }
  } finally {
    d1.close();
  }
});
