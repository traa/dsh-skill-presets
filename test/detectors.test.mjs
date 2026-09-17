import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectWorktree, detectPullRequest, detectConductor, detectArtifactChain, detectPlanBeforeCode, detectPlanDrift, detectWorktreeHygiene, isMutatingCommand, findPrUrl, worst, evaluate } from '../lib/host/practices/detectors.js'
import * as detectors from '../lib/host/practices/detectors.js'
import { workRootOf, currentWorkRoot, attributedWorkRoot } from '../lib/host/practices/workroot.js'
import { changesWorktrees } from '../lib/host/practices/worktrees.js'

// A real session always has BOTH a cwd and a repository top level: the facts
// were read from a directory, and `edit src/x.ts` resolves against one. The
// fixture carries them so the worktree practice can answer its question —
// "did this mutation land in THIS checkout?" — as it does in a live session.
// Same directory for both, which is the ordinary case: the agent is working
// where the session started.
const REPO = '/repo'
const base = { calls: [], teamAttached: false, userTurns: [1], protectedBranches: ['main', 'master'], ended: false, cwd: REPO }
const edit = (t = 't1', turn = 1, target = 'src/x.ts') => ({ t, turn, name: 'edit', target, isError: false })
const bash = (command, resultHead, turn = 1) => ({ t: 't', turn, name: 'bash', target: command, isError: false, resultHead })
const facts = (over = {}) => ({ inRepo: true, gitAvailable: true, isWorktree: false, branch: 'main', ahead: 0, hasUpstream: true, dirty: false, ghAvailable: true, topLevel: REPO, artifacts: [], instructionFiles: [], readAt: 'r', ...over })

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
  // THE NON-REGRESSION SIDE.
  // Widening this function is dangerous: `mutatesFiles` wraps `isMutatingCommand` and feeds `decideWorktreeGate`, which DENIES tool calls.
  // A false positive blocks a real user session. Assert these stay NON-mutating:
  const readOnly = [
    'git status', 'ls -la', 'npm test', undefined,
    'git log | wc -l', 'git log --oneline | sort | uniq', 'git status && npm test', 'ls | tail', 'git log 2>/dev/null',
    'git ls-files | xargs cat', 'git ls-files | xargs grep foo'
  ]
  for (const cmd of readOnly) {
    assert.ok(!isMutatingCommand(cmd), `should not be mutating: ${cmd}`)
  }

  const mutating = [
    'git commit -m x', 'rm -rf lib', 'npm install foo', 'echo x > file',
    'git ls-files | xargs rm',
    'git log | sed -i.bak s/a/b/ x.ts',
    'xargs rm', 'xargs -0 rm', 'xargs -n1 rm -f'
  ]
  for (const cmd of mutating) {
    assert.ok(isMutatingCommand(cmd), `should be mutating: ${cmd}`)
  }
})

test('xargs operand parsing: a flag value is never the operand command', () => {
  const mutating = [
    'xargs --replace rm',
    'xargs --eof rm',
    'xargs --max-lines rm',
    'git ls-files | xargs -J % rm %',
    'xargs -R 5 rm',
    'xargs rm',
    'xargs -0 rm',
    'xargs -n1 rm -f',
    'xargs -i rm {}',
    'xargs -I{} mv {} /tmp'
  ]
  for (const cmd of mutating) {
    assert.ok(isMutatingCommand(cmd), `should be mutating: ${cmd}`)
  }

  // `mutatesFiles` wraps `isMutatingCommand` and feeds `decideWorktreeGate` (src/host/practices/gate.ts line 149),
  // which DENIES tool calls — so a false positive here blocks a real user's session rather than merely making a panel noisy.
  const readOnly = [
    'xargs -J rm echo',
    'xargs -R rm cat',
    'git ls-files | xargs cat',
    'git ls-files | xargs'
  ]
  for (const cmd of readOnly) {
    assert.ok(!isMutatingCommand(cmd), `should not be mutating: ${cmd}`)
  }

})

