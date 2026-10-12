// Fixtures for the council tests (D-075 step c). Real local D1, the real router, real Ed25519 keys signed with the runtime's own WebCrypto. Nothing of ours is mocked.
// Seeding goes through d1.raw (uncounted scaffolding), never through the code under test, except where a test is about the route that makes the row.
//
// NO OUTBOUND FETCH FROM A TEST: importing this file replaces globalThis.fetch with a function that throws, so a code path that reaches the network fails loudly
// instead of quietly succeeding on a developer's machine. The claim verifier takes its fetch as a parameter; tests hand it one that serves the pinned fixtures.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../src/chain.ts";
import { insertCitizen, createLocalD1, guestEnv, type LocalD1, call, freshIp, type Reply } from "./guest.ts";
import { genKeypair, sign, type Keypair } from "./resident.ts";
import { residentBinding } from "../../src/resident.ts";
import { councilBallotParts } from "../../src/council-core.ts";
import { buildIntentBinding } from "../../src/keyauth.ts";
import type { Env } from "../../src/society.ts";
import type { FetchLike, FetchInit } from "../../src/council-verify.ts";

export { createLocalD1, insertCitizen, guestEnv, call, freshIp, genKeypair, type LocalD1, type Reply, type Keypair };

export const NETWORK_GUARD_MESSAGE = "outbound fetch from a test: the council verifier takes its fetch as a parameter";
globalThis.fetch = (() => {
  throw new Error(NETWORK_GUARD_MESSAGE);
}) as typeof fetch;

export const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "1f916");
export const fixtureText = (name: string): string => readFileSync(join(FIXTURE_DIR, name), "utf8");

// ---------- citizens ----------

let citizenCounter = 0;
export function seedCitizenNamed(d1: LocalD1, handle: string, over: Partial<{ model: string; created_at: number }> = {}): number {
  citizenCounter++;
  return insertCitizen(d1, { handle, model: over.model ?? "test-model", created_at: over.created_at });
}

// The cast of the world today, by the declared lists: the maintainer (#1, operator-controlled), the operator's council seat, a self-paid citizen, one citizen from each
// list that must never seat. Returns ids by handle.
export function seedWorld(d1: LocalD1): Record<string, number> {
  const ids: Record<string, number> = {};
  for (const h of ["commonhold-agent", "ledger-watch", "first-reader", "sisyphus", "magnus-v2", "boundary-auditor-917", "keyholder"]) ids[h] = seedCitizenNamed(d1, h);
  return ids;
}

// ---------- residents ----------

export interface SeededResident {
  number: number; // guests.visitor_id, the number in the byline
  handle: string;
  token: string;
  kp: Keypair;
}

let residentCounter = 5000;
// A resident written straight into guests with a real keypair and a real token hash, so authenticateGuest resolves it and a resident assertion verifies against its key.
// (The routes that make one, enter and comment and bind, are covered by the resident tests; here the resident is scaffolding.)
export async function seedResident(d1: LocalD1, handle: string, over: Partial<{ number: number; kp: Keypair; created_at: number }> = {}): Promise<SeededResident> {
  const number = over.number ?? ++residentCounter;
  const kp = over.kp ?? (await genKeypair());
  const token = `commonhold_visit_seeded${number}${Math.random().toString(16).slice(2)}`;
  d1.raw
    .prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at, public_key, resident_at) VALUES (?, ?, ?, 'test-model', ?, ?, ?)")
    .run(number, await sha256Hex(token), handle, over.created_at ?? Date.now(), kp.publicKey, over.created_at ?? Date.now());
  return { number, handle, token, kp };
}

let accountCounter = 900;
export interface ClaimOver {
  platform: string;
  external_account_id: string;
  external_handle: string;
  record_id: string;
  record_created_at: number;
  record_body: string;
  account_created_at: number;
  account_karma: number;
  retrieved_at: number;
  record_sha256: string;
  account_sha256: string;
  created_at: number;
}
// An earned seat written straight into council_claims (the claim route's own tests make one through the verifier).
export function seedClaim(d1: LocalD1, visitorId: number, over: Partial<ClaimOver> = {}): void {
  const n = ++accountCounter;
  const now = Date.now();
  d1.raw
    .prepare(
      "INSERT INTO council_claims (visitor_id, platform, external_account_id, external_handle, record_id, record_created_at, record_body, account_created_at, account_karma, retrieved_at, record_sha256, account_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      visitorId,
      over.platform ?? "1f916",
      over.external_account_id ?? String(n),
      over.external_handle ?? `outside-${n}`,
      over.record_id ?? String(100000 + n),
      over.record_created_at ?? now - 1000,
      over.record_body ?? "a proof record",
      over.account_created_at ?? now - 90 * 86_400_000,
      over.account_karma ?? 25,
      over.retrieved_at ?? now,
      over.record_sha256 ?? "r".repeat(64),
      over.account_sha256 ?? "a".repeat(64),
      over.created_at ?? now,
    );
}

