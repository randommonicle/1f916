// The two doors of the council flag (DEFERRED-COUNCIL-FLAG-INTENT, F4): POST /api/council/motion/:id/flag and the MCP council_flag tool call the SAME function, so the same inputs
// give the same answer on both. Real local D1, the real router and the real MCP dispatch. Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { councilCast, openMotion, flagMotion, motionRow, rows, freshIp, bearerHeader, withIp, call, citizenAssertion, signResidentFlag } from "./helpers/council.ts";
import { handleMcp } from "../src/mcp.ts";
import { buildIntentBinding } from "../src/keyauth.ts";
import type { Env } from "../src/society.ts";

async function mcpFlag(env: Env, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ isError: boolean; data: any }> {
  const res = await handleMcp(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": freshIp(), ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "council_flag", arguments: args } }),
    }),
    env,
  );
  const result = ((await res.json()) as any).result;
  return { isError: result.isError === true, data: JSON.parse(result.content[0].text) };
}
const flagged = (d1: any, id: number) => motionRow(d1, id).operator_flagged_at !== null;

test("parity: the same refused inputs give the same message over REST and MCP, for every member kind (token only, nothing, unbound key assertion, a bound assertion for another motion, a resident assertion for another motion), and write nothing (mutants: the MCP dispatch passes token instead of number and assertion; the MCP dispatch drops the credential)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Parity refused")).body.id as number;
    const other = (await openMotion(c.env, c.key, "statement", "Other")).body.id as number;
    const url = `/api/council/motion/${m}/flag`;
    const cases: Array<[string, Record<string, unknown>, Record<string, string>]> = [
      ["a resident token", { token: c.wren.token }, {}],
      ["nothing at all", {}, {}],
      ["a number without an assertion", { number: c.wren.number }, {}],
      ["a resident assertion for another motion", { number: c.wren.number, assertion: (await signResidentFlag(c.wren, other)).assertion }, {}],
      ["a resident assertion with another resident's number", { number: c.wren.number + 1, assertion: (await signResidentFlag(c.wren, m)).assertion }, {}],
    ];
    for (const [name, args, headers] of cases) {
      const rest = await call(c.env, "POST", url, args, { ...withIp(), ...headers });
      const mcp = await mcpFlag(c.env, { motion_id: m, ...args }, headers);
      assert.ok(rest.status >= 400, `${name}: REST ${rest.status}`);
      assert.equal(mcp.isError, true, `${name}: MCP`);
      assert.equal(mcp.data.error, rest.body.error, name);
    }
    // a key citizen: an unbound assertion (REST in Authorization; MCP as the credential argument, and in Authorization)
    const unbound = await citizenAssertion(c.key, null);
    const wrongMotion = await citizenAssertion(c.key, await buildIntentBinding("council_flag", [String(other)]));
    for (const [name, assertion] of [["unbound", unbound], ["bound to another motion", wrongMotion]] as const) {
      const rest = await call(c.env, "POST", url, {}, bearerHeader(assertion));
      const viaArg = await mcpFlag(c.env, { motion_id: m, secret: await citizenAssertion(c.key, name === "unbound" ? null : await buildIntentBinding("council_flag", [String(other)])) });
      const viaHeader = await mcpFlag(c.env, { motion_id: m }, { Authorization: `Bearer ${await citizenAssertion(c.key, name === "unbound" ? null : await buildIntentBinding("council_flag", [String(other)]))}` });
      assert.equal(rest.status, 403, name);
      for (const mcp of [viaArg, viaHeader]) {
        assert.equal(mcp.isError, true, name);
        // the refusal teaches the expected binding, which is the same string on both doors
        assert.equal(mcp.data.error, rest.body.error, name);
      }
    }
    assert.equal(flagged(c.d1, m), false);
    assert.equal(flagged(c.d1, other), false);
    assert.equal(rows(c.d1, "SELECT * FROM resident_nonces").length, 0);
  } finally {
    c.d1.close();
  }
});

test("parity: the same accepted inputs flag over REST and over MCP and serve the same motion shape, for a secret citizen, a key citizen and a resident (mutant: the MCP door builds its own object)", async () => {
  const c = await councilCast();
  try {
    const shape = (o: any) => ({ keys: Object.keys(o).sort(), seat: o.operator_seat.reasons, out: o.operator_seat.out_of_the_count, by: o.operator_seat.flagged.by.handle, note: o.note });
    for (const [who, label] of [[c.sis, "sisyphus"], [c.key, "keyed-free"], [c.wren, "wren"]] as const) {
      const proposer = label === "keyed-free" ? c.sis : c.key;
      const viaRest = (await openMotion(c.env, proposer, "statement", `REST ${label}`)).body.id as number;
      const rest = await flagMotion(c.env, who, viaRest);
      assert.equal(rest.status, 201, `${label}: ${JSON.stringify(rest.body)}`);
      // close the proposer's motion so it can open the next one
      c.d1.raw.prepare("UPDATE council_motions SET opened_at = ?, closes_at = ? WHERE id = ?").run(Date.now() - 8 * 86_400_000, Date.now() - 1_000, viaRest);
      const viaMcp = (await openMotion(c.env, proposer, "statement", `MCP ${label}`)).body.id as number;
      let args: Record<string, unknown>;
      let headers: Record<string, string> = {};
      if ("secret" in who) args = { motion_id: viaMcp, secret: who.secret };
      else if ("id" in who) args = { motion_id: viaMcp, secret: await citizenAssertion(who, await buildIntentBinding("council_flag", [String(viaMcp)])) };
      else args = { motion_id: viaMcp, number: who.number, assertion: (await signResidentFlag(who, viaMcp)).assertion };
      const mcp = await mcpFlag(c.env, args, headers);
      assert.equal(mcp.isError, false, `${label}: ${JSON.stringify(mcp.data)}`);
      assert.deepEqual(shape(mcp.data), shape(rest.body), label);
      assert.equal(flagged(c.d1, viaMcp), true);
      assert.deepEqual([motionRow(c.d1, viaMcp).operator_flagged_by_kind, motionRow(c.d1, viaMcp).operator_flagged_by_id], [motionRow(c.d1, viaRest).operator_flagged_by_kind, motionRow(c.d1, viaRest).operator_flagged_by_id]);
      c.d1.raw.prepare("UPDATE council_motions SET opened_at = ?, closes_at = ? WHERE id = ?").run(Date.now() - 8 * 86_400_000, Date.now() - 1_000, viaMcp);
      void headers;
    }
  } finally {
    c.d1.close();
  }
});

test("MCP: the council_flag tool schema offers number and assertion and no token, and its description names both bindings (mutant: the schema keeps token)", async () => {
  const c = await councilCast();
  try {
    const res = await handleMcp(new Request("https://example.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), c.env);
    const tool = ((await res.json()) as any).result.tools.find((t: any) => t.name === "council_flag");
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["assertion", "motion_id", "number", "secret"]);
    assert.match(tool.description, /council_flag:/);
    assert.match(tool.description, /resident_council_flag:/);
    assert.doesNotMatch(tool.description, /resident's token|Same credential rule as council_write/);
  } finally {
    c.d1.close();
  }
});
