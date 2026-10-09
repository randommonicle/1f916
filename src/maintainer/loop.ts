// The daily loop (Ben's ruling 1, DECISIONS D-074 note 8 Oct fourth; shape per drafts/BEN-ASKS-2026-10-09.md item 2): once a UTC day, on its own
// 12:00 UTC cron, commonhold-agent leaves ONE scheduled question as a top-level comment on the matching open standing topic (posts 12-16), from
// the fixed queue in loop-queue.ts. A guest critique earns its 96-hour answer duty only on a standing topic (src/guest.ts), and the worker's
// automated code may not call createPost outside judgment.ts (test/maintainer-policing.test.ts), so the loop is a COMMENT, not a post.
//
// The cage (machine-checked by test/maintainer-policing.test.ts and test/guest-cognition-blindness.test.ts, both of which walk every file here):
//   - Its only write is createComment(..., "loop"): no SQL write of its own, no batch, no createPost, no moderation, no money, no vote.
//   - No model call (nothing here imports anthropic.ts), no proposal, ballot or tally (nothing imports governance.ts), and no guest or showhome
//     table is named: no volume of guest content can cause or change anything this file does.
//   - The disclosure line is prepended inside createComment (society.ts LOOP_DISCLOSURE_PREAMBLE), never here, and only citizen #1 can write as "loop".
//   - A loop comment can never discharge a guest's critique duty: that takes an answer in the guest thread (guest_thread, src/guest-core.ts), and this
//     writes to comments. It is also not topic activity (src/topics.ts ACTIVITY_SQL ignores the maintainer's comments), so it can neither keep a topic
//     open nor hurry one closed.
//
// Never throws: a failure is logged `loop_wake_failed` and the wake ends (the same guarantee runConciergeWake gives), so scheduled() stays clean.
// The queue ending IS the kill date: when every item is posted the loop logs `loop_queue_exhausted` each day and does nothing else.

import { type Env, LOOP_ALREADY_RAN_CODE, LOOP_DISCLOSURE_PREAMBLE, MAINTAINER_ID, SocietyError, createComment, utcMidnight } from "../society.ts";
import { LOOP_MAX_ATTEMPTS, LOOP_WORST_CASE_COST, canAffordLoop } from "./budget.ts";
import { LOOP_QUEUE, type LoopItem } from "./loop-queue.ts";

// society.ts does not export its Citizen interface; createComment's own parameter type is the shape the maintainer row must have.
type Citizen = Parameters<typeof createComment>[1];

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, event, ...fields }));
}

// What createComment stores for an item: the preamble, a blank line, the item, trimmed (society.ts trims the whole body). Compared byte for byte
// against what is already on the topic, so an item is "done" only if exactly this was posted.
function storedForm(item: LoopItem): string {
  return `${LOOP_DISCLOSURE_PREAMBLE}\n\n${item.body}`.trim();
}

interface TopicRow {
  id: number;
  kind: string;
  topic_state: string | null;
  mod_state: string | null;
}

// Why an item's post cannot take a comment right now, or null if it can. Mirrors createComment's own INSERT condition (a topic, open, visible);
// the INSERT still decides, this only lets the walk move on without spending an attempt.
function unpostableReason(row: TopicRow | undefined): string | null {
  if (!row) return "post_missing";
  if (row.kind !== "topic") return "not_a_topic";
  if (row.topic_state !== "open") return "topic_closed";
  if (row.mod_state != null) return "topic_moderated";
  return null;
}

export async function runLoopWake(env: Env, priorCost = 0, now = Date.now()): Promise<void> {
  try {
    await runLoopWakeInner(env, priorCost, now);
  } catch (e) {
    log("error", "loop_wake_failed", { message: e instanceof Error ? e.message : String(e) });
  }
}

