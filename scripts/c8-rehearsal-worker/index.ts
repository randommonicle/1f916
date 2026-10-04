// M3 gate condition C1 (docs/REVIEW-PAID-PATH-M3-GATE-2026-10-03.md): a real-D1 rehearsal of C8 through the Workers D1 binding's batch().
// runBookingStep (src/settlement-claims.ts) takes a secret-mode citizen's id from `out[stmts.length - 1].meta.last_row_id` with no read-back; node:sqlite cannot
// show which statement's meta that is (mutant M7, reading the record UPDATE's meta instead, is green locally). This worker runs the REAL runBookingStep with
// the exact citizen statement register-gate.ts builds (check.mjs asserts the SQL is verbatim) and prints, per case, both statements' meta side by side:
//   (a) gate true: out[0].meta.changes === 1, last_row_id a number equal to the new citizens.id and to the claim's booked_refs.citizen_id, on a table with rows;
//   (b) the same after an unrelated INSERT on the same binding just before the batch (a stale last_insert_rowid()): still the NEW citizen's id;
//   (c) gate false (another owner's live lease): out[0] and out[1] changes 0, applied false, no citizen;
//   (d) out[0].meta.last_row_id and out[1].meta.last_row_id in every case.
// SCRATCH D1 ONLY (rehearsal.wrangler.jsonc; check.mjs refuses any other binding). Every row it writes is tagged and deleted in finally.
import { runBookingStep, type ClaimKey } from "../../src/settlement-claims.ts";
import type { Env } from "../../src/society.ts";

const ASSET = "0x000000000000000000000000000000000000c1c1"; // never a real asset: every rehearsal claim is found and deleted by it
const FROM = "0x000000000000000000000000000000000000c1aa";
const OWNER = "c1-rehearsal-owner";
const LEASE_MS = 60_000;

type Meta = { changes?: number; last_row_id?: unknown };

