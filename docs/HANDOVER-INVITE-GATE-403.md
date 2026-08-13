# Handover — invite-gate 403 incident (2026-08-13)

A recruit could not register through the phase-0 invite gate. Resolved the same
day by rotating the invite secret. This note is the pick-up point for a later
session; it deliberately contains **no codes, tokens, or keys** (per the README:
codes live only in the `INVITE_CODES` secret and the operator's local
`invite-codes.local.txt`, never in the repo).

## Symptom

A recruit (chosen handle `sisyphus`) POSTed to `/api/register` and the live door
returned `403 "That is not a recognised invite code."` — with and without the
angle brackets the code had been wrapped in, and before any payment. Nothing was
signed or charged, which is expected: the invite check is step 1 in
`handleRegisterGate` (`src/register-gate.ts`), ahead of the 402 and the x402
flow, so a bad code fails for free.

## Root cause

The value in the onboarding message was malformed: `9a12646a14f7` — 12 hex
characters, **no `ch-` prefix**. Real codes are `ch-` + 12 base64url characters
(`scripts/generate-invite-codes.mjs`: `"ch-" + randomBytes(9).toString("base64url")`).
The hex shape looks like a `randomBytes(6).toString("hex")` value from somewhere
else — it was never a configured code.

Confirmed against the live door (free probe — invite check precedes payment, so
these charge nothing and create nothing):

- `GET /` → 200 (door healthy).
- `POST /api/register` with `9a12646a14f7` → 403.
- `POST /api/register` with `ch-9a12646a14f7` (testing a dropped prefix) → 403.

So: the secret and the gate were always healthy. The wrong value was pasted at
the source. Not a loading bug, not the angle brackets, not the payment path.

## Resolution

Operator confirmed no other invite codes were outstanding, so overwriting the
secret was safe. A fresh, correctly-formed `ch-…` code was minted, and
`INVITE_CODES` was overwritten via the Cloudflare dashboard
(Workers → `commonhold` → Settings → Variables and Secrets). Verified live: a
probe with the new code returned **402** (invite accepted, x402 challenge
issued). The new code was sent to the recruit out-of-band and is **not** recorded
here. It was unused as of handover — a code is only marked redeemed after a
payment settles, so the verification probe did not burn it.

## What changed in the repo

- `scripts/add-invite-code.mjs` — appends **one** code without disturbing the
  cohort. `generate-invite-codes.mjs` regenerates all ten and overwrites the
  secret, which silently invalidates any outstanding codes — wrong for a single
  replacement. The new script rebuilds the full list from
  `../invite-codes.local.txt` and **refuses if that file is missing**, so it can
  never push a truncated list that would drop live codes. Run with `--dry-run`
  first.

## Follow-ups (not yet done)

1. **Invite template.** Drop the literal `<angle brackets>` around the code in
   the onboarding message, and instruct sending the code in a fenced code block.
   base64url codes contain `_`, which Markdown/rich-text channels render as an
   italic marker and eat on copy — a real failure mode adjacent to this incident.
2. **Shape check at send time.** A tiny guard (or lint) that rejects any code not
   matching `^ch-[A-Za-z0-9_-]{12}$` would have stopped `9a12646a14f7` before it
   ever reached the recruit.
3. **Phase-1 alphabet.** Consider a code alphabet without `_` for codes that will
   travel over rich-text channels, or document the code-block requirement in the
   generator's output.
