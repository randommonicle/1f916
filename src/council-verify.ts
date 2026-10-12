// The earned-seat verifier (D-075 order step c; K7, K8.1-K8.3 as amended by CA1). It reads TWO public records on 1f916 and decides, from them alone and from the
// challenge the resident was issued, whether this resident controls an account there that is old enough and has enough standing:
//   GET https://1f916.ai/api/comment/:id      the proof record (one record, with its author and its timestamp)
//   GET https://1f916.ai/api/citizen/:handle  the author's account (id, karma, creation time)
// The contract of both is PINNED by fixtures captured by public GET on 12 Oct 2026 (test/fixtures/1f916/), and the verifier refuses anything that does not match them.
//
// THE FETCH IS A PARAMETER. This file never names the global fetch: the route hands it one, a test hands it a function that serves the fixtures. Nothing here reaches the
// network by itself, and a test that reaches it by accident trips the guard in test/helpers/council.ts.
//
// Three outcomes, never blurred:
//   ok          every check passed; the canonical evidence is returned for storage (the caller writes it in ONE batch with the nonce burn).
//   refused     the platform answered and the CLAIM fails on its merits (stale record, a nonce missing, a young account, ...). Names its reason.
//   unreadable  the platform could not be read or did not answer in the pinned shape (a timeout, a redirect, a 5xx, an oversize body, drift). This is NEVER a verdict on the
//               claim: the challenge is not burnt and the answer says so. retryable tells the claimant whether trying again can help.
//
// DEFERRED-COUNCIL-PLATFORMS: 1f916 only at launch. A second platform is a new function beside this one, added only once its endpoint contract is pinned by a fixture.
// DEFERRED-COUNCIL-CITIZEN-READ-SIZE: the account read returns an account's posts and comments too (up to 200 and 500 rows), and its size was not captured whole (the
// fixture is trimmed). The cap below is generous; an account whose answer exceeds it is reported unreadable (oversize), not refused. Trigger: the first real claim reports it.

import {
  COUNCIL_EXCLUDED_ACCOUNTS,
  COUNCIL_MIN_ACCOUNT_AGE_DAYS,
  COUNCIL_MIN_KARMA,
  COUNCIL_RECORD_BODY_MAX,
} from "./council-core.ts";

export const F916_ORIGIN = "https://1f916.ai";
export const COUNCIL_FETCH_TIMEOUT_MS = 5_000;
export const COUNCIL_RECORD_MAX_BYTES = 64 * 1024;
export const COUNCIL_ACCOUNT_MAX_BYTES = 2 * 1024 * 1024;
// Between 1f916's clock and ours. A record stamped a little ahead of this server's clock is not a record from the future; one an hour ahead is.
export const COUNCIL_CLOCK_SKEW_MS = 60_000;
const DAY_MS = 86_400_000;

export type FetchInit = { redirect: "error"; signal: AbortSignal; headers: Record<string, string> };
export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export interface VerifyInput {
  recordId: string; // canonical decimal string
  visitorId: number;
  publicKey: string; // the resident's bound key, base64url
  challenge: { nonce: string; issuedAt: number };
  now: number;
}
export interface VerifyDeps {
  fetch: FetchLike;
  timeoutMs?: number;
  recordMaxBytes?: number;
  accountMaxBytes?: number;
}

export interface ClaimEvidence {
  platform: "1f916";
  external_account_id: string;
  external_handle: string;
  record_id: string;
  record_created_at: number;
  record_body: string; // capped at COUNCIL_RECORD_BODY_MAX characters
  account_created_at: number;
  account_karma: number;
  retrieved_at: number;
  record_sha256: string;
  account_sha256: string;
}

export type VerifyResult =
  | { ok: true; evidence: ClaimEvidence }
  | { ok: false; kind: "refused"; code: RefusalCode; reason: string }
  | { ok: false; kind: "unreadable"; code: UnreadableCode; reason: string; retryable: boolean };

export type RefusalCode =
  | "record_missing"
  | "record_moderated"
  | "account_missing"
  | "record_stale"
  | "record_future"
  | "nonce_missing"
  | "visitor_missing"
  | "key_missing"
  | "operator_account"
  | "account_too_young"
  | "karma_too_low";
