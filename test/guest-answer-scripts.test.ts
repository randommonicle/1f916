// The guest-answer loop's two local scripts (docs/BRIEF-GUEST-VOICE.md A6): the pure gates, the draft step's
// isolation, and both scripts run as real child processes against the real worker served over local HTTP on a
// real local D1. Nothing mocked. Mutants named per block.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import worker from "../src/index.ts";
import { sha256Hex } from "../src/chain.ts";
import type { Env } from "../src/society.ts";
import { createLocalD1, seedCitizens, seedTopic, seedVisitor, guestEnv, guestComment, count } from "./helpers/guest.ts";
// @ts-expect-error a plain .mjs script module, no types
import { convergenceProblem, idemKey, bodyProblems, answersTo, IDEM_KEY_MAX } from "../scripts/guest-answer-lib.mjs";

const SCRIPTS = resolve(import.meta.dirname, "..", "scripts");
const ANSWER = "Thank you for the critique. The rule you cite applies here, and this is why: the cap is enforced inside the write itself.";

function converged(body: string): string {
  return ["# REVIEW", "", "## [CLAUDE round 1]", "", "> " + body, "", "[[END CLAUDE round 1]]", "", "## [GEMINI round 1]", "", "fine", "", "[[CONVERGED]]", "", "[[END GEMINI round 1]]", "", "## [CODEX round 1]", "", "fine", "", "[[CONVERGED]]", "", "[[END CODEX round 1]]", ""].join("\n");
}

// ---------- the pure gates ----------

