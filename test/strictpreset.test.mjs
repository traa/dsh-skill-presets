import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dropRowsFromYaml, renamePresetYaml, planStrictPreset, createStrictPreset, listStrictPresets, shippedPresetsDir } from '../lib/host/strictpreset.js'
import { detectStage } from '../lib/host/stage.js'

const YAML = `# header
- id: keep-a
  name: a

# The skill REGISTRY lives in the host composition and is layered per scope:
# these rows register into THIS preset's layer of it, so they need no realm.
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - ./skills

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'

- id: keep-b
  name: b
`

test('dropRowsFromYaml removes the row, its indented body, and its attached comment block; keeps neighbours', () => {
  const { text, dropped } = dropRowsFromYaml(YAML, ['skill-filesystem'])
  assert.deepEqual(dropped, ['skill-filesystem'])
  assert.ok(!text.includes('skill-filesystem'))
  assert.ok(!text.includes('customSkillDirs'))
  assert.ok(!text.includes('The skill REGISTRY'))
  assert.ok(text.includes('- id: keep-a\n  name: a'))
  assert.ok(text.includes('- id: tool-skill'))
  assert.ok(text.includes('- id: keep-b\n  name: b'))
  assert.ok(text.startsWith('# header'))
  assert.deepEqual(dropRowsFromYaml(YAML, ['nope']).dropped, [])
})

test('renamePresetYaml sets name (and description) without touching other keys', () => {
  const out = renamePresetYaml('name: 标准模式\ndescription: x\norder: 1\n', 'standard (strict skills)', 'd')
  assert.equal(out, 'name: "standard (strict skills)"\ndescription: "d"\norder: 1\n')
  assert.match(renamePresetYaml('order: 1\n', 'n'), /^name: "n"\norder: 1/)
})

test('the shipped standard preset drops exactly its skill-filesystem row (when the harness is reachable)', async (t) => {
  let dir
  try { dir = shippedPresetsDir('web') } catch { t.skip('no web profile here'); return }
  let yaml
  try { yaml = await readFile(join(dir, 'standard', 'agent.cordis.yml'), 'utf8') } catch { t.skip('standard preset not found'); return }
  const { text, dropped } = dropRowsFromYaml(yaml, ['skill-filesystem'])
  assert.deepEqual(dropped, ['skill-filesystem'])
  assert.ok(text.includes('- id: tool-skill'), 'the catalog/loader row must survive')
  assert.equal((yaml.match(/^- id: /gmu) ?? []).length - 1, (text.match(/^- id: /gmu) ?? []).length, 'exactly one row fewer')
})

test('plan + create into a temp home; refuses to overwrite; listStrictPresets finds it', async (t) => {
  let presetsDir
  try { presetsDir = shippedPresetsDir('web') } catch { t.skip('no web profile here'); return }
  const home = await mkdtemp(join(tmpdir(), 'skp-home-'))
  const env = { DSH_HOME: home }
  const plan = await planStrictPreset('standard', 'standard-strict', { presetsDir, env })
  assert.equal(plan.exists, false)
  const created = await createStrictPreset(plan, { name: 'standard (strict skills)' })
  assert.deepEqual(created.dropped, ['skill-filesystem'])
  await access(join(home, '.agent-presets', 'standard-strict', 'agent.cordis.yml'))
  assert.match(await readFile(join(home, '.agent-presets', 'standard-strict', 'preset.yml'), 'utf8'), /strict skills/)
  assert.deepEqual((await listStrictPresets(env)).map(p => p.id), ['standard-strict'])
  const again = await planStrictPreset('standard', 'standard-strict', { presetsDir, env })
  assert.equal(again.exists, true)
  await assert.rejects(createStrictPreset(again, { name: 'x' }), /already exists/)
  await assert.rejects(planStrictPreset('standard', 'Bad Id', { presetsDir, env }), /must be/)
  await assert.rejects(planStrictPreset('nope', 'x', { presetsDir, env }), /no shipped preset/)
})

// Phase 7: shell verbs NEVER set the stage. This test used to pin "deploy only
// from a real deploy verb"; now it pins the stronger rule — no command does it,
// real or not. The stage is read from artifacts and PR state, and moving is the
// human's decision.
test('stage: no shell command sets the stage, not even a real deploy or revert', () => {
  const facts = { inRepo: true, gitAvailable: true, ghAvailable: true, artifacts: [], instructionFiles: [], readAt: 'r' }
  const bash = cmd => ({ t: 't', turn: 1, name: 'bash', target: cmd, isError: false })
  for (const cmd of ['git push -q origin --delete feat/phase-2 feat/release-notes', 'git commit -m "prepare deploy docs"', 'grep -rn deploy src/', 'kubectl apply -f k8s/', 'npm test && npm publish', 'gh release create v1.2.0', 'git revert HEAD']) {
    assert.equal(detectStage(facts, [bash(cmd)]).stage, 'plan', cmd)
  }
  assert.equal(detectStage(facts, [{ t: 't', turn: 1, name: 'edit', target: '/r/deploy.ts', isError: false }]).stage, 'plan')
  // What DOES move it: artifacts and the PR.
  assert.equal(detectStage({ ...facts, pr: { url: 'u', state: 'MERGED' } }).stage, 'deploy')
  assert.equal(detectStage({ ...facts, artifacts: ['docs/sdlc/incidents/x.md'] }).stage, 'maintain')
})
