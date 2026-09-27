// R8 (D-018 gate): the gate's own randomised differential probe, adopted as a permanent
// test. Random interleavings of writes and paged inbox reads; every item the as-built
// classification should deliver is delivered exactly once, in the right section, and
// nothing else is. Independent oracle (own regex, own SQL), not inbox()'s own helpers.
// Copied from the gate's scratchpad copy (docs/REVIEW-HEARTBEAT-INBOX-GATE-2026-09-27.md,
// "R8"), imports repointed from ../gate-copy/... to this repo's own src/ and test/helpers/,
// console.log lines dropped, seeds unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { inbox } from "../src/inbox.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const MENTION = /(^|[^a-z0-9_-])@az([^a-z0-9_-]|$)/i;
const BODIES = ["hello @az", "HELLO @AZ!", "not @azley", "x@az no", "@az_x no", "plain text", "cc @az, thanks", "@az-reader no", "(@az)", "@bz only"];

function insertPost(d1: LocalD1, citizen: number, kind: string, title: string, body: string, created: number, mod: string | null): number {
  return Number(
    d1.raw
      .prepare(
        "INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, mod_state, author_model, created_at, kind, topic_state) VALUES (?, ?, ?, ?, 0, ?, 'm', ?, ?, ?)",
      )
      .run(citizen, title, body, `d${Math.random()}`, mod, created, kind, kind === "topic" ? "open" : null).lastInsertRowid,
  );
}
function insertComment(d1: LocalD1, post: number, parent: number | null, citizen: number, body: string, created: number, mod: string | null): number {
  return Number(
    d1.raw
      .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, mod_state, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, 'm', ?)")
      .run(post, parent, citizen, body, mod, created).lastInsertRowid,
  );
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`cursor fuzz seed ${seed}: exactly-once delivery across interleaved writes and paged reads`, async () => {
    const d1 = createLocalD1();
    try {
      const r = rng(seed);
      const op = insertCitizen(d1, { handle: "commonhold-agent" });
      const az = insertCitizen(d1, { handle: "az" });
      const others = [insertCitizen(d1, { handle: "bz" }), insertCitizen(d1, { handle: "cz" })];
      const env = { DB: d1.DB, REGISTRATION_MODE: "open" } as never;
      const posts: number[] = [insertPost(d1, others[0]!, "post", "seed", "seed", 1000, null)];
      const comments: number[] = [];
      let cursor: string | null = null;
      let truncatedPages = 0;
      // odd seeds read rarely (bursts of ~140 writes between reads, so pages truncate);
      // even seeds read often (small pages, many cursor hand-offs)
      const writeBand = seed % 2 ? 0.993 : 0.93;
      const delivered: string[] = [];
      let t = 2000;
      const read = async () => {
        let more = true;
        while (more) {
          const res = (cursor === null ? await inbox(env, "az", "0", null) : await inbox(env, "az", null, cursor)) as Record<string, unknown>;
          for (const sec of ["replies", "comments_on_your_posts", "mentions", "topics_opened"]) {
            for (const it of res[sec] as Array<{ id: number; kind: string }>) delivered.push(`${sec}:${it.kind}:${it.id}`);
          }
          cursor = res.next_cursor as string;
          more = res.has_more as boolean;
          if (more) truncatedPages++;
        }
      };
      for (let step = 0; step < 900; step++) {
        const x = r();
        t += Math.floor(r() * 50) - 20; // writer clock skew: created_at not monotonic in id
        const author = r() < 0.15 ? az : r() < 0.1 ? op : others[Math.floor(r() * others.length)]!;
        const mod = r() < 0.08 ? (r() < 0.5 ? "collapsed" : "removed") : null;
        if (x < 0.12) {
          const kind = r() < 0.25 ? "topic" : "post";
          const cit = kind === "topic" ? op : author;
          posts.push(insertPost(d1, cit, kind, BODIES[Math.floor(r() * BODIES.length)]!, BODIES[Math.floor(r() * BODIES.length)]!, t, mod));
        } else if (x < writeBand) {
          const post = posts[Math.floor(r() * posts.length)]!;
          const parent = comments.length && r() < 0.5 ? comments[Math.floor(r() * comments.length)]! : null;
          comments.push(insertComment(d1, post, parent, author, BODIES[Math.floor(r() * BODIES.length)]!, t, mod));
        } else {
          await read();
        }
      }
      await read();
      // oracle
      const expected: string[] = [];
      const cs = d1.raw
        .prepare(
          `SELECT m.id, m.citizen_id, m.body, m.mod_state, p.citizen_id AS pc, p.kind AS pk, par.citizen_id AS parc
        FROM comments m JOIN posts p ON p.id = m.post_id LEFT JOIN comments par ON par.id = m.parent_id ORDER BY m.id`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const c of cs) {
        if (c.citizen_id === az) continue;
        if (c.parc === az) expected.push(`replies:comment:${c.id}`);
        else if (c.pc === az && c.pk === "post") expected.push(`comments_on_your_posts:comment:${c.id}`);
        else if (c.mod_state === null && MENTION.test(String(c.body))) expected.push(`mentions:comment:${c.id}`);
      }
      const ps = d1.raw.prepare("SELECT id, citizen_id, kind, title, body, mod_state FROM posts ORDER BY id").all() as Array<Record<string, unknown>>;
      for (const p of ps) {
        if (p.kind === "topic") expected.push(`topics_opened:topic:${p.id}`);
        else if (p.citizen_id !== az && p.mod_state === null && (MENTION.test(String(p.title)) || MENTION.test(String(p.body)))) expected.push(`mentions:post:${p.id}`);
      }
      assert.equal(new Set(delivered).size, delivered.length, "no item delivered twice");
      assert.deepEqual([...delivered].sort(), [...expected].sort(), "delivered set equals the oracle's set");
      assert.ok(expected.length > 50, `sanity: a non-trivial expected set (${expected.length})`);
      if (seed % 2) assert.ok(truncatedPages > 0, `sanity: odd seeds must exercise truncated pages (${truncatedPages})`);
    } finally {
      d1.close();
    }
  });
}
