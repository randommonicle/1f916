# Checkpoint: the inbox parameters wave (25 Nov 2026)

Ruled by the operator on 25 Nov ("Go with your recommendations for everything", FOR-BEN-2026-11-25 s3 and s4). Branch `gate-followups-2026-11-25`, base `46b6c393` (live). Brief: `drafts/BUILDER-BRIEF-inbox-params-2026-11-25.md`.

## 25 Nov wave

Commits (each with its tests):

- A `4af11aa3`: `assertInboxQuery` and `assertGuestInboxQuery` (one shared `assertKnownQuery` in `src/inbox.ts`), called in `src/index.ts` before any D1 statement; 400 `unknown_query_parameter` then `repeated_query_parameter`, same order and shape as `assertProposalsQuery`, which is untouched (its source literals and sentences are byte-identical). `assertInboxArgs` and `assertGuestInboxArgs` on both MCP doors (`unknown_argument`); `additionalProperties:false` and one sentence on both tools; one sentence on both route descriptions. Tests: `test/inbox-unknown-params-d1.test.ts`.
- B `ab576ab4`: both `cursor_note`s say at most INBOX_SECTION_LIMIT candidate rows of each table are taken for one page, a count of candidates and not items delivered; the citizen note adds that open_proposals is outside it. `docs/HEARTBEAT-SKILL-TEXT.md` carries the citizen sentence. Tests: `test/inbox-cursor-note-cap-d1.test.ts`.
- C `bd652373`: test only, in `test/inbox-cursor-head-d1.test.ts`. A cursor issued by hand one above the comments head, first sent after the head has passed it, is 200 and the row at the cursor is not delivered. Titled KNOWN LIMIT, not wanted behaviour. Control: a served cursor delivers both rows.
- D `6b195217`: the reservation refusal in `src/listings.ts` ends "This request settled nothing. That does not establish the outcome of an earlier or overlapping signed payment: ...". Flag comment removed. Two pins in `test/code-identity-lows-d1.test.ts` and one in `test/listings-d1.test.ts` updated; new test 10b in `test/settlement-replay-listings-d1.test.ts` holds two identical payments in flight.

Decisions and findings:

- MCP before this wave: `inbox` and `guest_inbox` read only their named keys and ignored any other argument (a `limit` or `secret` was silently dropped), on both doors. Now refused, as `assertProposalsArgs` does.
- The sentence in B says "candidate rows ... taken", not "looked at": the SQL LIMIT is `INBOX_SECTION_LIMIT + 1` candidates that already passed the SQL prefilter, and `runTablePage` cuts the page at the limit again in JavaScript. Both bounds exist, so raising only the SQL one changes nothing (mutation B3 first attempt, GREEN, explained; replaced by cutting the page one row late, RED).
- Callers in the repo that pass either route a parameter: `scripts/deploy-heartbeat-inbox.ps1` (handle, since), `scripts/deploy-ship-2026-11-24.ps1` (handle, since, guest, cursor), and the printed URLs in `src/inbox.ts`, `src/doc.ts`, `src/guest.ts`, `src/guest-core.ts`, `src/resident.ts`, `src/listings.ts` (handle, since, guest). All use accepted keys; test 8 proves each URL a served document prints is read with 200.
- `src/doc.ts` unchanged: its attested template was not touched, so no mint.
- Existing historical docs that quote the old refusal sentence (`CHECKPOINT-CODE-IDENTITY-LOWS.md`, two REVIEW files) are records and were left as written.

Mutations (all restored, worktree clean): A1 to A9 RED; B1, B2, B3 RED; C1, C2 RED; D1 to D4 RED. One GREEN along the way (B3's first form), explained above.

## 25 Nov, the exception and the hub's read (rebased on `c085b7a1`)

The branch was rebased on `c085b7a1` (one test file); the commit hashes above are the ones before the rebase.

- Ruled (D-093 note, 25 Nov): `secret` and `token` stay accepted and unused on the `inbox` and `guest_inbox` tools, both doors. `IGNORED_CREDENTIAL_ARGS` in `src/inbox.ts`; the refusal and both tool descriptions name the exception; a refusal names keys, never values. The two routes refuse both names like any other.
- `additionalProperties: false` is taken off both schemas, so a client that validates first does not refuse what the server accepts. Neither name is declared as a property: that would ask callers to send a credential to a read that needs none.
- Guest `cursor_note`: "and duties is outside it" added. `duties` is read from guest_thread too, under its own limit, so the cap sentence as built was not true of the whole answer.
- Test 8 was partly blind: a placeholder with a space cut the URL short, and an unfilled one was skipped. It now takes a placeholder as one atom, fills every one or fails, and checks the keys of every inbox URL printed by `src/*.ts`. The cap test asserts the exact page, then the remainder.
- Mutations (`scratch/mut-inbox.py` in the hub): 38 run, 38 RED, all restored.

Open: a client that sends any other stray key to these two tools or routes is now refused; the cost the operator accepted on 25 Nov.
