import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foundationReport, adoptFoundation } from '../lib/host/foundation.js'
import { CURATED_PRESETS, CURATED_OVERLAYS } from '../lib/host/curated.js'

const preset = (id, skills = [], overrides = {}) => ({
  id, title: id, stage: 'build', summary: 'sum', color: 'red',
  skills, createdAt: 'a', updatedAt: 'b', builtin: true, ...overrides
})
const overlay = (id, skills = [], overrides = {}) => ({
  id, title: id, when: 'now', skills, enabled: true, ...overrides
})
const ref = (id, as) => as ? { ref: id, as } : { ref: id }

test('foundationReport returns status diffs and counts for presets and overlays', () => {
  const shippedP = [
    preset('p-new', [ref('up/a')]),
    preset('p-up', [ref('up/a'), ref('up/b')]),
    preset('p-cust', [ref('up/a'), ref('up/b')]),
    preset('p-cur', [ref('up/a')])
  ]
  const storedP = [
    preset('p-up', [ref('up/a')]),
    preset('p-cust', [ref('up/a'), ref('user/x')], { title: 'Edited' }),
    preset('p-cur', [ref('up/a')]),
    preset('p-loc', [ref('loc/a')])
  ]
  const shippedO = [
    overlay('o-new', [ref('up/a')])
  ]
  const storedO = [
    overlay('o-loc', [ref('loc/a')])
  ]

  const report = foundationReport(shippedP, storedP, shippedO, storedO)
  
  assert.equal(report.added, 2)
  assert.equal(report.updatable, 1)
  assert.equal(report.customized, 1)

  assert.deepEqual(report.diffs.find(d => d.id === 'p-new'), {
    kind: 'preset', id: 'p-new', title: 'p-new', status: 'new',
    missingSkills: ['up/a'], extraSkills: [], changedFields: []
  })
  assert.deepEqual(report.diffs.find(d => d.id === 'p-up'), {
    kind: 'preset', id: 'p-up', title: 'p-up', status: 'updatable',
    missingSkills: ['up/b'], extraSkills: [], changedFields: []
  })
  assert.deepEqual(report.diffs.find(d => d.id === 'p-cust'), {
    kind: 'preset', id: 'p-cust', title: 'Edited', status: 'customized',
    missingSkills: ['up/b'], extraSkills: ['user/x'], changedFields: ['title']
  })
  assert.deepEqual(report.diffs.find(d => d.id === 'p-cur'), {
    kind: 'preset', id: 'p-cur', title: 'p-cur', status: 'current',
    missingSkills: [], extraSkills: [], changedFields: []
  })
  assert.deepEqual(report.diffs.find(d => d.id === 'p-loc'), {
    kind: 'preset', id: 'p-loc', title: 'p-loc', status: 'local',
    missingSkills: [], extraSkills: [], changedFields: []
  })
})

