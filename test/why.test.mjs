import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize, practicesAt, practiceDeltaAround } from '../lib/host/telemetry.js'

const E = [
  { t: '2026-01-01T00:00:01Z', kind: 'practice', id: 'worktree', status: 'red', evidence: [] },
  { t: '2026-01-01T00:00:02Z', kind: 'loaded', name: 'worktree-first', turn: 1, ok: true, chars: 10, userLine: 'fix the login bug', mentioned: true },
  { t: '2026-01-01T00:00:03Z', kind: 'practice', id: 'worktree', status: 'green', evidence: [] },
  { t: '2026-01-01T00:00:04Z', kind: 'practice', id: 'pull-request', status: 'amber', evidence: [] },
  { t: '2026-01-01T00:00:05Z', kind: 'loaded', name: 'pr-always', turn: 3, ok: true, chars: 10, mentioned: false },
  { t: '2026-01-01T00:00:06Z', kind: 'practice', id: 'pull-request', status: 'green', evidence: [] },
]

test('summary carries userLine/mentioned on loads and a practice timeline', () => {
  const s = summarize('x', E)
  assert.deepEqual(s.loads.map(l => [l.name, l.userLine, l.mentioned]), [['worktree-first', 'fix the login bug', true], ['pr-always', undefined, false]])
  assert.equal(s.practiceTimeline.length, 4)
})

test('practicesAt and practiceDeltaAround reconstruct before/after around a load', () => {
  const s = summarize('x', E)
  assert.deepEqual(practicesAt(s.practiceTimeline, '2026-01-01T00:00:02Z'), { worktree: 'red' })
  const first = practiceDeltaAround(s.practiceTimeline, s.loads[0].t, s.loads[1].t)
  assert.deepEqual(first, [{ id: 'worktree', from: 'red', to: 'green' }, { id: 'pull-request', to: 'amber' }])
  const second = practiceDeltaAround(s.practiceTimeline, s.loads[1].t)
  assert.deepEqual(second, [{ id: 'pull-request', from: 'amber', to: 'green' }])
})
