// Worker-binding rehearsal for last_assertion_at (D-078 item 4; brief A5 and A8). A SQL-only wrangler run cannot prove the JavaScript catch in authenticateByAssertion, so this runs the REAL
// authenticate() from src/society.ts through a REAL D1 binding on the SCRATCH database and reports what the Workers D1 binding does with the nonce-plus-stamp batch.
// Bound to commonhold-migtest only (wrangler.jsonc beside this file; scripts/rehearse-last-assertion.ps1 refuses any other database). Never deploy it.
// It generates a throwaway Ed25519 keypair inside the Worker, inserts ONE uniquely named scratch citizen, and checks:
//   c1   first spend returns the citizen; stamp set to a server time; one namespaced nonce row
//   c2   replay of that token: the existing 401 text; stamp (deliberately set EARLIER first, so a wrong update would show) and nonce rows unchanged
//   c3a  raw-nonce collision, stamp null: the same 401; stamp still null; no namespaced row
//   c3b  raw-nonce collision, stamp already set: the same 401; stamp unchanged; no namespaced row
//   c4   bad signature: 401, no stamp, no nonce row
//   c5   a batch of a nonce INSERT plus an UPDATE that must fail leaves no nonce row (proves D1's batch rollback; the real column exists here, so the failure is a nonexistent column)
//   c6   meta.rows_written of the raw batch for one spend, printed (brief A3)
// Every row it writes is deleted in finally. The report names each check with expected and actual and carries no key material and no token.
import { authenticate, SocietyError, type Env } from "../../src/society.ts";
import { ASSERTION_WINDOW_MS, DEFAULT_AUDIENCE, buildPayloadSegment, encodeBase64Url, newNonce } from "../../src/keyauth.ts";

const REPLAY_TEXT = "That assertion has already been used. Each one is single-use; sign a fresh one.";
const BAD_SIGNATURE_TEXT = "Signature does not verify against that citizen's registered public key.";
// The two statements authenticateByAssertion batches, verbatim (a test pins that they are the ones in src/society.ts).
const NONCE_INSERT =
  "INSERT INTO auth_nonces (nonce, citizen_id, expires_at) VALUES (CASE WHEN EXISTS (SELECT 1 FROM auth_nonces WHERE nonce = ?1) THEN ?1 ELSE ?2 END, ?3, ?4)";
const STAMP_UPDATE = "UPDATE citizens SET last_assertion_at = ? WHERE id = ? AND (last_assertion_at IS NULL OR last_assertion_at < ?)";

type Keypair = { privateKey: CryptoKey; publicKey: string };
type Check = { name: string; expected: unknown; actual: unknown; pass: boolean };

