import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectStage, suggest, recordDismissal, recordAcceptance, emptySuggestions, MUTE_AFTER } from '../lib/host/stage.js'

const facts = (over = {}) => ({ inRepo: true, gitAvailable: true, ghAvailable: true, artifacts: [], instructionFiles: [], readAt: 'r', ...over })
const edit = { t: 't', turn: 1, name: 'edit', target: 'src/a.ts', isError: false }
const bash = cmd => ({ t: 't', turn: 1, name: 'bash', target: cmd, isError: false })

test('each transition of the loop is detected from artifacts, PR state and commands', () => {
  assert.equal(detectStage(undefined).stage, 'plan')
  assert.ok(detectStage(undefined).confidence < 0.7)
  assert.deepEqual([detectStage(facts()).stage, detectStage(facts()).confidence], ['plan', 0.5])
  assert.equal(detectStage(facts({ artifacts: ['docs/sdlc/x/intent.md'] })).stage, 'design')
  assert.equal(detectStage(facts({ artifacts: ['docs/sdlc/x/intent.md', 'docs/sdlc/x/spec.md'] })).confidence, 0.8)
  const build = detectStage(facts({ artifacts: ['docs/sdlc/x/plan.md'] }), [edit])
  assert.equal(build.stage, 'build'); assert.equal(build.confidence, 0.9)
  assert.equal(detectStage(facts({ artifacts: ['plan.md'], pr: { url: 'u', state: 'OPEN' } })).stage, 'test')
  assert.equal(detectStage(facts({ pr: { url: 'u', state: 'MERGED' } })).stage, 'deploy')
  assert.equal(detectStage(facts(), [bash('kubectl rollout status deploy/x')]).stage, 'deploy')
  assert.equal(detectStage(facts({ artifacts: ['docs/sdlc/incidents/2026-01-01-x.md'] })).stage, 'maintain')
  assert.equal(detectStage(facts(), [bash('git revert HEAD # rollback')]).stage, 'maintain')
})

test('suggest fires only above the threshold, when the stage differs, and until muted', () => {
  const owners = new Map([['build', ['build']], ['test', ['test-review', 'qa']]])
  let doc = emptySuggestions()
  const guess = { stage: 'build', confidence: 0.9, why: ['plan.md committed'] }
  assert.equal(suggest({ ...guess, confidence: 0.6 }, 'design', owners, doc), undefined)
  assert.equal(suggest(guess, 'build', owners, doc), undefined)
  const s = suggest(guess, 'design', owners, doc)
  assert.deepEqual([s.from, s.to, s.presetId], ['design', 'build', 'build'])
  // Two owners → no presetId; the UI asks.
  assert.equal(suggest({ stage: 'test', confidence: 0.85, why: [] }, 'build', owners, doc).presetId, undefined)
  // Cross/none active stage counts as a transition from none.
  assert.equal(suggest(guess, undefined, owners, doc).from, null)
  for (let i = 0; i < MUTE_AFTER; i += 1) doc = recordDismissal(doc, 'design', 'build', new Date())
  assert.equal(suggest(guess, 'design', owners, doc), undefined, 'muted after repeated dismissals')
  assert.notEqual(suggest(guess, 'plan', owners, doc), undefined, 'a different transition is not muted')
  doc = recordAcceptance(doc, 'design', 'build')
  assert.notEqual(suggest(guess, 'design', owners, doc), undefined, 'acceptance clears the mute')
})
