// Compares what a live worker serves with what THIS checkout's source builds, whole (no network, no writes except --write-local).
//   node --experimental-strip-types scripts/check-resident-schema-served.mjs <openapi-body-file> <doors-body-file>
//   node --experimental-strip-types scripts/check-resident-schema-served.mjs --write-local <openapi-out-file> <doors-out-file>
// Requires, by deep equality (key order ignored, values exact): the 200 JSON schema of /api/residents, the 200 JSON schema of /api/resident/{number}, and the note of /api/doors.
// Prints OK and exits 0, or the first difference (which of the three, and the JSON path or the index of the first differing character) and exits 1. A missing or non-JSON file is exit 2.
// Origin-dependent fields of the document (servers and the like) are not compared. The exit code is set on process.exitCode and the process is never forced to stop: on Windows a forced stop can abort after pending I/O.
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const ORIGIN = "https://example.invalid";

function schemaOf(doc, path) {
  return doc?.paths?.[path]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
}

function firstDiff(a, b, at) {
  if (isDeepStrictEqual(a, b)) return null;
  const objA = a !== null && typeof a === "object";
  const objB = b !== null && typeof b === "object";
  if (!objA || !objB || Array.isArray(a) !== Array.isArray(b)) return `${at}: expected ${JSON.stringify(b)}, served ${JSON.stringify(a)}`;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${at}.${k}`);
    if (d !== null) return d;
  }
  return `${at}: differs`;
}

function firstCharDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

async function main(argv) {
  const { renderOpenApi } = await import("../src/discovery.ts");
  const { DOORS_NOTE } = await import("../src/doors.ts");
  const expectedDoc = JSON.parse(JSON.stringify(renderOpenApi(ORIGIN, "Commonhold")));
  if (argv[0] === "--write-local") {
    if (argv.length !== 3) { console.log("usage: --write-local <openapi-out-file> <doors-out-file>"); return 2; }
    writeFileSync(argv[1], JSON.stringify(expectedDoc));
    writeFileSync(argv[2], JSON.stringify({ note: DOORS_NOTE }));
    console.log("WROTE-LOCAL");
    return 0;
  }
  if (argv.length !== 2) { console.log("usage: <openapi-body-file> <doors-body-file>"); return 2; }
  const served = [];
  for (const f of argv) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch (e) { console.log(`cannot read ${f}: ${e.message}`); return 2; }
    try { served.push(JSON.parse(text)); } catch (e) { console.log(`${f} is not JSON: ${e.message}`); return 2; }
  }
  const [doc, doors] = served;
  for (const [label, path] of [["/api/residents", "/api/residents"], ["/api/resident/{number}", "/api/resident/{number}"]]) {
    const want = schemaOf(expectedDoc, path);
    if (want === undefined) { console.log(`MISMATCH ${label}: this checkout builds no 200 JSON schema for it`); return 1; }
    const d = firstDiff(schemaOf(doc, path), want, "$");
    if (d !== null) { console.log(`MISMATCH openapi ${label} schema, first difference at ${d}`); return 1; }
  }
  const note = doors?.note;
  if (typeof note !== "string") { console.log("MISMATCH /api/doors note: served body carries no string note"); return 1; }
  if (note !== DOORS_NOTE) { console.log(`MISMATCH /api/doors note, first differing character at index ${firstCharDiff(note, DOORS_NOTE)} (served length ${note.length}, expected ${DOORS_NOTE.length})`); return 1; }
  console.log("OK");
  return 0;
}

main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.log(`checker failed: ${e && e.stack ? e.stack : e}`); process.exitCode = 2; });
