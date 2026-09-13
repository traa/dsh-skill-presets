import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outcomes, skillImpact, presetImpact, sessionVsPeers, MIN_SAMPLE } from '../lib/host/impact.js'

const S = (id, { preset = 'build', offered = ['a', 'b'], loaded = [], green = true, pr = 'green', rating, drift = 0, denied = 0, lastAt = '2026-01-01' } = {}) => ({
  sessionId: id, preset, overlays: [], offered,
  loaded: Object.fromEntries(loaded.map(n => [n, { count: 1, firstTurn: 1, chars: 1, lastAt: 't' }])),
  unknown: [], denied, drift: Array.from({ length: drift }, (_, i) => `f${i}`), suggestions: [], switches: [], loads: [],
  practices: [{ id: 'worktree', status: green ? 'green' : 'red', evidence: [] }, { id: 'pull-request', status: pr, evidence: [] }],
  ...(rating !== undefined ? { rating } : {}), lastAt,
})

test('outcomes: rates over judged sessions only; rating over rated only; empty group has no rates', () => {
  const o = outcomes([S('1', { green: true, pr: 'green', rating: 1 }), S('2', { green: false, pr: 'red' }), S('3', { green: true, pr: 'n/a', drift: 2, denied: 1 })])
  assert.equal(o.sessions, 3)
  assert.equal(o.greenRate, 2 / 3, 'sessions 1 and 3 are all green-or-n/a; session 2 has a red')
  assert.equal(o.prRate, 1 / 2, 'only two sessions judged on PR')
  assert.equal(o.meanRating, 1); assert.equal(o.rated, 1)
  assert.equal(o.meanDriftFiles, 2 / 3); assert.equal(o.meanDenied, 1 / 3)
  assert.deepEqual(outcomes([]), { sessions: 0, rated: 0 })
})

test('skillImpact splits by loaded vs not among sessions where offered; marks small samples', () => {
  const sessions = [
    ...Array.from({ length: 6 }, (_, i) => S(`w${i}`, { loaded: ['a'], green: true, pr: 'green' })),
    ...Array.from({ length: 6 }, (_, i) => S(`n${i}`, { loaded: [], green: i < 3, pr: i < 2 ? 'green' : 'red' })),
    S('x', { offered: ['b'], loaded: ['b'] }), // 'a' not offered here → excluded from a's row
  ]
  const rows = skillImpact(sessions)
  const a = rows.find(r => r.key === 'a')
  assert.equal(a.with.sessions, 6); assert.equal(a.without.sessions, 6); assert.equal(a.enough, true)
  // without: i<3 has worktree green but only i<2 has PR green → all-green = 2/6; PR green = 2/6
  assert.ok(Math.abs(a.delta.greenRate - (1 - 2 / 6)) < 1e-9); assert.ok(Math.abs(a.delta.prRate - (1 - 2 / 6)) < 1e-9)
  const b = rows.find(r => r.key === 'b')
  assert.equal(b.with.sessions, 1); assert.equal(b.enough, false)
  assert.equal(rows[0].key, 'a', 'rows with enough evidence sort first')
})

test('presetImpact compares each preset with the rest; sessionVsPeers picks the newest N same-preset peers', () => {
  const sessions = [
    ...Array.from({ length: MIN_SAMPLE }, (_, i) => S(`b${i}`, { preset: 'build', green: true, lastAt: `2026-01-0${i + 1}` })),
    ...Array.from({ length: MIN_SAMPLE }, (_, i) => S(`p${i}`, { preset: 'plan', green: false })),
  ]
  const rows = presetImpact(sessions)
  const build = rows.find(r => r.key === 'build')
  assert.equal(build.with.greenRate, 1); assert.equal(build.without.greenRate, 0); assert.equal(build.delta.greenRate, 1); assert.equal(build.enough, true)
  const me = S('b0', { preset: 'build', loaded: ['a', 'b'], drift: 1 })
  const cmp = sessionVsPeers(me, sessions, 3)
  assert.equal(cmp.peerCount, 3)
  assert.equal(cmp.current.meanLoaded, 2)
  assert.equal(cmp.peers.meanLoaded, 0)
  assert.equal(cmp.preset, 'build')
})
