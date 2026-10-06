import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSet, validatePreset, splitRef, validatePresetsFile } from '../lib/host/presets.js'
import { StorePaths } from '../lib/host/store.js'
import { CURATED_PRESETS, CURATED_OVERLAYS, CURATED_SOURCES } from '../lib/host/curated.js'

async function store(skills) {
  const root = await mkdtemp(join(tmpdir(), 'skp-p-'))
  const paths = new StorePaths(root)
  const lock = { version: 1, sources: {}, skills: [] }
  for (const [source, dir, name, extra = {}] of skills) {
    const d = paths.skillDir(source, dir)
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: desc of ${name}\nwhen-to-use: when ${name}\n---\nbody ${name}`)
    lock.skills.push({ source, dir, name, description: `desc of ${name}`, digest: name, normalized: false, commit: 'c', installedAt: 'now', files: 1, ...extra })
  }
  return { paths, lock }
}

test('splitRef', () => {
  assert.deepEqual(splitRef('a/b'), { source: 'a', dir: 'b' })
  assert.equal(splitRef('a'), undefined)
  assert.equal(splitRef('a/'), undefined)
})

test('curated presets validate against an empty lock (structure only)', () => {
  for (const preset of CURATED_PRESETS) assert.deepEqual(validatePreset(preset), [], preset.id)
})

test('duplicate exposed names are a validation error, fixed by an alias', async () => {
  const { lock } = await store([['s1', 'tdd', 'test-driven-development'], ['s2', 'test-driven-development', 'test-driven-development']])
  const preset = { ...CURATED_PRESETS[0], skills: [{ ref: 's1/tdd' }, { ref: 's2/test-driven-development' }] }
  const problems = validatePreset(preset, lock)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /exposed name "test-driven-development"/)
  const fixed = { ...preset, skills: [{ ref: 's1/tdd' }, { ref: 's2/test-driven-development', as: 'tdd-superpowers' }] }
  assert.deepEqual(validatePreset(fixed, lock), [])
})

test('resolveSet exposes installed skills, aliases, overlay provenance, and reports unresolved', async () => {
  const { paths, lock } = await store([
    ['s1', 'a', 'alpha'],
    ['s1', 'b', 'beta'],
    ['s1', 'gone', 'gone', { orphaned: true }],
    ['local', 'conductor-protocol', 'conductor-protocol'],
  ])
  const preset = { ...CURATED_PRESETS[0], skills: [{ ref: 's1/a' }, { ref: 's1/b', as: 'beta-alias', whenToUse: 'extra' }, { ref: 's1/missing' }, { ref: 's1/gone' }] }
  const overlay = { id: 'team', title: 'Team', when: 'always', enabled: true, skills: [{ ref: 'local/conductor-protocol' }] }
  const res = await resolveSet(paths, lock, preset, [overlay])
  assert.deepEqual(res.skills.map(s => s.name), ['alpha', 'beta-alias', 'conductor-protocol'])
  const beta = res.skills.find(s => s.name === 'beta-alias')
  assert.equal(beta.whenToUse, 'when beta extra')
  assert.equal(beta.via, 'preset')
  assert.deepEqual(res.skills.find(s => s.name === 'conductor-protocol').via, { overlay: 'team' })
  assert.deepEqual(res.unresolved.map(u => [u.ref, u.reason]), [['s1/missing', 'not installed'], ['s1/gone', 'orphaned upstream (files kept)']])
})

test('an overlay skill colliding with a preset skill is dropped and reported', async () => {
  const { paths, lock } = await store([['s1', 'a', 'alpha'], ['s2', 'a2', 'alpha']])
  const preset = { ...CURATED_PRESETS[0], skills: [{ ref: 's1/a' }] }
  const res = await resolveSet(paths, lock, preset, [{ id: 'o', title: 'o', when: 'always', enabled: true, skills: [{ ref: 's2/a2' }] }])
  assert.equal(res.skills.length, 1)
  assert.deepEqual(res.collisions, ['alpha'])
})

test('curated refs all point at declared sources', () => {
  const ids = new Set(CURATED_SOURCES.map(s => s.id))
  for (const preset of CURATED_PRESETS) for (const s of preset.skills) assert.ok(ids.has(splitRef(s.ref).source), s.ref)
  for (const o of CURATED_OVERLAYS) for (const s of o.skills) assert.ok(ids.has(splitRef(s.ref).source), s.ref)
})

test('curated humanlayer-skills source picks only show-me, on main, credited to HumanLayer', () => {
  const source = CURATED_SOURCES.find(s => s.id === 'humanlayer-skills')
  assert.ok(source, 'CURATED_SOURCES must carry humanlayer-skills')
  assert.equal(source.kind, 'github')
  assert.equal(source.repo, 'humanlayer/skills')
  assert.equal(source.ref, 'main')
  assert.deepEqual(source.skills, [{ path: 'plugins/show-me/skills/show-me' }])
  assert.equal(source.enabled, true)
  assert.match(source.note ?? '', /Dex Horthy/)
  assert.match(source.note ?? '', /HumanLayer/)
})

test('curated recommended overlay is always on and carries humanlayer-skills/show-me without overriding upstream invocation', () => {
  const overlay = CURATED_OVERLAYS.find(o => o.id === 'recommended')
  assert.ok(overlay, 'CURATED_OVERLAYS must carry recommended')
  assert.equal(overlay.when, 'always')
  assert.equal(overlay.enabled, true)
  const entry = overlay.skills.find(s => s.ref === 'humanlayer-skills/show-me')
  assert.ok(entry, 'recommended must carry humanlayer-skills/show-me')
  // Upstream's `disable-model-invocation: true` is kept: the curated entry adds no invocation override.
  for (const key of Object.keys(entry)) assert.ok(['ref', 'as', 'whenToUse'].includes(key), `unexpected key ${key}`)
  assert.ok(CURATED_SOURCES.some(s => s.id === splitRef(entry.ref).source), 'the overlay ref resolves to a curated source')
})

test('validatePresetsFile tolerates junk entries', () => {
  const out = validatePresetsFile([{ id: 'ok', skills: [{ ref: 'a/b' }, 'junk'] }, 'junk', { skills: [] }])
  assert.equal(out.length, 1)
  assert.equal(out[0].skills.length, 1)
  assert.throws(() => validatePresetsFile({}), /array/)
})

test('mattpocock-skills/pr drives the PR body wherever pr-always opens one', () => {
  const refs = skills => skills.map(s => s.ref)
  for (const id of ['build', 'test-review', 'deploy']) {
    const skills = refs(CURATED_PRESETS.find(p => p.id === id).skills)
    assert.ok(skills.includes('mattpocock-skills/pr'), `${id} must carry the pr skill`)
    assert.ok(skills.indexOf('mattpocock-skills/pr') < skills.indexOf('local/pr-always'), `${id}: pr before pr-always`)
  }
  const git = refs(CURATED_OVERLAYS.find(o => o.id === 'git-repo').skills)
  assert.ok(git.includes('mattpocock-skills/pr'), 'git-repo overlay must carry the pr skill')
})
