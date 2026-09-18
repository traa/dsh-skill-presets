// The guardrails prompt block is the one thing the model reads every step.
// Phase 7: it names a practice only when it is RED and RELEVANT to the stage;
// amber ("I could not tell") and stage-irrelevant practices never reach the
// model; Explore says so once and is otherwise silent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderGuardrails } from '../lib/host/prompt.js'
import { BUILTIN_FLOWS, relevantStages, annotateRelevance } from '../lib/host/flows.js'
import { CURATED_PRESETS } from '../lib/host/curated.js'

const full = BUILTIN_FLOWS.find(f => f.id === 'full')
const explore = BUILTIN_FLOWS.find(f => f.id === 'explore')
const build = CURATED_PRESETS.find(p => p.id === 'build')
const skills = [{ name: 'worktree-first', via: 'preset' }, { name: 'pr-always', via: 'preset' }]

test('relevantStages: which stages each practice judges', () => {
  assert.deepEqual(relevantStages('plan-before-code'), ['build'])
  assert.deepEqual(relevantStages('plan-drift'), ['build'])
  assert.deepEqual(relevantStages('worktree'), ['build', 'test'])
  assert.deepEqual(relevantStages('pull-request'), ['build', 'test', 'deploy'])
  assert.deepEqual(relevantStages('artifact-chain'), ['plan', 'design', 'build', 'test'])
  assert.equal(relevantStages('post-merge-sync'), 'all')
  assert.equal(relevantStages('conductor'), 'all')
  assert.equal(relevantStages('worktree-hygiene'), 'all')
})

test('annotateRelevance: adds relevant + kind; Explore turns everything off', () => {
  const results = [
    { id: 'worktree', status: 'red', evidence: ['2 file mutations on protected branch main in the primary checkout'] },
    { id: 'plan-drift', status: 'amber', evidence: ['1 file not in plan.md: x.ts'] },
    { id: 'worktree-hygiene', status: 'amber', evidence: ['git facts unavailable'] },
    { id: 'post-merge-sync', status: 'green', evidence: ['level'] },
  ]
  const inPlan = annotateRelevance(results, full, 'plan')
  assert.equal(inPlan.find(r => r.id === 'worktree').relevant, false, 'worktree does not judge Plan')
  assert.equal(inPlan.find(r => r.id === 'post-merge-sync').relevant, true)
  const inBuild = annotateRelevance(results, full, 'build')
  assert.equal(inBuild.find(r => r.id === 'worktree').relevant, true)
  assert.equal(inBuild.find(r => r.id === 'worktree').kind, 'violation')
  assert.equal(inBuild.find(r => r.id === 'plan-drift').kind, 'violation', 'amber with a concrete finding is a (soft) violation')
  assert.equal(inBuild.find(r => r.id === 'worktree-hygiene').kind, 'unknown', 'amber "could not tell" is unknown, not a warning')
  assert.equal(inBuild.find(r => r.id === 'post-merge-sync').kind, undefined, 'green carries no kind')
  const inExplore = annotateRelevance(results, explore, null)
  assert.ok(inExplore.every(r => r.relevant === false), 'guardrails off: nothing is relevant')
})

test('renderGuardrails: only red + relevant practices are listed; unknowns and irrelevant ones are not', () => {
  const practices = annotateRelevance([
    { id: 'worktree', status: 'red', evidence: ['2 file mutations on protected branch main in the primary checkout'] },
    { id: 'pull-request', status: 'amber', evidence: ['3 commits ahead of upstream, no PR yet'] },
    { id: 'worktree-hygiene', status: 'amber', evidence: ['git facts unavailable'] },
    { id: 'plan-drift', status: 'amber', evidence: ['1 file not in plan.md: x.ts'] },
  ], full, 'build')
  const text = renderGuardrails({ preset: build, skills, overlays: [], practices, flow: full, stage: 'build' })
  assert.match(text, /Flow: Full · stage 3 of 5: Build → next gate: plan\.md/u)
  assert.match(text, /Practices at risk:\n- Work in a worktree \[red\]: 2 file mutations.*— load the `worktree-first` skill/u)
  assert.doesNotMatch(text, /Always open a PR/u, 'amber is not a violation the model must act on')
  assert.doesNotMatch(text, /Clean up worktrees/u, 'unknown never reaches the model')
  assert.doesNotMatch(text, /plan\.md in step/u, 'amber drift is advisory in the UI, not a prompt line')
})

test('renderGuardrails: red but irrelevant to the stage is silent', () => {
  const practices = annotateRelevance([{ id: 'plan-before-code', status: 'red', evidence: ['edited src/x.ts with no plan.md'] }], full, 'plan')
  const text = renderGuardrails({ preset: CURATED_PRESETS.find(p => p.id === 'plan'), skills: [], overlays: [], practices, flow: full, stage: 'plan' })
  assert.doesNotMatch(text, /Practices at risk/u)
})

test('renderGuardrails: Explore says so once and lists nothing', () => {
  const practices = annotateRelevance([{ id: 'worktree', status: 'red', evidence: ['edits on main'] }], explore, null)
  const text = renderGuardrails({ skills: [{ name: 'pr-always', via: { overlay: 'git-repo' } }], overlays: ['git-repo'], practices, flow: explore, stage: null })
  assert.match(text, /Explore flow: guardrails are off for this session/u)
  assert.doesNotMatch(text, /Practices at risk/u)
  assert.doesNotMatch(text, /Active skill preset/u)
})

test('renderGuardrails: without a flow (legacy caller) the old red/amber behaviour is kept', () => {
  const text = renderGuardrails({ preset: build, skills, overlays: [], practices: [{ id: 'pull-request', status: 'amber', evidence: ['no PR yet'] }] })
  assert.match(text, /Always open a PR \[amber\]/u)
})
