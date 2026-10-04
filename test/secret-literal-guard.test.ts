// D-061 (DECISIONS.md), Option B of the reopened design review
// (exchange/REVIEW_secret-literal-ast-guard-design_2026-09-07.md): the "stronger
// guarantee" the v4 work deferred as DEFERRED-SECRET-LITERAL-AST-GUARD. The v4
// AS-1..AS-9 tests (test/served-auth-both-path.test.ts) assert a FIXED, manually
// enumerated set of served surfaces names both credential paths and carries no
// secret-only instruction; the known-phrase grep there catches three specific
// phrasings anywhere in src/. Neither covers a novel secret-only phrasing on a
// FUTURE, unenumerated served surface. This guard does: it scans EVERY string and
// template literal in src/ for the word "secret" (decoded, so an escape cannot
// bypass) and fails on any that is not on an explicit, reviewed allowlist. A new
// or changed secret-bearing literal anywhere forces a human to look, against the
// v4 both-path invariant, at the point of loss.
//
// WHY A HAND-ROLLED LEXER, NOT THE TS COMPILER (Finding 1, and L-049): the project
// runs typescript@7.0.2, whose main export is version-only; the classic AST API
// (createSourceFile/ScriptTarget/forEachChild) is gone, and the unstable
// typescript/unstable/ast scanner hung on first real use. A dependency-free lexer
// avoids both the unstable-API fragility and a new dependency. It is a copy, not a
// shared import, per this project's policing-test convention (l002-residue.test.ts's
// own header on why walkTsFiles/stripComments are duplicated): each scan stays
// free-standing so one file's edit cannot silently change another's behaviour.
//
// DECLARED BOUNDARY, stated not papered (CODEX r2 req 2): this is a LITERAL-VALUE
// guard. A word split across concatenation ("secr" + "et") or across an
// interpolation boundary is OUTSIDE it, proven by a boundary test below. The
// separate contiguous-raw-source scan (l002-residue.test.ts) and the AS-1..AS-9
// rendered-output tests are the other layers; the three do not overlap.
//
// Baseline (CODEX r2 req 6) is emitted BY this scanner and pinned below: 66
// secret-literals in src/, 22 exact wire tokens (by decoded value), 44 prose,
// covered by 43 allowlist entries (one literal recurs verbatim in mcp.ts). The
// 22-by-value figure reconciles the raw-grep count of 24 quoted tokens: two of
// those occurrences are the string "citizen_secret" appearing as quoted TEXT
// inside a longer prose sentence, whose full decoded value is the sentence, not
// the bare token, so they are prose entries, not wire-token exemptions -- which is
// exactly the "exempt only the exact values" rule (req 3).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const SRC = join(import.meta.dirname, "..", "src");
const ROOT = join(SRC, "..");
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ---- decode JS string/template escapes, so "secr\u0065t" / "secr\x65t" cannot
//      bypass a raw-text match (CODEX r2 req 1). ----
function decodeEscapes(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c !== "\\") { out += c; i++; continue; }
    const n = raw[i + 1];
    if (n === "u") {
      if (raw[i + 2] === "{") {
        const end = raw.indexOf("}", i + 3);
        if (end === -1) { out += raw.slice(i); break; }
        out += String.fromCodePoint(parseInt(raw.slice(i + 3, end), 16) || 0);
        i = end + 1; continue;
      }
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16) || 0);
      i += 6; continue;
    }
    if (n === "x") { out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 4), 16) || 0); i += 4; continue; }
    const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
    out += map[n] !== undefined ? map[n] : (n ?? "");
    i += 2;
  }
  return out;
}

// A "/" starts a regex when the previous significant token cannot END an
// expression (heuristic; regex negative fixtures below prove it holds for src/).
type Prev = { type: "name" | "num" | "str" | "regex" | "punct"; last: string } | null;
function regexAllowedAfter(prev: Prev): boolean {
  if (prev === null) return true;
  if (prev.type === "punct" && /[)\]}]/.test(prev.last)) return false;
  if (prev.type === "name" || prev.type === "num" || prev.type === "str" || prev.type === "regex") return false;
  return true;
}

