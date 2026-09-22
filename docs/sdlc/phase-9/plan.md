# Plan — Phase 9

Reads `spec.md`. Branch `fix/phase-9-skills-tab`, worktree
`../dsh-skill-presets-phase-9`.

## Ownership

| Files | Owner |
|---|---|
| `src/client/index.ts`, `src/client/controller.ts` | plugin-core-developer |
| `test/client.test.mjs`, `stage/shell.js`, `stage/tests/phase9.spec.mjs` | test-engineer |
| `docs/sdlc/phase-9/**` | conductor |

No `src/types/` change: the service shapes are local interfaces inside
`src/client/index.ts` (`LayoutLike`, `SidebarTabsLike`), so the new
`SidebarRightLike` belongs in that same file, with the developer. types-and-contracts-author
is not engaged this round.

`stage/shell.js` is the one shared-by-nature file: it is the test harness, but it
fakes a service the developer's code calls. It goes to **test-engineer**, and the
developer must not touch it. The contract between them is frozen below.

## Frozen contract (neither agent may vary these)

- Service key: `sidebarRight`
- Method called: `openTab(kind)` — one argument, no options object
- Kind passed: `'skills'` — the existing `TAB_KIND` constant, never `TAB_ID`
- `inject` final value: `['slots', 'sidebarRightTabs', 'layout', 'sidebarRight']`
- Stage probe: `window.__STAGE__.tabsOpened` — an array of kind strings, pushed
  one per `openTab` call. `rightbarOpened` stays as it is, for the fallback test.

## Order of work

**Step 1 — developer: `src/client/index.ts`.**
Add `sidebarRight` to `inject`. Declare
`interface SidebarRightLike { openTab(kind: string): void }`. Read it
defensively (`ctx.get('sidebarRight') as SidebarRightLike | undefined`) next to
the existing `layout` read, and hand it to each `StageController` alongside
`attachLayout` — same lifecycle, same place (`stageFor`, line 126). Update the
module docstring table: the Skills tab is now reachable from the popover, not
only from the Guide page's "New tab".

**Step 2 — developer: `src/client/controller.ts`.**
Rewrite `openSkillsTab()` (line 767) to the spec's decision table: try
`sidebarRight.openTab('skills')` inside a `try`; on throw *or* on the service
being absent, fall back to `layout?.openRightbar(true, false)`; close the
popover on every path. Replace the docstring — its current text documents the
column-only behaviour this step removes, and leaving it is how the next reader
re-learns the wrong contract.

The attach seam may be one method (`attachShell({ layout, sidebarRight })`) or a
second `attachSidebarRight`. Developer's call; `attachLayout`'s existing callers
are the constraint.

**Step 3 — test-engineer: `test/client.test.mjs`.**
- Update the `inject` assertion at line 117 to the frozen four-entry array.
- Extend `fakeCtx`'s `available` table with a recording `sidebarRight`, and give
  it options to (a) omit the service and (b) make `openTab` throw.
- Four new cases, one per row of the spec's table: happy path calls `openTab('skills')`
  once and `openRightbar` zero times; service absent falls back; `openTab` throwing
  falls back and does not propagate; neither service present throws nothing.
- Each case asserts the popover closed.

`fakeCtx` currently has no `layout` entry in `available` (line 82) even though
`layout` is injected — so `ctx.get('layout')` already returns `undefined` in
every unit test and the fallback path is the *only* one unit-tested today. Adding
`layout` to that table is required before the happy path can be distinguished at
all. Assert this rather than trusting it.

**Step 4 — test-engineer: `stage/shell.js` + `stage/tests/phase9.spec.mjs`.**
Add a `sidebarRight` fake to the `services` table (line 154) that pushes the kind
into `window.__STAGE__.tabsOpened`. New spec file asserting one click yields
`tabsOpened === ['skills']` and `rightbarOpened` unchanged. Do not edit
`stage/tests/phase8.spec.mjs` test 6 — it pins the *old* behaviour and must be
migrated in this same step: move it to phase9 and invert its assertion, rather
than leaving a test that contradicts the new contract.

**Step 5 — conductor: verification gate.** Run the unit suite and the stage
suite. Grep for `openRightbar` callers to confirm the popover path no longer
reaches it on the success path.

**Step 6 — branch, commit, PR, then cross-model review.**

## Riskiest step

Step 2. `openTab` has two throw paths with different causes, and one of them
(`no session surface is mounted`) depends on shell state a unit test does not
model. A `try/catch` that swallows silently would turn a wiring mistake into an
invisible no-op — the exact failure shape of the bug being fixed. The catch must
fall back to the column, so the user always gets *something* visible.

## Rejected options

- **Keep `openRightbar` and also call `openTab`.** Two reveals, and it keeps a
  call whose only purpose was the missing capability.
- **Pass `TAB_ID`.** Throws; the registry is keyed by kind.
- **Register a close handler / navigation params.** Out of scope; nothing needs
  cleanup or a deep link this round.
- **Drop `layout` entirely.** It is the only fallback when the sidebar service is
  absent, and the plugin is specified to degrade rather than fail.
