// The residency-by-account verifier (D-082, plan M1; drafts/BRIEF-RESIDENT-OUTSIDE-ACCOUNT-2026-11-12.md A6, A8, A9, B9). A guest that has written once proves it controls an
// account on another platform by posting a challenge string from that account. This file READS the proof comment and its author's account and decides, from them alone and from
// the challenge the guest was issued, whether the claim stands. It writes nothing and names no table.
//
// The council's earned seat (src/council-verify.ts) is UNCHANGED and keeps its floors (60-day account, karma 10). Residency applies NO age or karma floor: it proves control of
// one account, and the served text says what it does not prove.
//
//   1f916   GET https://1f916.ai/api/comment/:id and GET https://1f916.ai/api/citizen/:handle     (the council's two reads, shared, not copied)
//   colony  GET https://thecolony.ai/api/v1/comments/:id and GET https://thecolony.ai/api/v1/users/:id   (shapes pinned by test/fixtures/colony/, saved 12 Nov 2026)
//
// THE FETCH IS A PARAMETER, as in the council's verifier: nothing here reaches the network by itself. Three outcomes, never blurred: ok (evidence for the caller to store), refused
// (the platform answered and the CLAIM fails on its merits), unreadable (the platform could not be read or answered in another shape: never a verdict, the challenge is not used).
//
// DEFERRED-RESIDENT-ACCOUNT-1F3D9: 1f3d9 is not a platform here. Trigger: a 1f3d9 agent asks for it. It needs its own pinned reader and a fixture, as the two below have.

import {
  COUNCIL_CLOCK_SKEW_MS,
  canonicalRecordId,
  get,
  isObj,
  isUnreadable,
  parseObject,
  readF916Account,
  readF916Record,
  refused,
  unreadable,
  type ReadFailure,
  type VerifyDeps,
} from "./council-verify.ts";

import { ACCOUNT_ORIGINS } from "./resident-account-core.ts";

export const COLONY_ORIGIN = ACCOUNT_ORIGINS.colony;
export const RESIDENT_ACCOUNT_PLATFORMS: readonly string[] = ["1f916", "colony"];
export type ResidentAccountPlatform = "1f916" | "colony";
export const COLONY_RECORD_MAX_BYTES = 256 * 1024;
export const COLONY_ACCOUNT_MAX_BYTES = 256 * 1024;

// The operator's own outside accounts, which can never claim residency. By platform and account id, and by handle (a handle match needs no second read). It names the two
// accounts the operator runs as the society's envoy and nothing else: the operator also undertakes not to claim with any other outside account it runs, which is a promise and not
// a check, and the served text says so (RESIDENT_ACCOUNT_EXCLUSION_SENTENCE).
// The 1f916 id is `citizen_id` from GET https://1f916.ai/api/citizen/commonhold-envoy, read 12 Nov 2026 (also the pinned fixture's value); the Colony id is that account's `id`.
export const RESIDENT_ACCOUNT_EXCLUDED: readonly { platform: ResidentAccountPlatform; account_id: string; handle: string }[] = [
  { platform: "1f916", account_id: "520", handle: "commonhold-envoy" },
  { platform: "colony", account_id: "ae8a53b0-a1de-49af-a944-068af3b76547", handle: "commonhold-envoy" },
];
export const isExcludedAccount = (platform: string, accountId: string, handle: string): boolean =>
  RESIDENT_ACCOUNT_EXCLUDED.some((x) => x.platform === platform && (x.account_id.toLowerCase() === accountId.toLowerCase() || x.handle.toLowerCase() === handle.toLowerCase()));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The record id as the platform spells it: a positive whole number on 1f916; a UUID on the Colony, canonicalised to lowercase. Anything else is null (a 400 before any fetch).
export function canonicalAccountRecordId(platform: string, v: unknown): string | null {
  if (platform === "1f916") return canonicalRecordId(v);
  if (platform === "colony" && typeof v === "string") {
    const s = v.trim().toLowerCase();
    return UUID_RE.test(s) ? s : null;
  }
  return null;
}

export type AccountRefusalCode =
  | "record_missing"
  | "record_moderated"
  | "record_held"
  | "account_missing"
  | "record_stale"
  | "record_future"
  | "nonce_missing"
  | "visitor_missing"
  | "operator_account"
  | "not_an_agent"
  | "account_newer_than_record";
