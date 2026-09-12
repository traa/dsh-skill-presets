import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectWorktree, detectPullRequest, detectConductor, detectArtifactChain, detectPlanBeforeCode, isMutatingCommand, findPrUrl, worst, evaluate } from '../lib/host/practices/detectors.js'

const base = { calls: [], teamAttached: false, userTurns: [1], protectedBranches: ['main', 'master'], ended: false }
const edit = (t = 't1', turn = 1, target = 'src/x.ts') => ({ t, turn, name: 'edit', target, isError: false })
const bash = (command, resultHead, turn = 1) => ({ t: 't', turn, name: 'bash', target: command, isError: false, resultHead })
const facts = (over = {}) => ({ inRepo: true, gitAvailable: true, isWorktree: false, branch: 'main', ahead: 0, hasUpstream: true, dirty: false, ghAvailable: true, artifacts: [], instructionFiles: [], readAt: 'r', ...over })

test('worktree: n/a before mutations; red on protected branch in primary checkout; green in a worktree or on a feature branch', () => {
  assert.equal(detectWorktree({ ...base, facts: facts() }).status, 'n/a')
  const red = detectWorktree({ ...base, calls: [edit()], facts: facts() })
  assert.equal(red.status, 'red'); assert.match(red.evidence[0], /protected branch main/); assert.equal(red.firstViolationAt, 't1')
  assert.equal(detectWorktree({ ...base, calls: [edit()], facts: facts({ isWorktree: true }) }).status, 'green')
  assert.equal(detectWorktree({ ...base, calls: [edit()], facts: facts({ branch: 'feat/x' }) }).status, 'green')
  assert.equal(detectWorktree({ ...base, calls: [edit()], facts: facts({ inRepo: false }) }).status, 'n/a')
  assert.equal(detectWorktree({ ...base, calls: [edit()] }).status, 'amber')
  assert.equal(detectWorktree({ ...base, calls: [edit()], facts: { inRepo: false, gitAvailable: false, ghAvailable: false, artifacts: [], instructionFiles: [], readAt: '' } }).status, 'amber')
})

test('mutating command classifier', () => {
  assert.ok(isMutatingCommand('git commit -m x'))
  assert.ok(isMutatingCommand('rm -rf lib'))
  assert.ok(isMutatingCommand('npm install foo'))
  assert.ok(isMutatingCommand('echo x > file'))
  assert.ok(!isMutatingCommand('git status'))
  assert.ok(!isMutatingCommand('ls -la'))
  assert.ok(!isMutatingCommand('npm test'))
  assert.ok(!isMutatingCommand(undefined))
})

test('pull-request: green from gh pr create, a PR URL from any forge, or facts.pr; red at end when ahead without a PR', () => {
  assert.equal(detectPullRequest({ ...base, calls: [edit(), bash('gh pr create --fill', 'https://github.com/o/r/pull/12')] , facts: facts() }).status, 'green')
  assert.match(detectPullRequest({ ...base, calls: [edit(), bash('glab mr create', 'https://gitlab.com/g/p/-/merge_requests/3')], facts: facts() }).evidence[0], /merge_requests\/3/)
  assert.equal(detectPullRequest({ ...base, calls: [edit()], facts: facts({ pr: { url: 'u', state: 'OPEN' } }) }).status, 'green')
  assert.equal(detectPullRequest({ ...base, calls: [edit()], facts: facts({ ahead: 2 }) }).status, 'amber')
  const red = detectPullRequest({ ...base, ended: true, calls: [edit()], facts: facts({ ahead: 3 }) })
  assert.equal(red.status, 'red'); assert.match(red.evidence[0], /3 commits ahead/)
  assert.equal(detectPullRequest({ ...base, ended: true, calls: [edit()], facts: facts({ hasUpstream: false, ahead: undefined }) }).status, 'red')
  assert.equal(detectPullRequest({ ...base, calls: [edit()], facts: facts({ ghAvailable: false, ahead: undefined, hasUpstream: false }) }).status, 'amber')
  assert.equal(detectPullRequest({ ...base, facts: facts() }).status, 'n/a')
  assert.equal(findPrUrl('see https://bitbucket.org/w/r/pull-requests/9 ok'), 'https://bitbucket.org/w/r/pull-requests/9')
})

test('conductor: n/a without a team; red on self-edits or delegation before approval; green with delegations only', () => {
  assert.equal(detectConductor(base).status, 'n/a')
  const view = { ...base, teamAttached: true, userTurns: [1, 2] }
  const red = detectConductor({ ...view, calls: [edit()] })
  assert.equal(red.status, 'red'); assert.match(red.evidence[0], /mutated files itself/)
  const early = detectConductor({ ...view, calls: [{ t: 't', turn: 1, name: 'team_delegate', isError: false }] })
  assert.equal(early.status, 'red'); assert.match(early.evidence[0], /without a prior approval turn/)
  const good = detectConductor({ ...view, calls: [{ t: 't', turn: 2, name: 'team_delegate', isError: false }, { t: 't', turn: 2, name: 'team_wait', isError: false }] })
  assert.equal(good.status, 'green')
  assert.equal(detectConductor({ ...view, calls: [{ t: 't', turn: 2, name: 'Read', isError: false }] }).status, 'amber')
  assert.equal(detectConductor({ ...view, ended: true, calls: [{ t: 't', turn: 2, name: 'Read', isError: false }] }).status, 'red')
})

test('artifact-chain and plan-before-code follow the active stage', () => {
  assert.equal(detectArtifactChain({ ...base, facts: facts({ artifacts: ['docs/sdlc/x/intent.md'] }), activeStage: 'design' }).status, 'green')
  const red = detectArtifactChain({ ...base, facts: facts(), activeStage: 'build' })
  assert.equal(red.status, 'red'); assert.match(red.evidence[1], /expects plan.md/)
  assert.equal(detectArtifactChain({ ...base, facts: facts({ artifacts: ['plan.md'] }), activeStage: 'build' }).status, 'green')
  assert.equal(detectArtifactChain({ ...base, facts: facts({ inRepo: false }) }).status, 'n/a')
  assert.equal(detectPlanBeforeCode({ ...base, calls: [edit()], facts: facts(), activeStage: 'design' }).status, 'n/a')
  assert.equal(detectPlanBeforeCode({ ...base, calls: [edit()], facts: facts(), activeStage: 'build' }).status, 'red')
  assert.equal(detectPlanBeforeCode({ ...base, calls: [edit()], facts: facts({ artifacts: ['docs/sdlc/a/plan.md'] }), activeStage: 'build' }).status, 'green')
})

test('evaluate and worst', () => {
  const results = evaluate({ ...base, calls: [edit()], facts: facts() }, ['worktree', 'pull-request', 'conductor'])
  assert.deepEqual(results.map(r => r.id), ['worktree', 'pull-request', 'conductor'])
  assert.equal(worst(results), 'red')
  assert.equal(worst([{ status: 'n/a' }, { status: 'green' }]), 'green')
  assert.equal(worst([]), 'n/a')
})
