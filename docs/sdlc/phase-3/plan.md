# Plan — Phase 3: hard guardrails, worktree lifecycle, evals

Branch `feat/phase-3`, worktree `../dsh-skill-presets-phase-3` (npm ci, no symlink).

## Task 1 — Worktree lifecycle (first: it is what bit us)
Files: `src/host/practices/worktrees.ts` (list `git worktree list --porcelain`;
per worktree: branch, upstream, dirty, merged into default (`git branch --merged
origin/<default>` or `gh pr view --json state`), ageDays, `createdBy: 'session'|'unknown'`);
`worktrees.json` in the store records worktrees the model created (observed
`git worktree add` in bash results) with the session id; `cleanup({dryRun})`
removes worktrees whose branch is merged AND tree is clean, then deletes the
branch, then `git worktree prune`; refuses dirty/unmerged with a reason;
`autoClean` setting (default on) runs cleanup on `agent/disposed` for the
session's repo and once an hour; RPC `worktrees/list|cleanup`; CLI `worktrees
[--clean] [--dry-run]`; sidebar section "Worktrees" with Remove per row; new
practice `worktree-hygiene` (amber when ≥ 1 merged-but-present worktree or a
node_modules symlink inside one); local skill `worktree-cleanup`; update
`worktree-first` to say `npm ci` in the worktree, never a node_modules symlink.
Tests: `test/worktrees.test.mjs` on a real temp repo with two worktrees.

## Task 2 — Strict catalog
In-tree (separate PR, DSH checkout): `ctx.skills.restrict({ allow?, deny? })` in
`packages/skill/skill/src/index.ts` — scoped ctx only, restrictions appended to
the scope's `SkillLayer`, applied in `collectFresh()` to entries from global/
ancestor layers (own layer exempt), unknown names allowed + logged once,
`skills/change` emitted, docs regenerated. Plugin: feature-detect
`typeof agent.ctx.skills?.restrict === 'function'`; on `agent/created` when
`strictSkills`, `restrict({ allow: names })` and re-apply on switch/overlay
flip (dispose + re-register); keep the `skill` pre-execute guard; chip shows a
lock; Practices tab explains guard-only when the seam is absent.
Tests: in-tree spec mirroring the tools restriction tests; plugin
`test/strict.test.mjs` with a fake scoped ctx.

## Task 3 — Hooks export (optional convenience)
`src/host/hooks.ts` writes `<workbench>/hooks/skill-presets.claude-code.json`
and `skill-presets.codex.json` from one declaration: PreToolUse (worktree,
conductor, plan-before-code, plan-drift when hard) and Stop (pull-request)
command hooks that call `dsh-skill-presets check <practice> --json --cwd`.
CLI `check <practice>` replays the detector against live git facts and exits
2 on red. Test: generated files parse under both bridges' config shape.

## Task 4 — Replay evals
`evals/fixtures/<name>/events.jsonl` + `facts.json` + `expected.json`.
`src/host/evals.ts`: replay events through `PracticeTracker` with a stubbed
git runner, compare final practice statuses + loaded skills + stage guess.
CLI `eval [--update]`; `npm test` includes `test/evals.test.mjs`; RPC
`evals/save {sessionId}` writes a redacted fixture; Insights gets "Save as
fixture". Ship 3 fixtures recorded from this and earlier sessions.

## Task 5 — Docs, PR, cleanup
README Phase 3; plan.md departures; `npm test`; PR; remove THIS worktree via
the new cleanup after merge.

## Riskiest step
Task 2's in-tree change: `collectFresh` caches by scope chain + revision;
restrictions must bump the revision so a restrict/unrestrict invalidates.

## Options rejected
- Materialising strict mode by rewriting the catalog message: breaks
  tool-skill's digest comparison (re-emits every step).
- Cleaning worktrees on a timer only: misses the moment that matters
  (session end); on-dispose + hourly covers both.
