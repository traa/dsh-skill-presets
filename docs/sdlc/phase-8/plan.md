# Plan — Phase 8: what the user can see

Reads [intent.md](./intent.md). Team-executed under the conductor protocol:
plugin-core-developer owns `src/client/**`; test-engineer owns `test/**` and
`stage/**`; cross-model-reviewer reviews the PR. The conductor owns `docs/**` and
`README.md` only.

## Task 1 — The bug: `inject`
Files: `src/client/index.ts` (`inject = ['slots', 'sidebarRightTabs', 'layout']`; module
doc table says the tab opens from the right sidebar's Guide page; `guide[0].description`
rewritten).
Tests: `test/client.test.mjs` "inject declares every service the bundle reaches for"
(regex over `lib/client.js` for `ctx.get('…')`; each must be in `mod.inject`, `styles`
excepted); `fakeCtx()` resolves only inject-listed services; `stage/shell.js` does the
same and records `__STAGE__.deniedGets`; `stage/tests/phase8.spec.mjs` asserts
`deniedGets` empty and `tabTypes` includes `dsh-skill-presets`.

## Task 2 — Native pill
Files: `src/client/stage.ts` (`.skp-ctl` on the shell's `.trigger` recipe: no border,
transparent, radius 24, 28 px, secondary label, `min-width: 0`, ellipsis; children
`.skp-ctl-label`, `.skp-ctl-count` (red-relevant count only), `.skp-ctl-caret`; no swatch).
Tests: `phase8.spec.mjs` computed-style + no-wrap at `?stage-width=560`;
`test/client.test.mjs` stage-control test updated.

## Task 3 — Popover: gate first, full checks, skills, open tab
Files: `src/client/stage.ts` (`.skp-gate` first with `✓ done` / `✗ not yet` / `? unknown`;
flow select; steps; `.skp-checks` full list of `relevant` practices with `data-status`,
actions only on red, `+N not judged in this stage`; `.skp-skills` chips from
`PositionCard.skills`; suggestion pointer; footer `Preset:` + `.skp-open-tab`),
`src/client/api.ts` (`PositionCard.skills?`, `artifacts?`, `pr?`), `src/client/controller.ts`
(`attachLayout`, `openSkillsTab` → `layout.openRightbar(true,false)`), `src/client/index.ts`
(`attachLayout(ctx.get('layout'))`).
Tests: `phase8.spec.mjs` items 3–6; `control.spec.mjs`/`health.spec.mjs` updated where they
asserted the old report-only block.

## Task 4 — Sidebar body shares the same blocks
Files: `src/client/views.ts` (`makeSidebarBody`: gate line, Flow row, full checks list via
the helpers exported from `stage.ts`; "Needs action"/"Practices" blocks replaced; SKILLS
section kept), `src/client/stage.ts` (exported `renderGate`, `renderChecks`).
Tests: `test/client.test.mjs` scorecard test updated; `health.spec.mjs` sidebar assertions
updated.

## Task 5 — Host sends `skills`, `artifacts`, `pr` on the position card
Files: `src/host/index.ts` `positionCard()` — OUT OF THIS ROUND'S CLIENT SCOPE; if the
developer needs it, a follow-up delegation with `src/host/index.ts` ownership. The stage
fixtures carry them from `stage/gen-fixtures.mjs` meanwhile.

## Task 6 — Docs, PR, review
`README.md` (What you get: pill, popover contents, how to open the Skills tab), this plan
kept in step, `npm test` + `npm run test:ui` green, PR with before/after screenshots,
cross-model-reviewer rounds until clean.

## Riskiest step
Task 1's contract test: it must FAIL on today's bundle (it does — `sidebarRightTabs`) and
the stage must stop handing over undeclared services, or the class of bug survives.

## Options rejected
- Keeping "green → nothing": the user's objection stands — the contract must be visible
  before it fires.
- Two-part pill label (`Review · until PR`): user chose the plain stage; the gate lives
  first in the popover.
