import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectStage, suggest, shouldSuggest, recordDismissal, recordAcceptance, emptySuggestions, MUTE_AFTER } from '../lib/host/stage.js'

const facts = (over = {}) => ({ inRepo: true, gitAvailable: true, ghAvailable: true, artifacts: [], instructionFiles: [], readAt: 'r', ...over })
const edit = { t: 't', turn: 1, name: 'edit', target: 'src/a.ts', isError: false }
const bash = cmd => ({ t: 't', turn: 1, name: 'bash', target: cmd, isError: false })

// Phase 7: detection reads ARTIFACTS and PR state only. Shell verbs
// (`kubectl apply`, `git revert`) and edit counts are gone: a deploy command in
// a grep, a revert of a typo, three edits — none of those are the human
// deciding to change stage, and mid-session pulses were the complaint.
test('the stage is read from committed artifacts and PR state, never from shell verbs or edit counts', () => {
  assert.equal(detectStage(undefined).stage, 'plan')
  assert.ok(detectStage(undefined).confidence < 0.7)
  assert.deepEqual([detectStage(facts()).stage, detectStage(facts()).confidence], ['plan', 0.5])
  assert.equal(detectStage(facts({ artifacts: ['docs/sdlc/x/intent.md'] })).stage, 'design')
  assert.equal(detectStage(facts({ artifacts: ['docs/sdlc/x/intent.md', 'docs/sdlc/x/spec.md'] })).confidence, 0.8)
  const build = detectStage(facts({ artifacts: ['docs/sdlc/x/plan.md'] }), [edit])
  assert.equal(build.stage, 'build')
  assert.equal(build.confidence, detectStage(facts({ artifacts: ['docs/sdlc/x/plan.md'] })).confidence, 'edits do not raise confidence')
  assert.equal(detectStage(facts({ artifacts: ['plan.md'], pr: { url: 'u', state: 'OPEN' } })).stage, 'test')
  assert.equal(detectStage(facts({ pr: { url: 'u', state: 'MERGED' } })).stage, 'deploy')
  assert.equal(detectStage(facts({ artifacts: ['docs/sdlc/incidents/2026-01-01-x.md'] })).stage, 'maintain')
  assert.equal(detectStage(facts(), [bash('kubectl rollout status deploy/x')]).stage, 'plan', 'a shell verb is not a stage')
  assert.equal(detectStage(facts(), [bash('git revert HEAD # rollback')]).stage, 'plan')
})

// Start-only: the suggestion is offered when the session has no explicit
// position yet, and again when the CURRENT stage's gate artifact appears
// (the playbook's "an accepted artifact fires the next gate"). Never because
// time passed, edits happened, or a command ran.
test('shouldSuggest: at session start, and when the current gate artifact lands — not otherwise', () => {
  const before = facts({ artifacts: ['docs/sdlc/x/intent.md'] })
  const after = facts({ artifacts: ['docs/sdlc/x/intent.md', 'docs/sdlc/x/spec.md'] })
  assert.equal(shouldSuggest({ explicitPosition: false, stage: 'plan', previous: undefined, facts: before }), true, 'no explicit position yet → offer')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'plan', previous: before, facts: before }), false, 'nothing changed')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'design', previous: before, facts: after }), true, 'spec.md is Design\'s gate: it just appeared')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'build', previous: before, facts: after }), false, 'spec.md is not Build\'s gate')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'test', previous: facts({ artifacts: ['plan.md'] }), facts: facts({ artifacts: ['plan.md'], pr: { url: 'u', state: 'OPEN' } }) }), true, 'the PR is Review\'s gate')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: null, previous: before, facts: after }), false, 'Explore never suggests')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'design', previous: undefined, facts: after }), false, 'first facts read with an explicit position is not "an artifact appeared"')
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
