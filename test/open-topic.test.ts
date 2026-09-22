// scripts/open-topic.mjs carries the maintainer secret, so its origin is pinned: an
// override is refused before anything is read (D-018 gate L6,
// docs/REVIEW-STANDING-TOPICS-GATE-2026-09-22.md), the same as post-listing.mjs and
// pay-listing.mjs. Spawned, because the refusal is the script's top-level behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("open-topic.mjs refuses a COMMONHOLD_ORIGIN override and exits 2 before reading any file", () => {
  const r = spawnSync(process.execPath, ["scripts/open-topic.mjs", "--file", "no-such-topic-file.txt"], {
    env: { ...process.env, COMMONHOLD_ORIGIN: "https://not-commonhold.example" },
    encoding: "utf8",
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /takes no origin override/);
  assert.doesNotMatch(r.stderr, /ENOENT/, "it must refuse before touching the --file path");
});
