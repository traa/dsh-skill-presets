import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectWorktree, detectPullRequest, detectConductor, detectArtifactChain, detectPlanBeforeCode, detectPlanDrift, detectWorktreeHygiene, isMutatingCommand, findPrUrl, worst, evaluate } from '../lib/host/practices/detectors.js'
import * as detectors from '../lib/host/practices/detectors.js'
import { workRootOf, currentWorkRoot } from '../lib/host/practices/workroot.js'
import { changesWorktrees } from '../lib/host/practices/worktrees.js'

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

// --- RULE 1: doing the conductor's own job is not a self-mutation.
// A conducted view with one approved delegation: green unless the conductor
// itself mutated files, so any red below is the self-mutation ground alone.
const conducted = (calls) => ({
  ...base,
  teamAttached: true,
  userTurns: [1, 2],
  calls: [{ t: 'd1', turn: 2, name: 'team_delegate', isError: false }, ...calls],
})
const selfMutation = (r) => r.evidence.filter(e => /mutated files itself/.test(e))

test('conductor: committing, pushing and opening the PR are the conductor\'s own job, not a self-mutation', () => {
  const plumbing = conducted([
    bash('git add -A', undefined, 2),
    bash('git commit -m "msg"', undefined, 2),
    bash('git push -u origin br', undefined, 2),
    bash('gh pr create --title x', undefined, 2),
  ])
  const r = detectConductor(plumbing)
  assert.deepEqual(selfMutation(r), [], 'git add/commit/push and gh pr create are VCS plumbing')
  assert.equal(r.status, 'green')
  assert.equal(r.firstViolationAt, undefined)
})

test('conductor: a heredoc-bearing git commit -F - is still plumbing, not a self-mutation', () => {
  const r = detectConductor(conducted([bash("git commit -F - <<'EOF'\nsubject\n\nbody line\nEOF", undefined, 2)]))
  assert.deepEqual(selfMutation(r), [])
  assert.equal(r.status, 'green')
})

test('conductor: a write or edit of a source file is still a self-mutation', () => {
  for (const name of ['write', 'edit']) {
    const r = detectConductor(conducted([{ t: 'm1', turn: 2, name, target: 'src/a.ts', isError: false }]))
    assert.equal(r.status, 'red', name)
    assert.equal(selfMutation(r).length, 1, name)
    assert.equal(r.firstViolationAt, 'm1', name)
  }
})

test('conductor: a shell command that writes working-tree contents via git is a self-mutation', () => {
  for (const command of [
    'git checkout -- src/a.ts',
    'git restore src/a.ts',
    'git apply patch.diff',
    'git stash pop',
    'git revert HEAD',
    'git cherry-pick abc',
    'git merge other',
    'git rebase main',
  ]) {
    const r = detectConductor(conducted([bash(command, undefined, 2)]))
    assert.equal(r.status, 'red', command)
    assert.equal(selfMutation(r).length, 1, command)
  }
})

test('conductor: a command mixing plumbing with real mutation is not pure plumbing', () => {
  const r = detectConductor(conducted([bash('git add -A && npm run build && rm -rf dist', undefined, 2)]))
  assert.equal(r.status, 'red')
  assert.equal(selfMutation(r).length, 1)
})

test('isVcsPlumbing classifies commit/push/PR plumbing apart from working-tree writes', { skip: typeof detectors.isVcsPlumbing === 'function' ? false : 'detectors.js exports no isVcsPlumbing' }, () => {
  const { isVcsPlumbing } = detectors
  for (const command of ['git add -A', 'git commit -m "msg"', 'git push -u origin br', 'gh pr create --title x', "git commit -F - <<'EOF'\nsubject\nEOF"]) {
    assert.equal(isVcsPlumbing(command), true, command)
  }
  for (const command of ['git checkout -- src/a.ts', 'git restore src/a.ts', 'git apply patch.diff', 'git stash pop', 'git revert HEAD', 'git cherry-pick abc', 'git merge other', 'git rebase main', 'git add -A && npm run build && rm -rf dist']) {
    assert.equal(isVcsPlumbing(command), false, command)
  }
})

// --- RULE 2: never assert a false location.
test('work root: an absolute path reached by a non-leading cd or a -C flag is honoured', () => {
  assert.equal(workRootOf({ t: 't', turn: 1, name: 'bash', target: 'git -C /wt commit -m x', isError: false }, '/primary'), '/wt')
  assert.equal(workRootOf({ t: 't', turn: 1, name: 'bash', target: 'npm run build && cd /wt && git add -A', isError: false }, '/primary'), '/wt')
})

