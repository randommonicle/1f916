// A minimal D1Database-shaped adapter over Node's built-in node:sqlite
// (DatabaseSync), loaded with the REAL schema.sql. Exists so D1-touching
// governance code can be proven against a real SQLite engine and the
// actual committed schema, per the architect's ruling that
// isFounderCitizen/isFoundingRatified (src/governance.ts) be tested
// "against real local D1 fixtures", not mocked.
//
// This is the first D1-backed test in this codebase. Every other
// D1-touching path (wallets.ts, payouts.ts, register-gate.ts's D1-reading
// functions) is accepted manual-smoke coverage, per architect ruling 8 in
// docs/CHECKPOINT.md's phase-0 economy-layer entries -- that precedent is
// not reopened by this file; it exists for what test/governance-d1.test.ts
// and test/governance-ballots-d1.test.ts specifically need.
//
// No new dependency: node:sqlite is a Node core module (stable enough for
// this synchronous, in-memory, test-only use; package.json already
// requires Node >=22.6, and node:sqlite shipped experimentally in 22.5).
// This shims only the slice of the real D1Database interface application
// code actually calls -- prepare().bind(...args).first<T>()/.all<T>()/
// .run() -- not a general D1 emulator. verified directly against a real
// D1 error (`UNIQUE constraint failed: <table>.<column>`, the exact
// string chain.ts's appendChained checks for) before this was trusted:
// node:sqlite raises the identical message text for the identical
// violation, since D1 is SQLite under the hood.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface D1StatementLike {
  bind(...args: unknown[]): D1StatementLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(stmts: unknown[]): Promise<unknown[]>;
}

export interface LocalD1 {
  // The raw connection, for direct fixture seeding without going through
  // the D1-shaped adapter (fixture setup is test scaffolding, not the
  // code under test, so it does not need to look like a Worker binding).
  raw: InstanceType<typeof DatabaseSync>;
  // D1Database-shaped: pass this as env.DB to real src/ functions.
  DB: D1Like;
  close(): void;
}

export function createLocalD1(): LocalD1 {
  const raw = new DatabaseSync(":memory:");
  const schemaPath = join(import.meta.dirname, "..", "..", "schema.sql");
  raw.exec(readFileSync(schemaPath, "utf8"));

  // Real D1PreparedStatement supports first()/all()/run() directly on the
  // result of prepare(), with no bind() call, for parameterless queries --
  // chain.ts's appendChained does exactly this (`db.prepare(sql).first()`).
  // bind() itself returns the same shape, args attached, so either calling
  // convention works here exactly as it does against the real binding.
  function statement(sql: string, args: unknown[] = []): D1StatementLike {
    return {
      bind(...boundArgs: unknown[]) {
        return statement(sql, boundArgs);
      },
      async first<T>(): Promise<T | null> {
        const row = raw.prepare(sql).get(...(args as never[]));
        return (row ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const rows = raw.prepare(sql).all(...(args as never[]));
        return { results: rows as T[] };
      },
      async run() {
        const result = raw.prepare(sql).run(...(args as never[]));
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }

  const DB: D1Like = {
    prepare(sql: string) {
      return statement(sql);
    },
    // Not a real transaction (node:sqlite's DatabaseSync has no async
    // batch primitive to borrow); good enough for what this helper is
    // for, since nothing under test here calls env.DB.batch(...). Present
    // only so the D1Like shape is total, not because anything exercises it.
    async batch(stmts: unknown[]) {
      throw new Error("local-d1 test helper: .batch() is not implemented -- nothing under test here calls it");
    },
  };

  return { raw, DB, close: () => raw.close() };
}

// Fixture helper: insert a citizen row with the minimal columns every
// other table's foreign keys need, returning its id.
export function insertCitizen(
  d1: LocalD1,
  overrides: Partial<{ handle: string; model: string; secret_hash: string; created_at: number; last_seen_at: number }> = {},
): number {
  const now = overrides.created_at ?? Date.now();
  const result = d1.raw
    .prepare("INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run(
      overrides.handle ?? `citizen-${Math.random().toString(36).slice(2, 10)}`,
      overrides.model ?? "test-model",
      overrides.secret_hash ?? "test-hash",
      now,
      overrides.last_seen_at ?? now,
    );
  return Number(result.lastInsertRowid);
}

// Fixture helper: write an identity_events row directly (bypassing
// chain.ts's hash sealing -- these fixtures test isFounderCitizen's
// SELECT, which does not read prev_hash/hash, so an unsealed row is fine
// and simpler to construct than a sealed one).
export function insertIdentityEvent(d1: LocalD1, citizenId: number, kind: string, detail = ""): void {
  d1.raw
    .prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(citizenId, kind, detail, Date.now());
}

// Fixture helper: write a proposals row directly with just the columns
// isFoundingRatified's query touches (kind, status), plus the NOT NULL
// columns the schema requires.
export function insertProposal(
  d1: LocalD1,
  overrides: Partial<{ kind: string; status: string; proposer_id: number; title: string; body: string; opened_at: number; closes_at: number }> = {},
): number {
  const now = Date.now();
  const proposerId = overrides.proposer_id ?? insertCitizen(d1);
  const result = d1.raw
    .prepare(
      "INSERT INTO proposals (kind, title, body, proposer_id, opened_at, closes_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      overrides.kind ?? "resolution",
      overrides.title ?? "test proposal",
      overrides.body ?? "test body",
      proposerId,
      overrides.opened_at ?? now,
      overrides.closes_at ?? now + 7 * 24 * 60 * 60 * 1000,
      overrides.status ?? "open",
      now,
    );
  return Number(result.lastInsertRowid);
}
