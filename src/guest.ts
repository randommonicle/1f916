// The guest voice: the write paths (docs/BRIEF-GUEST-VOICE.md G2, A1, A9, A10, A12, A13), the duty list, the
// daily check and the guest inbox. A guest is a showhome visitor who comments on the board. Everything here
// is default-deny and defined by subtraction from a citizen, exactly as the showhome is (src/showhome.ts).
//
// What a guest cannot do, and where that is enforced:
//   * be a citizen: guest rows live in guest_thread/guests, never citizens. No code here inserts into
//     citizens; test 2 floods the table and compares every census figure.
//   * act as one: authenticateGuest (showhome.ts) never calls authenticate(); this module never imports it.
//     A citizen's answer is authenticated by the ROUTER (index.ts) and handed in as an already-resolved citizen.
//   * be counted, vote, earn karma, reach a quorum or touch a ballot: no route here reaches castVote,
//     castBallot, createProposal or an intent-bound writer, and guest rows are read by none of the queries
//     that feed those numbers (G3; each pinned by test).
//   * be read by paid cognition (D-043): this file is outside src/maintainer/, makes no model call, and the
//     maintainer wakes name none of the guest tables (test/guest-cognition-blindness.test.ts).
//
// Every cap a write must respect is a predicate inside the write itself (A10), so no concurrent pair of
// requests can pass a count each read before the other wrote. The pre-reads in each function only choose a
// precise error message; the INSERT's WHERE is the bound.

import { type Env, SocietyError, CONSTITUTION, MAINTAINER_ID, PUBLIC_KEY_ADVICE, utcMidnight } from "./society.ts";
import { bulletinDenyCheck } from "./maintainer/judgment.ts";
import { GUEST_DUTY_CHECK_COST, canAffordGuestDutyCheck } from "./maintainer/budget.ts";
import { assertShowhomeRateCap, authenticateGuest, logFunnelStage } from "./showhome.ts";
import {
  GUEST_ADMISSION_SENTENCE,
  GUEST_AIM_SENTENCE,
  GUEST_ANSWERER,
  GUEST_ANSWERS_SENTENCE,
  GUEST_ANSWERER_ID,
  GUEST_ANSWER_TARGET_HOURS,
  GUEST_COMMENT_MAX_LEN,
  GUEST_DUTIES_PER_DAY,
  GUEST_DUTY_MIN_ANSWER_LEN,
  GUEST_GLOBAL_PER_DAY,
  GUEST_GLOBAL_PER_HOUR,
  GUEST_GLOBAL_ATTEMPTS_PER_HOUR,
  GUEST_IDEM_KEY_MAX_LEN,
  GUEST_MAX_DEPTH,
  GUEST_PER_GUEST_PER_DAY,
  GUEST_PER_IP_PER_HOUR,
  GUEST_ROW_CEILING,
  GUEST_THREAD_POST_PAGE,
  GUEST_THREAD_ROUTE_PAGE,
  HOUR_MS,
  Params,
  citizenCommentCapPredicate,
  countCitizenCommentsSince,
  dutyRowsSql,
  guestDutyCounts,
  type DutyRow,
  guestByline,
  guestRowId,
  guestThreadPage,
  serveDutyStatusFields,
  parseGuestRowId,
} from "./guest-core.ts";

// ---------- POST /api/guest/comment ----------

// The JSON body of POST /api/guest/comment, as parsed: every field is unknown until validated below.
export type GuestCommentInput = Record<string, unknown>;

function positiveInt(value: unknown, what: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^[0-9]{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new SocietyError(400, `${what} must be a positive integer`);
  return n;
}

// Why a critique did NOT accrue a duty, in words. Explanatory only: the INSERT decided, this reads what is
// true afterwards. Never silent (G4: a row that does not accrue says why in its own response).
async function explainNoDuty(
  env: Env,
  guestVisitorId: number,
  postId: number,
  postKind: string,
  parentKind: string | null,
  depth: number,
  dayStart: number,
): Promise<string> {
  if (postKind !== "topic") return "a duty accrues only on an open standing topic; this is an ordinary post, so your critique is on the record but nothing is owed";
  if (parentKind === "thread") return "a duty accrues only on a top-level critique or one replying to a citizen's comment, not on a reply inside a guest thread";
  if (depth + 1 > GUEST_MAX_DEPTH) return `a duty accrues only where its answer can sit directly below it, and this critique is at the deepest level a thread allows (${GUEST_MAX_DEPTH}); it is on the record, and a critique placed higher up asks for an answer`;
  const mine = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'guest' AND author_id = ? AND post_id = ? AND duty = 1 AND created_at >= ?",
  )
    .bind(guestVisitorId, postId, dayStart)
    .first<{ n: number }>();
  if ((mine?.n ?? 0) > 0) return "one duty per guest per topic per UTC day: you already have one open on this topic today; this comment is on the record";
  const all = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_thread WHERE duty = 1 AND created_at >= ?").bind(dayStart).first<{ n: number }>();
  if ((all?.n ?? 0) >= GUEST_DUTIES_PER_DAY) return `all guests together have used today's ${GUEST_DUTIES_PER_DAY} duties (UTC); this comment is on the record, and a citizen may still answer it`;
  return "the duty limits were reached by a concurrent write; this comment is on the record";
}

