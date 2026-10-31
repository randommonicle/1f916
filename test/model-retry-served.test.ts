// D-079 (docs/BRIEF-MODEL-CALL-RETRY.md R3, R5, R22): both run endpoints SERVE model_retry, and their notes say what is true after the change.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1 } from "./helpers/local-d1.ts";
import { maintainerRunsPage } from "../src/maintainer/runs.ts";
import { conciergeRunsPage } from "../src/maintainer/concierge.ts";

test("GET /api/maintainer-runs serves model_retry on the row and the note names it, the catch-up and both residuals", async () => {
  const d1 = createLocalD1();
  d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at, finished_at, model_retry) VALUES ('clerk', 1000, 1001, 'rerun: failed twice: a | b')").run();
  const page = await maintainerRunsPage({ DB: d1.DB });
  assert.equal((page.runs[0] as unknown as { model_retry: string }).model_retry, "rerun: failed twice: a | b");
  assert.match(page.note, /model_retry is a separate column/);
  assert.match(page.note, /deliberately NOT part of error/);
  assert.match(page.note, /at most once/);
  assert.match(page.note, /same Cloudflare data centre/);
  assert.match(page.note, /06:30 UTC daily/);
  assert.match(page.note, /only if the operator has registered those two cron lines/);
  assert.match(page.note, /manual wake started at the same moment/);
  assert.match(page.note, /open row that stops its own catch-up/);
  assert.match(page.note, /error carries three different things/, "error still carries exactly the three it did");
});

test("GET /api/concierge-runs serves model_retry and the note no longer calls a failed model call costly (R5)", async () => {
  const d1 = createLocalD1();
  d1.raw.prepare("INSERT INTO concierge_runs (started_at, finished_at, model_retry) VALUES (1000, 1001, 'recovered: x')").run();
  const page = await conciergeRunsPage({ DB: d1.DB });
  assert.equal((page.runs[0] as unknown as { model_retry: string }).model_retry, "recovered: x");
  assert.match(page.note, /model_retry is null unless a model call failed/);
  assert.match(page.note, /'model call failed' means the call returned an error, so no tokens came back/);
  assert.doesNotMatch(page.note, /Those three carry a real, non-zero cost/);
});
