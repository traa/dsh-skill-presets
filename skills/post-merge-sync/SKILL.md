---
name: post-merge-sync
description: Use when a pull request you opened has been merged, or when the guardrails say the checkout is behind its remote default branch. Brings the local checkout level before any further work — pull, install, build, sweep the merged worktree, verify — so later edits are not written against stale code.
when-to-use: The user says they merged; `gh pr view` shows MERGED; the "Sync after a merge" practice is red; you are about to start new work in a repo whose PR just landed.
---

# When a PR merges, sync before anything else

A merged PR means the local checkout is **behind**. Editing before syncing
writes changes against yesterday's code, rebases badly, and leaves the
running server serving the previous build. Two separate "the build finished
in 0.1 s" incidents in this project came from exactly this.

**This is a required sequence, not a suggestion.** The moment you learn a PR
merged — the user says so, or `gh pr view` reports `MERGED`, or the
guardrails block shows *Sync after a merge: red* — you do this before the
next edit.

## The sequence

One command does all of it in the plugin's own checkouts:

```sh
dsh-skill-presets sync              # this checkout
dsh-skill-presets sync <root>…      # specific checkouts
```

It performs, per checkout, and stops at the first failure:

| Step | Why |
|---|---|
| `git fetch origin` | See the merge |
| refuse unless the branch is the default one, clean, and fast-forwardable | Never touch work in progress |
| `git pull --ff-only` | Take the merge, never create one |
| `npm ci` | Lockfile changes come with merges |
| `npm run build` | `lib/` is what actually runs — source alone changes nothing |
| sweep merged worktrees | The branch is merged; its worktree is dead weight |
| report whether a restart is needed | The running server still holds the old build |

In a repo without that command, run the same steps by hand:

```sh
git fetch origin && git status          # confirm clean, on the default branch
git pull --ff-only
npm ci && npm run build                 # or the project's equivalent
git worktree list                       # remove the merged branch's worktree
```

## Then verify, then say what the human must do

- `dsh-skill-presets doctor` (or the project's check) — it reports a stale
  `lib/`, a symlinked `node_modules`, and **a server started before the last
  build**.
- The one step you cannot do: **the server restart**. Say it plainly, once,
  with the reason ("the running server still has the previous build"). Do not
  bury it in a paragraph, and do not claim the update is live before it.

## Rules

- Never `git pull` with a merge or a rebase here — `--ff-only`. If it refuses,
  the local branch has commits the remote lacks: stop and tell the user.
- Never sync a dirty checkout. Stop and report what is uncommitted.
- Never sync a checkout that is not on its default branch — that is someone's
  feature work.
- The `deepseek-harness` checkout is **read-only**: it only ever fast-forwards
  from upstream, and nothing here modifies it.
