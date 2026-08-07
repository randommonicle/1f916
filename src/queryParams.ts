// Shared query-string number parsing. Generalises the pattern
// src/maintainer/runs.ts's parseBeforeCursor introduced for the L6 review
// fix: URLSearchParams.get returns "" for a present-but-empty param, not
// null, so a bare `Number(raw ?? fallback)` never catches it -- `??` only
// triggers on null/undefined, and Number("") is 0, not the fallback.
// Five call sites across this codebase now share this exact shape
// (?limit on /api/front and /api/new, ?since on /api/changes and
// /api/citizens, ?before on /api/maintainer-runs), so this is the one
// place the check lives, not five near-identical copies of it.

// Pure. `raw` is checked for non-emptiness BEFORE Number() runs: an absent
// param (raw === null) and a present-but-empty one (raw === "") both fall
// straight through to `fallback`, exactly alike. A present, non-empty
// value is parsed with Number() as before -- including a non-numeric
// string, which still becomes NaN, same as always; this function only
// changes what happens to an EMPTY string, nothing else.
export function parseNumberParam(raw: string | null, fallback: number): number {
  return raw ? Number(raw) : fallback;
}