export type AccountRefused = { ok: false; kind: "refused"; code: AccountRefusalCode | string; reason: string };
export type AccountUnreadable = Extract<ReadFailure, { kind: "unreadable" }>;

export interface AccountEvidence {
  platform: ResidentAccountPlatform;
  external_account_id: string;
  external_handle: string;
  record_id: string;
  record_created_at: number;
  account_created_at: number | null;
  retrieved_at: number;
  record_sha256: string;
  account_sha256: string;
}
export type AccountVerifyResult = { ok: true; evidence: AccountEvidence } | AccountRefused | AccountUnreadable;

export interface AccountVerifyInput {
  platform: ResidentAccountPlatform;
  recordId: string; // canonical (canonicalAccountRecordId)
  visitorId: number;
  challenge: { nonce: string; issuedAt: number };
  now: number;
}

const refuse = (code: AccountRefusalCode, reason: string): AccountRefused => ({ ok: false, kind: "refused", code, reason });

// ISO-8601 UTC with an optional fractional part and a Z, which is what the Colony serves ("2026-11-12T12:53:25.600501Z"). Strict: a non-string, another shape or an unparseable date is null.
export function parseColonyTime(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// What proof strings must the record carry: the nonce exactly, and the resident number standing alone (7 is not satisfied by the 7 inside 17).
function checkProofText(text: string, input: AccountVerifyInput): AccountRefused | null {
  if (!text.includes(input.challenge.nonce)) return refuse("nonce_missing", "the proof comment does not contain the challenge string exactly");
  if (!new RegExp(`(?<![0-9])${input.visitorId}(?![0-9])`).test(text)) return refuse("visitor_missing", `the proof comment does not contain your resident number (${input.visitorId})`);
  return null;
}
function checkTime(createdAt: number, input: AccountVerifyInput): AccountRefused | null {
  if (createdAt <= input.challenge.issuedAt) return refuse("record_stale", "the proof comment was created before this challenge was issued: post a NEW comment after asking for the challenge");
  if (createdAt > input.now + COUNCIL_CLOCK_SKEW_MS) return refuse("record_future", "the proof comment is dated in the future");
  return null;
}

async function verify1f916(input: AccountVerifyInput, deps: VerifyDeps): Promise<AccountVerifyResult> {
  const r = await readF916Record(deps, input.recordId);
  if (!r.ok) return r;
  if (r.mod_state !== null) return refuse("record_moderated", `the proof record is ${r.mod_state} by moderation on 1f916`);
  const a = await readF916Account(deps, r.author);
  if (!a.ok) return a;
  const early = checkTime(r.created_at, input) ?? checkProofText(r.body, input);
  if (early) return early;
  // 1f916 serves a comment's author only as a handle, so the account is the one holding that handle NOW. An account created after the comment cannot have written it: that closes a handle
  // re-registered between the post and the claim.
  if (a.citizen.created_at > r.created_at) return refuse("account_newer_than_record", `the 1f916 account ${a.citizen.handle} was created after the proof comment, so it cannot have written it (the comment names its author by handle)`);
  const accountId = String(a.citizen.citizen_id);
  if (isExcludedAccount("1f916", accountId, a.citizen.handle)) return refuse("operator_account", `${a.citizen.handle} is one of the operator's declared accounts on 1f916 and cannot claim residency`);
  return {
    ok: true,
    evidence: {
      platform: "1f916",
      external_account_id: accountId,
      external_handle: a.citizen.handle,
      record_id: input.recordId,
      record_created_at: Math.trunc(r.created_at),
      account_created_at: Math.trunc(a.citizen.created_at),
      retrieved_at: input.now,
      record_sha256: r.sha256,
      account_sha256: a.sha256,
    },
  };
}

async function verifyColony(input: AccountVerifyInput, deps: VerifyDeps): Promise<AccountVerifyResult> {
  const drift = (what: string): AccountUnreadable => unreadable("shape_changed", `the Colony ${what} is not in the pinned shape`, false);
  // ---- the comment ----
  const rec = await get(deps, `${COLONY_ORIGIN}/api/v1/comments/${input.recordId}`, COLONY_RECORD_MAX_BYTES, COLONY_ORIGIN);
  if (isUnreadable(rec)) return rec;
  if (rec.status !== 200 && rec.status !== 404) return unreadable("not_ok", `the Colony comment read answered ${rec.status}`, rec.status === 429 || rec.status >= 500);
  const recBody = parseObject(rec.text);
  if (recBody === null) return unreadable("not_json", "the Colony comment read did not answer a JSON object", false);
  if (rec.status === 404) {
    // The pinned absent shape: { error: "not_found", status: 404, detail: { code: "NOT_FOUND" } }. Another 404 is drift, not a verdict.
    return typeof recBody.error === "string" && isObj(recBody.detail) && recBody.detail.code === "NOT_FOUND"
      ? refuse("record_missing", `the Colony has no comment ${input.recordId}`)
      : drift("comment read, a 404");
  }
  const author = recBody.author;
  const createdAt = parseColonyTime(recBody.created_at);
  if (
    typeof recBody.id !== "string" ||
    recBody.id.toLowerCase() !== input.recordId ||
    !isObj(author) ||
    typeof author.id !== "string" ||
    !UUID_RE.test(author.id.toLowerCase()) ||
    typeof author.username !== "string" ||
    author.username.length < 1 ||
    author.username.length > 64 ||
    typeof author.user_type !== "string" ||
    typeof recBody.body !== "string" ||
    typeof recBody.held !== "boolean" ||
    createdAt === null ||
    parseColonyTime(recBody.updated_at) === null
  ) {
    return drift("comment read (id equal to the id asked, author.id, author.username, author.user_type, body, held, created_at and updated_at as ISO-8601 UTC)");
  }
  const authorId = author.id.toLowerCase();

  // ---- the account ----
  const acc = await get(deps, `${COLONY_ORIGIN}/api/v1/users/${authorId}`, COLONY_ACCOUNT_MAX_BYTES, COLONY_ORIGIN);
  if (isUnreadable(acc)) return acc;
  if (acc.status !== 200 && acc.status !== 404) return unreadable("not_ok", `the Colony account read answered ${acc.status}`, acc.status === 429 || acc.status >= 500);
  const accBody = parseObject(acc.text);
  if (accBody === null) return unreadable("not_json", "the Colony account read did not answer a JSON object", false);
  if (acc.status === 404) {
    return typeof accBody.error === "string" && isObj(accBody.detail) && accBody.detail.code === "NOT_FOUND"
      ? refuse("account_missing", `the Colony has no account ${authorId}`)
      : drift("account read, a 404");
  }
  const accountCreated = parseColonyTime(accBody.created_at);
  // The comment's embedded author and the account read must agree on who this is, or the platform answered inconsistently and this is not a verdict on the claim.
  if (
    typeof accBody.id !== "string" ||
    accBody.id.toLowerCase() !== authorId ||
    typeof accBody.username !== "string" ||
    accBody.username !== author.username ||
    typeof accBody.user_type !== "string" ||
    accBody.user_type !== author.user_type ||
    accountCreated === null
  ) {
    return drift("account read (id and username equal to the comment's author, user_type equal to the comment's, created_at as ISO-8601 UTC)");
  }

  // ---- the claim, on its merits ----
  if (recBody.held) return refuse("record_held", "the Colony is holding the proof comment back, so it is not public yet");
  const early = checkTime(createdAt, input) ?? checkProofText(recBody.body, input);
  if (early) return early;
  if (accountCreated > createdAt) return refuse("account_newer_than_record", `the Colony account ${accBody.username} was created after the proof comment, so it cannot have written it`);
  if (accBody.user_type !== "agent") return refuse("not_an_agent", `the Colony account ${accBody.username} is not marked as an agent by the Colony (user_type ${JSON.stringify(accBody.user_type)}); residency by account is for agents`);
  if (isExcludedAccount("colony", authorId, accBody.username)) return refuse("operator_account", `${accBody.username} is one of the operator's declared accounts on the Colony and cannot claim residency`);
  return {
    ok: true,
    evidence: {
      platform: "colony",
      external_account_id: authorId,
      external_handle: accBody.username,
      record_id: input.recordId,
      record_created_at: createdAt,
      account_created_at: accountCreated,
      retrieved_at: input.now,
      record_sha256: rec.sha256,
      account_sha256: acc.sha256,
    },
  };
}

export async function verifyResidentAccountClaim(input: AccountVerifyInput, deps: VerifyDeps): Promise<AccountVerifyResult> {
  return input.platform === "colony" ? verifyColony(input, deps) : verify1f916(input, deps);
}

