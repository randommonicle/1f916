// Real-D1 proofs for D-056: the six irreversible writes (ballot, proposal,
// moderate, wallet, payout, ledger) refuse a key citizen's assertion unless its
// signed "b" claim commits to exactly this operation with exactly these
// arguments. Bearer-secret citizens and server-internal (null-credential)
// callers are exempt by design — a permanent full-authority credential gains
// nothing from per-request intent, and the exemption is structural (D-056
// ruling 3).
//
// Real SQLite via createLocalD1 (real schema.sql), real Ed25519 via the
// runtime's own crypto.subtle, no mocks, no fixture signatures. Every refusal
// test also asserts the ABSENCE of the side effect, because a refusal that
// still wrote is the failure mode this wave exists to prevent.
//
// RED-PROOF DISCIPLINE: this file was written BEFORE the enforcement existed
// and run against the unbound handlers, where every refusal test failed
// (the write succeeded); the implementation then turned it green. That run is
// recorded in docs/CHECKPOINT-INTENT-BINDING.md.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertIdentityEvent, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { authenticate, moderateContent, recordLedger, register, rotateKey, SocietyError, type Env } from "../src/society.ts";
import { castBallot, createProposal } from "../src/governance.ts";
import { declareWallet } from "../src/wallets.ts";
import { recordPayout } from "../src/payouts.ts";
import {
  ASSERTION_PREFIX,
  buildIntentBinding,
  buildPayloadSegment,
  encodeBase64Url,
  newNonce,
  stableStringify,
} from "../src/keyauth.ts";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "open",
  } as unknown as Env;
}

async function realKeypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, publicKeyB64: encodeBase64Url(raw) };
}

// A fresh assertion per call: nonces are single-use, so every authenticate()
// in these tests signs anew, exactly as a real client must.
async function sign(kp: CryptoKeyPair, handle: string, binding: string | null = null): Promise<string> {
  const payload = buildPayloadSegment(handle, Date.now(), newNonce(), binding);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
  return `${ASSERTION_PREFIX}${payload}.${encodeBase64Url(sig)}`;
}

// Registers a key citizen through the real registration path and returns its
// signing kit. On an empty database the first registration is citizen 1 — the
// maintainer — which the maintainer-op tests rely on and assert.
async function keyCitizen(env: Env, handle: string) {
  const { kp, publicKeyB64 } = await realKeypair();
  const out = (await register(env, handle, "claude-fable-5", null, publicKeyB64)) as { citizen_id: number };
  return { kp, publicKeyB64, id: out.citizen_id };
}

async function countRows(d1: LocalD1, table: string): Promise<number> {
  const row = await d1.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

function rejectsIntent(fn: () => Promise<unknown>, kind: "unbound" | "mismatch") {
  return assert.rejects(
    fn,
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 403 &&
      (kind === "unbound" ? /carries no signed intent/.test(e.message) : /commits to a different action/.test(e.message)),
  );
}

// ---------- ballot ----------

test("ballot: an UNBOUND assertion is refused with the recipe, no ballot lands, and the nonce is burned (D-056 rulings 2 and 5)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenKit = await keyCitizen(env, "keyvoter");
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open" });

    const token = await sign(citizenKit.kp, "keyvoter");
    const citizen = await authenticate(env, token);

    await assert.rejects(
      () => castBallot(env, citizen, proposalId, "yes", token),
      (e: unknown) =>
        e instanceof SocietyError &&
        e.status === 403 &&
        /carries no signed intent/.test(e.message) &&
        /ballot:[0-9a-f]{64}/.test(e.message),
      "the refusal must teach the exact binding to sign — it is derived from the caller's own request, so revealing it arms nobody",
    );

    assert.equal(await countRows(d1, "ballots"), 0, "the refused ballot must not have landed");
    // Ruling 5, pinned: the nonce was burned by authenticate() before the
    // binding was judged. Any captured assertion can be burned via `me`
    // regardless, so refusal-burn adds no new denial surface — but it is a
    // CHOICE, and this assertion keeps it visible.
    assert.equal(await countRows(d1, "auth_nonces"), 1, "the nonce is consumed even though the write was refused");
  } finally {
    d1.close();
  }
});

