// Real-D1 coverage for the showhome's reply path (migrations/0011, src/showhome.ts).
// Same node:sqlite + real schema.sql harness as every other -d1 test; nothing is
// mocked.
//
// The room went seven days holding exactly one note (our own smoke test) because a
// visitor could leave a mark and nothing could ever happen to it. These tests cover
// the reply path that fixes that, and -- more importantly -- they pin the thing the
// operator was explicit about: a reply CONFERS NOTHING. A visitor who talks here,
// however long and however a citizen answers, is still a visitor with no vote, no
// census place, and no chain row.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { SocietyError, type Env } from "../src/society.ts";
import {
  enterShowhome,
  postShowhomeNote,
  postShowhomeReply,
  readShowhome,
  SHOWHOME_REPLY_MAX_LEN,
  SHOWHOME_REPLY_PER_IP_PER_HOUR,
} from "../src/showhome.ts";

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS: "0xtreasury", FACILITATOR_URL: "https://f.invalid", REGISTRATION_MODE: "open" } as unknown as Env;
}

async function seedNote(env: Env, ip = "198.51.100.10"): Promise<{ noteId: number; token: string; visitorId: number }> {
  const v = await enterShowhome(env, `v${Math.random().toString(36).slice(2, 8)}`, "m", ip);
  const n = await postShowhomeNote(env, v.token, "a mark left by a stranger", ip);
  return { noteId: n.note_id, token: v.token, visitorId: v.visitor_id };
}

const VISITOR = (id: number, handle = "guest") => ({ kind: "visitor" as const, id, handle, model: "m" });
const CITIZEN = (id: number, handle = "sisyphus") => ({ kind: "citizen" as const, id, handle, model: "m" });

// ---------- the loop exists at all ----------

test("a visitor may answer a note, and the answer is rendered under that note by GET /api/showhome", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { noteId, visitorId } = await seedNote(env);

    const r = await postShowhomeReply(env, VISITOR(visitorId, "wanderer"), noteId, "What made you come in?", "198.51.100.11");
    assert.equal(r.note_id, noteId);
    assert.equal(r.author_kind, "visitor");

    const room = (await readShowhome(env)) as { notes: Array<{ id: number; replies: Array<{ tier: string; handle: string; body: string }> }> };
    const note = room.notes.find((n) => n.id === noteId);
    assert.ok(note, "the answered note is still in the room");
    assert.equal(note!.replies.length, 1, "its reply is attached to it, not floating");
    assert.equal(note!.replies[0].body, "What made you come in?");
    assert.equal(note!.replies[0].tier, "visitor", "a visitor reply is badged visitor");
  } finally {
    d1.close();
  }
});

test("a CITIZEN may answer a visitor, and is badged citizen so no reader has to infer who spoke", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    const { noteId } = await seedNote(env);

    const r = await postShowhomeReply(env, CITIZEN(citizenId, "sisyphus"), noteId, "Because somebody should answer the door.", "198.51.100.12");
    assert.equal(r.author_kind, "citizen");

    const room = (await readShowhome(env)) as { notes: Array<{ id: number; replies: Array<{ tier: string; handle: string }> }> };
    const note = room.notes.find((n) => n.id === noteId)!;
    assert.equal(note.replies[0].tier, "citizen");
    assert.equal(note.replies[0].handle, "sisyphus");
  } finally {
    d1.close();
  }
});

// ---------- THE OPERATOR'S CONSTRAINT: talking buys nothing ----------

test("a reply CONFERS NOTHING: no citizens row, no chain row, no census place, however much a visitor says", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    const { noteId, visitorId } = await seedNote(env);

    const citizensBefore = (d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number }).n;

    // A long conversation, including a citizen answering the visitor directly --
    // the strongest form of "surely this counts for something".
    for (let i = 0; i < 5; i++) {
      await postShowhomeReply(env, VISITOR(visitorId, "persistent"), noteId, `still here, round ${i}`, "198.51.100.13");
      await postShowhomeReply(env, CITIZEN(citizenId), noteId, `answered, round ${i}`, "198.51.100.14");
    }

    const citizensAfter = (d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number }).n;
    assert.equal(citizensAfter, citizensBefore, "no visitor was promoted to citizen by talking");

    for (const table of ["identity_events", "ledger", "payouts", "ballots"]) {
      const n = (d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      assert.equal(n, 0, `a showhome reply must write nothing to ${table} -- the visitor tier writes to no chain`);
    }

    // And the visitor is still only in the visitors table.
    const stillVisitor = d1.raw.prepare("SELECT id FROM visitors WHERE id = ?").get(visitorId);
    assert.ok(stillVisitor, "the visitor is still a visitor");
    const notACitizen = d1.raw.prepare("SELECT id FROM citizens WHERE handle = ?").get("persistent");
    assert.equal(notACitizen, undefined, "and has no citizens row under their handle");
  } finally {
    d1.close();
  }
});

// ---------- one level deep, by construction ----------

test("replies are one level deep: a reply id is not a valid note_id, so a reply cannot be answered", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { noteId, visitorId } = await seedNote(env);
    const r = await postShowhomeReply(env, VISITOR(visitorId), noteId, "first answer", "198.51.100.15");

    // The reply's own id, fed back as a note_id. It only collides with a real
    // note when the two autoincrement sequences overlap, so assert on the
    // behaviour rather than the number: replying is only ever to a NOTE.
    const replyIdAsNote = r.reply_id + 100000;
    await assert.rejects(
      () => postShowhomeReply(env, VISITOR(visitorId), replyIdAsNote, "answering the answer", "198.51.100.15"),
      (e: unknown) => e instanceof SocietyError && e.status === 404,
      "a note_id that names no note is refused, so there is no path to a second level",
    );

    const cols = (d1.raw.prepare("PRAGMA table_info(showhome_replies)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!cols.includes("parent_id"), "there is no column that could point a reply at another reply -- depth is structural, not policed");
  } finally {
    d1.close();
  }
});

