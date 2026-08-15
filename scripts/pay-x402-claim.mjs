// A parameterised x402 payer for paid endpoints that are NOT this society's
// own door.
//
// REUSE GATE: DO NOT RUN THIS SCRIPT AGAIN YET.
//
// Round-2's four items are closed (see below) and Gemini has converged, but
// CODEX round 3 returned NOT YET SAFE TO REUSE with two further HIGH findings,
// both open at time of writing:
//
//   H-A [OPEN] THE ATTEMPT KEY IS BYTE IDENTITY, NOT PURCHASE IDENTITY.
//       bodyDigest() hashes the raw body string, so the same JSON with
//       different whitespace, line endings or key order derives a DIFFERENT
//       claim path -- and two invocations of the same purchase can therefore
//       each win a `wx` claim and each sign. Reproduced by Codex against the
//       exported functions. Especially live on this Windows host, where an
//       editor changing CRLF to LF is sufficient. FIX: derive the key from a
//       canonical JSON form (RFC 8785 or equivalent), keeping the raw-body hash
//       separately for forensics, and red-prove that minified, indented,
//       key-reordered and CRLF/LF variants of one body collide on ONE path
//       while a real value change does not.
//
//   H-B [OPEN] THE RECOVERY TEXT PERMITS DELETING A SUCCESSFUL TOMBSTONE.
//       The deterministic file is the only durable at-most-once memory, and its
//       own instructions say "delete this file only once you have established
//       what happened" without branching on the outcome. Establish that it
//       SUCCEEDED, delete it, and the next identical run recreates the path,
//       mints a fresh nonce and can pay again. FIX: a settled-and-delivered
//       outcome leaves a PERMANENT tombstone at the deterministic path;
//       deletion is permitted only when the recorded nonce is publicly unused,
//       valid_before_unix has passed, and delivery is absent at the
//       destination. Archiving counts as deletion unless an atomic marker stays
//       at the path.
//
// Codex's LOW (the probe printing a flag the parser no longer accepts) is
// fixed. One test that positively asserted the unsafe byte-sensitivity has been
// removed rather than left blessing it; the positive canonicalisation tests
// arrive with H-A.
//
// History, kept because it is the reason the guards look the way they do. The
// script ran exactly once, successfully, for the 1f3d9 frontier claim
// (D-039). An external round-2 review converged on the target pin, the import
// guard, the Base/timeout binding, the explicit --execute flag and the honest
// post-send wording, while returning NOT YET SAFE TO REUSE on four counts
// (exchange/REVIEW_x402-payer-script_2026-08-15.md, CODEX and GEMINI round 2):
//
//   1. The pending file is EVIDENCE, not an at-most-once control. The path is
//      caller-chosen, the write is not exclusive-create, and nothing refuses a
//      second signature while an earlier record is unresolved. Two invocations
//      can each authorise a payment. Fix: derive one deterministic attempt path
//      from payer/chain/target/body-digest, create it with `wx` semantics
//      before transmission, and refuse to sign while an unresolved or
//      unverified record exists.
//   2. MAX_PRICE_ATOMIC is NOT asset-bound. 1000000 atomic units is $1 only for
//      a six-decimal token, and the asset contract is an expectations-file
//      value, so editing that file can change the economic ceiling without
//      touching this source constant. Fix: pin a supported-asset map holding
//      Base USDC's contract, EIP-712 domain, decimals and max atomic amount,
//      and require the expectation and the live challenge to match that entry.
//   3. The pending record's status labels any 2xx `accepted`. HTTP success is
//      not verified settlement: use `http_accepted_unverified` until the Base
//      authorisation state for the recorded payer/nonce AND the destination's
//      own public record have both been checked. Record chain id, asset
//      contract and a request-body digest too; the current recovery recipe
//      cannot identify the token contract or the purchase payload by itself.
//   4. The trailing-slash fold in canonicalUrl() invents an equivalence HTTP
//      does not guarantee (`/x` and `/x/` can be different resources). It is
//      harmless for the commissioned target only because that resource has no
//      trailing slash. Preserve pathname exactly and make the current
//      accepts-a-trailing-slash test a refusal instead.
//
// Also from that round, and not yet closed: redaction removes the LITERAL
// in-memory bearer, which closes the echo attack demonstrated in round 1, but a
// server can encode or split a credential it has seen. The custody-safe design
// prints allowlisted structural fields with bounded lengths, never raw response
// bodies. Treat exact redaction as defence in depth, not as proof.
//
// HOW EACH WAS CLOSED, 2026-08-15:
//   1. -> attemptPath() derives ONE deterministic path from payer, chain,
//      pinned target and a sha256 of the exact body; claimAttempt() creates it
//      with `wx` BEFORE any signature exists, so a second attempt at the same
//      purchase is refused rather than signed. Extracted as its own function
//      precisely so the refusal is testable without a live 402. Red-proofed:
//      changing `wx` to `w` fails two tests, including one asserting the
//      original nonce is not overwritten.
//   2. -> SUPPORTED_ASSETS pins contract, chain id, EIP-712 domain, decimals
//      and max atomic amount together, and the ceiling is checked AFTER the
//      asset matches, since atomic units mean nothing until decimals are
//      pinned. Red-proofed: disabling the contract check fails the
//      swap-the-asset test.
//   3. -> the record now carries chain_id, asset, decimals and body_sha256,
//      and a 2xx sets `http_accepted_unverified`, never `accepted`.
//   4. -> canonicalUrl() preserves pathname exactly. The test that used to
//      assert a trailing slash was folded now asserts it is REFUSED.
//
// STILL UNTESTED and load-bearing, carried honestly: redirect refusal, two
// genuinely concurrent invocations, write-before-send ordering, and transport
// failure AFTER transmission. Those need an injected request seam. The
// exclusive claim now bounds the damage of all four, because a second run of
// the same purchase cannot sign, but that is mitigation and not proof.
//
// scripts/register-maintainer.mjs is the proven one-purpose client: it pays
// exactly $1 to exactly Commonhold's treasury for exactly /api/register, and
// its validatePaymentRequirements() is a hardcoded whitelist of those values.
// That whitelist IS its safety property, and it is the reason that script must
// not be generalised in place -- a generalised version of it would be a tool
// that signs a payment to whoever answers the 402.
//
// This script keeps an equivalent property while allowing a second
// destination, by inverting where the expectation comes from: the OPERATOR
// declares every field in a reviewable expectations file, and the script
// refuses unless the live challenge matches all of them.
//
// REVISED 2026-08-15 after an external adversarial review returned NOT SAFE TO
// RUN (exchange/REVIEW_x402-payer-script_2026-08-15.md, CODEX round 1). Seven
// findings, all conceded, all closed here. The two that mattered:
//
//   * The bearer credential was sent to an UNPINNED url before any validation
//     ran, so a wrong or hostile target received it and could then reply with
//     the expected challenge. And because the EIP-712 message binds from/to/
//     value/window/nonce but NOT the resource, such an endpoint could obtain a
//     real authorisation that pays the correct address and delivers nothing.
//     The url is now pinned to the reviewed resource, HTTPS is required, and
//     both fetches refuse redirects.
//   * Once the SIGNED request has been sent, any failure is settlement
//     UNKNOWN, never settlement failed. The old code asserted "nothing
//     settled" on a transport error, which is the single most dangerous thing
//     to tell someone deciding whether to retry a payment. It now writes
//     recovery metadata BEFORE sending and names a deterministic check.
//
// Also from that review: the money path is now behind an explicit --execute
// (the default is a probe that signs nothing), the probe no longer claims
// "nothing sent" when it has just sent an authenticated POST, price is capped
// in code as well as by the expectations file, the chain id is pinned to the
// declared network rather than assumed, maxTimeoutSeconds must match the
// reviewed value, and no untrusted response body is printed without the
// in-memory bearer redacted from it.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildAuthorization,
  signAuthorization,
  encodePaymentHeader,
  describeWouldSign,
} from "./register-maintainer.mjs";

