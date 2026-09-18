// Flows: an ordered subset of stages a piece of work passes through. The
// session's position is `{ flow, stage }`; the PRESET is derived from the
// stage, so the provider, prompt block, and tools keep their shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_FLOWS, validateFlows, validateFlow, presetForStage, positionOf, nextStage, stageOfPreset, gateFor, flowsDoc } from '../lib/host/flows.js'
import { CURATED_PRESETS } from '../lib/host/curated.js'

const full = BUILTIN_FLOWS.find(f => f.id === 'full')
const explore = BUILTIN_FLOWS.find(f => f.id === 'explore')

test('built-in flows: Full walks the playbook loop; Explore has no stages and guardrails off', () => {
  assert.deepEqual(full.stages, ['plan', 'design', 'build', 'test', 'deploy'])
  assert.equal(full.guardrails, 'on')
  assert.equal(full.builtin, true)
  assert.deepEqual(explore.stages, [])
  assert.equal(explore.guardrails, 'off')
  for (const f of BUILTIN_FLOWS) assert.deepEqual(validateFlow(f), [], f.id)
})

test('validateFlow: id shape, at least a title, known stages in order, no duplicates', () => {
  assert.deepEqual(validateFlow({ id: 'fix', title: 'Fix', stages: ['build', 'test'], guardrails: 'on' }), [])
  assert.match(validateFlow({ id: 'Bad Id', title: 'x', stages: [], guardrails: 'on' })[0], /id/)
  assert.match(validateFlow({ id: 'x', title: '', stages: [], guardrails: 'on' })[0], /title/)
  assert.match(validateFlow({ id: 'x', title: 'x', stages: ['nope'], guardrails: 'on' })[0], /stage/)
  assert.match(validateFlow({ id: 'x', title: 'x', stages: ['build', 'build'], guardrails: 'on' })[0], /twice/)
  assert.match(validateFlow({ id: 'x', title: 'x', stages: ['build'], guardrails: 'maybe' })[0], /guardrails/)
})

test('validateFlows: tolerates junk, always re-seeds the built-ins, keeps custom order', () => {
  const out = validateFlows([{ id: 'fix', title: 'Fix', stages: ['build', 'test'], guardrails: 'on' }, 'junk', { id: 'full', title: 'Renamed Full', stages: ['build'], guardrails: 'off' }])
  assert.deepEqual(out.map(f => f.id), ['full', 'explore', 'fix'])
  // A built-in may be renamed and have its stages edited, but stays built-in.
  const editedFull = out.find(f => f.id === 'full')
  assert.equal(editedFull.title, 'Renamed Full')
  assert.deepEqual(editedFull.stages, ['build'])
  assert.equal(editedFull.builtin, true)
  assert.throws(() => validateFlows({}), /array/)
})

test('flowsDoc: the persisted shape carries a version and the flows', () => {
  const doc = flowsDoc(BUILTIN_FLOWS)
  assert.equal(doc.version, 1)
  assert.deepEqual(doc.flows.map(f => f.id), ['full', 'explore'])
})

test('presetForStage: exactly one owner → that preset; a pin wins a collision; none → undefined', () => {
  const presets = CURATED_PRESETS
  assert.equal(presetForStage('build', presets)?.id, 'build')
  assert.equal(presetForStage('test', presets)?.id, 'test-review')
  assert.equal(presetForStage('cross', presets), undefined, 'cross-stage presets are never a stage owner')
  const two = [...presets, { ...presets.find(p => p.id === 'build'), id: 'build-strict', title: 'Build (strict)' }]
  const collision = presetForStage('build', two)
  assert.equal(collision, undefined, 'two owners and no pin: the caller must ask')
  assert.equal(presetForStage('build', two, { build: 'build-strict' })?.id, 'build-strict')
  assert.deepEqual(presetForStage.ownersOf('build', two).map(p => p.id), ['build', 'build-strict'])
})

test('stageOfPreset: the inverse, for migrating a session that only knows its preset', () => {
  assert.equal(stageOfPreset('test-review', CURATED_PRESETS), 'test')
  assert.equal(stageOfPreset('delegate', CURATED_PRESETS), 'cross')
  assert.equal(stageOfPreset('nope', CURATED_PRESETS), undefined)
})

test('positionOf / nextStage: where a stage sits in a flow, and what follows', () => {
  assert.deepEqual(positionOf(full, 'build'), { index: 2, of: 5 })
  assert.equal(positionOf(full, 'maintain'), undefined, 'a stage the flow does not include has no position')
  assert.equal(nextStage(full, 'build'), 'test')
  assert.equal(nextStage(full, 'deploy'), undefined, 'the last stage has no next')
  assert.equal(nextStage(explore, null), undefined)
  assert.equal(positionOf(explore, null), undefined)
})

