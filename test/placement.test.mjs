import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestPlacement, orphanSkills, STAGE_KEYWORDS } from '../lib/host/placement.js'
import { CURATED_PRESETS } from '../lib/host/curated.js'

test('every stage has vocabulary and the curated presets place their own local skills sensibly', () => {
  for (const stage of ['plan', 'design', 'build', 'test', 'deploy', 'maintain', 'cross']) assert.ok(STAGE_KEYWORDS[stage].length >= 5, stage)
  const top = (text) => suggestPlacement(text, CURATED_PRESETS)[0]?.preset
  assert.equal(top('worktree-first: Before editing files in a git repository, work on a feature branch in a linked worktree; commit small'), 'build')
  assert.equal(top('pr-review-against-plan: Review a pull request against its plan.md and spec.md; security and correctness'), 'test-review')
  assert.equal(top('incident-to-intent: Turn a production problem into the next loop iteration — reproduce, root-cause, postmortem'), 'maintain')
  assert.equal(top('conductor-protocol: How to conduct an attached agent team — delegate, subagents in parallel'), 'delegate')
  assert.equal(top('brainstorming: refine an idea into a problem statement with questions'), 'plan')
  assert.deepEqual(suggestPlacement('zzz qqq', CURATED_PRESETS), [])
  assert.ok(suggestPlacement('review test pr build implement', CURATED_PRESETS).length <= 2)
})

test('orphanSkills lists installed skills in no preset with placements', () => {
  const lock = { version: 1, sources: {}, skills: [
    { source: 'local', dir: 'used', name: 'used', description: 'd', digest: 'x', normalized: false, commit: 'c', installedAt: 't', files: 1 },
    { source: 'local', dir: 'free', name: 'free', description: 'Review a pull request for security', digest: 'x', normalized: false, commit: 'c', installedAt: 't', files: 1 },
    { source: 'up', dir: 'gone', name: 'gone', description: 'd', digest: 'x', normalized: false, commit: 'c', installedAt: 't', files: 1, orphaned: true },
  ] }
  const presets = [{ ...CURATED_PRESETS[0], skills: [{ ref: 'local/used' }] }, CURATED_PRESETS.find(p => p.id === 'test-review')]
  const out = orphanSkills(lock, presets, new Map())
  assert.deepEqual(out.map(o => o.ref), ['local/free'])
  assert.equal(out[0].placements[0].preset, 'test-review')
})
