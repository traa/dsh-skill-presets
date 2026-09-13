import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Experiments } from '../lib/host/experiments.js'
import { StorePaths } from '../lib/host/store.js'

test('fork pins the child preset BEFORE recording and links parent/child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skp-exp-'))
  const paths = new StorePaths(root)
  const ex = new Experiments(() => paths, () => new Date('2026-04-01T00:00:00Z'))
  const order = []
  const forker = { fork: async ({ sessionId }) => { order.push(`fork:${sessionId}`); return { sessionId: 'child-1' } } }
  const e = await ex.fork(forker, 'parent-1', 'build', 'design', async (child) => { order.push(`pin:${child}`) }, { note: 'compare design vs build' })
  assert.deepEqual(order, ['fork:parent-1', 'pin:child-1'])
  assert.equal(e.parent, 'parent-1'); assert.equal(e.child, 'child-1'); assert.equal(e.childPreset, 'design'); assert.equal(e.parentPreset, 'build')
  assert.equal((await ex.forSession('child-1')).length, 1)
  assert.equal((await ex.forSession('nobody')).length, 0)
  assert.equal((await ex.list())[0].note, 'compare design vs build')
})

test('a failed fork records nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skp-exp-'))
  const ex = new Experiments(() => new StorePaths(root))
  await assert.rejects(ex.fork({ fork: async () => { throw new Error('open turn') } }, 'p', null, 'x', async () => {}), /open turn/)
  assert.equal((await ex.list()).length, 0)
})

test('aggregateExperiments judges each pair and totals per preset pair regardless of direction', async () => {
  const { aggregateExperiments } = await import('../lib/host/experiments.js')
  const S = (id, preset, green, pr) => ({ sessionId: id, preset, overlays: [], offered: [], loaded: {}, unknown: [], denied: 0, drift: [], suggestions: [], switches: [], loads: [], practices: [{ id: 'worktree', status: green ? 'green' : 'red', evidence: [] }, { id: 'pull-request', status: pr, evidence: [] }] })
  const ex = [
    { id: 'e1', parent: 'p1', child: 'c1', parentPreset: 'build', childPreset: 'design', at: '2026-01-02' },
    { id: 'e2', parent: 'p2', child: 'c2', parentPreset: 'design', childPreset: 'build', at: '2026-01-03' },
    { id: 'e3', parent: 'p3', child: 'c3', parentPreset: 'build', childPreset: 'design', at: '2026-01-01' },
    { id: 'orphan', parent: 'zz', child: 'yy', parentPreset: 'a', childPreset: 'b', at: 't' },
  ]
  const summaries = [S('p1', 'build', true, 'green'), S('c1', 'design', false, 'red'), S('p2', 'design', true, 'green'), S('c2', 'build', true, 'red'), S('p3', 'build', true, 'green'), S('c3', 'design', true, 'green')]
  const { results, pairs } = aggregateExperiments(ex, summaries)
  assert.deepEqual(results.map(r => [r.experiment.id, r.winner]), [['e2', 'parent'], ['e1', 'parent'], ['e3', null]], 'newest first; orphan skipped')
  assert.match(results[0].why, /all green: 1 vs 0/, 'c2 has a red PR practice, so it is not all-green')
  assert.deepEqual(pairs, [{ a: 'build', b: 'design', experiments: 3, aWins: 1, bWins: 1, ties: 1 }], 'e1 build wins, e2 design wins (parent, flipped), e3 tie')
})
