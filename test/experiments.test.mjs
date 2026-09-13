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
