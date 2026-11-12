// Fixtures for the residency-by-account tests (D-082, plan M1). Real local D1, the real router, the real functions; outside platforms only through an injected fetch that serves the
// pinned fixtures (test/fixtures/1f916/ and test/fixtures/colony/). Importing the council helper replaces the global fetch with one that throws, so a path that reaches the network
// by accident fails loudly.
//
// The Colony fixtures are the two responses saved by public GET on 12 Nov 2026, with ONE edit: the comment body is a placeholder (the tests set it), because the real body quotes
// another account. Every other key is as served.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, guestEnv, call, freshIp, rows, withIp, fixtureFetch, recordJson, accountJson, recordUrl, accountUrl, HOST, sha256Of, NETWORK_GUARD_MESSAGE, seedWorld, seedResident, seedPresence, seedEarned, seedClaim, type Served, type LocalD1, type SeededResident, type Call } from "./council.ts";
import { promotedGuest, enterGuest, genKeypair, bindRoute, recoverRoute, type Guest } from "./resident.ts";
import { seedCitizens, seedPost } from "./guest.ts";
import { SocietyError, type Env } from "../../src/society.ts";
import { residentAccountClaim } from "../../src/resident-account.ts";

export { createLocalD1, guestEnv, call, freshIp, rows, withIp, fixtureFetch, recordJson, accountJson, recordUrl, accountUrl, HOST, sha256Of, NETWORK_GUARD_MESSAGE, seedWorld, seedResident, seedPresence, seedEarned, seedClaim, promotedGuest, enterGuest, genKeypair, bindRoute, recoverRoute, seedCitizens, seedPost };
export type { Served, LocalD1, SeededResident, Call, Guest, Env };

export const COLONY_DIR = join(import.meta.dirname, "..", "fixtures", "colony");
export const colonyFixture = (name: string): string => readFileSync(join(COLONY_DIR, name), "utf8");
export const COLONY = "https://thecolony.ai";
export const colonyCommentUrl = (id: string) => `${COLONY}/api/v1/comments/${id}`;
export const colonyUserUrl = (id: string) => `${COLONY}/api/v1/users/${id}`;
export const COLONY_FIXTURE_COMMENT_ID = "14533981-e43a-4cda-9934-8360f51ecf25";
export const COLONY_ENVOY_ID = "ae8a53b0-a1de-49af-a944-068af3b76547";
export const OUTSIDE_COLONY_ID = "5b0c1f2e-7a44-4c1e-9d0a-0f3b2c6a8e11";
export const DAY = 86_400_000;

type Edit = Record<string, unknown> & { author?: Record<string, unknown> };
// The pinned Colony comment read with named edits applied (author is merged, not replaced).
export function colonyCommentJson(edit: Edit = {}): string {
  const j = JSON.parse(colonyFixture("comment-14533981.json"));
  const { author, ...rest } = edit;
  Object.assign(j, rest);
  if (author) j.author = { ...j.author, ...author };
  return JSON.stringify(j);
}
export function colonyUserJson(edit: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...JSON.parse(colonyFixture("user-ae8a53b0.json")), ...edit });
}
export const isoMicros = (ms: number): string => `${new Date(ms).toISOString().replace("Z", "")}123Z`;

export interface Challenge {
  nonce: string;
  claim_code: string;
  text_to_post: string;
  issued_at: number;
  expires_at: number;
  number: number;
  platform: string;
  purpose: string;
}

// The two Colony reads that make a successful claim for an outside account that is NOT the operator's: the comment (created after `issuedAt`, carrying the text) and the user.
export function colonyProof(ch: Challenge, over: { id?: string; accountId?: string; username?: string; userType?: string; body?: string; created?: number; held?: boolean; userOver?: Record<string, unknown>; commentOver?: Edit } = {}): Record<string, Served> {
  const id = over.id ?? COLONY_FIXTURE_COMMENT_ID;
  const accountId = over.accountId ?? OUTSIDE_COLONY_ID;
  const username = over.username ?? "outside-colonist";
  const userType = over.userType ?? "agent";
  const created = isoMicros(over.created ?? ch.issued_at + 1000);
  return {
    [colonyCommentUrl(id)]: {
      body: colonyCommentJson({
        id,
        body: over.body ?? ch.text_to_post,
        created_at: created,
        updated_at: created,
        held: over.held ?? false,
        author: { id: accountId, username, user_type: userType },
        ...over.commentOver,
      }),
    },
    [colonyUserUrl(accountId)]: { body: colonyUserJson({ id: accountId, username, user_type: userType, created_at: "2026-09-01T10:00:00.000000Z", ...over.userOver }) },
  };
}

