---
name: worktree-cleanup
description: Remove linked git worktrees whose branch has merged and whose tree is clean — together with the branch — and never touch dirty, unmerged, locked, or detached ones. Use after a PR merges, when finishing a session, or when the practice scorecard flags worktree hygiene.
when-to-use: A PR you worked on was merged; the session is ending; `git worktree list` shows more than the primary checkout; the "Clean up worktrees" practice is amber or red.
---

# Worktree cleanup

`worktree-first` creates a worktree per piece of work. Left alone they pile
up, and a stale one is where mistakes hide — a `node_modules` symlink that
gets committed, a branch nobody remembers. The rule: **a worktree lives
exactly as long as its unmerged work.**

## Prefer the tool

If `sdlc_status`/`skill_preset_status` are available, the plugin already
scans worktrees; the session's Skills tab lists them with a verdict and a
**Remove** button, and merged ones are removed automatically when the
session ends. The CLI does the same:

```
dsh-skill-presets worktrees            # list with verdicts
dsh-skill-presets worktrees --dry-run  # what would go
dsh-skill-presets worktrees --clean    # remove merged + clean, delete branch, prune
```

## By hand

```
git worktree list --porcelain
```

For each linked worktree (not the first row):

1. **Dirty?** `git -C <path> status --porcelain` non-empty → **leave it**;
   tell the user what is uncommitted.
2. **Merged?** `git merge-base --is-ancestor <head> <default-branch>` succeeds,
   or `gh pr view <branch> --json state` says `MERGED` → removable.
3. **Own commits?** `git rev-list --count <default>..<head>` is `0` → removable
   (nothing would be lost).
4. Otherwise it has live work → **leave it** and say so.

Remove:

```
git worktree remove <path>        # refuses if dirty; never add --force for someone else's tree
git branch -d <branch>            # -d, not -D: it fails if anything is unmerged
git worktree prune
```

## Never

- Symlink `node_modules` into a worktree. Run `npm ci` (or the project's
  install) inside it. A symlink is a file; `.gitignore`'s `node_modules/`
  does not match it; `git add -A` commits it; on the main checkout it points
  at itself and every build silently does nothing.
- `git worktree remove --force` or `git branch -D` on a tree you did not
  create in this session.
- Remove the primary checkout or a locked worktree.

## Report

One line per worktree: removed (with branch), kept (why), needs attention (why).
