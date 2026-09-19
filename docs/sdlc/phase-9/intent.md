# Intent — Phase 9: "Open Skills tab" must open the Skills tab

Branch `fix/phase-9-skills-tab` in worktree `../dsh-skill-presets-phase-9`.
Follows Phase 8 (PR #26, merged as `62de8f7`).

## What the user said, verbatim

> "Open Skills tab" button opens empty right pane

## Problem

The popover's footer button `Open Skills tab` opens the right *column* and
nothing else. It does not select this plugin's Skills tab, so the user lands on
whatever the column last showed — for a session that never opened a right tab,
that is an empty pane. The button's own label promises the tab.

This is not a regression. It is Phase 8's explicitly deferred non-goal arriving
as a user-visible bug:

> Opening the *specific* Skills tab from the popover (needs
> `sidebarRight.openTab`, a different service); this round opens the right
> column.

Phase 8 fixed the neighbouring bug (the tab type never registered because
`sidebarRightTabs` was missing from `inject`), so the Skills card now exists on
the Guide page. That made this second half the only thing still standing between
the button and its promise.

## Evidence

- `src/client/controller.ts:767` — `openSkillsTab()` calls
  `this.layout?.openRightbar(true, false)` and closes the popover. Its own
  docstring states it opens the column, not the tab.
- `src/client/index.ts:65` — `inject = ['slots', 'sidebarRightTabs', 'layout']`.
  `sidebarRight` is absent, so `ctx.get('sidebarRight')` returns `undefined` on
  the live page even though the shell provides it. This is the same failure mode
  Phase 8 fixed for `sidebarRightTabs`; a client plugin receives only the
  services it declares.
- `src/client/index.ts:174-175` — the tab type is registered with
  `id = 'dsh-skill-presets'`, `kind = 'skills'`.
- Harness API (`packages/client/ui-sidebar-right/src/client/service.ts:170`):
  `openTab<K extends string>(kind: K, options?: SidebarRightOpenTabOptions<K>): void`
  — "Open a page type by kind: the type in force for it, at the address this
  package records pages under. A kind nothing registered throws." The column
  expands in the same step, so the existing `openRightbar` call becomes
  redundant on the success path.

## Expected outcome

Clicking `Open Skills tab` opens **this plugin's Skills tab**, focused and
visible, in one step — from a session with no right tab open, from a session
with a different tab open, and with the column collapsed. The popover still
closes behind it.

## Constraints

- `openTab` **throws** for an unregistered kind. The tab type registration is
  already conditional on `sidebarRightTabs` being present, so the call must be
  guarded and must not escape as an unhandled error from a click handler.
- Keep the degraded paths working: a shell without `sidebarRight` must still
  open the column via `layout` (today's behaviour), and a shell without either
  must still close the popover rather than throw. The button already renders in
  shells lacking these services.
- `openTab` takes the **kind** (`skills`), not the tab id (`dsh-skill-presets`).
  The two constants are different strings and the slot body is keyed by the id;
  passing the wrong one is the obvious defect to guard against.
- Unit `fakeCtx` and the browser stage hand the plugin services regardless of
  `inject` — the exact reason Phase 8's bug survived every test. A test that
  mocks the service proves nothing about the live page; the `inject` list needs
  asserting directly, as Phase 8's `inject` contract test does.
- No change to `src/host/**`.

## Non-goals

- Restoring or redesigning the right-sidebar Guide card (Phase 8 shipped it).
- Placement control — panes, splitting, floating. Default placement is right.
- Any other popover or settings surface.

## Who asked

The user, from the live page, this session.
