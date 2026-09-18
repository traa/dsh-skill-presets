# dsh-skill-presets

Out-of-tree DeepSeek Harness plugin: **SDLC-stage skill presets** from a
**versioned skill library**, **practice guardrails**, and **skill-usage
insight** — so you can see which skills are in play, switch them in one click,
and measure whether the model actually used them.

Grounded in the [AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook):
six non-linear stages (Plan → Design → Build → Test → Deploy → Maintain), each
ending by committing an artifact (`intent.md` → `spec.md` → `plan.md` → PR →
incident record) that the next stage reads; skills as institutional knowledge;
guardrails that act as the model acts; worktrees for parallel work; humans at
the gates.

**Provider-neutral.** Every seam is a harness seam (`ctx.skills`,
`agent/pre-step`, `tools/result`, `tools/pre-execute`, `ctx.systemPrompt`).
Nothing depends on a vendor hook dialect, a vendor instructions file, or a
vendor tool name. Upstream skills that do are normalized on install.

## What you get

| Surface | Where | What it shows |
|---|---|---|
| **Stage control** | composer tool row, beside the model and plan controls | `◈ Build ▾` — the session's **flow** and **stage**. Click: pick a flow, move between its stages, see the gate that ends the stage, and the practices that need action (red and relevant only). Its popover renders through the shell's overlay layer, so nothing clips it. |
| **Start notice** | one line under the composer | `plan.md committed — start in Build?` **Yes / Not now**. Offered at session start and when the current stage's gate artifact lands; never mid-session, never pulses. |
| **Skills tab** | right sidebar | flow · stage n of m · gate; **Needs action** (red + relevant, one line each with the fixing skill); green practices; *Not judged (facts unavailable)* muted; every offered skill with load count; per-turn timeline; 👍/👎 |
| **Settings → Skills** | left nav | **Stages & presets** (flows, presets, defaults per agent preset), **Library**, **Practices** (off/advisory/hard), **Insights** |
| **Plugin card** | Settings → Plugins | store path, active preset, counts |
| Tools | model | `sdlc_status` (flow, stage n of m, gate, then only what needs action), `skill_preset_status`, `skill_preset_suggest` (never switches) |
| Prompt | model | a ≤ 8-line block: flow + stage + next gate, active preset + skill names, practices **needing action** (red, relevant to the stage — never "unknown", never stage-irrelevant). Empty when nothing needs saying; one line in Explore. |

## Flows and stages

A **flow** is the ordered subset of stages a piece of work passes through. Not
every project needs the whole loop:

| Flow | Stages | Guardrails |
|---|---|---|
| **Full** (built in) | Plan → Design → Build → Review → Ship | on |
| **Explore** (built in) | none | off — spikes, prototypes, looking around |
| yours | any ordered subset (e.g. **Fix** = Build → Review) | on/off |

The **stage** is the human's choice. Pick it in the stage control; the plugin
never switches it. Each stage maps to the preset that owns it (`plan` → Plan,
`build` → Build, `test` → Test & Review, …); when several presets own a stage the
control asks which. Moving stage activates the derived preset at the same rung.

Resolution is **session → agent-preset default → workspace default**; a session
that predates flows (has a preset but no position) reads as Full at that preset's
stage. Positions live in `positions.json` beside `active.json`.

**Each stage ends with a gate artifact** — `intent.md`, `spec.md`, `plan.md`,
the PR, the merge — and the next stage reads it. The prompt block and
`sdlc_status` name the current gate; committing it is what "done with this
stage" means.

### The start suggestion

The detector reads **committed artifacts and PR state** (never shell verbs or
edit counts) and is offered at exactly two moments: the start of a session that
has no explicit position yet, and when the current stage's gate artifact appears.
One line, **Yes / Not now**; three dismissals of the same transition mute it for
the workspace; accepting moves the position.

### Health is a gate report, not a dashboard

Nothing renders while all is well. A practice surfaces only when it is **red**
and the **current stage judges it** (`plan-before-code` and `plan-drift` judge
Build; `pull-request` judges Build/Review/Ship; `worktree` judges Build/Review;
the rest judge every stage), as one line with the evidence and the skill that
fixes it. **Amber means "I could not read a fact"** (git unavailable, cwd outside
the repo, no forge CLI) — it is *Not judged*, never a warning. Dismissing a line
hides it for the session; three dismissals mute it for the workspace. Explore
turns every practice off for the session.

