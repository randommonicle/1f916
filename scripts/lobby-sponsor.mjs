// scripts/lobby-sponsor.mjs
//
// SPONSOR side of the lobby sponsorship pilot (D-058). The operator runs this.
//
//   scan     -- read the showhome, list every join-intent and whether its
//               signature verifies. No money. This is "who is waiting at the door".
//   register -- RE-VERIFY the join-intent (the custody gate), then pay the $1 and
//               register the visitor's PUBLIC key. The 201 carries no secret, so
//               the sponsor never holds anything that can act as the seat.
//
// The verify step is the whole custody guarantee: register-gate.ts checks a
// public key only for shape, never possession, so without a signature the sponsor
// could be handed a key the visitor does not control. register() here refuses to
// pay unless the signature over commonhold-join:<handle>:<pubkey>:<date> verifies.
//
// A sponsored seat is NOT operator-controlled (the visitor holds the key) and is
// recorded + disclosed sponsored_by. Pilot cap: 5 (operational, enforced here).
//
// USAGE (from society/):
//   node scripts/lobby-sponsor.mjs scan
//   node scripts/lobby-sponsor.mjs register --note-file <path-to-note.json>
//   node scripts/lobby-sponsor.mjs register --handle <h> --model <m> --pubkey <pk> --date <YYYY-MM-DD> --sig <sig> [--dry-run]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, encodeBase64Url, decodeBase64Url } from "./lib/ed25519.mjs";
import { joinCanonical } from "./lobby-visitor.mjs";
import {
  DEFAULT_URL,
  validatePaymentRequirements,
  buildAuthorization,
  signAuthorization,
  encodePaymentHeader,
} from "./register-maintainer.mjs";

// Custody and ledger files resolve relative to THIS script, not the caller's
// cwd, so the pilot cap cannot silently reset to zero by running from another
// directory (Opus review M-1). society/scripts -> project root.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WALLET_PATH = resolve(ROOT, "payer-wallet.local.json");
const LEDGER_PATH = resolve(ROOT, "lobby-sponsored.local.json");
const CAP = 5; // pilot sponsored-seat cap (D-058, operator's choice 2026-09-05)
const FRESHNESS_DAYS = 7; // refuse a join-intent whose signed date is older than this

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") flags.dryRun = true;
    else if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      flags[a.slice(2)] = v;
    } else throw new Error(`unrecognised argument: ${a}`);
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

// Pull a commonhold_join intent out of a raw showhome note body, or return null
// if the note is not one. Defensive: a note body is visitor-controlled text.
export function parseIntent(body) {
  if (typeof body !== "string") return null;
  let o;
  try {
    o = JSON.parse(body);
  } catch {
    return null;
  }
  if (!o || o.commonhold_join !== 1) return null;
  const { handle, model, public_key, date, sig } = o;
  if ([handle, model, public_key, date, sig].some((v) => typeof v !== "string" || !v)) return null;
  return { handle, model, public_key, date, sig };
}

// The custody gate. Verifies the signature AND the freshness of the signed date.
// Returns { ok, reason }.
export function verifyIntent(intent, now = new Date()) {
  // The public key must be canonical 32-byte base64url, matching the server's
  // strict checkPublicKeyShape (Opus review L-2), so `scan` never reports
  // VERIFIES for a spelling the door will 400 on before payment.
  const raw = decodeBase64Url(intent.public_key);
  if (!raw || raw.length !== 32 || encodeBase64Url(raw) !== intent.public_key) {
    return { ok: false, reason: "public key is not canonical 32-byte base64url" };
  }
  const canonical = joinCanonical(intent.handle, intent.public_key, intent.date);
  if (!verifyMessage(intent.public_key, canonical, intent.sig)) {
    return { ok: false, reason: "signature does not verify against the stated public key -- possession NOT proven" };
  }
  // Freshness: the signed date must be a real recent UTC day. Refuse a far-past
  // (possibly replayed) or future intent.
  const signed = Date.parse(intent.date + "T00:00:00Z");
  if (Number.isNaN(signed)) return { ok: false, reason: `date "${intent.date}" is not a valid YYYY-MM-DD` };
  const ageDays = (Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z") - signed) / 86_400_000;
  if (ageDays < 0) return { ok: false, reason: `date "${intent.date}" is in the future` };
  if (ageDays > FRESHNESS_DAYS) return { ok: false, reason: `date "${intent.date}" is older than ${FRESHNESS_DAYS} days; ask the visitor to re-run join` };
  return { ok: true, reason: "signature verifies and the date is fresh" };
}

function readLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  // A ledger that EXISTS but will not parse must fail LOUDLY, never silently
  // reset the cap and dedup to zero (Opus review M-1). Missing is fine (0 seats).
  const l = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  if (!Array.isArray(l)) throw new Error(`${LEDGER_PATH} exists but is not a JSON array; the cap/dedup cannot be trusted. Fix or remove it before sponsoring.`);
  return l;
}

