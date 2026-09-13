import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, utimes, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { detectPostMergeSync } from '../lib/host/practices/detectors.js'
import { readGitFacts } from '../lib/host/practices/git.js'
import { checkSync, performSync } from '../lib/host/sync.js'
import { HOOK_PLAN } from '../lib/host/hooks.js'

const exec = promisify(execFile)
const G = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = async (cwd, ...a) => (await exec('git', a, { cwd, env: { ...process.env, ...G } })).stdout.trim()
const view = (facts, calls = []) => ({ calls, facts, teamAttached: false, userTurns: [1], protectedBranches: ['main'], ended: false })

async function repoPair() {
  const root = await mkdtemp(join(tmpdir(), 'skp-pm-'))
  const origin = join(root, 'origin.git'); const clone = join(root, 'clone'); const other = join(root, 'other')
  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin])
  await exec('git', ['clone', '-q', origin, clone]); await git(clone, 'checkout', '-q', '-b', 'main')
  await writeFile(join(clone, 'a'), '1'); await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'init'); await git(clone, 'push', '-q', '-u', 'origin', 'main')
  await exec('git', ['clone', '-q', origin, other]); await git(other, 'checkout', '-q', 'main')
  const mergePr = async (name) => { await writeFile(join(other, name), name); await git(other, 'add', '-A'); await git(other, 'commit', '-q', '-m', name); await git(other, 'push', '-q', 'origin', 'main') }
  return { clone, mergePr }
}

test('the practice is red exactly when a merge landed, and green once the checkout is level', async () => {
  const { clone, mergePr } = await repoPair()
  await git(clone, 'fetch', '-q', 'origin')
  const level = await readGitFacts(clone, {})
  assert.equal(level.behind, 0)
  assert.equal(detectPostMergeSync(view(level)).status, 'green')

  await mergePr('merged-pr')
  await git(clone, 'fetch', '-q', 'origin')
  const behind = await readGitFacts(clone, {})
  assert.equal(behind.behind, 1)
  const red = detectPostMergeSync(view(behind))
  assert.equal(red.status, 'red')
  assert.match(red.evidence[0], /1 commit ahead of this checkout/)

  await git(clone, 'pull', '-q', '--ff-only', 'origin', 'main')
  const after = await readGitFacts(clone, {})
  assert.equal(after.behind, 0)
  assert.equal(detectPostMergeSync(view(after)).status, 'green')
})

test('a checkout that pulled but never rebuilt is still red', async () => {
  const { clone } = await repoPair()
  await mkdir(join(clone, 'src'), { recursive: true }); await mkdir(join(clone, 'lib'), { recursive: true })
  await writeFile(join(clone, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }))
  await writeFile(join(clone, 'lib', 'x.js'), 'old')
  await utimes(join(clone, 'lib', 'x.js'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  await writeFile(join(clone, 'src', 'x.ts'), 'new')
  await git(clone, 'fetch', '-q', 'origin')
  const facts = await readGitFacts(clone, {})
  assert.equal(facts.buildStale, true)
  const r = detectPostMergeSync(view(facts))
  assert.equal(r.status, 'red')
  assert.match(r.evidence[0], /lib\/ is older than src\//)
  // A repo with no build script is not judged on staleness.
  await writeFile(join(clone, 'package.json'), JSON.stringify({ name: 'x' }))
  assert.equal((await readGitFacts(clone, {})).buildStale, undefined)
})

test('the practice is n/a outside a repo and where there is no remote default branch', async () => {
  assert.equal(detectPostMergeSync(view({ inRepo: false, gitAvailable: true, ghAvailable: false, artifacts: [], instructionFiles: [], readAt: 't' })).status, 'n/a')
  assert.equal(detectPostMergeSync(view({ inRepo: true, gitAvailable: true, ghAvailable: false, artifacts: [], instructionFiles: [], readAt: 't' })).status, 'n/a')
})

test('sync refuses dirty, non-default, and diverged checkouts; performs a clean fast-forward', async () => {
  const { clone, mergePr } = await repoPair()
  const target = { root: clone, name: 'clone', build: [['true']] }
  const idle = await checkSync(target)
  assert.equal(idle.behind, false); assert.equal(idle.work, 'none')

  await mergePr('pr-1')
  const ready = await checkSync(target)
  assert.equal(ready.behind, true); assert.equal(ready.work, 'pull'); assert.equal(ready.defaultBranch, 'main'); assert.equal(ready.refused, undefined)

  await writeFile(join(clone, 'a'), 'dirty')
  assert.match((await checkSync(target)).refused, /uncommitted changes/)
  await git(clone, 'checkout', '-q', 'a')

  await git(clone, 'checkout', '-q', '-b', 'feat/x')
  assert.match((await checkSync(target)).refused, /not main/)
  await git(clone, 'checkout', '-q', 'main')

  await writeFile(join(clone, 'local-only'), 'x'); await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'local')
  assert.match((await checkSync(target)).refused, /local commits origin does not/)
  await git(clone, 'reset', '-q', '--hard', 'HEAD~1')

  const check = await checkSync(target)
  let swept = 0
  const result = await performSync(target, check, undefined, async () => { swept += 1; return { removed: [{ path: '/x/wt' }] } })
  assert.equal(result.ok, true)
  assert.equal(result.restartNeeded, true)
  assert.equal(swept, 1)
  assert.deepEqual(result.steps.map(s => [s.step, s.ok]), [['git pull --ff-only origin main', true], ['true', true], ['sweep merged worktrees', true]])
  assert.equal(await git(clone, 'rev-parse', 'HEAD'), check.remote)
  assert.equal(await readFile(join(clone, 'pr-1'), 'utf8'), 'pr-1')
})

test('a failing build step stops the chain and does not claim a restart is needed', async () => {
  const { clone, mergePr } = await repoPair()
  await mergePr('pr-2')
  const result = await performSync({ root: clone, name: 'c', build: [['node', '-e', 'console.error("boom"); process.exit(1)'], ['true']] }, await checkSync({ root: clone, name: 'c' }))
  assert.equal(result.ok, false); assert.equal(result.restartNeeded, false)
  assert.deepEqual(result.steps.map(s => s.ok), [true, false])
  assert.match(result.steps[1].note, /boom/)
})

test('the practice is gated by a hook like the others', () => {
  const entry = HOOK_PLAN.find(e => e.practice === 'post-merge-sync')
  assert.deepEqual(entry.tools, ['write', 'edit', 'bash'])
  assert.equal(entry.event, 'PreToolUse')
})

test('a level checkout with a stale build is build-only work: no pull, just the build steps', async () => {
  const { clone } = await repoPair()
  await mkdir(join(clone, 'src'), { recursive: true }); await mkdir(join(clone, 'lib'), { recursive: true })
  await writeFile(join(clone, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }))
  await writeFile(join(clone, 'lib', 'x.js'), 'old')
  await utimes(join(clone, 'lib', 'x.js'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  await writeFile(join(clone, 'src', 'x.ts'), 'new')
  await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'src'); await git(clone, 'push', '-q', 'origin', 'main')
  const target = { root: clone, name: 'c', build: [['true']] }
  const check = await checkSync(target)
  assert.equal(check.behind, false); assert.equal(check.buildStale, true); assert.equal(check.work, 'build-only')
  const result = await performSync(target, check)
  assert.equal(result.ok, true)
  assert.deepEqual(result.steps.map(s => s.step), ['true'], 'no pull step when already level')
})
