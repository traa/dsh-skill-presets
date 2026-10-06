---
name: pr-review-against-plan
description: Review a pull request against its plan.md and spec.md — conformance, tests as evidence, risk hot spots, security and correctness — and write the findings into the PR as the record. Use when asked to review, when a PR is opened in this session, or in the Test & Review stage.
when-to-use: A PR URL or diff is in front of you; the user asks for a review; you are the reviewing teammate.
---

# Review a PR against its plan

Review is the stage where human attention concentrates on what the agent
flagged rather than on every line. Your job is to produce **findings with
evidence**, written into the PR, so the approval decision is quick and
recorded.

## Inputs

- The diff (`gh pr diff <n>` or the branch compare).
- `docs/sdlc/<slug>/plan.md` and `spec.md` if present; the PR body otherwise.
- The PR body, written to the `pr` skill's template (Summary, Evidence, Merge
  Danger). Rerun the tests named in Evidence if you can.

## Passes, in order

1. **Conformance** — does the diff do what `plan.md` says, and only that?
   List additions the plan never mentioned and plan items the diff skipped.
   A plan that was not updated for a deliberate departure is itself a
   finding.
2. **Behaviour** — does it meet `spec.md`'s acceptance criteria? Name the test
   that proves each criterion, or note the missing test.
3. **Risk hot spots** — auth, permissions, data migration, money, concurrency,
   external input, deletion. For each touched hot spot: what could go wrong,
   how the diff guards it, and whether a test covers the guard.
4. **Correctness and clarity** — error paths, boundary values, naming that
   misleads, dead code, duplicated logic.
5. **Security** — where attacker-controllable input enters and how it is
   validated; secrets; injection surfaces; dependency changes.

## Checking the PR body itself

The body is part of the diff under review. Check it against the `pr` skill:

- **Summary** shows the change as the smallest useful view (tree, diff-sketch,
  diagram) and agrees with the diff — not a prose recap.
- **Evidence** has a real before *and* after (output, test run, screenshot).
  Missing or "tests pass" with no before state is a should-fix.
- **Merge Danger** names the door (one-way / two-way) and a blast radius, and
  you agree with the call. A one-way door the author called two-way is a
  blocker; confirm it yourself from the diff (migrations, deletions, public
  API, published artifacts).

A body missing these sections goes back to the author before the code review
proceeds.

## Writing findings

For each finding: **severity** (blocker / should-fix / nit), **where**
(file:line), **what** and **why**, **evidence** (a test, a reproduction, a
spec line), and **a proposed fix**. Prove a blocker — a reviewer who cannot
show the failure has a hunch, not a finding.

Open with your agreement or disagreement with Merge Danger, then the
findings. Post them on the PR (`gh pr review --comment -b …` or the forge equivalent)
or, if you cannot, return them to the author verbatim and say they must land
in the PR.

## Verdict

End with one of: *approve* (no blockers; nits optional), *request changes*
(blockers listed), or *needs a second reviewer* (a disagreement or a hot
spot beyond your evidence). If a second reviewer with a different model or
vantage point is available, ask for it on risk-tier code — shared blind
spots are the failure mode this stage exists to catch.

You do not merge. The author fixes; a human approves.
