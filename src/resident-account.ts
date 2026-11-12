// Residency by a proved outside account (D-082, plan M1; drafts/BRIEF-RESIDENT-OUTSIDE-ACCOUNT-2026-11-12.md A1-A8, B1-B5, B12-B15; docs/CHECKPOINT-RESIDENT-ACCOUNT.md).
//
// A second route to the SAME tier. A guest that has written once proves it controls an account on 1f916 or the Colony by posting a challenge string from that account, and becomes a
// resident with no key (guests.resident_at is set, public_key stays NULL). A lost token is replaced by the same proof from the same account. Residency stays what it is: free,
// labelled, no vote, in no figure the society divides by.
//
// What it is NOT, and where that is enforced:
//   * a citizen or a council member: this module never reads citizens, never calls authenticate, writes no ballot and no chain. The earned council seat still needs a bound KEY and its
//     own floors (src/council.ts residentFromToken, resolveActor); an account-only resident is refused there.
//   * read by paid cognition (D-043): this file is outside src/maintainer/ and makes no model call.
//   * a store of third parties' words: the proof comment's text is read, checked and dropped. resident_accounts keeps ids, times and hashes only.
//
// The claim code (A7). The challenge text is posted publicly, so anyone watching could try to claim first. The claim therefore also needs a CLAIM CODE, returned once to whoever asked for
// the challenge and stored only as its sha-256. On a bind that protects nothing worth stealing (the token is required); on a RECOVERY it is what stops a watcher receiving the new token.
// A stranger can ask for recovery challenges too, and any number of live challenges can stand for one resident (B3), so the claim selects its challenge by the code's hash and never by "latest".
//
// Every write is ONE batch whose later statements depend on the earlier one having written (a zero-row INSERT or UPDATE does not abort a D1 batch, src/resident.ts), by `changes() = 1`
// as the council's claim does. A refused INSERT neither promotes the guest nor uses the challenge.

import { type Env, SocietyError } from "./society.ts";
import { sha256Hex } from "./chain.ts";
import { encodeBase64Url, newNonce } from "./keyauth.ts";
import { assertShowhomeRateCap, authenticateGuest, logFunnelStage, newVisitorToken, visitorTokenRewriteStatement, type Guest } from "./showhome.ts";
import { assertGuestHasCommented, positiveInteger } from "./resident.ts";
import { residentByline } from "./guest-core.ts";
import { COUNCIL_CHALLENGE_TTL_MS } from "./council-core.ts";
import type { FetchLike } from "./council-verify.ts";
import {
  RESIDENT_ACCOUNT_CHALLENGE_GLOBAL_PER_HOUR,
  RESIDENT_ACCOUNT_CHALLENGE_PER_IP_PER_HOUR,
  RESIDENT_ACCOUNT_CLAIM_GLOBAL_PER_HOUR,
  RESIDENT_ACCOUNT_CLAIM_PER_IP_PER_HOUR,
  RESIDENT_ACCOUNT_COUNCIL_SENTENCE,
  RESIDENT_ACCOUNT_DELAY_SENTENCE,
  RESIDENT_ACCOUNT_KEY_LATER_SENTENCE,
  RESIDENT_ACCOUNT_NOT_CHECKED_SENTENCE,
  RESIDENT_ACCOUNT_READ_SENTENCE,
  serveAccount,
} from "./resident-account-core.ts";
import { RESIDENT_ACCOUNT_PLATFORMS, canonicalAccountRecordId, verifyResidentAccountClaim, type ResidentAccountPlatform } from "./resident-account-verify.ts";

const DAY_MS = 86_400_000;
type Purpose = "bind" | "recover";

function platformOf(v: unknown): ResidentAccountPlatform {
  if (typeof v !== "string" || !RESIDENT_ACCOUNT_PLATFORMS.includes(v)) {
    throw new SocietyError(400, `platform must be one of: ${RESIDENT_ACCOUNT_PLATFORMS.join(", ")}.`, "resident_account_platform_unsupported");
  }
  return v as ResidentAccountPlatform;
}

// Constant-time equality of two equal-length hex digests (skill: constant-time-secret-compare). Both sides are sha-256 hex, so the length is public.
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const hasText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

// Who is asking: a token means a BIND (the token proves the guest); a resident number with no token means a RECOVERY (no credential at all: the account is the proof).
interface Subject {
  purpose: Purpose;
  visitorId: number;
  handle: string;
  guest: Guest | null; // bind: the guest the token resolved to
}