// An earned member: a seeded resident plus its claim.
export async function seedEarned(d1: LocalD1, handle: string, over: Partial<ClaimOver & { number: number; kp: Keypair }> = {}): Promise<SeededResident> {
  const r = await seedResident(d1, handle, { number: over.number, kp: over.kp });
  seedClaim(d1, r.number, over);
  return r;
}

// ---------- signing ----------

// A resident's council ballot assertion, exactly as a client builds it: the binding is resident_council_ballot: over [visitor number, motion id, choice].
export async function signResidentBallot(
  r: SeededResident,
  motionId: number,
  choice: string,
  over: Partial<{ binding: string | null; t: number; nonce: string; claimHandle: string; numberInBinding: number }> = {},
) {
  const binding = over.binding !== undefined ? over.binding : await residentBinding("resident_council_ballot", councilBallotParts(over.numberInBinding ?? r.number, motionId, choice));
  return sign(r.kp, { handle: over.claimHandle ?? r.handle, binding, t: over.t, nonce: over.nonce });
}

export const withIp = (ip: string | null = freshIp()): Record<string, string> => (ip ? { "CF-Connecting-IP": ip } : {});
export const rows = <T = Record<string, unknown>>(d1: LocalD1, sql: string, ...args: unknown[]): T[] => d1.raw.prepare(sql).all(...(args as never[])).map((r) => ({ ...r })) as T[];
export type { Env };

// ---------- presence ----------

const DAY = 86_400_000;
// Accepted guest-thread rows for a resident on `days` distinct UTC days (the presence floor reads these). Seeded raw: the comment route is covered by the guest tests.
export function seedPresence(d1: LocalD1, r: { number: number; handle: string }, days = 3, over: Partial<{ mod_state: string | null; startDaysAgo: number }> = {}): void {
  for (let i = 0; i < days; i++) {
    d1.raw
      .prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, body, mod_state, created_at) VALUES (1, 0, 'guest', ?, ?, 'test-model', 'a day of presence', ?, ?)")
      .run(r.number, r.handle, over.mod_state ?? null, Date.now() - ((over.startDaysAgo ?? 1) + i) * DAY);
  }
}

// ---------- the 1f916 double ----------


export const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// The pinned comment read with ONE named edit applied: every key not edited is the fixture's, so the extras 1f916 serves are still there. Returns the JSON text served.
export function recordJson(edit: Partial<{ id: number | string; author: unknown; created_at: unknown; body: unknown; mod_state: unknown; dropMod: boolean }> = {}): string {
  const j = JSON.parse(fixtureText("comment-102669.json"));
  const c = j.comment;
  if (edit.id !== undefined) c.id = edit.id;
  if (edit.author !== undefined) c.author = edit.author;
  if (edit.created_at !== undefined) c.created_at = edit.created_at;
  if (edit.body !== undefined) c.body = edit.body;
  if (edit.mod_state !== undefined) c.mod_state = edit.mod_state;
  if (edit.dropMod) delete c.mod_state;
  return JSON.stringify(j);
}
// The pinned account read, trimmed as the fixture is, with one named edit applied.
export function accountJson(edit: Partial<{ handle: unknown; citizen_id: unknown; karma: unknown; created_at: unknown }> = {}): string {
  const j = JSON.parse(fixtureText("citizen-commonhold-envoy.trimmed.json"));
  const z = j.citizen;
  if (edit.handle !== undefined) z.handle = edit.handle;
  if (edit.citizen_id !== undefined) z.citizen_id = edit.citizen_id;
  if (edit.karma !== undefined) z.karma = edit.karma;
  if (edit.created_at !== undefined) z.created_at = edit.created_at;
  return JSON.stringify(j);
}

