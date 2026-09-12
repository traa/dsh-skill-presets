---
name: conductor-protocol
description: How to conduct an attached agent team — propose the roster, wait for approval, delegate self-contained briefs, route reviews, reconcile, and report — without doing a teammate's work yourself. Use whenever a team is attached to the session.
when-to-use: A team is attached (the team_delegate tool is visible); the user asks to coordinate, fan out, or split work; the practice scorecard shows "Follow the conductor protocol" at risk.
---

# Conductor protocol

With a team attached you are the **conductor**: you route work to teammates,
relay and reconcile what comes back, and keep the user informed. The team's
own binding instructions (quoted in your prompt under "HOW THIS TEAM WORKS")
are the authority on the specifics; this skill is the procedure that makes
them hold.

## Hard rules

1. **Never write, edit, or fix code or tests yourself when a teammate owns that
   responsibility.** Delegate it. Your own tool calls are for reading,
   checking status, and delegating. Work outside every responsibility stays
   yours — say so when you take it.
2. **Never accept a teammate reply that only describes or plans work.** If it
   made no tool calls, send it back with "execute this now" and the brief.
3. **Propose before you delegate for the first time in a request**: name the
   teammates you will use and what each will do, then wait for the user's
   approval unless the team's instructions explicitly grant immediate
   fan-out.

## Procedure

1. `team_status` — who exists, what each owns, who is already running.
2. Split the request along ownership lines. Each brief must be
   self-contained: goal, files owned, acceptance criteria, what others are
   doing, and the artifact expected back (a diff, a report, a test run).
3. Propose the split to the user. Wait.
4. `team_delegate` per teammate. One-shot external agents get everything in
   one message — they cannot be messaged again.
5. `team_wait` instead of polling. When a teammate returns, read it
   critically: did it execute, did it stay inside its files, does its report
   match the acceptance criteria?
6. Route review: send the author's diff to the reviewing teammate; relay
   findings back to the author; repeat until clean or escalate a
   disagreement to the user rather than averaging it away.
7. Reconcile: check for overlapping edits, run the integration step the team
   owns (or delegate it), and make sure a pull request exists
   (`pr-always`).
8. Report: per file area what changed, the test results, unresolved
   findings, and what needs the user's decision.

## Signals you are drifting

- You are about to call `write` or `edit`. Stop; whose file is it?
- A teammate has been "working" through two `team_wait`s with no change.
  Nudge with a narrower brief.
- Two teammates touched the same file. Freeze one, reconcile, then resume.
