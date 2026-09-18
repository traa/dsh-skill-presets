# Plan — Phase 7: flows, the stage control, gate-report health, a browser stage

Branch `feat/phase-7` in worktree `../dsh-skill-presets-phase-7`. Reads
[spec.md](./spec.md). Ends with a PR against `main`. One commit per task; every
task leaves `npm test` green. Risk-first: the browser stage lands first because
every UI task is accepted through it.

## Task 0 — Stop the bleeding (host, no UI)
Files: `src/host/practices/worktrees.ts` (`classify`: `removable` needs merged/PR-MERGED
AND `hasOwnCommits`, never "0 ahead" alone; `GRACE_HOURS = 24` from the newest commit's
age, `graceHours` option threaded through `cleanupWorktrees`; scanner sets `hasOwnCommits`
and `ageHours`), `src/host/curated.ts` + `src/host/store.ts` (`autoCleanWorktrees` default
`false`), `src/host/practices/workroot.ts` (DEPARTURE: the "cannot be placed" amber was not
a placement bug — a read-only `cd /other && grep` MOVED the work root; `attributesWork()`
now lets only mutating or git/gh/glab commands move it), `src/host/practices/plan.ts`
(`isDocsPath`), `src/host/practices/detectors.ts` (`plan-before-code` judges the first
non-doc edit), `src/host/practices/index.ts` (docs never recorded as drift),
`examples/practices.json`, `README.md` (worktree lifecycle table, auto-clean default).
Tests: `test/worktrees.test.mjs` (fresh 0-ahead worktree → keep; grace period; real-repo
sweep keeps `wt-fresh`), `test/detectors.test.mjs` (read-only cd does not move the root;
docs edits → plan-before-code n/a), `test/plan-drift.test.mjs` (`isDocsPath`; `planPaths`
accepts dotfiles — `.gitignore` was reported as drift while dogfooding this very plan).
ADDED (issue #23, found dogfooding): `src/host/practices/index.ts` `loadPlan()` prunes
`state.drift` against the plan AS IT IS NOW on every re-read, so a plan.md that grows to
name the drifted files clears them and the next unplanned edit lists only itself — before,
the stale list stood ("19 files not in plan.md") and came back on every edit.
Test: `test/plan-drift.test.mjs` "tracker: editing plan.md to name the drifted files…".

## Task 1 — Browser stage
Files: `stage/server.mjs` (plain `node:http`: serves the shell, React 18 UMD from
node_modules, `lib/client.js`, and answers `/plugins/dsh-skill-presets/rpc/*` from
`stage/fixtures/<name>.json`; `/__stage/calls` for assertions — DEPARTURE: no Vite, no TS;
the stage must not need a build step of its own), `stage/shell.html` + `stage/shell.css`
(a 40 px `overflow: hidden` header, composer card, right pane, settings view, and a
`position: fixed` overlay layer — the same clip and the same escape the real shell has),
`stage/shell.js` (module loader, `slots`/`styles`/`sidebarRightTabs`, fixture header on
every RPC), `stage/fixtures/*.json` (`green`, `red-worktree`, `explore`, `start-suggestion`),
`stage/tests/smoke.spec.mjs`, `stage/tests/_helpers.mjs` (`openStage`, `rpcCalls`,
`expectInViewport`, `visibleFraction`), `playwright.config.mjs`, `package.json` (`stage`, `test:ui`,
devDeps `@playwright/test@1.61.1`, `react@18.3.1`, `react-dom@18.3.1` — the harness's own
versions; `package-lock.json` follows), `.gitignore` (`stage/shots/*` with the kept
screenshots un-ignored, `test-results/`, `playwright-report/`).
Tests: `npm run test:ui` boots the shell, loads `lib/client.js`, asserts the FOUR current
surfaces mount (proves the harness before any redesign). Screenshot of the current
header chip popover clipped — the "before" evidence.

## Task 2 — Flows in the store
DEPARTURE: no `ActiveDoc` v3. `active.json` (which preset, per rung) is read by the
provider, the tools, the prompt block, the CLI and ~20 tests; rewriting it is the biggest
blast radius in the plan for no user-visible gain. Instead a parallel `positions.json`
(`{ flow, stage }` per rung) sits beside it and `setPosition()` ALSO activates the derived
preset at the same rung, so the two never disagree. A session with a preset but no
position reads as Full at that preset's stage (`source: 'legacy'`).
Files: `src/host/flows.ts` (NEW, pure: `Flow`, `BUILTIN_FLOWS`, `validateFlow(s)`,
`presetForStage` + `ownersOf`, `stageOfPreset`, `positionOf`, `nextStage`, `gateFor`,
`STAGE_TITLE`; `Position`/`PositionsDoc`, `resolvePosition`, `positionFromPreset`,
`moveTo`, `switchFlow`), `src/host/store.ts` (`flows`/`positions` paths), `src/host/service.ts`
(`flows()`, `flow()`, `saveFlow`, `deleteFlow` (remaps positions to Full), `positions()`,
`positionFor()`, `setPosition()`; dispose/clear keep positions in step), `src/host/schema.ts`
(`flows.json` example + schema), `examples/flows.json`, `examples/flows.schema.json`,
`tsdown.client.config.ts` (`external: ['react', …]` — installing react for the stage made
tsdown inline a second React and killed every hook; see `test/client.test.mjs` guard).
Tests: `test/flows.test.mjs` (pure + service), `test/client.test.mjs` (React-external guard).

## Task 3 — Host wiring
Files: `src/host/flows.ts` (`relevantStages`, `annotateRelevance` → `relevant` +
`kind: violation|unknown`, `isUnknownEvidence`), `src/host/index.ts` (RPC `flows/list|save|delete`,
`session/position`, `session/move {flow?, stage?, pin?, scope?}` (one RPC, not two),
`practice/dismiss`; `positionCard()` shared by the control; `scorecard` carries `flow`,
`stage`, `positionSource`, `gate`, `next` and annotated practices; suggestion gated by
`shouldSuggest` and held in `offered` until accept/dismiss/move; `suggestion/accept` MOVES
the position), `src/host/stage.ts` (shell-verb and edit-count sniffing deleted;
`shouldSuggest({explicitPosition, stage, previous, facts})`), `src/host/prompt.ts` (with a
flow: red + relevant + not unknown only; Explore one-liner; legacy callers unchanged),
`src/host/tools.ts` (`sdlc_status` → flow, stage n of m, gate, then only "needing action"
and one "not judged" line). `provider.ts` unchanged: Explore already clears the preset via
`setPosition → activate(null)`.
Tests: `test/stage.test.mjs`, `test/prompt.test.mjs` (new), `test/strictpreset.test.mjs`
(verb test replaced by the "no command sets the stage" contract).

## Task 4 — Stage control + overlay popover (client)
Files: `src/client/api.ts` (`Flow`, `AnnotatedPractice`, `PositionCard`), `src/client/controller.ts`
(`StageController`: card polling, `open`, `anchor` rect, `focusStep`, `move`, accept/dismiss
suggestion, `dismissPractice`, `requestFix` seam), `src/client/stage.ts` (NEW: `STAGE_CSS`,
`makeStageControl`, `makeStagePopover`, `makeStartNotice`, `reportLine`), `src/client/index.ts`
(registers `conversation.input.right@skill-presets-stage` order 30, `shell.overlay@skill-presets-
stage-pop` — root-scoped, renders every session's popover, re-renders via a `roster` store when a
controller is created — and `conversation.composer.dock@skill-presets-start`; **header chip
registration removed**), `src/client/views.ts` (`makeHeaderChip`, `exposedName`, `POP_SKILL_CAP`
and the `.skp-hchip` CSS deleted; `.skp-pop*` kept for the sidebar), `stage/shell.css` (real
theme token names), `stage/gen-fixtures.mjs` (emits `session/position` + `flows/list`).
Tests: `stage/tests/control.spec.mjs` (8: in the composer row; popover 100 % visible + in
viewport + anchored above the control; stages with `aria-current`; click → `session/move`;
outside click / Escape / toggle; keyboard arrows + Enter; flow select → Explore; Explore copy;
start notice Yes/Not now → `suggestion/dismiss`), `test/client.test.mjs` (registration set updated;
chip tests replaced by a closed-state control test). The BEFORE test is retired; its screenshot
and the AFTER are in `stage/shots/`.

## Task 5 — Gate report in the popover and sidebar
Files: `src/client/stage.ts` (report lines were built in Task 4; control classes renamed
`skp-ctl*` — `.skp-stage` collided with the SETTINGS stage card's CSS (`flex-direction:
column`) and stacked the pill vertically; the stage caught it, a fake React never would),
`src/client/views.ts` (sidebar: "Preset" block → "Flow" line with stage n of m, gate, and
the derived preset as a pill; "Practices" → a "Needs action" block (red + relevant, evidence
+ fixing skill) rendered ONLY when non-empty, then green lines, amber advisories, one muted
"Not judged (facts unavailable): …" line, "+N not applicable"; `stageLines`/`STAGE_SHOW_AT`
and the suggestion card + `.skp-pulse` deleted — the sidebar never announces a guess),
`src/client/api.ts` (`Scorecard.flow/stage/positionSource/gate/next`, annotated practices).
Tests: `stage/tests/health.spec.mjs` (5: green → no count/no lines/no amber; red worktree →
count 1, one line, one fix + dismiss, unknown hygiene NOT listed; dismiss → hidden +
`practice/dismiss`; sidebar → one report line, unknowns under "Not judged", no amber badges;
green sidebar → no report block), `test/client.test.mjs` (scorecard test updated; "never
announces a detected stage" replaces the muted-guess test). Screenshots: `stage/shots/after-
red-worktree.png`, `after-sidebar.png`.

## Task 6 — Settings: Flows section
Files: `src/client/controller.ts` (`SettingsSnapshot.flows/flowDraft`; `refresh` fetches
`flows/list`; `newFlow`/`editFlow`/`patchFlowDraft`/`toggleDraftStage`/`saveFlow`/
`deleteFlow`/`setDefaultPosition`), `src/client/views.ts` (Stages tab → **Flows** card: one row
per flow with its stages, `guardrails off` / `built-in` pills, Edit, Delete for custom;
inline editor: title, optional id, guardrails checkbox, stage checkboxes kept in canonical
order; stale "header chip" copy fixed).
Tests: `stage/tests/settings-flows.spec.mjs` (lists built-ins; built-ins have no Delete;
create "Fix" → `flows/save {id:'fix', stages:['build','test']}`). Screenshot
`stage/shots/after-settings-flows.png`.

## Task 7 — Docs, examples, PR
`README.md` (What you get table, "Which preset a session gets" → "Flows and stages",
Practices table statuses, Development: `test:ui`), `docs/sdlc/phase-7/plan.md` kept in
step, `npm run gen:examples`, `npm test`, `npm run test:ui`, push, PR with screenshots
and the acceptance list from spec §10.

## Riskiest step
Task 4's `shell.overlay` portal: the overlay slot is root-scoped while the control is
session-scoped, so the popover must find its anchor through the controller, not props.
The stage (Task 1) proves the two-slot handshake before the host work depends on it.
Fallback if `shell.overlay` rejects a per-session registration: `position: fixed` from the
control itself with a `getBoundingClientRect` anchor — still escapes the header clip.

## Options rejected
- `conversation.hero.agentPreset` for the flow picker: single-kind, owned by the shell
  (`replaceRisk: shadows-shipped-ui`). The composer control is available on the blank
  session too, so the hero adds nothing.
- Keeping the chip alongside the control: two places for one decision (Impeccable:
  "If the 'save' button looks different in two places, one is wrong").
- Deleting the guesser: the start-only suggestion is cheap and matches Cursor's
  "suggest, never switch".
