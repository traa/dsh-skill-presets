# Intent: install a single GitHub skill, and ship `show-me` as the first one

## Problem
A skill source in this plugin is a whole repository: `SkillSource` carries `repo` and
`paths`, and `discoverSkills` takes every `<root>/<name>/SKILL.md` exactly one level under
those roots. There is no way to say "install this one skill from that repo". The skill the
user wants, `humanlayer/skills` → `plugins/show-me/skills/show-me/SKILL.md`, sits in a
repo whose other skills are not wanted, at a depth (`plugins/<plugin>/skills/<name>`)
that no curated source uses.

## Outcome
1. A mechanism to add ONE skill from GitHub given the link to its `SKILL.md`
   (`https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md`), through the same
   surfaces sources already have: the store file, the RPC, the CLI, and the UI.
2. `show-me` (Dex Horthy / HumanLayer) installed through that mechanism and recommended:
   carried by an always-on overlay, so every conversation under this plugin lists it.
3. Upstream behaviour kept: the file sets `disable-model-invocation: true`, so `show-me`
   is user-invoked (the user chose this explicitly). It is visible, not auto-offered.

## Constraints
- Provider-neutral; no vendor names in presets.
- Existing whole-repo sources, locks and exports keep working unchanged (stored data is
  plain JSON in the workbench; old files must still validate).
- Network only on explicit install/check; tests never touch the network (`FetchLike`).
- `examples/`, the JSON Schema and `curated.ts` are one declaration; the drift test
  must stay green.
- Never merge; the work ends in a reviewed PR.

## Evidence
- `src/host/github.ts` `discoverSkills`: `parts.length !== 2` ⇒ one level only.
- `src/host/library.ts` `sync`/`check`: both call `discoverSkills(tree.entries, source.paths ?? ['skills'])`.
- `src/host/service.ts` `validateSourcesFile`: whitelists the fields a source may carry.
- `src/host/frontmatter.ts`: `disable-model-invocation: true` ⇒ `modelInvocable: false`.
- Template for "recommend a skill": PR #32 (`fea4f0c`) touching `curated.ts`, `examples/`, README, a test, fixtures.

## Who asked
The user, in the session; confirmed design answers: always-on overlay, user-invoked.
