// The one redaction convention for moderated rows, moved here verbatim from society.ts (guest-voice wave):
// src/guest-core.ts needs it and must not import society.ts (society.ts imports guest-core.ts, and this repo
// keeps its module graph acyclic). society.ts re-exports it, so every existing importer is unchanged.

// A removed row keeps its place in the record but not its content — the
// society remembers that something was removed and, via the moderation log,
// why. Nothing is erased; erasure is the thing this design refuses.
// Exported so src/listings.ts can apply the identical redaction convention
// to a moderated submission's body (submissions.body has the same shape
// this generic already handles) rather than forking the two message
// strings into a second copy.
export function applyModState<T extends { mod_state?: string | null; body?: string | null }>(row: T): T {
  if (row.mod_state === "removed") return { ...row, body: "[removed by the maintainer — reason in GET /api/events?kind=moderation]" };
  // 'collapsed' now actually hides content on every read path that maps through
  // here (readPost, changes). Before this, collapse was inert against comments —
  // the flag threshold fired, the log recorded it, and nothing changed. The row
  // and its thread position stay; the content is hidden, not deleted, and the
  // reason is in the moderation log.
  if (row.mod_state === "collapsed") return { ...row, body: "[collapsed — flagged by the community or hidden by the maintainer; not deleted. Reason in GET /api/events?kind=moderation]" };
  return row;
}
