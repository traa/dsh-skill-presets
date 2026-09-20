# Deferred — Phase 9

Raised during review of PR #27 and deliberately **not** fixed in it. Recorded
here because a PR comment stops being reachable once the PR closes.

## D1 — The Playwright stage specs were never executed

**What.** `stage/tests/phase9.spec.mjs` (new) and the migration out of
`stage/tests/phase8.spec.mjs` were written and reviewed **by inspection only**.
Neither has ever run.

**Why not.** `@playwright/test` does not resolve in this worktree, and
installing fails against a private registry
(`GET https://registry.npmjs.org/@deepseek-ai%2Fdsh-type-meta → 404`). The
worktree has no `node_modules` of its own; `npm run build` works because npm
resolves binaries upward from the primary checkout, but module resolution for
test imports does not follow that path.

**Risk accepted.** Low but not zero. The four `phase 9 shape` unit tests in
`test/client.test.mjs` drive the same click handler on the same built artifact
and are mutation-verified (dropping `sidebarRight` from `inject` fails shapes 1
and 3). What the unit tests cannot prove is the part only a browser exercises:
that the real shell's `sidebarRight` service is reachable from the popover's
click at runtime. That is exactly the class of gap that hid the Phase 8 bug —
unit-green while the live page was broken — so it should not stay unrun.

**To close it.** Run `npx playwright test stage/tests/phase9.spec.mjs` from a
checkout with a real `node_modules` (the primary checkout, after the branch
merges), or fix worktree dependency resolution. Two assertions must hold:
`window.__STAGE__.tabsOpened === ['skills']` and `rightbarOpened === 0`.

**Related, same root cause.** `probe on this checkout reports lib present and
node_modules real` (`test/doctor.test.mjs:64`) fails in this worktree for the
same missing-`node_modules` reason. It passes in the primary checkout and fails
identically with every phase-9 change stashed. It is not caused by this PR, and
it is the suite's only failure.

## Not deferred

Every finding from both review rounds was fixed in `2ca9956`. Nothing else was
declined.
