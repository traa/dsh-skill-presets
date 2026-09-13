# Plan — Phase 5

Branch `feat/phase-5`, worktree `../dsh-skill-presets-phase-5` (npm ci).

## Task 1 — doctor
`src/host/doctor.ts`: pure `diagnose(input) → Finding[]` (`ok|warn|fail`, id, message,
fix). Probes (all injectable): lib newer than src (mtime compare of newest src vs
newest lib; missing lib modules for every src module), `node_modules` lstat is a
symlink, `require.resolve('<pkg>/package.json')` from the profile dir
(`$DSH_HOME/profiles/<name>`), server start time vs lib mtime (from
`ps -o lstart -p <pid>` for `pnpm dsh web` / a `serverStartedAt` the host records at
apply), `skills.restrict` seam, `agentTeams` present, profile `cordis.patch.yml`
still has `skill-filesystem` enabled, every store JSON parses, `runEvals` green.
CLI `doctor [--profile web] [--json]` (exit 1 on any fail); RPC `doctor`; a banner on
the Skills page and the plugin card when any `fail`. Tests: probes stubbed, each
finding path.

## Task 2 — impact fold
`src/host/impact.ts`: from `SessionSummary[]` + practices: per skill `{ with, without }`
groups → `{ sessions, greenRate, prRate, meanTurnsToPr, drift, denied, rating }`
and a delta; per preset the same vs all other presets; per current session vs the
last N under the same preset. RPC `impact/report`, `impact/session`. Insights
"Impact" table (delta bars); sidebar "vs your last 20 under Build". Tests: fold
arithmetic incl. small-sample guards (n < 5 → "not enough data").

## Task 3 — experiments aggregation
`src/host/experiments.ts` `aggregate(experiments, summaries)` → per pair the two
cards + verdict (which side had more green / PR / fewer denials), per preset-pair
totals. RPC `experiments/aggregate`; Insights "Experiments" table. Tests.

## Task 4 — skill lint
`src/host/lint.ts`: rules over parsed SKILL.md: vendor terms (word list beyond the
normalize rules), description without a trigger ("Use when"/"when"), no
`when-to-use`, body > 300 lines, missing `name`/`description`, non-kebab name;
plus usage-based: offered ≥ 30 sessions, never loaded. `lintLibrary(lock, paths,
rollup) → Record<ref, LintFinding[]>`. Runs after `library.sync`, in
`test/lint.test.mjs` for `skills/` (must be clean), Library badge + drawer list, CLI
`lint [ref]`. Tests: each rule; shipped local skills lint clean.

## Task 5 — placement suggestions
`src/host/placement.ts`: score a skill (name + description + when-to-use) against
each preset's stage keywords (reuse `skill_preset_suggest`'s table) → top 2 presets
with reasons. Used by `knowledge/promote` (returns `suggestedPresets`), the Promote
notice ("add to Plan?" one-click via `pruning/add`), and the Stages tab's "orphan
skills" strip (installed, in no preset). Tests: scoring, orphan list.

## Task 6 — why trace
Telemetry `loaded` gains `userLine` (first 120 chars of the turn's first user
message, from `agent/pre-step` messages with `source.kind === 'user'`) and
`mentioned` (whether the guardrails block named the skill that step). Sidebar: each
load expands to turn, user line, mentioned, practices before → after (from the
`practice` events around it). Tests: summary carries the fields; view renders.

## Task 7 — README, PR, cleanup.

## Departures (recorded during execution)
- Task 1: two false positives on first run, both fixed and encoded as tests — the
  legacy-row regex matched only the id line (now parses the row body), and server
  age was judged from a worktree the profile does not serve (now skipped when
  `probedRoot ≠ profileResolvedTo`).
- Task 4: lint on the real library found 12 vendor-term errors; two normalize rules
  were added (`ask-user-tool`, `cross-model-vendors`). Vendor terms are matched with a
  left word boundary so "autocopilot" is not a hit.
- Task 6: the "mentioned" signal reads the rendered guardrails text the host already
  caches per session; no extra prompt inspection.

## Riskiest step
Task 1's "server older than build": `ps` parsing is platform-specific; record
`serverStartedAt` in the host at apply and expose it via RPC, use `ps` only in the
CLI as a fallback, and mark the probe `warn` (not `fail`) when neither is available.
