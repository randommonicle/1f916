// Proves the subrequest-counting seam THE PROOF is built on actually counts
// both boundaries on one shared closure and throws before the 51st -- a
// detector that cannot fail certifies nothing (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md,
// prove-it-can-fail). The e2e proofs in test/maintainer-scheduled-budget.test.ts
// rely on exactly this behaviour; this file pins it directly.
//
// Run just this file: node --experimental-strip-types --test "test/subrequest-counter.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter } from "./helpers/subrequest-counter.ts";

test("the counter tallies D1 statements and outbound fetches on ONE shared counter", async () => {
  const counter = installSubrequestCounter(() => new Response("{}", { status: 200 }));
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    await d1.DB.prepare("SELECT 1 AS x").first();
    await d1.DB.prepare("SELECT 1 AS x").all();
    assert.equal(counter.d1(), 2, "two D1 statements counted");
    assert.equal(counter.fetches(), 0);

    await globalThis.fetch("https://api.anthropic.com/v1/messages", { body: "{}" });
    assert.equal(counter.fetches(), 1, "one outbound fetch counted");
    assert.equal(counter.total(), 3, "D1 and fetch draw from the ONE shared pool");
    assert.equal(counter.breached(), false);
  } finally {
    counter.restore();
    d1.close();
  }
});

test("each statement inside a batch counts as its own subrequest (conservative metering)", async () => {
  const counter = installSubrequestCounter(() => new Response("{}", { status: 200 }));
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    await d1.DB.batch([d1.DB.prepare("SELECT 1 AS x"), d1.DB.prepare("SELECT 2 AS x"), d1.DB.prepare("SELECT 3 AS x")]);
    assert.equal(counter.d1(), 3, "a 3-statement batch is 3 subrequests, not 1");
  } finally {
    counter.restore();
    d1.close();
  }
});

test("the 51st subrequest THROWS before executing, and breached latches -- proven for a D1 statement", async () => {
  const counter = installSubrequestCounter(() => new Response("{}", { status: 200 }));
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    for (let i = 0; i < 50; i++) await d1.DB.prepare("SELECT 1 AS x").first();
    assert.equal(counter.total(), 50, "50 is within budget");
    assert.equal(counter.breached(), false);
    await assert.rejects(
      () => d1.DB.prepare("SELECT 1 AS x").first(),
      /subrequest budget exceeded: attempted subrequest 51 .* d1=51/,
      "the 51st D1 statement throws before executing",
    );
    assert.equal(counter.breached(), true, "breached latches so a swallowed throw cannot read as a pass");
  } finally {
    counter.restore();
    d1.close();
  }
});

test("the 51st subrequest THROWS when it is a FETCH -- fetches count identically to D1 statements", async () => {
  const counter = installSubrequestCounter(() => new Response("{}", { status: 200 }));
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    for (let i = 0; i < 50; i++) await d1.DB.prepare("SELECT 1 AS x").first();
    await assert.rejects(
      () => globalThis.fetch("https://api.anthropic.com/v1/messages", { body: "{}" }),
      /this one is a fetch/,
      "the 51st subrequest being an outbound fetch throws just the same -- a proof that fails only on 'query 51' would miss this",
    );
    assert.equal(counter.fetches(), 1, "the over-budget fetch was counted (and refused) as subrequest 51");
    assert.equal(counter.breached(), true);
  } finally {
    counter.restore();
    d1.close();
  }
});