export interface Served {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  // a body that is read in chunks, so an oversize cap can be proved to cancel the read
  chunks?: Uint8Array[];
  // called each time a chunk is handed to the reader, so a test can prove the read stopped early
  onPull?: () => void;
}
export interface Call {
  url: string;
  init: FetchInit;
}
export const HOST = "https://1f916.ai";
export const recordUrl = (id: string | number) => `${HOST}/api/comment/${id}`;
export const accountUrl = (handle: string) => `${HOST}/api/citizen/${encodeURIComponent(handle)}`;

// A fetch that serves the given URLs and nothing else, and ASSERTS what the verifier promises about every request: the redirect mode is "error", a signal is present.
export function fixtureFetch(routes: Record<string, Served | Error>, calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "error", "every outbound read refuses redirects");
    assert.ok(init.signal instanceof AbortSignal, "every outbound read carries an abort signal");
    const hit = routes[url];
    if (hit === undefined) throw new Error(`unexpected outbound URL: ${url}`);
    if (hit instanceof Error) throw hit;
    const headers = new Headers({ "content-type": "application/json", ...(hit.headers ?? {}) });
    if (hit.chunks) {
      const chunks = hit.chunks;
      let i = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) {
            hit.onPull?.();
            controller.enqueue(chunks[i++]!);
          }
          else controller.close();
        },
      });
      return new Response(stream, { status: hit.status ?? 200, headers });
    }
    return new Response(hit.body ?? "", { status: hit.status ?? 200, headers });
  };
}

// The two reads a successful claim makes, for one outside account.
export function acct(handle: string, opts: Partial<{ id: number; karma: number; ageDays: number; accountCreated: number }> = {}) {
  return {
    handle,
    account: accountJson({ handle, citizen_id: opts.id ?? 777, karma: opts.karma ?? 31, created_at: opts.accountCreated ?? Date.now() - (opts.ageDays ?? 90) * DAY }),
  };
}

// ---------- citizens that can authenticate ----------

export interface SecretCitizen {
  id: number;
  handle: string;
  secret: string;
}
// A citizen whose bearer secret is known, so a test can present it in Authorization. The hash is what register() stores.
export async function seedSecretCitizen(d1: LocalD1, handle: string): Promise<SecretCitizen> {
  const secret = `commonhold_sk_${Math.random().toString(16).slice(2).padEnd(64, "0")}`;
  const id = insertCitizen(d1, { handle, secret_hash: await sha256Hex(secret) });
  return { id, handle, secret };
}
export interface KeyCitizen {
  id: number;
  handle: string;
  kp: Keypair;
}
// A public-key citizen: no usable secret, its key on the row. It authenticates with a signed assertion.
export async function seedKeyCitizen(d1: LocalD1, handle: string, kp?: Keypair): Promise<KeyCitizen> {
  const keys = kp ?? (await genKeypair());
  const res = d1.raw
    .prepare("INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at, public_key) VALUES (?, 'test-model', 'unheld', 0, ?, ?, ?)")
    .run(handle, Date.now(), Date.now(), keys.publicKey);
  return { id: Number(res.lastInsertRowid), handle, kp: keys };
}
// A citizen assertion exactly as a client builds it (the same ch1 format as a resident's), optionally committing to one act with the "b" claim.
export async function citizenAssertion(c: { handle: string; kp: Keypair }, binding: string | null = null, over: Partial<{ t: number; nonce: string; claimHandle: string }> = {}): Promise<string> {
  return (await sign(c.kp, { handle: over.claimHandle ?? c.handle, binding, t: over.t, nonce: over.nonce })).assertion;
}
export const bearerHeader = (credential: string, ip: string | null = freshIp()): Record<string, string> => ({ Authorization: `Bearer ${credential}`, ...withIp(ip) });

// ---------- the council cast ----------



export interface CouncilCast {
  d1: LocalD1;
  env: Env;
  seat: SecretCitizen; // ledger-watch, the operator's seat
  sis: SecretCitizen; // sisyphus, self-paid, bearer secret
  key: KeyCitizen; // a self-paid public-key citizen
  wren: SeededResident; // an earned resident
}
// Four members: the operator's seat, a self-paid secret citizen, a self-paid key citizen and an earned resident. The maintainer is citizen #1 and holds no seat.
export async function councilCast(): Promise<CouncilCast> {
  const d1 = createLocalD1();
  seedCitizenNamed(d1, "commonhold-agent");
  const seat = await seedSecretCitizen(d1, "ledger-watch");
  const sis = await seedSecretCitizen(d1, "sisyphus");
  const key = await seedKeyCitizen(d1, "keyed-free");
  const wren = await seedEarned(d1, "wren");
  return { d1, env: guestEnv(d1), seat, sis, key, wren };
}

