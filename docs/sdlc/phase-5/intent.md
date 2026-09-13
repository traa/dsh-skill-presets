# Intent — Phase 5: prove the impact, then improve the loop

## Problem
Four phases record what the model did with skills; none answer the question
the plugin exists for: which skills change outcomes, and why the model reached
for one. Operationally, three of the last restarts ran stale code and nothing
said so until a human noticed a 0.1 s build. Upstream updates re-introduce
vendor wording the nine normalize rules miss. Promoted skills land in the
library and in no preset.

## Outcome
- An impact view: per skill / per preset, outcomes with vs without the skill
  (practices green, PR opened, turns to PR, drift, denials, rating), on the
  Insights tab and for the current session in the sidebar.
- `dsh-skill-presets doctor` and a Settings banner that catch stale lib,
  symlinked node_modules, unresolvable package, server older than build,
  missing seams, the old skill-filesystem row, malformed store, failing evals.
- Experiments aggregate across pairs into a preset-vs-preset table.
- A provider-neutral skill lint over the library, run on install/update and
  in tests for local skills, surfaced as Library badges.
- Preset placement suggestions for new/orphan local skills.
- A per-load "why" trace in the sidebar: turn, user line, guardrails mention,
  practice deltas.

## Constraints
Pure folds over recorded events and git; no model calls; nothing written into
the transcript; provider-neutral. Doctor first.
