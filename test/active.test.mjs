import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateActive, resolveActive, pruneSessions, defaultActive } from '../lib/host/store.js'
import { SkillPresetsService } from '../lib/host/service.js'

test('a Phase-1 v1 document migrates to v2 as the workspace default', () => {
  const doc = validateActive({ version: 1, preset: 'build', since: 's', by: 'ui' })
  assert.equal(doc.version, 2)
  assert.equal(doc.default, 'build')
  assert.deepEqual(doc.sessions, {})
  assert.equal(doc.by, 'ui')
})

test('resolution order: session → agent-preset → default; explicit null at a nearer rung wins', () => {
  const doc = {
    ...defaultActive(),
    default: 'plan',
    byAgentPreset: { cordis: 'design', ptc: null },
    sessions: { s1: { preset: 'build', since: 's', by: 'ui' }, s2: { preset: null, since: 's', by: 'ui' } },
  }
  assert.deepEqual(resolveActive(doc, 's1', 'cordis'), { preset: 'build', source: 'session' })
  assert.deepEqual(resolveActive(doc, 's2', 'cordis'), { preset: null, source: 'session' })
  assert.deepEqual(resolveActive(doc, 's9', 'cordis'), { preset: 'design', source: 'agent-preset' })
  assert.deepEqual(resolveActive(doc, 's9', 'ptc'), { preset: null, source: 'agent-preset' })
  assert.deepEqual(resolveActive(doc, 's9', 'standard'), { preset: 'plan', source: 'default' })
  assert.deepEqual(resolveActive(doc), { preset: 'plan', source: 'default' })
})

test('pruning drops only sessions disposed past retention', () => {
  const now = new Date('2026-03-10T00:00:00Z')
  const doc = {
    ...defaultActive(),
    sessions: {
      live: { preset: 'a', since: 's', by: 'ui' },
      fresh: { preset: 'a', since: 's', by: 'ui', disposedAt: '2026-03-09T00:00:00Z' },
      stale: { preset: 'a', since: 's', by: 'ui', disposedAt: '2026-03-01T00:00:00Z' },
    },
  }
  assert.deepEqual(Object.keys(pruneSessions(doc, now).sessions).sort(), ['fresh', 'live'])
})

test('service.activate at each scope; deletePreset clears every rung; sessionDisposed starts the clock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skp-act-'))
  let clock = new Date('2026-03-01T00:00:00Z')
  const svc = new SkillPresetsService({ root: () => root, now: () => clock })
  await svc.ensure()
  // The curated presets reference upstream skills that are not installed here,
  // but activation validates structure only (dup names), not installation.
  assert.deepEqual(await svc.activate('plan', 'cli'), { from: null, to: 'plan', scope: 'default' })
  assert.deepEqual(await svc.activate('build', 'ui', { sessionId: 'S' }), { from: 'plan', to: 'build', scope: 'session' })
  assert.deepEqual(await svc.activate('design', 'ui', { scope: 'agent-preset', agentPreset: 'cordis' }), { from: 'plan', to: 'design', scope: 'agent-preset' })
  assert.equal((await svc.activePreset({ id: 'S' })).id, 'build')
  assert.equal((await svc.activePreset({ id: 'other', agentPreset: 'cordis' })).id, 'design')
  assert.equal((await svc.activePreset({ id: 'other' })).id, 'plan')
  assert.equal(await svc.activeStage({ id: 'S' }), 'build')
  await assert.rejects(svc.activate('nope', 'ui'), /does not exist/)
  await assert.rejects(svc.activate('plan', 'ui', { scope: 'session' }), /needs a sessionId/)

  await svc.clearSession('S')
  assert.equal((await svc.activePreset({ id: 'S' })).id, 'plan')

  await svc.activate('build', 'ui', { sessionId: 'S' })
  await svc.duplicatePreset('build', 'build-x')
  await svc.activate('build-x', 'ui', { sessionId: 'T' })
  await svc.deletePreset('build-x')
  assert.equal((await svc.active()).sessions.T.preset, null)

  await svc.sessionDisposed('S')
  assert.ok((await svc.active()).sessions.S.disposedAt !== undefined)
  clock = new Date('2026-03-20T00:00:00Z')
  await svc.sessionDisposed('unknown')
  assert.equal((await svc.active()).sessions.S, undefined, 'stale session pruned')
})
