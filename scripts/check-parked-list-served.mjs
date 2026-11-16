// Compares what a live worker serves with what THIS checkout's source builds, WHOLE (no network, no writes except --write-local).
//   node --experimental-strip-types scripts/check-parked-list-served.mjs <parked-body> <openapi-body> <privacy-body> <runs-body>
//   node --experimental-strip-types scripts/check-parked-list-served.mjs --write-local <parked-out> <openapi-out> <privacy-out> <runs-out>
// Requires: GET /api/maintainer/parked carries the note, since and park_after of the source EXACTLY; the 200 JSON schema of /api/maintainer/parked in /openapi.json equals the source's by deep equality (key order ignored);
// GET /privacy equals the source's WHOLE rendered privacy document (line endings normalised; the controller and contact values are constants in src/privacy.ts, filled the same way by the worker, so nothing is masked);
// GET /api/maintainer-runs carries the source's whole note. Never a fragment or a marker phrase.
// Prints OK and exits 0, or the first difference (which of the four, and the JSON path or the index of the first differing character) and exits 1. A missing or unreadable file is exit 2.
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
  const { PARKED_NOTE, PARKED_SINCE, PARK_AFTER } = await import("../src/maintainer/parked.ts");
  const { MAINTAINER_RUNS_NOTE } = await import("../src/maintainer/runs.ts");
  const { renderPrivacy } = await import("../src/privacy.ts");
  const expectedDoc = JSON.parse(JSON.stringify(renderOpenApi(ORIGIN, "Commonhold")));
  const expectedPrivacy = renderPrivacy();
  if (argv[0] === "--write-local") {
    if (argv.length !== 5) { console.log("usage: --write-local <parked-out> <openapi-out> <privacy-out> <runs-out>"); return 2; }
    writeFileSync(argv[1], JSON.stringify({ note: PARKED_NOTE, since: PARKED_SINCE, park_after: PARK_AFTER }));
    writeFileSync(argv[2], JSON.stringify(expectedDoc));
    writeFileSync(argv[3], expectedPrivacy);
    writeFileSync(argv[4], JSON.stringify({ note: MAINTAINER_RUNS_NOTE }));
    console.log("WROTE-LOCAL");
    return 0;
  }
  if (argv.length !== 4) { console.log("usage: <parked-body> <openapi-body> <privacy-body> <runs-body>"); return 2; }
  const raw = [];
  for (const f of argv) {
    try { raw.push(readFileSync(f, "utf8")); } catch (e) { console.log(`cannot read ${f}: ${e.message}`); return 2; }
  }
  const json = [];
  for (const i of [0, 1, 3]) {
    try { json[i] = JSON.parse(raw[i]); } catch (e) { console.log(`${argv[i]} is not JSON: ${e.message}`); return 2; }
  }
  const [parked, doc, , runs] = json;
  const privacy = raw[2];

  if (typeof parked?.note !== "string") { console.log("MISMATCH /api/maintainer/parked note: served body carries no string note"); return 1; }
  if (parked.note !== PARKED_NOTE) { console.log(`MISMATCH /api/maintainer/parked note, first differing character at index ${firstCharDiff(parked.note, PARKED_NOTE)} (served length ${parked.note.length}, expected ${PARKED_NOTE.length})`); return 1; }
  if (parked.since !== PARKED_SINCE) { console.log(`MISMATCH /api/maintainer/parked since: expected ${JSON.stringify(PARKED_SINCE)}, served ${JSON.stringify(parked.since)}`); return 1; }
  if (parked.park_after !== PARK_AFTER) { console.log(`MISMATCH /api/maintainer/parked park_after: expected ${PARK_AFTER}, served ${JSON.stringify(parked.park_after)}`); return 1; }

  const want = schemaOf(expectedDoc, "/api/maintainer/parked");
  if (want === undefined) { console.log("MISMATCH openapi: this checkout builds no 200 JSON schema for /api/maintainer/parked"); return 1; }
  const d = firstDiff(schemaOf(doc, "/api/maintainer/parked"), want, "$");
  if (d !== null) { console.log(`MISMATCH openapi /api/maintainer/parked schema, first difference at ${d}`); return 1; }

  const servedPrivacy = String(privacy).replace(/\r\n/g, "\n");
  const expectedNorm = expectedPrivacy.replace(/\r\n/g, "\n");
  if (servedPrivacy !== expectedNorm) { console.log(`MISMATCH /privacy document, first differing character at index ${firstCharDiff(servedPrivacy, expectedNorm)} (served length ${servedPrivacy.length}, expected ${expectedNorm.length})`); return 1; }

  if (typeof runs?.note !== "string") { console.log("MISMATCH /api/maintainer-runs note: served body carries no string note"); return 1; }
  if (runs.note !== MAINTAINER_RUNS_NOTE) { console.log(`MISMATCH /api/maintainer-runs note, first differing character at index ${firstCharDiff(runs.note, MAINTAINER_RUNS_NOTE)} (served length ${runs.note.length}, expected ${MAINTAINER_RUNS_NOTE.length})`); return 1; }
  console.log("OK");
  return 0;
}

main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.log(`checker failed: ${e && e.stack ? e.stack : e}`); process.exitCode = 2; });
