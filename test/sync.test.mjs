import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { checkSync, performSync, readRestartFlag, writeRestartFlag, RESTART_EXIT_CODE } from '../lib/host/sync.js'
import { diagnose } from '../lib/host/doctor.js'

const exec = promisify(execFile)
const G = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = async (cwd, ...a) => (await exec('git', a, { cwd, env: { ...process.env, ...G } })).stdout.trim()

/** origin (bare) + a clone on main; returns helpers to push a new commit "upstream". */
async function repoPair() {
  const root = await mkdtemp(join(tmpdir(), 'skp-sync-'))
  const origin = join(root, 'origin.git'); const clone = join(root, 'clone'); const other = join(root, 'other')
  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin])
  await exec('git', ['clone', '-q', origin, clone]); await git(clone, 'checkout', '-q', '-b', 'main')
  await writeFile(join(clone, 'a'), '1'); await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'init'); await git(clone, 'push', '-q', '-u', 'origin', 'main')
  await exec('git', ['clone', '-q', origin, other])
  const pushUpstream = async (msg) => { await writeFile(join(other, msg), msg); await git(other, 'add', '-A'); await git(other, 'commit', '-q', '-m', msg); await git(other, 'push', '-q', 'origin', 'main') }
  return { clone, pushUpstream }
}

test('checkSync: up to date → not behind; upstream commit → behind (fast-forward); dirty and non-main are reported, not touched', async () => {
  const { clone, pushUpstream } = await repoPair()
  const target = { root: clone, name: 't', needsRestart: true }
  assert.equal((await checkSync(target)).behind, false)
  await pushUpstream('merged-pr')
  const behind = await checkSync(target)
  assert.equal(behind.behind, true); assert.notEqual(behind.local, behind.remote); assert.equal(behind.dirty, false)
  await writeFile(join(clone, 'a'), 'dirty')
  assert.equal((await checkSync(target)).dirty, true)
  await git(clone, 'checkout', '-q', 'a')
  await git(clone, 'checkout', '-q', '-b', 'feat/x')
  assert.match((await checkSync(target)).note, /not main/)
})

test('performSync pulls, runs the build steps in order, sweeps worktrees, and flags a restart only on success', async () => {
  const { clone, pushUpstream } = await repoPair()
  await pushUpstream('merged-pr')
  const target = { root: clone, name: 't', needsRestart: true, build: [['true'], ['node', '-e', 'process.exit(0)']] }
  const check = await checkSync(target)
  let swept = 0
  const result = await performSync(target, check, undefined, async () => { swept += 1; return { removed: [{ path: '/x/wt-merged' }] } })
  assert.equal(result.ok, true); assert.equal(result.restartPending, true); assert.equal(swept, 1)
  assert.deepEqual(result.steps.map(s => [s.step, s.ok]), [['git pull --ff-only', true], ['true', true], ['node -e process.exit(0)', true], ['worktrees --clean', true]])
  assert.match(result.steps[3].note, /wt-merged/)
  assert.equal(await git(clone, 'rev-parse', 'HEAD'), check.remote, 'checkout moved to origin/main')
  assert.ok((await readFile(join(clone, 'merged-pr'), 'utf8')) === 'merged-pr')
})

test('a failing build step stops the chain and does not flag a restart', async () => {
  const { clone, pushUpstream } = await repoPair()
  await pushUpstream('bad')
  const target = { root: clone, name: 't', needsRestart: true, build: [['node', '-e', 'console.error("boom"); process.exit(1)'], ['true']] }
  const result = await performSync(target, await checkSync(target))
  assert.equal(result.ok, false); assert.equal(result.restartPending, false)
  assert.deepEqual(result.steps.map(s => s.ok), [true, false])
  assert.match(result.steps[1].note, /boom/)
})

test('restart flag round-trips; doctor reports a pending restart as fail and no supervisor as warn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skp-home-'))
  assert.deepEqual(await readRestartFlag(home), { pending: false })
  await writeRestartFlag(home, { pending: true, reason: 'x → y', since: 't' })
  assert.equal((await readRestartFlag(home)).reason, 'x → y')
  const base = { libMissing: [], nodeModulesPresent: true, storeParse: [], srcNewest: 1, libNewest: 2 }
  const by = f => Object.fromEntries(f.map(x => [x.id, x.severity]))
  assert.equal(by(diagnose({ ...base, restartPending: { pending: true, reason: 'r' }, supervised: true })).restart, 'fail')
  assert.equal(by(diagnose({ ...base, restartPending: { pending: false }, supervised: false })).supervisor, 'warn')
  assert.equal(by(diagnose({ ...base, restartPending: { pending: false }, supervised: true })).supervisor, undefined)
  assert.equal(RESTART_EXIT_CODE, 75)
})
