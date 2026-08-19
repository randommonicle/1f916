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
  postShowhomeNote,
  authenticateVisitor,
  newVisitorToken,
  SHOWHOME_ENTER_PER_IP_PER_HOUR,
  SHOWHOME_ENTER_GLOBAL_PER_HOUR,
  SHOWHOME_POST_PER_IP_PER_HOUR,
  SHOWHOME_POST_GLOBAL_PER_HOUR,
  SHOWHOME_VISITORS_RING,
  SHOWHOME_NOTES_RING,
  SHOWHOME_NOTE_MAX_LEN,
} from "../src/showhome.ts";

async function mint(env: Env, ip = "198.51.100.200"): Promise<string> {
  const out = await enterShowhome(env, `v${Math.random().toString(36).slice(2, 8)}`, "m", ip);
  return out.token;
}
function countNotes(d1: LocalD1): number {
  return (d1.raw.prepare("SELECT COUNT(*) AS n FROM showhome_notes").get() as { n: number }).n;
}

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

// ---------- post: the single scoped write path ----------

test("post: a valid token leaves a note; handle/model are snapshotted onto the row", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const enter = await enterShowhome(env, "marker", "gpt-5", "198.51.100.30");
    const out = await postShowhomeNote(env, enter.token, "hello, is this thing on?", "198.51.100.30");
    assert.equal(out.tier, "visitor");
    assert.equal(out.handle, "marker");
    assert.ok(out.note_id > 0);
    const row = d1.raw.prepare("SELECT visitor_id, handle, model, body FROM showhome_notes WHERE id = ?").get(out.note_id) as
      | { visitor_id: number; handle: string; model: string; body: string }
      | undefined;
    assert.ok(row);
    assert.equal(row!.visitor_id, enter.visitor_id);
    assert.equal(row!.handle, "marker");
    assert.equal(row!.model, "gpt-5");
    assert.equal(row!.body, "hello, is this thing on?");
  } finally {
    d1.close();
  }
});

test("post: an unknown or blank token is refused 401 (no note written)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    await assert.rejects(() => postShowhomeNote(env, "commonhold_visit_deadbeef", "hi", "198.51.100.31"), (e: unknown) => e instanceof SocietyError && e.status === 401);
    await assert.rejects(() => postShowhomeNote(env, "", "hi", "198.51.100.31"), (e: unknown) => e instanceof SocietyError && e.status === 401);
    assert.equal(countNotes(d1), 0);
  } finally {
    d1.close();
  }
});

test("post: size cap -- an empty body and an over-length body are both refused 400", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const token = await mint(env, "198.51.100.32");
    await assert.rejects(() => postShowhomeNote(env, token, "   ", "198.51.100.32"), (e: unknown) => e instanceof SocietyError && e.status === 400);
    await assert.rejects(() => postShowhomeNote(env, token, "x".repeat(SHOWHOME_NOTE_MAX_LEN + 1), "198.51.100.32"), (e: unknown) => e instanceof SocietyError && e.status === 400);
    assert.equal(countNotes(d1), 0);
  } finally {
    d1.close();
  }
});

test("authenticateVisitor accepts a real token and rejects a citizen-shaped secret (disjoint stores)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const enter = await enterShowhome(env, "who", "m", "198.51.100.33");
    const v = await authenticateVisitor(env, enter.token);
    assert.equal(v.handle, "who");
    // A citizen-style secret is not a visitor token -- disjoint identity stores.
    await assert.rejects(() => authenticateVisitor(env, "commonhold_sk_" + "0".repeat(64)), (e: unknown) => e instanceof SocietyError && e.status === 401);
  } finally {
    d1.close();
  }
});

// ---------- invariant 4 (post side): per-IP + global rate caps + notes ring ----------

test("invariant 4: post is per-IP rate-capped -- the (N+1)th note from one IP is refused", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "203.0.113.40";
    const token = await mint(env, ip);
    // mint() already consumed one 'enter' rate row for this IP, but 'enter' and
    // 'post' are separate paths -- the post per-IP budget is untouched.
    for (let i = 0; i < SHOWHOME_POST_PER_IP_PER_HOUR; i++) {
      await postShowhomeNote(env, token, `note ${i}`, ip);
    }
    await assert.rejects(() => postShowhomeNote(env, token, "one too many", ip), (e: unknown) => e instanceof SocietyError && e.status === 429);
    assert.equal(countNotes(d1), SHOWHOME_POST_PER_IP_PER_HOUR, "no note past the per-IP cap");
  } finally {
    d1.close();
  }
});

test("invariant 4: post is GLOBALLY rate-capped across many IPs", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const now = Date.now();
    for (let i = 0; i < SHOWHOME_POST_GLOBAL_PER_HOUR; i++) {
      d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES ('post', ?, ?)").run(`ip-${i}`, now);
    }
    const token = await mint(env, "203.0.113.201");
    await assert.rejects(() => postShowhomeNote(env, token, "late note", "203.0.113.202"), (e: unknown) => e instanceof SocietyError && e.status === 429);
    assert.equal(countNotes(d1), 0, "no note written once the global cap is reached");
  } finally {
    d1.close();
  }
});

test("invariant 4: the notes room is a strict ring buffer of the newest K -- a burst self-heals", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const now = Date.now();
    // Seed the room past the ring on purpose.
    for (let i = 0; i < SHOWHOME_NOTES_RING + 5; i++) {
      d1.raw.prepare("INSERT INTO showhome_notes (visitor_id, handle, model, body, created_at) VALUES (?, ?, ?, ?, ?)").run(1, "seed", "m", `seed ${i}`, now - (SHOWHOME_NOTES_RING + 5 - i));
    }
    assert.equal(countNotes(d1), SHOWHOME_NOTES_RING + 5);
    const token = await mint(env, "198.51.100.44");
    const out = await postShowhomeNote(env, token, "the newest note", "198.51.100.44");
    assert.equal(countNotes(d1), SHOWHOME_NOTES_RING, "the room holds exactly K after a post over the cap");
    assert.ok(d1.raw.prepare("SELECT id FROM showhome_notes WHERE id = ?").get(out.note_id), "the newest note is retained");
    assert.equal(d1.raw.prepare("SELECT id FROM showhome_notes WHERE body = 'seed 0'").get(), undefined, "the oldest note was evicted");
  } finally {
    d1.close();
  }
});

// Guards against an accidental unused-import regression as this file grows.
test("newVisitorToken produces the distinct visitor prefix", () => {
  assert.match(newVisitorToken(), /^commonhold_visit_[0-9a-f]{64}$/);
});
