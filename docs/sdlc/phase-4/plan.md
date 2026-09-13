# Plan — Phase 4: teams and knowledge

Branch `feat/phase-4`, worktree `../dsh-skill-presets-phase-4` (npm ci).

## Task 1 — `ctx.agentTeams` service (dsh-agent-teams, separate PR) + consumer
dsh-agent-teams `src/host/index.ts`: `ctx.provide('agentTeams', { attachment(sessionId),
teamFor(sessionId), onAttachmentChange(cb) })` fed by the existing attach/detach/recover
paths. Plugin: `src/host/teams.ts` prefers the service, falls back to `team_delegate`
visibility; `detectConductor` gets `approvalRequired` derived from the team's
`conductorInstructions` (regex on "approval|approve|wait for" + "before delegat").
Tests: consumer with a fake service; detector with approvalRequired false.

## Task 2 — SDLC team templates
`templates/teams/sdlc-build-team.json`, `sdlc-review-board.json` in the agent-teams
blueprint format (id, name, objective, members[{id,name,responsibility,engine:'dsh',
context, autoStart, reviews?}], conductorInstructions). RPC `teams/templates`,
`teams/attach-template {sessionId, templateId}` → agent-teams RPC `teams.save` then
`mode.attach` (HTTP to `/plugins/dsh-agent-teams/rpc/...`, feature-detected). Stages
tab: "Attach the build team" on Build, "Attach the review board" on Test & Review.
Test: templates validate against the blueprint field list.

## Task 3 — Promote a knowledge insight to a skill
`src/host/knowledge.ts`: read `<workbench>/knowledge/global.json` and
`<workbench>/projects/<key>/knowledge.json` (read-only), list candidates
(confidence ≥ 2, kind ∈ {workflow, convention}, not retired/superseded, not yet
promoted), `promote(id)` writes `library/local/<kebab>/SKILL.md` from a
deterministic template, re-indexes local, records `promotedFrom` in lock and appends
to `promotions.json`. RPC `knowledge/candidates|promote`; Insights card. Local skill
`writing-skills-from-insights`. Tests: template output, idempotency, filter.

## Task 4 — Stale-skill pruning + missing-skill hints
`src/host/pruning.ts`: pure fold over the rollup + presets → `{ stale: [{preset, skill,
offered, rate}], missing: [{name, count, sources?}] }`; thresholds in practices.json
(`pruning: { minSessions: 20, maxLoadRate: 0.1, minUnknown: 3 }`). RPC `pruning/report`,
`pruning/remove {preset, ref}`; Stages card shows "remove from build?" chips; Insights
"add x?" with a search across sources' discovered dirs. Tests: fold thresholds.

## Task 5 — Preset export / import
`src/host/bundle.ts`: `exportBundle(ids)` → `{ version, presets, overlays?, lock: pinned
entries, sources }`; `importBundle(bundle, { rename? })` → resolves sources (adds
missing ones disabled), reports collisions (id exists, exposed-name clash), installs
missing skills via the library, writes presets. RPC + CLI `export`/`import`; drop
target on the Stages tab. Tests: round-trip, collision report.

## Task 6 — Docs, PR, cleanup via `worktrees --clean`.

## Riskiest step
Task 2's cross-plugin RPC: agent-teams' handlers require an agent (`rpc.requireAgent`);
attaching from our page needs the session id passed as agent-teams expects. Verify its
`mode.attach` argument shape before wiring; fall back to "open Agent Teams panel" copy.