test("ballot: a binding with the CHOICE swapped is refused — CODEX's argument-substitution case, the reason op-only binding was rejected", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenKit = await keyCitizen(env, "keyvoter");
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open" });

    // Signed for "yes"; the request says "no". An intermediary that captured
    // the yes-assertion must not be able to cast any other ballot with it.
    const bound = await buildIntentBinding("ballot", [String(proposalId), "yes"]);
    const token = await sign(citizenKit.kp, "keyvoter", bound);
    const citizen = await authenticate(env, token);

    await rejectsIntent(() => castBallot(env, citizen, proposalId, "no", token), "mismatch");
    assert.equal(await countRows(d1, "ballots"), 0);
  } finally {
    d1.close();
  }
});

test("ballot: a binding for a DIFFERENT operation (wallet) is refused — the me-becomes-ballot substitution, cross-op direction", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenKit = await keyCitizen(env, "keyvoter");
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open" });

    const walletBound = await buildIntentBinding("wallet", ["0x1111111111111111111111111111111111111111"]);
    const token = await sign(citizenKit.kp, "keyvoter", walletBound);
    const citizen = await authenticate(env, token);

    await rejectsIntent(() => castBallot(env, citizen, proposalId, "yes", token), "mismatch");
    assert.equal(await countRows(d1, "ballots"), 0);
  } finally {
    d1.close();
  }
});

test("ballot: the CORRECT binding casts, seals into the chain, and a bearer citizen still votes with no binding at all", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenKit = await keyCitizen(env, "keyvoter");
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open" });

    const bound = await buildIntentBinding("ballot", [String(proposalId), "yes"]);
    const token = await sign(citizenKit.kp, "keyvoter", bound);
    const citizen = await authenticate(env, token);

    const out = await castBallot(env, citizen, proposalId, "yes", token);
    assert.equal(out.choice, "yes");
    assert.equal(typeof out.chain_head, "string");

    // Bearer exemption (D-056 ruling 3): a legacy secret is already full
    // authority; it authorises with no binding, both as a raw secret string
    // and as the null credential server-internal callers pass.
    const bearerId = insertCitizen(d1);
    const bearer = { id: bearerId, created_at: Date.now() };
    const viaSecret = await castBallot(env, bearer, proposalId, "no", "commonhold_sk_" + "0".repeat(64));
    assert.equal(viaSecret.choice, "no");

    assert.equal(await countRows(d1, "ballots"), 2);
  } finally {
    d1.close();
  }
});

// ---------- rotate cross-shape (both directions) ----------

test("a ballot-bound assertion cannot rotate (its binding is never a valid key), and a rotate-style bare-key binding cannot ballot", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenKit = await keyCitizen(env, "keyvoter");
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open" });

    // Direction one: captured ballot assertion raced into rotation. The op
    // prefix contains ":", which base64url forbids, so the rotation branch
    // refuses it as a key mismatch and custody cannot move.
    const ballotBound = await buildIntentBinding("ballot", [String(proposalId), "yes"]);
    const tokenA = await sign(citizenKit.kp, "keyvoter", ballotBound);
    const citizenA = await authenticate(env, tokenA);
    const { publicKeyB64: attackerKey } = await realKeypair();
    await assert.rejects(
      () => rotateKey(env, citizenA, attackerKey, tokenA),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /different key/.test(e.message),
    );
    const stored = await d1.DB.prepare("SELECT public_key FROM citizens WHERE id = ?").bind(citizenA.id).first<{ public_key: string }>();
    assert.equal(stored?.public_key, citizenKit.publicKeyB64, "custody must not have moved");

    // Direction two: a captured ROTATE assertion (b = the bare replacement
    // key) raced into a ballot. It carries no op prefix, so it can never equal
    // an intent binding.
    const { publicKeyB64: replacement } = await realKeypair();
    const tokenB = await sign(citizenKit.kp, "keyvoter", replacement);
    const citizenB = await authenticate(env, tokenB);
    await rejectsIntent(() => castBallot(env, citizenB, proposalId, "yes", tokenB), "mismatch");
    assert.equal(await countRows(d1, "ballots"), 0);
  } finally {
    d1.close();
  }
});

// ---------- proposal ----------

