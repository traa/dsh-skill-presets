import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBundle, validateBundle, planImport, applyImport, readLocalSkill } from '../lib/host/bundle.js'

const preset = (id, refs) => ({ id, title: id, stage: 'build', summary: 's', skills: refs.map(ref => ({ ref })), createdAt: 'a', updatedAt: 'b', builtin: true })
const locked = (source, dir, name) => ({ source, dir, name, description: 'd', digest: 'x', normalized: false, commit: 'abc1234', installedAt: 't', files: 1 })
const sources = [{ id: 'up', title: 'Up', kind: 'github', repo: 'o/r', enabled: true }, { id: 'local', title: 'Local', kind: 'local', enabled: true }, { id: 'other', title: 'O', kind: 'github', repo: 'o/o', enabled: true }]

test('export takes only referenced sources/lock entries, strips builtin, and carries local skill bodies', async () => {
  const bundle = await exportBundle({
    presetIds: ['a'],
    presets: [preset('a', ['up/x', 'local/mine']), preset('b', ['other/y'])],
    overlays: [],
    sources,
    lock: { version: 1, sources: {}, skills: [locked('up', 'x', 'x'), locked('local', 'mine', 'mine'), locked('other', 'y', 'y')] },
    readLocal: async dir => ({ 'SKILL.md': `---\nname: ${dir}\ndescription: d\n---\nbody` }),
    now: new Date('2026-06-01T00:00:00Z'),
  })
  assert.deepEqual(bundle.presets.map(p => p.id), ['a'])
  assert.equal(bundle.presets[0].builtin, undefined)
  assert.deepEqual(bundle.sources.map(s => s.id).sort(), ['local', 'up'])
  assert.deepEqual(bundle.lock.map(l => `${l.source}/${l.dir}`).sort(), ['local/mine', 'up/x'])
  assert.match(bundle.localSkills.mine['SKILL.md'], /name: mine/)
  await assert.rejects(exportBundle({ presetIds: ['zzz'], presets: [], overlays: [], sources, lock: { version: 1, sources: {}, skills: [] }, readLocal: async () => ({}) }), /unknown preset/)
  assert.doesNotThrow(() => validateBundle(JSON.parse(JSON.stringify(bundle))))
  assert.throws(() => validateBundle({ version: 2 }), /not a dsh-skill-presets bundle/)
})

test('planImport reports collisions per mode, new sources disabled, installs pinned, local writes; apply performs it', async () => {
  const bundle = validateBundle({
    version: 1, exportedAt: 't',
    presets: [preset('build', ['up/x', 'local/mine']), preset('fresh', ['new/z'])],
    overlays: [],
    sources: [sources[0], { id: 'new', title: 'New', kind: 'github', repo: 'n/n', enabled: true }],
    lock: [locked('new', 'z', 'z')],
    localSkills: { mine: { 'SKILL.md': '---\nname: mine\ndescription: d\n---\nbody' } },
  })
  const ctx = { presets: [preset('build', ['up/x'])], sources: [sources[0], sources[1]], lock: { version: 1, sources: {}, skills: [locked('up', 'x', 'x')] } }
  const skip = planImport(bundle, ctx)
  assert.deepEqual(skip.presets.map(p => [p.id, p.action]), [['build', 'skip'], ['fresh', 'create']])
  assert.deepEqual(skip.collisions, ['build'])
  assert.deepEqual(skip.newSources.map(s => [s.id, s.enabled]), [['new', false]])
  assert.deepEqual(skip.toInstall, [{ source: 'new', dir: 'z', pinnedCommit: 'abc1234' }])
  assert.deepEqual(skip.localSkills, [{ dir: 'mine', action: 'write' }])
  assert.deepEqual(skip.problems, [])
  assert.deepEqual(planImport(bundle, { ...ctx, onCollision: 'replace' }).presets[0], { id: 'build', from: 'build', action: 'replace' })
  assert.deepEqual(planImport(bundle, { ...ctx, onCollision: 'rename' }).presets[0], { id: 'build-imported', from: 'build', action: 'create' })
  const bad = planImport(validateBundle({ ...bundle, presets: [preset('needs', ['local/ghost'])] }), ctx)
  assert.match(bad.problems[0], /local skill ghost is referenced but not included/)

  const lib = await mkdtemp(join(tmpdir(), 'skp-bundle-'))
  const saved = []; const synced = []; let savedSources
  const result = await applyImport(bundle, planImport(bundle, { ...ctx, onCollision: 'rename' }), {
    savePreset: async p => { saved.push(p.id) }, saveSources: async s => { savedSources = s }, libraryRoot: lib,
    sync: async (source, dirs) => { synced.push([source.id, source.enabled, dirs]) }, sources: ctx.sources,
  })
  assert.deepEqual(saved, ['build-imported', 'fresh'])
  assert.deepEqual(synced, [['new', true, ['z']]])
  assert.equal(savedSources.find(s => s.id === 'new').enabled, false, 'added disabled; enabled only for the pinned install')
  assert.match(await readFile(join(lib, 'local', 'mine', 'SKILL.md'), 'utf8'), /name: mine/)
  assert.deepEqual(result.written, ['local/mine', 'preset build-imported', 'preset fresh'])
  assert.deepEqual(await readLocalSkill(lib, 'mine'), { 'SKILL.md': '---\nname: mine\ndescription: d\n---\nbody' })
})

