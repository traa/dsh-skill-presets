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
docs edits → plan-before-code n/a), `test/plan-drift.test.mjs` (`isDocsPath`).

## Task 1 — Browser stage
Files: `stage/server.mjs` (plain `node:http`: serves the shell, React 18 UMD from
node_modules, `lib/client.js`, and answers `/plugins/dsh-skill-presets/rpc/*` from
`stage/fixtures/<name>.json`; `/__stage/calls` for assertions — DEPARTURE: no Vite, no TS;
the stage must not need a build step of its own), `stage/shell.html` + `stage/shell.css`
(a 40 px `overflow: hidden` header, composer card, right pane, settings view, and a
`position: fixed` overlay layer — the same clip and the same escape the real shell has),
`stage/shell.js` (module loader, `slots`/`styles`/`sidebarRightTabs`, fixture header on
every RPC), `stage/fixtures/{green,red-worktree,explore,start-suggestion}.json`,
`stage/tests/smoke.spec.mjs`, `playwright.config.mjs`, `package.json` (`stage`, `test:ui`,
devDeps `@playwright/test@1.61.1`, `react@18.3.1`, `react-dom@18.3.1` — the harness's own
versions), `.gitignore` (`stage/shots/`, `test-results/`).
Tests: `npm run test:ui` boots the shell, loads `lib/client.js`, asserts the FOUR current
surfaces mount (proves the harness before any redesign). Screenshot of the current
header chip popover clipped — the "before" evidence.

## Task 2 — Flows in the store
Files: `src/host/types.ts` (`Flow`, `ActiveDoc` v3 `{flow, stage}` per rung), `src/host/store.ts`
(`validateActive` v1→v2→v3; `flows.json` seed + validate), `src/host/curated.ts`
(`BUILTIN_FLOWS`, `PRACTICE_INFO[id].stages`), `src/host/service.ts` (`flows()`,
`saveFlow`, `deleteFlow`, `activeFor` returns `{flow, stage, preset}`, `presetFor(stage)`
with pins, `setStage`, `setFlow`), `examples/flows.json` + `flows.schema.json`,
`src/bin/gen-examples.ts`.
Tests: `test/active.test.mjs` (v2→v3 migration incl. `cross` preset → pins), new
`test/flows.test.mjs` (derivation, collision → pin, Explore → no preset).

## Task 3 — Host wiring
Files: `src/host/index.ts` (RPC `flows/list|save|delete`, `session/set-flow`,
`session/set-stage`, `practice/dismiss`; `scorecard` carries `flow`, `stage`, `gate`,
`relevant`/`kind` per practice; suggestion only at session start / gate appearance),
`src/host/stage.ts` (delete command sniffing; `shouldSuggest(prevFacts, facts, state)`),
`src/host/prompt.ts` (red+relevant only; Explore one-liner), `src/host/tools.ts`
(`sdlc_status` → flow/stage/next gate), `src/host/provider.ts` (Explore → no preset).
Tests: `test/stage.test.mjs`, `test/prompt.test.mjs` (new), `test/tools.test.mjs` (new).

## Task 4 — Stage control + overlay popover (client)
Files: `src/client/api.ts` (types), `src/client/controller.ts` (`StageController`: anchor
rect, open, setStage, setFlow, dismiss, suggestion), `src/client/views.ts`
(`makeStageControl`, `makeStagePopover` for `shell.overlay`, `makeStartNotice` for
`conversation.composer.dock`; CSS from theme tokens), `src/client/index.ts` (register
`conversation.input.right` order 30, `shell.overlay` id `skill-presets-popover`,
`conversation.composer.dock` order 30; **remove** the header chip registration).
Tests: `stage/tests/control.spec.ts` (opens within viewport under clipped header; outside
click; Escape; stage click → RPC body; arrow keys), `test/client.test.mjs` (registration
count updated: control, overlay, dock, settings, card, tab; chip gone).

## Task 5 — Gate report in the popover and sidebar
Files: `src/client/views.ts` (red+relevant lines with one action each: `Create worktree`,
`Open PR`, `Update plan.md`, `Sync`, `Remove worktree`; *Not judged* muted group in the
sidebar; green → nothing), `src/client/controller.ts` (actions call existing RPCs).
Tests: `stage/tests/health.spec.ts` (green fixture: zero lines; red-worktree fixture:
exactly one line, one button; dismiss hides), screenshots per fixture.

## Task 6 — Settings: Flows section
Files: `src/client/views.ts` (Stages tab → Flows list: stages as ordered toggles,
guardrails on/off, delete non-builtin, "New flow"), `src/client/controller.ts`.
Tests: `test/client.test.mjs` (renders flows from fixture status).

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
