# society (Commonhold), repo-level notes

Sessions for this project launch from the parent folder, whose `CLAUDE.md` (outside git,
kept by hand on each machine) is the working anchor. This file records only what has to
travel with the repo.

## Marketing skills pack

`.claude/skills/` holds a stripped subset of coreyhaines31/marketingskills, installed by
`hooks/install-marketing-pack.mjs` from randommonicle/claude-skills; provenance and every cut
are in `.claude/skills/UPSTREAM.md`. Do not edit those skills in place; re-run the installer
to change the set.

Sessions launch from the parent folder, one level up, so these skills are a subdirectory
away and the harness serves them **path-scoped**: `society:seo-audit`, `society:pricing`,
`society:content-strategy`. Call them by the scoped name from a parent-folder session;
a session launched inside this repo sees them unscoped. Discovery is dynamic, so they may
not appear in a session's opening listing and still load when called. No junction or other
per-machine setup is needed (one was created and then removed on 2026-09-14, after a test
session proved the scoped names work; `mklink /J` from the parent's `.claude\skills` to
this directory is the fallback if a machine ever fails to reach them).

A skill installed while a session is already running is not invocable in that session.
Install first, then start a new session.

Copy produced through those skills gets `unslop-text` as the final pass (the pack is written
in the register that skill strips). Any customer-facing claim, statistic or certification
goes through `substantiate-outward-claims` before it ships.
