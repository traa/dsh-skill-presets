import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarize, rollupOf, parseEvents, Telemetry } from '../lib/host/telemetry.js'
import { StorePaths } from '../lib/host/store.js'

const S1 = [
  { t: '2026-01-01T00:00:00Z', kind: 'session', cwd: '/w' },
  { t: '2026-01-01T00:00:01Z', kind: 'provider', provider: 'deepseek', model: 'v4' },
  { t: '2026-01-01T00:00:02Z', kind: 'offered', preset: 'build', overlays: ['git-repo'], skills: ['a', 'b', 'c'] },
  { t: '2026-01-01T00:00:03Z', kind: 'loaded', name: 'a', turn: 1, ok: true, chars: 400 },
  { t: '2026-01-01T00:00:04Z', kind: 'loaded', name: 'a', turn: 2, ok: true, chars: 400 },
  { t: '2026-01-01T00:00:05Z', kind: 'loaded', name: 'b', turn: 3, ok: true, chars: 100 },
  { t: '2026-01-01T00:00:06Z', kind: 'loaded', name: 'zzz', turn: 3, ok: false, unknown: true, chars: 0 },
  { t: '2026-01-01T00:00:07Z', kind: 'practice', id: 'worktree', status: 'red', evidence: ['e'] },
  { t: '2026-01-01T00:00:08Z', kind: 'practice', id: 'worktree', status: 'green', evidence: ['fixed'] },
  { t: '2026-01-01T00:00:09Z', kind: 'rated', preset: 'build', rating: 1 },
]
const S2 = [
  { t: '2026-01-02T00:00:00Z', kind: 'provider', provider: 'anthropic', model: 'x' },
  { t: '2026-01-02T00:00:01Z', kind: 'offered', preset: 'build', overlays: [], skills: ['a', 'b'] },
  { t: '2026-01-02T00:00:02Z', kind: 'practice', id: 'worktree', status: 'amber', evidence: [] },
]

test('summarize folds loads, unknown requests, last practice status, rating, provider', () => {
  const s = summarize('s1', S1)
  assert.equal(s.preset, 'build')
  assert.deepEqual(s.overlays, ['git-repo'])
  assert.deepEqual(s.offered, ['a', 'b', 'c'])
  assert.equal(s.loaded.a.count, 2); assert.equal(s.loaded.a.firstTurn, 1); assert.equal(s.loaded.a.chars, 800)
  assert.deepEqual(s.unknown, ['zzz'])
  assert.deepEqual(s.practices, [{ id: 'worktree', status: 'green', evidence: ['fixed'] }])
  assert.equal(s.rating, 1)
  assert.equal(s.provider, 'deepseek')
  assert.equal(s.loads.length, 4)
})

test('rollup computes load rates, co-usage, unknown requests, practice buckets, per-model split, coverage', () => {
  const r = rollupOf([summarize('s1', S1), summarize('s2', S2)], new Date('2026-01-03T00:00:00Z'))
  assert.equal(r.sessions, 2)
  assert.equal(r.skills.a.sessionsOffered, 2); assert.equal(r.skills.a.sessionsLoaded, 1); assert.equal(r.skills.a.loads, 2)
  assert.equal(r.skills.c.sessionsOffered, 1); assert.equal(r.skills.c.sessionsLoaded, 0)
  assert.deepEqual(r.coUsage, { 'a|b': 1 })
  assert.deepEqual(r.unknownRequests, { zzz: 1 })
  assert.deepEqual(r.practices.worktree, { green: 1, amber: 1, red: 0, na: 0 })
  assert.equal(r.byModel['deepseek/v4'].loads, 3)
  assert.equal(r.byModel['anthropic/x'].sessions, 1)
  assert.equal(r.presets.build.sessions, 2)
  assert.equal(r.presets.build.ratingSum, 1)
  // s1 loaded 2 of 3 offered, s2 0 of 2 → coverageSum = 0.666…
  assert.ok(Math.abs(r.presets.build.coverageSum - 2 / 3) < 1e-9)
})

test('parseEvents skips torn or junk lines', () => {
  const events = parseEvents('{"kind":"session","t":"x"}\n{"kind":"loaded"\n\n"str"\n{"kind":"rated","t":"y","rating":1}\n')
  assert.equal(events.length, 2)
})

test('Telemetry appends, reads back, and rebuilds the rollup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skp-tel-'))
  const paths = new StorePaths(root)
  const tel = new Telemetry(paths, () => {}, () => new Date('2026-02-02T00:00:00Z'))
  tel.record('sess/1', { kind: 'offered', preset: 'plan', overlays: [], skills: ['x'] })
  tel.record('sess/1', { kind: 'loaded', name: 'x', turn: 1, ok: true, chars: 10 })
  await tel.flush()
  const events = await tel.events('sess/1')
  assert.equal(events.length, 2)
  assert.equal(events[0].t, '2026-02-02T00:00:00.000Z')
  const rollup = await tel.rebuildRollup()
  assert.equal(rollup.sessions, 1)
  assert.equal(rollup.skills.x.loads, 1)
  const recent = await tel.recentSessions()
  assert.equal(recent[0].sessionId, 'sess_1')
  assert.equal((await tel.rollup()).sessions, 1)
})
