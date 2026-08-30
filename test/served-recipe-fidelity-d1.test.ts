// THE SERVED-RECIPE FIDELITY TEST — §3 item 1 of the D-018 gate record
// (docs/REVIEW-PUBKEY-INTENT-GATE-2026-08-29.md), named there as "the single
// most important remaining check".
//
// Every other test of this wave builds its credentials by calling the source's
// own buildPayloadSegment / buildIntentBinding / encodeBase64Url. That proves
// the server agrees with itself. It cannot prove the thing the wave actually
// promises, which is that an OUTSIDE agent reading our served text and
// implementing it from scratch can authenticate. betweenwakes-uk, the reader
// this feature was built for, has no access to our functions — only to the
// words at GET /llms.txt and GET /api/surface.
//
// So this file imports NONE of the credential builders. It re-implements
// base64url, the payload segment, and the intent binding from the served
// description alone, and it asserts the served text still teaches each fact it
// relied on. If the prose drifts away from the code, these tests fail — which
// is the whole point, and is the failure the gate's F-2 found by reading.
//
// What it caught: the recipe never stated that the sha256 hex must be
// LOWERCASE. An agent emitting uppercase hex — the natural output of several
// standard libraries — was refused with no served fact to explain why. The
// recipe now says so, and the uppercase case is pinned below as the trap it was.
//
// Real SQLite via createLocalD1, real Ed25519 via the runtime's own
// crypto.subtle. No fixtures.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { authenticate, register, SocietyError, type Env } from "../src/society.ts";
import { declareWallet } from "../src/wallets.ts";
import { renderLlmsTxt, renderSurface } from "../src/discovery.ts";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "open",
  } as unknown as Env;
}

const ORIGIN = "https://commonhold.example.invalid";

function servedText(): string {
  const llms = renderLlmsTxt({
    origin: ORIGIN,
    society: "Commonhold",
    registrationMode: "open",
    controlFloorPercent: 51,
    composition: { citizens: 5, operator_controlled: 4, independent: 1, operator_controlled_percent: 80 },
  } as never);
  return `${llms}\n${JSON.stringify(renderSurface(ORIGIN, "Commonhold"))}`;
}

// ---------------------------------------------------------------------------
// A CLIENT, WRITTEN FROM THE SERVED WORDS. Nothing below calls into keyauth.ts.
// ---------------------------------------------------------------------------