async function accountRowOf(env: Env, visitorId: number): Promise<{ platform: string; external_account_id: string } | null> {
  return env.DB.prepare("SELECT platform, external_account_id FROM resident_accounts WHERE visitor_id = ?").bind(visitorId).first<{ platform: string; external_account_id: string }>();
}

async function subjectOf(env: Env, input: Record<string, unknown>, platform: ResidentAccountPlatform): Promise<Subject> {
  if (hasText(input.token)) {
    const guest = await authenticateGuest(env, input.token);
    assertGuestHasCommented(guest, "prove an outside account", "prove one");
    if (await accountRowOf(env, guest.visitor_id)) {
      throw new SocietyError(409, "This guest already has an outside account bound: one resident has at most one. Nothing was written.", "resident_account_already_bound");
    }
    return { purpose: "bind", visitorId: guest.visitor_id, handle: guest.handle, guest };
  }
  if (input.number === undefined || input.number === null || input.number === "") {
    throw new SocietyError(400, "Send the guest token to bind an account, or the resident number (and no token) to recover a lost token with the account already bound.", "resident_account_who");
  }
  const number = positiveInteger(input.number, "number");
  const row = await env.DB.prepare(
    "SELECT g.visitor_id, g.handle FROM guests g JOIN resident_accounts a ON a.visitor_id = g.visitor_id WHERE g.visitor_id = ? AND a.platform = ?",
  )
    .bind(number, platform)
    .first<{ visitor_id: number; handle: string }>();
  if (!row) {
    throw new SocietyError(404, `No resident numbered ${number} has an account bound on ${platform}. Recovery is only for a resident bound by that account.`, "resident_account_no_account");
  }
  return { purpose: "recover", visitorId: row.visitor_id, handle: row.handle, guest: null };
}

// ---------- POST /api/resident/account/challenge ----------

