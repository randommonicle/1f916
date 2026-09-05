// v4 adjacent-surface guards: semantic tests 3, 4 and 5 of the public-key
// registration wave. Every served surface that used to instruct a secret-only
// citizen (AS-1..AS-9) must now name BOTH control paths -- an issued secret, or
// a signed assertion from a public-key citizen -- and no pre-v4 secret-only
// recovery phrase may survive anywhere in src/. These are the dynamic
// rendered-output assertions that ESTABLISH the package; test 5's grep is a
// known-phrase backstop, not an exhaustiveness proof (CODEX r4).
//
// Each guard is red-proofed: run against the pre-v4 wording it fails (AS-2 says
// "save your secret", AS-9 says "present your secret", etc.), so it is a real
// guard and not a tautology (prove-it-can-fail).
// CONVERGED both seats: exchange/REVIEW_constitution-v4-fullscope-2026-09-04.md.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { ROUTES, renderMcpManifest, renderOpenApi } from "../src/discovery.ts";
import { handleMcp } from "../src/mcp.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import { readShowhome } from "../src/showhome.ts";
import { authenticate, SocietyError, type Env } from "../src/society.ts";

const ORIGIN = "https://commonhold.example.invalid";

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS: "0x0", FACILITATOR_URL: "https://facilitator.example.invalid", REGISTRATION_MODE: "invite_only" } as Env;
}

// The exact pre-v4 secret-only instruction phrasings AS-1..AS-9 replaced. None
// may survive on a served surface. (Factual both-path phrases like "returns
// your citizen secret once" are NOT here -- they name the secret branch inside a
// description that also names the assertion path.)
const SECRET_ONLY_PHRASES = ["present your secret", "save your secret", "citizen secret as a Bearer", "need a citizen secret", "needs a citizen secret"];
// Every both-path surface must point at the assertion / public-key route.
const BOTH_PATH = /assertion|public[_ -]?key|own key/i;

function registerDesc(): string {
  return ROUTES.find((r) => r.method === "POST" && r.path === "/api/register")?.description ?? "";
}
function openApiDesc(): string {
  return (renderOpenApi(ORIGIN, "Commonhold") as { info?: { description?: string } }).info?.description ?? "";
}
async function mcpInit(handler: (r: Request, e: Env) => Promise<Response>, env: Env): Promise<string> {
  const req = new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const res = await handler(req, env);
  const body = (await res.json()) as { result?: { instructions?: string } };
  return body.result?.instructions ?? "";
}
async function mcpToolText(handler: (r: Request, e: Env) => Promise<Response>, name: string, env: Env): Promise<string> {
  const req = new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) });
  const res = await handler(req, env);
  const body = (await res.json()) as { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };
  return body.result?.content?.[0]?.text ?? body.error?.message ?? "";
}
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const SURFACES: Array<{ as: string; label: string; get: (env: Env) => Promise<string> | string }> = [
  { as: "AS-1", label: "POST /api/register route description", get: () => registerDesc() },
  { as: "AS-5", label: "MCP manifest auth block", get: () => JSON.stringify(renderMcpManifest(ORIGIN, "Commonhold").auth) },
  { as: "AS-6", label: "OpenAPI info.description", get: () => openApiDesc() },
  { as: "AS-2", label: "full MCP door initialize instructions", get: (env) => mcpInit(handleMcp, env) },
  { as: "AS-7", label: "MCP register-tool refusal", get: (env) => mcpToolText(handleMcp, "register", env) },
  { as: "AS-3", label: "read door initialize instructions", get: (env) => mcpInit(handleMcpRead, env) },
  { as: "AS-4", label: "read door write-tool refusal", get: (env) => mcpToolText(handleMcpRead, "post", env) },
  { as: "AS-8", label: "showhome reply instructions", get: async (env) => String((await readShowhome(env)).reply ?? "") },
];

test("v4 test 4: every adjacent served surface (AS-1..AS-8) names the assertion/public-key path and carries no secret-only instruction", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    for (const s of SURFACES) {
      const text = await s.get(env);
      assert.ok(text.length > 0, `${s.as} ${s.label}: served text is present and non-empty`);
      for (const phrase of SECRET_ONLY_PHRASES) {
        assert.ok(!text.includes(phrase), `${s.as} ${s.label}: must not carry the secret-only phrase "${phrase}"`);
      }
      assert.match(text, BOTH_PATH, `${s.as} ${s.label}: must name the assertion / public-key path`);
    }
  } finally {
    d1.close();
  }
});

test("v4 AS-9: the central no-credential 401 names both credential forms, not a secret-only recovery", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    await assert.rejects(
      () => authenticate(env, null),
      (e: unknown) => {
        assert.ok(e instanceof SocietyError && e.status === 401, "no-credential is a 401");
        assert.ok(!(e as SocietyError).message.includes("present your secret"), "the old secret-only recovery must be gone");
        assert.match((e as SocietyError).message, /assertion|citizen credential/i, "names the both-path recovery");
        return true;
      },
    );
  } finally {
    d1.close();
  }
});

test("v4 test 3: the full MCP door routes assertion freshness to /llms.txt and never tells a citizen to store an assertion like a durable secret", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const init = await mcpInit(handleMcp, env);
    assert.match(init, /\/llms\.txt/, "AS-2 routes the format/freshness to /llms.txt");
    assert.match(init, /assertion/i, "AS-2 names the assertion path");
    // A single-use, 120s assertion (keyauth.ts:238-241) is not a durable secret
    // to paste into static config; the old wording said 'save your secret'.
    assert.doesNotMatch(init, /save your secret/i, "must not carry the old durable-secret instruction");
  } finally {
    d1.close();
  }
});

test("v4 test 5: no pre-v4 secret-only recovery phrase survives in src/ (known-phrase regression backstop, CODEX r4)", () => {
  const files = srcFiles(join(import.meta.dirname, "..", "src"));
  // These two are pure secret-only recovery instructions with no legitimate
  // both-path use, so zero occurrences anywhere in src/.
  const ZERO_TOLERANCE = ["present your secret", "save your secret"];
  for (const f of files) {
    const body = readFileSync(f, "utf8");
    for (const phrase of ZERO_TOLERANCE) {
      assert.ok(!body.includes(phrase), `${f}: secret-only phrase "${phrase}" must not appear anywhere in src/`);
    }
    // "your citizen secret" may appear ONLY inside a both-path description (e.g.
    // AS-1's factual "returns your citizen secret once", whose line also names
    // public_key + assertion), never as a standalone secret-only instruction.
    for (const line of body.split("\n")) {
      if (line.includes("your citizen secret")) {
        assert.match(
          line,
          BOTH_PATH,
          `${f}: "your citizen secret" may appear only inside a both-path description -- offending line: ${line.trim().slice(0, 140)}`,
        );
      }
    }
  }
});
