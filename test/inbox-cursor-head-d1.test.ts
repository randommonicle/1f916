// A cursor part above the newest row id of its own table (found by soft-power and load-bearing-2 on 1f916 post 9594, 23-24 Nov
// 2026). Before this wave GET /api/inbox and GET /api/guest/inbox answered 200 with no rows and the caller's own value back as
// next_cursor, so a client that followed next_cursor stayed above the head and the rows written up to its value were never
// delivered, with nothing to tell it. Now the part is refused with 400. Real local D1, the real router, both MCP doors.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, guestComment, call, type LocalD1 } from "./helpers/guest.ts";
import { postGuestAnswer } from "../src/guest.ts";
import type { Env } from "../src/society.ts";

const ALICE = { id: 2, handle: "alice", model: "test-model" };

interface World {
  d1: LocalD1;
  env: Env;
  visitor: number;
  row: string;
  topic: number;
}

async function world(): Promise<World> {
  const d1 = createLocalD1();
  seedCitizens(d1); // 1 = commonhold-agent, 2 = alice
  insertCitizen(d1, { handle: "bob" }); // 3
  const env = guestEnv(d1);
  const topic = seedTopic(d1);
  const v = await seedVisitor(d1, "wren");
  const g = await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  addComment(d1, topic, 3, "a first comment");
  return { d1, env, visitor: v.id, row: g.body.comment_id as string, topic };
}

function addComment(d1: LocalD1, post: number, citizen: number, body: string): number {
  return Number(
    d1.raw
      .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, ?, ?, 0, 'test-model', ?)")
      .run(post, citizen, body, Date.now()).lastInsertRowid,
  );
}