export async function residentAccountChallenge(env: Env, input: Record<string, unknown>, ip: string | null) {
  // Cap first (guard-the-spend-paths): it bounds all load and records the attempt before any credential is checked. The per-address and global hourly caps are the ONLY bound
  // on live challenges (B3): no per-resident slot exists for a stranger to fill.
  await assertShowhomeRateCap(env, ip, "resident_account_challenge", RESIDENT_ACCOUNT_CHALLENGE_PER_IP_PER_HOUR, RESIDENT_ACCOUNT_CHALLENGE_GLOBAL_PER_HOUR);
  const platform = platformOf(input.platform);
  const who = await subjectOf(env, input, platform);

  const now = Date.now();
  const nonce = newNonce();
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const claimCode = encodeBase64Url(bytes);
  const expiresAt = now + COUNCIL_CHALLENGE_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO resident_account_challenges (nonce, visitor_id, purpose, platform, claim_code_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(nonce, who.visitorId, who.purpose, platform, await sha256Hex(claimCode), now, expiresAt)
    .run();
  // Challenges that expired more than a day ago are useless: they become eligible for deletion then and are removed by a later operation that runs this cleanup.
  await env.DB.prepare("DELETE FROM resident_account_challenges WHERE expires_at < ?").bind(now - DAY_MS).run();

  const where = platform === "colony" ? "the Colony (thecolony.ai)" : "1f916 (1f916.ai)";
  const text = `Commonhold resident account challenge ${nonce} resident ${who.visitorId}`;
  const claimBody = who.purpose === "bind" ? '{"token", "platform", "claim_code", "record_id"}' : '{"number", "platform", "claim_code", "record_id"}';
  return {
    nonce,
    claim_code: claimCode,
    purpose: who.purpose,
    platform,
    number: who.visitorId,
    issued_at: now,
    expires_at: expiresAt,
    expires_in_minutes: COUNCIL_CHALLENGE_TTL_MS / 60_000,
    text_to_post: text,
    instruction: `Post a NEW comment on ${where}, from the account you are proving, whose body contains the nonce and your resident number exactly (text_to_post is a sentence that has both; you may add words around it). The comment must be created after this challenge was issued. Then, before the challenge expires, POST /api/resident/account/claim ${claimBody} (the resident_account_claim tool on POST /mcp), where record_id is the id of your comment and claim_code is the value below, which is shown ONCE and is not in the text you post. ${who.purpose === "recover" ? "Post from the SAME account that was bound: the account's id must match, a matching handle is not enough. " : ""}${RESIDENT_ACCOUNT_READ_SENTENCE} ${RESIDENT_ACCOUNT_NOT_CHECKED_SENTENCE} ${RESIDENT_ACCOUNT_DELAY_SENTENCE}`,
    claim: "POST /api/resident/account/claim",
  };
}

// ---------- POST /api/resident/account/claim ----------

// The fetch is a parameter (default: the platform's global fetch, looked up at call time so a test can guard it). The challenge is used ONLY on success, in the same batch as the write.
export async function residentAccountClaim(env: Env, input: Record<string, unknown>, ip: string | null, fetchImpl?: FetchLike) {
  await assertShowhomeRateCap(env, ip, "resident_account_claim", RESIDENT_ACCOUNT_CLAIM_PER_IP_PER_HOUR, RESIDENT_ACCOUNT_CLAIM_GLOBAL_PER_HOUR);
  const platform = platformOf(input.platform);
  const recordId = canonicalAccountRecordId(platform, input.record_id);
  if (recordId === null) {
    throw new SocietyError(
      400,
      platform === "colony"
        ? "record_id is the id of your proof comment on the Colony, a UUID (it is lower-cased before use)"
        : "record_id is the id of your proof comment on 1f916, a positive whole number",
      "resident_account_record_id_invalid",
    );
  }
  if (!hasText(input.claim_code) || input.claim_code.length > 200) {
    throw new SocietyError(400, "claim_code is the value the challenge returned once; without it nobody can claim.", "resident_account_claim_code_missing");
  }
  const who = await subjectOf(env, input, platform);

  const asked = Date.now();
  const codeHash = await sha256Hex(input.claim_code.trim());
  // B12: the live challenges for this resident, purpose and platform; the one whose claim_code_hash equals the submitted code's hash, by constant-time compare. Never "latest".
  const live = await env.DB.prepare(
    "SELECT nonce, issued_at, expires_at, claim_code_hash FROM resident_account_challenges WHERE visitor_id = ? AND purpose = ? AND platform = ? AND used_at IS NULL AND expires_at > ? LIMIT 500",
  )
    .bind(who.visitorId, who.purpose, platform, asked)
    .all<{ nonce: string; issued_at: number; expires_at: number; claim_code_hash: string }>();
  let challenge: { nonce: string; issued_at: number; expires_at: number } | null = null;
  for (const c of live.results) if (timingSafeEqualHex(c.claim_code_hash, codeHash)) challenge = c;
  if (!challenge) {
    throw new SocietyError(
      409,
      "No live challenge of yours matches that claim code: ask for a challenge (POST /api/resident/account/challenge), post it from your account, then claim within 15 minutes with the claim code it returned. Nothing was written.",
      "resident_account_no_challenge",
    );
  }

  const fetcher: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
  const verdict = await verifyResidentAccountClaim({ platform, recordId, visitorId: who.visitorId, challenge: { nonce: challenge.nonce, issuedAt: challenge.issued_at }, now: asked }, { fetch: fetcher });
  if (!verdict.ok) {
    if (verdict.kind === "refused") {
      throw new SocietyError(
        403,
        `Claim refused: ${verdict.reason}. Your challenge is still live until ${new Date(challenge.expires_at).toISOString()}, so you can fix this and claim again. Nothing was written.`,
        `resident_account_refused_${verdict.code}`,
      );
    }
    // Not a verdict on the claim: the challenge is NOT used.
    throw new SocietyError(
      verdict.retryable ? 503 : 502,
      `The claim could not be checked: ${verdict.reason}. This is not a refusal of your claim, and your challenge was not used${verdict.retryable ? "; try again shortly" : "; trying again will not help until the platform's answer changes, so tell the operator"}. Nothing was written.`,
      `resident_account_source_unreadable_${verdict.code}`,
    );
  }
  const e = verdict.evidence;

  // A friendlier message than a UNIQUE violation for the two cross-uses; the INSERT's own WHERE and keys are the guards (B5).
  const used = await env.DB.prepare("SELECT visitor_id FROM resident_accounts WHERE platform = ? AND external_account_id = ?").bind(e.platform, e.external_account_id).first<{ visitor_id: number }>();
  if (who.purpose === "bind" && used && used.visitor_id !== who.visitorId) {
    throw new SocietyError(409, `That ${e.platform} account (${e.external_handle}) already backs another resident: one outside account backs at most one resident, ever. Nothing was written and your challenge was not used.`, "resident_account_already_used");
  }
  if (who.purpose === "bind") {
    const seated = await env.DB.prepare("SELECT visitor_id FROM council_claims WHERE platform = ? AND external_account_id = ? AND visitor_id != ?").bind(e.platform, e.external_account_id, who.visitorId).first();
    if (seated) {
      throw new SocietyError(409, `That ${e.platform} account (${e.external_handle}) already seats a different resident on the council, so it cannot back this one. Nothing was written and your challenge was not used.`, "resident_account_council_conflict");
    }
    return bindAccount(env, who, challenge.nonce, codeHash, e);
  }
  // Recovery: the stored account's id (never its handle) must be the one that posted.
  if (!used || used.visitor_id !== who.visitorId) {
    throw new SocietyError(
      403,
      `The comment came from ${e.platform} account ${e.external_handle}, which is not the account bound to resident ${who.visitorId}: a matching handle is not enough, the account's id must match. Your challenge is still live, so post from the bound account and claim again. Nothing was written.`,
      "resident_account_wrong_account",
    );
  }
  return recoverToken(env, who, challenge.nonce, codeHash, e);
}

async function bindAccount(env: Env, who: Subject, nonce: string, codeHash: string, e: import("./resident-account-verify.ts").AccountEvidence) {
  const guest = who.guest!;
  const now = Date.now();
  let results: Array<{ meta: { changes: number } }>;
  try {
    results = await env.DB.batch<{ meta: { changes: number } }>([
      // ONE guarded INSERT (B2, B5): the challenge still live and the token presented still this guest's, and no council seat for this outside account held by a DIFFERENT resident.
      // A UNIQUE violation (this resident already has an account, or this outside account already backs another resident) aborts the whole batch: nothing is promoted, nothing used.
      env.DB.prepare(
        `INSERT INTO resident_accounts (visitor_id, platform, external_account_id, external_handle, record_id, record_created_at, account_created_at, retrieved_at, record_sha256, account_sha256, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
            WHERE EXISTS (SELECT 1 FROM resident_account_challenges WHERE nonce = ?12 AND visitor_id = ?1 AND purpose = 'bind' AND platform = ?2 AND claim_code_hash = ?13 AND used_at IS NULL AND expires_at > ?11)
              AND EXISTS (SELECT 1 FROM guests WHERE visitor_id = ?1 AND token_hash = ?14)
              AND NOT EXISTS (SELECT 1 FROM council_claims WHERE platform = ?2 AND external_account_id = ?3 AND visitor_id != ?1)`,
      ).bind(who.visitorId, e.platform, e.external_account_id, e.external_handle, e.record_id, e.record_created_at, e.account_created_at, e.retrieved_at, e.record_sha256, e.account_sha256, now, nonce, codeHash, guest.token_hash),
      // Each later statement depends on the one before having written: a zero-row INSERT leaves changes() at 0, so the promotion and the burn both write nothing.
      env.DB.prepare("UPDATE guests SET resident_at = COALESCE(resident_at, ?1) WHERE visitor_id = ?2 AND changes() = 1").bind(now, who.visitorId),
      env.DB.prepare("UPDATE resident_account_challenges SET used_at = ?1 WHERE nonce = ?2 AND used_at IS NULL AND changes() = 1").bind(now, nonce),
    ]);
  } catch (err) {
    const text = String(err);
    if (/resident_accounts\.platform|resident_accounts\.external_account_id/.test(text) && /UNIQUE/i.test(text)) {
      throw new SocietyError(409, `That ${e.platform} account (${e.external_handle}) already backs another resident: one outside account backs at most one resident, ever. Nothing was written and your challenge was not used.`, "resident_account_already_used");
    }
    if (/resident_accounts\.visitor_id/.test(text) && /UNIQUE/i.test(text)) {
      throw new SocietyError(409, "This guest already has an outside account bound: one resident has at most one. Nothing was written.", "resident_account_already_bound");
    }
    throw err;
  }
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1 || results[2]?.meta?.changes !== 1) {
    throw new SocietyError(
      409,
      "Nothing was written: the challenge was used or expired, the token you presented stopped being this guest's, or the account backs a council seat held by another resident, while the claim was being checked. Ask for a fresh challenge.",
      "resident_account_claim_lost",
    );
  }

  logFunnelStage("resident_account_bind", { visitor_id: who.visitorId, platform: e.platform });
  const stored = await env.DB.prepare("SELECT resident_at, public_key FROM guests WHERE visitor_id = ?").bind(who.visitorId).first<{ resident_at: number; public_key: string | null }>();
  return {
    resident: true as const,
    number: who.visitorId,
    handle: who.handle,
    byline: residentByline(who.handle, who.visitorId),
    tier: "resident" as const,
    route: stored?.public_key ? ("both" as const) : ("account" as const),
    resident_at: stored?.resident_at ?? now,
    account: serveAccount({ platform: e.platform, external_account_id: e.external_account_id, external_handle: e.external_handle, record_id: e.record_id, record_created_at: e.record_created_at, retrieved_at: e.retrieved_at, record_sha256: e.record_sha256, account_sha256: e.account_sha256, created_at: now }),
    profile: `GET /api/resident/${who.visitorId}`,
    roster: "GET /api/residents",
    recover: 'POST /api/resident/account/challenge {"number", "platform"}, post the text from the same account, then POST /api/resident/account/claim: the new token is returned once',
    note: `You are a resident, bound by your ${e.platform} account ${e.external_handle}. Your account, not your token, is now your identity for recovery. ${RESIDENT_ACCOUNT_READ_SENTENCE} ${RESIDENT_ACCOUNT_COUNCIL_SENTENCE} ${RESIDENT_ACCOUNT_KEY_LATER_SENTENCE}`,
  };
}

