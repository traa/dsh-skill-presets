# Spec — Phase 7: flows, the stage control, gate-report health, a browser stage

Reads [intent.md](./intent.md). Decisions confirmed with the user on 2026-09-18:
composer-row control and **drop the header chip**; built-in flows **Full** and
**Explore** (Fix / Build-only remain one click away as custom flows); the guesser
becomes a **start-only** one-line suggestion; health shows **only red,
stage-relevant lines** with one fix action, nothing when green.

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Stage** | Unchanged union `plan · design · build · test · deploy · maintain · cross`. Preset ownership unchanged. |
| **Flow** | `{ id, title, stages: Stage[], guardrails: 'on' \| 'off', builtin? }`. An ordered subset of stages a piece of work passes through. |
| **Session flow state** | `{ flow: string, stage: Stage \| null, since, by }` per session. `stage === null` only for a flow with no stages (Explore). |
| **Gate** | The artifact that ends a stage in the *Full* flow: `plan→intent.md`, `design→spec.md`, `build→plan.md then the diff`, `test→PR`, `deploy→merge`. Other flows inherit the gate for each stage they include. |

Built-in flows (`examples/flows.json`, seeded, editable, exported/imported with presets):

```json
[
  { "id": "full",    "title": "Full",    "stages": ["plan","design","build","test","deploy"], "guardrails": "on",  "builtin": true },
  { "id": "explore", "title": "Explore", "stages": [],                                        "guardrails": "off", "builtin": true }
]
```

`examples/flows.json` gets a schema and joins `test/examples.test.mjs`.
Custom flows are saved from the same control ("New flow…" → title + stage
checkboxes in order) and persist in `<workbench>/skills/flows.json`.

## 2. Resolution — what a session is actually in

`ActiveDoc` v3 replaces the per-session `preset` with `{ flow, stage }`:

```
sessions[id] = { flow: 'full', stage: 'build', since, by }
```

Preset is *derived*: `presetFor(stage)` = the single preset whose `stage`
matches (collision → the one the flow pins in `pins[stage]`, else the first by
`STAGE_ORDER`, and the control shows a picker). Migration from v2: a session
with `preset: X` becomes `{ flow: 'full', stage: preset(X).stage }`; a
`cross` preset becomes `{ flow: 'full', stage: 'build' }` with the preset kept
in `pins`. The workspace default and per-agent-preset defaults become
`{ flow, stage }` too. Everything the model sees (`ctx.skills` set, guardrails
block, `sdlc_status`) reads the derived preset, so the provider and tools do
not change shape.

Explore: `stage === null` → no preset, overlays still apply, all practices
`off` for the session (not `n/a`: the prompt block says
*"Explore flow: guardrails off for this session"* once, then nothing).

## 3. The stage control (composer row)

Registered into `conversation.input.right` (list, session-scoped), `order: 30`
so it sits left of the submit action and right of the shell's own controls.
One button, ≤ 28 px tall, matching the model control's look (read tokens from
`Theme.listTokens`; no colours of our own except the preset swatch):

```
[ ◈ Build ▾ ]          (Full flow; stage name only)
[ ◈ Explore ▾ ]        (no stage)
[ ◈ Build · 1 ▾ ]      (one red, stage-relevant practice — the count, not a dot)
```

Clicking opens a popover rendered **through `shell.overlay`** (registered once
per session; the control passes its anchor rect through the controller). The
popover:

```
Flow  ( Full ▾ )                          ← changes the flow; keeps stage if it exists in the new one
Plan → Design → [Build] → Review → Ship   ← the flow's stages; the current one filled; click = move
plan.md present — start in Build?  [Yes] [No]   ← start-only suggestion (see §4)
────────────────────────────────────────────
Worktree · edits on main in the primary checkout        [Create worktree]
                                                        ← red + relevant lines only; one action each
────────────────────────────────────────────
Skills in play: executing-plans, tdd, +7               ← names, not a wall of chips
Settings…                                              ← the only path to everything else
```

Rules (Impeccable operate mode): ≤ 4 choices visible per decision, one primary
action per line, 150–250 ms transitions, no pulse, no dot, no gradient, no
eyebrow labels, radii ≤ 8 px on the popover and 999 on the pill. Outside
`pointerdown` and Escape close it (existing logic, moved). Keyboard: the button
is focusable; arrow keys move between stages; Enter confirms.

The header chip (`conversation.session.header.utilities`) is **removed**. The
sidebar Skills tab stays as the *detail* surface (§5).

## 4. Suggestion, start-only

