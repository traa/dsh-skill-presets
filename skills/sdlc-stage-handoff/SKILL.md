---
name: sdlc-stage-handoff
description: Detect which SDLC stage the work is in from committed artifacts and end each stage by committing the artifact the next stage reads (intent.md → spec.md → plan.md → PR). Use at the start of any non-trivial task and whenever a stage is about to end.
when-to-use: Starting work on a feature, fix, or refactor; unsure whether to plan, design, or build; about to say "done" for a stage.
---

# SDLC stage handoff

The lifecycle is a loop of six stages — Plan, Design, Build, Test, Deploy,
Maintain — and every stage ends by **committing an artifact** that the next
stage begins by reading. The chain of commits is the audit trail: who asked
for what, what was produced, who approved it. Work that does not leave an
artifact behind is invisible to the next session and to reviewers.

## Detect the stage first

Run `sdlc_status` (a tool) if it is available; otherwise look for these files
under `docs/sdlc/<slug>/` (preferred) or the repository root:

| Present | You are in | Next artifact |
|---|---|---|
| nothing | Plan | `intent.md` |
| `intent.md` | Design | `spec.md`, then `plan.md` |
| `spec.md` + `plan.md` | Build | the diff + tests, then a pull request |
| an open PR | Test / Review | review findings written into the PR |
| PR merged | Deploy | deployment evidence in the PR or release notes |
| an incident record | Maintain | a new `intent.md` |

If the active skill preset does not match the stage you detected, **tell the
user** which stage the artifacts say you are in and ask whether to switch
presets. Do not switch on your own.

## What each artifact must contain

**`intent.md`** — the problem in one paragraph; the expected outcome; the
constraints (time, compatibility, security, cost); the evidence (links, logs,
tickets, numbers); who asked. Short. A product owner and an agent can both
read it.

**`spec.md`** — what will exist when this is done, as observable behaviour:
interfaces, data, error cases, non-goals, acceptance criteria. Policies the
project applies (security, UX, compliance) shape it. No implementation
detail beyond what constrains behaviour.

**`plan.md`** — for an engineer who has never seen the conversation: the
files that change and why, the order of work, the tests that prove each
step, the riskiest step, and the options rejected. Small, verifiable tasks.
The PR review will check the diff against this file, so when the
implementation departs from the plan, update `plan.md` in the same commit.

## Ending a stage

1. Write the artifact into `docs/sdlc/<slug>/` (create the folder; `<slug>` is
   a short kebab-case name for the piece of work). Keep the user's preferred
   location if they have one.
2. Commit it on its own with a message that names the stage:
   `docs(sdlc): <slug> intent` / `… spec` / `… plan`.
3. Say plainly which stage just ended and what the next one reads.

## Do not

- Skip from an idea straight to code. If there is no `plan.md`, write one
  (or ask whether the change is small enough that the user waives it).
- Merge anything. Build ends with a pull request, not a merge.
- Put artifacts in a vendor-specific location; `docs/sdlc/` is the neutral home.
