// /openapi.json response schemas (soft-power, 1f916 9594 142902): a declared schema may only mark required what the route really serves.
// Real local D1, the real router, nothing mocked. Each check walks the SERVED schema (GET /openapi.json) against a SERVED body, so a schema
// that names a field the route does not carry (e.g. decided_event_id_note on /api/proposal/{id}) goes red here.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { call, createLocalD1, seedCitizens, guestEnv } from "./helpers/guest.ts";
import { DECIDED_EVENT_ID_NOTE } from "../src/governance.ts";
import { newResident, recoverRoute } from "./helpers/resident.ts";
import { world, writtenGuest, bindByAccount, OUTSIDE_COLONY_ID } from "./helpers/resident-account.ts";
import { RECOVERIES_SINCE } from "../src/resident.ts";
import { STAMPS_SINCE, DOORS_NOTE } from "../src/doors.ts";

type Schema = { type?: string; nullable?: boolean; required?: string[]; properties?: Record<string, Schema>; items?: Schema; description?: string; enum?: unknown[]; minimum?: number; maximum?: number; maxItems?: number };

// Every required name is present; every present value with a declared type has that type (null only where nullable); enum, minimum, maximum and maxItems hold where declared.
// A keyword this walker does not read must not appear in a declared schema: the resident test below fails on one.
function conform(schema: Schema, value: unknown, at: string): string[] {
  const out: string[] = [];
  if (value === null) return schema.nullable ? out : [`${at} is null but not nullable`];
  const t = Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (schema.type && schema.type !== t) out.push(`${at} is ${t}, schema says ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at} is ${JSON.stringify(value)}, not in enum ${JSON.stringify(schema.enum)}`);
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) out.push(`${at} is ${value}, below minimum ${schema.minimum}`);
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) out.push(`${at} is ${value}, above maximum ${schema.maximum}`);
  if (schema.maxItems !== undefined && Array.isArray(value) && value.length > schema.maxItems) out.push(`${at} has ${value.length} items, maxItems is ${schema.maxItems}`);
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

// ---------- the resident routes (soft-power, 1f916 9594 147976) ----------

const WALKED = new Set(["type", "nullable", "required", "properties", "items", "description", "enum", "minimum", "maximum", "maxItems"]);
function keywords(schema: unknown, out = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== "object") return out;
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    out.add(k);
    if (k === "properties") for (const p of Object.values(v as Record<string, unknown>)) keywords(p, out);
    if (k === "items") keywords(v, out);
  }
  return out;
}

// Four residents through the real routes: key-only with no recovery, key-only with one recovery, account-only (Colony), and bound both ways (a key first, then a 1f916 account).
async function roster() {
  const w = world();
  const plain = await newResident(w.env, w.post, "plain");
  const recovered = await newResident(w.env, w.post, "recovered");
  assert.equal((await recoverRoute(w.env, recovered.guest, recovered.kp)).status, 201);
  const acct = await writtenGuest(w.env, w.post, "acct");
  await bindByAccount(w.env, acct, "colony", { accountId: OUTSIDE_COLONY_ID, username: "acct-outside" });
  const both = await newResident(w.env, w.post, "both");
  await bindByAccount(w.env, both.guest, "1f916");
  return { ...w, numbers: { plain: plain.guest.number, recovered: recovered.guest.number, acct: acct.number, both: both.guest.number } };
}

