// Pre-flight for the C1 rehearsal worker: run before `npx wrangler dev --remote --config scripts/c8-rehearsal-worker/rehearsal.wrangler.jsonc`.
// Refuses (exit 1) unless the rehearsal config binds DB to the scratch database and nothing else, and its id differs from the production binding in
// ./wrangler.jsonc. Reads only those two config files; prints ids, never a secret.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRATCH_ID = "465f489c-f1ca-446e-8f5f-d35ea53fd720";
const SCRATCH_NAME = "commonhold-migtest";
const root = join(import.meta.dirname, "..", "..");
const jsonc = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, ""));

const rehearsal = jsonc(join(import.meta.dirname, "rehearsal.wrangler.jsonc"));
const prod = jsonc(join(root, "wrangler.jsonc"));
const prodIds = new Set((prod.d1_databases ?? []).flatMap((d) => [d.database_id, d.preview_database_id].filter(Boolean)));
const dbs = rehearsal.d1_databases ?? [];
const problems = [];
if (dbs.length !== 1) problems.push(`expected exactly one D1 binding, found ${dbs.length}`);
for (const d of dbs) {
  if (d.database_name !== SCRATCH_NAME) problems.push(`database_name is ${d.database_name}, not ${SCRATCH_NAME}`);
  for (const id of [d.database_id, d.preview_database_id]) {
    if (id !== SCRATCH_ID) problems.push(`binding id ${id} is not the scratch id ${SCRATCH_ID}`);
    if (prodIds.has(id)) problems.push(`binding id ${id} is a PRODUCTION id`);
  }
}
if (rehearsal.name === prod.name) problems.push(`worker name ${rehearsal.name} equals the production worker's`);
if (rehearsal.triggers) problems.push("the rehearsal config declares triggers");
if (problems.length) {
  console.error(`REFUSED:\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`OK: DB -> ${SCRATCH_NAME} (${SCRATCH_ID}); production ids ${[...prodIds].join(", ")} not bound; worker ${rehearsal.name}.`);
}
