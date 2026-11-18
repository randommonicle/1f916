// /openapi.json response side (D-086, option A; soft-power 148881 and 149382, load-bearing-2 149371 on 1f916 9594).
// Document lint: reads only the rendered document and the UNVALIDATED table it is served from. No D1, nothing mocked.
//   1. Every GET parameter either declares a bound (minimum, maximum, pattern, enum) or carries the extension that says what the handler does with a bad value.
//   2. The extensions and the table agree both ways, value for value.
//   3. Every cursor a route serves carries the pattern of the parameter it feeds (the parked list keeps its integer cursor on both sides).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { renderOpenApi, UNVALIDATED } from "../src/discovery.ts";

type Schema = Record<string, any>;
type Param = { name: string; in: string; schema: Schema };

const doc: any = renderOpenApi("https://example.test", "Commonhold");
const paramsOf = (path: string): Param[] => [...(doc.paths[path].parameters ?? []), ...(doc.paths[path].get?.parameters ?? [])];
const allParams = (): Array<[string, Param]> => Object.keys(doc.paths).flatMap((path) => paramsOf(path).map((p): [string, Param] => [`${path}|${p.name}`, p]));
const okSchema = (path: string): Schema => doc.paths[path].get.responses["200"].content["application/json"].schema;

test("every GET parameter is bounded or carries x-clamped / x-ignored-when-invalid", () => {
  const params = allParams();
  assert.ok(params.length > 40, `the lint saw ${params.length} parameters (it is not vacuous)`);
  const bare = params
    .filter(([, p]) => p.schema.minimum === undefined && p.schema.maximum === undefined && p.schema.pattern === undefined && p.schema.enum === undefined && !p.schema["x-clamped"] && !p.schema["x-ignored-when-invalid"])
    .map(([k]) => k);
  assert.deepEqual(bare, []);
});

test("the extensions and the UNVALIDATED table agree both ways", () => {
  const seen = new Set<string>();
  const wrong: string[] = [];
  for (const [key, p] of allParams()) {
    seen.add(key);
    const entry = UNVALIDATED[key];
    const clamped = p.schema["x-clamped"];
    const ignored = p.schema["x-ignored-when-invalid"];
    if (!entry) {
      if (clamped || ignored) wrong.push(`${key} carries an extension the table does not name`);
      continue;
    }
    if (entry.kind === "clamped") {
      if (!clamped || ignored) wrong.push(`${key} is clamped in the table but the document says otherwise`);
      else if (clamped.minimum !== entry.min || clamped.maximum !== entry.max || clamped.reason !== entry.reason) wrong.push(`${key} x-clamped differs from the table`);
    } else if (!ignored || clamped) wrong.push(`${key} is ignored-when-invalid in the table but the document says otherwise`);
    else if (ignored.reason !== entry.reason) wrong.push(`${key} x-ignored-when-invalid differs from the table`);
    if (p.schema.minimum !== undefined || p.schema.maximum !== undefined || p.schema.pattern !== undefined || p.schema.enum !== undefined) wrong.push(`${key} is both bounded and listed in the table`);
  }
  assert.deepEqual(wrong, []);
  assert.deepEqual(Object.keys(UNVALIDATED).filter((k) => !seen.has(k)), [], "the table names no parameter the document lacks");
  assert.ok(Object.keys(UNVALIDATED).length >= 15, "the table is not empty");
  const clamps = Object.values(UNVALIDATED).filter((u) => u.kind === "clamped");
  assert.ok(clamps.length >= 4 && clamps.every((u) => u.kind === "clamped" && u.min >= 1 && u.max > u.min), "the clamp bounds are real numbers taken from the code");
});

// [route, the parameter that takes the cursor, the 200 field that carries it, whether the field is null at the end]
const CURSOR_ROUTES: Array<[string, string, string, boolean]> = [
  ["/api/residents", "after", "next_cursor", true],
  ["/api/council/thread", "after", "next_cursor", true],
  ["/api/guest/thread", "after", "guest_thread_next", true],
  ["/api/settlements/attention", "after", "next", true],
  ["/api/guest/inbox", "cursor", "next_cursor", false],
  ["/api/guest/due", "after", "next_cursor", true],
  ["/api/inbox", "cursor", "next_cursor", false],
];

test("every cursor a route serves carries the pattern of the parameter it feeds", () => {
  const wrong: string[] = [];
  for (const [path, param, field, nullable] of CURSOR_ROUTES) {
    const want = paramsOf(path).find((p) => p.name === param)?.schema.pattern;
    const got = okSchema(path).properties?.[field];
    if (typeof want !== "string") wrong.push(`${path} ${param} declares no pattern`);
    else if (!got) wrong.push(`${path} 200 declares no ${field}`);
    else {
      if (got.pattern !== want) wrong.push(`${path} ${field} pattern ${got.pattern} is not the ${param} pattern ${want}`);
      if (got.type !== "string") wrong.push(`${path} ${field} is not a string`);
      if (Boolean(got.nullable) !== nullable) wrong.push(`${path} ${field} nullable should be ${nullable}`);
      if (!(okSchema(path).required ?? []).includes(field)) wrong.push(`${path} ${field} is not required`);
    }
  }
  assert.equal(CURSOR_ROUTES.length, 7, "residents plus the six bare cursor routes (the brief says eight; its own list names seven)");
  assert.deepEqual(wrong, []);
});

test("the parked list keeps its integer cursor on both sides", () => {
  const after = paramsOf("/api/maintainer/parked").find((p) => p.name === "after")!.schema;
  const next = okSchema("/api/maintainer/parked").properties!.next_cursor;
  assert.equal(after.type, "integer");
  assert.equal(next.type, "integer");
  assert.equal(next.nullable, true);
  assert.equal(next.pattern, undefined, "no string pattern: the cursor is an integer");
});
