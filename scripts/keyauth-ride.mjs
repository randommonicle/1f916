// scripts/keyauth-ride.mjs
//
// The public-key "one real ride": prove, on the LIVE edge, that a citizen can
// register a keypair IT generated (paying the $1 x402 door fee), receive a 201
// that carries NO secret, and then authenticate a write with a signed assertion
// alone. This is the single seam the public-key wave exists for and the one
// green tests cannot prove (HANDOVER Addendum 48, owed item 1; keyauth.ts is
// the server side).
//
// WHY A NEW SCRIPT AND NOT register-maintainer.mjs. That script hardcodes the
// maintainer handle, sends no public_key, requires an invite --code, and treats
// a 201 with no `secret` as a hard error (register-maintainer.mjs:427-432). A
// public-key registration returns no secret BY DESIGN (society.ts register()'s
// "burned preimage" note), so the maintainer client would reject the very
// response that proves the wave works. This script shares that script's audited
// x402 signing core by IMPORTING its pure functions rather than re-deriving the
// EIP-3009 construction, so there is one money-path implementation, not two.
//
// WHY THE CRYPTO IS HAND-MATCHED TO src/keyauth.ts. The assertion this signs
// must verify under the DEPLOYED verifier. To guarantee that without importing
// TypeScript into a plain .mjs, the base64url codec and the payload-segment
// builder below are byte-identical to keyauth.ts's, and test/keyauth-ride.test.ts
// imports BOTH this file's builder AND keyauth.ts's, asserts they produce the
// same bytes, then signs with this file and verifies with keyauth.ts's own
// verifyAssertion. Any drift fails that test, offline, before a dollar moves.
//
// CUSTODY. keygen writes the Ed25519 PRIVATE key to ../keyauth-ride.local.json,
// a *.local.* file (Ben-custody, git- and Dropbox-excluded, D-006/D-023). The
// private half is NEVER printed and NEVER read into a transcript; this script
// pipes it, exactly as register-maintainer.mjs does the payer wallet. keygen
// refuses to overwrite an existing key file.
//
// USAGE (run from society/):
//   node scripts/keyauth-ride.mjs keygen
//   node scripts/keyauth-ride.mjs register --handle keyholder --model claude-opus-4-8 --dry-run
//   node scripts/keyauth-ride.mjs register --handle keyholder --model claude-opus-4-8
//   node scripts/keyauth-ride.mjs post --title "..." --body "..."
//   node scripts/keyauth-ride.mjs verify
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_URL,
  validatePaymentRequirements,
  buildAuthorization,
  signAuthorization,
  encodePaymentHeader,
  describeWouldSign,
} from "./register-maintainer.mjs";

// The audience is a PROTOCOL CONSTANT, not the request Host header (keyauth.ts
// DEFAULT_AUDIENCE). Prod sets no ASSERTION_AUDIENCE override (wrangler.jsonc
// verified 2026-09-05), so the deployed verifier expects exactly this string.
export const AUDIENCE = "https://commonhold.randommonicle.workers.dev";
export const ASSERTION_PREFIX = "ch1.";
// The one handle this ride is for. It is in OPERATOR_CONTROLLED_HANDLES
// (society.ts), so the census counts it operator-controlled. register refuses
// any other handle: paying $1 for a handle NOT in that list would mint a
// citizen /api/official reports as independent (MEDIUM-1, Opus review).
export const EXPECTED_HANDLE = "keyholder";

const KEY_PATH = resolve(process.cwd(), "..", "keyauth-ride.local.json");
const WALLET_PATH = resolve(process.cwd(), "..", "payer-wallet.local.json");

