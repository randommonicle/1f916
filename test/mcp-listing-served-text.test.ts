// A5 (docs/BRIEF-MCP-LISTING-READY.md): served-text corrections. The recon
// (drafts/RECRUIT-CHANNELS-RECON-2026-09-27.md, gap 1) found "the first request
// answers 402" was only true of a request that had already passed
// register-gate.ts's free, pre-payment checks (handle/model/public_key shape,
// handle-taken, the hourly registration limit) -- a bare POST answers 400. Three
// served surfaces said the old, narrower thing; this fixes /skill.md and /llms.txt
// (their own doc-fidelity/rendering tests, updated in the same commit, already cover
// (a) and (b) in depth) and adds mode-awareness to the /mcp `register` tool's
// refusal (c), which no existing test pinned. FRONT_DOOR_TEMPLATE is deliberately
// UNCHANGED (d) -- test/doc.test.ts's golden page and topics-d1.test.ts's v5 hash
// pin already prove that by staying green; this file does not re-prove it.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { handleMcp, TOOLS } from "../src/mcp.ts";
import { renderLlmsTxt, type LlmsTxtFacts } from "../src/discovery.ts";
import { JOIN_INVITE_ONLY } from "../src/doc.ts";
import type { Env } from "../src/society.ts";

function testEnv(d1: LocalD1, registrationMode: string): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: registrationMode,
  } as Env;
}

async function registerToolError(env: Env): Promise<string> {
  const request = new Request("https://example.invalid/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register", arguments: { handle: "x", model: "y" } } }),
  });
  const response = await handleMcp(request, env);
  assert.equal(response.status, 200, "tools/call always answers 200 at the transport level, refusal rides isError");
  const body = (await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  assert.equal(body.result.isError, true, "register must still be refused over MCP");
  const parsed = JSON.parse(body.result.content[0].text) as { error: string };
  return parsed.error;
}

function baseFacts(overrides: Partial<LlmsTxtFacts> = {}): LlmsTxtFacts {
  return {
    origin: "https://commonhold.example.invalid",
    society: "Commonhold",
    registrationMode: "open",
    controlFloorPercent: 51,
    composition: { citizens: 5, operator_controlled: 4, independent: 1, operator_controlled_percent: 80 },
    ...overrides,
  };
}

// ---------- A5(c): the /mcp register tool ----------

test("A5(c): the register tool's static description names the checks-run-first flow, per-HTTP not per-invite-code", () => {
  const register = TOOLS.find((t) => t.name === "register")!;
  assert.match(register.description, /\$1 x402 payment over HTTP/);
  // Gate C2 (docs/REVIEW-MCP-LISTING-READY-GATE-2026-09-28.md): "MCP has no channel to carry one" is false of
  // MCP (x402 publishes an MCP transport, payment in _meta["x402/payment"]). What is true is that THIS door
  // carries none; the thrown message below already says "this MCP tool cannot carry". Absence first, so a run
  // against the old string is seen red on it.
  assert.doesNotMatch(register.description, /MCP has no channel/, "the description must not claim a fact about MCP as a whole: only this door lacks an x402 channel");
  assert.match(register.description, /this MCP door cannot carry one/);
  assert.doesNotMatch(register.description, /invite code/i, "the description no longer conditions itself on the invite-only phase");
});

test("A5(c): the register tool's thrown message is mode-aware -- open mode carries no invite_code sentence", async () => {
  const d1 = createLocalD1();
  try {
    const err = await registerToolError(testEnv(d1, "open"));
    assert.match(err, /\$1 x402 payment, which this MCP tool cannot carry/);
    assert.match(err, /issued no secret/);
    assert.match(err, /public_key/);
    assert.doesNotMatch(err, /invite-only/, "open mode must not carry the invite-only sentence");
    assert.doesNotMatch(err, /invite_code/, "open mode must not mention invite_code at all");
  } finally {
    d1.close();
  }
});

test("A5(c): the register tool's thrown message is mode-aware -- invite_only mode appends the invite_code sentence, base text unchanged", async () => {
  const d1 = createLocalD1();
  try {
    const openErr = await registerToolError(testEnv(d1, "open"));
    const inviteErr = await registerToolError(testEnv(d1, "invite_only"));
    assert.ok(inviteErr.startsWith(openErr), "invite_only must be the open-mode text with a sentence appended, not a rewritten message");
    assert.equal(inviteErr, openErr + " While registration is invite-only, the body also needs invite_code.");
  } finally {
    d1.close();
  }
});

test("A5(c): neither mode's thrown message resurrects the old two-things-one-channel phrasing", async () => {
  const d1 = createLocalD1();
  try {
    for (const mode of ["open", "invite_only"]) {
      const err = await registerToolError(testEnv(d1, mode));
      assert.doesNotMatch(err, /plus an invite code while the door is invite-gated; this MCP tool cannot carry either/, `${mode}: the old undifferentiated wording must be gone`);
    }
  } finally {
    d1.close();
  }
});

// ---------- A5(b): llms.txt's write section ----------

test("A5(b): llms.txt's register write-up discloses the free pre-payment checks and refuses-first wording, both registration modes", () => {
  for (const registrationMode of ["open", "invite_only"] as const) {
    const out = renderLlmsTxt(baseFacts({ registrationMode }));
    // \s+ (not a literal space) between each wrapped phrase's words: the template
    // literal line-wraps this sentence across several lines, so two adjacent words
    // can be joined by a newline rather than a space, exactly as the surrounding
    // surface already wraps neighbouring sentences.
    assert.match(out, /a request that passes its checks\s+returns 402/, `${registrationMode}: must carry the new checks-first framing`);
    assert.match(out, /handle, model or\s+public_key is malformed/, `${registrationMode}: must name the free checks`);
    assert.match(out, /an hourly registration\s+limit has been reached/, `${registrationMode}: must name the throttle`);
    assert.match(out, /refused first, for free/, `${registrationMode}: must state the checks cost nothing`);
    assert.doesNotMatch(
      out,
      /^The first request returns 402 with signed-payment requirements; pay with any\nx402 client and retry with the X-PAYMENT header\./m,
      `${registrationMode}: the old, narrower sentence must be gone`,
    );
  }
});

test("A5(b): the corrected sentence sits in the Write section, immediately followed by join.transition with no accidental blank line", () => {
  const invite = renderLlmsTxt(baseFacts({ registrationMode: "invite_only" }));
  const writeSection = invite.split("## Write (citizen credential)")[1]!.split("## Honesty")[0]!;
  assert.match(writeSection, /a request that passes its checks\s+returns 402/);
  // ${join.transition} (doc.ts JOIN_INVITE_ONLY.transition, " Once open registration
  // starts, the\ninvite_code requirement lifts; the payment does not.") must abut
  // "header." directly -- the interpolation point the corrected sentence now ends on.
  assert.ok(
    writeSection.includes("header." + JOIN_INVITE_ONLY.transition),
    "join.transition must directly follow the corrected sentence's final word, with no blank line inserted",
  );
});
