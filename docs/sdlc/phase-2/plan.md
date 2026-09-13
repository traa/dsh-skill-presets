# Plan — Phase 2: per-session presets and the stage loop

Branch `feat/phase-2` in worktree `../dsh-skill-presets-phase-2`. Ends with a PR.

## Task 1 — Per-session active document
Files: `src/host/types.ts` (ActiveDoc v2: `default`, `byAgentPreset`, `sessions`),
`src/host/store.ts` (`validateActive` migrates v1 `{preset}` → v2 `{default}`),
`src/host/service.ts` (`activeFor(sessionId, agentPreset)`, `activate(id, by, {sessionId?})`,
`setDefault`, `setForAgentPreset`, `pruneSessions(maxAgeDays=7)`),
`src/host/index.ts` (provider `setFor` and pre-step use the per-session resolution;
RPC `presets/activate {id, sessionId?, scope:'session'|'default'|'agent-preset'}`).
Tests: `test/active.test.mjs` — resolution order session → byAgentPreset → default;
v1 migration; pruning.

## Task 2 — Stage detection → suggestion
Files: `src/host/stage.ts` (pure fold `{ stage, confidence, why[] }` from GitFacts +
recent calls), `src/host/service.ts` (`suggestions.json`: dismiss counts per
transition per workspace; mute after 3), `src/host/index.ts` (scorecard carries
`suggestion`; RPC `suggestion/accept|dismiss`), telemetry events `suggested`,
`suggestion-accepted|dismissed`. Client: chip pulses with "Switch to build?" +
accept/dismiss.
Tests: `test/stage.test.mjs` — each transition; muted after 3 dismissals.

## Task 3 — Plan-drift watch
Files: `src/host/practices/plan.ts` (parse backticked/relative paths from plan.md,
glob-tolerant), `src/host/practices/detectors.ts` (`plan-drift` practice),
`src/host/index.ts` (`tools/post-execute` context-only listener: one injected line
per session when an edited path is not in the plan; never blocks; hard mode denies).
Tests: `test/plan-drift.test.mjs` — parse; first-offence-only injection; hard deny.

## Task 4 — A/B fork with a different preset
Files: `src/host/experiments.ts` (records `{ parent, child, preset, at }` in
`experiments.json`), `src/host/index.ts` (RPC `experiments/fork {sessionId, preset}`
→ `ctx.get('sessions')`/session-controller `fork`, then `sessions[child] = preset`
BEFORE its first step; `experiments/list`), client: sidebar **Compare** section.
Tests: `test/experiments.test.mjs` — record linking with a fake fork.

## Task 5 — Docs, examples, tests, PR
README Phase 2 section; `gen:examples`; `npm test` green; open PR against main.

## Riskiest step
Task 4: the fork seam. `@Remote('fork')` lives on the session controller; from a
host plugin the reachable face must be verified (`ctx.get('sessionController')` or
`ctx.sessions.fork`). If neither is reachable out-of-tree, ship the record +
Compare view with a documented "fork from the GUI, then pick the preset" path.

## Options rejected
- Symlink-materialised per-session directories: one `customSkillDirs` root cannot
  differ per agent.
- Auto-switching on detection: the playbook keeps humans at the gates.
