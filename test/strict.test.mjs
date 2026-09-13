import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StrictCatalog, canRestrict } from '../lib/host/strict.js'

function fakeCtx() {
  const calls = []
  const disposed = []
  return {
    calls, disposed,
    ctx: { skills: { restrict: (f) => { calls.push(f); const id = calls.length; return () => disposed.push(id) } } },
  }
}

test('canRestrict feature-detects on direct and get() shaped contexts', () => {
  assert.ok(canRestrict({ skills: { restrict() {} } }))
  assert.ok(canRestrict({ get: (n) => n === 'skills' ? { restrict() {} } : undefined }))
  assert.ok(!canRestrict({ skills: {} }))
  assert.ok(!canRestrict(undefined))
})

test('apply is idempotent for an unchanged set and swaps (dispose then register) on change', () => {
  const { ctx, calls, disposed } = fakeCtx()
  const strict = new StrictCatalog()
  assert.equal(strict.apply('s', ctx, ['b', 'a']), 'applied')
  assert.deepEqual(calls[0], { allow: ['b', 'a'] })
  assert.equal(strict.apply('s', ctx, ['a', 'b']), 'unchanged', 'order does not matter')
  assert.equal(calls.length, 1)
  assert.equal(strict.apply('s', ctx, ['a']), 'applied')
  assert.deepEqual(disposed, [1]); assert.equal(calls.length, 2)
  strict.release('s')
  assert.deepEqual(disposed, [1, 2])
  assert.ok(!strict.isApplied('s'))
  strict.release('s') // no throw
})

test('an empty set still narrows (sentinel allow) and a missing seam reports unsupported', () => {
  const { ctx, calls } = fakeCtx()
  const strict = new StrictCatalog()
  assert.equal(strict.apply('s', ctx, []), 'applied')
  assert.deepEqual(calls[0], { allow: ['no-inherited-skills'] })
  assert.equal(new StrictCatalog().apply('t', { skills: {} }, ['a']), 'unsupported')
  const log = []
  const throwing = { skills: { restrict: () => { throw new Error('unscoped') } } }
  assert.equal(new StrictCatalog(m => log.push(m)).apply('u', throwing, ['a']), 'unsupported')
  assert.match(log[0], /unscoped/)
})