const WALLET_PATH = resolve(process.cwd(), "..", "payer-wallet.local.json");

// A code-level ceiling that no expectations file can raise. The expectations
// file is a reviewed artifact, but it is also just a file on disk that a later
// edit could change; this is the backstop that survives that edit. Raising it
// is a deliberate source change that goes through review, which is the point.
// The spend ceiling is bound to an ASSET, not to a bare number. Both externals
// made the same point in round 2 and it is correct: "1000000" is $1 only for a
// six-decimal token, and the asset contract used to be an arbitrary
// expectations-file value, so editing that file could change the real economic
// ceiling without touching the constant that claimed to cap it.
//
// So each supported entry pins the contract, its EIP-712 domain, its decimals
// and its maximum atomic amount together, and the expectation AND the live
// challenge must both match the entry. buildTypedData() in
// register-maintainer.mjs hardcodes Base's chain id, so Base is also the only
// network this signer can honestly sign for, and that is stated here rather
// than implied.
export const SUPPORTED_ASSETS = Object.freeze({
  base: Object.freeze({
    label: "Base USDC",
    chain_id: 8453,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    domain_name: "USD Coin",
    domain_version: "2",
    decimals: 6,
    max_atomic: 1000000n, // $1.00 at six decimals. Raising it is a source change, on purpose.
  }),
});

