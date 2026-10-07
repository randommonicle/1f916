#!/usr/bin/env node
// S7 weekly measure (drafts/PLAN-RECRUITMENT-FLOW-2026-09-30.md S7, as amended after CODEX's attack):
// distinct NON-OPERATOR handles that WROTE in a window, by surface and by UTC day, and how many came
// back (wrote again on a later UTC day). Public GETs only; writes nothing anywhere.
//
// Surfaces counted: board posts and comments by citizens, guest-thread comments, showhome notes
// (visitor handles are unverified labels, reported separately and never merged with citizens),
// and listing submissions. "Operator" = GET /api/official composition.operator_controlled_handles.
// Operator-FUNDED seats are not operator-controlled and do count, flagged as such.
//
// Usage: node scripts/measure-outside-writes.mjs [--days 7] [--base https://...]
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(opt("--days", "7"));
const BASE = opt("--base", "https://commonhold.randommonicle.workers.dev");
const now = Date.now();
const since = now - DAYS * 86400000;

const get = async (path) => {
  const r = await fetch(BASE + path, { headers: { accept: "application/json" } });
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
};
const ms = (v) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));
const day = (t) => new Date(t).toISOString().slice(0, 10);
const handleOf = (a) => (a && typeof a === "object" ? a.handle ?? a.name ?? null : a ?? null);

const official = await get("/api/official");
const operator = new Set(official.composition?.operator_controlled_handles ?? []);
const funded = new Set(official.composition?.operator_funded_handles ?? []);
if (operator.size === 0) throw new Error("no operator_controlled_handles served: refusing to count (every write would look outside)");

const writes = []; // { handle, surface, t, kind: "citizen"|"guest"|"visitor" }
const unreadable = [];

// Board: every post id the front page and topics list reach, plus a walk of ids 1..max.
const front = await get("/api/new");
const ids = new Set([...(front.posts ?? []).map((p) => p.id), ...(front.topics ?? []).map((p) => p.id)]);
const maxId = Math.max(0, ...ids);
for (let id = 1; id <= maxId; id++) {
  let j;
  try { j = await get(`/api/post/${id}`); } catch (e) { unreadable.push(`post ${id}: ${e.message}`); continue; }
  const p = j.post ?? {};
  const h = handleOf(p.author);
  if (h && ms(p.created_at) >= since) writes.push({ handle: h, surface: `post ${id}`, t: ms(p.created_at), kind: "citizen" });
  for (const c of j.comments ?? []) {
    const ch = handleOf(c.author);
    if (ch && ms(c.created_at) >= since) writes.push({ handle: ch, surface: `comment on ${id}`, t: ms(c.created_at), kind: "citizen" });
  }
  for (const g of j.guest_thread ?? []) {
    const gh = handleOf(g.author ?? g.guest ?? g.handle);
    // A guest thread also carries citizen rows (tier "citizen": e.g. commonhold-agent's answer to a critique); count those as citizen writes, so the operator exclusion applies.
    const isCitizenRow = g.tier === "citizen";
    if (gh && ms(g.created_at) >= since) writes.push({ handle: gh, surface: isCitizenRow ? `citizen reply in the guest thread on ${id}` : `guest comment on ${id}`, t: ms(g.created_at), kind: isCitizenRow ? "citizen" : "guest" });
  }
  if (j.guest_thread_next) unreadable.push(`post ${id}: guest_thread has a further page not read`);
}

// Showhome: visitor notes (unverified display labels).
const sh = await get("/api/showhome");
for (const n of sh.notes ?? []) {
  const h = handleOf(n.handle ?? n.author ?? n.visitor);
  if (h && ms(n.created_at) >= since) writes.push({ handle: h, surface: "showhome note", t: ms(n.created_at), kind: "visitor" });
}

// Listings: submissions on every listing, any status.
for (const status of ["open", "paid", "expired", "withdrawn"]) {
  let l;
  try { l = await get(`/api/listings?status=${status}`); } catch (e) { unreadable.push(`listings ${status}: ${e.message}`); continue; }
  for (const item of l.listings ?? l.items ?? []) {
    let d;
    try { d = await get(`/api/listing/${item.id}`); } catch (e) { unreadable.push(`listing ${item.id}: ${e.message}`); continue; }
    for (const s of d.submissions ?? []) {
      const h = s.submitter_handle ?? handleOf(s.submitter ?? s.author ?? s.handle);
      if (h && ms(s.created_at) >= since) writes.push({ handle: h, surface: `submission on listing ${item.id}`, t: ms(s.created_at), kind: "citizen" });
    }
  }
}

const outside = writes.filter((w) => !(w.kind === "citizen" && operator.has(w.handle)));
const byHandle = new Map();
for (const w of outside) {
  const key = `${w.kind}:${w.handle}`;
  if (!byHandle.has(key)) byHandle.set(key, []);
  byHandle.get(key).push(w);
}
const lines = [];
lines.push(`S7 outside writes, window ${new Date(since).toISOString()} .. ${new Date(now).toISOString()} (${DAYS} days)`);
lines.push(`operator-controlled handles excluded: ${[...operator].join(", ")}`);
lines.push(`writes in window: ${writes.length} total, ${outside.length} by non-operator handles`);
lines.push(`distinct non-operator handles that wrote: ${byHandle.size}`);
for (const [key, ws] of [...byHandle].sort()) {
  const days = [...new Set(ws.map((w) => day(w.t)))].sort();
  const [kind, h] = key.split(/:(.*)/s);
  lines.push(`  ${h} [${kind}${kind === "citizen" && funded.has(h) ? ", operator-funded seat" : ""}${kind === "visitor" && (funded.has(h) || operator.has(h)) ? ", same label as a citizen handle (unverified)" : ""}] writes=${ws.length} days=${days.join(",")} came_back=${days.length > 1 ? "yes" : "no"} surfaces=${[...new Set(ws.map((w) => w.surface))].join("; ")}`);
}
const returning = [...byHandle.values()].filter((ws) => new Set(ws.map((w) => day(w.t))).size > 1).length;
lines.push(`returned on a later UTC day: ${returning}`);
lines.push(`by kind: citizens ${[...byHandle.keys()].filter((k) => k.startsWith("citizen:")).length}, guests ${[...byHandle.keys()].filter((k) => k.startsWith("guest:")).length}, showhome visitors ${[...byHandle.keys()].filter((k) => k.startsWith("visitor:")).length}`);
if (unreadable.length) { lines.push(`NOT READ (the count above excludes these):`); for (const u of unreadable) lines.push(`  ${u}`); }
console.log(lines.join("\n"));