## Worktree lifecycle

`worktree-first` creates a worktree per piece of work; nothing used to remove
them. Now a worktree lives exactly as long as its unmerged work:

| Verdict | When | Action |
|---|---|---|
| **removable** | the branch has commits of its own **and** all of them are in the default branch (or its PR is `MERGED`), the tree is clean, **and** the newest commit is older than the 24 h grace period | removed with `git worktree remove`, branch deleted with `git branch -d`, `git worktree prune` |
| **attention** | dirty tree, detached HEAD, or a `node_modules` **symlink** inside | listed with the reason; never touched |
| **keep** | primary checkout, locked, on the default branch, has unmerged commits, **has no commits of its own yet** (fresh — "0 ahead" is not "merged"), or merged less than 24 h ago | left alone |

Manual by default: the session's Skills tab lists worktrees with **Remove**;
`dsh-skill-presets worktrees [--dry-run|--clean]`. Automatic sweeping
(`autoCleanWorktrees`, **off** by default since Phase 7 — it once deleted a
fresh worktree and its branch mid-session) runs when a session ends, for the
repo it worked in, and hourly for every live repo. The **Clean up worktrees** practice goes amber on merged
leftovers and **red** on a `node_modules` symlink — the exact footgun that made
Phase 2's post-merge build a silent no-op. `worktree-first` now says `npm ci`
inside the worktree, never a symlink; `worktree-cleanup` teaches the removal
rules.

## Strict catalog

**Strict skill catalog** (Practices tab) makes the model's catalog *exactly*
the resolved set — with **composition only; the harness is never modified**.

The agent preset's own `skill-filesystem` row is what still shows the model
`~/.dsh/skills` and `<project>/.dsh/skills`. Press **Create strict agent
preset** (Practices tab) or run `dsh-skill-presets strict-preset standard
--skill-preset build`: it copies the shipped agent preset into
`~/.dsh/.agent-presets/standard-strict/` **without** that row — the
harness's own copy-then-edit authoring model — and maps it under *Defaults per
harness agent preset*. Restart once so the agent-preset picker lists it, then
choose it for new sessions. Move anything you still want from those skill
directories into `library/local/` first.

Now every skill the model can load comes from this plugin, and the `skill`
pre-execute guard denies anything outside the set with a reason (🔐). The
plugin also feature-detects a `ctx.skills.restrict()` seam and will use it if
a future harness release ships one (🔒); nothing depends on that.

## Hooks export (optional)

**Generate hook files** writes the same detectors as command hooks for **both**
bridges the harness ships — `<workbench>/hooks/skill-presets.claude-code.json`
and `skill-presets.codex.json` — each calling `dsh-skill-presets check
<practice> --hook <dialect>`, which replays the detector against live git facts
plus the gated call from stdin and exits 2 (reason on stderr) only when the
practice is red **and** hard. The native `tools/pre-execute` gate is the
primary mechanism; this is for setups that already run hooks in one dialect.

## Replay evals

`evals/fixtures/<name>/fixture.json` is a **redacted** session: tool names,
path/command/skill arguments, error flags, first result line, a git-facts
snapshot, usage events — no prompt text. `expected.json` pins the practice
statuses, detected stage, and loaded/unknown skills. `npm test` replays the
three shipped fixtures through the real tracker; `dsh-skill-presets eval
[--update]` runs them (and `<workbench>/skills/evals/`) from the CLI; **Save as
fixture** in the sidebar records the current session. Change a detector, a
stage rule, or a summary fold and the fixtures fail first — the playbook's
"re-run the evals whenever a skill or hook changes", made concrete.

## When a PR merges, the agent syncs

A merged PR leaves the local checkout behind; editing before syncing writes
against stale code and leaves the server serving the previous build. That is
now a **practice**, not a paragraph a human has to remember:

| | |
|---|---|
| **Sync after a merge** | red when `origin/<default>` is ahead of the checkout, or when the checkout is level but `lib/` is older than `src/` (pulled, never rebuilt); green when level and built; n/a outside a repo |
| Skill | `post-merge-sync` — in the `git-repo` overlay, so it is offered in every repository session |
| Command | `dsh-skill-presets sync [root…]` — fetch, refuse anything that is not a clean fast-forwardable default branch, `git pull --ff-only`, `npm ci`, `npm run build`, sweep merged worktrees, report whether a restart is needed |
| Enforcement | advisory by default (named in the guardrails block every step); `hard` blocks writes, edits, and shell until it is green |

The agent therefore cannot quietly continue on stale code: the red line is in
its context on every step, the skill tells it exactly what to run, and hard
mode denies the next edit with the reason. The one step it cannot do is the
**server restart** — the skill requires it to say so plainly instead of
claiming the update is live.

Nothing here runs on a timer and nothing restarts anything by itself: the
sync is an action the agent takes, when the condition holds.

## Doctor

`dsh-skill-presets doctor [--profile web]` — and a banner on the Skills page
when anything fails — checks what three restarts taught us to check by hand:
`lib/` older than `src/` or missing modules, `node_modules` a symlink,
the profile cannot resolve or does not bundle the package, **the server
started before the last build** (host-recorded start time; `ps` fallback;
not judged when probing a checkout the profile does not serve), the
`skills.restrict` and `agentTeams` seams, the legacy `skill-filesystem` row
still enabled, store JSON, eval fixtures. Exit 1 on any `fail`; warnings are
degradations, not breakage.

## Impact

Insights → **Impact**: for each skill, sessions that *loaded* it vs sessions
offered it that did not — all-practices-green rate, PR-opened rate, drift
files, denials, rating — as deltas; per preset vs all others; and in the
sidebar, **this session vs your last 20 under the same preset**. Rows with
fewer than 5 sessions on a side are greyed, never hidden. Forked experiments
aggregate into preset-pair win totals on the same outcomes.

## Why each load

Every `loaded` event records the first line of the user message that opened
that turn (≤ 120 chars — nothing else from the prompt) and whether the
guardrails block named the skill that step. The sidebar expands each load
into *you said → nudged or self-routed → which practices changed before the
next load*. This is the offered → loaded → outcome chain, per load.

## Lint

`dsh-skill-presets lint` (also after every install/update, and as Library
badges): vendor terms with line numbers (**error**), a description with no
trigger, no `when-to-use`, long descriptions, bodies over 300 lines, and
skills offered in ≥ 30 sessions never loaded. The shipped local skills must
lint clean in `npm test`. First run on the real library found 12 vendor
terms the original normalize rules missed; two rules were added.

## Placement

Promote now says which preset the new skill fits; the drawer offers one-click
**add to ‹preset›** for any local skill in no preset; the Stages tab lists
**installed but in no preset** skills — the ones the model never sees.

## Teams