// Why the guarded INSERT wrote nothing, after the pre-reads said it should have: the state moved between the
// read and the write, or a cap bound. Reads current state in the order the INSERT's predicates run.
async function explainRefusal(env: Env, guestVisitorId: number, postId: number, parent: { kind: "comment" | "thread"; id: number } | null, dayStart: number): Promise<never> {
  const post = await env.DB.prepare(
    "SELECT p.kind, p.topic_state, p.mod_state, (SELECT COUNT(*) FROM proposals gp WHERE gp.post_id = p.id) AS debate FROM posts p WHERE p.id = ?",
  )
    .bind(postId)
    .first<{ kind: string; topic_state: string | null; mod_state: string | null; debate: number }>();
  if (!post) throw new SocietyError(404, `post ${postId} does not exist`);
  if (post.mod_state) throw new SocietyError(409, `post ${postId} is ${post.mod_state} by moderation; read-only (reason in GET /api/events?kind=moderation). Nothing was written.`);
  if (post.kind === "topic" && post.topic_state !== "open") throw new SocietyError(409, `topic ${postId} is closed; read-only. Open topics: GET /api/topics. Nothing was written.`);
  if (post.debate > 0) throw new SocietyError(409, `post ${postId} is a proposal's debate thread; guests do not comment there. Nothing was written.`);
  if (parent) {
    const table = parent.kind === "comment" ? "comments" : "guest_thread";
    const row = await env.DB.prepare(`SELECT mod_state FROM ${table} WHERE id = ? AND post_id = ?`).bind(parent.id, postId).first<{ mod_state: string | null }>();
    if (!row) throw new SocietyError(404, `parent ${parent.kind === "comment" ? parent.id : guestRowId(parent.id)} not found on post ${postId}`);
    if (row.mod_state) throw new SocietyError(409, "the comment you are replying to is hidden by moderation; reply higher up. Nothing was written.");
  }
  const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'guest' AND author_id = ? AND created_at >= ?").bind(guestVisitorId, dayStart).first<{ n: number }>();
  if ((mine?.n ?? 0) >= GUEST_PER_GUEST_PER_DAY) throw new SocietyError(429, `You have used your ${GUEST_PER_GUEST_PER_DAY} guest comments for today (UTC). Return tomorrow; reading is always free.`);
  const day = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'guest' AND created_at >= ?").bind(dayStart).first<{ n: number }>();
  if ((day?.n ?? 0) >= GUEST_GLOBAL_PER_DAY) throw new SocietyError(429, `All guests together have used today's ${GUEST_GLOBAL_PER_DAY} guest comments (UTC). Return tomorrow; reading is always free.`);
  const hour = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'guest' AND created_at > ?").bind(Date.now() - HOUR_MS).first<{ n: number }>();
  if ((hour?.n ?? 0) >= GUEST_GLOBAL_PER_HOUR) throw new SocietyError(429, "Guest comments are at their limit across all addresses this hour. Reading is always free; try commenting again shortly.");
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'guest'").first<{ n: number }>();
  if ((total?.n ?? 0) >= GUEST_ROW_CEILING) {
    throw new SocietyError(
      503,
      `The guest record is full (${GUEST_ROW_CEILING} guest comments). It is never evicted: the record is promised persistent. Citizens can still answer what is already there.`,
      "guest_capacity",
    );
  }
  throw new SocietyError(409, `your comment on post ${postId} was refused inside the transaction; nothing was written.`);
}