test("the declared resident schemas match served rows of every kind: key, recovered, account-only, both; and the empty roster", async () => {
  const empty = world();
  try {
    const doc = (await call(empty.env, "GET", "/openapi.json")).body;
    const body = (await call(empty.env, "GET", "/api/residents")).body;
    assert.equal(body.total, 0);
    assert.deepEqual(conform(schemaOf(doc, "/api/residents"), body, "residents"), []);
  } finally {
    empty.d1.close();
  }
  const { d1, env, numbers } = await roster();
  try {
    const doc = (await call(env, "GET", "/openapi.json")).body;
    const list = schemaOf(doc, "/api/residents");
    const one = schemaOf(doc, "/api/resident/{number}");
    const row = list.properties!.residents!.items!;
    // what soft-power asked to have declared
    for (const k of ["recoveries", "last_recovered_at", "unit", "counts_toward"]) assert.ok(row.required!.includes(k) && one.required!.includes(k), `${k} is required on the row and the profile`);
    assert.equal(row.properties!.recoveries!.type, "integer");
    assert.equal(row.properties!.recoveries!.minimum, 0);
    assert.ok(row.properties!.recoveries!.description!.includes(RECOVERIES_SINCE), "the floor date is in the field's description");
    assert.equal(row.properties!.last_recovered_at!.nullable, true);
    assert.deepEqual(row.properties!.unit!.enum, ["resident_record"]);
    assert.equal(row.properties!.counts_toward!.maxItems, 0);
    assert.deepEqual(list.properties!.unit!.enum, ["resident_record"]);
    // the page bound the route enforces (limit 1 to 100) is in the schema, on the echo and on the array
    assert.deepEqual([list.properties!.limit!.minimum, list.properties!.limit!.maximum, list.properties!.residents!.maxItems], [1, 100, 100]);
    assert.equal((await call(env, "GET", "/api/residents?limit=101")).status, 400);
    const page = (await call(env, "GET", "/api/residents?limit=100")).body;
    assert.equal(page.limit, 100);
    assert.deepEqual(conform(list, page, "residents"), []);
    assert.deepEqual(conform(list, { ...page, limit: 101 }, "residents"), ["residents.limit is 101, above maximum 100"]);
    assert.deepEqual(conform(list, { ...page, residents: Array.from({ length: 101 }, () => page.residents[0]) }, "residents"), ["residents.residents has 101 items, maxItems is 100"]);
    assert.ok(!row.required!.includes("account") && !row.required!.includes("account_since"), "the conditional account fields are never required");
    // every keyword a declared schema uses is one the walker reads
    for (const s of [list, one, schemaOf(doc, "/api/proposals"), schemaOf(doc, "/api/proposal/{id}")]) for (const k of keywords(s)) assert.ok(WALKED.has(k), `schema keyword ${k} is not walked by conform()`);

    const body = (await call(env, "GET", "/api/residents")).body;
    assert.equal(body.total, 4);
    assert.deepEqual(conform(list, body, "residents"), []);
    const by = new Map<number, any>(body.residents.map((r: any) => [r.number, r]));
    // the fixture really covers the shapes (not a vacuous pass)
    assert.deepEqual([by.get(numbers.plain).route, by.get(numbers.acct).route, by.get(numbers.both).route], ["key", "account", "both"]);
    assert.deepEqual([by.get(numbers.plain).recoveries, by.get(numbers.plain).last_recovered_at], [0, null]);
    assert.equal(by.get(numbers.recovered).recoveries, 1);
    assert.equal(typeof by.get(numbers.recovered).last_recovered_at, "number");
    assert.equal(by.get(numbers.acct).public_key, null);
    assert.ok(!("account" in by.get(numbers.plain)) && "account" in by.get(numbers.acct) && "account" in by.get(numbers.both));
    assert.deepEqual([by.get(numbers.acct).account.platform, by.get(numbers.both).account.platform], ["colony", "1f916"]);
    for (const n of Object.values(numbers)) assert.deepEqual(conform(one, (await call(env, "GET", `/api/resident/${n}`)).body, `resident/${n}`), []);
    // every key a served row or profile carries is declared (a new served field must be added to the schema)
    for (const r of body.residents) for (const k of Object.keys(r)) assert.ok(k in row.properties!, `served row key ${k} is not declared`);
    for (const k of Object.keys(body)) assert.ok(k in list.properties!, `served roster envelope key ${k} is not declared`);
    for (const n of [numbers.plain, numbers.recovered, numbers.acct]) for (const k of Object.keys((await call(env, "GET", `/api/resident/${n}`)).body)) assert.ok(k in one.properties!, `served profile key ${k} is not declared (resident ${n})`);
    for (const k of Object.keys((await call(env, "GET", `/api/resident/${numbers.both}`)).body)) assert.ok(k in one.properties!, `served profile key ${k} is not declared`);
    for (const n of [numbers.acct, numbers.both]) for (const k of Object.keys(by.get(n).account)) assert.ok(k in row.properties!.account!.properties!, `served account key ${k} is not declared`);
  } finally {
    d1.close();
  }
});