**Attachment through a service.** When dsh-agent-teams publishes
`ctx.agentTeams` ([traa/dsh-agent-teams#7](https://github.com/traa/dsh-agent-teams/pull/7))
the plugin reads attachment there and re-publishes the catalog on
`onAttachmentChange`; without it, `team_delegate` visibility remains the seam.
The **conductor** practice now reads the team's own `conductorInstructions`:
a team that says "delegate immediately" is not flagged for skipping the
approval turn.

**SDLC team templates** (`templates/teams/`, plus `<workbench>/teams/templates/`):
`sdlc-build-team` (implementer · tester · reviewer→implementer) and
`sdlc-review-board` (plan conformance · security · performance), whose
conductor instructions name `conductor-protocol`, `worktree-first`, `pr-always`.
Members inherit the session's provider. **Attach** from the session's Skills tab
(goes through agent-teams' own `teams.save` + `mode.attach`).

## Knowledge → skill

The Insights tab lists **promotable insights** from dsh-knowledge's stores
(read-only): `workflow` / `convention` / `preference` with confidence ≥ 2 **or**
≥ 40 reads, not retired or superseded. **Promote** writes
`library/local/<kebab-title>/SKILL.md` from a deterministic template — the
insight *is* the body, with a back-link — re-indexes local, records
`promotedFrom` in the lock and `promotions.json`, and opens the drawer so you
turn the prose into a checklist. The insight stays in knowledge. Local skill
`writing-skills-from-insights` teaches the model the same move.

## Pruning hints

Stage cards show **"remove from preset?"** for a skill offered in ≥ 20 sessions
of that preset with a load rate ≤ 10 % (thresholds in `practices.json`);
removal is from the preset, never the library. Insights shows **"add to
‹preset›?"** for a name the model asked the `skill` tool for ≥ 3 times that no
preset exposes — one click when it is in the library, an upstream pointer after
**Search upstream**, or "write it as a local skill?" otherwise.

## Export / import

**Export all** downloads one JSON bundle: presets, every overlay, the sources
their skills come from, the exact lock entries (commit + digest), and the
bodies of referenced local skills. **Import…** or drop a bundle on the Stages
tab: same-id presets are imported with an `-imported` suffix; missing sources
are added *disabled*; missing skills are installed at the pinned commit; local
skills are written first so refs resolve. CLI: `export <file> [preset…]`,
`import <file> [--replace|--rename] [--dry-run]`.

## How the model sees exactly one set

The plugin registers one `SkillProvider` into the host `ctx.skills` registry.
A host-row provider lands in the **global** layer, so the set reaches every
agent preset (standard, cordis, ptc, …). `list()` returns the **active preset
∪ overlays**; switching a preset calls the registry's `invalidate()`, and
`dsh-tool-skill` republishes `<available_skills>` on the model's next step. No
restart, no filesystem watching.

**Overlays** add skills when a condition holds for the viewing agent:

| Overlay | Condition (harness seam) | Adds |
|---|---|---|
| `team-attached` | `team_delegate` is visible to the agent (dsh-agent-teams installs it per attached session) | `conductor-protocol` |
| `git-repo` | the session cwd is inside a git work tree | `worktree-first`, `pr-always` |

Enforcement is **additive** by default: skills from `~/.dsh/skills` or a
project's `.dsh/skills` stay visible. **Strict** mode narrows the catalog
itself (see *Strict catalog*).

## The foundation

Three curated sources, fetched only when you click **Install foundation**:

- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) — `skills/`
- [obra/superpowers](https://github.com/obra/superpowers) — `skills/`
- [mattpocock/skills](https://github.com/mattpocock/skills) — `skills/engineering`, `skills/productivity`

plus **local** skills this plugin authors and seeds into the workbench (edit
them there; they are yours):

| Skill | Practice it teaches |
|---|---|
| `sdlc-stage-handoff` | detect the stage from artifacts; end a stage by committing the next artifact |
| `worktree-first` | edits happen on a feature branch in a linked worktree, never on `main` in the primary checkout |
| `pr-always` | work ends with a pushed branch and an open PR carrying intent/plan/evidence — never a merge |
| `conductor-protocol` | with a team attached: propose → approval → delegate self-contained briefs → route reviews → reconcile → report; never edit code a teammate owns |
| `pr-review-against-plan` | review the diff against `plan.md`/`spec.md`; findings with evidence into the PR |
| `incident-to-intent` | reproduce → root cause → incident record → new `intent.md` + test + guidance |

**Stage presets** (`examples/presets.json` is the exact seed):

| Preset | Skills |
|---|---|
| `plan` | brainstorming, idea-refine, interview-me, spec-driven-development, grill-me, to-spec, sdlc-stage-handoff |
| `design` | writing-plans, planning-and-task-breakdown, api-and-interface-design, documentation-and-adrs, codebase-design, domain-modeling, to-tickets, sdlc-stage-handoff |
| `build` | executing-plans, test-driven-development, using-git-worktrees, verification-before-completion, incremental-implementation, git-workflow-and-versioning, implement, worktree-first, pr-always |
| `test-review` | requesting-code-review, receiving-code-review, finishing-a-development-branch, code-review-and-quality, security-and-hardening, browser-testing-with-devtools, code-review, pr-review-against-plan, pr-always |
| `deploy` | ci-cd-and-automation, shipping-and-launch, deprecation-and-migration, pr-always |
| `maintain` | systematic-debugging, debugging-and-error-recovery, observability-and-instrumentation, performance-optimization, diagnosing-bugs, triage, incident-to-intent |
| `delegate` | dispatching-parallel-agents, subagent-driven-development, conductor-protocol, gemini-agent, qoder-agent |

Two sources ship a `test-driven-development`; a preset resolves exposed names
and refuses to save on a collision unless one gets an `as` alias.

## Practices

Observed from **tool names, arguments, results, and git** — never from the
model's prose — so they behave identically under every provider and replay
from recorded logs. Git facts are read at the model's **work root**: the
directory of its last absolute write/edit, or the target of a `cd`/`-C` in a
command that **mutates or drives git** — a read-only `cd /other && grep` never
moves it — falling back to the session cwd. So a session that moved into a
worktree is judged there, not at the checkout it was opened in, and a look at
another repository does not poison its verdicts.

| Practice | Green | Red | Unknown (amber) |
|---|---|---|---|
| Work in a worktree | linked worktree, or a non-protected branch | a write/edit/mutating bash on a protected branch in the primary checkout | git unavailable, or the mutations cannot be placed in the checkout |
| Always open a PR | `gh pr create` / `glab mr create` ran, a PR/MR URL appeared in any tool result, or `gh pr view` finds one | session ended ahead of upstream with no PR, or never pushed | no forge CLI and no upstream |
| Follow the conductor protocol | delegations, no self-edits | conductor wrote/edited files; delegated before a user approval turn; ended with zero delegations | — |
| Commit the stage artifact | the active stage's artifact exists | Build/Test without `plan.md`, Design without `intent.md` | — |
| Plan before code | `plan.md` present before the first edit in Build | edited with no `plan.md` | — |
| Keep plan.md in step with the diff | every Build edit is named in `plan.md`, or `plan.md` was updated after | — (amber while unplanned edits are outstanding) | — |
| Clean up worktrees | no merged leftovers, no `node_modules` symlink | a `node_modules` symlink in a worktree | — (amber on merged leftovers / stale) |

Modes per practice: **off**, **advisory** (a prompt line when at risk),
**hard** (the offending tool call is denied with a reason naming the skill to
load). Every denial is a telemetry event.

## Telemetry

`skills/usage/<sessionId>.jsonl` — one line per event: `offered`, `loaded`
(name, turn, ok, `unknown`, chars), `preset-switch`, `overlay`, `practice`,
`denied`, `rated`, `provider`. `skills/usage-rollup.json` aggregates: per skill
**load rate** (sessions loaded ÷ sessions offered), loads, mean first-load turn,
~tokens; per preset sessions, coverage, rating; per practice green/amber/red;
**unknown requests** (the model asked for a skill that does not exist — the
strongest "missing skill" signal); **co-usage** pairs; per provider/model.

`usage/` is the one directory you may want to gitignore in the workbench.

## Store layout (`<workbench>/skills/`)

```
library/<source-id>/<skill-dir>/SKILL.md (+ siblings)
sources.json  presets.json  overlays.json  practices.json  normalize-rules.json
lock.json        # per source: commit, fetchedAt; per skill: digest, upstreamDigest, normalized, history[≤5], orphaned?
active.json      # per rung: which preset
positions.json   # per rung: { flow, stage }
flows.json       # Full, Explore, and yours
usage/*.jsonl    usage-rollup.json
```

`examples/*.json` are byte-identical to what bootstrap seeds and
`examples/*.schema.json` validate them; `test/examples.test.mjs` fails on drift
(`npm run gen:examples` after editing `src/host/curated.ts`).

### Normalization

Upstream skills name one vendor's tools and files. `normalize-rules.json`
rewrites Markdown on install — `CLAUDE.md`/`GEMINI.md` → "your project's
instructions file", `Task tool` → `subagent`, `TodoWrite` → `todo_write`,
`Skill(x)`/`superpowers:x` → the `skill` tool, vendor slash commands → "the
corresponding skill or tool if available", `Claude Code` → "the coding agent".
Scripts are byte-identical. The lock keeps both digests; the drawer shows a
**normalized** badge; `keepUpstream` per skill opts out.

## Install

```sh
cd ~/dev/dsh-plugins/dsh-skill-presets
npm install && npm run build        # tsc -> lib/ + tsdown -> lib/client.js
dsh plugin --profile web add link:$PWD
```

Then in `$DSH_HOME/profiles/web/cordis.patch.yml` **disable the row that
exposes `<workbench>/skills` as `customSkillDirs`** — the library now lives
under that directory and would otherwise be discovered twice:

```yaml
- id: skill-filesystem
  disabled: true
```

Pre-flight without booting, then restart the profile:

```sh
dsh --profile web --dump-config | grep -A3 'id: skill-presets'
```

On first use the plugin bootstraps the store: seeds the JSON files, **moves**
any legacy `skills/<name>/SKILL.md` bundles into `library/local/<name>/`
(never deletes; leaves `MIGRATED.md`), seeds the six local SDLC skills, and
indexes local. Nothing is fetched from the network until **Install
foundation** is clicked (or `dsh-skill-presets install` is run).

The workbench is resolved from `ctx.get('workbench')` when dsh-workbench is
composed, else `$DSH_WORKBENCH` → `$DSH_SETTINGS_REPO` → `$DSH_HOME/settings-repo`.
`GITHUB_TOKEN` is honoured for the API; unauthenticated works for three sources.

## CLI

```
dsh-skill-presets status | install [source…] | update [source…] | check-updates [source…]
                  | activate <id|none> | summary <usage.jsonl> | rollup
                  | worktrees [cwd] [--dry-run|--clean]
                  | hooks generate [dir]
                  | check <practice> [--cwd d] [--json] [--hook <dialect>]
                  | eval [dir] [--update] [--only name]
                  | export <file> [preset…] | import <file> [--replace|--rename] [--dry-run]
                  | doctor [--profile name] [--json] | lint [ref] [--json]
                  | strict-preset <base> [id] [--skill-preset <id>]
```

## Acceptance checklist

- Move stage in the composer control → the next `<available_skills>` message in
  the transcript reflects the derived preset.
- Load a skill → its row in the Skills tab turns green within 3 s.
- Attach a team → `conductor-protocol` appears in the catalog on the next
  step; a conductor `Edit` turns the Conductor practice red with the call listed.
- Edit on `main` in the primary checkout → Worktree red: "N file mutations on
  protected branch main in the primary checkout".
- `gh pr create` in a Bash result → PR practice green with the URL.
- Change an upstream skill (or point a source at a fork) → **Check for updates**
  flags it; **Update** installs it and keeps the previous version in `history`.

## Roadmap

Phase 2 — shipped: per-session presets, stage suggestions, plan drift,
experiments (see above).
Phase 3 — shipped: worktree lifecycle, strict catalog (composition recipe;
no harness change), hooks export, replay evals.
Phase 4 — shipped: `ctx.agentTeams` consumer, SDLC team templates, insight →
skill, pruning hints, export/import.
Phase 5 — shipped: doctor, impact view, experiments aggregation, lint,
placement, why-trace.
Phase 7 — shipped: flows, the stage control in the composer row (header chip
removed), start-only suggestion, health as a gate report, the browser stage,
and three false-positive fixes (fresh worktrees are never swept; a read-only
`cd` does not move the work root; docs are not code).

## Development

```sh
npm run build      # tsc -> lib/  +  tsdown -> lib/client.js
npm test           # builds, then node --test (~220 tests incl. the executed client artifact)
npm run test:ui    # Playwright against the browser stage (below)
npm run stage      # serve the stage at http://127.0.0.1:4173/?fixture=green
npm run stage:fixtures   # regenerate stage/fixtures/*.json from the real host service
npm run typecheck
npm run gen:examples
```

### The browser stage

`test/client.test.mjs` drives the bundle with a fake React and proves what it
*registers*; it cannot prove a popover is visible or that an outside click
closes it — which is how the header chip shipped with its popover 0 % visible
inside a clipped header. `stage/` is a fake shell that mounts the **real**
`lib/client.js` exactly as the page does (loader handoff, real React 18, DOM
regions named like the slots, a `position: fixed` overlay layer) over a
fixture-driven RPC stub. Pick a scenario with `?fixture=green|red-worktree|
explore|start-suggestion`; Playwright specs in `stage/tests/` click, measure
visibility *after ancestor clipping*, and screenshot. Every UI change lands with
a passing spec there.

`lib/` is gitignored on purpose: a stale client bundle fails silently, because
the browser loads whatever is on disk without complaint. `tsconfig.build.json`
`paths` point at a local harness checkout for **types only**; `lib/host/**`
imports only `node:*` and relative paths — verified by
`grep -hE "^import .* from '[^.]" lib/host/*.js`.