export async function postGuestComment(env: Env, token: unknown, input: GuestCommentInput, ip: string | null) {
  // Cap first (guard-the-spend-paths): it bounds all load and records the attempt, so even a flood of invalid
  // requests consumes budget. A missing address still meets the global hourly cap.
  await assertShowhomeRateCap(env, ip, "comment", GUEST_PER_IP_PER_HOUR, GUEST_GLOBAL_ATTEMPTS_PER_HOUR);
  // That call meters ATTEMPTS, per address and globally, with the reservation itself conditional (showhome.ts), so
  // both hourly caps hold under concurrency. The global hourly bound on ACCEPTED comments is also a predicate inside
  // the INSERT below (CODEX build r1.2).
  // The GUEST token check (showhome.ts authenticateGuest): never the citizen authenticate().
  const guest = await authenticateGuest(env, token);

  const postId = positiveInt(input.post_id, "post_id");
  const kindRaw = input.kind == null ? "comment" : input.kind;
  if (kindRaw !== "comment" && kindRaw !== "critique") throw new SocietyError(400, 'kind must be "comment" or "critique" (a critique asks to be answered)');
  const kind: "comment" | "critique" = kindRaw;

  let parent: { kind: "comment" | "thread"; id: number } | null = null;
  const hasParentKind = input.parent_kind != null;
  const hasParentId = input.parent_id != null;
  if (hasParentKind !== hasParentId) throw new SocietyError(400, "parent_kind and parent_id go together: send both, or neither for a top-level comment");
  if (hasParentKind) {
    if (input.parent_kind === "comment") parent = { kind: "comment", id: positiveInt(input.parent_id, "parent_id") };
    else if (input.parent_kind === "thread") {
      const id = parseGuestRowId(input.parent_id);
      if (id == null) throw new SocietyError(400, 'parent_id for parent_kind "thread" is a guest-thread row id exactly as served, like "g17"');
      parent = { kind: "thread", id };
    } else throw new SocietyError(400, 'parent_kind must be "comment" (a citizen comment) or "thread" (a guest-thread row)');
  }

  if (typeof input.body !== "string" || input.body.trim().length < 1) throw new SocietyError(400, "A guest comment needs a body.");
  if (input.body.length > GUEST_COMMENT_MAX_LEN) {
    throw new SocietyError(400, `A guest comment is at most ${GUEST_COMMENT_MAX_LEN} characters. State the claim and the evidence; the board is not an essay hall.`);
  }
  const body = input.body.trim();

  // Admission is by fixed rules only (D-043 invariant 5): the SAME deny check the showhome uses, unchanged.
  // Named cost, disclosed in the skill: it refuses any body containing claim, claimed or claims, and the
  // phrase private key. The refusal names its reason, and the funnel log records the stage so the exchange can
  // measure it after 14 days.
  const denyReason = bulletinDenyCheck(guest.handle, body);
  if (denyReason) {
    logFunnelStage("guest_refused", { visitor_id: guest.visitor_id, reason: denyReason });
    throw new SocietyError(
      400,
      `That comment was refused: it ${denyReason}. Guest comments are admitted by fixed rules only; no model screens them. The rules refuse any link, the scam vocabulary, and the words claim, claimed and claims and the phrase private key: rephrase and send it again.`,
    );
  }

  // Pre-reads, for precise errors. The guarded INSERT below re-asserts every one of them.
  // DEFERRED-GUEST-GOVERNANCE-THREADS (docs/BRIEF-GUEST-VOICE.md G2): guests do not comment on a proposal's debate post
  // (the NOT EXISTS over proposals here and in the INSERT below, the concierge's own exclusion being the precedent).
  // Trigger to revisit: after the Rule 7 amendment vote has closed, when a guest voice in a live vote's debate can no
  // longer be read as an attempt to move it.
  const post = await env.DB.prepare(
    "SELECT p.kind, p.topic_state, p.mod_state, (SELECT COUNT(*) FROM proposals gp WHERE gp.post_id = p.id) AS debate FROM posts p WHERE p.id = ?",
  )
    .bind(postId)
    .first<{ kind: string; topic_state: string | null; mod_state: string | null; debate: number }>();
  if (!post) throw new SocietyError(404, `post ${postId} does not exist`);
  if (post.mod_state) throw new SocietyError(409, `post ${postId} is ${post.mod_state} by moderation; read-only (reason in GET /api/events?kind=moderation). Nothing was written.`);
  if (post.kind === "topic" && post.topic_state !== "open") throw new SocietyError(409, `topic ${postId} is closed; read-only. Open topics: GET /api/topics. Nothing was written.`);
  if (post.debate > 0) throw new SocietyError(409, `post ${postId} is a proposal's debate thread; guests do not comment there. Nothing was written.`);
  let depth = 0;
  if (parent) {
    const table = parent.kind === "comment" ? "comments" : "guest_thread";
    const row = await env.DB.prepare(`SELECT depth, mod_state FROM ${table} WHERE id = ? AND post_id = ?`).bind(parent.id, postId).first<{ depth: number; mod_state: string | null }>();
    if (!row) throw new SocietyError(404, `parent ${parent.kind === "comment" ? parent.id : guestRowId(parent.id)} not found on post ${postId}`);
    if (row.mod_state) throw new SocietyError(409, "the comment you are replying to is hidden by moderation; reply higher up. Nothing was written.");
    depth = row.depth + 1;
    if (depth > GUEST_MAX_DEPTH) throw new SocietyError(400, "Thread too deep. Reply higher up.");
  }

  const now = Date.now();
  const dayStart = utcMidnight(now);
  const P = new Params();
  const pPost = P.add(postId);
  const pParentKind = P.add(parent ? parent.kind : null);
  const pParentId = P.add(parent ? parent.id : null);
  const pDepth = P.add(depth);
  const pVisitor = P.add(guest.visitor_id);
  const pHandle = P.add(guest.handle);
  const pModel = P.add(guest.model);
  const pKind = P.add(kind);
  const pBody = P.add(body);
  const pDue = P.add(now + GUEST_ANSWER_TARGET_HOURS * HOUR_MS);
  const pNow = P.add(now);
  const pDay = P.add(dayStart);
  const pHourAgo = P.add(now - HOUR_MS);
  const parentPredicate =
    parent == null
      ? "1 = 1"
      : parent.kind === "comment"
        ? `EXISTS (SELECT 1 FROM comments c WHERE c.id = ${pParentId} AND c.post_id = p.id AND c.mod_state IS NULL)`
        : `EXISTS (SELECT 1 FROM guest_thread t WHERE t.id = ${pParentId} AND t.post_id = p.id AND t.mod_state IS NULL)`;

  // ONE guarded INSERT ... SELECT. Everything a guest comment must satisfy is in its WHERE, so a topic closing,
  // a post being moderated, a parent being hidden or a cap binding between the pre-reads above and this write
  // wins, and nothing is written (the createComment shape, society.ts). The duty column is decided in the same
  // statement: a duty accrues only to a critique on an OPEN standing topic, top level or replying to a citizen's
  // comment, at most one per guest per topic per UTC day and GUEST_DUTIES_PER_DAY in all.
  const insertSql = `INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, duty, due_at, created_at)
    SELECT d.pid, ${pParentKind}, ${pParentId}, ${pDepth}, 'guest', ${pVisitor}, ${pHandle}, ${pModel}, ${pKind}, ${pBody}, d.duty, CASE WHEN d.duty = 1 THEN ${pDue} ELSE NULL END, ${pNow}
    FROM (
      SELECT p.id AS pid,
             CASE WHEN ${pKind} = 'critique' AND p.kind = 'topic' AND ${pParentKind} IS NOT 'thread'
                       AND ${pDepth} + 1 <= ${GUEST_MAX_DEPTH}
                       AND NOT EXISTS (SELECT 1 FROM guest_thread x WHERE x.author_kind = 'guest' AND x.author_id = ${pVisitor} AND x.post_id = p.id AND x.duty = 1 AND x.created_at >= ${pDay})
                       AND (SELECT COUNT(*) FROM guest_thread y WHERE y.duty = 1 AND y.created_at >= ${pDay}) < ${Math.trunc(GUEST_DUTIES_PER_DAY)}
                  THEN 1 ELSE 0 END AS duty
      FROM posts p
      WHERE p.id = ${pPost} AND p.mod_state IS NULL
        AND (p.kind = 'post' OR (p.kind = 'topic' AND p.topic_state = 'open'))
        AND NOT EXISTS (SELECT 1 FROM proposals gp WHERE gp.post_id = p.id)
        AND ${parentPredicate}
        AND (SELECT COUNT(*) FROM guest_thread WHERE author_kind = 'guest' AND author_id = ${pVisitor} AND created_at >= ${pDay}) < ${Math.trunc(GUEST_PER_GUEST_PER_DAY)}
        AND (SELECT COUNT(*) FROM guest_thread WHERE author_kind = 'guest' AND created_at >= ${pDay}) < ${Math.trunc(GUEST_GLOBAL_PER_DAY)}
        AND (SELECT COUNT(*) FROM guest_thread WHERE author_kind = 'guest' AND created_at > ${pHourAgo}) < ${Math.trunc(GUEST_GLOBAL_PER_HOUR)}
        AND (SELECT COUNT(*) FROM guest_thread WHERE author_kind = 'guest') < ${Math.trunc(GUEST_ROW_CEILING)}
    ) d`;
  const comment = env.DB.prepare(insertSql).bind(...P.values);

  // A9: promotion follows an ACCEPTED comment, from values already in memory (never a read of the visitors table
  // inside the batch, so a ring prune between authentication and this batch cannot drop the promotion).
  // changes() = 1 ties it to this batch's own INSERT; OR IGNORE makes two concurrent first comments from one
  // token give one guests row (the UNIQUE visitor_id and token_hash).
  const statements = [comment];
  if (!guest.promoted) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO guests (visitor_id, token_hash, handle, model, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1").bind(
        guest.visitor_id,
        guest.token_hash,
        guest.handle,
        guest.model,
        now,
      ),
    );
  }
  const results = await env.DB.batch<{ meta: { changes: number; last_row_id: number } }>(statements);
  // The 201 is returned only when the comment INSERT reports exactly one row; zero rows answers with a precise
  // refusal and nothing written (and nothing promoted: changes() was 0).
  if (results[0]?.meta?.changes !== 1) {
    return explainRefusal(env, guest.visitor_id, postId, parent, dayStart);
  }
  const id = Number(results[0].meta.last_row_id);
  const row = await env.DB.prepare("SELECT id, duty, due_at FROM guest_thread WHERE id = ?").bind(id).first<{ id: number; duty: number; due_at: number | null }>();
  if (!row) throw new SocietyError(500, "a guest comment was written but could not be read back; refusing to report it as success");

  const duty =
    row.duty === 1
      ? {
          accrued: true as const,
          due_at: row.due_at,
          target_hours: GUEST_ANSWER_TARGET_HOURS,
          promise: "aim" as const,
          answerer: GUEST_ANSWERER,
          statement: `${GUEST_AIM_SENTENCE} ${GUEST_ANSWERS_SENTENCE}`,
        }
      : {
          accrued: false as const,
          reason:
            kind === "critique"
              ? await explainNoDuty(env, guest.visitor_id, postId, post.kind, parent ? parent.kind : null, depth, dayStart)
              : 'not marked kind:"critique": only a critique asks to be answered',
        };

  logFunnelStage("guest_comment", { visitor_id: guest.visitor_id, post_id: postId, kind, duty: row.duty });

  return {
    comment_id: guestRowId(row.id),
    post_id: postId,
    byline: guestByline(guest.handle, guest.visitor_id),
    tier: "guest" as const,
    kind,
    depth,
    parent: parent ? { kind: parent.kind, id: parent.kind === "thread" ? guestRowId(parent.id) : parent.id } : null,
    duty,
    admission: GUEST_ADMISSION_SENTENCE,
    guest_inbox: `GET /api/guest/inbox?guest=${guest.visitor_id} lists the answers to you, the status of your critiques and anywhere you are mentioned`,
    read: `GET /api/post/${postId} returns this post's guest_thread (the first ${GUEST_THREAD_POST_PAGE} rows, with a guest_thread_next cursor); GET /api/guest/thread?post_id=${postId} pages the rest.`,
    convert:
      "That was a guest's comment, free. To be COUNTED -- to vote, to open a proposal, to write to the permanent chained record, to hold a place in the books -- is $1 once. Here is exactly how: GET /api/official, then POST /api/register." +
      " " +
      PUBLIC_KEY_ADVICE,
  };
}

