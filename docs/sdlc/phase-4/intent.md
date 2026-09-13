# Intent — Phase 4: close the loop with teams and knowledge

## Problem
Team attachment is detected by tool visibility (a proxy). Teams that follow
the SDLC practices must be hand-built. Knowledge captured by dsh-knowledge
(workflow rules, conventions) stays as insights and never becomes a skill the
model reaches for. Presets accumulate skills nobody loads, and nobody notices.
A good preset cannot be shared with another workbench.

## Outcome
- dsh-agent-teams publishes `ctx.agentTeams`; this plugin prefers it, and the
  conductor practice reads the team's own instructions to decide whether the
  approval-turn rule applies.
- Two SDLC team templates (build team, review board) whose conductor
  instructions name `conductor-protocol`, `worktree-first`, `pr-always`;
  members inherit the session's provider unless pinned. One click attaches.
- A knowledge insight with confidence ≥ 2 and kind workflow/convention can be
  promoted to a local skill with a deterministic template (no model call);
  the link is recorded both ways.
- Stale-skill pruning: a skill offered in ≥ 20 sessions of a preset with a
  load rate < 10 % is flagged on the stage card ("remove from build?");
  requested-but-missing ≥ 3× is flagged ("add x?").
- Presets export to one JSON bundle (presets + overlay refs + pinned lock
  entries) and import with collision reporting; a drop target on the Stages tab.

## Constraints
Provider-neutral; read dsh-knowledge's store read-only; every cross-plugin
seam feature-detected with the Phase-1 fallback kept.