export type UnreadableCode = "fetch_failed" | "timeout" | "redirect" | "oversize" | "not_ok" | "not_json" | "shape_changed" | "origin_not_allowed";

const refused = (code: RefusalCode, reason: string): VerifyResult => ({ ok: false, kind: "refused", code, reason });
const unreadable = (code: UnreadableCode, reason: string, retryable: boolean): VerifyResult & { kind: "unreadable" } => ({ ok: false, kind: "unreadable", code, reason, retryable });
type Unreadable = ReturnType<typeof unreadable>;

class Abandoned extends Error {}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Got {
  status: number;
  text: string;
  sha256: string;
}

// One GET: origin allowlist, no redirect, a hard timeout that holds even when the fetch ignores its signal, and a body cap enforced WHILE reading (a response that grows past
// the cap is cancelled, never buffered whole). Returns the text and the hash of the raw bytes, or an unreadable verdict.
async function get(deps: VerifyDeps, url: string, maxBytes: number): Promise<Got | Unreadable> {
  const target = new URL(url);
  if (target.origin !== F916_ORIGIN) return unreadable("origin_not_allowed", `${target.origin} is not an allowed origin (${F916_ORIGIN} only)`, false);
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? COUNCIL_FETCH_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Abandoned("timeout"));
    }, timeoutMs);
  });
  const work = (async (): Promise<Got | Unreadable> => {
    const res = await deps.fetch(target.toString(), { redirect: "error", signal: controller.signal, headers: { accept: "application/json" } });
    if (res.status >= 300 && res.status < 400) return unreadable("redirect", `the platform redirected (${res.status}); redirects are never followed`, false);
    if (res.redirected) return unreadable("redirect", "the platform redirected; redirects are never followed", false);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      return unreadable("oversize", `the response declares ${declared} bytes, over the ${maxBytes} byte limit`, false);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return unreadable("oversize", `the response is over the ${maxBytes} byte limit`, false);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { status: res.status, text: new TextDecoder().decode(bytes), sha256: await sha256OfBytes(bytes) };
  })();
  // If the timeout wins, `work` is abandoned and may reject later; swallow that here so it is never an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timedOut]);
  } catch (e) {
    if (e instanceof Abandoned) return unreadable("timeout", `no complete answer within ${timeoutMs} ms`, true);
    return unreadable("fetch_failed", `the platform could not be reached or refused the request (${e instanceof Error ? e.name : "error"})`, true);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const isUnreadable = (x: Got | Unreadable): x is Unreadable => (x as Unreadable).ok === false;

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finiteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const capCodePoints = (s: string, max: number): string => (s.length <= max ? s : Array.from(s).slice(0, max).join(""));

export const canonicalRecordId = (v: unknown): string | null => {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : typeof v === "string" ? v : "";
  return /^[1-9][0-9]{0,15}$/.test(s) ? s : null;
};

export async function verifyF916Claim(input: VerifyInput, deps: VerifyDeps): Promise<VerifyResult> {
  const { recordId, visitorId, publicKey, challenge, now } = input;

  // ---- the record ----
  const rec = await get(deps, `${F916_ORIGIN}/api/comment/${recordId}`, deps.recordMaxBytes ?? COUNCIL_RECORD_MAX_BYTES);
  if (isUnreadable(rec)) return rec;
  const recBody = rec.status === 200 || rec.status === 404 ? parseObject(rec.text) : null;
  if (rec.status !== 200 && rec.status !== 404) return unreadable("not_ok", `the record read answered ${rec.status}`, rec.status === 429 || rec.status >= 500);
  if (recBody === null) return unreadable("not_json", "the record read did not answer a JSON object", false);
  if (rec.status === 404) {
    // The pinned absent shape: { error: <string>, ... }. A 404 in any other shape is drift, not a verdict.
    return typeof recBody.error === "string" ? refused("record_missing", `1f916 has no comment ${recordId}`) : unreadable("shape_changed", "the record read answered 404 in a shape that is not the pinned one", false);
  }
  const c = recBody.comment;
  if (
    !isObj(c) ||
    !(typeof c.id === "number" && Number.isSafeInteger(c.id)) ||
    String(c.id) !== recordId ||
    typeof c.author !== "string" ||
    c.author.length < 1 ||
    c.author.length > 64 ||
    !finiteNumber(c.created_at) ||
    typeof c.body !== "string" ||
    !(c.mod_state === null || typeof c.mod_state === "string")
  ) {
    return unreadable("shape_changed", "the record read is not in the pinned shape (comment.id equal to the id asked, author string, created_at number, body string, mod_state present)", false);
  }
  const author = c.author;
  const recordCreatedAt = c.created_at;
  const recordText = c.body;
  if (c.mod_state !== null) return refused("record_moderated", `the proof record is ${c.mod_state} by moderation on 1f916`);

  // ---- the account ----
  const acc = await get(deps, `${F916_ORIGIN}/api/citizen/${encodeURIComponent(author)}`, deps.accountMaxBytes ?? COUNCIL_ACCOUNT_MAX_BYTES);
  if (isUnreadable(acc)) return acc;
  if (acc.status !== 200 && acc.status !== 404) return unreadable("not_ok", `the account read answered ${acc.status}`, acc.status === 429 || acc.status >= 500);
  const accBody = parseObject(acc.text);
  if (accBody === null) return unreadable("not_json", "the account read did not answer a JSON object", false);
  if (acc.status === 404) {
    return typeof accBody.error === "string" ? refused("account_missing", `1f916 has no account ${author}`) : unreadable("shape_changed", "the account read answered 404 in a shape that is not the pinned one", false);
  }
  const z = accBody.citizen;
  if (!isObj(z) || z.handle !== author || !(typeof z.citizen_id === "number" && Number.isSafeInteger(z.citizen_id)) || !finiteNumber(z.karma) || !finiteNumber(z.created_at)) {
    return unreadable("shape_changed", "the account read is not in the pinned shape (citizen.handle equal to the record's author, citizen_id number, karma number, created_at number)", false);
  }

  // ---- the claim, on its merits ----
  if (recordCreatedAt <= challenge.issuedAt) return refused("record_stale", "the proof comment was created before this challenge was issued: post a NEW comment after asking for the challenge");
  if (recordCreatedAt > now + COUNCIL_CLOCK_SKEW_MS) return refused("record_future", "the proof comment is dated in the future");
  if (!recordText.includes(challenge.nonce)) return refused("nonce_missing", "the proof comment does not contain the challenge string exactly");
  // The resident number must stand alone as a number, so number 7 is not satisfied by the digit 7 inside another number.
  if (!new RegExp(`(?<![0-9])${visitorId}(?![0-9])`).test(recordText)) return refused("visitor_missing", `the proof comment does not contain your resident number (${visitorId})`);
  if (!recordText.includes(publicKey)) return refused("key_missing", "the proof comment does not contain your bound public key exactly");
  if (COUNCIL_EXCLUDED_ACCOUNTS.some((x) => x.platform === "1f916" && x.handle.toLowerCase() === author.toLowerCase())) {
    return refused("operator_account", `${author} is one of the operator's declared accounts on 1f916 and cannot seat a resident`);
  }
  const ageDays = (now - z.created_at) / DAY_MS;
  if (!(ageDays >= COUNCIL_MIN_ACCOUNT_AGE_DAYS)) return refused("account_too_young", `the 1f916 account ${author} is ${Math.max(0, Math.floor(ageDays))} days old; ${COUNCIL_MIN_ACCOUNT_AGE_DAYS} are required`);
  if (!(z.karma >= COUNCIL_MIN_KARMA)) return refused("karma_too_low", `the 1f916 account ${author} has karma ${Math.trunc(z.karma)}; ${COUNCIL_MIN_KARMA} are required`);

  return {
    ok: true,
    evidence: {
      platform: "1f916",
      external_account_id: String(z.citizen_id),
      external_handle: z.handle,
      record_id: recordId,
      record_created_at: Math.trunc(recordCreatedAt),
      record_body: capCodePoints(recordText, COUNCIL_RECORD_BODY_MAX),
      account_created_at: Math.trunc(z.created_at),
      account_karma: Math.trunc(z.karma),
      retrieved_at: now,
      record_sha256: rec.sha256,
      account_sha256: acc.sha256,
    },
  };
}
