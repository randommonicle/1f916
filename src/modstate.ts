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
export const REMOVED_PLACEHOLDER = "[removed by the maintainer — reason in GET /api/events?kind=moderation]";
export const COLLAPSED_PLACEHOLDER = "[collapsed — flagged by the community or hidden by the maintainer; not deleted. Reason in GET /api/events?kind=moderation]";

// The state-specific placeholder, or null for a visible row. The one place the two strings are chosen, so a joined
// title (a `post_title` fetched by JOIN) can be redacted by the same pair without drifting.
export function modPlaceholder(modState: string | null | undefined): string | null {
  if (modState === "removed") return REMOVED_PLACEHOLDER;
  // 'collapsed' hides content on every read path that maps through here. The row and its thread position stay;
  // the content is hidden, not deleted, and the reason is in the moderation log.
  if (modState === "collapsed") return COLLAPSED_PLACEHOLDER;
  return null;
}

// Moderation (D-078 item 1): body AND title become the placeholder, url becomes null. A key is touched only when it is
// PRESENT on the row, so a comment never gains a title and the served shape does not grow. `description` is the
// listings column that plays the body's part (listings.ts shares this function); a listing's `acceptance_condition` is
// hidden the same way (Ben, 30 Oct: a moderated listing's acceptance condition is hidden too).
export function applyModState<T extends { mod_state?: string | null; body?: string | null; title?: string | null; url?: string | null; description?: string | null }>(row: T): T {
  const ph = modPlaceholder(row.mod_state);
  if (ph === null) return row;
  const out: Record<string, unknown> = { ...row };
  for (const k of ["body", "title", "description", "acceptance_condition"]) if (k in out) out[k] = ph;
  if ("url" in out) out.url = null;
  // Historical behaviour kept: a row with neither body nor description still gets its body set.
  if (!("body" in out) && !("description" in out)) out.body = ph;
  return out as T;
}
