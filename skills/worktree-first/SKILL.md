---
name: worktree-first
description: Before editing files in a git repository, work on a feature branch in a linked worktree — never on a protected branch (main, master, develop) in the primary checkout. Use before the first write or edit of any task in a repo.
when-to-use: About to change files; the practice scorecard shows "Work in a worktree" at risk; starting parallel pieces of work.
---

# Worktree first

Isolation is what lets several sessions work in parallel without stepping
on each other, and what keeps a protected branch clean until a reviewed PR
lands. The rule is simple: **edits happen on a feature branch inside a git
worktree.**

## Check before the first edit

```
git rev-parse --is-inside-work-tree     # true → a repo
git branch --show-current                # which branch
git rev-parse --git-dir --git-common-dir # equal → primary checkout; different → linked worktree
```

You are fine when **either** holds: the checkout is a linked worktree, or the
branch is not protected. You must act when both are false: primary checkout
AND a protected branch.

## Create the worktree

```
slug=<short-kebab-name>
type=<feat|fix|chore|docs|refactor>
git fetch origin --quiet
git worktree add ../$(basename "$PWD")-$slug -b $type/$slug origin/<default-branch>
```

Install dependencies **inside** the worktree (`npm ci`, or the project's
install command). **Never symlink `node_modules`** from the main checkout: the
link is a file, `.gitignore`'s `node_modules/` does not match it, `git add -A`
commits it, and on the main checkout it points at itself — every build then
exits 0 having done nothing.

Then **tell the user the absolute path** of the new worktree and that further
work happens there. If the harness cannot change its working directory for
this session, say so and ask the user to open a session in that path; do
not fall back to editing on the protected branch.

If a suitable feature branch already exists, `git worktree add ../<name>
<branch>` instead of creating another.

## While working

- Commit small and often on the feature branch; never `git push --force` to a
  shared branch.
- Keep the worktree clean at the end of the session: commit or stash, and say
  which.
- The `pr-always` skill covers how work ends: pushed branch, open PR.
- After the PR merges, the worktree goes: `worktree-cleanup` (or the plugin
  removes merged, clean worktrees automatically when the session ends).

## When the user says the rule does not apply

A one-line docs fix or a repository that is not shared may be exempt. Ask
once, record the answer in your reply, and continue. Do not silently assume
an exemption.
