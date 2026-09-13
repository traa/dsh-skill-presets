// The shipped fixtures must replay to their expected scorecards. A change to a
// detector, the stage fold, or the summary that alters an outcome fails here
// first — run `node lib/bin/cli.js eval --update` after an INTENDED change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEvals, replay, fakeGit } from '../lib/host/evals.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('shipped fixtures replay to their expected outcomes', async () => {
  const results = await runEvals(join(ROOT, 'evals', 'fixtures'))
  assert.ok(results.length >= 3)
  for (const r of results) assert.ok(r.pass, `${r.name}: ${r.diffs.join('; ')}`)
})

test('the three foundation fixtures encode the outcomes we designed the detectors for', async () => {
  const results = await runEvals(join(ROOT, 'evals', 'fixtures'))
  const by = Object.fromEntries(results.map(r => [r.name, r.actual]))
  assert.equal(by['build-on-main-no-plan'].practices.worktree, 'red')
  assert.equal(by['build-on-main-no-plan'].practices['plan-before-code'], 'red')
  assert.equal(by['build-on-main-no-plan'].practices['pull-request'], 'red')
  assert.deepEqual(by['build-on-main-no-plan'].unknown, ['ghost-skill'])
  assert.equal(by['worktree-with-pr-clean'].practices.worktree, 'green')
  assert.equal(by['worktree-with-pr-clean'].practices['pull-request'], 'green')
  assert.equal(by['worktree-with-pr-clean'].stage, 'test')
  assert.equal(by['conductor-self-edits'].practices.conductor, 'red')
})

test('fakeGit answers the facts reader consistently with the snapshot', () => {
  const facts = { inRepo: true, gitAvailable: true, ghAvailable: false, isWorktree: true, branch: 'f', hasUpstream: false, dirty: true, topLevel: '/r', artifacts: [], instructionFiles: [], readAt: '' }
  assert.equal(fakeGit(facts, 'git', ['rev-parse', '--is-inside-work-tree']).stdout.trim(), 'true')
  assert.notEqual(fakeGit(facts, 'git', ['rev-parse', '--git-dir']).stdout, fakeGit(facts, 'git', ['rev-parse', '--git-common-dir']).stdout)
  assert.equal(fakeGit(facts, 'git', ['status', '--porcelain']).stdout.trim().length > 0, true)
  assert.equal(fakeGit(facts, 'git', ['rev-list', '--count', '@{upstream}..HEAD']).ok, false)
  assert.equal(fakeGit(facts, 'gh', ['pr', 'view']).code, 'ENOENT')
})

test('replay is deterministic', async () => {
  const { readFile } = await import('node:fs/promises')
  const fixture = JSON.parse(await readFile(join(ROOT, 'evals/fixtures/worktree-with-pr-clean/fixture.json'), 'utf8'))
  const a = await replay(fixture)
  const b = await replay(fixture)
  assert.deepEqual(a, b)
})
