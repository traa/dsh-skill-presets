# Intent — Phase 2: per-session presets and the stage loop

## Problem
Phase 1 exposes ONE global active preset. Two parallel sessions cannot use
different presets, and the user has to notice when the artifacts say the work
has moved to another stage. Editing outside the plan goes unnoticed. Comparing
two presets on the same task is manual.

## Outcome
- Each session can have its own preset; a workspace default (and an
  agent-preset mapping) seeds new sessions. Switching is per session, live.
- The header chip suggests the next stage when committed artifacts move ahead
  of the active preset; it never switches on its own.
- In Build, edits to files `plan.md` never names produce one advisory context
  line (plan-drift), never a block.
- A session can be forked under a different preset and the two scorecards
  compared side by side.

## Constraints
Provider-neutral (harness seams only). No restart to switch. Additive by
default. Session ids are not stable across host restarts — the default must
survive, per-session choices may not.

## Evidence
Phase 1 shipped and is in use; this session runs under the `build` preset it
produced. `provider.list(options)` already receives `scope`, so per-session is
a data change (verified in `packages/skill/skill/src/index.ts`).
