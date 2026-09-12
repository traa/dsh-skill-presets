---
name: pr-always
description: Finish work by pushing the feature branch and opening a pull request that links the intent, spec, and plan, states the test evidence, and names what a reviewer should check. Never merge. Use whenever a piece of work is about to be called done.
when-to-use: Tests are green and the change is complete; the user asks to "wrap up", "ship", or "finish"; the practice scorecard shows "Always open a PR" at risk.
---

# Always open a pull request

A pull request is the artifact that ends the Build stage and starts Test and
Review. It carries the change, its evidence, and the review findings, and it
is where a human — or a separate review agent — approves. **You never merge.**

## Before opening

1. `git status` — nothing uncommitted. Commit or explain what is left and why.
2. Tests you touched or that cover the change ran and passed in this session;
   keep the command and the summary line for the PR body.
3. `plan.md` (if one exists) matches what you did. If not, update it in the
   same branch.
4. You are on a feature branch (see `worktree-first`).

## Open it

Push, then create the PR with the forge CLI that is available:

```
git push -u origin HEAD
gh pr create --fill --title "<type>: <summary>" --body-file <body.md>   # GitHub
glab mr create --fill                                                   # GitLab
```

If no forge CLI is installed, push and give the user the compare URL the
remote prints, plus the body below, so they can open the PR themselves. Say
explicitly that the PR still needs to be created.

## The body

```
## Why
Link to docs/sdlc/<slug>/intent.md (or one paragraph if none).

## What
Link to spec.md / plan.md. Bullet the user-visible change.

## Evidence
- `<test command>` → <summary line>
- Manual checks performed, if any.

## Review focus
- The riskiest part and where it lives.
- Anything that departs from plan.md and why.

## Not in this PR
Deferred items, with reasons.
```

## After opening

- Paste the PR URL in your reply.
- If a team is attached, hand the PR to the reviewing teammate through
  `team_delegate`; if not, the `pr-review-against-plan` skill describes the
  review a second agent or the user performs.
- Stop. Approval and merge are the user's.
