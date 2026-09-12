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

test('validatePresetsFile tolerates junk entries', () => {
  const out = validatePresetsFile([{ id: 'ok', skills: [{ ref: 'a/b' }, 'junk'] }, 'junk', { skills: [] }])
  assert.equal(out.length, 1)
  assert.equal(out[0].skills.length, 1)
  assert.throws(() => validatePresetsFile({}), /array/)
})