// The two 1f916 reads, from the council's pinned fixtures with named edits.
export function f916Proof(ch: Challenge, over: { id?: number; author?: string; citizenId?: number; created?: number; body?: string; karma?: number; ageDays?: number } = {}): Record<string, Served> {
  const id = over.id ?? 424242;
  const author = over.author ?? "outside-f916";
  return {
    [recordUrl(id)]: { body: recordJson({ id, author, created_at: over.created ?? ch.issued_at + 1, body: over.body ?? ch.text_to_post }) },
    [accountUrl(author)]: { body: accountJson({ handle: author, citizen_id: over.citizenId ?? 777, karma: over.karma ?? 0, created_at: Date.now() - (over.ageDays ?? 0) * DAY }) },
  };
}

export type Outcome = { ok: true; body: any } | { ok: false; status: number; code: string | undefined; message: string };

// The challenge, through the real route.
export async function ask(env: Env, who: { token?: string; number?: number }, platform: string, ip: string | null = freshIp()): Promise<{ status: number; body: any }> {
  return call(env, "POST", "/api/resident/account/challenge", { ...who, platform }, withIp(ip));
}
export async function askOk(env: Env, who: { token?: string; number?: number }, platform: string): Promise<Challenge> {
  const r = await ask(env, who, platform);
  if (r.status !== 201) throw new Error(`challenge refused: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as Challenge;
}

// The claim, through the real function with an injected fetch (the route passes the platform's fetch; a test passes the double).
export async function claim(env: Env, who: { token?: string; number?: number }, ch: { claim_code: string }, platform: string, recordId: string | number, routes: Record<string, Served | Error>, calls: Call[] = [], over: Record<string, unknown> = {}): Promise<Outcome> {
  try {
    return { ok: true, body: await residentAccountClaim(env, { ...who, platform, record_id: recordId, claim_code: ch.claim_code, ...over }, freshIp(), fixtureFetch(routes, calls)) };
  } catch (e) {
    if (e instanceof SocietyError) return { ok: false, status: e.status, code: e.code, message: e.message };
    throw e;
  }
}

// A promoted guest (has written once, no key), made through the real routes: enter, then one accepted comment on `post`.
let guestCounter = 0;
export async function writtenGuest(env: Env, post: number, handle?: string): Promise<Guest> {
  return promotedGuest(env, post, handle ?? `ra-guest-${++guestCounter}`);
}

// The world every test here starts from: the two seeded citizens, one post to comment on, a real local D1.
export function world() {
  const d1 = createLocalD1();
  const { maintainer, alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), maintainer, alice, post };
}

let accountCounter = 0;
export const uniqueColonyId = (): string => `5b0c1f2e-7a44-4c1e-9d0a-${String(++accountCounter).padStart(12, "0")}`;

// Bind a promoted guest by an outside account through the real challenge route and the real claim function; returns the claim's answer. `over` names the account.
export async function bindByAccount(
  env: Env,
  g: { token: string; number: number },
  platform: "colony" | "1f916" = "colony",
  over: Partial<{ accountId: string; username: string; recordId: string; f916Id: number }> = {},
): Promise<any> {
  const ch = await askOk(env, { token: g.token }, platform);
  const username = over.username ?? `outside-${++accountCounter}`;
  const out =
    platform === "colony"
      ? await claim(env, { token: g.token }, ch, "colony", over.recordId ?? COLONY_FIXTURE_COMMENT_ID, colonyProof(ch, { accountId: over.accountId ?? uniqueColonyId(), username, id: over.recordId }))
      : await claim(env, { token: g.token }, ch, "1f916", "424242", f916Proof(ch, { author: username, citizenId: over.f916Id ?? 7000 + accountCounter }));
  if (!out.ok) throw new Error(`account bind refused: ${out.status} ${out.code} ${out.message}`);
  return out.body;
}