// register-maintainer.mjs caps this at 3600; the new client used to accept any
// positive number, which let a server stretch a five-minute authorisation into
// a long-lived one via validBefore.
export const MAX_TIMEOUT_SECONDS_CEILING = 3600;

export const REQUIRED_EXPECTATION_FIELDS = [
  "pay_to",
  "price_atomic",
  "asset",
  "network",
  "chain_id",
  "resource",
  "max_timeout_seconds",
  "domain_name",
  "domain_version",
];

export function parseArgs(argv) {
  const args = { execute: false };
  const wants = {
    "--url": "url",
    "--body-file": "bodyFile",
    "--expect-file": "expectFile",
    "--confirm-pay-to": "confirmPayTo",
    "--bearer-file": "bearerFile",
    "--bearer-prefix": "bearerPrefix",
    "--pending-dir": "pendingDir",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") {
      args.execute = true;
      continue;
    }
    const key = wants[a];
    if (!key) throw new Error(`unrecognised argument: ${a}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${a} requires a value`);
    args[key] = value;
  }
  for (const flag of ["--url", "--body-file", "--expect-file", "--confirm-pay-to"]) {
    if (!args[wants[flag]]) throw new Error(`${flag} is required`);
  }
  if (Boolean(args.bearerFile) !== Boolean(args.bearerPrefix)) {
    throw new Error("--bearer-file and --bearer-prefix must be given together");
  }
  // Recovery metadata is only meaningful on the path that can actually spend,
  // and on that path it is not optional: it is the only thing that makes an
  // ambiguous settlement resolvable afterwards.
  if (args.execute && !args.pendingDir) {
    throw new Error("--pending-dir is required with --execute (the attempt record is the at-most-once control, not a convenience)");
  }
  return args;
}

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

