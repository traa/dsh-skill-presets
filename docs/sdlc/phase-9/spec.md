# Spec — Phase 9: "Open Skills tab" opens the Skills tab

Reads `intent.md`. Observable behaviour only.

## Behaviour

Clicking `Open Skills tab` in the stage popover:

1. Opens **this plugin's Skills tab** (kind `skills`) in the right sidebar of the
   current session, focused and visible, expanding the column in the same step.
2. Closes the popover.

Repeat clicks reveal the already-open tab rather than stacking duplicates — the
sidebar's page opens deduplicate within the target pane, so this needs no work,
but it is part of the accepted behaviour.

The button's label and position do not change.

## The call

`ctx.sidebarRight.openTab('skills')`, with no options: default placement is the
active docked pane, which is what "open my tab" means.

Two hard details, both verified in
`packages/client/ui-sidebar-right/src/client/service.ts`:

- **The argument is the kind, not the tab id.** `openTab` looks the kind up in
  the tab-type registry (`placeTab`, line 368). The plugin registers
  `kind = 'skills'`, `id = 'dsh-skill-presets'`. Passing the id throws.
- **`openTab` reveals the column itself.** The existing `layout.openRightbar`
  call becomes redundant on the success path and must not run as well — a second
  reveal is not harmful today, but it states an intent the sidebar already owns.

## Failure modes, and what each must do

`openTab` throws — it does not return a status. Three distinct ways, all
reachable from a click:

| Condition | Source | Required behaviour |
|---|---|---|
| `sidebarRight` not provided by the shell | `ctx.get` returns `undefined` | Fall back to `layout.openRightbar(true, false)` — today's behaviour |
| No tab type registered for `skills` | `placeTab` throws `no tab type is registered as "skills"` (line 369) | Fall back to `layout.openRightbar(true, false)` |
| No session surface mounted | `require()` throws `no session surface is mounted` (line 542) | Fall back to `layout.openRightbar(true, false)` |
| Neither service present | both `undefined` | Close the popover; do nothing else |

The second case is genuinely reachable: the tab type is registered only when
`sidebarRightTabs` is present (`index.ts:172`), while `sidebarRight` is a
*separate* service. A shell that provides one and not the other is a supported
shape — the existing test `without sidebarRightTabs the other five surfaces
still register` pins exactly that shape.

**No throw may escape the click handler** in any of these cases. The popover
closes on every path, including the failing ones.

## Acceptance criteria

1. `inject` is `['slots', 'sidebarRightTabs', 'layout', 'sidebarRight']` — the
   live page gives a plugin only what it declares.
2. With all services present, one click calls `openTab` exactly once with
   `'skills'`, and does **not** call `openRightbar`.
3. With `sidebarRight` absent, one click calls `openRightbar(true, false)` once.
4. With `openTab` throwing (either message), one click calls `openRightbar` once
   and the error does not propagate.
5. The popover is closed after the click in all four shapes above.
6. The browser stage exercises the real path: the stage shell provides a
   `sidebarRight` fake, and the phase-9 stage test asserts the Skills tab opened
   rather than asserting `rightbarOpened`.

## Non-goals

- Placement control (panes, splitting, floating) and navigation `params`.
- Any change to the tab body, the Guide card, or `src/host/**`.
- Removing `layout` from `inject` — it remains the degraded path.

## Risk the tests must carry

Phase 8's bug shipped through a green suite because both the unit `fakeCtx` and
the browser stage hand the plugin services regardless of `inject`. The unit
`fakeCtx` still does (`test/client.test.mjs:85` copies only names listed in
`inject`, but the stage's `services` table at `stage/shell.js:154` is read
through a `ctx.get` that records denied gets). Criterion 1 must therefore be
asserted against the `inject` array **literally**, not inferred from a mock that
answers anyway — which is what the existing `inject declares every service the
bundle reaches for` test does by scanning the built artifact for `ctx.get(...)`
calls. That test will catch a missing `sidebarRight` automatically once the call
site exists; it must be kept passing, not weakened.