test('adoptFoundation merges missing skills, keeps user edits, and is idempotent', () => {
  const shippedP = [
    preset('p-new', [ref('up/a')]),
    preset('p-up', [ref('up/a'), ref('up/b'), ref('up/c')]),
    preset('p-cust', [ref('up/a'), ref('up/b')]),
  ]
  const storedP = [
    preset('p-up', [ref('up/a')]),
    preset('p-cust', [ref('up/a'), ref('user/x')], { title: 'Edited' }),
    preset('p-loc', [ref('loc/a')])
  ]
  const shippedO = [
    overlay('o-up', [ref('up/a'), ref('up/b')])
  ]
  const storedO = [
    overlay('o-up', [ref('up/a'), ref('user/y')], { enabled: false, when: 'never' }),
    overlay('o-loc', [ref('loc/a')])
  ]

  const report = foundationReport(shippedP, storedP, shippedO, storedO)
  const now = () => '2026-09-14T00:00:00.000Z'
  
  const res1 = adoptFoundation(report, shippedP, storedP, shippedO, storedO, undefined, now)
  
  // p-new is appended
  const pNew = res1.presets.find(p => p.id === 'p-new')
  assert.deepEqual(pNew.skills, [{ ref: 'up/a' }])
  
  // p-up gets missing skills in shipped order, local left alone
  const pUp = res1.presets.find(p => p.id === 'p-up')
  assert.deepEqual(pUp.skills, [{ ref: 'up/a' }, { ref: 'up/b' }, { ref: 'up/c' }])
  assert.equal(pUp.updatedAt, '2026-09-14T00:00:00.000Z')
  
  // p-cust gets missing skills before user extras, keeps title edit
  const pCust = res1.presets.find(p => p.id === 'p-cust')
  assert.deepEqual(pCust.skills, [{ ref: 'up/a' }, { ref: 'up/b' }, { ref: 'user/x' }])
  assert.equal(pCust.title, 'Edited')
  
  // p-loc is untouched
  const pLoc = res1.presets.find(p => p.id === 'p-loc')
  assert.deepEqual(pLoc.skills, [{ ref: 'loc/a' }])

  // o-up gets missing skills, keeps enabled: false and when: never
  const oUp = res1.overlays.find(o => o.id === 'o-up')
  assert.deepEqual(oUp.skills, [{ ref: 'up/a' }, { ref: 'up/b' }, { ref: 'user/y' }])
  assert.equal(oUp.enabled, false)
  assert.equal(oUp.when, 'never')
  
  // o-loc is untouched
  const oLoc = res1.overlays.find(o => o.id === 'o-loc')
  assert.deepEqual(oLoc.skills, [{ ref: 'loc/a' }])

  // local never appears in applied
  assert.equal(res1.applied.some(a => a.id === 'p-loc' || a.id === 'o-loc'), false)
  
  // test only filter
  const resOnly = adoptFoundation(report, shippedP, storedP, shippedO, storedO, ['p-up'], now)
  assert.deepEqual(resOnly.applied.map(a => a.id), ['p-up'])
  
  // idempotent
  const report2 = foundationReport(shippedP, res1.presets, shippedO, res1.overlays)
  const res2 = adoptFoundation(report2, shippedP, res1.presets, shippedO, res1.overlays, undefined, now)
  assert.equal(res2.applied.length, 0)
  assert.deepEqual(res2.presets, res1.presets)
  assert.deepEqual(res2.overlays, res1.overlays)
})

test('regression: stale curated store marks git-repo updatable and adoptFoundation restores refs', () => {
  const staleGitRepo = {
    ...CURATED_OVERLAYS.find(o => o.id === 'git-repo'),
    skills: CURATED_OVERLAYS.find(o => o.id === 'git-repo').skills.filter(s => s.ref !== 'local/worktree-cleanup' && s.ref !== 'local/post-merge-sync')
  }
  const storedOverlays = CURATED_OVERLAYS.map(o => o.id === 'git-repo' ? staleGitRepo : o)
  
  const report = foundationReport(CURATED_PRESETS, CURATED_PRESETS, CURATED_OVERLAYS, storedOverlays)
  const diff = report.diffs.find(d => d.id === 'git-repo')
  
  assert.equal(diff.status, 'updatable')
  assert.deepEqual(diff.missingSkills, ['local/worktree-cleanup', 'local/post-merge-sync'])
  
  const res = adoptFoundation(report, CURATED_PRESETS, CURATED_PRESETS, CURATED_OVERLAYS, storedOverlays)
  const updatedGitRepo = res.overlays.find(o => o.id === 'git-repo')
  assert.deepEqual(updatedGitRepo.skills, CURATED_OVERLAYS.find(o => o.id === 'git-repo').skills)
})

test('short collapses whitespace, trims, and truncates', async () => {
  const { short } = await import('../lib/host/practices/detectors.js')
  assert.equal(short('  hello   world  '), 'hello world')
  assert.equal(short('a\nb\r\nc'), 'a b c')
  
  const long = 'a'.repeat(5000)
  const result = short(long)
  assert.equal(result.length, 121)
  assert.ok(result.endsWith('…'))
  assert.equal(result.slice(0, 120), 'a'.repeat(120))
  
  const custom = short('hello world', 5)
  assert.equal(custom, 'hello…')
})