// The url the request actually goes to must equal the resource the operator
// reviewed. Compared canonically so that a trailing-slash or case difference in
// the scheme/host is not a false refusal, while any difference in path, query,
// port or host IS one.
export function canonicalUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not a valid absolute URL: ${JSON.stringify(raw)}`);
  }
  if (u.protocol !== "https:") {
    throw new Error(`refusing a non-HTTPS target (${u.protocol}): a bearer credential would travel in clear`);
  }
  if (u.username || u.password) {
    throw new Error("refusing a URL carrying inline credentials");
  }
  if (u.hash) throw new Error("refusing a URL carrying a fragment");
  // pathname is preserved EXACTLY. An earlier version folded trailing slashes,
  // which invents an equivalence HTTP does not guarantee -- `/x` and `/x/` can
  // be different resources -- and there is no benefit in inventing equivalences
  // on a money path (CODEX round 2). Only scheme-case and host-case, which ARE
  // case-insensitive by RFC, are normalised.
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
}

export function assertTargetPinned(url, expectedResource) {
  const a = canonicalUrl(url);
  const b = canonicalUrl(expectedResource);
  if (a !== b) {
    throw new Error(
      `refusing to send: --url ${a} is not the reviewed resource ${b}.\n` +
        "  The bearer credential would go to an unreviewed host, and the EIP-712 signature does not bind the\n" +
        "  resource, so an endpoint repeating the expected fields could obtain a real authorisation and deliver nothing.",
    );
  }
  return a;
}

export function loadExpectations(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expectations file: not a JSON object");
  }
  const missing = REQUIRED_EXPECTATION_FIELDS.filter((f) => {
    const v = parsed[f];
    return v === undefined || v === null || v === "";
  });
  if (missing.length > 0) {
    throw new Error(`expectations file is missing required field(s): ${missing.join(", ")}`);
  }
  if (typeof parsed.price_atomic !== "string") {
    // Deliberately a string. A JSON number goes through the float path, and
    // this is an exact integer amount of money.
    throw new Error("expectations file: price_atomic must be a STRING of atomic units, e.g. \"1000000\" for $1.00 USDC");
  }
  if (!/^[0-9]+$/.test(parsed.price_atomic)) {
    throw new Error(`expectations file: price_atomic must be digits only, got ${JSON.stringify(parsed.price_atomic)}`);
  }
  // The asset is validated BEFORE the price ceiling, and the order is
  // load-bearing: a ceiling expressed in atomic units means nothing until the
  // token's decimals are pinned.
  const supported = SUPPORTED_ASSETS[parsed.network];
  if (!supported) {
    throw new Error(
      `expectations file: network ${JSON.stringify(parsed.network)} is not one this script can sign for. ` +
        `The imported typed-data builder hardcodes a chain id, so only ${Object.keys(SUPPORTED_ASSETS).join(", ")} is supported.`,
    );
  }
  const pinned = [];
  if (parsed.chain_id !== supported.chain_id) pinned.push(`chain_id ${JSON.stringify(parsed.chain_id)} (pinned ${supported.chain_id})`);
  if (String(parsed.asset).toLowerCase() !== supported.asset.toLowerCase()) pinned.push(`asset ${JSON.stringify(parsed.asset)} (pinned ${supported.asset})`);
  if (parsed.domain_name !== supported.domain_name) pinned.push(`domain_name ${JSON.stringify(parsed.domain_name)} (pinned ${JSON.stringify(supported.domain_name)})`);
  if (parsed.domain_version !== supported.domain_version) pinned.push(`domain_version ${JSON.stringify(parsed.domain_version)} (pinned ${JSON.stringify(supported.domain_version)})`);
  if (pinned.length > 0) {
    throw new Error(
      `expectations file does not match the pinned ${supported.label} entry: ${pinned.join("; ")}.\n` +
        "  The spend ceiling is bound to THIS asset. A different token is a different economic cap, so changing it is a source change, not a file edit.",
    );
  }
  if (BigInt(parsed.price_atomic) > supported.max_atomic) {
    throw new Error(
      `expectations file: price_atomic ${parsed.price_atomic} exceeds the pinned ceiling for ${supported.label} ` +
        `(${supported.max_atomic} atomic units at ${supported.decimals} decimals). Raising it is a source change, on purpose.`,
    );
  }
  if (!Number.isInteger(parsed.max_timeout_seconds) || parsed.max_timeout_seconds <= 0 || parsed.max_timeout_seconds > MAX_TIMEOUT_SECONDS_CEILING) {
    throw new Error(`expectations file: max_timeout_seconds must be a positive integer no greater than ${MAX_TIMEOUT_SECONDS_CEILING}`);
  }
  return parsed;
}

// The guard. Collects EVERY mismatch rather than failing on the first, because
// an operator deciding whether to trust an unexpected 402 wants the whole
// picture at once, not one field at a time.
export function validateAgainstExpectations(reqs, expected, confirmPayTo) {
  if (!reqs || typeof reqs !== "object") throw new Error("payment requirements: not an object");
  const problems = [];

  if (reqs.scheme !== "exact") {
    problems.push(`scheme: expected "exact", got ${JSON.stringify(reqs.scheme)}`);
  }
  if (reqs.network !== expected.network) {
    problems.push(`network: declared ${JSON.stringify(expected.network)}, server offered ${JSON.stringify(reqs.network)}`);
  }
  if (!sameAddress(reqs.asset, expected.asset)) {
    problems.push(`asset: declared ${expected.asset}, server offered ${JSON.stringify(reqs.asset)}`);
  }
  if (!sameAddress(reqs.payTo, expected.pay_to)) {
    problems.push(`payTo: declared ${expected.pay_to}, server offered ${JSON.stringify(reqs.payTo)}`);
  }
  if (reqs.maxAmountRequired !== expected.price_atomic) {
    problems.push(`maxAmountRequired: declared exactly ${JSON.stringify(expected.price_atomic)}, server asked ${JSON.stringify(reqs.maxAmountRequired)}`);
  }
  if (reqs.resource !== expected.resource) {
    problems.push(`resource: declared ${JSON.stringify(expected.resource)}, server named ${JSON.stringify(reqs.resource)}`);
  }
  if (!reqs.extra || reqs.extra.name !== expected.domain_name || reqs.extra.version !== expected.domain_version) {
    problems.push(
      `extra: declared EIP-712 domain {name:${JSON.stringify(expected.domain_name)},version:${JSON.stringify(expected.domain_version)}}, server offered ${JSON.stringify(reqs.extra)}`,
    );
  }
  // Exact, not "any positive number": this value becomes validBefore, so a
  // server that inflates it lengthens the life of a signed authorisation.
  if (reqs.maxTimeoutSeconds !== expected.max_timeout_seconds) {
    problems.push(
      `maxTimeoutSeconds: declared exactly ${JSON.stringify(expected.max_timeout_seconds)}, server offered ${JSON.stringify(reqs.maxTimeoutSeconds)} ` +
        "(this becomes the authorisation's validBefore, so a larger value is a longer-lived signature)",
    );
  }

  // A speed bump, deliberately NOT described as independent confirmation: if
  // the operator copies the address out of the expectations file, both values
  // share one source. It still catches invoking the wrong expectations file,
  // which is worth keeping. The real defences are the pinned target, the
  // reviewed one-purpose expectation, the code-level price ceiling, and Ben's
  // per-action approval.
  if (!sameAddress(confirmPayTo, expected.pay_to)) {
    problems.push(`--confirm-pay-to ${confirmPayTo} does not match the expectations file's pay_to ${expected.pay_to}`);
  }

  if (problems.length > 0) {
    throw new Error(`refusing to sign -- the live 402 does not match what was declared:\n  - ${problems.join("\n  - ")}`);
  }
  return reqs;
}

