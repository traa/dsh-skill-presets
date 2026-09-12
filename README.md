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
| **Settings → Skills** | left nav | **Stages & presets** (the six-stage loop; activate/edit/duplicate), **Library** (sources, install/update, per-skill drawer with normalized diff badge), **Practices** (off/advisory/hard per practice), **Insights** (load rate, co-usage map, unknown-skill requests, per-model split, recent sessions) |
| **Header chip** | session header, right | `◈ Build` + a traffic-light dot for the worst practice; click → switch preset, see overlays and practice evidence |
| **Skills tab** | right sidebar | live scorecard for THIS session: stage & artifacts, practices with evidence, every offered skill with load count and first-load turn, a per-turn timeline, 👍/👎 rating |
| **Plugin card** | Settings → Plugins | store path, active preset, counts |
| Tools | model | `skill_preset_status`, `sdlc_status`, `skill_preset_suggest` (deterministic; never switches) |
| Prompt | model | a ≤ 8-line block: active preset + skill names, artifacts present, practices **at risk** with the skill that fixes each. Empty when all green. |

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
project's `.dsh/skills` stay visible. **Strict** mode (Practices tab) denies a
`skill` call for a name outside the set with a reason; hiding them from the
catalog too needs the in-tree `SkillRestriction` seam (roadmap, phase 3).

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
from recorded logs.

| Practice | Green | Red | Unknown (amber) |
|---|---|---|---|
| Work in a worktree | linked worktree, or a non-protected branch | a write/edit/mutating bash on a protected branch in the primary checkout | git unavailable |
| Always open a PR | `gh pr create` / `glab mr create` ran, a PR/MR URL appeared in any tool result, or `gh pr view` finds one | session ended ahead of upstream with no PR, or never pushed | no forge CLI and no upstream |
| Follow the conductor protocol | delegations, no self-edits | conductor wrote/edited files; delegated before a user approval turn; ended with zero delegations | — |
| Commit the stage artifact | the active stage's artifact exists | Build/Test without `plan.md`, Design without `intent.md` | — |
| Plan before code | `plan.md` present before the first edit in Build | edited with no `plan.md` | — |

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
active.json      # { preset, since, by }
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
dsh-skill-presets status | install [source…] | update [source…] | check [source…]
                  | activate <id|none> | summary <usage.jsonl> | rollup
```

## Acceptance checklist

- Switch preset in the header chip → the next `<available_skills>` message in
  the transcript reflects it.
- Load a skill → its row in the Skills tab turns green within 3 s.
- Attach a team → `conductor-protocol` appears in the catalog on the next
  step; a conductor `Edit` turns the Conductor practice red with the call listed.
- Edit on `main` in the primary checkout → Worktree red: "N file mutations on
  protected branch main in the primary checkout".
- `gh pr create` in a Bash result → PR practice green with the URL.
- Change an upstream skill (or point a source at a fork) → **Check for updates**
  flags it; **Update** installs it and keeps the previous version in `history`.

## Roadmap

Phase 2 — per-session presets (the provider already receives `scope`; this is a
data change), auto stage detection that *suggests* the next preset, plan-drift
watch on `tools/post-execute`, A/B fork with a different preset.
Phase 3 — in-tree `ctx.skills.restrict()` mirroring `tools.restrict()` for a
truly strict catalog, hard-gate practices, optional export of the same
detectors to both shipped hook bridges (`dsh-hooks-claude-code`,
`dsh-hooks-codex`), session-replay evals re-run when a skill/practice changes.
Phase 4 — `dsh-agent-teams` publishing an `agentTeams` service + SDLC team
templates, promote a `dsh-knowledge` insight to a local skill, stale-skill
pruning, preset export/import.

## Development

```sh
npm run build      # tsc -> lib/  +  tsdown -> lib/client.js
npm test           # builds, then node --test (49 tests incl. the executed client artifact)
npm run typecheck
npm run gen:examples
```

`lib/` is gitignored on purpose: a stale client bundle fails silently, because
the browser loads whatever is on disk without complaint. `tsconfig.build.json`
`paths` point at a local harness checkout for **types only**; `lib/host/**`
imports only `node:*` and relative paths — verified by
`grep -hE "^import .* from '[^.]" lib/host/*.js`.
