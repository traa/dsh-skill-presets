---
name: incident-to-intent
description: Turn a production problem into the next loop iteration — reproduce, root-cause, write the incident record, and produce a new intent.md plus updates to tests, runbooks, and the project's instructions file so the bug class does not recur. Use for alerts, regressions, and postmortems.
when-to-use: A bug or alert is reported; a control band was breached; the user asks for a postmortem or "why did this happen".
---

# From incident to intent

Maintain is where the loop closes: something deterministic detected a
problem, you diagnose it, and the outcome is **a committed record and a new
intent** that re-enters Plan. A fix without the record teaches the system
nothing.

## 1. Stabilise the facts

- What is observed, since when, how often, who is affected. Numbers, not
  adjectives.
- The narrowest reproduction you can run here (a failing test is ideal).
- Recent changes to the affected area: `git log --since=… -- <paths>`, the
  PRs merged, the deploys.

## 2. Root cause, not first cause

Follow the failure to the decision that made it possible, not the line that
threw. Ask "why" until the answer is a design choice, a missing test, a
missing guard, or a wrong assumption in `spec.md`. Write that sentence down.

## 3. The incident record

`docs/sdlc/incidents/<date>-<slug>.md`:

```
# <title>
Impact:      who / what / how long
Detection:   what noticed it (alert, user, test) and how late
Timeline:    key timestamps
Root cause:  one paragraph, the design-level answer
Fix:         what changed (link the PR) and how it was verified
Prevention:  tests added, guards added, docs/instructions updated
Follow-ups:  as new intents
```

Commit it on its own.

## 4. Close the loop

- **Test**: add the reproduction as a permanent test. Every incident adds one.
- **Guidance**: if the bug class is one the coding agent should avoid in
  future, write the rule into the project's instructions file (AGENTS.md or
  whatever the project uses) or into a skill — one sentence, with the
  incident as the reason. Propose the edit; the user commits it.
- **Intent**: write `docs/sdlc/<new-slug>/intent.md` for the structural fix
  or the follow-ups that did not fit the hotfix. This is what makes Maintain
  feed Plan.

## 5. Report

Impact, root cause, fix, prevention, and the new intents — five lines. Link
the record and the PR.
