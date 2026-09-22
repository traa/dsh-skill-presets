# Intent — Phase 10: the conductor practice flags its own artifacts

Branch `fix/phase-10-conductor-artifacts` in worktree
`../dsh-skill-presets-phase-10`. Follows Phase 9 (PR #27, merged `c7d0076`).

## Problem

`detectConductor` reports **red** for a conductor that did nothing wrong. Every
`write` counts as "doing a teammate's job", including the stage artifacts the
conductor is *required* to produce — `intent.md`, `spec.md`, `plan.md` — and the
PR body. Through the whole of Phase 9, which was conducted correctly, the
scorecard read:

> Follow the conductor protocol [red]: conductor mutated files itself 10×

All ten were `docs/sdlc/**` writes or the PR body. No teammate owns that
directory; the SDLC skills instruct the conductor to write there.

## Evidence

- `src/host/practices/detectors.ts:1256` — `isConductorSelfMutation` opens with
  `if (isWriteTool(call.name)) return true`. Path-blind: the target is never
  consulted for a write tool.
- `src/host/practices/detectors.ts:1265-1267` — the function already carves out
  the conductor's *git* duties (commit, push, PR) with exactly this reasoning.
  Artifact authoring is the same class of duty and was missed.
- The remedy the practice prints is "load the `conductor-protocol` skill". In
  Phase 9 that skill was already loaded when the first red appeared. A detector
  that fires *after* the write, and prescribes a document the model has read,
  changes nothing.

## User ruling (2026-09-22)

> "I don't think this is a violation, let's capture this as an acceptable action
> for conductor"

Said of the conductor creating a worktree and branch before proposing the
roster. Recorded as durable knowledge; the same ruling covers artifact writes,
which are the conductor's own setup work.

## Expected outcome

1. A conductor that writes only `docs/sdlc/**` (and other artifact paths it
   owns) and delegates all code stays **green**.
2. A conductor that writes `src/**`, `test/**` or any teammate-owned file is
   still **red**, with no loss of sensitivity.
3. The distinction is by path, not by tool.

## Constraints

- `isConductorSelfMutation` is exported and used elsewhere; check every caller
  before changing its contract.
- The bash side already handles laundered writes (`sed -w`, redirects, VCS
  plumbing). A path exemption must not become a hole there: `bash sed -i` into
  `src/**` must still count, and an artifact-path exemption must not be
  reachable by a command that also writes elsewhere.
- Existing detector tests must keep passing; this is a sensitivity change to one
  predicate, not a rewrite.

## Non-goals

- Turning the practice into a blocking gate (raised, not chosen — a detector
  that only reports is still the design).
- Any change to the other practices or to the skills themselves.
- Re-scoring past sessions.
