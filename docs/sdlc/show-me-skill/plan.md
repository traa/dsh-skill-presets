# Plan: add one skill from a GitHub link, and recommend `show-me`

Spec: [spec.md](./spec.md). Intent: [intent.md](./intent.md).
Base: `6dd859a` on `feat/show-me-skill`, worktree `../dsh-skill-presets-show-me`.

## Order of work (one writer at a time)

| # | Owner | Step | Files | Proof |
|---|---|---|---|---|
| 0 | conductor | Baseline test count, `npm run build` and `npm test` green at base | none | recorded in the red commit message |
| 1 | test-engineer | **Red.** Tests pinning B1–B7 and success criteria 1–6; each must fail for the missing behaviour | `test/*.test.mjs` only (new `test/skillpick.test.mjs`; additions to `presets.test.mjs`, `client.test.mjs`, `examples.test.mjs` if that is where the drift test lives) | `npm test` red for the named tests, existing tests still pass |
| 2 | developer | **Green A (host).** Type, validation, schema, `parseSkillUrl`, `pickSkills`, library discovery, `addSkillFromUrl`, RPC, CLI | `src/host/types.ts`, `src/host/github.ts`, `src/host/library.ts`, `src/host/service.ts`, `src/host/schema.ts`, `src/host/index.ts`, `src/bin/cli.ts` | host tests green |
| 3 | developer | **Green B (client).** Type, controller method, Sources view input and button | `src/client/api.ts`, `src/client/controller.ts`, `src/client/views.ts` | client tests green |
| 4 | developer | **Green C (data).** Curated source and overlay, regenerate examples, README, stage fixtures if they embed sources/overlays | `src/host/curated.ts`, `examples/*.json`, `README.md`, `stage/fixtures/*.json` | drift test green |
| 5 | conductor | Gate: fresh build, typecheck, full tests; count ≥ baseline + new; drive the real render path | none | evidence in the PR body |
| 6 | conductor | Install `show-me` into the live workbench with the new CLI (`add-skill`) | `~/.dsh/settings-repo/skills/*` (data, not source) | `lock.json` lists `humanlayer-skills/show-me` |
| 7 | adversarial-reviewer | Fresh review of base…HEAD | none | findings |

Steps 2–4 are separate developer deliveries and separate commits (`feat(skill-pick): host`,
`…: client`, `…: data`), so a review can read them in slices. A step does not start before
the previous one is committed.

## Design notes the developer must follow
- One discovery helper in `library.ts`, used by `sync` AND `check`; `index.ts:932` (the
  "missing skills" scan over github sources) uses the same helper. Three call sites
  today call `discoverSkills(tree.entries, source.paths ?? ['skills'])` directly:
  `library.ts:138`, `library.ts:266`, `index.ts:932`. Leaving one on the old path is the
  most likely defect.
- `SkillSource` is declared twice (`src/host/types.ts`, `src/client/api.ts`); update both.
- `sources.schema.json` has `additionalProperties: false`, so `skills` must be added to
  the schema in `schema.ts` or every generated example fails validation.
- `validateSourcesFile` whitelists fields; without a change it silently drops `skills`
  on save, which would turn a pick source into a whole-repo source on the next write.
- `addSkillFromUrl` does read-modify-write on `sources.json`; keep it in one
  `service` method so the check and the write are not split across awaits of other callers.
- No casts to silence the checker. The existing `as never` at `index.ts:723` is not
  yours to fix.

## Riskiest step
Step 2's discovery switch. A pick source that falls back to scanning `paths` would
install every skill in `humanlayer/skills`. The red tests include a fake tree with
sibling skills for exactly this reason.

## Options rejected
- `kind: 'github-skill'` per skill: touches every `kind` branch and multiplies sources.
- Scanning to arbitrary depth: cannot say "only this one" and would change what existing
  sources install.
- Pinning the commit sha from the link: the user chose to follow the branch.

## Out of scope
Playwright tests; adopting curated sources into existing workbenches (spec B7); branch
names containing `/`.