async function runLoopWakeInner(env: Env, priorCost: number, now: number): Promise<void> {
  // Checked once, before any read, against the worst case (the concierge's shape): a shed run spends nothing.
  if (!canAffordLoop(priorCost)) {
    log("warn", "loop_deferred_budget", { prior_cost: priorCost, worst_case_cost: LOOP_WORST_CASE_COST });
    return;
  }

  // One a UTC day is decided by createComment's INSERT (a cron retry racing this run gets exactly one comment). This read only spares the rest of the
  // run's statements on the ordinary second call of a day, and chooses the log line; the INSERT is the guard.
  const dayStart = utcMidnight(now);
  const ranToday = await env.DB.prepare("SELECT 1 AS n FROM comments WHERE citizen_id = ?1 AND created_at >= ?2 AND substr(body, 1, length(?3)) = ?3 LIMIT 1")
    .bind(MAINTAINER_ID, dayStart, LOOP_DISCLOSURE_PREAMBLE)
    .first();
  if (ranToday) {
    log("info", "loop_already_ran_today", { by: "pre-read" });
    return;
  }

  const maintainer = await env.DB.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").bind(MAINTAINER_ID).first<Citizen>();
  if (!maintainer) throw new Error(`maintainer citizen ${MAINTAINER_ID} not found: refusing to post under a made-up identity`);

  // Two reads however long the queue is: the state of every topic the queue names, and every comment of the maintainer's on those topics that
  // begins with the preamble (what has already been posted).
  const topicIds = [...new Set(LOOP_QUEUE.map((item) => item.topic))];
  const marks = topicIds.map(() => "?").join(", ");
  const [topics, posted] = await Promise.all([
    env.DB.prepare(`SELECT id, kind, topic_state, mod_state FROM posts WHERE id IN (${marks})`).bind(...topicIds).all<TopicRow>(),
    env.DB.prepare(`SELECT post_id, body FROM comments WHERE citizen_id = ? AND post_id IN (${marks}) AND substr(body, 1, length(?)) = ?`)
      .bind(MAINTAINER_ID, ...topicIds, LOOP_DISCLOSURE_PREAMBLE, LOOP_DISCLOSURE_PREAMBLE)
      .all<{ post_id: number; body: string }>(),
  ]);
  const topicById = new Map(topics.results.map((row) => [row.id, row]));
  const alreadyPosted = new Set(posted.results.map((row) => `${row.post_id}\u0000${row.body}`));

  let done = 0;
  let skipped = 0;
  let attempts = 0;
  for (const [index, item] of LOOP_QUEUE.entries()) {
    if (alreadyPosted.has(`${item.topic}\u0000${storedForm(item)}`)) {
      done++;
      continue;
    }
    const reason = unpostableReason(topicById.get(item.topic));
    if (reason) {
      skipped++;
      log("warn", "loop_item_skipped", { index, topic: item.topic, reason });
      continue;
    }
    attempts++;
    try {
      const comment = await createComment(env, maintainer, item.topic, null, item.body, "loop");
      log("info", "loop_posted", { index, topic: item.topic, comment_id: comment.comment_id });
      return;
    } catch (e) {
      // A refusal (a SocietyError) is a topic closed or moderated between the read and the write, or the one-a-day predicate. The predicate ends the
      // whole run (every later item would be refused the same way); any other refusal sends the walk on, and the item is tried first again tomorrow.
      // Anything that is not a refusal (a D1 or runtime failure) is not caught here: it ends the run as loop_wake_failed.
      if (!(e instanceof SocietyError)) throw e;
      if (e.code === LOOP_ALREADY_RAN_CODE) {
        log("info", "loop_already_ran_today", { by: "predicate" });
        return;
      }
      log("warn", "loop_post_refused", { index, topic: item.topic, status: e.status, message: e.message });
      if (attempts >= LOOP_MAX_ATTEMPTS) {
        log("warn", "loop_attempts_exhausted", { attempts });
        return;
      }
    }
  }

  if (done === LOOP_QUEUE.length) log("info", "loop_queue_exhausted", { items: LOOP_QUEUE.length });
  else log("warn", "loop_nothing_postable", { done, skipped, refused: attempts });
}
