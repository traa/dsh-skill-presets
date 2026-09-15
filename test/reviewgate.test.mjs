import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReviewGate, modeFrom } from '../lib/host/practices/reviewgate.js'

function createGate(mode = 'default', now = 1000) {
  let time = now
  const gate = new ReviewGate(mode, () => {}, () => time)
  return { gate, tick: (ms) => { time += ms }, setTime: (t) => { time = t } }
}

test('Group A: DENY - Second gh pr create while a PR is unreviewed names the PR', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  const verdict = gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx)
  
  assert.equal(verdict.kind, 'deny')
  assert.ok(verdict.reason.includes('https://github.com/org/repo/pull/42'))
})

test('Group A: DENY - gh pr merge while unreviewed', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  const verdict = gate.decide('s1', 'bash', { command: 'gh pr merge' }, ctx)
  
  assert.equal(verdict.kind, 'deny')
})

test('Group A: DENY - A gh pr comment aimed at a DIFFERENT PR does not discharge', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  gate.observe('s1', 'bash', { command: 'gh pr comment 43 --body foo' }, false, '', ctx)
  const verdict = gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx)
  
  assert.equal(verdict.kind, 'deny')
})

test('Group A: DENY - A team_delegate that ERRORED does not discharge', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  gate.observe('s1', 'team_delegate', { task: 'review https://github.com/org/repo/pull/42' }, true, '', ctx)
  const verdict = gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx)
  
  assert.equal(verdict.kind, 'deny')
})

test('Group A: DENY - A team_delegate with no PR reference does not discharge', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  gate.observe('s1', 'team_delegate', { task: 'review this' }, false, '', ctx)
  const verdict = gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx)
  
  assert.equal(verdict.kind, 'deny')
})

test('Group B: ALLOW - The FIRST gh pr create', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  const verdict = gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx)
  assert.equal(verdict, undefined)
})

test('Group B: ALLOW - npm test, a file edit, and git push', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  
  assert.equal(gate.decide('s1', 'bash', { command: 'npm test' }, ctx), undefined)
  assert.equal(gate.decide('s1', 'edit', { file_path: 'foo.js' }, ctx), undefined)
  assert.equal(gate.decide('s1', 'bash', { command: 'git push' }, ctx), undefined)
})

test('Group B: ALLOW - Each discharge route allows the next create', () => {
  const ctx = { teamAttached: true }
  
  // by URL
  {
    const { gate } = createGate()
    gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
    gate.observe('s1', 'team_delegate', { task: 'review https://github.com/org/repo/pull/42' }, false, '', ctx)
    assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx), undefined)
  }
  
  // by #12
  {
    const { gate } = createGate()
    gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
    gate.observe('s1', 'team_delegate', { task: 'review #42 please' }, false, '', ctx)
    assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx), undefined)
  }
  
  // by branch name
  {
    const { gate } = createGate()
    gate.observe('s1', 'bash', { command: 'gh pr create' }, false, '', { teamAttached: true, branch: 'feat/foo' })
    gate.observe('s1', 'team_delegate', { task: 'review feat/foo' }, false, '', ctx)
    assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx), undefined)
  }
  
  // gh pr comment 42 --body ...
  {
    const { gate } = createGate()
    gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
    gate.observe('s1', 'bash', { command: 'gh pr comment 42 --body LGTM' }, false, '', ctx)
    assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx), undefined)
  }
})

test('Group B: ALLOW - session with no team attached never accrues an obligation', () => {
  const { gate } = createGate()
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', { teamAttached: false })
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, { teamAttached: false }), undefined)
})

test('Group B: ALLOW - After the TTL expires', () => {
  const { gate, tick } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  tick(7 * 60 * 60 * 1000) // > 6 hours
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx), undefined)
})

test('Group B: ALLOW - After forget()', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  gate.forget('s1')
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx), undefined)
})

test('Group C: ESCAPE - The literal phrase "no reviewer available" in the gated call allows and clears', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  const verdict = gate.decide('s1', 'bash', { command: 'gh pr merge --body "no reviewer available"' }, ctx)
  assert.equal(verdict, undefined)
  // Check it cleared
  const verdict2 = gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx)
  assert.equal(verdict2, undefined)
})

test('Group C: ESCAPE - Phrase present when PR CREATED opens no obligation at all', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create --body "no reviewer available"' }, false, 'https://github.com/org/repo/pull/42', ctx)
  const verdict = gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx)
  assert.equal(verdict, undefined)
})

test('Group C: ESCAPE - DSH_REVIEW_GATE=off and =all behave correctly', () => {
  assert.equal(modeFrom({}), 'default')
  assert.equal(modeFrom({ DSH_REVIEW_GATE: 'off' }), 'off')
  assert.equal(modeFrom({ DSH_REVIEW_GATE: 'all' }), 'all')
  
  // off
  {
    const { gate } = createGate('off')
    gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', { teamAttached: true })
    assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, { teamAttached: true }), undefined)
  }
  
  // all
  {
    const { gate } = createGate('all')
    gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', { teamAttached: false })
    assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, { teamAttached: false })?.kind, 'deny')
  }
})

test('Group D: CONTAINMENT - decide() never throws on hostile inputs', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  const hostiles = [
    null,
    42,
    'hello',
    Symbol('foo'),
    { get command() { throw new Error('boom') } },
    Object.create(null),
    { command: 'a'.repeat(200_000) }
  ]
  
  for (const h of hostiles) {
    assert.equal(gate.decide('s1', 'bash', h, ctx), undefined)
  }
})

test('Group D: CONTAINMENT - A context whose teamAttached getter THROWS degrades to allow', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx)?.kind, 'deny')
  
  const hostileCtx = { get teamAttached() { throw new Error('boom') } }
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, hostileCtx), undefined)
})

test('Group D: CONTAINMENT - After three faults isTripped is true and everything is allowed', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  gate.observe('s1', 'bash', { command: 'gh pr create' }, false, 'https://github.com/org/repo/pull/42', ctx)
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx)?.kind, 'deny')
  
  const hostileCtx = { get teamAttached() { throw new Error('boom') } }
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, hostileCtx), undefined)
  assert.equal(gate.isTripped, false)
  
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, hostileCtx), undefined)
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, hostileCtx), undefined)
  
  assert.equal(gate.isTripped, true)
  assert.equal(gate.decide('s1', 'bash', { command: 'gh pr create' }, ctx), undefined)
})

test('Group D: CONTAINMENT - observe() never throws on hostile inputs', () => {
  const { gate } = createGate()
  const ctx = { teamAttached: true }
  
  const hostiles = [
    null,
    42,
    'hello',
    Symbol('foo'),
    { get command() { throw new Error('boom') } },
    Object.create(null),
    { command: 'a'.repeat(200_000) }
  ]
  
  for (const h of hostiles) {
    gate.observe('s1', 'bash', h, false, '', ctx) // Should not throw
  }
})