// docs/sdlc/show-me-skill/spec.md data model: sources arriving through a bundle
// pass the same validation as sources.json before they are saved or synced.
test('planImport/applyImport validate bundle pick sources: unsafe or malformed picks are never added or synced', async () => {
  const { SkillPresetsService } = await import('../lib/host/service.js')
  const pickSource = (id, skills) => ({ id, title: id, kind: 'github', repo: `o/${id}`, ref: 'main', skills, enabled: true })
  const bundle = validateBundle({
    version: 1, exportedAt: 't',
    presets: [preset('fresh', ['safe/ok', 'unsafe/x', 'malformed/y'])],
    overlays: [],
    sources: [
      pickSource('safe', [{ path: 'skills/ok' }]),
      pickSource('unsafe', [{ path: '../../outside/x' }]),
      pickSource('malformed', 'skills/y'),
    ],
    lock: [],
    localSkills: {},
  })
  const root = await mkdtemp(join(tmpdir(), 'skp-bundle-pick-'))
  const service = new SkillPresetsService({ root: () => root })
  await service.saveSources([sources[1]])
  const ctx = { presets: [], sources: await service.sources(), lock: { version: 1, sources: {}, skills: [] } }

  const plan = planImport(bundle, ctx)
  assert.deepEqual(plan.newSources.map(s => s.id), ['safe'], 'only the safe pick source is added')
  assert.equal(plan.newSources[0].enabled, false, 'added disabled')
  assert.deepEqual(plan.newSources[0].skills, [{ path: 'skills/ok' }], 'its pick is kept')

  const synced = []
  await applyImport(bundle, plan, {
    savePreset: async () => {}, saveSources: s => service.saveSources(s), libraryRoot: join(root, 'library'),
    sync: async (source, dirs) => { synced.push([source.id, dirs]) }, sources: ctx.sources,
  })
  const saved = new Set((await service.sources()).map(s => s.id))
  assert.ok(saved.has('safe'))
  for (const [id] of synced) assert.ok(saved.has(id), `sync ran for "${id}", which is not in sources.json, so its lock entries would have no source`)
  assert.ok(!synced.some(([id]) => id === 'unsafe' || id === 'malformed'))
})

// Review round 2: an invalid source is a BLOCKING problem (the bundle/apply RPC
// refuses while plan.problems is non-empty), so the message must say so.
test('an invalid bundle source is a problem that says it blocks the import', () => {
  const bundle = validateBundle({
    version: 1, exportedAt: 't', presets: [preset('fresh', ['bad/x'])], overlays: [],
    sources: [{ id: 'bad', title: 'bad', kind: 'github', repo: 'o/bad', ref: 'main', skills: [{ path: '../x' }], enabled: true }],
    lock: [], localSkills: {},
  })
  const plan = planImport(bundle, { presets: [], sources: [sources[1]], lock: { version: 1, sources: {}, skills: [] } })
  assert.ok(plan.problems.length > 0, 'the plan carries a blocking problem')
  const problem = plan.problems.find(p => p.includes('"bad"'))
  assert.ok(problem, `the problem names the source: ${plan.problems.join(' | ')}`)
  // Spec B4 2b (round 3): the same text serves the bundle/plan preview and apply.
  assert.match(problem, /blocks the import/i)
  assert.deepEqual(plan.newSources, [])
})
