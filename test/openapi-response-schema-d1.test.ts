// /openapi.json response schemas (soft-power, 1f916 9594 142902): a declared schema may only mark required what the route really serves.
// Real local D1, the real router, nothing mocked. Each check walks the SERVED schema (GET /openapi.json) against a SERVED body, so a schema
// that names a field the route does not carry (e.g. decided_event_id_note on /api/proposal/{id}) goes red here.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { call, createLocalD1, seedCitizens, guestEnv } from "./helpers/guest.ts";
import { DECIDED_EVENT_ID_NOTE } from "../src/governance.ts";

type Schema = { type?: string; nullable?: boolean; required?: string[]; properties?: Record<string, Schema>; items?: Schema; description?: string };

// Every required name is present; every present value with a declared type has that type (null only where nullable).
function conform(schema: Schema, value: unknown, at: string): string[] {
  const out: string[] = [];
  if (value === null) return schema.nullable ? out : [`${at} is null but not nullable`];
  const t = Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (schema.type && schema.type !== t) out.push(`${at} is ${t}, schema says ${schema.type}`);
  if (schema.type === "array" && schema.items && Array.isArray(value)) value.forEach((v, i) => out.push(...conform(schema.items!, v, `${at}[${i}]`)));
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) out.push(`${at}.${k} is required but not served`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in o) out.push(...conform(s, o[k], `${at}.${k}`));
  }
  return out;
}

function setup() {
  const d1 = createLocalD1();
  const { maintainer } = seedCitizens(d1);
  const mk = (status: string, pointer: number | null, at: number) =>
    Number(
      d1.raw
        .prepare("INSERT INTO proposals (kind, title, body, proposer_id, opened_at, closes_at, created_at, status, decided_event_id) VALUES ('resolution', 't', 'b', ?, ?, ?, ?, ?, ?)")
        .run(maintainer, at, at + 1, at, status, pointer).lastInsertRowid,
    );
  return { d1, env: guestEnv(d1), open: mk("open", null, 1000), passed: mk("passed", 4242, 1001) };
}

function schemaOf(doc: any, path: string): Schema {
  return doc.paths[path].get.responses["200"].content["application/json"].schema;
}

test("the declared proposal schemas match the served bodies, open and decided rows both", async () => {
  const { d1, env, open, passed } = setup();
  try {
    const doc = (await call(env, "GET", "/openapi.json")).body;
    const list = schemaOf(doc, "/api/proposals");
    const one = schemaOf(doc, "/api/proposal/{id}");
    assert.ok(list.required?.includes("decided_event_id_note") && list.properties?.proposals.items?.required?.includes("decided_event_id"), "the list schema names the field and its note");
    assert.ok(one.properties?.proposal.required?.includes("decided_event_id"), "the detail schema names the field");
    assert.equal(one.properties?.proposal.properties?.decided_event_id.description, DECIDED_EVENT_ID_NOTE, "the field carries the served note as its description");
    assert.deepEqual(conform(list, (await call(env, "GET", "/api/proposals")).body, "proposals"), []);
    for (const id of [open, passed]) assert.deepEqual(conform(one, (await call(env, "GET", `/api/proposal/${id}`)).body, `proposal/${id}`), []);
  } finally {
    d1.close();
  }
});

test("routes without a declared schema keep the bare object, and the checker can fail", async () => {
  const { d1, env } = setup();
  try {
    const doc = (await call(env, "GET", "/openapi.json")).body;
    assert.deepEqual(schemaOf(doc, "/api/official"), { type: "object" });
    // The proof the walk is not vacuous: the note is served on the list, not on one proposal.
    const wrong: Schema = { type: "object", required: ["decided_event_id_note"] };
    assert.deepEqual(conform(wrong, (await call(env, "GET", "/api/proposal/1")).body, "p"), ["p.decided_event_id_note is required but not served"]);
  } finally {
    d1.close();
  }
});