function recording(env: Env) {
  const seen: { out: Array<{ meta: Meta }> | null } = { out: null };
  const real = env.DB;
  const DB = new Proxy(real as object, {
    get(t: any, p: string | symbol) {
      if (p === "batch") {
        return async (stmts: unknown[]) => {
          const out = await t.batch(stmts);
          seen.out = out;
          return out;
        };
      }
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { env: { ...env, DB } as unknown as Env, seen };
}

async function insertClaim(env: Env, nonce: string, handle: string, leaseOwner: string, now: number): Promise<ClaimKey> {
  await env.DB.prepare(
    `INSERT INTO settlement_claims (network, asset, from_addr, nonce, route, intent_json, intent_hash, rpc_body, rpc_body_hash, valid_before, state, booked_refs, created_at, updated_at, lease_owner, leased_until)
     VALUES ('base', ?, ?, ?, 'register', ?, 'c1-rehearsal', NULL, 'c1-rehearsal', ?, 'settled_unbooked', '{}', ?, ?, ?, ?)`,
  )
    .bind(ASSET, FROM, nonce, JSON.stringify({ handle, model: "c1-rehearsal" }), Math.floor(now / 1000) + 300, now, now, leaseOwner, now + LEASE_MS)
    .run();
  return { network: "base", asset: ASSET, from: FROM, nonce } as ClaimKey;
}

async function runCase(env: Env, label: string, handle: string, nonce: string, leaseOwner: string, staleInsert: boolean) {
  const now = Date.now();
  const key = await insertClaim(env, nonce, handle, leaseOwner, now);
  let stale: unknown = null;
  if (staleInsert) {
    // An unrelated INSERT on the same binding immediately before the batch (register-gate.ts writes reg_log just before its citizen step).
    const r = await env.DB.prepare("INSERT INTO reg_log (ip_hash, created_at) VALUES (?, ?)").bind("c1-rehearsal", now).run();
    stale = r.meta.last_row_id;
  }
  const rec = recording(env);
  const result = await runBookingStep(
    rec.env,
    key,
    {
      ref: "citizen_id",
      final: true, // secret mode: the citizen IS the final step
      statements: async (gate) => [
        rec.env.DB.prepare(
          `INSERT INTO citizens (handle, model, secret_hash, public_key, karma, created_at, last_seen_at) SELECT ?, ?, ?, ?, 0, ?, ? WHERE EXISTS (${gate.sql})`,
        ).bind(handle, "c1-rehearsal", "c1-rehearsal-not-a-secret-hash", null, now, now, ...gate.args),
      ],
    },
    OWNER,
    now,
  );
  const out = rec.seen.out ?? [];
  const citizen = await env.DB.prepare("SELECT id FROM citizens WHERE handle = ?").bind(handle).first<{ id: number }>();
  const claim = await env.DB.prepare(
    "SELECT state, json_extract(booked_refs, '$.citizen_id') AS citizen_ref FROM settlement_claims WHERE network = 'base' AND asset = ? AND from_addr = ? AND nonce = ?",
  )
    .bind(ASSET, FROM, nonce)
    .first<{ state: string; citizen_ref: number | null }>();
  return {
    label,
    batch_length: out.length,
    out0: { changes: out[0]?.meta.changes, last_row_id: out[0]?.meta.last_row_id, last_row_id_type: typeof out[0]?.meta.last_row_id },
    out1: { changes: out[1]?.meta.changes, last_row_id: out[1]?.meta.last_row_id },
    stale_insert_last_row_id: stale,
    applied: result.applied,
    rowId: result.rowId ?? null,
    citizen_id_by_handle: citizen?.id ?? null,
    claim_state: claim?.state ?? null,
    claim_booked_citizen_id: claim?.citizen_ref ?? null,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/run") return new Response("GET /run\n", { status: 404 });
    const tag = Date.now().toString(16);
    const handles = [`c1-rehearsal-a-${tag}`, `c1-rehearsal-b-${tag}`, `c1-rehearsal-c-${tag}`];
    const report: Record<string, unknown> = { database: "commonhold-migtest (scratch)", started: new Date().toISOString() };
    const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settlement_claims'").first();
    if (!table) return Response.json({ ...report, pass: false, error: "settlement_claims is missing: migration 0017 is not on this database" }, { status: 500 });
    const before = await env.DB.prepare("SELECT MAX(id) AS max_id, COUNT(*) AS n FROM citizens").first<{ max_id: number | null; n: number }>();
    report.citizens_before = before;
    if (!before || !before.n) return Response.json({ ...report, pass: false, error: "citizens is empty: (a) needs a table that already has rows" }, { status: 500 });
    try {
      const a = await runCase(env, "a: gate true", handles[0], `0x${tag}a`.padEnd(66, "0"), OWNER, false);
      const b = await runCase(env, "b: gate true after an unrelated INSERT", handles[1], `0x${tag}b`.padEnd(66, "0"), OWNER, true);
      const c = await runCase(env, "c: gate false (another owner's live lease)", handles[2], `0x${tag}c`.padEnd(66, "0"), "c1-rehearsal-someone-else", false);
      const good = (x: typeof a) =>
        x.out0.changes === 1 &&
        x.out0.last_row_id_type === "number" &&
        x.out0.last_row_id === x.citizen_id_by_handle &&
        x.out0.last_row_id === x.claim_booked_citizen_id &&
        x.rowId === x.citizen_id_by_handle &&
        x.applied === true &&
        x.claim_state === "booked" &&
        (x.citizen_id_by_handle ?? 0) > 1;
      const checks = {
        a: good(a),
        b: good(b) && b.stale_insert_last_row_id !== b.citizen_id_by_handle,
        c: c.out0.changes === 0 && c.out1.changes === 0 && c.applied === false && c.citizen_id_by_handle === null && c.claim_state === "settled_unbooked",
        d_printed: [a, b, c].every((x) => "last_row_id" in x.out0 && "last_row_id" in x.out1),
      };
      Object.assign(report, { cases: [a, b, c], checks, pass: Object.values(checks).every(Boolean) });
      report.m7_note =
        "M7 reads out[1].meta.last_row_id (the record UPDATE). If out1.last_row_id differs from out0.last_row_id in (a) or (b), real D1 distinguishes the two and the code's out[stmts.length - 1] is the right one; if equal, both readings give the same id on real D1.";
    } catch (e) {
      report.pass = false;
      report.error = e instanceof Error ? e.message : String(e);
    } finally {
      const del = await env.DB.batch([
        env.DB.prepare("DELETE FROM citizens WHERE handle IN (?, ?, ?)").bind(...handles),
        env.DB.prepare("DELETE FROM settlement_claims WHERE asset = ?").bind(ASSET),
        env.DB.prepare("DELETE FROM reg_log WHERE ip_hash = 'c1-rehearsal'"),
      ]);
      report.cleanup_rows_deleted = del.map((r) => r.meta.changes);
    }
    return Response.json(report);
  },
};
