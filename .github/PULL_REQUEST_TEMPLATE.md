<!--
PR template — see AGENTS.md for the full contribution guide.

Do not remove sections. Mark sections "n/a" with a one-line reason
when they truly don't apply (e.g. "n/a — docs-only"). Reviewers use
this template to track what was tested and what's at risk; removing
parts of it makes review harder.
-->

## Summary

<!--
1–3 bullets on what changed and why. Focus on the *why*; the diff
shows the *what*. Link to an issue or design doc if one motivated
the change.
-->

-

## Test plan

<!--
What you ran locally before requesting review. For code changes,
all three boxes must be checked. For docs-only PRs, write "n/a —
docs only" below the checklist and leave the boxes unticked.
-->

- [ ] `npm run lint` — zero eslint errors
- [ ] `npm test` — all vitest suites pass
- [ ] `npm run build` — clean rebuild, no rollup errors

**Manual / UI verification:**

<!--
For UI or playback changes: how you exercised the change in HA.
Which radar source? Which overlays enabled? Which map zoom level?
Mobile or desktop? If you used the Docker testbed
(`npm run ha:up`), say so. If you couldn't test a surface (e.g. a
DWD-only change without German rain to look at), say so explicitly
so a reviewer can pick it up.
-->

## Risk

<!--
Anything a reviewer should think hardest about. Schema changes,
config migrations, fetch lifecycle (AbortController, generation
counters), the crossfade pipeline, marker resolution, anything that
could regress an existing install on upgrade. "Low — internal
refactor with full test coverage" is a valid answer when true.
-->

## Docs touched

<!--
Tick the docs you updated in this PR, or write "n/a — internal
change" if no user-visible behaviour or future plans changed.
-->

- [ ] `README.md`
- [ ] `CHANGELOG.md`
- [ ] `docs/todo.md`
- [ ] `docs/configuration.md`
- [ ] `docs/data-sources.md`
- [ ] `docs/overlays.md`
- [ ] `docs/markers.md`
- [ ] `docs/examples.md`
- [ ] `docs/animation.md` or other `docs/*-feature-design.md`
- [ ] `docs/network-access.md`
- [ ] n/a — internal change
