# Intent — Phase 7: make the workflow fit how people actually work

Branch `feat/phase-7` in worktree `../dsh-skill-presets-phase-7`.

## The problem, in the user's words

> It doesn't truly allow people to properly use the skills at every specific
> stage where they are needed. There is no way to set the initial stage when
> starting a session. The stages are error-prone: not every project needs the
> same flow. The attempt to guess the stage is probably a nice touch, but I'm
> not sure how useful it is. The health assessment needs a UI revamp and more
> thinking so it doesn't distract with false positives or too-opinionated
> advice. I don't think the dropdown you built is actually working. You should
> build something that allows you to test the UI on a staging environment.
> More importantly, it doesn't click with the user.

## What we verified before writing this

**The dropdown.** `makeHeaderChip` renders the popover as a child `div` of the
chip with `position: relative` on the wrapper (`views.ts:880-894`). The header
is a clipped flex row; a child popover is cut by the header's overflow and
stacks under the conversation. Impeccable's operate-mode rule names this
failure exactly: *"Overlays escape their container… reach for `<dialog>`, the
popover API, `position: fixed`, or a portal."* The shell offers
`shell.overlay` (a root-scoped frame-wide floating layer) for precisely this.

**Testing.** `test/client.test.mjs` drives the bundle with a fake `React` whose
`createElement` records trees and whose `useEffect` is replayed by hand. It
proves registration and text; it cannot prove that a popover is visible, that
an outside click closes it, or that a `pointerdown` listener on `document`
fires. No browser, no DOM, no screenshot. That is why the dropdown could ship
broken with 196 green tests.

**False positives, observed live during this session.** Read-only `grep`/`ls`
commands run with `workdir` inside another repository were reported as *"2
file mutations that cannot be placed in …"* and turned *Work in a worktree*
amber. Ten minutes later the plugin's own hourly sweep deleted the fresh
worktree this phase was started in, because "0 commits ahead of main" is
treated as "merged" (`practices/worktrees.ts:63`). Both are the kind of
over-confident advice the user is complaining about.

**The stage guesser.** `stage.ts` folds artifacts and commands into a stage
with a confidence; the chip pulses when ≥ 0.7. Under the research below this is
solving the wrong problem: the decision "which stage am I in" is a human's, made
once at the start and rarely mid-session.

## What the research says (four sources, four subagents)

| Source | What it says about our assumptions |
|---|---|
| **Anthropic, AI-native SDLC playbook** | Stage movement is a *human accepting an artifact*: "A stage ends by committing an artifact… A human team mate always makes this call." No stage detection exists in the playbook. Small work skips upstream: "A small, well-bounded fix arrives as a PR through the review gate, and anything larger is written up as intent.md." Build's prerequisite is the intent artifact "*if one exists*." Guardrails: "A skill is a control, though an advisory one… a policy that must always hold needs something deterministic behind the skill." Noise: "at most five nits per review"; "Dismissals tune the bands and help to reduce noise." |
| **Google, *The New SDLC with Vibe Coding* (Day 1, the attached PDF)** | Rigor is chosen per task, not imposed: "The right position on this spectrum depends on the stakes… the skill is knowing where to draw the line for each task." "Make the boundary explicit: which projects, which branches, which environments warrant which mode of working." Skills load "when a task matches" — by relevance, not lifecycle phase. "Most agent failures, examined honestly, are configuration failures." Phase "boundaries blur"; teams "go directly from specs to review." |
| **DORA 2025 / Gemini Code Assist** | No prescribed phases — capabilities: small batches, strong version control, "make work and bottlenecks visible." Gates are plan approval and per-tool approval, inline in chat. No stage dashboard anywhere. |
| **Impeccable + how tools ship "mode"** | Every shipping tool (Claude Code, Cursor, Gemini Code Assist) puts *one explicit mode toggle at the prompt input* — `Shift+Tab` cycles, a one-line status, a dropdown in the composer — and "stage" is really permission scope. Cursor *suggests* plan mode from keywords but never switches. Superpowers triages work into **spike / bounded / architectural** and announces it so the user can override. Impeccable's menu rule: "lead with the 2-3 highest-value next commands… **Never auto-run a command; the recommendation is a suggestion the user confirms.**" Reporting: "Too many P3 issues creates noise… If everything is important, nothing is." Operate mode: ≤ 4 visible options per decision point; one primary action; "The tool should disappear into the task." |

Nobody surfaces a health scorecard. Everybody surfaces *what is blocked and why*,
and *what the next artifact/gate is*.

## Intent

1. **Choosing the flow is explicit and happens where the user already is.**
   A *flow* is an ordered subset of stages a piece of work will pass through
   (`Full`: Plan → Design → Build → Review → Ship; `Build only`; `Fix`: Build →
   Review; `Explore`: no guardrails; custom). The user picks the flow **when
   creating the session** (the hero, beside the agent preset) and can change
   the *current stage within the flow* from **one control in the composer tool
   row**, next to the model and plan controls, where every other tool puts its
   mode toggle. The header chip goes away.

2. **Stages are steps in the chosen flow, not a global sequence.** Advancing is
   a human act — "Move to Review" — and the stage the user picks is the stage.
   The guesser becomes a *one-line suggestion in the same control* ("plan.md
   is present — start in Build?") that appears only at session start and after
   a stage's artifact is committed, and never pulses.

3. **Health is a gate report, not a dashboard.** Nothing renders while all is
   well. A practice surfaces only when it is red *and* the current stage cares
   about it, as one line with the evidence and the single action that fixes it;
   amber is reserved for facts we could not read, and reads as "unknown", never
   as a warning. Every detector must be able to say *"I cannot tell"* instead
   of guessing. Dismissing a line mutes it for that session; three dismissals
   mute it for the workspace (the playbook's "dismissals tune the bands").

4. **The plugin never destroys work.** The sweep does not touch a worktree
   younger than its grace period or with zero commits; auto-clean is off by
   default and the manual path is the primary one.

5. **Every UI change is verified in a browser before it is claimed done.** A
   staging harness (`stage/`) mounts the real built client bundle into a
   fake shell that exposes the same slots (`shell.overlay`,
   `conversation.input.right`, `conversation.hero.agentPreset`,
   `sidebar.right.pane.tab`, `settings.section`) over a scripted RPC, with
   Playwright tests that click, screenshot, and assert visibility. The
   deliverable of a UI slice is a passing Playwright test plus a screenshot
   in the PR.

## Non-goals

- Removing the library, lint, evals, insights, teams, or experiments. They
  move out of the daily path (Settings) but stay.
- Changing what a skill *is* or how the model loads one.
- Any harness change. Every seam used already exists in the slot tree.

## Success

- A new session can start in `Fix` and be in `Build` with `plan.md` optional,
  with nothing on screen but the stage control.
- The popover opens above everything, closes on outside click and Escape, and
  a Playwright test proves it.
- Zero amber lines from read-only commands; zero worktree deletions of work
  that was never merged.
- The scorecard's *at-risk* block appears in the model prompt only for red,
  stage-relevant practices.