test('mutating classifier: a command is recognised by its normalised name, not its spelling', () => {
  // RULE: a command must be recognised by its NORMALISED name (basename, past git global flags, across flag spellings),
  // because /bin/rm and rm are the same command, while a flag's VALUE (-J rm) is never a command at all.

  const mutating = [
    'sed --in-place s/a/b/ x.ts',
    'git log | sed -ni s/a/b/ x.ts',
    '/bin/rm -rf foo',
    'xargs /bin/rm',
    'git -C /wt commit -m x',
    'xargs -I"" rm',
    'xargs -d"" rm'
  ]
  for (const cmd of mutating) {
    assert.ok(isMutatingCommand(cmd), `should be mutating: ${cmd}`)
  }

  const readOnly = [
    'git -C /wt status',
    'git -C /wt log',
    'xargs -J rm echo',
    'xargs -R rm cat',
    'xargs -J % echo %',
    'git ls-files | xargs cat',
    'gh issue comment -b "done; rm -rf tmp"'
  ]
  for (const cmd of readOnly) {
    assert.ok(!isMutatingCommand(cmd), `should not be mutating: ${cmd}`)
  }
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
  // An attributed root: a real call named an absolute path, so the repo under
  // judgement is demonstrably the one being worked in (see RULE A below).
  const at = [{ t: 'a1', turn: 1, name: 'edit', target: '/wt/src/x.ts', isError: false }]
  assert.equal(detectArtifactChain({ ...base, calls: at, facts: facts({ artifacts: ['docs/sdlc/x/intent.md'] }), activeStage: 'design' }).status, 'green')
  const red = detectArtifactChain({ ...base, calls: at, facts: facts({ artifacts: ['docs/sdlc/x/intent.md'] }), activeStage: 'build' })
  assert.equal(red.status, 'red'); assert.match(red.evidence.join(' | '), /plan\.md/)
  assert.equal(detectArtifactChain({ ...base, calls: at, facts: facts({ artifacts: ['plan.md'] }), activeStage: 'build' }).status, 'green')
  assert.equal(detectArtifactChain({ ...base, calls: at, facts: facts({ inRepo: false }) }).status, 'n/a')
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

test('isVcsPlumbing classifies commit/push/PR plumbing apart from working-tree writes', () => {
  const { isVcsPlumbing } = detectors
  for (const command of ['git add -A', 'git commit -m "msg"', 'git push -u origin br', 'gh pr create --title x', "git commit -F - <<'EOF'\nsubject\nEOF"]) {
    assert.equal(isVcsPlumbing(command), true, command)
  }
  for (const command of ['git checkout -- src/a.ts', 'git restore src/a.ts', 'git apply patch.diff', 'git stash pop', 'git revert HEAD', 'git cherry-pick abc', 'git merge other', 'git rebase main', 'git add -A && npm run build && rm -rf dist']) {
    assert.equal(isVcsPlumbing(command), false, command)
  }
})

test('isVcsPlumbing: pipe fixes and regressions', () => {
  const { isVcsPlumbing } = detectors

  // GROUP A — disqualified: launders a real mutation past the check
  assert.equal(isVcsPlumbing('git push | sed -i.bak s/a/b/ src/x.ts'), false, 'attached short-flag value')
  assert.equal(isVcsPlumbing('git push | sed -ibak s/a/b/ x.ts'), false, 'no separator')
  assert.equal(isVcsPlumbing('git push | sed -ni.bak s/a/b/ x.ts'), false, 'CLUSTERED short flags')
  assert.equal(isVcsPlumbing('git push | sort -oout.txt'), false, 'attached -o value')
  assert.equal(isVcsPlumbing('git push | sed -n \'w out.txt\''), false, 'standalone w command')
  assert.equal(isVcsPlumbing('git push | sed \'1,5w out.txt\''), false, 'w after an address')
  assert.equal(isVcsPlumbing('git push | sed \'s/a/b/wout.txt\''), false, 's///w flag, no space')
  assert.equal(isVcsPlumbing('git push | uniq - out.txt'), false, '\'-\' is stdin; out.txt is the write target')
  assert.equal(isVcsPlumbing('git push | awk \'BEGIN{system("touch o.txt")}\''), false, 'awk removed from the allow-list')
  assert.equal(isVcsPlumbing('git push | less'), false, 'less executes from argv, and -o writes')
  assert.equal(isVcsPlumbing('git push | rg --pre ./x.sh foo'), false, 'names an external program')
  assert.equal(isVcsPlumbing('git push | sort --compress-program ./x.sh'), false, 'same')
  assert.equal(isVcsPlumbing('git push | sed -f script.sed x.txt'), false, 'script contents are invisible')

  // GROUP B — stay read-only: the false positive that must not return
  assert.equal(isVcsPlumbing('git push -u origin feat/x 2>&1 | tail -4'), true, 'pipe into pager must not defeat plumbing exclusion')
  assert.equal(isVcsPlumbing('cd /repo && git commit -q -m x | tail -1'), true, 'pipe into pager must not defeat plumbing exclusion (commit)')
  assert.equal(isVcsPlumbing('git push | grep -i error'), true, 'THE POOLED-FLAG TRAP: for grep, -i is ignore-case')
  assert.equal(isVcsPlumbing('git push | grep -o pattern'), true, 'and -o is only-matching, NOT an output file')
  assert.equal(isVcsPlumbing('git log | sed \'s/warn/W/\''), true, 'a \'w\' in payload text is not a w COMMAND')
  assert.equal(isVcsPlumbing('git status | sed -n 1p'), true, 'status with sed')
  assert.equal(isVcsPlumbing('git log | head -5'), true, 'log with head')
  assert.equal(isVcsPlumbing('git log | wc -l'), true, 'log with wc')
  assert.equal(isVcsPlumbing('git log --oneline | sort | uniq'), true, 'multiple safe filters')

  // GROUP C — must still be FLAGGED as conductor self-mutation
  const assertSelfMutation = (command, msg) => {
    const r = detectConductor(conducted([bash(command, undefined, 2)]))
    assert.equal(r.status, 'red', msg)
    assert.equal(selfMutation(r).length, 1, msg)
  }
  assertSelfMutation('sed -i s/a/b/ src/x.ts | tail -1', 'sed -i in pipe must not be laundered')
  assertSelfMutation('git commit -m x && rm -rf build | tail -1', 'rm in segment must not be laundered')
  assertSelfMutation('git push | tee log.txt', 'tee is not a read-only consumer')
  assertSelfMutation('git log > out.txt', 'redirection to file is not plumbing')
  assertSelfMutation('git log | tail > out.txt', 'redirection to file after pipe is not plumbing')
  
  // It pins the BOUNDARY of redirectsToFile in src/host/practices/detectors.ts.
  // A redirect to /dev/null writes nothing and must stay plumbing; a redirect to a real path must disqualify.
  // The two surviving cases only pin the disqualifying side. Without this one, someone simplifying 
  // redirectsToFile to treat every >/2> as a file write would keep the suite green while resurrecting 
  // the original false positive: a git command harmlessly silencing stderr (git push … 2>&1 | tail -4 is 
  // exactly the shape this whole branch fixed) would again be reported as the conductor editing files.
  assert.equal(isVcsPlumbing('git log 2>/dev/null'), true, 'redirection to /dev/null is still plumbing')
  
  for (const command of [
    'git restore -- p',
    'git apply p.patch',
    'git checkout -- p',
    'git stash pop',
    'git revert x',
    'git cherry-pick x',
    'git merge x',
    'git rebase main',
  ]) {
    assertSelfMutation(command, `working-tree subcommand ${command}`)
    assertSelfMutation(`${command} | tail -1`, `working-tree subcommand ${command} piped`)
  }

  // GROUP D — chain with no VCS invocation must not become plumbing
  assert.equal(isVcsPlumbing('ls | tail'), false, 'chain with no VCS invocation')

  // Issue #19: isMutatingCommand was deciding on the FIRST segment only.
  // These must be reported as conductor self-mutations.
  assertSelfMutation('git ls-files | xargs rm', 'xargs rm must be flagged as self-mutation')
  assertSelfMutation('git log | sed -i.bak s/a/b/ x.ts', 'sed -i later in pipe must be flagged')
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

// A mutation may only be named as evidence about a checkout when it provably
// landed IN that checkout: absolute and under the root, or relative and
// resolving under it from the session cwd. PR #11 closed the "named no path"
// hole; this closes the "named a path somewhere else" one.
test('worktree: only mutations that provably landed in this checkout are counted as evidence', () => {
  // (a) RELATIVE target, session cwd inside the repo: resolves to
  // /repo/src/x.ts, so it IS this checkout and the red case still fires.
  const rel = detectWorktree({ ...base, calls: [edit('t1', 1, 'src/x.ts')], facts: facts() })
  assert.equal(rel.status, 'red', rel.evidence.join(' | '))
  assert.match(rel.evidence[0], /1 file mutation on protected branch main in the primary checkout/)

  // (b) ABSOLUTE target under the root: the plainest red there is.
  const abs = detectWorktree({ ...base, calls: [edit('t1', 1, `${REPO}/src/x.ts`)], facts: facts() })
  assert.equal(abs.status, 'red', abs.evidence.join(' | '))
  assert.match(abs.evidence[0], /1 file mutation on protected branch main in the primary checkout/)

  // (c) ABSOLUTE target OUTSIDE the root: nothing ties it to this checkout, so
  // the practice must not name it — and must not claim the location either.
  const outside = detectWorktree({ ...base, calls: [edit('t1', 1, '/other/repo/src/x.ts')], facts: facts() })
  assert.notEqual(outside.status, 'red', outside.evidence.join(' | '))
  assert.deepEqual(outside.evidence.filter(e => /primary checkout/.test(e)), [])
  assert.match(outside.evidence.join(' | '), /cannot be placed/)

  // A relative target whose session cwd sits OUTSIDE the attributed root is
  // the PR #11 hole itself: it named a path, but not one in this checkout.
  const elsewhere = detectWorktree({ ...base, cwd: '/other/repo', calls: [edit('t1', 1, 'src/x.ts')], facts: facts() })
  assert.notEqual(elsewhere.status, 'red', elsewhere.evidence.join(' | '))
  assert.deepEqual(elsewhere.evidence.filter(e => /primary checkout/.test(e)), [])

  // Mixed: the in-checkout mutation still convicts, and the count is of TIED
  // mutations only — the unplaceable one is declared, not silently folded in.
  const mixed = detectWorktree({ ...base, calls: [edit('t1', 1, `${REPO}/src/x.ts`), edit('t2', 1, '/other/repo/y.ts')], facts: facts() })
  assert.equal(mixed.status, 'red')
  assert.match(mixed.evidence[0], /^1 file mutation on protected branch main/)
  assert.match(mixed.evidence.join(' | '), /1 further mutation could not be placed/)

  // The same containment rule guards the GREEN verdicts, which name this
  // checkout just as loudly: a write outside a linked worktree is not evidence
  // that the work happened safely inside it.
  const falseGreen = detectWorktree({ ...base, calls: [edit('t1', 1, '/other/repo/y.ts')], facts: facts({ isWorktree: true }) })
  assert.notEqual(falseGreen.status, 'green', falseGreen.evidence.join(' | '))
})

test('worktree: a symlinked checkout is still this checkout (git resolves the top level, tool paths do not)', () => {
  // macOS /tmp → /private/tmp: `git rev-parse --show-toplevel` answers the
  // realpath while every tool call carries the symlinked spelling. Comparing
  // them literally turned a genuine red into "cannot be placed".
  const r = detectWorktree({
    ...base,
    cwd: '/var/folders/x/repo',
    calls: [edit('t1', 1, '/var/folders/x/repo/src/a.ts')],
    facts: facts({ topLevel: '/private/var/folders/x/repo', topLevelAlias: '/var/folders/x/repo' }),
  })
  assert.equal(r.status, 'red', r.evidence.join(' | '))
  assert.match(r.evidence[0], /primary checkout/)
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

// --- RULE A: never judge a repo nobody worked in.
// The work root is ATTRIBUTED when some call named where it worked, and merely
// ASSUMED when it fell back to the session cwd. The tracker derives that with
// `attributedWorkRoot(calls, cwd)` and passes `view.workRootAssumed` to the
// detector — the same shape PR #10 gave the worktree practice. The invariant
// spans both halves, so the factory composes them exactly as the tracker does
// rather than hand-setting the flag.
const CWD = '/session-cwd'
const attributed = [{ t: 'a1', turn: 1, name: 'edit', target: '/wt/src/x.ts', isError: false }]
const chain = (activeStage, artifacts, calls = attributed) => detectArtifactChain({
  ...base,
  calls,
  facts: facts({ artifacts, topLevel: CWD }),
  activeStage,
  ...(attributedWorkRoot(calls, CWD) === undefined ? { workRootAssumed: true } : {}),
})

test('artifact-chain: with no call naming a path the root is only assumed, so the practice is n/a, never red', () => {
  // Artifacts are non-empty and the stage requirement is UNMET: under an
  // attributed root this is the red case, so only the assumed root can spare it.
  for (const [label, calls] of [['no calls at all', []], ['a call that names no path', [bash('npm install left-pad')]]]) {
    assert.equal(attributedWorkRoot(calls, CWD), undefined, `${label}: no call attributes a root`)
    const r = chain('build', ['docs/sdlc/phase-2/intent.md'], calls)
    assert.equal(r.status, 'n/a', `${label}: ${r.status} — ${r.evidence.join(' | ')}`)
    assert.match(r.evidence.join(' | '), /named a path/i, label)
  }
})

test('artifact-chain: an assumed root is not judged even when the stage requirement would be met', () => {
  assert.equal(chain('build', ['docs/sdlc/phase-2/plan.md'], []).status, 'n/a')
})

test('artifact-chain: once a call attributes the root, the normal stage rules apply again', () => {
  assert.equal(attributedWorkRoot(attributed, CWD), '/wt/src')
  assert.equal(chain('build', ['docs/sdlc/phase-2/plan.md']).status, 'green')
  assert.equal(chain('build', ['docs/sdlc/phase-2/intent.md']).status, 'red')
})

// --- RULE B: a change that was never planned is not a broken chain.
// Red is reserved for a chain that was STARTED AND DROPPED, never for a session
// that simply never had a planned phase.
const notRed = (r, label) => {
  assert.ok(['n/a', 'amber'].includes(r.status), `${label}: status was ${r.status} — ${r.evidence.join(' | ')}`)
  assert.ok(r.evidence.length > 0 && r.evidence[0].length > 0, `${label}: states a reason`)
}

test('artifact-chain: a Build or Test session with no artifacts at all was never a planned phase, so it is not red', () => {
  for (const stage of ['build', 'test']) {
    const r = chain(stage, [])
    notRed(r, stage)
    assert.match(r.evidence.join(' | '), /planned/i, `${stage}: says this was never a planned phase`)
  }
})

test('artifact-chain: a Build or Test chain holding intent.md but no plan.md was started and dropped, so it is red', () => {
  for (const stage of ['build', 'test']) {
    const r = chain(stage, ['docs/sdlc/phase-2/intent.md'])
    assert.equal(r.status, 'red', `${stage}: ${r.evidence.join(' | ')}`)
    assert.match(r.evidence.join(' | '), /plan\.md/, stage)
  }
})

test('artifact-chain: plan.md satisfies Build whether it sits under docs/sdlc or at the repo root', () => {
  assert.equal(chain('build', ['docs/sdlc/phase-2/plan.md']).status, 'green')
  assert.equal(chain('build', ['plan.md']).status, 'green')
  assert.equal(chain('build', ['docs/sdlc/phase-2/intent.md', 'docs/sdlc/phase-2/plan.md']).status, 'green')
})

test('artifact-chain: Design is green on intent.md and not red when nothing was started', () => {
  assert.equal(chain('design', ['docs/sdlc/phase-2/intent.md']).status, 'green')
  assert.equal(chain('design', ['intent.md']).status, 'green')
  notRed(chain('design', []), 'design with no artifacts')
})

// Design holding a LATER artifact but not intent.md: by the same
// started-and-dropped principle this is the dropped case, so it is pinned red.
test('artifact-chain: Design holding spec.md but no intent.md is a dropped chain, so it is red', () => {
  const r = chain('design', ['docs/sdlc/phase-2/spec.md'])
  assert.equal(r.status, 'red', `design/spec-only: ${r.evidence.join(' | ')}`)
  assert.match(r.evidence.join(' | '), /intent\.md/)
})

test('artifact-chain: a stage with no artifact requirement is never red on this ground', () => {
  for (const stage of ['plan', 'deploy', 'maintain', 'cross']) {
    notRed(chain(stage, []), `${stage} with no artifacts`)
    const withSome = chain(stage, ['docs/sdlc/phase-2/intent.md'])
    assert.notEqual(withSome.status, 'red', `${stage} with an artifact: ${withSome.evidence.join(' | ')}`)
  }
})

test('evaluate and worst', () => {
  const results = evaluate({ ...base, calls: [edit()], facts: facts() }, ['worktree', 'pull-request', 'conductor'])
  assert.deepEqual(results.map(r => r.id), ['worktree', 'pull-request', 'conductor'])
  assert.equal(worst(results), 'red')
  assert.equal(worst([{ status: 'n/a' }, { status: 'green' }]), 'green')
  assert.equal(worst([]), 'n/a')
})

test('package manager subcommands survive a global flag', () => {
  // RULE: a subcommand is found by SKIPPING FLAGS BY ARITY, never by searching the line for the word "install"
  // otherwise a script named `install-hooks` denies innocent work.
  
  const mutating = [
    'npm ci',
    'npm --prefix /tmp install x',
    'npm -g install x',
    'npm install foo'
  ]
  for (const cmd of mutating) {
    assert.ok(isMutatingCommand(cmd), `should be mutating: ${cmd}`)
  }

  const readOnly = [
    'npm run install-hooks',
    'npm --prefix /tmp run build',
    'npm test',
    'npm ls',
    'npm run build',
    'pnpm test'
  ]
  for (const cmd of readOnly) {
    assert.ok(!isMutatingCommand(cmd), `should not be mutating: ${cmd}`)
  }
})

test('package manager subcommands are matched by exact spelling, not prefix or substring', () => {
  // RULE: membership is a test of the SUBCOMMAND SPELLING, not a prefix or substring match — 
  // which is why ci and uninstall each have to be listed by name, and why a read-only verb 
  // like list must never be added to that table.

  const mutating = [
    'yarn remove x',
    'cargo remove x',
    'cargo install x',
    'pip uninstall x',
    'pip3 uninstall x'
  ]
  for (const cmd of mutating) {
    assert.ok(isMutatingCommand(cmd), `should be mutating: ${cmd}`)
  }

  const readOnly = [
    'cargo build',
    'cargo test',
    'yarn run build',
    'pip list',
    'npm run install-hooks'
  ]
  for (const cmd of readOnly) {
    assert.ok(!isMutatingCommand(cmd), `should not be mutating: ${cmd}`)
  }
})