test("proposal: unbound refused with NO rows anywhere; the correct binding (payload via stableStringify) opens one", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenKit = await keyCitizen(env, "keyproposer");
    // Tenure: a freshly registered citizen is not yet eligible to propose, and
    // eligibility is not what this file tests. Backdate the row, then
    // re-authenticate so the citizen object carries the backdated created_at.
    await d1.DB.prepare("UPDATE citizens SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 90 * 86_400_000, citizenKit.id)
      .run();

    const title = "A test resolution";
    const body = "Resolve that the intent binding holds.";

    const tokenUnbound = await sign(citizenKit.kp, "keyproposer");
    const citizen1 = await authenticate(env, tokenUnbound);
    await rejectsIntent(() => createProposal(env, citizen1, "resolution", title, body, null, tokenUnbound), "unbound");
    assert.equal(await countRows(d1, "proposals"), 0, "no proposal row from the refused attempt");
    assert.equal(await countRows(d1, "posts"), 0, "no debate post either — the refusal must precede every write");

    const bound = await buildIntentBinding("proposal", ["resolution", title, body, ""]);
    const token = await sign(citizenKit.kp, "keyproposer", bound);
    const citizen2 = await authenticate(env, token);
    const out = await createProposal(env, citizen2, "resolution", title, body, null, token);
    assert.equal(out.kind, "resolution");
    assert.equal(await countRows(d1, "proposals"), 1);

    // And with a structured payload the binding commits to its stableStringify
    // spelling, so key order in the caller's JSON cannot change the digest.
    // A SECOND key citizen (one open proposal per citizen), made a founder the
    // way isFounderCitizen defines one (an invite_redeemed identity event),
    // because set_name is founder-gated before founding completes.
    const kit2 = await keyCitizen(env, "keyproposer2");
    await d1.DB.prepare("UPDATE citizens SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 90 * 86_400_000, kit2.id)
      .run();
    insertIdentityEvent(d1, kit2.id, "invite_redeemed");
    const title2 = "Ratify the founding name";
    const body2 = "Confirm the name by vote.";
    const payload = { name: "Commonhold" };
    const bound2 = await buildIntentBinding("proposal", ["set_name", title2, body2, stableStringify(payload)]);
    const token2 = await sign(kit2.kp, "keyproposer2", bound2);
    const citizen3 = await authenticate(env, token2);
    const out2 = await createProposal(env, citizen3, "set_name", title2, body2, payload, token2);
    assert.equal(out2.kind, "set_name");
  } finally {
    d1.close();
  }
});

// ---------- moderate (maintainer-only, and the maintainer can be a key citizen) ----------

test("moderate: the key-citizen maintainer needs a binding over (type, id, action, reason); unbound is refused pre-write; null credential (server-internal judgment calls) stays exempt", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const maintainer = await keyCitizen(env, "commonhold-agent");
    assert.equal(maintainer.id, 1, "first registration must be citizen 1, the maintainer, or these tests are not testing maintainer ops");

    await d1.DB.prepare(
      "INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (1, 'target', 'body', 'dupe-x', 0, 'm', ?)",
    )
      .bind(Date.now())
      .run();
    const post = await d1.DB.prepare("SELECT id FROM posts WHERE title = 'target'").first<{ id: number }>();
    const postId = post!.id;

    const tokenUnbound = await sign(maintainer.kp, "commonhold-agent");
    const citizen1 = await authenticate(env, tokenUnbound);
    await rejectsIntent(() => moderateContent(env, citizen1, "post", postId, "collapse", "test reason", tokenUnbound), "unbound");
    const untouched = await d1.DB.prepare("SELECT mod_state FROM posts WHERE id = ?").bind(postId).first<{ mod_state: string | null }>();
    assert.equal(untouched?.mod_state ?? null, null, "the refused moderation must not have collapsed anything");

    const bound = await buildIntentBinding("moderate", ["post", String(postId), "collapse", "test reason"]);
    const token = await sign(maintainer.kp, "commonhold-agent", bound);
    const citizen2 = await authenticate(env, token);
    const out = await moderateContent(env, citizen2, "post", postId, "collapse", "test reason", token);
    assert.equal(out.mod_state, "collapsed");

    // The judgment wake moderates with the maintainer's citizen row and NO
    // transport credential (src/maintainer/judgment.ts) — that path must keep
    // working, and its exemption is the null credential, not a special case.
    const out2 = await moderateContent(env, { ...citizen2 }, "post", postId, "restore", null, null);
    assert.equal(out2.mod_state, null);
  } finally {
    d1.close();
  }
});

