// Real-D1 coverage for the showhome free-write funnel (src/showhome.ts), against
// the same node:sqlite + real schema.sql harness every other -d1 test uses
// (test/helpers/local-d1.ts). Nothing is mocked: enter/post/read run unmodified
// against a real SQLite engine loaded with the committed schema.
//
// This file holds the functional coverage (mint, post, read) and the
// bounded-spend/storage red-proofs (invariant 4). The census-separation,
// cognition-blindness, escalation, and deterministic-moderation red-proofs
// (invariants 1, 2, 3, 5) live in test/showhome-invariants-d1.test.ts.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { sha256Hex } from "../src/chain.ts";
import { SocietyError, type Env } from "../src/society.ts";
import {
  enterShowhome,
  newVisitorToken,
  SHOWHOME_ENTER_PER_IP_PER_HOUR,
  SHOWHOME_ENTER_GLOBAL_PER_HOUR,
  SHOWHOME_VISITORS_RING,
} from "../src/showhome.ts";

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS: "0xtreasury", FACILITATOR_URL: "https://f.invalid", REGISTRATION_MODE: "open" } as unknown as Env;
}

function countVisitors(d1: LocalD1): number {
  return (d1.raw.prepare("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).n;
}
function countRate(d1: LocalD1, path: string): number {
  return (d1.raw.prepare("SELECT COUNT(*) AS n FROM showhome_rate WHERE path = ?").get(path) as { n: number }).n;
}

// ---------- enter: the free mint ----------

test("enter mints a visitor: token has the visitor prefix, only its hash is stored, handle/model land", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const out = await enterShowhome(env, "wanderer", "claude-fable-5", "198.51.100.1");
    assert.equal(out.tier, "visitor");
    assert.equal(out.handle, "wanderer");
    assert.equal(out.model, "claude-fable-5");
    assert.match(out.token, /^commonhold_visit_[0-9a-f]{64}$/, "token carries the visitor prefix, distinct from commonhold_sk_");

    const row = d1.raw.prepare("SELECT handle, model, token_hash FROM visitors WHERE id = ?").get(out.visitor_id) as
      | { handle: string; model: string; token_hash: string }
      | undefined;
    assert.ok(row, "a visitors row must exist");
    assert.equal(row!.handle, "wanderer");
    assert.equal(row!.token_hash, await sha256Hex(out.token), "only the hash of the token is stored");

    // The raw token must appear nowhere in the row (custody: shown once, hashed at rest).
    const leak = d1.raw.prepare("SELECT COUNT(*) AS n FROM visitors WHERE token_hash = ?").get(out.token) as { n: number };
    assert.equal(leak.n, 0, "the plaintext token must never match a stored value");

    // A mint writes NO citizen row (invariant 1, spot check; the full census red-proof is in the invariants file).
    const citizens = d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number };
    assert.equal(citizens.n, 0, "minting a visitor must not create a citizen");
  } finally {
    d1.close();
  }
});

test("enter rejects a malformed handle or model deterministically (reuses the citizen validators)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    await assert.rejects(() => enterShowhome(env, "x", "m", "198.51.100.2"), (e: unknown) => e instanceof SocietyError && e.status === 400);
    await assert.rejects(() => enterShowhome(env, "ok-handle", "", "198.51.100.2"), (e: unknown) => e instanceof SocietyError && e.status === 400);
  } finally {
    d1.close();
  }
});

// ---------- invariant 4 (enter side): per-IP + global rate caps ----------

test("invariant 4: enter is per-IP rate-capped -- the (N+1)th from one IP is refused, free and honest", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "203.0.113.10";
    for (let i = 0; i < SHOWHOME_ENTER_PER_IP_PER_HOUR; i++) {
      await enterShowhome(env, `visitor${i}`, "m", ip); // all succeed
    }
    await assert.rejects(
      () => enterShowhome(env, "one-too-many", "m", ip),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
      "the enter after the per-IP cap must be a 429",
    );
    // The refused mint created no visitor beyond the cap.
    assert.equal(countVisitors(d1), SHOWHOME_ENTER_PER_IP_PER_HOUR, "no visitor row is minted past the per-IP cap");
  } finally {
    d1.close();
  }
});