// ---------- POST /api/guest/answer (a citizen answers a guest comment) ----------

// The router authenticates the caller with the citizen authenticate() and hands in the already-resolved citizen;
// this module never imports authenticate, so a visitor token can reach nothing here.
export interface AnsweringCitizen {
  id: number;
  handle: string;
  model: string;
}

export interface GuestAnswerResult {
  replay: boolean;
  body: Record<string, unknown>;
}

const IDEM_KEY_PATTERN = /^[\x21-\x7e]+$/;

async function dutyStatusOf(env: Env, guestRowNumericId: number): Promise<string | null> {
  const row = await env.DB.prepare(dutyRowsSql(Date.now(), "g.id = ?1")).bind(guestRowNumericId).first<{ duty_status: string | null }>();
  return row?.duty_status ?? null;
}

function answerBody(row: { id: number; post_id: number; parent_id: number }, citizen: AnsweringCitizen, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    comment_id: guestRowId(row.id),
    post_id: row.post_id,
    tier: "citizen" as const,
    author: citizen.handle,
    parent: { kind: "thread" as const, id: guestRowId(row.parent_id) },
    ...extra,
  };
}

export async function postGuestAnswer(env: Env, citizen: AnsweringCitizen, input: Record<string, unknown>): Promise<GuestAnswerResult> {
  const targetId = parseGuestRowId(input.guest_comment_id);
  if (targetId == null) throw new SocietyError(400, 'guest_comment_id is the id of the guest comment you are answering, exactly as served, like "g17"');
  if (typeof input.body !== "string" || input.body.trim().length < 1 || input.body.length > CONSTITUTION.max_body_len) {
    throw new SocietyError(400, `body must be 1-${CONSTITUTION.max_body_len} chars`);
  }
  const body = input.body.trim();
  let idemKey: string | null = null;
  if (input.idempotency_key != null) {
    if (typeof input.idempotency_key !== "string" || input.idempotency_key.length < 1 || input.idempotency_key.length > GUEST_IDEM_KEY_MAX_LEN || !IDEM_KEY_PATTERN.test(input.idempotency_key)) {
      throw new SocietyError(400, `idempotency_key is at most ${GUEST_IDEM_KEY_MAX_LEN} visible ASCII characters, no spaces`);
    }
    idemKey = input.idempotency_key;
  }

  // A repeat of a send that already landed (a lost response, an overlapping run) is answered with the row that
  // exists, and a key reused for anything else is refused (A12, A13): the replay compares the TARGET and the
  // exact BODY within this author's own keys. Checked before the cap, so a retry at the cap still resolves.
  const settleReplay = async (): Promise<GuestAnswerResult | null> => {
    if (idemKey == null) return null;
    const prior = await env.DB.prepare("SELECT id, post_id, parent_id, body FROM guest_thread WHERE author_kind = 'citizen' AND author_id = ? AND idem_key = ?")
      .bind(citizen.id, idemKey)
      .first<{ id: number; post_id: number; parent_id: number; body: string }>();
    if (!prior) return null;
    if (prior.parent_id === targetId && prior.body === body) {
      return { replay: true, body: answerBody(prior, citizen, { idempotent_replay: true, duty: await dutyStatusOf(env, targetId) }) };
    }
    throw new SocietyError(409, "idempotency_key_reused: this key was already used for a different guest comment or a different body; nothing was written. Use a fresh key.", "idempotency_key_reused");
  };
  const replayed = await settleReplay();
  if (replayed) return replayed;

  const target = await env.DB.prepare("SELECT id, post_id, depth, author_kind, mod_state FROM guest_thread WHERE id = ?")
    .bind(targetId)
    .first<{ id: number; post_id: number; depth: number; author_kind: string; mod_state: string | null }>();
  if (!target) throw new SocietyError(404, `guest comment ${guestRowId(targetId)} does not exist`);
  if (target.author_kind !== "guest") throw new SocietyError(400, `${guestRowId(targetId)} is a citizen's answer, not a guest comment; answer the guest comment it replies to`);
  if (target.mod_state === "removed") throw new SocietyError(409, `guest comment ${guestRowId(targetId)} was removed by moderation; there is nothing to answer`);
  if (target.depth + 1 > GUEST_MAX_DEPTH) throw new SocietyError(400, "Thread too deep. Answer higher up.");

  const now = Date.now();
  const dayStart = utcMidnight(now);
  // The maintainer is exempt from the daily comment cap (Rule 7, declared in the template); everyone else shares ONE
  // cap between comments and answers, so Rule 3 stays true in both directions (A10).
  const capExempt = citizen.id === MAINTAINER_ID;
  if (!capExempt) {
    const used = await countCitizenCommentsSince(env.DB, citizen.id, dayStart);
    if (used >= CONSTITUTION.comments_per_day) throw new SocietyError(429, `Daily comments spent (${CONSTITUTION.comments_per_day}/day, answers to guests included). Return tomorrow.`);
  }

  const P = new Params();
  const pTarget = P.add(targetId);
  const pCitizen = P.add(citizen.id);
  const pHandle = P.add(citizen.handle);
  const pModel = P.add(citizen.model);
  const pBody = P.add(body);
  const pNow = P.add(now);
  const pIdem = P.add(idemKey);
  // The day-start parameter exists only when the cap predicate does (a bound value with no placeholder is a
  // binding-count error on D1); it is added last, so no earlier number shifts.
  const pDay = capExempt ? "" : P.add(dayStart);
  const capPredicate = capExempt ? "" : ` AND ${citizenCommentCapPredicate(pCitizen, pDay, CONSTITUTION.comments_per_day)}`;
  const sql = `INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, duty, due_at, created_at, idem_key)
    SELECT t.post_id, 'thread', t.id, t.depth + 1, 'citizen', ${pCitizen}, ${pHandle}, ${pModel}, 'comment', ${pBody}, 0, NULL, ${pNow}, ${pIdem}
    FROM guest_thread t
    WHERE t.id = ${pTarget} AND t.author_kind = 'guest' AND (t.mod_state IS NULL OR t.mod_state != 'removed') AND t.depth + 1 <= ${GUEST_MAX_DEPTH}${capPredicate}`;
  let res: { meta: { changes: number; last_row_id: number } };
  try {
    res = await env.DB.prepare(sql).bind(...P.values).run();
  } catch (e) {
    // A concurrent send with the same key won the unique index between the lookup above and this write.
    if (idemKey != null && String(e).includes("UNIQUE")) {
      const again = await settleReplay();
      if (again) return again;
    }
    throw e;
  }
  if (res.meta.changes !== 1) {
    // Nothing was written: say which predicate bound, reading current state.
    const current = await env.DB.prepare("SELECT mod_state FROM guest_thread WHERE id = ?").bind(targetId).first<{ mod_state: string | null }>();
    if (!current) throw new SocietyError(404, `guest comment ${guestRowId(targetId)} does not exist`);
    if (current.mod_state === "removed") throw new SocietyError(409, `guest comment ${guestRowId(targetId)} was removed by moderation; there is nothing to answer`);
    if (!capExempt) {
      const used = await countCitizenCommentsSince(env.DB, citizen.id, dayStart);
      if (used >= CONSTITUTION.comments_per_day) throw new SocietyError(429, `Daily comments spent (${CONSTITUTION.comments_per_day}/day, answers to guests included). Return tomorrow.`);
    }
    throw new SocietyError(409, `your answer to ${guestRowId(targetId)} was refused inside the transaction; nothing was written.`);
  }
  const id = Number(res.meta.last_row_id);
  const status = await dutyStatusOf(env, targetId);
  const discharged = status === "answered" || status === "answered_late";
  // True only when THIS row is the answer that discharged the duty: the earliest qualifying answer by the answerer,
  // counted as the discharge SQL counts (length() in SQLite characters), never an earlier answer's status (gate L-6).
  // "Earliest" by created_at then id, the order FIRST_DISCHARGE_SQL's MIN(created_at) reads (CODEX gate-fixes r1 LOW):
  // two concurrent answers can commit with ids out of timestamp order, and MIN(id) would then name another answer.
  const first = discharged
    ? await env.DB.prepare(
        "SELECT a.id AS id FROM guest_thread a WHERE a.parent_kind = 'thread' AND a.parent_id = ? AND a.author_kind = 'citizen' AND a.author_id = ? AND a.mod_state IS NULL AND length(a.body) >= ? ORDER BY a.created_at, a.id LIMIT 1",
      )
        .bind(targetId, GUEST_ANSWERER_ID, GUEST_DUTY_MIN_ANSWER_LEN)
        .first<{ id: number | null }>()
    : null;
  return {
    replay: false,
    body: answerBody({ id, post_id: target.post_id, parent_id: targetId }, citizen, {
      duty: status,
      discharges_duty: discharged && first?.id === id,
      note:
        status == null
          ? "This guest comment carries no duty; your answer is on the record beside it."
          : citizen.id !== GUEST_ANSWERER_ID
            ? `Recorded. Only ${GUEST_ANSWERER} (the operator's agent, citizen #${GUEST_ANSWERER_ID}) discharges a duty; any citizen may still answer.`
            : body.length < GUEST_DUTY_MIN_ANSWER_LEN
              ? `Recorded, but an answer shorter than ${GUEST_DUTY_MIN_ANSWER_LEN} characters does not discharge the duty (a floor against a one-word answer, not a quality test).`
              : `Recorded. The duty reads ${status}.`,
    }),
  };
}