test('gateFor: the artifact that ends a stage, from the playbook', () => {
  assert.equal(gateFor('plan'), 'intent.md')
  assert.equal(gateFor('design'), 'spec.md')
  assert.equal(gateFor('build'), 'plan.md')
  assert.equal(gateFor('test'), 'PR')
  assert.equal(gateFor('deploy'), 'merge')
  assert.equal(gateFor('maintain'), 'incident record')
  assert.equal(gateFor('cross'), undefined)
})

// ------------------------------------------------------------ positions ----
import { validatePositions, defaultPositions, resolvePosition, positionFromPreset, moveTo, switchFlow } from '../lib/host/flows.js'

test('positions: default doc, validation tolerates junk, resolution order session → agent-preset → default', () => {
  const d = defaultPositions()
  assert.deepEqual(d.default, { flow: 'full', stage: 'plan' })
  const v = validatePositions({ version: 1, default: { flow: 'fix', stage: 'build' }, byAgentPreset: { cordis: { flow: 'explore', stage: 'nonsense' } }, sessions: { s1: { flow: 'full', stage: 'test', since: 'x' }, junk: 'junk' } })
  assert.deepEqual(v.byAgentPreset.cordis, { flow: 'explore', stage: null }, 'an unknown stage becomes null, not a crash')
  assert.deepEqual(Object.keys(v.sessions), ['s1'])
  assert.deepEqual(resolvePosition(v, 's1', 'cordis'), { position: { flow: 'full', stage: 'test' }, source: 'session' })
  assert.deepEqual(resolvePosition(v, 'other', 'cordis'), { position: { flow: 'explore', stage: null }, source: 'agent-preset' })
  assert.deepEqual(resolvePosition(v, 'other', 'standard'), { position: { flow: 'fix', stage: 'build' }, source: 'default' })
  assert.throws(() => validatePositions(null), /object/)
})

test('positionFromPreset: a pre-flows preset choice lands in Full at its stage; none → Explore; cross → Full/Build', () => {
  assert.deepEqual(positionFromPreset('test-review', CURATED_PRESETS), { flow: 'full', stage: 'test' })
  assert.deepEqual(positionFromPreset(null, CURATED_PRESETS), { flow: 'explore', stage: null })
  assert.deepEqual(positionFromPreset('delegate', CURATED_PRESETS), { flow: 'full', stage: 'build' })
  assert.deepEqual(positionFromPreset('gone', CURATED_PRESETS), { flow: 'full', stage: 'build' })
})

test('moveTo refuses a stage outside the flow; switchFlow keeps the stage when it can', () => {
  assert.deepEqual(moveTo(full, 'test'), { flow: 'full', stage: 'test' })
  assert.throws(() => moveTo(full, 'maintain'), /not in flow/)
  assert.throws(() => moveTo(explore, 'build'), /no stages/)
  assert.deepEqual(moveTo(explore, null), { flow: 'explore', stage: null })
  const fix = { id: 'fix', title: 'Fix', stages: ['build', 'test'], guardrails: 'on' }
  assert.deepEqual(switchFlow(fix, { flow: 'full', stage: 'test' }), { flow: 'fix', stage: 'test' })
  assert.deepEqual(switchFlow(fix, { flow: 'full', stage: 'plan' }), { flow: 'fix', stage: 'build' }, 'stage not in the new flow → its first')
  assert.deepEqual(switchFlow(explore, { flow: 'full', stage: 'plan' }), { flow: 'explore', stage: null })
  assert.deepEqual(switchFlow(full, { flow: 'explore', stage: null }), { flow: 'full', stage: 'plan' })
})

// ------------------------------------------------------------ service ------
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillPresetsService } from '../lib/host/service.js'