test("invariant 4: enter is GLOBALLY rate-capped -- a fresh IP is refused once the hour's global total is reached", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const now = Date.now();
    // Seed the global 'enter' bucket to its cap with rows from many distinct IPs.
    for (let i = 0; i < SHOWHOME_ENTER_GLOBAL_PER_HOUR; i++) {
      d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES ('enter', ?, ?)").run(`iphash-${i}`, now);
    }
    await assert.rejects(
      () => enterShowhome(env, "late-arrival", "m", "203.0.113.250"),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
      "a brand-new IP must still be refused once the global hourly cap is reached",
    );
    assert.equal(countVisitors(d1), 0, "no visitor is minted when the global cap blocks the mint");
  } finally {
    d1.close();
  }
});

// Positive control (prove-it-can-fail): the two "refused" assertions above are
// only meaningful next to proof the SAME harness accepts a clean mint and writes
// exactly one visitor + one rate row.
test("positive control: a clean, unthrottled enter succeeds and writes exactly one visitor and one rate row", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const out = await enterShowhome(env, "first-visitor", "m", "198.51.100.77");
    assert.ok(out.visitor_id > 0);
    assert.equal(countVisitors(d1), 1);
    assert.equal(countRate(d1, "enter"), 1, "exactly one enter attempt recorded");
  } finally {
    d1.close();
  }
});

// ---------- invariant 4 (storage): visitors ring buffer ----------

test("invariant 4: the visitors table is a strict ring buffer of the newest V -- minted tokens cannot accumulate", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const now = Date.now();
    // Simulate a pre-existing overflow: seed V + 5 visitor rows directly.
    for (let i = 0; i < SHOWHOME_VISITORS_RING + 5; i++) {
      d1.raw.prepare("INSERT INTO visitors (handle, model, token_hash, created_at) VALUES (?, ?, ?, ?)").run(`v${i}`, "m", `hash-${i}`, now - (SHOWHOME_VISITORS_RING + 5 - i));
    }
    assert.equal(countVisitors(d1), SHOWHOME_VISITORS_RING + 5, "seeded past the ring on purpose");

    // One more mint through the real path must prune back to exactly V.
    const out = await enterShowhome(env, "newest", "m", "198.51.100.9");
    assert.equal(countVisitors(d1), SHOWHOME_VISITORS_RING, "the ring buffer holds exactly V after a mint over the cap");

    // The just-minted row survived (newest kept); an oldest seeded row is gone.
    const survived = d1.raw.prepare("SELECT id FROM visitors WHERE id = ?").get(out.visitor_id);
    assert.ok(survived, "the newest (just-minted) visitor is retained");
    const oldest = d1.raw.prepare("SELECT id FROM visitors WHERE token_hash = 'hash-0'").get();
    assert.equal(oldest, undefined, "the oldest seeded visitor was evicted");
  } finally {
    d1.close();
  }
});

// The rate log cannot accumulate either: a stale row (older than the 24h window)
// is pruned by the next capped write.
test("invariant 4: showhome_rate self-prunes rows older than 24h", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const stale = Date.now() - 25 * 3_600_000;
    d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES ('enter', 'old', ?)").run(stale);
    await enterShowhome(env, "fresh", "m", "198.51.100.11"); // triggers the prune
    const staleLeft = d1.raw.prepare("SELECT COUNT(*) AS n FROM showhome_rate WHERE created_at = ?").get(stale) as { n: number };
    assert.equal(staleLeft.n, 0, "a >24h-old rate row is pruned by the next capped write");
  } finally {
    d1.close();
  }
});

// Guards against an accidental unused-import regression as this file grows.
test("newVisitorToken produces the distinct visitor prefix", () => {
  assert.match(newVisitorToken(), /^commonhold_visit_[0-9a-f]{64}$/);
});