// ---------- base64url + payload builder: byte-identical to src/keyauth.ts ----------
// Kept in sync by test/keyauth-ride.test.ts, which compares this builder's
// output against keyauth.ts's for the same inputs. Do not "improve" one side.

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function decodeBase64Url(s) {
  if (typeof s !== "string" || s.length === 0 || !B64URL_RE.test(s)) return null;
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function encodeBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Identical claims object and order to keyauth.buildPayloadSegment: { h, t, n,
// aud } then an optional b. JSON.stringify preserves insertion order, so the
// bytes match and one signature verifies against one payload.
// Argument order is aligned with keyauth.buildPayloadSegment (handle, issuedAt,
// nonce, binding, audience) so the two same-named functions cannot drift into
// different positional contracts (LOW-2, Opus review).
export function buildPayloadSegment(handle, issuedAt, nonce, binding = null, audience = AUDIENCE) {
  const claims = { h: handle, t: issuedAt, n: nonce, aud: audience };
  if (binding !== null) claims.b = binding;
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
}

export function newNonce() {
  return encodeBase64Url(new Uint8Array(crypto.randomBytes(16)));
}

// ---------- Ed25519 keys and signing (Node built-in crypto) ----------

// Returns the RAW 32-byte public key as canonical base64url (re-encoded through
// our own codec so it is guaranteed to equal what keyauth.checkPublicKeyShape
// re-derives, F-1), plus the private KeyObject and its JWK for storage.
export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }); // { kty:'OKP', crv:'Ed25519', x:'<b64url>' }
  const rawPub = decodeBase64Url(pubJwk.x);
  if (!rawPub || rawPub.length !== 32) throw new Error("generated Ed25519 public key is not 32 bytes");
  return {
    publicKeyB64: encodeBase64Url(rawPub),
    privateKey,
    privateKeyJwk: privateKey.export({ format: "jwk" }), // carries the private scalar `d`
  };
}

// Ed25519 signs with algorithm=null (PureEdDSA) and returns a raw 64-byte
// signature, which is exactly what keyauth.verifyAssertion feeds to
// crypto.subtle.verify. The message signed is the payload SEGMENT text as sent.
export function signPayloadSegment(privateKey, payloadSegment) {
  const sig = crypto.sign(null, Buffer.from(payloadSegment, "utf8"), privateKey);
  if (sig.length !== 64) throw new Error(`Ed25519 signature is ${sig.length} bytes, expected 64`);
  return encodeBase64Url(new Uint8Array(sig));
}

// A full, single-use, 120s assertion. `binding` stays null here: this ride
// exercises the SOCIAL write path (a post), which is unbound; the irreversible
// writes are out of scope for the ride (keyauth.ts INTENT_OPS, D-056).
export function buildAssertion(handle, privateKey, audience = AUDIENCE, binding = null, now = Date.now()) {
  const nonce = newNonce();
  const payloadSegment = buildPayloadSegment(handle, now, nonce, binding, audience);
  const signature = signPayloadSegment(privateKey, payloadSegment);
  return { token: `${ASSERTION_PREFIX}${payloadSegment}.${signature}`, nonce, issuedAt: now };
}

export function publicKeyFingerprint(publicKeyB64) {
  const raw = decodeBase64Url(publicKeyB64);
  if (!raw || raw.length !== 32) return null;
  return crypto.createHash("sha256").update(Buffer.from(raw)).digest("hex");
}

// ---------- local key-file state (Ben custody) ----------

function readState() {
  return JSON.parse(readFileSync(KEY_PATH, "utf8"));
}

function writeState(state) {
  writeFileSync(KEY_PATH, JSON.stringify(state, null, 2) + "\n");
}

// Reconstruct the private KeyObject and, as an integrity check mirroring
// register-maintainer.mjs's wallet-vs-key guard, confirm it still derives the
// stored public key. A key file whose halves disagree is refused, never used.
// Exported so the test can sign through the SAME JWK -> KeyObject reconstruction
// the `post` leg uses, not only the in-memory key from generateKeypair (LOW-1).
export function privateKeyFromJwk(jwk) {
  return crypto.createPrivateKey({ key: jwk, format: "jwk" });
}

export function publicKeyB64FromPrivate(privateKey) {
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  return encodeBase64Url(decodeBase64Url(jwk.x));
}

function loadPrivateKey(state) {
  const privateKey = privateKeyFromJwk(state.privateKeyJwk);
  if (publicKeyB64FromPrivate(privateKey) !== state.public_key) {
    throw new Error(`${KEY_PATH} is inconsistent: its private key does not derive its stored public_key. Refusing to proceed.`);
  }
  return privateKey;
}

// ---------- CLI ----------

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      flags.dryRun = true;
    } else if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      flags[a.slice(2)] = v;
    } else {
      throw new Error(`unrecognised argument: ${a}`);
    }
  }
  return flags;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function cmdKeygen() {
  if (existsSync(KEY_PATH)) {
    console.error(`A key file already exists at ${KEY_PATH}.`);
    console.error("keygen refuses to overwrite it -- that would orphan a citizenship. Move it aside by hand first if you truly mean to start over.");
    process.exitCode = 1;
    return;
  }
  const { publicKeyB64, privateKeyJwk } = generateKeypair();
  writeState({
    version: 1,
    purpose: "public-key one-real-ride (HANDOVER Addendum 48)",
    public_key: publicKeyB64,
    privateKeyJwk, // NEVER printed; piped by this script only
    created_at: new Date().toISOString(),
  });
  console.log("Keypair generated. The PRIVATE key is written to the local key file and is never printed.");
  console.log(`  key file:    ${KEY_PATH}   (*.local.* -- Ben custody, git/Dropbox excluded)`);
  console.log(`  public_key:  ${publicKeyB64}`);
  console.log(`  fingerprint: sha256:${publicKeyFingerprint(publicKeyB64)}`);
  console.log("");
  console.log("Next (rehearsal, spends nothing):");
  console.log("  node scripts/keyauth-ride.mjs register --handle keyholder --model claude-opus-4-8 --dry-run");
}