// Fail-closed lexer: returns the decoded value + line of every string and
// template-quasi literal. Throws on an unterminated literal/comment/regex, or if
// the walk fails to advance (CODEX r2 req 4).
//
// Line terminators are normalised to LF before lexing. ECMAScript already does
// this to the runtime VALUE of a template literal (a CRLF in the source becomes
// "\n" in the string the worker serves), so hashing the raw source bytes would
// key PROSE_ALLOW on the checkout's line-ending policy rather than on the served
// text: on a fresh Windows clone with Git's default autocrlf=true, the
// multi-line literals in doc.ts decoded with "\r\n" and this guard reported them
// unreviewed (found by an outside auditor's first clone, 2026-09-17; reproduced
// in a scratch clone). The repo carries no .gitattributes, so the guard must not
// depend on one.
function extractLiterals(rawSource: string): Array<{ value: string; line: number }> {
  const source = rawSource.replace(/\r\n?/g, "\n");
  const out: Array<{ value: string; line: number }> = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let prev: Prev = null;
  let guard = 0;
  let lastI = -1;
  while (i < n) {
    if (i === lastI) throw new Error(`no-progress at index ${i} (line ${line})`);
    lastI = i;
    if (++guard > n * 6 + 1000) throw new Error("no-progress guard tripped");
    const c = source[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && source[i + 1] === "/") { i += 2; while (i < n && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new Error(`unterminated block comment at line ${line}`);
      for (let k = i; k < end; k++) if (source[k] === "\n") line++;
      i = end + 2; continue;
    }
    if (c === "/" && regexAllowedAfter(prev)) {
      i++; let inClass = false;
      while (i < n) {
        const d = source[i];
        if (d === "\\") { i += 2; continue; }
        if (d === "\n") throw new Error(`unterminated regex at line ${line}`);
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/i.test(source[i])) i++;
      prev = { type: "regex", last: "/" };
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c; const startLine = line; let raw = ""; i++;
      let closed = false;
      while (i < n) {
        const d = source[i];
        if (d === "\\") { raw += d + (source[i + 1] ?? ""); i += 2; continue; }
        if (d === q) { i++; closed = true; break; }
        if (d === "\n") throw new Error(`unterminated ${q} string at line ${startLine}`);
        raw += d; i++;
      }
      if (!closed) throw new Error(`unterminated string at EOF (line ${startLine})`);
      out.push({ value: decodeEscapes(raw), line: startLine });
      prev = { type: "str", last: q };
      continue;
    }
    if (c === "`") {
      i++; let quasi = ""; const startLine = line; let closed = false;
      while (i < n) {
        const d = source[i];
        if (d === "\\") { quasi += d + (source[i + 1] ?? ""); i += 2; continue; }
        if (d === "`") { i++; closed = true; break; }
        if (d === "$" && source[i + 1] === "{") {
          if (quasi) { out.push({ value: decodeEscapes(quasi), line: startLine }); quasi = ""; }
          i += 2; let depth = 1;
          while (i < n && depth > 0) {
            const e = source[i];
            if (e === "{") { depth++; i++; }
            else if (e === "}") { depth--; i++; }
            else if (e === '"' || e === "'") {
              const q2 = e; let raw2 = ""; i++; let c2 = false;
              while (i < n) { const f = source[i]; if (f === "\\") { raw2 += f + (source[i + 1] ?? ""); i += 2; continue; } if (f === q2) { i++; c2 = true; break; } if (f === "\n") throw new Error(`unterminated ${q2} in template expr at line ${line}`); raw2 += f; i++; }
              if (!c2) throw new Error("unterminated string in template expr at EOF");
              out.push({ value: decodeEscapes(raw2), line: startLine });
            } else if (e === "`") {
              i++; let inner = ""; let idepth = 0; let ic = false;
              while (i < n) { const f = source[i]; if (f === "\\") { inner += f + (source[i + 1] ?? ""); i += 2; continue; } if (f === "`" && idepth === 0) { i++; ic = true; break; } if (f === "$" && source[i + 1] === "{") { idepth++; i += 2; continue; } if (f === "}" && idepth > 0) { idepth--; i++; continue; } if (f === "\n") line++; inner += f; i++; }
              if (!ic) throw new Error("unterminated nested template at EOF");
              out.push({ value: decodeEscapes(inner), line: startLine });
            } else { if (e === "\n") line++; i++; }
          }
          if (depth > 0) throw new Error(`unterminated template expression at line ${startLine}`);
          continue;
        }
        if (d === "\n") line++;
        quasi += d; i++;
      }
      if (!closed) throw new Error(`unterminated template at EOF (line ${startLine})`);
      if (quasi) out.push({ value: decodeEscapes(quasi), line: startLine });
      prev = { type: "str", last: "`" };
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let id = ""; while (i < n && /[A-Za-z0-9_$]/.test(source[i])) { id += source[i]; i++; } prev = { type: "name", last: id }; continue; }
    if (/[0-9]/.test(c)) { while (i < n && /[0-9a-fA-Fxo._n]/.test(source[i])) i++; prev = { type: "num", last: "0" }; continue; }
    prev = { type: "punct", last: c };
    i++;
  }
  return out;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// ---- the allowlist ----
// Exempt globally, by EXACT decoded value only (req 3): the two stable wire tokens.
const WIRE_TOKENS = new Set(["citizen_secret", "maintainer_secret"]);

// Reviewed prose, keyed by (project-relative file + sha256 of the COMPLETE decoded
// literal value) (req 3: no substring/line/broad-file allowances). A hashed
// full-value key is used rather than the verbatim value because one entry is the
// ~5KB doc.ts front-door template; the hash carries the same "any change forces
// review" guarantee compactly (change the literal, its hash changes, the entry goes
// stale AND the new value becomes an offender). `note` is a review hint only, never
// matched on. Baseline generated by this scanner, 2026-09-07.
const PROSE_ALLOW: Array<{ file: string; sha: string; note: string }> = [
  { file: "src/discovery.ts", sha: "ba3ed9d6aae8394f2052ed021f2f9c39aa449c0628116306382bdafbeaba49f3", note: "Pay $1 USDC to inscribe one public line in the ledger" },
  { file: "src/discovery.ts", sha: "d2caae3db9fa60aec0a4d2347bac683df857ab4b4842257a0a7d99828ccea7ed", note: "auth is per-tool-call (Authorization header or a 'secret' arg)" },
  { file: "src/discovery.ts", sha: "843c7f4270f06d8924a02eba93f90092dc3c654ee45fdb98c686d9792f55a2a4", note: "JSON-RPC 2.0 read-only NO auth, writes need a credential" },
  { file: "src/discovery.ts", sha: "32330f74f50f39bd7c99196dc4b1ae9e326cafa5b2e74bc10f8c413345a53efb", note: "Become a citizen. 201 returns your citizen secret once / or pubkey" },
  { file: "src/discovery.ts", sha: "6fc8069708a77cfa74a755d33ed47907afe62bde07ddd06272854d12ea9b4c44", note: "token from showhome/enter, never a citizen secret" },
  { file: "src/discovery.ts", sha: "be0323ec462299d0cef3b7bfd8983d07a8739e5d0f1d0ff10ed12a074c733a47", note: "Replace your credential; secret citizen issued a new secret" },
  { file: "src/discovery.ts", sha: "7e69f3f92ec6e77197ead77c5a0e016cb50d3c768fe7a9a48686a3e0115a7859", note: "MAINTAINER_SECRET is an operator credential, distinct" },
  { file: "src/discovery.ts", sha: "5f617e2821be2f5f0c503739f92bdf6f2a03485a0d5f29e388034b670753fcac", note: "a citizen credential in Bearer <credential> (secret OR assertion)" },
  // (guest-voice wave: AUTH_LABEL.visitor_token no longer says "secret" -- it names the credential, "never a citizen credential" -- so its entry is gone; POST /api/guest/answer's ROUTES row adds one wire token "citizen_secret". The baseline below moved from 76 / 23 / 53 to 76 / 24 / 52.)
  { file: "src/discovery.ts", sha: "9917671a3aafd921d2f509269bf99e78a728b22798a5d021357a64a49ad24fa3", note: "MAINTAINER_SECRET, operator credential distinct from citizen's" },
  { file: "src/discovery.ts", sha: "8d13de6287fbc78727e9cb650c606f0a22ce69fd4a0fce62c76691c7729678d0", note: "/mcp/read read-only no-auth, writes need a credential" },
  { file: "src/discovery.ts", sha: "080bcde82c877fe2fc2604a75cf64fc2cca232e1111cec71603950dfb3827d13", note: "authenticate every citizen write with your citizen credential (both forms); not every write takes one: guest comment and showhome note take a visitor token, a reply takes either, enter and sweep none, register and patron x402, a listing x402 plus the funder's citizen credential, the maintainer routes the operator's maintainer secret (gate M-1, 2026-10-02; CODEX gate-fixes r1, 2026-10-03)" },
  // CODEX gate-fixes r1 (2026-10-03): the two other credentials sentences now name the maintainer routes, so their literals carry "secret" for the first time: the operator's maintainer secret, never a citizen-auth instruction.
  { file: "src/guest-core.ts", sha: "be1c32fa3a23a5f2e4aff23960b6c79946a4959847c7f18423d80a050874dc4b", note: "guest writes exception: visitor token, none, x402, listing x402 plus funder credential, maintainer routes take the operator's maintainer secret" },
  { file: "src/inbox.ts", sha: "3dc24db5a89ca87d4ef3447db88ef0ae57c07b32a18de4bda4afb3c4a49b02eb", note: "skill.md Credentials: not every write takes a citizen credential; maintainer routes take the maintainer secret, not a citizen credential; every other write: both citizen forms" },
  { file: "src/discovery.ts", sha: "07584c9afa4ef1e1978a6f40f05f98c5955dab0ced278454e0b14505c651f21b", note: "an issued secret from POST" },
  { file: "src/discovery.ts", sha: "6d8c25756aec66c544bcbab7616ab1bea58ac4b5dc9080e84dd85b4df606d433", note: "llms.txt for write routes, credential (secret or assertion)" },
  { file: "src/doc.ts", sha: "de69f7e8e96fcb76b9b4cc6c1712e52a7e16fa72b7ac891edf7f1e609a391c1c", note: "Register (once). invite-gated; reply shows a secret once / or pubkey" },
  { file: "src/doc.ts", sha: "3ff6a9ceb77ee76931386fa752db0709ea4333ce1ee0c52a299ff5ccf781f4f3", note: "register body {invite_code, handle, model, public_key}" },
  { file: "src/doc.ts", sha: "063dc91cbb3955ae3ed392f3d0e3cbf3d6af2814113d41ee11b6be2a29582fb1", note: "Register (once), open door; reply shows a secret once / or pubkey" },
  { file: "src/doc.ts", sha: "26553bfb8f7045a417cb0b38aaa6d44d78b1453aea81daf375cd4d6d02502bc1", note: "register body {handle, model, public_key}" },
  { file: "src/doc.ts", sha: "bbdfbaf3e8c55d3e7ab25fb805f549c707aad8056bdb797823c2105ebebd4cd0", note: "the full front-door FRONT_DOOR_TEMPLATE (constitution, compact); sha moved at v5 (2026-09-12 fee-framing correction, TREASURY para)" },
  // D-073 (2), 2026-09-30: the lobby note reworded to "pilot PAUSED" (Ben's text, verbatim): two quasis now carry the word.
  { file: "src/doc.ts", sha: "dab58cb04edbca6277f1b0609e4c74d985373c3e49c396f6ad353537964e6451", note: "lobby door-note (paused): how the seven were made; the registration issued no secret, the operator holds no key (custody, not immunity)" },
  { file: "src/doc.ts", sha: "ba3b6d209143e3d7bb33bc02a3eef65f687017f98b43fac6d4ca8983c69ce4de", note: "lobby door-note (paused): operator-funded but custody-independent; hold the only key by registering at $1 with a public_key, which issues no secret" },
  { file: "src/listings.ts", sha: "c81896ee72fd2549767e978d3316e9bbafe7efbfd60681e4cfb31d128375937e", note: "listings: scrub secrets and identifying detail from a git link" },
  { file: "src/maintainer/judgment.ts", sha: "28b48056382aef4101812ac5647a6fab0bd114bc4cb144afec7ac26e3d5bcd13", note: "deny-pattern: mentions a citizen secret or private key" },
  { file: "src/maintainer/judgment.ts", sha: "12d5b8fb036cbb7e6fa14774e8df52b567a9176c2779745c967d48a658cf7732", note: "deny-pattern: asks the reader to send crypto or a secret" },
  { file: "src/mcp-read.ts", sha: "abbd3559b28961f0f46046feb3ca292a7e50966d323f8bf8c9568cc5c51c2f33", note: "read door refusal: write tools need a credential (secret or assertion) -- heartbeat-inbox wave added inbox, the guest-voice wave added guest_thread, guest_due and guest_inbox, to the tool list named in this sentence (the credential wording is unchanged)" },
  { file: "src/mcp-read.ts", sha: "bc869f523e850806809dcd23605b4381bed18a64ee93287468a66cfafb76d087", note: "read door init: citizen actions need a credential" },
  { file: "src/mcp.ts", sha: "2cf530512f2dd7ce27d4369003459722461fcb64e68ecc5c16415d0246018602", note: "credential arg: secret issued OR ch1 assertion (recurs verbatim)" },
  { file: "src/mcp.ts", sha: "609798938cfbdab31876455a028bedb9f51a889517281aa862adb346bade9fc0", note: "rotate: secret citizen gets fresh secret; pubkey citizen swaps key" },
  { file: "src/mcp.ts", sha: "bbbd572da044852cf6a6b29c9e5960efd9de7fb46ef4628db393eb08608d3b93", note: "read one proposal: ballots roll-call, not secret" },
  { file: "src/mcp.ts", sha: "080faea4f53d44c3552b9a9efc0b7906cf25dac13679e238e8248478b7f89d31", note: "register tool refusal (A5(c), 2026-09-28): mode-aware base text, use HTTP door, optional public_key no secret" },
  { file: "src/mcp.ts", sha: "38c507d5f2358a398f6cda1e4d87f2306af0e3ffa927d7038514c30bacdbbeac", note: "MCP init: authenticate writes with credential (secret or assertion)" },
  { file: "src/showhome.ts", sha: "54a83ed789da1f10eb53418173c193bd1936ad5aa8b9fd54e242530a0d15e3c6", note: "visitor token shown once; not a citizen secret; guest-voice wave reworded it (the token now also comments on the board as a guest, writes to no chain), and the continuity sentence follows it" },
  { file: "src/showhome.ts", sha: "5c4e8c2527a40c80e258a64b3a66e06de64405de4df67b105aacc1c254b59c49", note: "showhome/reply: citizen answers with credential (secret or assertion)" },
  { file: "src/society.ts", sha: "18282b506402cb1a7dfc9065a0307085f7a3fe18a08781201476af823897df13", note: "401: present your citizen credential (secret or assertion)" },
  { file: "src/society.ts", sha: "d30fa3d558897d8c46959aca9b714b0aca17fb27df002a75ba51110ca49e0722", note: "SQL: SELECT ... WHERE secret_hash = ? AND public_key IS NULL" },
  { file: "src/society.ts", sha: "437933f1c4245eb7a8eb45f2d4618ee23a3e261ddc9593b216a5188332d13853", note: "error: Unknown secret. It identifies no citizen." },
  { file: "src/society.ts", sha: "08952ee765170a6e7d2584a683da4a11f13d3f7563a6b04586f898ead5aeb1bb", note: "SQL: INSERT INTO citizens (... secret_hash, public_key ...)" },
  { file: "src/society.ts", sha: "bfa0780a837dc8fbee8c88a262b05848a1a0ca07701a150114f5ec7e100e7960", note: "pubkey 201: no citizen secret issued; operator can replace key (honest limit)" },
  { file: "src/society.ts", sha: "8e664c84e6b4fcdfe519ea91b2a15796baefbbcb039545cfc2e1b85a7e18ff8b", note: "secret shown once is your entire identity, no recovery" },
  { file: "src/society.ts", sha: "60a4a6f3f9249a84ef0dce6e294079ddcd7d8b3ad5de276d76b1b9aa031d6342", note: "rotate pubkey citizen: replaces public key, issues no secret" },
  { file: "src/society.ts", sha: "ed6ee486390e1a408c35c7fabda6e9efd1ab252393af3d533635075cfc7d891d", note: "rotate result: public key replaced; app never saw your private key" },
  { file: "src/society.ts", sha: "83c7178ad00d476bca8b952b41897b44321044015e0907ffb2a6af996f11a396", note: "rotate: secret-held citizenship replaces the secret; no convert to pubkey" },
  { file: "src/society.ts", sha: "1f0c81b878184de8d2581b39dab380eb0c8826bbc820c09a7ae288a77ac30330", note: "SQL: UPDATE citizens SET secret_hash = ? WHERE id = ?" },
  { file: "src/society.ts", sha: "1ac8a8277b799929a9e4d160e796e35527413b5ad46b97328be367b898234242", note: "new secret shown once is now your entire identity" },
  // Standing topics (D-070): the officialFacts.topics note and the door note both say the route is
  // secret-guarded (the MAINTAINER_SECRET, an operator credential); neither is a citizen-auth instruction.
  { file: "src/society.ts", sha: "ae7b51c94c1fcef9b7446399edad2c95169e93f54be98ecabd39ba25359e46d3", note: "officialFacts.topics: opened through a secret-guarded route; Rule 7 disclosure; re-reviewed 2026-09-22 for the D-018 gate L2-L4 wording (one row per act, citizen #1, the quiet rule, operator steering), no credential instruction added" },
  { file: "src/topics.ts", sha: "9b1c541d4d0f13d967851e4eb95506efd10e8a26e28bd29023a1785f32e03aba", note: "topicsDoorNote: STANDING TOPICS, a secret-guarded route (POST /api/maintainer/topic); the guest-voice wave added one parenthesis saying a guest may comment too (the maintainer-secret wording is unchanged)" },
  // x402 settle-honesty wave, B4 (docs/BRIEF-X402-SETTLE-HONESTY.md): the register door's PayAI discovery
  // declaration (REGISTER_OUTPUT_SCHEMA), in the hub's words. It describes the public-key path's 201 (no
  // secret is issued); it is not a secret-only citizen-auth instruction.
  { file: "src/register-gate.ts", sha: "9b8f9ece1db53655f8efebbddea2dfed1a4cf35742ad10505c17166d3b402f53", note: "B4 discovery declaration, public_key field: when sent, the 201 returns no secret" },
  // Settlement replay guard (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md B5b/B5d/B6b): the served wording for a
  // secret-mode registration whose claim is booked or waiting. Neither is a citizen-auth instruction; both
  // say a secret was or will be issued once, in the registration's own response, and cannot be recovered.
  // B10 (Ben's ruling, 2026-09-30): the one recommendation every register-door surface outside the attested template carries.
  // It says a secret exists only in the response that carries it; it is advice to use a key, not a secret-only credential instruction.
  { file: "src/society.ts", sha: "f7c5db6942130f7f67d00c65b11ec8c38e34b4428aca0d89b0b03e301ff2985d", note: "B10 PUBLIC_KEY_ADVICE: register with a public_key; a secret exists only in the response that carries it" },
  { file: "src/settlement-claims.ts", sha: "a6c0e9a10d23bdfdfbfe1df1dceaa024a4c83c33c8901dfefe8c5f431d32a984", note: "B5d: your seat exists; a response with its secret was issued, it cannot be recovered; reach the maintainer with this tx; send a public_key next time" },
  { file: "src/settlement-claims.ts", sha: "527643d8e38e808306a6318cf532173f5f28cdc9a03030f759db3b4b29a1d9ca", note: "B6b: a secret-mode settled_unbooked row waits for the payer's identical re-send, which delivers a fresh secret; no deadline" },
  // The claim-booked citizen INSERT (register-gate.ts finishRegistration): the same column list as register()'s own SQL above, gated on the claim.
  { file: "src/register-gate.ts", sha: "4ebfc1c9fed7351b062afe0896f603965b5a5453b27a9fd1d80dbcd40f24c8bc", note: "SQL: INSERT INTO citizens (... secret_hash, public_key ...) SELECT ... WHERE EXISTS (claim gate)" },
  { file: "src/register-gate.ts", sha: "337c602c21a3c23b7c4eb7c1e0a24eab7ac23bd08f23e9288817495c8d4211c7", note: "B6b: the paid-but-failed message for a secret-mode registration: an identical re-send re-attempts it without a second charge and hands a fresh secret if it completes; no deadline" },
];
const proseKey = (file: string, value: string): string => file + "\n" + sha(value);
const PROSE_KEYS = new Set(PROSE_ALLOW.map((e) => e.file + "\n" + e.sha));

type Verdict = "wire" | "prose-allowed" | "offender";
function classify(file: string, value: string): Verdict {
  if (WIRE_TOKENS.has(value)) return "wire";
  if (PROSE_KEYS.has(proseKey(file, value))) return "prose-allowed";
  return "offender";
}

test("secret-literal guard: every 'secret' literal in src/ is a reviewed wire token or an allowlisted prose entry, none unreviewed", () => {
  const offenders: Array<{ file: string; line: number; snippet: string }> = [];
  const usedKeys = new Set<string>();
  let total = 0, wire = 0, prose = 0;
  for (const file of walkTsFiles(SRC)) {
    const rel = relative(ROOT, file).split("\\").join("/");
    let lits: Array<{ value: string; line: number }>;
    try {
      lits = extractLiterals(readFileSync(file, "utf8"));
    } catch (e) {
      // Fail-closed: a lexer failure is a gate failure, never a silent skip.
      assert.fail(`secret-literal lexer FAILED (fail-closed) on ${rel}: ${(e as Error).message}`);
    }
    for (const lit of lits) {
      if (!/secret/i.test(lit.value)) continue;
      total++;
      const v = classify(rel, lit.value);
      if (v === "wire") wire++;
      else if (v === "prose-allowed") { prose++; usedKeys.add(proseKey(rel, lit.value)); }
      else offenders.push({ file: rel, line: lit.line, snippet: lit.value.replace(/\s+/g, " ").trim().slice(0, 90) });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Unreviewed secret-bearing literal(s) in src/. If a secret-only citizen-auth instruction has appeared on a served surface, restate it to name BOTH credential paths (an issued secret OR a signed assertion), per D-059/v4. If it is a legitimate new/changed literal, add a reviewed PROSE_ALLOW entry: { file, sha: sha256(complete decoded value), note }.",
  );
  const stale = PROSE_ALLOW.filter((e) => !usedKeys.has(e.file + "\n" + e.sha));
  assert.deepEqual(
    stale.map((e) => `${e.file} :: ${e.note}`),
    [],
    "Stale PROSE_ALLOW entries match no current src literal (the literal changed or was removed). Re-review and update or drop the entry.",
  );
  // Pinned baseline generated by this scanner (CODEX r2 req 6). These numbers move
  // only when a secret-literal is deliberately added/removed AND the allowlist is
  // updated in the same change, which is the review this guard exists to force.
  assert.equal(total, 78, "secret-literal total drifted from the committed baseline (78)");
  assert.equal(wire, 24, "exact wire-token count drifted from the committed baseline (24)");
  assert.equal(prose, 54, "prose-literal count drifted from the committed baseline (54)");
});

test("secret-literal guard red-proof: catches a novel secret-only instruction, decodes escapes, exempts only exact wire tokens, and forces review on a changed literal", () => {
  // A novel secret-only phrase on a NEW source file is caught (not one of AS-1..AS-9).
  assert.equal(classify("src/new-surface.ts", "Present your secret to authenticate every write."), "offender");
  // Escape-encoded bypass: decodeEscapes turns secr\u0065t into secret, then it is caught.
  const encoded = extractLiterals('const x = "reveal your secr\\u0065t token";')[0];
  assert.match(encoded.value, /secret/i, "decodeEscapes must turn secr\\u0065t into secret");
  assert.equal(classify("src/new-surface.ts", encoded.value), "offender");
  // Only the exact wire values are exempt, anywhere.
  assert.equal(classify("src/anywhere.ts", "citizen_secret"), "wire");
  assert.equal(classify("src/anywhere.ts", "maintainer_secret"), "wire");
  // "citizen_secret" as a SUBSTRING of prose is NOT the exempt token (req 3).
  assert.equal(classify("src/new-surface.ts", 'see "citizen_secret" in the vocabulary'), "offender");
  // Changing an allowed prose literal changes its hash, so it is caught for re-review.
  assert.equal(classify(PROSE_ALLOW[0].file, "Pay $1 USDC to inscribe one public MODIFIED secret line."), "offender");
});

test("secret-literal guard: a CRLF checkout hashes to the same PROSE_ALLOW key as the LF source, matching what the runtime serves", () => {
  const lf = "const p = `Register (once). By default the reply shows a\nsecret once, which is your credential to save.`;";
  const crlf = lf.replace(/\n/g, "\r\n");
  const [fromLf] = extractLiterals(lf);
  const [fromCrlf] = extractLiterals(crlf);
  assert.equal(fromCrlf.value, fromLf.value, "the decoded value must not depend on the checkout's line endings");
  assert.equal(proseKey("src/doc.ts", fromCrlf.value), proseKey("src/doc.ts", fromLf.value));
  // The normalisation is what ECMAScript does to the runtime value: a template literal
  // written with CRLF in the source serves "\n". Guard and worker must agree.
  assert.equal(fromLf.value, `Register (once). By default the reply shows a\nsecret once, which is your credential to save.`);
  assert.equal(fromLf.value.includes("\r"), false);
  // Control: a genuinely different literal still moves the key.
  assert.notEqual(proseKey("src/doc.ts", fromLf.value + " MODIFIED"), proseKey("src/doc.ts", fromLf.value));
});

test("secret-literal guard: comments and regex literals are not scanned (negative fixtures)", () => {
  assert.equal(extractLiterals("// present your secret here\nconst a = 1;").filter((l) => /secret/i.test(l.value)).length, 0, "a line comment mentioning secret is not a literal");
  assert.equal(extractLiterals("/* your secret */ const a = 1;").filter((l) => /secret/i.test(l.value)).length, 0, "a block comment mentioning secret is not a literal");
  // A regex whose body contains quote characters must not desync the string lexer:
  // the regex is skipped and only the real following string literal is captured.
  const lits = extractLiterals("const re = /[\"'`]secret/g;\nconst s = \"real secret prose\";");
  const hits = lits.filter((l) => /secret/i.test(l.value));
  assert.equal(hits.length, 1, "only the real string literal is a secret-literal, not the regex body");
  assert.equal(hits[0].value, "real secret prose");
});

test("secret-literal guard boundary: concatenation and split interpolation are OUT of scope, by declaration", () => {
  // "secr" + "et": two literals, neither contains the word. Documented boundary,
  // not a defect: a literal-value guard cannot see a word assembled across tokens.
  const concat = extractLiterals('const x = "secr" + "et";');
  assert.equal(concat.filter((l) => /secret/i.test(l.value)).length, 0, "concatenation is outside a literal-value guard");
  // Interpolation splitting the word across a quasi/expression boundary likewise.
  const interp = extractLiterals("const x = `secr${''}et`;");
  assert.equal(interp.filter((l) => /secret/i.test(l.value)).length, 0, "split interpolation is outside a literal-value guard");
});

test("secret-literal guard: the lexer fails closed on unterminated input (never a silent skip)", () => {
  assert.throws(() => extractLiterals('const x = "unterminated'), /unterminated/i, "unterminated string throws");
  assert.throws(() => extractLiterals("const x = `open ${1"), /unterminated/i, "unterminated template expression throws");
  assert.throws(() => extractLiterals("const x = /unterminated\n"), /unterminated/i, "unterminated regex throws");
});
