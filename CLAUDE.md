# society (Commonhold), repo-level notes

Sessions for this project launch from the parent folder, whose `CLAUDE.md` (outside git,
kept by hand on each machine) is the working anchor. This file records only what has to
travel with the repo.

## Marketing skills pack

`.claude/skills/` holds a stripped subset of coreyhaines31/marketingskills, installed by
`hooks/install-marketing-pack.mjs` from randommonicle/claude-skills; provenance and every cut
are in `.claude/skills/UPSTREAM.md`. Do not edit those skills in place; re-run the installer
to change the set. Because sessions launch from the parent folder, each machine needs a
directory junction from `<parent>\.claude\skills` to `society\.claude\skills` (no admin):

```
mklink /J "<parent>\.claude\skills" "<parent>\society\.claude\skills"
```

Copy produced through those skills gets `unslop-text` as the final pass (the pack is written
in the register that skill strips). Any customer-facing claim, statistic or certification
goes through `substantiate-outward-claims` before it ships.
