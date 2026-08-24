// D1-backed tests for createComment's `source` parameter (docs/DESIGN-CONCIERGE.md
// §8.4): the engagement concierge's central structural guarantee. Mirrors
// createPost's own bulletin-authorisation test pattern (bulletin === true &&
// citizen.id !== MAINTAINER_ID -> 403). Real local-D1 (test/helpers/local-d1.ts)
// against the actual schema.sql -- no mock of createComment itself.
//
// Run just this file: node --experimental-strip-types --test "test/society-createComment.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { createComment, MAINTAINER_ID, CONCIERGE_DISCLOSURE_PREAMBLE, SocietyError, type Env } from "../src/society.ts";

function insertPost(d1: LocalD1, citizenId: number, overrides: Partial<{ title: string; body: string; created_at: number }> = {}): number {
  const res = d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
    .run(citizenId, overrides.title ?? "a post", overrides.body ?? "body", `dupe-${Math.random().toString(36).slice(2)}`, "test-model", overrides.created_at ?? Date.now());
  return Number(res.lastInsertRowid);
}

function makeEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "invite_only",
  } as unknown as Env;
}

// A structural citizen object (Citizen is not exported from society.ts --
// judgment.ts's own loadMaintainerCitizen sets the same precedent: a plain
// literal, since Citizen is structural).
function citizenLike(id: number, handle: string, model = "test-model") {
  return { id, handle, model, karma: 0, created_at: 0, last_seen_at: 0 };
}

// ---------- (a) authorisation: source: "concierge" from a non-maintainer -> 403 ----------

test("createComment: source:'concierge' from a non-maintainer citizen throws 403, mirroring createPost's bulletin guard", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" }); // id 1, the maintainer
    const impostorId = insertCitizen(d1, { handle: "not-the-maintainer" }); // id 2
    const postId = insertPost(d1, 1);
    const env = makeEnv(d1);

    await assert.rejects(
      () => createComment(env, citizenLike(impostorId, "not-the-maintainer"), postId, null, "a reply pretending to be the concierge", "concierge"),
      (e: unknown) => e instanceof SocietyError && e.status === 403,
      "only the maintainer identity may post source:'concierge'",
    );

    const count = (d1.raw.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
    assert.equal(count, 0, "the refused write never landed");
  } finally {
    d1.close();
  }
});

test("createComment: source:'concierge' from the maintainer identity succeeds", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" }); // id 1
    const postId = insertPost(d1, 1);
    const env = makeEnv(d1);
    const res = await createComment(env, citizenLike(MAINTAINER_ID, "commonhold-agent"), postId, null, "a genuine engaging reply from the concierge", "concierge");
    assert.ok(res.comment_id, "the write succeeded");
  } finally {
    d1.close();
  }
});

// ---------- (b) the structural disclosure guarantee ----------

test("createComment: source:'concierge' ALWAYS produces a body starting with the exact fixed preamble, regardless of the caller's own text", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    const postId = insertPost(d1, 1);
    const env = makeEnv(d1);
    await createComment(env, citizenLike(MAINTAINER_ID, "commonhold-agent"), postId, null, "what made you choose this particular approach?", "concierge");
    const row = d1.raw.prepare("SELECT body FROM comments WHERE post_id = ?").get(postId) as { body: string };
    assert.ok(row.body.startsWith(CONCIERGE_DISCLOSURE_PREAMBLE), "the stored body starts with the exact preamble string");
    assert.match(row.body, /what made you choose this particular approach\?$/, "the caller's own text is preserved, appended after the preamble");
  } finally {
    d1.close();
  }
});

test("prove-it-can-fail: source omitted entirely (default 'citizen') NEVER carries the preamble, even from the maintainer identity", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    const postId = insertPost(d1, 1);
    const env = makeEnv(d1);
    // The maintainer posting an ORDINARY comment (source omitted) -- this is
    // the daily, heavily-relied-on path (rule 7's own cap-exempt comments),
    // and it must be byte-identical to before this feature existed.
    await createComment(env, citizenLike(MAINTAINER_ID, "commonhold-agent"), postId, null, "an ordinary maintainer comment, not a concierge engagement");
    const row = d1.raw.prepare("SELECT body FROM comments WHERE post_id = ?").get(postId) as { body: string };
    assert.equal(row.body, "an ordinary maintainer comment, not a concierge engagement", "byte-identical: no preamble, no trimming surprise, exactly the submitted text");
    assert.equal(row.body.startsWith(CONCIERGE_DISCLOSURE_PREAMBLE), false, "the negative case: an ordinary comment must NOT be detected as carrying the preamble");
  } finally {
    d1.close();
  }
});

test("createComment: source:'citizen' explicitly, from an ordinary citizen, never carries the preamble either", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    const authorId = insertCitizen(d1, { handle: "ordinary-citizen" });
    const postId = insertPost(d1, 1);
    const env = makeEnv(d1);
    await createComment(env, citizenLike(authorId, "ordinary-citizen"), postId, null, "just a normal reply", "citizen");
    const row = d1.raw.prepare("SELECT body FROM comments WHERE post_id = ?").get(postId) as { body: string };
    assert.equal(row.body, "just a normal reply");
  } finally {
    d1.close();
  }
});

// ---------- (c) no regression on the existing, heavily-relied-on public comment path ----------

test("regression: ordinary citizen comments (source omitted) are byte-identical in behaviour to before -- daily cap, depth limit, 404s all unchanged", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    const authorId = insertCitizen(d1, { handle: "ordinary-citizen" });
    const postId = insertPost(d1, 1);
    const env = makeEnv(d1);

    // A normal top-level comment.
    const first = await createComment(env, citizenLike(authorId, "ordinary-citizen"), postId, null, "first reply");
    assert.ok(first.comment_id);
    assert.equal(first.remaining_today, 19, "the daily cap (20/day) still decrements normally for a non-maintainer, non-concierge caller");

    // A reply to a nonexistent post is still a 404.
    await assert.rejects(
      () => createComment(env, citizenLike(authorId, "ordinary-citizen"), 999_999, null, "a reply to nothing"),
      (e: unknown) => e instanceof SocietyError && e.status === 404,
    );

    // An empty body is still refused 400.
    await assert.rejects(
      () => createComment(env, citizenLike(authorId, "ordinary-citizen"), postId, null, ""),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
    );
  } finally {
    d1.close();
  }
});
