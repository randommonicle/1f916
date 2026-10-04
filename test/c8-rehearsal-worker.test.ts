// The C1 rehearsal worker (scripts/c8-rehearsal-worker) ridden on the local D1 shim before it ever meets real D1. The shim cannot settle C1 itself
// (node:sqlite reports the same lastInsertRowid for the record UPDATE, which is why the gate asks for real D1); this proves the worker's own plumbing:
// the three cases run the real runBookingStep, its checks pass on a correct id, they go RED on a wrong one, and it deletes every row it wrote.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen } from "./helpers/local-d1.ts";
import { testEnv, type Env } from "./helpers/settlement-harness.ts";
import worker from "../scripts/c8-rehearsal-worker/index.ts";

const run = async (env: Env) => (await (await worker.fetch(new Request("https://rehearsal.test/run"), env)).json()) as Record<string, any>;

test("C1 rehearsal worker, local ride: all three cases pass on a correct id, (d) is printed, and every rehearsal row is deleted", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1);
    insertCitizen(d1);
    const report = await run(testEnv(d1));
    assert.equal(report.pass, true, JSON.stringify(report));
    assert.deepEqual(report.checks, { a: true, b: true, c: true, d_printed: true });
    const [a, b, c] = report.cases;
    assert.ok(a.citizen_id_by_handle > 1 && b.citizen_id_by_handle > a.citizen_id_by_handle);
    assert.equal(typeof b.stale_insert_last_row_id, "number");
    assert.equal(c.applied, false);
    assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens WHERE handle LIKE 'c1-rehearsal-%'").get()!.n, 0);
    assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM settlement_claims").get()!.n, 0);
    assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = 'c1-rehearsal'").get()!.n, 0);
    assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get()!.n, 2, "the two pre-existing citizens are untouched");
  } finally {
    d1.close();
  }
});

test("C1 rehearsal worker, red-proof: a batch whose first statement reports a stale last_row_id fails (a) and (b); an empty citizens table is refused", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1);
    const base = testEnv(d1);
    const lying = new Proxy(base.DB as object, {
      get(t: any, p: string | symbol) {
        if (p === "batch") {
          return async (stmts: unknown[]) => {
            const out = await t.batch(stmts);
            if (out.length === 2 && out[0]?.meta) out[0] = { ...out[0], meta: { ...out[0].meta, last_row_id: 1 } };
            return out;
          };
        }
        const v = t[p];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const report = await run({ ...base, DB: lying } as unknown as Env);
    assert.equal(report.pass, false);
    assert.equal(report.checks.a, false);
    assert.equal(report.checks.b, false);
    assert.equal(report.checks.c, true, "the gate-false case does not depend on the id");
  } finally {
    d1.close();
  }
  const empty = createLocalD1();
  try {
    const report = await run(testEnv(empty));
    assert.equal(report.pass, false);
    assert.match(String(report.error), /citizens is empty/);
  } finally {
    empty.close();
  }
});

test("C1 rehearsal worker: its citizen statement is verbatim register-gate.ts's, and runBookingStep still takes the id from out[stmts.length - 1]", () => {
  const root = join(import.meta.dirname, "..");
  const literal = "`INSERT INTO citizens (handle, model, secret_hash, public_key, karma, created_at, last_seen_at) SELECT ?, ?, ?, ?, 0, ?, ? WHERE EXISTS (${gate.sql})`";
  assert.ok(readFileSync(join(root, "scripts/c8-rehearsal-worker/index.ts"), "utf8").includes(literal));
  assert.ok(readFileSync(join(root, "src/register-gate.ts"), "utf8").includes(literal), "register-gate.ts's citizen INSERT changed: re-copy it into the rehearsal worker");
  assert.ok(readFileSync(join(root, "src/settlement-claims.ts"), "utf8").includes("out[stmts.length - 1]"));
});