`detectStage` stays as a pure function. `suggest()` is called only when
`sessions[id]` is absent (first step of a session) or when a gate artifact for
the current stage appeared in `facts.artifacts` since the last check (the
playbook's "an accepted artifact fires the next gate"). It never fires because
of edit counts or shell verbs; the `deploy`/`maintain` command sniffing is
deleted. The result is a line in the popover *and* a one-line notice under the
composer (`conversation.composer.dock`, order 30) that disappears on
accept/dismiss or after the first user message. Three dismissals of the same
`from→to` still mute for the workspace.

## 5. Health as a gate report

`PracticeResult` gains `relevant: boolean` (does the current stage care?) and
`kind: 'violation' | 'unknown'` for non-green. Detectors change so that:

- **Amber is `unknown`.** It means "I could not read a fact" (git unavailable,
  cwd outside the repo, forge CLI missing). It never renders as a warning: the
  popover shows nothing; the sidebar shows it muted under *Not judged*.
- **Read-only commands are never mutations.** `isMutatingCommand` already
  handles segments; the gap is the *placement* branch: a call whose `workdir`
  is outside every known root is **not** a mutation — it is `unknown`.
  Regression test: `grep -rn x`, `ls`, `sed -n` with `workdir` in a foreign
  repo → worktree practice stays green.
- **Docs are not code.** `plan-before-code` and `plan-drift` judge edits under
  source roots only; writing `docs/**`, `*.md`, `README*`, `LICENSE*` never
  trips them (observed live: writing `docs/sdlc/phase-7/intent.md` turned
  *Plan before code* red — the artifact the practice exists to encourage).
- **Relevance per flow.** A practice lists the stages it judges
  (`PRACTICE_INFO[id].stages`). `plan-before-code`, `plan-drift` → build;
  `pr-always` → build/test/deploy; `worktree-first` → build/test;
  `post-merge-sync` → all; `conductor` → when a team is attached. Outside its
  stages a practice is `n/a` and *not counted*.
- **Prompt block.** `renderGuardrails` lists a practice only when
  `status === 'red' && relevant`. Unknowns are never in the prompt.
- **Dismiss.** `practice/dismiss {sessionId, id}` hides that line for the
  session; three dismissals in a workspace mute it there (same doc as
  suggestions, keyed `practice:<id>`). Hard mode is unaffected by dismissal.

## 6. The plugin never destroys work

`classify()` in `practices/worktrees.ts`:

- `removable` requires **all** of: branch merged into default *or* its PR is
  `MERGED` (never "0 ahead" alone), clean tree, **and** the worktree's
  `.git` gitdir mtime older than `graceHours` (default 24).
- `autoCleanWorktrees` **defaults to `false`**; the practice line offers
  *Remove* as the action; the CLI `--clean` is explicit.
- A regression test: a worktree created seconds ago, 0 ahead, clean → `keep`
  with reason `created <1h ago`.

## 7. The browser stage (`stage/`)

A Playwright harness that mounts the **real** `lib/client.js` into a fake shell:

- `stage/shell.html` + `stage/shell.ts`: defines `window.__ModuleLoader__`
  exactly as the page does (captured from `client.test.mjs`'s `load()`),
  provides real React 18 from `node_modules`, and a `slots` implementation
  that renders each registered occupant into a DOM region with the same name
  (`conversation.input.right`, `shell.overlay`, `conversation.composer.dock`,
  `sidebar.right.pane.tab`, `settings.section`). Layout mimics the shell:
  header row with `overflow: hidden`, composer card at the bottom, overlay
  layer `position: fixed; inset: 0; pointer-events: none` with children
  `pointer-events: auto`.
- `stage/rpc.ts`: a scripted `fetch`/RPC stub answering `status`, `scorecard`,
  `flows/*`, `presets/activate`, `practice/dismiss` from fixtures in
  `stage/fixtures/*.json` (green session, red worktree, explore, start
  suggestion). Fixtures are validated against the same TS types by a
  `stage/fixtures.test.mjs`.
- `stage/tests/*.spec.ts` (Playwright, `chromium` already installed):
  popover opens above the header and is fully within the viewport; outside
  click closes; Escape closes; stage click calls `presets/activate` with the
  right body; red line shows exactly one action; green fixture renders no
  health line; keyboard path; a screenshot per fixture into `stage/shots/`
  (gitignored, attached to the PR).
- `npm run stage` serves it on `127.0.0.1:4173` for eyeballing; `npm run
  test:ui` runs the specs headless. `npm test` stays Node-only and fast;
  `test:ui` is a separate gate the PR must show green.

## 8. Settings page

Unchanged in scope; the **Stages & presets** tab gains a **Flows** section
(list, reorder stages, guardrails on/off, delete non-builtin). Everything the
chip's popover used to show that is not in §3 lives here.

## 9. Tools

`sdlc_status` reports `flow`, `stage`, `next gate`, and only red relevant
practices. `skill_preset_suggest` is unchanged. New `sdlc_set_stage { stage }`
is **not** added: moving stage is a human act (playbook §2).

## 10. Acceptance (all must hold before the PR)

1. New session → control reads `◈ Plan ▾` (Full default) or the workspace's
   default flow; Explore shows `◈ Explore ▾` and no practice lines ever.
2. Popover renders inside the viewport with the header clipped at 40 px in
   the stage shell; Playwright asserts `boundingBox` within viewport.
3. `grep` with a foreign `workdir` → worktree practice green (test + live).
4. A 5-second-old worktree with 0 commits is `keep`, and `autoCleanWorktrees`
   is `false` in a fresh store.
5. `renderGuardrails` output contains no amber line and no irrelevant practice
   (test).
6. v2 → v3 migration test for `active.json`.
7. `npm test` green; `npm run test:ui` green; README updated; screenshots in
   the PR.
