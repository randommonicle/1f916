// Shared Ed25519 primitives for the public-key CLIENT tooling: the lobby
// sponsorship pilot (lobby-visitor.mjs, lobby-sponsor.mjs) and its test.
//
// The base64url codec here is byte-identical to src/keyauth.ts's, so a key
// generated and a signature produced with these functions verify under the
// DEPLOYED server. test/lobby-pilot.test.ts holds that parity open by comparing
// this codec against keyauth.ts's and by round-tripping a real signature through
// crypto.subtle-equivalent verification.
//
// (scripts/keyauth-ride.mjs predates this file and carries its own inlined
// equivalents; it is shipped, reviewed and spent, so it was left untouched
// rather than refactored. New client tooling uses this lib.)
import crypto from "node:crypto";

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

// Returns the raw 32-byte public key as canonical base64url (re-encoded through
// our own codec, so it equals what keyauth.checkPublicKeyShape re-derives, F-1),
// plus the private KeyObject and its JWK for local storage.
export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const rawPub = decodeBase64Url(pubJwk.x);
  if (!rawPub || rawPub.length !== 32) throw new Error("generated Ed25519 public key is not 32 bytes");
  return {
    publicKeyB64: encodeBase64Url(rawPub),
    privateKey,
    privateKeyJwk: privateKey.export({ format: "jwk" }),
  };
}

export function privateKeyFromJwk(jwk) {
  return crypto.createPrivateKey({ key: jwk, format: "jwk" });
}

export function publicKeyB64FromPrivate(privateKey) {
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  return encodeBase64Url(decodeBase64Url(jwk.x));
}

// Build a public KeyObject from a raw base64url Ed25519 key (32 bytes), so a
// sponsor can verify a signature made by whoever holds the private half.
// Returns null if the key is not a well-formed 32-byte Ed25519 point.
export function publicKeyObjectFromB64(pubB64) {
  const raw = decodeBase64Url(pubB64);
  if (!raw || raw.length !== 32) return null;
  try {
    return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: encodeBase64Url(raw) }, format: "jwk" });
  } catch {
    return null;
  }
}

// Ed25519 signs with algorithm=null (PureEdDSA) and returns a raw 64-byte
// signature, base64url here. The message is signed as its exact UTF-8 bytes.
export function signMessage(privateKey, message) {
  const sig = crypto.sign(null, Buffer.from(message, "utf8"), privateKey);
  if (sig.length !== 64) throw new Error(`Ed25519 signature is ${sig.length} bytes, expected 64`);
  return encodeBase64Url(new Uint8Array(sig));
}

// Verify a base64url signature over a message's UTF-8 bytes against a base64url
// public key. Returns false (never throws) on any malformed input, so a corrupt
// key or signature is a verification failure, never a crash.
export function verifyMessage(pubB64, message, sigB64) {
  const key = publicKeyObjectFromB64(pubB64);
  const sig = decodeBase64Url(sigB64);
  if (!key || !sig || sig.length !== 64) return false;
  try {
    return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

export function publicKeyFingerprint(pubB64) {
  const raw = decodeBase64Url(pubB64);
  if (!raw || raw.length !== 32) return null;
  return crypto.createHash("sha256").update(Buffer.from(raw)).digest("hex");
}