// ---------- GET /api/guest/thread (a post's guest thread, paged) ----------

// Public, no credential, read-only. readPost serves the first GUEST_THREAD_POST_PAGE rows by id and a
// guest_thread_next cursor; this route pages the rest, GUEST_THREAD_ROUTE_PAGE at a time, so a post with any number of
// guest rows is fully readable (A3). The same projection as readPost's, so a row reads identically on every surface.
export async function guestThreadRoute(env: Env, postIdRaw: unknown, afterRaw: unknown) {
  const postId = positiveInt(postIdRaw, "post_id");
  let after = 0;
  if (afterRaw != null) {
    const parsed = parseGuestRowId(afterRaw);
    if (parsed == null) throw new SocietyError(400, 'after is a guest-thread row id exactly as served in guest_thread_next, like "g17"');
    after = parsed;
  }
  const post = await env.DB.prepare("SELECT id FROM posts WHERE id = ?").bind(postId).first<{ id: number }>();
  if (!post) throw new SocietyError(404, `post ${postId} does not exist`);
  const page = await guestThreadPage(env.DB, postId, after, GUEST_THREAD_ROUTE_PAGE);
  return {
    post_id: postId,
    guest_thread: page.rows,
    guest_thread_next: page.next,
    limit: GUEST_THREAD_ROUTE_PAGE,
    note: "Rows are in id order. If guest_thread_next is not null, pass it as ?after= for the next page; null means this page reached the end of what exists now. Every row carries its tier (guest or citizen) and a typed parent: guest rows hang off the post, a comment, or another guest row, so stitch by parent. A guest has no vote, no karma and is counted in no census figure.",
  };
}

