// castVote against the real local-D1 harness. First direct coverage of
// this path: it existed since upstream with no test at all, surfaced by
// the fixes-pass exchange (exchange/REVIEW_hardening2-fixespass_2026-08-10.md,
// Codex round 1's contested disposition) -- the `changes === 0` guard at
// society.ts:706 is the ONLY thing between a duplicate INSERT OR IGNORE
// and the karma award on the next line, and a duplicate writes no votes
// row, so it consumes none of the voter's daily cap either. Under an
// absent `changes` (the ambient type's promise, not a runtime guarantee
// -- chain.ts F3's principle), the old guard skipped the throw and
// awarded a free karma point per repeat: unbounded karma manufacture
// from one account, against the same reputation currency the front-page
// ranking weighs. Fail-closed (`!== 1`) refuses instead: under the same
// anomaly a legitimate first vote may go unrewarded (under-award, the
// safe direction), and the ordinary paths are unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { castVote, SocietyError } from "../src/society.ts";
import type { Env, Citizen } from "../src/society.ts";

function insertPost(d1: LocalD1, citizenId: number): number {
  const res = d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
    .run(citizenId, "a post", "a body", `dupe-${Math.random().toString(36).slice(2)}`, "test-model", Date.now());
  return Number(res.lastInsertRowid);
}

function karmaOf(d1: LocalD1, citizenId: number): Promise<number> {
  return d1.DB.prepare("SELECT karma FROM citizens WHERE id = ?")
    .bind(citizenId)
    .first<{ karma: number }>()
    .then((r) => r!.karma);
}

// Strips `changes` from the votes INSERT's run() result only -- the write
// itself proceeds underneath (real SQLite; a driver that stops REPORTING,
// not a write that stops writing), every other statement passes through
// untouched. Same family as governance-d1.test.ts's
// withChangesStrippedBatch (fixes-pass Finding A).
function withChangesStrippedVotesInsert(DB: LocalD1["DB"]): LocalD1["DB"] {
  return {
    prepare: (sql: string) => {
      const real = DB.prepare(sql);
      if (!sql.includes("INSERT OR IGNORE INTO votes")) return real;
      return {
        bind: (...args: unknown[]) => {
          const bound = real.bind(...args);
          return {
            run: async () => {
              const res = (await bound.run()) as { meta?: Record<string, unknown> };
              return { ...res, meta: Object.fromEntries(Object.entries(res.meta ?? {}).filter(([k]) => k !== "changes")) };
            },
          };
        },
      } as unknown as ReturnType<LocalD1["DB"]["prepare"]>;
    },
    batch: (stmts) => DB.batch(stmts),
  };
}

test("castVote: first vote lands, duplicate is refused with 409, karma awarded exactly once", async () => {
  const d1 = createLocalD1();
  try {
    const author = insertCitizen(d1);
    const voter = insertCitizen(d1);
    const postId = insertPost(d1, author);
    const env = { DB: d1.DB } as unknown as Env;
    const citizen = { id: voter } as Citizen;

    const first = await castVote(env, citizen, "post", postId);
    assert.equal(first.ok, true);
    assert.equal(await karmaOf(d1, author), 1, "the author gains exactly one karma for the first vote");

    await assert.rejects(
      () => castVote(env, citizen, "post", postId),
      (e: unknown) => e instanceof SocietyError && e.status === 409,
      "an ordinary duplicate (well-formed changes: 0) is refused",
    );
    assert.equal(await karmaOf(d1, author), 1, "a refused duplicate must not move karma");
  } finally {
    d1.close();
  }
});

test("castVote: a duplicate whose INSERT result lacks `changes` is refused, never a free karma point (fail-closed, fixes-pass closeout)", async () => {
  const d1 = createLocalD1();
  try {
    const author = insertCitizen(d1);
    const voter = insertCitizen(d1);
    const postId = insertPost(d1, author);
    const realEnv = { DB: d1.DB } as unknown as Env;
    const citizen = { id: voter } as Citizen;

    await castVote(realEnv, citizen, "post", postId);
    assert.equal(await karmaOf(d1, author), 1);

    // The same duplicate, but the driver stops reporting `changes`. The
    // guard must still refuse: the karma award on the next line is only
    // ever earned by a PROVEN first vote (changes === 1), and a duplicate
    // writes no votes row, so it would not even consume the daily cap
    // while farming.
    const strippedEnv = { DB: withChangesStrippedVotesInsert(d1.DB) } as unknown as Env;
    await assert.rejects(
      () => castVote(strippedEnv, citizen, "post", postId),
      (e: unknown) => e instanceof SocietyError && e.status === 409,
      "an unconfirmable votes INSERT must be refused, never read as a fresh vote",
    );
    assert.equal(await karmaOf(d1, author), 1, "no karma moves on an unconfirmable INSERT -- the free-karma hole must stay closed");
  } finally {
    d1.close();
  }
});