async function genKeypair(): Promise<Keypair> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) };
}
async function sign(kp: Keypair, handle: string, nonce: string): Promise<string> {
  const payload = buildPayloadSegment(handle, Date.now(), nonce, null, DEFAULT_AUDIENCE);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
  return `ch1.${payload}.${encodeBase64Url(sig)}`;
}
async function refusal(fn: () => Promise<unknown>): Promise<{ status: number | null; message: string }> {
  try {
    await fn();
    return { status: null, message: "NO ERROR" };
  } catch (e) {
    if (e instanceof SocietyError) return { status: e.status, message: e.message };
    return { status: null, message: `not a SocietyError: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/run") return new Response("GET /run\n", { status: 404 });
    const tag = Date.now().toString(16) + Math.random().toString(16).slice(2, 6);
    const handle = `a5-rehearsal-${tag}`;
    const report: Record<string, unknown> = { database: "commonhold-migtest (scratch)", started: new Date().toISOString() };
    const checks: Check[] = [];
    const add = (name: string, expected: unknown, actual: unknown, pass: boolean) => checks.push({ name, expected, actual, pass });
    const stampOf = async (id: number) => (await env.DB.prepare("SELECT last_assertion_at AS v FROM citizens WHERE id = ?").bind(id).first<{ v: number | null }>())?.v ?? null;
    const setStamp = (id: number, v: number | null) => env.DB.prepare("UPDATE citizens SET last_assertion_at = ? WHERE id = ?").bind(v, id).run();
    const nonceRows = async (id: number) => Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_nonces WHERE citizen_id = ?").bind(id).first<{ n: number }>())?.n ?? -1);
    const namespacedRows = async (id: number, nonce: string) =>
      Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_nonces WHERE nonce = ?").bind(`c:${id}:${nonce}`).first<{ n: number }>())?.n ?? -1);

    const col = await env.DB.prepare("SELECT name FROM pragma_table_info('citizens') WHERE name = 'last_assertion_at'").first();
    const nonces = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_nonces'").first();
    if (!col || !nonces) return Response.json({ ...report, pass: false, error: "citizens.last_assertion_at or auth_nonces is missing: migration 0024 is not on this database" }, { status: 500 });

    let citizenId = 0;
    try {
      const kp = await genKeypair();
      const other = await genKeypair();
      const now0 = Date.now();
      const ins = await env.DB.prepare(
        "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at, public_key) VALUES (?, 'assertion-rehearsal', 'unheld', 0, ?, ?, ?)",
      )
        .bind(handle, now0, now0, kp.publicKey)
        .run();
      citizenId = Number(ins.meta.last_row_id);
      report.scratch_citizen = handle;

      // c1: first spend
      const nonce1 = newNonce();
      const token1 = await sign(kp, handle, nonce1);
      const t1 = Date.now();
      const got = await authenticate(env, token1);
      const t2 = Date.now();
      const s1 = await stampOf(citizenId);
      add("c1 first spend returns the citizen", handle, got.handle, got.handle === handle);
      add("c1 stamp is a server time inside the call", `${t1}..${t2}`, s1, typeof s1 === "number" && s1 >= t1 && s1 <= t2);
      add("c1 one namespaced nonce row", 1, await namespacedRows(citizenId, nonce1), (await namespacedRows(citizenId, nonce1)) === 1);

      // c2: namespaced replay, with a deliberately EARLIER stamp so a wrong update would raise it
      const earlier = (s1 ?? Date.now()) - 1_000_000;
      await setStamp(citizenId, earlier);
      const rowsBefore2 = await nonceRows(citizenId);
      const r2 = await refusal(() => authenticate(env, token1));
      add("c2 replay is the existing 401", `401 ${REPLAY_TEXT}`, `${r2.status} ${r2.message}`, r2.status === 401 && r2.message === REPLAY_TEXT);
      add("c2 stamp unchanged by the replay", earlier, await stampOf(citizenId), (await stampOf(citizenId)) === earlier);
      add("c2 nonce rows unchanged", rowsBefore2, await nonceRows(citizenId), (await nonceRows(citizenId)) === rowsBefore2);

      // c3: raw-nonce collision, with a null stamp (a) and an existing earlier stamp (b)
      for (const [label, start] of [["c3a", null], ["c3b", earlier]] as const) {
        await setStamp(citizenId, start);
        const rawNonce = newNonce();
        await env.DB.prepare("INSERT INTO auth_nonces (nonce, citizen_id, expires_at) VALUES (?, ?, ?)")
          .bind(rawNonce, citizenId, Date.now() + ASSERTION_WINDOW_MS)
          .run();
        const rows3 = await nonceRows(citizenId);
        const r3 = await refusal(async () => authenticate(env, await sign(kp, handle, rawNonce)));
        add(`${label} raw-nonce collision is the existing 401`, `401 ${REPLAY_TEXT}`, `${r3.status} ${r3.message}`, r3.status === 401 && r3.message === REPLAY_TEXT);
        add(`${label} stamp unchanged`, start, await stampOf(citizenId), (await stampOf(citizenId)) === start);
        add(`${label} no namespaced row`, 0, await namespacedRows(citizenId, rawNonce), (await namespacedRows(citizenId, rawNonce)) === 0);
        add(`${label} nonce rows unchanged`, rows3, await nonceRows(citizenId), (await nonceRows(citizenId)) === rows3);
      }

      // c4: bad signature (signed by another key)
      await setStamp(citizenId, null);
      const nonce4 = newNonce();
      const rows4 = await nonceRows(citizenId);
      const r4 = await refusal(async () => authenticate(env, await sign(other, handle, nonce4)));
      add("c4 bad signature is a 401", `401 ${BAD_SIGNATURE_TEXT}`, `${r4.status} ${r4.message}`, r4.status === 401 && r4.message === BAD_SIGNATURE_TEXT);
      add("c4 no stamp", null, await stampOf(citizenId), (await stampOf(citizenId)) === null);
      add("c4 no nonce row", rows4, await nonceRows(citizenId), (await nonceRows(citizenId)) === rows4);

      // c5: batch rollback. The real column exists on this database, so the failing statement names a column that does not.
      const nonce5 = newNonce();
      let threw5 = false;
      try {
        await env.DB.batch([
          env.DB.prepare(NONCE_INSERT).bind(nonce5, `c:${citizenId}:${nonce5}`, citizenId, Date.now() + ASSERTION_WINDOW_MS),
          env.DB.prepare("UPDATE citizens SET a5_no_such_column = ? WHERE id = ?").bind(1, citizenId),
        ]);
      } catch {
        threw5 = true;
      }
      add("c5 the failing batch threw", true, threw5, threw5);
      add("c5 no nonce row survived the failing batch", 0, await namespacedRows(citizenId, nonce5), (await namespacedRows(citizenId, nonce5)) === 0);
      report.c5_note =
        "c5 proves D1's whole-batch rollback (a first-statement success is undone when a later statement fails). It does NOT prove the missing-column deploy case, because last_assertion_at exists on this database: the failing statement names a column that does not.";

      // c6: rows_written of the raw batch for one spend (stamp null so the UPDATE writes)
      await setStamp(citizenId, null);
      const nonce6 = newNonce();
      const out = await env.DB.batch([
        env.DB.prepare(NONCE_INSERT).bind(nonce6, `c:${citizenId}:${nonce6}`, citizenId, Date.now() + ASSERTION_WINDOW_MS),
        env.DB.prepare(STAMP_UPDATE).bind(Date.now(), citizenId, Date.now()),
      ]);
      const written = out.map((r) => (r.meta as { rows_written?: number }).rows_written);
      report.rows_written_per_statement = written;
      add("c6 rows_written reported for both statements", "two numbers", written, written.length === 2 && written.every((n) => typeof n === "number"));
      add("c6 the stamp landed", "a number", await stampOf(citizenId), typeof (await stampOf(citizenId)) === "number");
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
      add("the run completed without an unexpected error", "no error", report.error, false);
    } finally {
      if (citizenId > 0) {
        const del = await env.DB.batch([
          env.DB.prepare("DELETE FROM auth_nonces WHERE citizen_id = ?").bind(citizenId),
          env.DB.prepare("DELETE FROM citizens WHERE id = ? AND handle = ?").bind(citizenId, handle),
        ]);
        report.cleanup_rows_deleted = del.map((r) => r.meta.changes);
      }
    }
    return Response.json({ ...report, checks, pass: checks.length > 0 && checks.every((c) => c.pass) });
  },
};