test("the resident schema can fail: each declared constraint goes red on a row that breaks it", async () => {
  const { d1, env, numbers } = await roster();
  try {
    const doc = (await call(env, "GET", "/openapi.json")).body;
    const one = schemaOf(doc, "/api/resident/{number}");
    const good = (await call(env, "GET", `/api/resident/${numbers.recovered}`)).body;
    assert.deepEqual(conform(one, good, "r"), []);
    const without = (k: string) => {
      const c = { ...good };
      delete c[k];
      return c;
    };
    assert.deepEqual(conform(one, without("recoveries"), "r"), ["r.recoveries is required but not served"]);
    assert.deepEqual(conform(one, without("last_recovered_at"), "r"), ["r.last_recovered_at is required but not served"]);
    assert.deepEqual(conform(one, { ...good, recoveries: null }, "r"), ["r.recoveries is null but not nullable"]);
    assert.deepEqual(conform(one, { ...good, recoveries: -1 }, "r"), ["r.recoveries is -1, below minimum 0"]);
    assert.deepEqual(conform(one, { ...good, recoveries: "1" }, "r"), ["r.recoveries is string, schema says integer"]);
    assert.deepEqual(conform(one, { ...good, last_recovered_at: "yesterday" }, "r"), ["r.last_recovered_at is string, schema says integer"]);
    assert.deepEqual(conform(one, { ...good, unit: "account-binding" }, "r"), ['r.unit is "account-binding", not in enum ["resident_record"]']);
    assert.deepEqual(conform(one, { ...good, counts_toward: ["census"] }, "r"), ["r.counts_toward has 1 items, maxItems is 0"]);
    assert.deepEqual(conform(one, { ...good, route: "token" }, "r"), ['r.route is "token", not in enum ["key","account","both"]']);
  } finally {
    d1.close();
  }
});

test("the doors note states the ship-day limit of commits_by_day, and its date is the recoveries date", () => {
  assert.equal(STAMPS_SINCE, RECOVERIES_SINCE);
  assert.ok(DOORS_NOTE.includes(`Days before this shipped have no entry. It shipped on ${STAMPS_SINCE}.`));
  assert.ok(DOORS_NOTE.includes("a single stamp covers every count of that day"));
  assert.ok(DOORS_NOTE.includes(`any count written on ${STAMPS_SINCE} before that day's deploy is in that day's figures and is not covered by its stamp`));
  assert.ok(!DOORS_NOTE.includes("itself include requests served before"), "the note states the rule, not an unmeasured count");
  assert.ok(DOORS_NOTE.endsWith("This route cannot show how many counts a stamp does not cover."));
});

// ---------- the parked list (D-083) ----------

// Rows of every state through the real route: parked, still pending under the threshold, approved, rejected. The empty list is walked too.
function parkedRows(d1: ReturnType<typeof createLocalD1>) {
  seedCitizens(d1);
  const clerk = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('clerk', 1)").run().lastInsertRowid);
  const states: Array<[string, string, number, number | null]> = [
    ["registration_check", "pending", 2, null],
    ["bulletin_draft", "pending", 1, null],
    ["flag_review", "approved", 3, 50],
    ["constitution_fidelity", "rejected", 2, 60],
  ];
  for (const [kind, status, n, decided] of states) {
    const q = Number(d1.raw.prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, note, status, decided_at) VALUES (?, 10, ?, ?, ?, 'private note', ?, ?)").run(clerk, kind, kind === "flag_review" ? "post" : null, kind === "flag_review" ? 1 : null, status, decided).lastInsertRowid);
    for (let i = 0; i < n; i++) {
      const run = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('judgment', ?)").run(100 + q * 10 + i).lastInsertRowid);
      d1.raw.prepare("INSERT INTO maintainer_declines (queue_id, run_id, declined_at) VALUES (?, ?, ?)").run(q, run, 200 + i);
    }
  }
}