test('service: positions drive presets; legacy preset choices read as Full at their stage; Explore clears the preset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skp-flow-'))
  let clock = new Date('2026-09-18T12:00:00Z')
  const svc = new SkillPresetsService({ root: () => root, now: () => clock })
  await svc.ensure()
  assert.deepEqual((await svc.flows()).map(f => f.id), ['full', 'explore'], 'built-ins seeded')

  // Fresh store: default rung is Full/Plan → the DERIVED preset is plan, while
  // active.json still says "nothing active" until something is set — the
  // provider path is unchanged for existing installs.
  let pos = await svc.positionFor({ id: 'S' })
  assert.equal(pos.flow.id, 'full'); assert.equal(pos.stage, 'plan'); assert.equal(pos.presetId, 'plan'); assert.equal(pos.source, 'default')
  assert.equal(await svc.activePreset({ id: 'S' }), undefined)

  // Human moves the session to Build: preset follows at the SESSION rung only.
  const moved = await svc.setPosition({ sessionId: 'S' }, { stage: 'build' }, 'ui')
  assert.equal(moved.presetId, 'build')
  assert.equal((await svc.activePreset({ id: 'S' })).id, 'build')
  assert.equal(await svc.activePreset({ id: 'other' }), undefined, 'default rung untouched')
  pos = await svc.positionFor({ id: 'S' })
  assert.equal(pos.stage, 'build'); assert.equal(pos.source, 'session')

  // A stage outside the flow is refused.
  await assert.rejects(svc.setPosition({ sessionId: 'S' }, { stage: 'maintain' }, 'ui'), /not in flow/)

  // Switching to Explore: no stage, no preset, guardrails off.
  const ex = await svc.setPosition({ sessionId: 'S' }, { flow: 'explore' }, 'ui')
  assert.equal(ex.stage, null); assert.equal(ex.presetId, null)
  assert.equal(await svc.activePreset({ id: 'S' }), undefined)
  assert.equal((await svc.positionFor({ id: 'S' })).flow.guardrails, 'off')

  // Back to Full keeps nothing to keep → first stage.
  assert.equal((await svc.setPosition({ sessionId: 'S' }, { flow: 'full' }, 'ui')).stage, 'plan')

  // Legacy: a session with an explicit preset but no position reads as Full at that stage.
  await svc.activate('test-review', 'ui', { sessionId: 'L' })
  const legacy = await svc.positionFor({ id: 'L' })
  assert.equal(legacy.source, 'legacy'); assert.equal(legacy.flow.id, 'full'); assert.equal(legacy.stage, 'test'); assert.equal(legacy.presetId, 'test-review')

  // Custom flow: Fix = Build → Review; switching keeps Build; deleting it remaps to Full.
  await svc.saveFlow({ id: 'fix', title: 'Fix', stages: ['build', 'test'], guardrails: 'on' })
  await svc.setPosition({ sessionId: 'S' }, { stage: 'build' }, 'ui')
  assert.equal((await svc.setPosition({ sessionId: 'S' }, { flow: 'fix' }, 'ui')).stage, 'build')
  await assert.rejects(svc.deleteFlow('full'), /built in/)
  await svc.deleteFlow('fix')
  pos = await svc.positionFor({ id: 'S' })
  assert.equal(pos.flow.id, 'full'); assert.equal(pos.stage, 'build')

  // Collision: two presets own Build and the flow pins none → presetId undefined, owners listed; a pin resolves it.
  await svc.duplicatePreset('build', 'build-strict')
  pos = await svc.positionFor({ id: 'S' })
  assert.equal(pos.presetId, 'build', 'the last explicit choice still wins an unpinned collision')
  await svc.setPosition({ sessionId: 'S' }, { stage: 'build', pin: 'build-strict' }, 'ui')
  assert.equal((await svc.activePreset({ id: 'S' })).id, 'build-strict')
  assert.deepEqual((await svc.positionFor({ id: 'S' })).owners.sort(), ['build', 'build-strict'])

  // Dispose + retention prunes positions with active.json.
  await svc.sessionDisposed('S')
  assert.ok((await svc.positions()).sessions.S.disposedAt !== undefined)
  clock = new Date('2026-10-01T00:00:00Z')
  await svc.sessionDisposed('unknown')
  assert.equal((await svc.positions()).sessions.S, undefined)
  await svc.clearSession('L')
  assert.equal((await svc.positionFor({ id: 'L' })).source, 'default')
})

// Acceptance §10.1: a brand-new session on a fresh store is Full at Plan — the
// control reads "Plan" — and Explore is one move away with no preset and no
// judged practice. Also the default rung: "what a new session starts in".
test('acceptance: a fresh store puts a new session in Full/Plan; the workspace default can be moved to Explore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skp-fresh-'))
  const svc = new SkillPresetsService({ root: () => root, now: () => new Date('2026-09-18T12:00:00Z') })
  await svc.ensure()
  const fresh = await svc.positionFor({ id: 'brand-new' })
  assert.equal(fresh.flow.id, 'full'); assert.equal(fresh.stage, 'plan'); assert.equal(fresh.presetId, 'plan'); assert.equal(fresh.source, 'default')
  assert.equal((await svc.practices()).autoCleanWorktrees, false, '§10.4: auto-clean is off in a fresh store')
  // Workspace default → Explore: every NEW session now starts there.
  await svc.setPosition({ scope: 'default' }, { flow: 'explore' }, 'ui')
  const next = await svc.positionFor({ id: 'another-new' })
  assert.equal(next.flow.id, 'explore'); assert.equal(next.stage, null); assert.equal(next.presetId, undefined); assert.equal(next.flow.guardrails, 'off')
  assert.equal(await svc.activePreset({ id: 'another-new' }), undefined)
  // Agent-preset rung wins over the workspace default.
  await svc.setPosition({ scope: 'agent-preset', agentPreset: 'cordis' }, { flow: 'full', stage: 'build' }, 'ui')
  const cordis = await svc.positionFor({ id: 'x', agentPreset: 'cordis' })
  assert.equal(cordis.stage, 'build'); assert.equal(cordis.source, 'agent-preset'); assert.equal(cordis.presetId, 'build')
  assert.equal((await svc.positionFor({ id: 'x', agentPreset: 'standard' })).flow.id, 'explore')
})
