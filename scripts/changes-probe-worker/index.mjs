// Worker-path probe for the standing-topics gate (CODEX, exchange/REVIEW_standing-topics-build-2026-09-21.md
// round 2): does SQLite's changes() inside a managed-D1 env.DB.batch([...]) report the immediately
// preceding statement of the SAME batch, and reset on a zero-row statement? src/topics.ts gates its
// chained row on `changes() = 1`; this proves the premise through the API the Worker actually uses.
//
// Runs against the SCRATCH database only (commonhold-migtest), never prod. Tables are namespaced and
// created WITHOUT "IF NOT EXISTS", so a name collision fails the run instead of touching a real table;
// both are dropped in finally. Read-only for everything else. One GET returns the evidence as JSON.
const T = "probe_chg_20260922_t";
const L = "probe_chg_20260922_log";

// The gate, shaped like src/topics.ts's: the new row must exist AND this batch's previous statement
// must have changed exactly one row.
const gated = (db, note, id) =>
  db.prepare(`INSERT INTO ${L} (note) SELECT ? WHERE EXISTS (SELECT 1 FROM ${T} n WHERE n.id = ? AND changes() = 1)`).bind(note, id);

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/run") return new Response("GET /run\n", { status: 404 });
    const db = env.DB;
    const out = { database: "commonhold-migtest (scratch)", started: new Date().toISOString() };
    await db.batch([db.prepare(`CREATE TABLE ${T} (id INTEGER PRIMARY KEY, v TEXT)`), db.prepare(`CREATE TABLE ${L} (id INTEGER PRIMARY KEY, note TEXT)`)]);
    try {
      const vec = (rs) => rs.map((r) => r.meta.changes);
      // 1. seed winner: a one-row conditional open, then the gate -> [1, 1]
      out.case1_open_winner = vec(await db.batch([db.prepare(`INSERT INTO ${T} (id, v) SELECT 1, 'open' WHERE (SELECT COUNT(*) FROM ${T}) < 5`), gated(db, "case1", 1)]));
      // 2. loser after a batch that ended on a one-row write: a zero-row open, then the gate -> [0, 0]
      //    (row 1 exists, so only changes() can refuse; a count leaking across batches shows as [0, 1])
      out.case2_open_loser = vec(await db.batch([db.prepare(`INSERT INTO ${T} (id, v) SELECT 2, 'open' WHERE 1 = 0`), gated(db, "case2", 1)]));
      // 3. replacing loser: a one-row close, a zero-row open, then the gate -> [1, 0, 0]
      //    (the intervening zero-row statement must reset the count the close left)
      out.case3_replace_loser = vec(await db.batch([db.prepare(`UPDATE ${T} SET v = 'closed' WHERE id = 1`), db.prepare(`INSERT INTO ${T} (id, v) SELECT 3, 'open' WHERE 1 = 0`), gated(db, "case3", 1)]));
      // 4. replacing winner: a one-row close, a one-row open, then the gate -> [1, 1, 1]
      out.case4_replace_winner = vec(await db.batch([db.prepare(`UPDATE ${T} SET v = 'closed' WHERE id = 1`), db.prepare(`INSERT INTO ${T} (id, v) SELECT 4, 'open' WHERE (SELECT COUNT(*) FROM ${T}) < 5`), gated(db, "case4", 4)]));
      out.log = (await db.prepare(`SELECT note FROM ${L} ORDER BY id`).all()).results.map((r) => r.note);
    } finally {
      await db.batch([db.prepare(`DROP TABLE ${T}`), db.prepare(`DROP TABLE ${L}`)]);
      out.dropped = true;
    }
    const expect = { case1_open_winner: [1, 1], case2_open_loser: [0, 0], case3_replace_loser: [1, 0, 0], case4_replace_winner: [1, 1, 1], log: ["case1", "case4"] };
    out.expect = expect;
    out.pass = Object.keys(expect).every((k) => JSON.stringify(out[k]) === JSON.stringify(expect[k]));
    return Response.json(out);
  },
};