test("the declared parked-list schema matches the served body: the empty list and rows of every state, and it declares no key the route does not serve and the route serves no key it does not declare", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const doc = (await call(env, "GET", "/openapi.json")).body;
    const schema = schemaOf(doc, "/api/maintainer/parked");
    assert.ok(![...keywords(schema)].some((k) => !WALKED.has(k) && k !== "type"), `only walked keywords: ${[...keywords(schema)].join(",")}`);
    const empty = (await call(env, "GET", "/api/maintainer/parked")).body;
    assert.deepEqual(conform(schema, empty, "parked"), []);
    parkedRows(d1);
    const body = (await call(env, "GET", "/api/maintainer/parked")).body;
    assert.equal(body.items.length, 4);
    assert.deepEqual(conform(schema, body, "parked"), []);
    assert.deepEqual(Object.keys(schema.properties!).sort(), Object.keys(body).sort(), "top-level keys: declared equals served");
    const rowSchema = schema.properties!.items.items!;
    for (const row of body.items) assert.deepEqual(Object.keys(rowSchema.properties!).sort(), Object.keys(row).sort(), "row keys: declared equals served");
    assert.deepEqual(body.items.map((r: any) => [r.parked, r.status]), [[true, "pending"], [false, "pending"], [false, "approved"], [false, "rejected"]]);
  } finally {
    d1.close();
  }
});

test("the parked-list schema can fail: each declared constraint goes red on a body that breaks it", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const schema = schemaOf((await call(env, "GET", "/openapi.json")).body, "/api/maintainer/parked");
    parkedRows(d1);
    const good = (await call(env, "GET", "/api/maintainer/parked")).body;
    assert.deepEqual(conform(schema, good, "p"), []);
    const without = (k: string) => {
      const c = { ...good };
      delete c[k];
      return c;
    };
    assert.deepEqual(conform(schema, without("parked_now"), "p"), ["p.parked_now is required but not served"]);
    assert.deepEqual(conform(schema, { ...good, total: -1 }, "p"), ["p.total is -1, below minimum 0"]);
    assert.deepEqual(conform(schema, { ...good, park_after: 3 }, "p"), ["p.park_after is 3, not in enum [2]"]);
    assert.deepEqual(conform(schema, { ...good, next_cursor: "7" }, "p"), ["p.next_cursor is string, schema says integer"]);
    const row = good.items[0];
    assert.deepEqual(conform(schema, { ...good, items: [{ ...row, status: "held" }] }, "p"), ['p.items[0].status is "held", not in enum ["pending","approved","rejected"]']);
    assert.deepEqual(conform(schema, { ...good, items: [{ ...row, kind: "note" }] }, "p").length, 1);
    assert.deepEqual(conform(schema, { ...good, items: [{ ...row, decided_at: "x" }] }, "p"), ["p.items[0].decided_at is string, schema says integer"]);
    assert.deepEqual(conform(schema, { ...good, items: [{ ...row, declines: 0 }] }, "p"), ["p.items[0].declines is 0, below minimum 1"]);
    const nokey = { ...row };
    delete nokey.decided_at;
    assert.deepEqual(conform(schema, { ...good, items: [nokey] }, "p"), ["p.items[0].decided_at is required but not served"]);
    // An undeclared key is caught by the equality of declared and served key sets (the walker itself does not forbid extras).
    assert.notDeepEqual(Object.keys(schema.properties!).sort(), Object.keys({ ...good, extra: 1 }).sort());
  } finally {
    d1.close();
  }
});