test("A6 gates: convergence needs the exact body AND both seats' [[CONVERGED]] after its last appearance", () => {
  // Mutant: drop the CODEX requirement from convergenceProblem -> the GEMINI-only file passes.
  assert.equal(convergenceProblem(converged(ANSWER), ANSWER), null);
  assert.match(convergenceProblem(converged(ANSWER), ANSWER + " (edited)"), /does not appear/);
  const geminiOnly = converged(ANSWER).replace(/## \[CODEX round 1\][\s\S]*$/, "");
  assert.match(convergenceProblem(geminiOnly, ANSWER), /from CODEX/);
  // the body re-quoted in a later hub round (a change) resets the gate: convergence before it does not count
  const requoted = converged(ANSWER) + "\n## [CLAUDE round 2]\n\n> " + ANSWER + "\n\n[[END CLAUDE round 2]]\n";
  assert.match(convergenceProblem(requoted, ANSWER), /GEMINI and CODEX/);
});

test("A6 gates: the idempotency key is deterministic per target and body, within the server's limit and alphabet; bodies are length- and dash-checked", () => {
  const k = idemKey("g7", ANSWER);
  assert.equal(k, idemKey("g7", ANSWER));
  assert.notEqual(k, idemKey("g8", ANSWER));
  assert.notEqual(k, idemKey("g7", ANSWER + "."));
  assert.ok(k.length <= IDEM_KEY_MAX && /^[\x21-\x7e]+$/.test(k), k);
  assert.deepEqual(bodyProblems(ANSWER), []);
  assert.match(bodyProblems("too short").join(), /discharges nothing/);
  assert.match(bodyProblems(ANSWER + " — and more").join(), /dash/);
  assert.equal(answersTo([{ id: "g2", tier: "citizen", author: "commonhold-agent", parent: { kind: "thread", id: "g1" } }], "g1").length, 1);
  assert.equal(answersTo([{ id: "g2", tier: "citizen", author: "alice", parent: { kind: "thread", id: "g1" } }], "g1").length, 0, "another citizen's answer is not the answerer's");
});

test("A6 (i) isolation: the draft step and the shared lib read no custody file and make no write request", () => {
  // Mutant: add `readFileSync("../commonhold-agent-registration.local.json")` or a POST to the draft step -> red.
  for (const f of ["guest-due-draft.mjs", "guest-answer-lib.mjs"]) {
    const src = readFileSync(join(SCRIPTS, f), "utf8");
    assert.doesNotMatch(src, /\.local\./, `${f} names a custody file`);
    assert.doesNotMatch(src, /method:\s*["'](POST|PUT|PATCH|DELETE)/, `${f} makes a write request`);
  }
  const draftImports = [...readFileSync(join(SCRIPTS, "guest-due-draft.mjs"), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(draftImports.filter((m) => !m.startsWith("node:")), ["./guest-answer-lib.mjs"]);
});

// ---------- both scripts end to end, as child processes, against the real worker over HTTP ----------

function serve(env: Env): Promise<{ server: Server; base: string }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "GET" ? undefined : body }), env);
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

function run(script: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    execFile(process.execPath, [join(SCRIPTS, script), ...args], { cwd, encoding: "utf8" }, (err, stdout, stderr) => ok({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
  });
}

test("A6 end to end: draft writes the critique as data; send refuses an unconverged exchange, dry-runs clean, sends once, verifies, and refuses a second send", async () => {
  // Mutants: drop the answersTo re-read in the send step -> the second --execute is not a STOP; drop the
  // convergence gate -> the unconverged run sends.
  const d1 = createLocalD1();
  seedCitizens(d1);
  const secret = "commonhold_sk_test_answerer_" + "c".repeat(40);
  d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE id = 1").run(await sha256Hex(secret));
  const env = guestEnv(d1);
  const { server, base } = await serve(env);
  const root = mkdtempSync(join(tmpdir(), "guest-answer-"));
  try {
    const topic = seedTopic(d1, { title: "Advice" });
    const v = await seedVisitor(d1, "wren");
    const crit = await guestComment(env, v.token, { post_id: topic, body: "Why can the operator close a topic by opening another one?", kind: "critique" });
    assert.equal(crit.body.duty.accrued, true, JSON.stringify(crit.body));
    const gid = crit.body.comment_id as string;

    const out = join(root, "draft");
    const draft = await run("guest-due-draft.mjs", ["--out", out, "--base", base], root);
    assert.equal(draft.code, 0, draft.out);
    assert.match(draft.out, /1 actionable: 1 owed, 0 already answered/);
    const rec = JSON.parse(readFileSync(join(out, `${gid}.json`), "utf8"));
    assert.equal(rec.row.body, "Why can the operator close a topic by opening another one?");
    const skeleton = readFileSync(join(out, `REVIEW_guest-answers-${rec.read_at.slice(0, 10)}.md`), "utf8");
    assert.match(skeleton, /Guest text \(data\):[\s\S]*Why can the operator close a topic/);

    const society = join(root, "society");
    mkdirSync(society);
    writeFileSync(join(root, "commonhold-agent-registration.local.json"), JSON.stringify({ secret }));
    writeFileSync(join(root, "answer.txt"), ANSWER + "\n");
    writeFileSync(join(root, "unconverged.md"), "## [CLAUDE round 1]\n\n> " + ANSWER + "\n\n## [GEMINI round 1]\n\n[[CONVERGED]]\n");
    writeFileSync(join(root, "converged.md"), converged(ANSWER));
    const common = ["--target", gid, "--body-file", join(root, "answer.txt"), "--base", base];

    const refused = await run("guest-answer-send.mjs", [...common, "--exchange", join(root, "unconverged.md"), "--execute"], society);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /\[STOP\] exchange: no \[\[CONVERGED\]\] from CODEX/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'citizen'"), 0);

    const dry = await run("guest-answer-send.mjs", [...common, "--exchange", join(root, "converged.md")], society);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /\[dry-run\] gates passed; nothing sent/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'citizen'"), 0, "a dry run writes nothing");

    const sent = await run("guest-answer-send.mjs", [...common, "--exchange", join(root, "converged.md"), "--execute"], society);
    assert.equal(sent.code, 0, sent.out);
    assert.match(sent.out, /\[verify\] g\d+ answers g\d+ .*body matches the file exactly/);
    assert.doesNotMatch(sent.out, new RegExp(secret), "the secret is never printed");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'citizen' AND author_id = 1 AND parent_kind = 'thread'"), 1);

    const again = await run("guest-answer-send.mjs", [...common, "--exchange", join(root, "converged.md"), "--execute"], society);
    assert.equal(again.code, 1, again.out);
    assert.match(again.out, /already answered/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'citizen'"), 1, "exactly one answer");
    assert.ok(existsSync(join(out, `${gid}.json`)));
  } finally {
    server.close();
    d1.close();
    rmSync(root, { recursive: true, force: true });
  }
});