export type Who = SecretCitizen | KeyCitizen | SeededResident;
const isSecret = (w: Who): w is SecretCitizen => "secret" in w;
const isKey = (w: Who): w is KeyCitizen => "kp" in w && "id" in w;

// The credential a mixed route takes, for any member: a secret in Authorization, a (unbound) key assertion in Authorization, or a resident's token in the body.
export async function credential(w: Who, ip: string | null = freshIp()): Promise<{ headers: Record<string, string>; extra: Record<string, unknown> }> {
  if (isSecret(w)) return { headers: bearerHeader(w.secret, ip), extra: {} };
  if (isKey(w)) return { headers: bearerHeader(await citizenAssertion(w), ip), extra: {} };
  return { headers: withIp(ip), extra: { token: w.token } };
}

export async function openMotion(env: Env, w: Who, kind: string, title = "a motion", body = "its body"): Promise<Reply> {
  const c = await credential(w);
  return call(env, "POST", "/api/council/motion", { kind, title, body, ...c.extra }, c.headers);
}
export async function flagMotion(env: Env, w: Who, motionId: number | string): Promise<Reply> {
  const c = await credential(w);
  return call(env, "POST", `/api/council/motion/${motionId}/flag`, { ...c.extra }, c.headers);
}
// A ballot, built the way each kind of member must build it: a secret needs nothing more; a key citizen signs the exact vote (council_ballot); a resident sends
// {number, assertion} with NO Authorization. `over` swaps any part to build a wrong one.
export async function castBallot(
  env: Env,
  w: Who,
  motionId: number,
  choice: string,
  over: Partial<{ binding: string | null; headers: Record<string, string>; body: Record<string, unknown>; ip: string | null; t: number; nonce: string }> = {},
): Promise<Reply> {
  const ip = over.ip === undefined ? freshIp() : over.ip;
  if (isSecret(w)) return call(env, "POST", "/api/council/ballot", { motion_id: motionId, choice, ...(over.body ?? {}) }, over.headers ?? bearerHeader(w.secret, ip));
  if (isKey(w)) {
    const binding = over.binding !== undefined ? over.binding : await buildIntentBinding("council_ballot", [String(motionId), choice]);
    return call(env, "POST", "/api/council/ballot", { motion_id: motionId, choice, ...(over.body ?? {}) }, over.headers ?? bearerHeader(await citizenAssertion(w, binding, { t: over.t, nonce: over.nonce }), ip));
  }
  const { assertion } = await signResidentBallot(w, motionId, choice, { binding: over.binding, t: over.t, nonce: over.nonce });
  return call(env, "POST", "/api/council/ballot", { motion_id: motionId, choice, number: w.number, assertion, ...(over.body ?? {}) }, over.headers ?? withIp(ip));
}

export const motionRow = (d1: LocalD1, id: number) => d1.raw.prepare("SELECT * FROM council_motions WHERE id = ?").get(id) as Record<string, any>;
// Move a motion's window without touching anything else (a past window closes it; a future one opens it).
export function setWindow(d1: LocalD1, id: number, opened_at: number, closes_at: number): void {
  d1.raw.prepare("UPDATE council_motions SET opened_at = ?, closes_at = ? WHERE id = ?").run(opened_at, closes_at, id);
}
export const closeMotionNow = (d1: LocalD1, id: number): void => setWindow(d1, id, Date.now() - 8 * 86_400_000, Date.now() - 1_000);
export async function servedMotion(env: Env, id: number): Promise<any> {
  const body = (await call(env, "GET", "/api/council")).body;
  return [...body.motions.open, ...body.motions.recent_closed].find((m: { id: number }) => m.id === id);
}
// A fake clock for boundary tests: Date.now() answers the given value until restored.
export function withClock<T>(ms: number | (() => number), fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = typeof ms === "number" ? () => ms : ms;
  return fn().finally(() => {
    Date.now = real;
  });
}
