# Intent — Phase 3: hard guardrails, worktree lifecycle, evals

## Problem
Phase 2 measures practices and advises; it cannot make "only this preset's
skills" true, and a worktree created by `worktree-first` is never removed —
Phase 2 itself left `../dsh-skill-presets-phase-2` behind after merge, and a
`node_modules` symlink inside it was committed and broke the main build for
one restart. Detectors are tested by unit fixtures but never against a whole
recorded session, so a regression in a fold shows up only in a live session.

## Outcome
- Strict mode hides non-preset skills from the model's catalog, not just
  denies them — via an in-tree `ctx.skills.restrict()` that mirrors
  `ctx.tools.restrict()`, with a documented guard-only fallback when the
  running harness lacks it.
- Worktrees have a lifecycle: the plugin knows which ones it (or the model)
  created, marks them mergeable/merged/stale, removes merged ones
  automatically (with the branch), refuses to remove dirty ones, and a
  `worktree-cleanup` skill teaches the model the same. Never symlink
  node_modules into a worktree.
- The same detectors are exportable as command hooks for BOTH shipped hook
  bridges; the plugin stays complete without either.
- Recorded sessions replay through the folds in `npm test`; a changed skill,
  practice, or preset re-runs them.

## Constraints
Provider-neutral. Out-of-tree first; the in-tree seam is a separate PR to the
harness and feature-detected. Nothing destructive without a dirty-tree check.