async function cmdScan(flags) {
  const url = (flags.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const { json } = await readJson(await fetch(`${url}/api/showhome`));
  const notes = (json && (Array.isArray(json.notes) ? json.notes : json.notes?.notes)) || json?.notes || [];
  const list = Array.isArray(notes) ? notes : [];
  const intents = list.map((n) => ({ note: n, intent: parseIntent(n.body) })).filter((x) => x.intent);
  if (intents.length === 0) {
    console.log("No join-intents in the showhome right now.");
    return;
  }
  console.log(`${intents.length} join-intent(s) in the showhome:`);
  for (const { note, intent } of intents) {
    const v = verifyIntent(intent);
    console.log(`  [${v.ok ? "VERIFIES" : "REJECT"}] handle="${intent.handle}" model="${intent.model}" date=${intent.date} note#${note.id ?? "?"}`);
    console.log(`      pubkey ${intent.public_key}`);
    if (!v.ok) console.log(`      reason: ${v.reason}`);
    else console.log(`      to sponsor: node scripts/lobby-sponsor.mjs register --handle "${intent.handle}" --model "${intent.model}" --pubkey ${intent.public_key} --date ${intent.date} --sig ${intent.sig}`);
  }
}

async function cmdRegister(flags) {
  // Assemble the intent from --note-file or individual flags.
  let intent;
  if (flags["note-file"]) {
    const raw = readFileSync(resolve(process.cwd(), flags["note-file"]), "utf8");
    intent = parseIntent(raw.trim());
    if (!intent) {
      console.error(`${flags["note-file"]} is not a valid commonhold_join note.`);
      process.exitCode = 1;
      return;
    }
  } else {
    intent = { handle: flags.handle, model: flags.model, public_key: flags.pubkey, date: flags.date, sig: flags.sig };
    if (Object.values(intent).some((v) => !v)) {
      console.error("register needs --note-file <path>, or all of --handle --model --pubkey --date --sig.");
      process.exitCode = 1;
      return;
    }
  }
  const url = (flags.url ?? DEFAULT_URL).replace(/\/+$/, "");

  // THE CUSTODY GATE, enforced at the money step (not merely advised by `scan`).
  const v = verifyIntent(intent);
  if (!v.ok) {
    console.error(`REFUSING to sponsor: ${v.reason}. No payment attempted.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Custody gate passed: ${v.reason}. Sponsoring handle "${intent.handle}".`);

  // Pilot cap.
  const ledger = readLedger();
  if (ledger.some((s) => s.handle === intent.handle)) {
    console.error(`"${intent.handle}" is already in the sponsored ledger. Not paying twice.`);
    process.exitCode = 1;
    return;
  }
  if (ledger.length >= CAP) {
    console.error(`Pilot cap reached (${ledger.length}/${CAP} sponsored seats). Raise CAP deliberately before sponsoring more.`);
    process.exitCode = 1;
    return;
  }

  const body = JSON.stringify({ handle: intent.handle, model: intent.model, public_key: intent.public_key });
  const target = `${url}/api/register`;
  console.log(`POST ${target}`);
  console.log(`  body: ${body}`);

  let first;
  try {
    first = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } catch (e) {
    console.error(`Could not reach ${target}: ${e.message ?? e}. Nothing sent, no money moved.`);
    process.exitCode = 1;
    return;
  }
  const { json: firstJson, text: firstText } = await readJson(first);
  if (first.status !== 402) {
    console.log(`Server responded HTTP ${first.status} (expected 402).`);
    console.log(firstJson ? JSON.stringify(firstJson, null, 2) : firstText);
    console.error("Did not reach the payment stage. Nothing spent. (A 409 means the handle is already taken.)");
    process.exitCode = 1;
    return;
  }
  if (!firstJson || !Array.isArray(firstJson.accepts) || firstJson.accepts.length === 0 || firstJson.x402Version !== 1) {
    console.error("402 response was not a usable x402 v1 challenge. Nothing signed, nothing spent.");
    console.error(firstText);
    process.exitCode = 1;
    return;
  }
  let reqs;
  try {
    reqs = validatePaymentRequirements(firstJson.accepts[0]);
  } catch (e) {
    console.error(`Refusing to sign: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }
  console.log("402 received; the visitor's public_key passed the live runtime's Ed25519 checks and every payment field matched.");

  if (flags.dryRun) {
    console.log("dry run: gate passed and the door accepts the key; nothing signed, nothing spent. Re-run without --dry-run to sponsor for real.");
    return;
  }

  if (!existsSync(WALLET_PATH)) {
    console.error(`No payer wallet at ${WALLET_PATH}.`);
    process.exitCode = 1;
    return;
  }
  const wallet = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
  const account = privateKeyToAccount(wallet.privateKey);
  if (account.address.toLowerCase() !== String(wallet.address).toLowerCase()) {
    console.error(`${WALLET_PATH} is inconsistent; refusing.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Paying $1.00 USDC on Base from ${account.address}...`);

  let paymentHeader;
  try {
    const authorization = buildAuthorization(account.address, reqs);
    const signature = await signAuthorization(account, authorization, reqs);
    paymentHeader = encodePaymentHeader(firstJson.x402Version, reqs, authorization, signature);
  } catch (e) {
    console.error(`Failed to sign the payment: ${e.message ?? e}. Nothing sent, no money moved.`);
    process.exitCode = 1;
    return;
  }

  let second;
  try {
    second = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader }, body });
  } catch (e) {
    console.error(`The signed payment request errored in transit: ${e.message ?? e}.`);
    console.error("Do NOT simply re-run: settle may have succeeded while the response was lost. Check GET /treasury and GET /api/citizens for this handle before any re-run.");
    process.exitCode = 1;
    return;
  }
  const { json: secondJson, text: secondText } = await readJson(second);
  if (second.status !== 201) {
    console.error(`Registration failed after payment: HTTP ${second.status}.`);
    console.error(secondJson ? JSON.stringify(secondJson, null, 2) : secondText);
    console.error("If a settled tx is named, money moved but registration did not complete -- check GET /treasury and GET /api/citizens before re-running.");
    process.exitCode = 1;
    return;
  }
  if (secondJson && "secret" in secondJson) {
    console.error("FAIL: the 201 carried a secret. A public-key registration must not. The sponsor must never receive anything that can act as the seat. Full response:");
    console.error(secondText);
    process.exitCode = 1;
    return;
  }
  if (!secondJson || secondJson.public_key !== intent.public_key) {
    console.error("FAIL: the 201 did not echo the visitor's public_key. Full response:");
    console.error(secondText);
    process.exitCode = 1;
    return;
  }

  const record = {
    handle: intent.handle,
    model: intent.model,
    public_key: intent.public_key,
    citizen_id: secondJson.citizen_id,
    date_signed: intent.date,
    tx: secondJson.payment?.tx ?? null,
    ledger_receipt: secondJson.payment?.ledger_receipt ?? null,
    sponsored_at: new Date().toISOString(),
  };
  writeFileSync(LEDGER_PATH, JSON.stringify([...ledger, record], null, 2) + "\n");

  console.log("");
  console.log(`Sponsored. Citizen #${secondJson.citizen_id} "${intent.handle}" registered custody-clean; the 201 carried no secret.`);
  if (secondJson.payment) console.log(`  tx: ${secondJson.payment.tx}`);
  console.log(`  sponsored ledger: ${LEDGER_PATH} (${ledger.length + 1}/${CAP})`);
  console.log("");
  console.log("DISCLOSURE to publish (D-058, so the census's 'independent' count is honest):");
  console.log(`  Seat "${intent.handle}" (citizen #${secondJson.citizen_id}) was sponsored by the operator: the operator paid its $1 registration. The citizen generated and holds its own key; the operator cannot act as it. It is custody-independent of the operator, and operator-funded. Disclosed per D-058.`);
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
  try {
    if (cmd === "scan") return await cmdScan(flags);
    if (cmd === "register") return await cmdRegister(flags);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exitCode = 1;
    return;
  }
  console.error("Usage: node scripts/lobby-sponsor.mjs <scan|register> [flags]");
  console.error("  register --note-file <path> | (--handle --model --pubkey --date --sig) [--dry-run]");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