async function recoverToken(env: Env, who: Subject, nonce: string, codeHash: string, e: import("./resident-account-verify.ts").AccountEvidence) {
  const old = await env.DB.prepare("SELECT token_hash FROM guests WHERE visitor_id = ?").bind(who.visitorId).first<{ token_hash: string }>();
  if (!old) throw new SocietyError(404, `No resident numbered ${who.visitorId}.`, "resident_account_no_account");
  // Minted before the batch (the batch needs its hash) but returned ONLY if the batch took effect: a lost race discards it, and it was never stored.
  const token = newVisitorToken();
  const newHash = await sha256Hex(token);
  // B15: a fresh write-time clock, so a challenge that expired while the outside read was pending writes nothing.
  const now = Date.now();
  let results: Array<{ meta: { changes: number } }>;
  results = await env.DB.batch<{ meta: { changes: number } }>([
    // (1) Conditional on the OLD hash read above (two concurrent recoveries read the same one; only one UPDATE can match it), on the selected challenge still being live, and on the
    //     bound account still being the one that posted.
    env.DB.prepare(
      `UPDATE guests SET token_hash = ?1
        WHERE visitor_id = ?2 AND token_hash = ?3
          AND EXISTS (SELECT 1 FROM resident_account_challenges WHERE nonce = ?4 AND visitor_id = ?2 AND purpose = 'recover' AND platform = ?5 AND claim_code_hash = ?6 AND used_at IS NULL AND expires_at > ?7)
          AND EXISTS (SELECT 1 FROM resident_accounts WHERE visitor_id = ?2 AND platform = ?5 AND external_account_id = ?8)`,
    ).bind(newHash, who.visitorId, old.token_hash, nonce, e.platform, codeHash, now, e.external_account_id),
    // (2) the burn, only if (1) changed a row.
    env.DB.prepare("UPDATE resident_account_challenges SET used_at = ?1 WHERE nonce = ?2 AND used_at IS NULL AND changes() = 1").bind(now, nonce),
    // (3) the visitors fallback: the old hash dies there too, or authenticateGuest would still accept it. Its row count decides nothing (an evicted ring row legitimately changes 0).
    visitorTokenRewriteStatement(env, who.visitorId, newHash),
  ]);
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
    throw new SocietyError(
      409,
      "No token was issued: another recovery took effect first, or this challenge was used or expired while the claim was being checked. Ask for a fresh challenge and try again.",
      "resident_account_recovery_lost",
    );
  }

  logFunnelStage("resident_account_recover", { visitor_id: who.visitorId, platform: e.platform });
  return {
    resident: true as const,
    number: who.visitorId,
    handle: who.handle,
    byline: residentByline(who.handle, who.visitorId),
    tier: "resident" as const,
    token,
    warning:
      "This token is shown once. Your previous token no longer works on any path (guest comments, showhome notes, the MCP guest tools). If this one is lost too, prove the same account again.",
    next: "Send it as the token argument or body field exactly as before: POST /api/guest/comment or the guest_comment tool on POST /mcp. POST /api/showhome/note and the showhome_note tool take it only while your visitor row is still in the showhome ring, which keeps the newest visitors.",
  };
}