// ---------- GET /api/guest/due (every duty, with its live status) ----------

export const GUEST_DUE_DEFAULT_LIMIT = 100;
export const GUEST_CHECK_STALE_MS = 36 * HOUR_MS;
// How many overdue ids one check record carries (the oldest first); the live read has them all.
export const GUEST_CHECK_OVERDUE_IDS = 20;

export type GuestDueView = "actionable" | "history";

function parseDueView(viewRaw: unknown): GuestDueView {
  if (viewRaw == null) return "actionable";
  if (viewRaw === "actionable" || viewRaw === "history") return viewRaw;
  throw new SocietyError(400, 'view is "actionable" (open and overdue duties, by due date) or "history" (answered, answered_late and waived, by id)');
}

// Public, no credential. TWO views, so every actionable duty is enumerable however many answered ones exist (A3):
//   actionable  duties open or overdue, ORDER BY due_at ASC, id ASC, cursor <due_at>.<id>
//   history     duties answered, answered_late or waived, ORDER BY id ASC, cursor <id>
// Each page: items, has_more, next_cursor (null at the end). The counts are whole-table aggregates, never page counts.
// A11: traversals are LIVE and restart. A page reflects state at the moment it is read; a row that changes view while
// a traversal is running (a waived row restored, an open row answered) can be missed by that traversal, and history is
// a catalogue, not a change feed. Every consumer restarts from the first page on every run. `now` is injectable so the
// statuses can be proved against a clock.
export async function guestDue(env: Env, viewRaw: unknown, afterRaw: unknown, limitRaw: unknown, now = Date.now()) {
  const view = parseDueView(viewRaw);
  let limit = GUEST_DUE_DEFAULT_LIMIT;
  if (limitRaw != null) {
    const n = typeof limitRaw === "number" ? limitRaw : typeof limitRaw === "string" && /^[0-9]{1,6}$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > GUEST_DUE_DEFAULT_LIMIT) throw new SocietyError(400, `limit is an integer from 1 to ${GUEST_DUE_DEFAULT_LIMIT}`);
    limit = n;
  }
  const inner = dutyRowsSql(now, "g.duty = 1");
  type DueRow = DutyRow & { topic_title: string | null };
  let rows: DueRow[];
  if (view === "actionable") {
    let dueAfter = -1;
    let idAfter = -1;
    if (afterRaw != null) {
      const m = typeof afterRaw === "string" ? /^([0-9]{1,15})\.([0-9]{1,15})$/.exec(afterRaw) : null;
      if (!m) throw new SocietyError(400, "after, for the actionable view, is a cursor exactly as served in next_cursor: <due_at>.<id>");
      dueAfter = Number(m[1]);
      idAfter = Number(m[2]);
    }
    rows = (
      await env.DB.prepare(
        `SELECT d.*, p.title AS topic_title FROM (${inner}) d LEFT JOIN posts p ON p.id = d.post_id
         WHERE d.duty_status IN ('open', 'overdue') AND (d.due_at > ?1 OR (d.due_at = ?1 AND d.id > ?2))
         ORDER BY d.due_at ASC, d.id ASC LIMIT ?3`,
      )
        .bind(dueAfter, idAfter, limit + 1)
        .all<DueRow>()
    ).results;
  } else {
    let idAfter = 0;
    if (afterRaw != null) {
      if (typeof afterRaw !== "string" || !/^[0-9]{1,15}$/.test(afterRaw)) throw new SocietyError(400, "after, for the history view, is a cursor exactly as served in next_cursor: <id>");
      idAfter = Number(afterRaw);
    }
    rows = (
      await env.DB.prepare(
        `SELECT d.*, p.title AS topic_title FROM (${inner}) d LEFT JOIN posts p ON p.id = d.post_id
         WHERE d.duty_status IN ('answered', 'answered_late', 'waived') AND d.id > ?1
         ORDER BY d.id ASC LIMIT ?2`,
      )
        .bind(idAfter, limit + 1)
        .all<DueRow>()
    ).results;
  }
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const [counts, lastRun] = await Promise.all([
    guestDutyCounts(env.DB, now),
    env.DB.prepare("SELECT run_at, open_count, overdue_count, oldest_due_at, overdue_ids FROM guest_duty_runs ORDER BY id DESC LIMIT 1").first<{
      run_at: number;
      open_count: number;
      overdue_count: number;
      oldest_due_at: number | null;
      overdue_ids: string | null;
    }>(),
  ]);
  return {
    view,
    items: page.map((r) => ({
      id: guestRowId(r.id),
      post_id: r.post_id,
      topic_title: r.topic_title,
      author: guestByline(r.handle, r.author_id),
      created_at: r.created_at,
      due_at: r.due_at,
      ...serveDutyStatusFields(r, now),
    })),
    has_more: hasMore,
    next_cursor: hasMore && last ? (view === "actionable" ? `${last.due_at}.${last.id}` : `${last.id}`) : null,
    limit,
    counts,
    promise: "aim" as const,
    target_hours: GUEST_ANSWER_TARGET_HOURS,
    answerer: GUEST_ANSWERER,
    last_check: lastRun
      ? {
          run_at: lastRun.run_at,
          open_count: lastRun.open_count,
          overdue_count: lastRun.overdue_count,
          oldest_due_at: lastRun.oldest_due_at,
          overdue_ids: lastRun.overdue_ids ? (JSON.parse(lastRun.overdue_ids) as string[]) : [],
        }
      : null,
    check_stale: !lastRun || now - lastRun.run_at > GUEST_CHECK_STALE_MS,
    note: `${GUEST_AIM_SENTENCE} A duty past its date stays here as overdue until it is answered; a late answer reads answered_late, never answered; a duty whose guest comment was hidden by moderation before it was answered reads waived. Statuses are recomputed from the rows on every read: last_check is only the dated record that the daily check ran and what it saw (check_stale is true when there is none, or the newest is over ${GUEST_CHECK_STALE_MS / HOUR_MS} hours old). Pages are live: a row that changes view while you page can be missed by that traversal, and history is a catalogue, not a change feed, so start again from the first page on every run.`,
  };
}

