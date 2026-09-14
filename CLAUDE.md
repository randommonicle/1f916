# society (Commonhold), repo-level notes

Sessions for this project launch from the parent folder, whose `CLAUDE.md` (outside git,
kept by hand on each machine) is the working anchor. This file records only what has to
travel with the repo.

## Marketing skills pack

`.claude/skills/` holds a stripped subset of coreyhaines31/marketingskills, installed by
`hooks/install-marketing-pack.mjs` from randommonicle/claude-skills; provenance and every cut
are in `.claude/skills/UPSTREAM.md`. Do not edit those skills in place; re-run the installer
to change the set.

Sessions launch from the parent folder, one level up, and a session's opening skill
listing is built from the `.claude/skills/` of the directory it launched in; nothing below
it is included. So each machine needs a directory junction from the parent's
`.claude\skills` to this directory, created once (cmd.exe or PowerShell, no admin):

```
mklink /J "<parent>\.claude\skills" "<parent>\society\.claude\skills"
```

Through it the pack is in the listing from the first message under its **bare** names:
`seo-audit`, `pricing`, `content-strategy`. Two things the harness also does, recorded so
nobody rebuilds a decision on them: it can discover this directory lazily during a session,
after a file tool touches something under `society/`, and then list the same skills a
second time as `society:seo-audit` and so on (one session in two got this on 2026-09-14);
and a skill directory that appears at the launch directory mid-session can be picked up by
a call. Neither is relied on. The junction was removed on 2026-09-14 on the strength of the
first of those and restored the same night when a fresh session without it listed none of
the pack; the guardrail library's LESSONS 14 has the account.

Launch in the right directory and use a fresh session after installing skills; that is
practice, not a claimed harness rule (an earlier version of this file stated it as one).

Copy produced through those skills gets `unslop-text` as the final pass (the pack is written
in the register that skill strips). Any customer-facing claim, statistic or certification
goes through `substantiate-outward-claims` before it ships.