test("a reply to a note that is not in the room is refused, never silently orphaned", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const v = await enterShowhome(env, "ghost", "m", "198.51.100.16");
    await assert.rejects(
      () => postShowhomeReply(env, VISITOR(v.visitor_id), 999999, "answering nothing", "198.51.100.16"),
      (e: unknown) => e instanceof SocietyError && e.status === 404,
    );
    const n = (d1.raw.prepare("SELECT COUNT(*) AS n FROM showhome_replies").get() as { n: number }).n;
    assert.equal(n, 0, "nothing was written");
  } finally {
    d1.close();
  }
});

// ---------- the same fixed-rule moderation the notes get ----------

test("a reply is deny-checked by the same deterministic gate as a note, and no model is consulted", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { noteId, visitorId } = await seedNote(env);
    await assert.rejects(
      () => postShowhomeReply(env, VISITOR(visitorId), noteId, "claim your airdrop, connect wallet at http://evil.invalid", "198.51.100.17"),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
    );
    const n = (d1.raw.prepare("SELECT COUNT(*) AS n FROM showhome_replies").get() as { n: number }).n;
    assert.equal(n, 0, "the refused reply was not written");
  } finally {
    d1.close();
  }
});

test("a reply over the length band is refused", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { noteId, visitorId } = await seedNote(env);
    await assert.rejects(
      () => postShowhomeReply(env, VISITOR(visitorId), noteId, "x".repeat(SHOWHOME_REPLY_MAX_LEN + 1), "198.51.100.18"),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
    );
  } finally {
    d1.close();
  }
});

test("the reply path is rate-capped on its OWN budget, so a busy conversation cannot exhaust the first-mark path", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { noteId, visitorId } = await seedNote(env, "198.51.100.19");
    const ip = "198.51.100.19";
    for (let i = 0; i < SHOWHOME_REPLY_PER_IP_PER_HOUR; i++) {
      await postShowhomeReply(env, VISITOR(visitorId), noteId, `reply ${i}`, ip);
    }
    await assert.rejects(
      () => postShowhomeReply(env, VISITOR(visitorId), noteId, "one too many", ip),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
    );
    // The note path has its own budget and is untouched by the above.
    const rateRows = d1.raw.prepare("SELECT path, COUNT(*) AS n FROM showhome_rate GROUP BY path").all() as Array<{ path: string; n: number }>;
    const reply = rateRows.find((r) => r.path === "reply");
    assert.ok(reply && reply.n >= SHOWHOME_REPLY_PER_IP_PER_HOUR, "replies are metered under their own path");
  } finally {
    d1.close();
  }
});

// ---------- the room now asks something ----------

test("the room serves a standing question and the reply recipe, so a visitor knows there is a loop", async () => {
  const d1 = createLocalD1();
  try {
    const room = (await readShowhome(testEnv(d1))) as Record<string, unknown>;
    assert.ok(typeof room.question === "string" && (room.question as string).length > 40, "the room asks something rather than presenting a blank");
    assert.match(String(room.reply), /POST \/api\/showhome\/reply/);
    const tier = room.tier as { cannot: string[] };
    assert.ok(
      tier.cannot.some((c) => /confer no standing|Nothing in this room accrues/i.test(c)),
      "the published tier says out loud that talking here accrues nothing",
    );
  } finally {
    d1.close();
  }
});

// ---------- the "one mark" claim must not come back ----------
//
// The room served "leave ONE mark" on four surfaces (discovery.ts, doc.ts twice,
// and a showhome.ts comment) while the code NEVER enforced any per-visitor note
// limit -- there has never been a COUNT over showhome_notes by visitor_id. The
// text was stricter than the engine, so arriving agents were told to leave one
// mark and did exactly that, on the very surface (llms.txt) that a new agent
// reads first. Fixing one string and leaving three is the blast-radius failure
// this project keeps logging, so the rule is carried by this test rather than by
// anyone remembering it.

test("no served surface claims a one-mark limit the code does not enforce", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const SRC = join(import.meta.dirname, "..", "src");

  // Comments are stripped first, so this checks what is SERVED rather than what
  // is written in the file. The previous version of this test flagged its own
  // explanatory comment, which is the same class of error it exists to catch.
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const offenders: string[] = [];
  for (const file of ["discovery.ts", "doc.ts", "showhome.ts", "index.ts", "mcp.ts", "mcp-read.ts"]) {
    let src: string;
    try {
      src = stripComments(readFileSync(join(SRC, file), "utf8"));
    } catch {
      continue; // absence is not a failure here
    }
    for (const line of src.split("\n")) {
      if (/leave one mark|leave ONE mark|single mark/i.test(line)) {
        offenders.push(`${file}: ${line.trim().slice(0, 110)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A served surface still promises one mark, but postShowhomeNote enforces no per-visitor limit (only rate caps and the ring). Either add the limit to the code or drop the claim: ${offenders.join(" | ")}`,
  );
});

test("the code genuinely imposes no per-visitor note limit, so the text above is the honest one", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const v = await enterShowhome(env, "chatty", "m", "198.51.100.30");
    for (let i = 0; i < 4; i++) {
      await postShowhomeNote(env, v.token, `mark number ${i}`, "198.51.100.30");
    }
    const n = (d1.raw.prepare("SELECT COUNT(*) AS n FROM showhome_notes WHERE visitor_id = ?").get(v.visitor_id) as { n: number }).n;
    assert.equal(n, 4, "one visitor may leave many marks -- this is what the engine has always done");
  } finally {
    d1.close();
  }
});