// ---------- wallet ----------

test("wallet: key citizen binds the address as SUPPLIED; unbound refused with no row and no identity event; bearer unaffected", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenKit = await keyCitizen(env, "keyholder");
    const address = "0xAbCd000000000000000000000000000000000001"; // mixed case on purpose: the binding is over the string as sent, not the normalised form

    const tokenUnbound = await sign(citizenKit.kp, "keyholder");
    const citizen1 = await authenticate(env, tokenUnbound);
    await rejectsIntent(() => declareWallet(env, citizen1, address, tokenUnbound), "unbound");
    assert.equal(await countRows(d1, "wallets"), 0);
    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind LIKE 'wallet%'").first<{ n: number }>();
    assert.equal(events?.n ?? 0, 0, "no wallet_declared event from the refused attempt");

    const bound = await buildIntentBinding("wallet", [address]);
    const token = await sign(citizenKit.kp, "keyholder", bound);
    const citizen2 = await authenticate(env, token);
    const out = await declareWallet(env, citizen2, address, token);
    assert.equal(out.address, address.toLowerCase());

    const bearerId = insertCitizen(d1);
    const viaBearer = await declareWallet(env, { id: bearerId }, "0x2222222222222222222222222222222222222222", "commonhold_sk_" + "1".repeat(64));
    assert.equal(viaBearer.address, "0x2222222222222222222222222222222222222222");
  } finally {
    d1.close();
  }
});

// ---------- payout ----------

test("payout: the key-citizen maintainer binds (citizen_id, amount_cents, reason, tx); unbound refused with neither chain written", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const maintainer = await keyCitizen(env, "commonhold-agent");
    assert.equal(maintainer.id, 1);

    const targetId = insertCitizen(d1);
    await declareWallet(env, { id: targetId }, "0x3333333333333333333333333333333333333333", null);

    const tokenUnbound = await sign(maintainer.kp, "commonhold-agent");
    const citizen1 = await authenticate(env, tokenUnbound);
    await rejectsIntent(() => recordPayout(env, citizen1, targetId, 250, "test bounty", "0xdeadbeef", tokenUnbound), "unbound");
    assert.equal(await countRows(d1, "payouts"), 0, "no payout row from the refused attempt");
    assert.equal(await countRows(d1, "ledger"), 0, "and no ledger row — the pair commits together, so both must be absent");

    const bound = await buildIntentBinding("payout", [String(targetId), "250", "test bounty", "0xdeadbeef"]);
    const token = await sign(maintainer.kp, "commonhold-agent", bound);
    const citizen2 = await authenticate(env, token);
    const out = await recordPayout(env, citizen2, targetId, 250, "test bounty", "0xdeadbeef", token);
    assert.equal(out.amount_cents, 250);
    assert.equal(await countRows(d1, "payouts"), 1);
    assert.equal(await countRows(d1, "ledger"), 1);
  } finally {
    d1.close();
  }
});

// ---------- ledger ----------

test("ledger: the sealed treasury chain is a bound op (the criterion catch D-056 flags); unbound refused, bound entry seals", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const maintainer = await keyCitizen(env, "commonhold-agent");
    assert.equal(maintainer.id, 1);

    const tokenUnbound = await sign(maintainer.kp, "commonhold-agent");
    const citizen1 = await authenticate(env, tokenUnbound);
    await rejectsIntent(() => recordLedger(env, citizen1, "test inflow, tx 0xabc", 100, tokenUnbound), "unbound");
    assert.equal(await countRows(d1, "ledger"), 0);

    const bound = await buildIntentBinding("ledger", ["test inflow, tx 0xabc", "100"]);
    const token = await sign(maintainer.kp, "commonhold-agent", bound);
    const citizen2 = await authenticate(env, token);
    const out = await recordLedger(env, citizen2, "test inflow, tx 0xabc", 100, token);
    assert.equal(typeof out.receipt, "string");
    assert.equal(await countRows(d1, "ledger"), 1);
  } finally {
    d1.close();
  }
});
