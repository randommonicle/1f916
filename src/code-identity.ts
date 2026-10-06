// Served code identity (docs/BRIEF-SERVED-CODE-IDENTITY.md, 6 Oct 2026; amendments A1-A8).
//
// Two deploy-time facts, read from env and never invented, computed in THIS module only, so every served surface (GET /api/attest's `code` block and every settlement-claim
// answer's `answered_by`) says the same thing:
//
//   - `commit`: the 40-hex git commit the deploy script stamped (`wrangler deploy --var CODE_COMMIT:<sha>`). It is the operator's STATEMENT, checkable by reading the public
//     repository at that commit; nothing here proves the running bytes were built from it. Valid only if it matches COMMIT_PATTERN exactly. Absent: null + "not_stamped". Present but
//     not valid: null + "malformed_stamp", and the bad value is NOT served (a stamp is a claim about code, and an unvalidated string would be served as one). Each `wrangler deploy` replaces the
//     version's vars (--keep-vars defaults false) and CODE_COMMIT is not in wrangler.jsonc, so a deploy that forgets the flag serves "not_stamped", never a stale sha.
//   - `version_id`: Cloudflare's own id for the running Worker version, from the `version_metadata` binding (CF_VERSION_METADATA), with the time that version was uploaded. A platform
//     record: it tells one deploy from another and names no source. Binding absent (tests, an older config): null + "unavailable".

// JavaScript's `$` without the `m` flag matches only at the very end of the string (unlike Python's), so a trailing newline fails this pattern; no trim is applied anywhere.
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export interface VersionMetadata {
  id: string;
  tag?: string;
  timestamp: string;
}

export type CommitStatus = "stamped" | "not_stamped" | "malformed_stamp";
export type VersionStatus = "available" | "unavailable";

export interface CodeIdentity {
  commit: string | null;
  commit_status: CommitStatus;
  version_id: string | null;
  version_timestamp: string | null;
  version_status: VersionStatus;
}

// The shape the identity needs from env, spelt structurally and as `unknown` so a var set to anything (a number, an empty string) is judged here, not trusted by the type.
export interface CodeIdentityEnv {
  CODE_COMMIT?: unknown;
  CF_VERSION_METADATA?: unknown;
}

export function codeIdentity(env: CodeIdentityEnv): CodeIdentity {
  const stamp = env.CODE_COMMIT;
  let commit: string | null = null;
  let commit_status: CommitStatus;
  if (stamp === undefined || stamp === null) {
    commit_status = "not_stamped";
  } else if (typeof stamp === "string" && COMMIT_PATTERN.test(stamp)) {
    commit = stamp;
    commit_status = "stamped";
  } else {
    commit_status = "malformed_stamp";
  }

  const meta = env.CF_VERSION_METADATA as Partial<VersionMetadata> | undefined | null;
  const idOk = meta !== undefined && meta !== null && typeof meta === "object" && typeof meta.id === "string" && meta.id.length > 0;
  return {
    commit,
    commit_status,
    version_id: idOk ? (meta as VersionMetadata).id : null,
    version_timestamp: idOk && typeof (meta as VersionMetadata).timestamp === "string" ? (meta as VersionMetadata).timestamp : null,
    version_status: idOk ? "available" : "unavailable",
  };
}

// The sentence every settlement-claim answer carries in `answered_by.note` (A7; the text is pinned by the brief, corrected verbatim by the second exchange seat's round 3). One constant, so the
// served sentence, the test that pins it and the brief cannot drift apart.
export const ANSWERED_BY_NOTE =
  "The code that produced this answer. commit is the operator's deploy-time stamp: a statement checkable against the public repository at that commit, not proof of the running bytes, and null when no valid commit stamp is served, including when the stamp is absent or malformed (commit_status says which). version_id is Cloudflare's id for this Worker version. This payment's claim may have been decided earlier by other code; the claim row does not record which.";

export interface AnsweredBy {
  commit: string | null;
  commit_status: CommitStatus;
  version_id: string | null;
  note: string;
}

// The block a settlement-claim answer carries. Deliberately narrower than the /api/attest block: no timestamp, no version_status (the version id is null when unavailable).
export function answeredBy(identity: CodeIdentity): AnsweredBy {
  return { commit: identity.commit, commit_status: identity.commit_status, version_id: identity.version_id, note: ANSWERED_BY_NOTE };
}

// Where each served figure comes from, in the vocabulary of /api/official's composition provenance (society.ts COMPOSITION_PROVENANCE: commonhold_statement), plus one new label,
// platform_record, because "record" there means "reproducible from public data" and a Cloudflare version id is not (a stranger cannot recompute it; the platform reports it). Static: it names
// sources and never counts or quotes a value, so it cannot go stale.
export const CODE_PROVENANCE = {
  key: "commonhold_statement: Commonhold describing itself; the claim and its source are the same party, so it is not independent corroboration, which is not a presumption that it is false. platform_record: an identifier the Cloudflare runtime reports for the running Worker version; a stranger cannot recompute it from public data, and it names no source.",
  commit: {
    source: ["commonhold_statement"],
    check: "The operator's deploy script typed this sha when it deployed (wrangler deploy --var CODE_COMMIT:<sha>). Check it by reading the public repository at that commit (https://github.com/randommonicle/1f916). Nothing served here proves the running bytes were built from it. null means no valid stamp is served: commit_status says whether it was absent or malformed.",
  },
  version_id: {
    source: ["platform_record"],
    check: "Cloudflare's own id for the Worker version now running, from the runtime's version-metadata binding, with the time that version was uploaded. It tells one deploy from another and names no source: it does not say which commit the bytes were built from.",
  },
} as const;

// The block GET /api/attest serves as `code`.
export function codeBlock(env: CodeIdentityEnv): CodeIdentity & { provenance: typeof CODE_PROVENANCE } {
  return { ...codeIdentity(env), provenance: CODE_PROVENANCE };
}