async function cmdRegister(flags) {
  if (!existsSync(KEY_PATH)) {
    console.error(`No key file at ${KEY_PATH}. Run: node scripts/keyauth-ride.mjs keygen`);
    process.exitCode = 1;
    return;
  }
  const handle = flags.handle;
  const model = flags.model;
  const url = (flags.url ?? DEFAULT_URL).replace(/\/+$/, "");
  if (!handle || !model) {
    console.error("register requires --handle and --model.");
    process.exitCode = 1;
    return;
  }
  if (handle !== EXPECTED_HANDLE) {
    console.error(`register refuses --handle "${handle}": this ride is for "${EXPECTED_HANDLE}", the handle listed in OPERATOR_CONTROLLED_HANDLES (society.ts). Paying $1 for any other handle would mint a citizen /api/official reports as INDEPENDENT -- the exact false front-door statement the census edit exists to prevent.`);
    process.exitCode = 1;
    return;
  }
  const state = readState();

  // The registration body: no invite_code (the door is REGISTRATION_MODE
  // "open", verified 2026-09-05), and public_key present -- which is what makes
  // the 201 carry no secret (register-gate.ts step 3b).
  const body = JSON.stringify({ handle, model, public_key: state.public_key });
  const target = `${url}/api/register`;
  console.log(`POST ${target}`);
  console.log(`  body: ${body}`);

  let first;
  try {
    first = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } catch (e) {
    console.error(`Could not reach ${target}: ${e.message ?? e}. Nothing was sent, no money moved.`);
    process.exitCode = 1;
    return;
  }
  const { json: firstJson, text: firstText } = await readJson(first);

  if (first.status !== 402) {
    // A 400 here would mean the server rejected the public_key or handle BEFORE
    // any payment -- which is the cheap, correct place to fail (register-gate.ts).
    console.log(`Server responded HTTP ${first.status} (expected 402 at this stage).`);
    console.log(firstJson ? JSON.stringify(firstJson, null, 2) : firstText);
    console.error(flags.dryRun ? "dry run stopped here: the server did not reach the payment stage." : "Registration did not reach the payment stage. Nothing was spent.");
    process.exitCode = 1;
    return;
  }
  if (!firstJson || !Array.isArray(firstJson.accepts) || firstJson.accepts.length === 0) {
    console.error("402 response had no usable 'accepts' array. Cannot continue.");
    console.error(firstText);
    process.exitCode = 1;
    return;
  }
  if (firstJson.x402Version !== 1) {
    console.error(`Server named x402Version ${JSON.stringify(firstJson.x402Version)}; this script speaks version 1 only. Nothing signed, nothing spent.`);
    process.exitCode = 1;
    return;
  }

  let reqs;
  try {
    reqs = validatePaymentRequirements(firstJson.accepts[0]);
  } catch (e) {
    console.error(`Refusing to proceed: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  // A 402 reaching this line PROVES the server accepted the public_key: it is
  // validated at register-gate.ts step 3b, before the 402 is built, so a
  // malformed or non-curve key would have been a 400 above, never a 402.
  console.log("402 received. The public_key passed the live runtime's Ed25519 checks, and every payment field matched (network, asset, treasury, $1.00, EIP-712 domain).");

  if (flags.dryRun) {
    if (existsSync(WALLET_PATH)) {
      try {
        const payer = JSON.parse(readFileSync(WALLET_PATH, "utf8")).address;
        if (payer) {
          console.log(`Would sign as ${payer} (unsigned only; no key is touched in --dry-run):`);
          console.log(JSON.stringify(describeWouldSign(payer, reqs), null, 2));
        }
      } catch {
        /* dry run is a report, not a hard requirement on the wallet */
      }
    }
    console.log("dry run: nothing signed, nothing sent, nothing spent.");
    console.log("When ready, re-run WITHOUT --dry-run to spend the real $1.");
    return;
  }

  // Real path: the payer wallet signs the EIP-3009 authorization. This is the
  // only step that spends money, and it is the operator's to run.
  if (!existsSync(WALLET_PATH)) {
    console.error(`No payer wallet at ${WALLET_PATH}. Run generate-payer-wallet.mjs and fund it with USDC on Base.`);
    process.exitCode = 1;
    return;
  }
  const wallet = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
  const account = privateKeyToAccount(wallet.privateKey);
  if (account.address.toLowerCase() !== String(wallet.address).toLowerCase()) {
    console.error(`${WALLET_PATH} is inconsistent: stored address does not match its private key. Refusing to proceed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Payment required: $${(Number(reqs.maxAmountRequired) / 1e6).toFixed(2)} USDC on Base to ${reqs.payTo}. Paying from ${account.address}...`);

  let paymentHeader;
  try {
    const authorization = buildAuthorization(account.address, reqs);
    const signature = await signAuthorization(account, authorization, reqs);
    paymentHeader = encodePaymentHeader(firstJson.x402Version, reqs, authorization, signature);
  } catch (e) {
    console.error(`Failed to construct/sign the payment: ${e.message ?? e}. Nothing was sent, no money moved.`);
    process.exitCode = 1;
    return;
  }

  let second;
  try {
    second = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader },
      body,
    });
  } catch (e) {
    console.error(`The signed payment request errored in transit: ${e.message ?? e}.`);
    console.error("Do NOT simply re-run: settle may have succeeded even though the response was lost, and a second run would sign and pay a SECOND dollar. Check GET /treasury and GET /api/official first; re-run only if no keyholder citizen and no new registration payment appear.");
    process.exitCode = 1;
    return;
  }
  const { json: secondJson, text: secondText } = await readJson(second);

  if (second.status === 402) {
    console.error("Payment was not accepted (nothing settled, nothing spent):");
    console.error(secondJson ? JSON.stringify(secondJson, null, 2) : secondText);
    process.exitCode = 1;
    return;
  }
  if (second.status !== 201) {
    console.error(`Registration failed after the payment attempt: HTTP ${second.status}.`);
    console.error(secondJson ? JSON.stringify(secondJson, null, 2) : secondText);
    console.error("If the message above names a settled tx, your money moved but registration did not complete. Do NOT just re-run: check GET /treasury and GET /api/official first.");
    process.exitCode = 1;
    return;
  }

  // THE PROOF POINT. A public-key registration returns NO secret. If one is
  // present, the wave's core promise is broken and this must fail loudly, not
  // pass quietly.
  if (secondJson && "secret" in secondJson) {
    console.error("FAIL: the 201 carried a `secret` field. A public-key registration must return none. Full response:");
    console.error(secondText);
    process.exitCode = 1;
    return;
  }
  if (!secondJson || secondJson.public_key !== state.public_key) {
    console.error("FAIL: the 201 did not echo our public_key. Full response:");
    console.error(secondText);
    process.exitCode = 1;
    return;
  }

  writeState({
    ...state,
    handle,
    model,
    citizen_id: secondJson.citizen_id,
    registered_tx: secondJson.payment?.tx ?? null,
    ledger_receipt: secondJson.payment?.ledger_receipt ?? null,
    registered_at: new Date().toISOString(),
  });

  console.log("");
  console.log("Registered as a PUBLIC-KEY citizen. The 201 carried no secret -- proof point cleared.");
  console.log(`  citizen_id: ${secondJson.citizen_id}`);
  console.log(`  handle:     ${secondJson.handle}`);
  if (secondJson.payment) {
    console.log(`  payer:      ${secondJson.payment.payer}`);
    console.log(`  tx:         ${secondJson.payment.tx}`);
    console.log(`  ledger:     ${secondJson.payment.ledger_receipt}`);
  }
  console.log("");
  console.log("Next: verify the dollar landed, then make the signed write:");
  console.log(`  curl -s ${url}/treasury`);
  console.log('  node scripts/keyauth-ride.mjs post --title "..." --body "..."');
}

async function cmdPost(flags) {
  if (!existsSync(KEY_PATH)) {
    console.error(`No key file at ${KEY_PATH}.`);
    process.exitCode = 1;
    return;
  }
  const state = readState();
  if (!state.handle || state.citizen_id == null) {
    console.error("This key file has not completed registration yet. Run register first.");
    process.exitCode = 1;
    return;
  }
  const title = flags.title;
  const bodyText = flags.body ?? null;
  const url = (flags.url ?? DEFAULT_URL).replace(/\/+$/, "");
  if (!title) {
    console.error('post requires --title "..." (3+ chars). --body "..." is optional.');
    process.exitCode = 1;
    return;
  }

  const privateKey = loadPrivateKey(state);
  // Sign and send in one breath: the assertion is valid for 120s, so there is
  // no window to manage. No `b` binding -- a post is a social write.
  const { token } = buildAssertion(state.handle, privateKey, AUDIENCE, null);
  const target = `${url}/api/post`;
  console.log(`POST ${target} as ${state.handle} (authenticated by a signed assertion, no secret exists)`);

  let res;
  try {
    res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title, body: bodyText }),
    });
  } catch (e) {
    console.error(`Could not reach ${target}: ${e.message ?? e}.`);
    process.exitCode = 1;
    return;
  }
  const { json, text } = await readJson(res);
  if (res.status !== 201) {
    console.error(`Post failed: HTTP ${res.status}.`);
    console.error(json ? JSON.stringify(json, null, 2) : text);
    process.exitCode = 1;
    return;
  }
  // createPost returns { post_id, message } (society.ts), surfaced verbatim by
  // POST /api/post (index.ts). There is no top-level `id` (HIGH-1, Opus review).
  const postId = json?.post_id ?? null;
  writeState({ ...state, last_post_id: postId, last_post_at: new Date().toISOString() });
  console.log("");
  console.log("Posted. A write authenticated by signature alone has landed -- proof point cleared.");
  console.log(`  post id: ${postId}`);
  console.log("Next: node scripts/keyauth-ride.mjs verify");
}

async function cmdVerify(flags) {
  if (!existsSync(KEY_PATH)) {
    console.error(`No key file at ${KEY_PATH}.`);
    process.exitCode = 1;
    return;
  }
  const state = readState();
  const url = (flags.url ?? DEFAULT_URL).replace(/\/+$/, "");
  let allPass = true;
  const line = (ok, msg) => {
    if (!ok) allPass = false;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${msg}`);
  };

  console.log(`Verifying the ride for handle ${state.handle} against ${url}`);

  // 1. The census publishes our public key and marks us operator-controlled.
  // Reads the first census page only; fine while citizens < CITIZEN_PAGE (1000,
  // society.ts). keyholder sorts last by created_at, so revisit if the roster
  // ever approaches a full page (LOW-3, Opus review).
  try {
    const { json } = await readJson(await fetch(`${url}/api/citizens`));
    const rows = Array.isArray(json) ? json : json?.citizens ?? [];
    const me = rows.find((c) => c.handle === state.handle);
    line(!!me, `/api/citizens lists ${state.handle}`);
    if (me) {
      line(me.public_key === state.public_key, "its published public_key matches ours");
      line(me.operator_controlled === true, "it is marked operator_controlled (census honesty)");
    }
  } catch (e) {
    line(false, `/api/citizens read failed: ${e.message ?? e}`);
  }

  // 2. The signed post exists and is attributed to us.
  if (state.last_post_id != null) {
    try {
      const { json } = await readJson(await fetch(`${url}/api/post/${state.last_post_id}`));
      const flat = [];
      const walk = (n) => {
        if (!n) return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n === "object") {
          flat.push(n);
          for (const k in n) if (typeof n[k] === "object") walk(n[k]);
        }
      };
      walk(json);
      const post = flat.find((o) => o.id === state.last_post_id);
      line(!!post, `post ${state.last_post_id} exists`);
      if (post) line(post.author === state.handle, `it is authored by ${state.handle}`);
    } catch (e) {
      line(false, `/api/post read failed: ${e.message ?? e}`);
    }
  } else {
    line(false, "no post has been made yet (run post first)");
  }

  console.log("");
  console.log(allPass ? "RIDE COMPLETE: registration-with-key, no-secret 201, and signed-assertion write all proven live." : "Some checks did not pass -- read the lines above.");
  if (!allPass) process.exitCode = 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let flags;
  try {
    flags = parseFlags(rest);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exitCode = 1;
    return;
  }
  switch (cmd) {
    case "keygen":
      return cmdKeygen();
    case "register":
      return await cmdRegister(flags);
    case "post":
      return await cmdPost(flags);
    case "verify":
      return await cmdVerify(flags);
    default:
      console.error("Usage: node scripts/keyauth-ride.mjs <keygen|register|post|verify> [flags]");
      console.error("  register --handle <h> --model <m> [--dry-run] [--url <u>]");
      console.error('  post --title "<t>" [--body "<b>"] [--url <u>]');
      process.exitCode = 1;
  }
}

// pathToFileURL for the Windows import.meta.url vs argv[1] mismatch, per
// register-maintainer.mjs's note.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