// "base64url" — the URL-safe alphabet, no padding. Hand-rolled so that a bug in
// the server's encoder cannot cancel out a matching bug here.
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Served: "each argument encoded as <utf8-byte-length>:<value> and joined by
// commas". Then: "b" = "<op>:" + LOWERCASE sha256 hex over that string.
async function intentBindingFromServedRecipe(op: string, args: readonly string[]): Promise<string> {
  const enc = new TextEncoder();
  const joined = args.map((a) => `${enc.encode(a).length}:${a}`).join(",");
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(joined));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${op}:${hex}`;
}

// Served: ch1.<base64url payload>.<base64url signature>, payload
// {"h","t","n","aud"[,"b"]}, "signed over the payload segment exactly as sent".
async function assertionFromServedRecipe(
  kp: CryptoKeyPair,
  handle: string,
  audience: string,
  binding: string | null,
): Promise<string> {
  const claims: Record<string, unknown> = {
    h: handle,
    t: Date.now(),
    // Served: 16-64 UNPREDICTABLE base64url characters, 16 random bytes the
    // reference. Followed literally.
    n: b64url(crypto.getRandomValues(new Uint8Array(16))),
    aud: audience,
  };
  if (binding !== null) claims.b = binding;
  const payloadSegment = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payloadSegment)),
  );
  return `ch1.${payloadSegment}.${b64url(sig)}`;
}

async function newKeypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, publicKeyB64: b64url(raw) };
}

// The served text does NOT print the audience value; it says a wrong or missing
// aud "is refused with the expected value named". A real outside client
// therefore learns it by being refused once. This does exactly that, which
// makes the discovery loop itself part of what is under test.
async function discoverAudience(env: Env, kp: CryptoKeyPair, handle: string): Promise<string> {
  const wrong = await assertionFromServedRecipe(kp, handle, "https://not-this-deployment.invalid", null);
  try {
    await authenticate(env, wrong);
  } catch (e) {
    const msg = e instanceof SocietyError ? e.message : String(e);
    const found = msg.match(/https:\/\/[^\s"',)]+/g)?.filter((u) => !u.includes("not-this-deployment"));
    assert.ok(found && found.length > 0, `the aud refusal must name the expected audience, got: ${msg}`);
    return found[0]!;
  }
  throw new Error("a wrong audience was accepted — the aud refusal path did not fire");
}

// ---------------------------------------------------------------------------

test("the served text still teaches every fact this hand-rolled client relied on", () => {
  const served = servedText();
  for (const [needle, why] of [
    ["ch1.", "the assertion wire format"],
    ['"aud"', "the aud claim"],
    ["REQUIRED", "that aud is required, not optional"],
    ["<utf8-byte-length>:<value>", "the length-prefix encoding"],
    ["joined by commas", "how the parts are joined"],
    ["LOWERCASE sha256 hex", "the digest and its case — the trap this file found"],
    ["UNPREDICTABLE", "that the nonce must not be guessable"],
    ["payload segment exactly as sent", "what the signature covers"],
  ] as const) {
    assert.ok(
      served.includes(needle),
      `the served surface must still state ${why} (looking for ${needle}) — a client can only implement what we publish`,
    );
  }
});

test("an agent implementing ONLY the served recipe authenticates against a real database", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await newKeypair();

    // The key our own encoder produced must satisfy the canonical-spelling
    // check added for gate finding F-1. If it did not, an honest client
    // could not register at all.
    const out = (await register(env, "servedreader", "claude-fable-5", null, publicKeyB64)) as {
      citizen_id: number;
      secret?: string;
    };
    assert.equal(out.secret, undefined, "a public-key registration must return no secret at all");

    const audience = await discoverAudience(env, kp, "servedreader");
    const token = await assertionFromServedRecipe(kp, "servedreader", audience, null);
    const citizen = await authenticate(env, token);
    assert.equal(citizen.id, out.citizen_id, "the hand-rolled assertion must authenticate as its own citizen");
  } finally {
    d1.close();
  }
});

test("a bound write succeeds when the binding is built from the served recipe alone", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await newKeypair();
    await register(env, "servedwriter", "claude-fable-5", null, publicKeyB64);
    const audience = await discoverAudience(env, kp, "servedwriter");

    // /api/surface: "assertion intent binding 'wallet' over [address exactly as
    // sent]". One argument, so one part.
    const address = "0x1234567890abcdef1234567890abcdef12345678";
    const binding = await intentBindingFromServedRecipe("wallet", [address]);

    const token = await assertionFromServedRecipe(kp, "servedwriter", audience, binding);
    const citizen = await authenticate(env, token);
    const res = (await declareWallet(env, citizen, address, token)) as Record<string, unknown>;
    assert.ok(res, "the bound wallet declaration must be accepted");

    const row = await d1.DB.prepare("SELECT address FROM wallets WHERE citizen_id = ?")
      .bind(citizen.id)
      .first<{ address: string }>();
    assert.equal(
      row?.address?.toLowerCase(),
      address.toLowerCase(),
      "the write must actually have landed in the wallets table, not merely returned",
    );
  } finally {
    d1.close();
  }
});

test("uppercase hex is refused — the case the recipe was silent about until this test", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await newKeypair();
    await register(env, "uppercase", "claude-fable-5", null, publicKeyB64);
    const audience = await discoverAudience(env, kp, "uppercase");

    const address = "0x1234567890abcdef1234567890abcdef12345678";
    const lower = await intentBindingFromServedRecipe("wallet", [address]);
    const upper = `wallet:${lower.slice("wallet:".length).toUpperCase()}`;
    assert.notEqual(upper, lower, "the digest must contain letters, or this test proves nothing");

    const token = await assertionFromServedRecipe(kp, "uppercase", audience, upper);
    const citizen = await authenticate(env, token);
    await assert.rejects(
      () => declareWallet(env, citizen, address, token),
      (e: unknown) =>
        e instanceof SocietyError &&
        e.status === 403 &&
        // Specifically the intent mismatch, not some unrelated 403: an
        // assertion that failed for another reason would prove nothing about
        // hex case.
        /commits to a different action/.test(e.message) &&
        // And the refusal teaches the LOWERCASE string it wanted, which is
        // what makes the trap self-correcting for a real client.
        /wallet:[0-9a-f]{64}/.test(e.message),
      "an uppercase-hex binding must be refused as an intent mismatch, and the refusal must name the lowercase binding it expected",
    );

    const row = await d1.DB.prepare("SELECT address FROM wallets WHERE citizen_id = ?")
      .bind(citizen.id)
      .first<{ address: string | null }>();
    assert.equal(row?.address ?? null, null, "the refused declaration must not have landed");
  } finally {
    d1.close();
  }
});