// Pulled by prefix rather than by field name, because a registration response
// saved to disk is not guaranteed to use the field name the API documented.
// Returns null rather than throwing so the caller can say WHICH file was wrong
// -- this exact failure (a file holding {"error":"handle taken"} instead of a
// credential) cost an hour on 2026-08-15, see LESSONS_LEARNED L-012.
export function extractBearer(text, prefix) {
  if (typeof text !== "string" || typeof prefix !== "string" || prefix === "") return null;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}[A-Za-z0-9_-]+`).exec(text);
  return m ? m[0] : null;
}

// Everything a foreign server sends back is untrusted, and it has seen our
// bearer. A server can echo it into its own response body and make us print it.
// Nothing reaches stdout or stderr without going through this.
export function redact(text, secret) {
  if (typeof text !== "string") return text;
  if (typeof secret !== "string" || secret.length === 0) return text;
  return text.split(secret).join("[REDACTED-BEARER]");
}

// The attempt record is the at-most-once control, so its PATH must be
// deterministic: the same logical purchase has to resolve to the same file
// whatever the caller types. Derived from payer, chain, the pinned target and a
// digest of the exact request body, so a second attempt at the SAME purchase
// collides with the first and is refused, while a genuinely different purchase
// gets its own slot.
//
// A caller-chosen filename could not do this, which is what the first version
// got wrong: two invocations could each open their own record and each
// authorise a payment, leaving the warning banner as the only thing between us
// and a double spend. A banner is not a control.
export function bodyDigest(body) {
  return createHash("sha256").update(String(body)).digest("hex");
}

// Exclusive creation, extracted so the refusal itself is testable rather than
// only reachable behind a live 402. `wx` fails if the path exists, and that
// failure IS the control: it means this exact purchase has been attempted
// before and its outcome may be unresolved.
export function claimAttempt(path, record) {
  try {
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    return { claimed: true };
  } catch (e) {
    if (e && e.code === "EEXIST") return { claimed: false, reason: "exists" };
    return { claimed: false, reason: "error", error: String((e && e.message) ?? e) };
  }
}

export function attemptPath(dir, { payer, chainId, target, digest }) {
  const key = createHash("sha256")
    .update([String(payer).toLowerCase(), String(chainId), String(target), String(digest)].join("\n"))
    .digest("hex")
    .slice(0, 32);
  return join(dir, `x402-attempt-${key}.json`);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function usage() {
  console.error("Usage: node scripts/pay-x402-claim.mjs \\");
  console.error("         --url <must equal the expectations file's resource> \\");
  console.error("         --body-file <path to request body json> \\");
  console.error("         --expect-file <path to expectations json> \\");
  console.error("         --confirm-pay-to <0x...> \\");
  console.error("         [--bearer-file <path> --bearer-prefix <prefix>] \\");
  console.error("         [--execute --pending-dir <dir>]");
  console.error("");
  console.error("Without --execute this PROBES: it sends the body and the credential, reads the 402,");
  console.error("checks every declared field, and stops before signing. It is an outward request, not an offline check.");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message ?? e));
    console.error("");
    usage();
    process.exitCode = 1;
    return;
  }

  let expected;
  try {
    expected = loadExpectations(JSON.parse(readFileSync(args.expectFile, "utf8")));
  } catch (e) {
    console.error(`Could not read/validate ${args.expectFile}: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  // BEFORE the bearer is even read off disk, let alone sent anywhere.
  let target;
  try {
    target = assertTargetPinned(args.url, expected.resource);
  } catch (e) {
    console.error(String(e.message ?? e));
    console.error("");
    console.error("Nothing was sent. No credential left this machine.");
    process.exitCode = 1;
    return;
  }

  let body;
  try {
    body = readFileSync(args.bodyFile, "utf8");
    JSON.parse(body);
  } catch (e) {
    console.error(`Could not read/parse ${args.bodyFile}: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  const headers = { "Content-Type": "application/json" };
  let bearer = null;
  if (args.bearerFile) {
    let raw;
    try {
      raw = readFileSync(args.bearerFile, "utf8");
    } catch (e) {
      console.error(`Could not read ${args.bearerFile}: ${e.message ?? e}`);
      process.exitCode = 1;
      return;
    }
    bearer = extractBearer(raw, args.bearerPrefix);
    if (!bearer) {
      console.error(`No value starting ${args.bearerPrefix} found in ${args.bearerFile}.`);
      console.error("That file does not hold the credential it is supposed to hold. Check it before anything else;");
      console.error("a saved error response looks exactly like a saved secret to every tool except this check.");
      process.exitCode = 1;
      return;
    }
    headers.Authorization = `Bearer ${bearer}`; // never logged; see redact()
  }

  let account = null;
  let payerAddress = null;
  if (args.execute) {
    if (!existsSync(WALLET_PATH)) {
      console.error(`No payer wallet at ${WALLET_PATH}. Nothing was sent.`);
      process.exitCode = 1;
      return;
    }
    let wallet;
    try {
      wallet = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
    } catch (e) {
      console.error(`Could not read/parse ${WALLET_PATH}: ${e.message ?? e}`);
      process.exitCode = 1;
      return;
    }
    account = privateKeyToAccount(wallet.privateKey);
    if (!sameAddress(account.address, String(wallet.address))) {
      console.error(`${WALLET_PATH} is inconsistent: its stored address does not match its private key. Refusing to proceed.`);
      process.exitCode = 1;
      return;
    }
    payerAddress = account.address;
  } else if (existsSync(WALLET_PATH)) {
    try {
      payerAddress = JSON.parse(readFileSync(WALLET_PATH, "utf8")).address ?? null;
    } catch {
      payerAddress = null; // a probe is a report; an unreadable wallet is not fatal to it
    }
  }

  const say = (s) => console.log(redact(String(s), bearer));
  const warn = (s) => console.error(redact(String(s), bearer));

  say(`${args.execute ? "EXECUTE" : "PROBE"}: POST ${target}`);
  say(`  body: ${body.trim()}`);
  say(`  auth: ${headers.Authorization ? "bearer token loaded (not printed)" : "none"}`);
  say(`  target pinned to the reviewed resource, HTTPS, redirects refused.`);

  let first;
  try {
    first = await fetch(target, { method: "POST", headers, body, redirect: "error" });
  } catch (e) {
    warn(`Could not reach ${target}: ${e.message ?? e}`);
    warn("Nothing was signed. No money moved.");
    process.exitCode = 1;
    return;
  }
  const { json: firstJson, text: firstText } = await readJson(first);

  if (first.status !== 402) {
    say(`Server responded HTTP ${first.status} (expected 402 at this stage).`);
    say(firstJson ? JSON.stringify(firstJson, null, 2) : firstText);
    warn("No payment was constructed. Nothing was signed, nothing was spent.");
    process.exitCode = first.status >= 200 && first.status < 300 ? 0 : 1;
    return;
  }

  if (!firstJson || !Array.isArray(firstJson.accepts) || firstJson.accepts.length === 0) {
    warn("402 response was not valid JSON, or had no usable 'accepts' array. Cannot continue.");
    warn(firstText);
    process.exitCode = 1;
    return;
  }
  if (firstJson.x402Version !== 1) {
    warn(`Server's 402 named x402Version ${JSON.stringify(firstJson.x402Version)}; this script only speaks protocol version 1.`);
    warn("Refusing to guess at a different protocol version. Nothing was signed, nothing was spent.");
    process.exitCode = 1;
    return;
  }

  // Only accepts[0] is considered, deliberately. Searching later entries for
  // one that matches would add flexibility without adding safety: it would let
  // a server that offers a hostile first option still get paid on its second.
  let reqs;
  try {
    reqs = validateAgainstExpectations(firstJson.accepts[0], expected, args.confirmPayTo);
  } catch (e) {
    warn(String(e.message ?? e));
    warn("");
    warn("Nothing was signed, nothing was spent.");
    process.exitCode = 1;
    return;
  }

  if (!args.execute) {
    say("402 received. Every declared field matched: scheme, network, asset, payTo, price, resource, EIP-712 domain, timeout, and the confirmed destination.");
    if (payerAddress) {
      say(`Would sign as ${payerAddress} (signAuthorization is never called without --execute):`);
      say(JSON.stringify(describeWouldSign(payerAddress, reqs), null, 2));
    } else {
      say(`No payer wallet readable at ${WALLET_PATH}, so the unsigned payload is not shown.`);
    }
    say("");
    say("PROBE COMPLETE. Nothing was SIGNED and no money moved.");
    say("Note honestly: this DID send the request body and the bearer credential to the pinned target. It was an");
    say("outward act against a foreign service, not an offline check. Re-run with --execute --pending-dir <dir> to pay.");
    process.exitCode = 0;
    return;
  }

  const asset = SUPPORTED_ASSETS[expected.network];
  const human = (Number(reqs.maxAmountRequired) / 10 ** asset.decimals).toFixed(asset.decimals > 2 ? 2 : asset.decimals);
  say(`Payment required: ${human} ${asset.label} on ${reqs.network}, to ${reqs.payTo}`);
  say(`Paying from ${payerAddress}...`);

  // THE CLAIM, and it happens before a signature exists at all. Exclusive
  // creation is what makes this a control rather than a note: if the record is
  // already there, this purchase has been attempted, and we refuse rather than
  // mint a second authorisation with a fresh nonce.
  const digest = bodyDigest(body);
  const attempt = attemptPath(args.pendingDir, { payer: payerAddress, chainId: expected.chain_id, target, digest });
  const record = {
    status: "claimed_not_yet_signed",
    written_at: new Date().toISOString(),
    target,
    chain_id: expected.chain_id,
    asset: expected.asset,
    asset_label: asset.label,
    decimals: asset.decimals,
    payer: payerAddress,
    payee: expected.pay_to,
    value_atomic: expected.price_atomic,
    body_sha256: digest,
    nonce: null,
    valid_before_unix: null,
    how_to_resolve: [
      "This record exists because a payment was attempted for this exact purchase.",
      "An EIP-3009 authorisation is SINGLE USE and its state is publicly readable on Base, so the pair",
      "(payer, nonce) below answers 'did it settle?' deterministically, which no HTTP status can.",
      "1. Check the payer address on basescan.io for a transfer of value_atomic to payee.",
      "2. Check the destination's own public record for the thing being bought.",
      "3. If neither shows it, wait until valid_before_unix has passed before authorising again, so the",
      "   old authorisation cannot land late alongside a new one.",
      "Delete this file only once you have established what happened. It is the only record of the nonce.",
    ],
  };
  {
    const claim = claimAttempt(attempt, record);
    if (!claim.claimed) {
      if (claim.reason === "exists") {
        warn(`REFUSING: an attempt record already exists for this exact purchase at ${attempt}`);
        warn("");
        warn("This payer has already attempted this body against this target on this chain, and the outcome");
        warn("was either successful or never resolved. Signing again would mint a SECOND authorisation with a");
        warn("fresh nonce, which is how a double spend happens.");
        warn("Read that file, establish what actually happened on Base and at the destination, and only then");
        warn("decide. Nothing was signed and nothing was sent.");
      } else {
        warn(`Could not create the attempt record at ${attempt}: ${claim.error}`);
        warn("Refusing to sign with no way to resolve an ambiguous result. Nothing was sent.");
      }
      process.exitCode = 1;
      return;
    }
  }
  say(`Attempt claimed exclusively at ${attempt} (before any signature existed).`);

  let authorization;
  let paymentHeader;
  try {
    authorization = buildAuthorization(payerAddress, reqs);
    const signature = await signAuthorization(account, authorization, reqs);
    paymentHeader = encodePaymentHeader(firstJson.x402Version, reqs, authorization, signature);
  } catch (e) {
    warn(`Failed to construct/sign the payment: ${e.message ?? e}`);
    warn(`Nothing was sent. No money moved. The attempt record at ${attempt} can be deleted.`);
    process.exitCode = 1;
    return;
  }

  // The nonce exists only now, and it is the single thing that makes an
  // ambiguous outcome resolvable afterwards. It goes into the already-claimed
  // record BEFORE the signed request leaves.
  record.status = "signed_and_sending";
  record.nonce = authorization.nonce;
  record.valid_before_unix = authorization.validBefore;
  try {
    writeFileSync(attempt, JSON.stringify(record, null, 2) + "\n");
    say(`Nonce ${authorization.nonce} recorded at ${attempt} BEFORE sending.`);
  } catch (e) {
    warn(`Could not update ${attempt}: ${e.message ?? e}`);
    warn("Refusing to send a signed payment whose nonce is not recorded. Nothing was sent.");
    process.exitCode = 1;
    return;
  }

  const unknown = (why) => {
    warn("");
    warn("*** SETTLEMENT UNKNOWN ***");
    warn(why);
    warn("The signed authorisation WAS transmitted. Whether it settled cannot be determined from this outcome,");
    warn("and this script will not guess. Do NOT re-run it: the nonce is fresh each time, so a blind retry can");
    warn("authorise a SECOND payment.");
    warn(`Resolve it using ${attempt}, which holds the payer, payee, chain, asset, value, body digest, nonce and expiry.`);
    warn("That record was created exclusively, so a re-run of this exact purchase will refuse rather than sign again.");
  };

  let second;
  try {
    second = await fetch(target, { method: "POST", headers: { ...headers, "X-PAYMENT": paymentHeader }, body, redirect: "error" });
  } catch (e) {
    unknown(`The request failed in transport: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }
  const { json: secondJson, text: secondText } = await readJson(second);

  if (second.status < 200 || second.status >= 300) {
    unknown(`The server answered HTTP ${second.status} after the signed request:\n${redact(secondJson ? JSON.stringify(secondJson, null, 2) : secondText, bearer)}`);
    process.exitCode = 1;
    return;
  }

  // NOT "accepted". HTTP success is not verified settlement, and labelling it
  // so would put a claim in a durable record that nobody checked (CODEX round
  // 2). Settlement is verified on Base, and delivery at the destination's own
  // public record; until both, this is exactly what it says.
  try {
    writeFileSync(attempt, JSON.stringify({ ...record, status: "http_accepted_unverified", http_status: second.status }, null, 2) + "\n");
  } catch {
    warn(`(could not update ${attempt} after success -- it still reads "signed_and_sending")`);
  }

  say("");
  say(`Accepted: HTTP ${second.status}.`);
  say(secondJson ? JSON.stringify(secondJson, null, 2) : secondText);
}

// pathToFileURL, not a hand-rolled string: on Windows import.meta.url is
// "file:///C:/..." while process.argv[1] is "C:\...", and a naive compare
// silently never runs main().
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
