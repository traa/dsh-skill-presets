import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pruningReport, presetSkillUsage } from '../lib/host/pruning.js'

const session = (preset, offered, loadedNames) => ({ sessionId: 's', preset, overlays: [], offered, loaded: Object.fromEntries(loadedNames.map(n => [n, { count: 1, firstTurn: 1, chars: 1, lastAt: 't' }])), unknown: [], practices: [], denied: 0, drift: [], suggestions: [], switches: [], loads: [] })
const preset = (id, refs) => ({ id, title: id, stage: 'build', summary: '', skills: refs.map(ref => ({ ref })), createdAt: 'a', updatedAt: 'b' })

test('presetSkillUsage counts offered/loaded per preset', () => {
  const u = presetSkillUsage([session('build', ['a', 'b'], ['a']), session('build', ['a', 'b'], []), session('plan', ['a'], ['a'])])
  assert.deepEqual(u.get('build').get('a'), { offered: 2, loaded: 1 })
  assert.deepEqual(u.get('build').get('b'), { offered: 2, loaded: 0 })
  assert.deepEqual(u.get('plan').get('a'), { offered: 1, loaded: 1 })
})

test('stale needs minSessions and a low rate; missing needs minUnknown and no preset with that name', () => {
  const sessions = [
    ...Array.from({ length: 25 }, (_, i) => session('build', ['alpha', 'beta'], i < 2 ? ['alpha', 'beta'] : ['alpha'])),
    ...Array.from({ length: 5 }, () => session('plan', ['gamma'], [])),
  ]
  const rollup = { version: 1, updatedAt: '', sessions: 30, skills: {}, presets: {}, practices: {}, unknownRequests: { ghost: 5, alpha: 4, once: 1, 'in-lib': 3 }, coUsage: {}, byModel: {}, suggestions: { suggested: 0, accepted: 0, dismissed: 0, acceptMsSum: 0 } }
  const report = pruningReport({
    presets: [preset('build', ['s/alpha', 's/beta']), preset('plan', ['s/gamma'])],
    sessions, rollup,
    installed: new Map([['alpha', 's/alpha'], ['beta', 's/beta'], ['gamma', 's/gamma'], ['in-lib', 's/in-lib']]),
    inPresets: new Set(['alpha', 'beta', 'gamma']),
    discovered: [{ source: 'up', skills: [{ dir: 'ghost', path: 'skills/ghost', files: [] }] }],
  })
  assert.deepEqual(report.stale.map(s => [s.preset, s.name, s.offered, s.loaded]), [['build', 'beta', 25, 2]], 'beta: 2/25 = 8% ≤ 10%; gamma: only 5 sessions')
  assert.deepEqual(report.missing.map(m => [m.name, m.count, m.inLibrary, m.upstream?.length]), [['ghost', 5, undefined, 1], ['in-lib', 3, 's/in-lib', undefined]], 'alpha exists in a preset (wrong preset, not missing); once < minUnknown')
  const strict = pruningReport({ presets: [preset('build', ['s/alpha', 's/beta'])], sessions, rollup, installed: new Map(), inPresets: new Set(), thresholds: { minSessions: 100 } })
  assert.equal(strict.stale.length, 0)
})
