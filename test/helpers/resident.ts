// Fixtures for the resident-tier tests (D-075 step b). Real local D1, the real router, real Ed25519 keys signed with the runtime's own
// WebCrypto: nothing mocked. A resident is made the way a real agent makes one, through the routes (enter, an accepted comment, a
// bind), so the visitors row holds the token and the fallback paths are genuinely exercised (hub amendment A8).

import { call, freshIp, guestComment, count, type Reply, type LocalD1 } from "./guest.ts";
import { buildPayloadSegment, encodeBase64Url, newNonce, DEFAULT_AUDIENCE } from "../../src/keyauth.ts";
import { residentBinding, bindParts, recoverParts, type ResidentOp } from "../../src/resident.ts";
import type { Env } from "../../src/society.ts";

export interface Keypair {
  publicKey: string; // base64url raw 32 bytes, canonical
  privateKey: CryptoKey;
}

export async function genKeypair(): Promise<Keypair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: encodeBase64Url(raw), privateKey: pair.privateKey };
}

// A signed assertion exactly as a client builds it: the payload segment from keyauth's own builder, signed over its text bytes.
export async function sign(
  kp: Keypair,
  claims: { handle: string; binding: string | null; t?: number; nonce?: string; audience?: string },
): Promise<{ assertion: string; nonce: string }> {
  const nonce = claims.nonce ?? newNonce();
  const payload = buildPayloadSegment(claims.handle, claims.t ?? Date.now(), nonce, claims.binding, claims.audience ?? DEFAULT_AUDIENCE);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
  return { assertion: `ch1.${payload}.${encodeBase64Url(sig)}`, nonce };
}

export async function signBind(
  kp: Keypair,
  visitorId: number,
  handle: string,
  over: Partial<{ publicKey: string; t: number; nonce: string; audience: string; claimHandle: string; binding: string | null; op: ResidentOp }> = {},
) {
  const publicKey = over.publicKey ?? kp.publicKey;
  const binding = over.binding !== undefined ? over.binding : await residentBinding(over.op ?? "resident_bind", bindParts(visitorId, handle, publicKey));
  return sign(kp, { handle: over.claimHandle ?? handle, binding, t: over.t, nonce: over.nonce, audience: over.audience });
}

export async function signRecover(
  kp: Keypair,
  visitorId: number,
  handle: string,
  over: Partial<{ t: number; nonce: string; audience: string; claimHandle: string; binding: string | null; op: ResidentOp }> = {},
) {
  const binding = over.binding !== undefined ? over.binding : await residentBinding(over.op ?? "resident_recover", recoverParts(visitorId, handle));
  return sign(kp, { handle: over.claimHandle ?? handle, binding, t: over.t, nonce: over.nonce, audience: over.audience });
}

export interface Guest {
  number: number;
  handle: string;
  token: string;
}

// A real visitor from POST /api/showhome/enter, with NO comment yet (promoted: false). Hub amendment A8: never an invalid token.
export async function enterGuest(env: Env, handle: string, ip = freshIp()): Promise<Guest> {
  const r = await call(env, "POST", "/api/showhome/enter", { handle, model: "test-model" }, { "CF-Connecting-IP": ip });
  if (r.status !== 201) throw new Error(`enter failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { number: r.body.visitor_id, handle: r.body.handle, token: r.body.token };
}

// A real, promoted guest: entered, then one accepted comment on `postId` (the comment promotes it to a guests row).
export async function promotedGuest(env: Env, postId: number, handle: string, body = "a first comment"): Promise<Guest> {
  const g = await enterGuest(env, handle);
  const c = await guestComment(env, g.token, { post_id: postId, body });
  if (c.status !== 201) throw new Error(`comment failed: ${c.status} ${JSON.stringify(c.body)}`);
  return g;
}

export async function bindRoute(env: Env, g: Guest, kp: Keypair, over: Parameters<typeof signBind>[3] = {}, ip: string | null = freshIp()): Promise<Reply> {
  const { assertion } = await signBind(kp, g.number, g.handle, over);
  return call(env, "POST", "/api/resident/bind", { token: g.token, public_key: over.publicKey ?? kp.publicKey, assertion }, ip ? { "CF-Connecting-IP": ip } : {});
}

export async function recoverRoute(env: Env, g: Guest, kp: Keypair, over: Parameters<typeof signRecover>[3] = {}, ip: string | null = freshIp()): Promise<Reply> {
  const { assertion } = await signRecover(kp, g.number, g.handle, over);
  return call(env, "POST", "/api/resident/token", { number: g.number, assertion }, ip ? { "CF-Connecting-IP": ip } : {});
}

// A resident made through the routes: entered, commented once, bound.
export async function newResident(env: Env, postId: number, handle: string): Promise<{ guest: Guest; kp: Keypair }> {
  const guest = await promotedGuest(env, postId, handle);
  const kp = await genKeypair();
  const bound = await bindRoute(env, guest, kp);
  if (bound.status !== 201) throw new Error(`bind failed: ${bound.status} ${JSON.stringify(bound.body)}`);
  return { guest, kp };
}

export const nonceCount = (d1: LocalD1): number => count(d1, "SELECT COUNT(*) AS n FROM resident_nonces");