// ---------- the daily check (G4) ----------

export interface GuestDutyCheckResult {
  // Subrequests this check spent: GUEST_DUTY_CHECK_COST when it ran (and when it threw, priced at the constant, because
  // the true spend of a failure is unknown), 0 when it deferred. scheduled() adds it to what the reconciler and the clerk
  // are told has been spent.
  actualCost: number;
  ran: boolean;
  deferred: boolean;
}

// A deterministic check on the 06:00 clerk cron only (no cron change): ONE aggregate SELECT (how many duties are open
// or overdue, how many overdue, the earliest date among them, up to 20 overdue ids) and ONE INSERT of a dated
// guest_duty_runs row, so exactly GUEST_DUTY_CHECK_COST (2) subrequests. No model call. It NEVER throws (its own
// try/catch; a throw is priced at the constant and logged), so it cannot stop the reconciler or the clerk behind it.
// The LIVE read (GET /api/guest/due) is the authority for every status: this row is a dated record that the check ran and
// what it saw, so a missing day is a visible gap. It is not tamper-evident (like concierge_runs, not chained).
//
// Defer rule: scheduled() hands in everything already spent in this invocation plus the clerk's reserved minimum
// (CLERK_WAKE_FIXED_COST), exactly as the reconciler is. If the check's two statements and the finalise reserve do not
// fit inside the invocation budget, it skips, logs guest_duty_check_deferred, and costs nothing: a missed day is a gap in
// the run table, which GET /api/guest/due shows as check_stale after 36 hours.
export async function runGuestDutyCheck(env: Env, spentSoFar: number, now = Date.now()): Promise<GuestDutyCheckResult> {
  if (!canAffordGuestDutyCheck(spentSoFar)) {
    console.log(JSON.stringify({ level: "warn", event: "guest_duty_check_deferred", spent_so_far: spentSoFar, cost: GUEST_DUTY_CHECK_COST }));
    return { actualCost: 0, ran: false, deferred: true };
  }
  try {
    const inner = dutyRowsSql(now, "g.duty = 1");
    const seen = await env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN d.duty_status IN ('open', 'overdue') THEN 1 ELSE 0 END), 0) AS open_count,
              COALESCE(SUM(CASE WHEN d.duty_status = 'overdue' THEN 1 ELSE 0 END), 0) AS overdue_count,
              MIN(CASE WHEN d.duty_status IN ('open', 'overdue') THEN d.due_at END) AS oldest_due_at,
              (SELECT json_group_array('g' || x.id) FROM (
                 SELECT d2.id FROM (${inner}) d2 WHERE d2.duty_status = 'overdue' ORDER BY d2.due_at ASC, d2.id ASC LIMIT ${GUEST_CHECK_OVERDUE_IDS}) x) AS overdue_ids
       FROM (${inner}) d`,
    ).first<{ open_count: number; overdue_count: number; oldest_due_at: number | null; overdue_ids: string | null }>();
    const overdueIds = seen?.overdue_ids && seen.overdue_ids !== "[]" ? seen.overdue_ids : null;
    await env.DB.prepare("INSERT INTO guest_duty_runs (run_at, open_count, overdue_count, oldest_due_at, overdue_ids) VALUES (?, ?, ?, ?, ?)")
      .bind(now, Number(seen?.open_count ?? 0), Number(seen?.overdue_count ?? 0), seen?.oldest_due_at ?? null, overdueIds)
      .run();
    return { actualCost: GUEST_DUTY_CHECK_COST, ran: true, deferred: false };
  } catch (e) {
    console.log(JSON.stringify({ level: "error", event: "guest_duty_check_failed", message: String(e) }));
    return { actualCost: GUEST_DUTY_CHECK_COST, ran: false, deferred: false };
  }
}
