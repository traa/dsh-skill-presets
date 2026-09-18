# Intent — Phase 8: what the user can *see*

Branch `feat/phase-8` in worktree `../dsh-skill-presets-phase-8`. Follows Phase 7
(PR #22, #24). Driven by the user's first look at the live page.

## What the user said, verbatim

> **Green → invisible** — it should be visible, otherwise it's hard to understand
> what will be checked and you only know about that when it's too late.

> **"Skills in play" will switch** — I do not see this functionality, where is
> that? I think we actually missing the list of skills applicable every round.

> UI bug when something with more than 4-5 letters selected [screenshot: the
> composer row with the team chip on the left and our pill on the right].

> A design seems like not following dsh tokens (like dsh-agent-teams for
> instance).

> **What ends the stage** — we need to be able to properly display this to a
> user, like what ends the stage because it's not obvious and important.

> **Right sidebar → Skills tab** — where is that? I do not see it. [screenshot
> of the Guide page: Workspace files, New terminal, Browser — no Skills card]

## What we found

1. **The Skills tab has never been reachable on the live page.** `export const
   inject = ['slots']` omits `sidebarRightTabs`; Cordis gives a client plugin
   only the services it declares, so `ctx.get('sidebarRightTabs')` is
   `undefined` on the real page and the tab type is never registered. Both the
   unit test's `fakeCtx` and the browser stage hand the plugin the service
   regardless of `inject`, so neither could catch it. Every phase since the tab
   was added shipped with this.
2. **Skills in play** is in the prompt block the *model* receives and switched
   correctly when the user moved to Review — but no UI shows it. The Phase 7 spec
   had the line; the CSS class was written and the element never rendered.
3. **Green hidden** was the wrong reading of "no dashboard". The user's point:
   the contract must be visible before it fires.
4. **The pill's chrome is wrong, not its tokens.** It used `--dsw-alias-*`
   correctly but as a bordered, filled box with its own swatch. The shipped
   composer chips (model, permission) and dsh-agent-teams' `TEAM … 4 agents ⌄`
   are borderless text, radius 24, caption-tone chevron, `min-width: 0` +
   ellipsis — dsh-agent-teams' CSS literally says *"Matches the shipped composer
   chips … exactly"*. Same root cause for "clipped" and "not dsh".
5. **The gate** — the most important line — was small grey text at the bottom.

## Decisions (user, 2026-09-18)

- Practice visibility: the **full list** of stage-relevant practices with status,
  in popover and sidebar; irrelevant ones collapsed; unknowns muted.
- Pill label: **just the stage** (`Review`); the gate is the popover's first line.

## Non-goals

- Opening the *specific* Skills tab from the popover (needs `sidebarRight.openTab`,
  a different service); this round opens the right column.
- Anything in `src/host/**` beyond sending `skills`/`artifacts`/`pr` on the
  position card — deferred if the client can read them from the scorecard.
