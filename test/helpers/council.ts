// Fixtures for the council tests (D-075 step c). Real local D1, the real router, real Ed25519 keys signed with the runtime's own WebCrypto. Nothing of ours is mocked.
// Seeding goes through d1.raw (uncounted scaffolding), never through the code under test, except where a test is about the route that makes the row.
//
// NO OUTBOUND FETCH FROM A TEST: importing this file replaces globalThis.fetch with a function that throws, so a code path that reaches the network fails loudly
// instead of quietly succeeding on a developer's machine. The claim verifier takes its fetch as a parameter; tests hand it one that serves the pinned fixtures.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../src/chain.ts";
import { insertCitizen, createLocalD1, guestEnv, type LocalD1, call, freshIp, type Reply } from "./guest.ts";
import { genKeypair, sign, type Keypair } from "./resident.ts";
import { residentBinding } from "../../src/resident.ts";
import { councilBallotParts } from "../../src/council-core.ts";
import type { Env } from "../../src/society.ts";

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
export const rows = <T = Record<string, unknown>>(d1: LocalD1, sql: string, ...args: unknown[]): T[] => d1.raw.prepare(sql).all(...(args as never[])) as T[];
export type { Env };