test('work root: a cd or -C target has the same precedence as a write path — the newest attributing call wins', () => {
  const editCall = { t: 't1', turn: 1, name: 'edit', target: '/wt-a/src/x.ts', isError: false }
  const cdCall = { t: 't2', turn: 1, name: 'bash', target: 'cd /wt-b && git apply p.diff', isError: false }
  const dashC = { t: 't3', turn: 1, name: 'bash', target: 'git -C /wt-c commit -m x', isError: false }
  assert.equal(currentWorkRoot([editCall, cdCall], '/primary'), '/wt-b')
  assert.equal(currentWorkRoot([cdCall, editCall], '/primary'), '/wt-a/src')
  assert.equal(currentWorkRoot([editCall, dashC], '/primary'), '/wt-c')
})

test('worktree: with no attributable path the practice reports n/a or amber with a reason, never the primary checkout', () => {
  // A mutating call that names no path at all: nothing ties it to facts read
  // from the session cwd, so the location is unknown, not "primary checkout".
  const r = detectWorktree({ ...base, calls: [bash('npm install left-pad')], facts: facts() })
  assert.ok(['n/a', 'amber'].includes(r.status), `status was ${r.status}: ${r.evidence.join(' | ')}`)
  assert.deepEqual(r.evidence.filter(e => /primary checkout/.test(e)), [])
  assert.ok(r.evidence.length > 0 && r.evidence[0].length > 0, 'states a reason')
})

// --- RULE 3: plan-drift counts distinct files.
const driftView = (drift) => ({
  ...base,
  activeStage: 'build',
  facts: facts({ artifacts: ['docs/sdlc/x/plan.md'] }),
  drift,
})

test('plan-drift: three edits of the same path count as one drifting file, named once', () => {
  const r = detectPlanDrift(driftView([
    { path: 'src/a.ts', t: 't1' },
    { path: 'src/a.ts', t: 't2' },
    { path: 'src/a.ts', t: 't3' },
  ]))
  assert.equal(r.status, 'amber')
  assert.equal(r.evidence[0], '1 file not in plan.md: src/a.ts')
  assert.equal(r.firstViolationAt, 't1')
})

test('plan-drift: three distinct paths count as three drifting files', () => {
  const r = detectPlanDrift(driftView([
    { path: 'src/a.ts', t: 't1' },
    { path: 'src/b.ts', t: 't2' },
    { path: 'src/c.ts', t: 't3' },
  ]))
  assert.equal(r.status, 'amber')
  assert.equal(r.evidence[0], '3 files not in plan.md: src/a.ts, src/b.ts, src/c.ts')
})

// --- RULE 4: a verdict must not outlive its facts.
// The scan is cached by the tracker and folded into `view.worktrees`; a call
// that changes worktree state is recognised by `changesWorktrees` and raises
// `view.worktreesStale`. The invariant spans both, so the test composes them
// exactly as the tracker does rather than asserting either half alone.
const sweptView = (command) => ({
  ...base,
  facts: facts(),
  worktrees: { removable: 1, attention: [], stale: 0, symlinked: 0, total: 2 },
  ...(command !== undefined ? { worktreesStale: changesWorktrees(command) } : {}),
})

test('worktree-hygiene: a scan taken before a sweep may not keep claiming a merged worktree is present', () => {
  const before = detectWorktreeHygiene(sweptView(undefined))
  assert.equal(before.status, 'amber')
  assert.equal(before.evidence[0], '1 merged worktree still present')
  for (const command of ['git worktree remove /wt/old', 'git worktree prune', 'dsh-skill-presets worktrees --clean']) {
    assert.equal(changesWorktrees(command), true, `${command} changes worktree state`)
    const r = detectWorktreeHygiene(sweptView(command))
    assert.deepEqual(
      r.evidence.filter(e => /merged worktree/.test(e)),
      [],
      `after "${command}" the stale scan is still asserted: ${r.status} — ${r.evidence.join(' | ')}`,
    )
    assert.ok(['n/a', 'amber'].includes(r.status), `${command}: ${r.status}`)
    assert.ok(r.evidence.length > 0 && r.evidence[0].length > 0, `${command}: states a reason`)
  }
  // A call that does not touch worktrees must not suppress the finding.
  assert.equal(changesWorktrees('git status'), false)
  assert.equal(detectWorktreeHygiene(sweptView('git status')).evidence[0], '1 merged worktree still present')
})

test('evaluate and worst', () => {
  const results = evaluate({ ...base, calls: [edit()], facts: facts() }, ['worktree', 'pull-request', 'conductor'])
  assert.deepEqual(results.map(r => r.id), ['worktree', 'pull-request', 'conductor'])
  assert.equal(worst(results), 'red')
  assert.equal(worst([{ status: 'n/a' }, { status: 'green' }]), 'green')
  assert.equal(worst([]), 'n/a')
})
