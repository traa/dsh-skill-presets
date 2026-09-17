# Intent — Phase 6: make the worktree practice actually prevent the edit

## Problem
The plugin's flagship practice does not work. In a live session under the
`build` preset, with the `git-repo` overlay active and both `worktree-first`
and `using-git-worktrees` in the catalog, the model edited on `main` in the
primary checkout and nothing stopped it. Three independent causes, each
sufficient on its own:

1. **Advisory by default.** `defaultPractices()` ships every practice with
   `mode: 'advisory'`, and the hard gate in `tools/pre-execute` is wrapped in
   `hard.has('worktree')`. With no `practices.json` written, the defaults are
   live and the gate is dead code for every fresh install. The plugin ships
   with its own enforcement off.

2. **The detector is retroactive.** `detectWorktree` returns `n/a — no file
   mutations yet` until a mutating call has already been observed. The
   scorecard therefore reads `n/a` — indistinguishable from "fine" — while the
   session sits on a protected branch one keystroke from the violation, and
   only turns red after the damage. A practice that can only report the past
   cannot prevent the future.

3. **Two gate paths disagree.** The CLI hook path (`check <practice> --hook`)
   synthesises the pending tool call as a mutating call and runs the detector
   against it, so it blocks correctly BEFORE the write. The native
   `tools/pre-execute` gate reads the retroactive tracker verdict instead. The
   primary mechanism is the weaker of the two, and the correct construction
   already exists in the repo.

A fourth issue is presentation, not mechanism: `n/a` is rendered the same
whether the practice is satisfied, inapplicable, or simply has no evidence
yet. "Not judged" and "nothing wrong" must not look alike.

## Outcome
- `worktree` defaults to `hard`, and a fresh install refuses the first
  mutating call on a protected branch in the primary checkout, naming the
  skill and the exact `git worktree add` to run.
- Both gate paths answer from ONE pure decision function over git facts plus
  the pending call, so the CLI hook and the native gate cannot diverge again.
- The gate fires on the pending call, before any mutation exists — no
  dependency on a prior observed mutation.
- Subagents and teammates inherit the gate unchanged (they already do: the
  gate is per-session and children inherit the parent's cwd). Phase 6 adds
  the regression test that proves it, and does NOT give each agent its own
  worktree — the worktree is per unit of work, shared by the whole fan-out.
- The scorecard distinguishes "not judged yet" from "satisfied", so a session
  cannot read a pre-violation `n/a` as safe.
- An escape hatch that is explicit and recorded: a documented exemption for a
  repo or a session, because a gate with no legitimate override gets disabled
  wholesale the first time it is wrong.

## Constraints
Provider-neutral; pure functions over injected git facts; no model calls. The
default flip is a behaviour change for existing installs — an existing
`practices.json` keeps its current modes, and only absent config picks up the
new default. Advisory must remain fully functional for users who want it.

## Evidence
Verified in this session: no `practices.json` exists under
`/Users/andriistepikov/.dsh/settings-repo`, so `defaultPractices()` is live;
`skill_preset_status` reported `Work in a worktree: n/a — no file mutations
yet` while on `main` in the primary checkout; the deny branch at
`src/host/index.ts` reads only git facts and would have fired correctly had
the mode been `hard`; `src/bin/cli.ts` already models the pending call.