const head = (d1: LocalD1, table: string): number => Number((d1.raw.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m);

async function mcpGuestInbox(env: Env, door: "/mcp" | "/mcp/read", args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await worker.fetch(
    new Request(`https://example.test${door}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_inbox", arguments: args } }) }),
    env,
  );
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: body.result.isError === true, text: body.result.content[0].text };
}

const ROUTES = [
  {
    path: "/api/guest/inbox",
    base: (w: World) => `guest=${w.visitor}`,
    cursor: (g: number, c: number, p: number) => `g${g}-c${c}-p${p}`,
    restart: "omit cursor to start again",
  },
  {
    path: "/api/inbox",
    base: () => "handle=alice",
    cursor: (g: number, c: number, p: number) => `c${c}-p${p}-g${g}`,
    restart: "pass since=<ms> to start again",
  },
] as const;

const PARTS = [
  { name: "guest row", table: "guest_thread", at: 0 },
  { name: "comment", table: "comments", at: 1 },
  { name: "post", table: "posts", at: 2 },
] as const;

test("each part, on both routes: one above the newest row of its own table is refused with 400, the safe-integer ceiling included, and the served head itself is 200", async () => {
  // Mutations that redden this: delete the `startId > head` check in runTablePage; `>` -> `>=` (the served head is then refused); compare against another table's head (the parts below differ per table).
  const w = await world();
  try {
    addComment(w.d1, w.topic, 3, "a second comment, so the three tables' heads differ");
    const heads = [head(w.d1, "guest_thread"), head(w.d1, "comments"), head(w.d1, "posts")] as [number, number, number];
    assert.notEqual(heads[0], heads[1], "the fixture's heads differ, so a check against the wrong table shows");
    for (const r of ROUTES) {
      const served = (await call(w.env, "GET", `${r.path}?${r.base(w)}&cursor=${r.cursor(...heads)}`)) as { status: number; body: any };
      assert.equal(served.status, 200, `${r.path} at the head`);
      assert.equal(served.body.next_cursor, r.cursor(...heads), "the head is served back");
      const padded = r.cursor(...heads).replace(/\d+/g, (n) => "000" + n);
      const paddedRead = await call(w.env, "GET", `${r.path}?${r.base(w)}&cursor=${padded}`);
      assert.deepEqual([paddedRead.status, paddedRead.body.next_cursor], [200, r.cursor(...heads)], "leading zeros still read as the same number, at the head too");
      assert.equal((await call(w.env, "GET", `${r.path}?${r.base(w)}&cursor=${r.cursor(0, 0, 0)}`)).status, 200, "a cursor below the head still reads");
      for (const part of PARTS) {
        for (const value of [heads[part.at] + 1, heads[part.at] + 1000, Number.MAX_SAFE_INTEGER]) {
          const parts = [...heads] as [number, number, number];
          parts[part.at] = value;
          const res = await call(w.env, "GET", `${r.path}?${r.base(w)}&cursor=${r.cursor(...parts)}`);
          assert.equal(res.status, 400, `${r.path} ${part.name} ${value}: ${JSON.stringify(res.body)}`);
          assert.equal(
            res.body.error,
            `cursor's ${part.name} id is ${value}, above the newest one here (${heads[part.at]}). A cursor is read only as served in a previous response's next_cursor; ${r.restart}.`,
          );
        }
      }
    }
  } finally {
    w.d1.close();
  }
});

test("the loss this stops: a client one row ahead of the head is refused instead of being told it is caught up and then missing the next row", async () => {
  // Mutation that reddens this: delete the `startId > head` check (the first call is then 200 with no rows and its own cursor back, and the answer written next is never delivered to it).
  const w = await world();
  try {
    const g = head(w.d1, "guest_thread");
    const ahead = `g${g + 1}-c${head(w.d1, "comments")}-p${head(w.d1, "posts")}`;
    const before = await call(w.env, "GET", `/api/guest/inbox?guest=${w.visitor}&cursor=${ahead}`);
    const answer = await postGuestAnswer(w.env, ALICE, { guest_comment_id: w.row, body: "an answer written after the client's read" });
    assert.equal(head(w.d1, "guest_thread"), g + 1, `the answer took the row id the client named: ${JSON.stringify(answer.body)}`);
    if (before.status === 200) {
      const followed = await call(w.env, "GET", `/api/guest/inbox?guest=${w.visitor}&cursor=${before.body.next_cursor}`);
      assert.equal(followed.body.answers.length, 1, `the client followed next_cursor ${before.body.next_cursor} and was told has_more ${followed.body.has_more} with ${followed.body.answers.length} answers; the answer is never delivered to it`);
    }
    assert.equal(before.status, 400);
    const restarted = await call(w.env, "GET", `/api/guest/inbox?guest=${w.visitor}`);
    assert.equal(restarted.body.answers.length, 1, "starting again without a cursor, as the refusal says, delivers it");
  } finally {
    w.d1.close();
  }
});

test("both MCP doors refuse it with the same sentence, and the since path never reaches the check", async () => {
  const w = await world();
  try {
    const g = head(w.d1, "guest_thread");
    for (const door of ["/mcp", "/mcp/read"] as const) {
      const r = await mcpGuestInbox(w.env, door, { guest: w.visitor, cursor: `g${g + 1}-c0-p0` });
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, new RegExp(`cursor's guest row id is ${g + 1}, above the newest one here \\(${g}\\)`));
    }
    // a since in the future starts at the head (it is turned into a row id inside the query), so it is not refused
    const future = await call(w.env, "GET", `/api/inbox?handle=alice&since=${Date.now() + 86_400_000_000}`);
    assert.equal(future.status, 200, JSON.stringify(future.body));
  } finally {
    w.d1.close();
  }
});

test("empty tables: a zero part is not above an empty table's head, and 1 is", async () => {
  // Mutation that reddens this: read an empty table's head as anything but 0.
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    assert.equal((await call(env, "GET", "/api/inbox?handle=alice&cursor=c0-p0")).status, 200);
    const res = await call(env, "GET", "/api/inbox?handle=alice&cursor=c1-p0");
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /cursor's comment id is 1, above the newest one here \(0\)/);
  } finally {
    d1.close();
  }
});

test("served text: both cursor notes bound the claim to a served cursor and name the refusal, and openapi.json's two cursor parameters say it", async () => {
  const w = await world();
  try {
    seedPost(w.d1, 2);
    const citizen = (await call(w.env, "GET", "/api/inbox?handle=alice&since=0")).body.cursor_note as string;
    const guest = (await call(w.env, "GET", `/api/guest/inbox?guest=${w.visitor}`)).body.cursor_note as string;
    for (const note of [citizen, guest]) {
      assert.equal(/nothing committed after this page can be skipped/.test(note), false, "the unbounded sentence is gone");
      assert.match(note, /A part above the newest row of its table is refused with 400/);
    }
    const doc = (await call(w.env, "GET", "/openapi.json")).body;
    for (const path of ["/api/inbox", "/api/guest/inbox"]) {
      const p = doc.paths[path].get.parameters.find((x: any) => x.name === "cursor");
      assert.match(p.description, /above the newest row id of its table, is refused with 400/);
    }
  } finally {
    w.d1.close();
  }
});
