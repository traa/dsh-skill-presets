import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { classify, parsePorcelain, scanWorktrees, cleanupWorktrees, worktreeAddPath } from '../lib/host/practices/worktrees.js'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })).stdout

/** A repo on main with: a merged worktree, an unmerged worktree, a dirty worktree. */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'skp-wt-'))
  const main = join(root, 'main')
  await exec('mkdir', [main])
  await git(main, 'init', '-q', '-b', 'main')
  await writeFile(join(main, 'a.txt'), 'a')
  await git(main, 'add', '-A'); await git(main, 'commit', '-q', '-m', 'init')
  // merged: branch with a commit, merged back into main
  await git(main, 'worktree', 'add', '-q', join(root, 'wt-merged'), '-b', 'feat/merged')
  await writeFile(join(root, 'wt-merged', 'b.txt'), 'b')
  await git(join(root, 'wt-merged'), 'add', '-A'); await git(join(root, 'wt-merged'), 'commit', '-q', '-m', 'b')
  await git(main, 'merge', '-q', '--no-ff', 'feat/merged', '-m', 'merge')
  // unmerged: has its own commit
  await git(main, 'worktree', 'add', '-q', join(root, 'wt-open'), '-b', 'feat/open')
  await writeFile(join(root, 'wt-open', 'c.txt'), 'c')
  await git(join(root, 'wt-open'), 'add', '-A'); await git(join(root, 'wt-open'), 'commit', '-q', '-m', 'c')
  // dirty: merged branch but uncommitted file + node_modules symlink
  await git(main, 'worktree', 'add', '-q', join(root, 'wt-dirty'), '-b', 'feat/dirty', 'main')
  await writeFile(join(root, 'wt-dirty', 'dirty.txt'), 'x')
  await symlink('../main/node_modules', join(root, 'wt-dirty', 'node_modules'))
  // fresh: just created from main, clean, zero commits of its own — the Phase 7 casualty
  await git(main, 'worktree', 'add', '-q', join(root, 'wt-fresh'), '-b', 'feat/fresh', 'main')
  return { root, main }
}

test('parsePorcelain reads path, head, branch, locked, prunable, detached', () => {
  const rows = parsePorcelain([
    'worktree /r/main', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /r/wt', 'HEAD bbb', 'branch refs/heads/feat/x', 'locked reason here', '',
    'worktree /r/gone', 'HEAD ccc', 'detached', 'prunable gitdir file points to non-existent location', '',
  ].join('\n'))
  assert.equal(rows.length, 3)
  assert.equal(rows[0].primary, true); assert.equal(rows[0].branch, 'main')
  assert.equal(rows[1].locked, 'reason here'); assert.equal(rows[1].branch, 'feat/x'); assert.equal(rows[1].primary, false)
  assert.equal(rows[2].detached, true); assert.match(rows[2].prunable, /non-existent/)
})

test('classify: primary/locked keep; merged+clean removable; dirty/detached/symlink attention; unmerged keep', () => {
  const base = { path: '/p', head: 'h', primary: false, detached: false }
  assert.equal(classify({ ...base, primary: true }, 'main').kind, 'keep')
  assert.equal(classify({ ...base, locked: true }, 'main').kind, 'keep')
  assert.equal(classify({ ...base, prunable: 'gone' }, 'main').kind, 'removable')
  assert.equal(classify({ ...base, branch: 'f', dirty: true, merged: true }, 'main').kind, 'attention')
  assert.equal(classify({ ...base, detached: true, dirty: false }, 'main').kind, 'attention')
  assert.equal(classify({ ...base, branch: 'main', dirty: false }, 'main').kind, 'keep')
  assert.equal(classify({ ...base, branch: 'f', dirty: false, merged: true }, 'main').kind, 'removable')
  assert.equal(classify({ ...base, branch: 'f', dirty: false, merged: false, prState: 'MERGED' }, 'main').kind, 'removable')
  assert.equal(classify({ ...base, branch: 'f', dirty: false, merged: false, nodeModulesSymlink: '../x' }, 'main').kind, 'attention')
  assert.equal(classify({ ...base, branch: 'f', dirty: false, merged: false, hasUpstream: false, aheadOfDefault: 2 }, 'main').kind, 'keep')
})

// Observed live (Phase 7): `git worktree add ../x -b feat/x origin/main`, then
// `npm ci` — and ten minutes later the hourly sweep had removed the directory
// AND deleted the branch, because a branch with zero commits beyond main was
// classified "removable: no commits beyond main". Zero ahead is what EVERY
// worktree looks like in its first minutes. "Not yet started" is not "merged".
// A fresh worktree — and one that is 0 ahead but whose HEAD equals the default
// tip, which `merge-base --is-ancestor` also reports as `merged` — must be KEPT
// until it is old enough that "abandoned" is the likelier reading, and even then
// only when it is truly merged.
test('classify: a worktree with no commits of its own is kept, not swept — "0 ahead" is not "merged"', () => {
  const base = { path: '/p', head: 'h', primary: false, detached: false, branch: 'feat/x', dirty: false }
  const fresh = classify({ ...base, merged: false, aheadOfDefault: 0, ageDays: 0 }, 'main')
  assert.equal(fresh.kind, 'keep', fresh.reason)
  assert.match(fresh.reason, /no commits of its own/i)
  // HEAD == default tip: git says "ancestor" (merged: true) — still nothing to sweep.
  const atTip = classify({ ...base, merged: true, aheadOfDefault: 0, ageDays: 0 }, 'main')
  assert.equal(atTip.kind, 'keep', atTip.reason)
  // Genuinely merged work (has commits, all of them in main) is still removable…
  assert.equal(classify({ ...base, merged: true, aheadOfDefault: 0, ageDays: 3, hasOwnCommits: true }, 'main').kind, 'removable')
  // …unless it is younger than the grace period: a merge that landed an hour ago
  // may still have a session open in that directory.
  const justMerged = classify({ ...base, merged: true, aheadOfDefault: 0, ageDays: 0, hasOwnCommits: true, ageHours: 1 }, 'main')
  assert.equal(justMerged.kind, 'keep', justMerged.reason)
  assert.match(justMerged.reason, /grace/i)
})

test('scan + cleanup on a real repo: removes merged+clean, keeps unmerged, flags dirty; dry run touches nothing', async () => {
  const { root, main } = await repo()
  const scan = await scanWorktrees(main, { skipPr: true })
  assert.equal(scan.defaultBranch, 'main')
  const by = Object.fromEntries(scan.worktrees.map(w => [w.path.split('/').pop(), w]))
  assert.equal(by.main.primary, true)
  assert.equal(by['wt-merged'].merged, true); assert.equal(by['wt-merged'].dirty, false)
  assert.equal(by['wt-open'].merged, false)
  assert.equal(by['wt-dirty'].dirty, true); assert.match(by['wt-dirty'].nodeModulesSymlink, /main\/node_modules/)
  // The scanner tells a merged branch from a never-started one, even though git
  // calls both "ancestor of main".
  assert.equal(by['wt-merged'].hasOwnCommits, true)
  assert.equal(by['wt-fresh'].merged, true, 'git itself says the fresh tip is an ancestor of main')
  assert.equal(by['wt-fresh'].hasOwnCommits, false)
  assert.equal(by['wt-fresh'].aheadOfDefault, 0)

  // Everything here was committed seconds ago, so with the default grace period
  // NOTHING is removable — that is the point of the grace period.
  const graced = await cleanupWorktrees(main, { skipPr: true, dryRun: true })
  assert.deepEqual(graced.removed, [], 'inside the grace period the merged worktree is kept')
  assert.ok(graced.kept.some(k => k.path.endsWith('wt-merged') && /grace/.test(k.reason)))

  const dry = await cleanupWorktrees(main, { skipPr: true, dryRun: true, graceHours: 0 })
  assert.deepEqual(dry.removed.map(r => r.branch), ['feat/merged'])
  assert.equal((await scanWorktrees(main, { skipPr: true })).worktrees.length, 5, 'dry run removed nothing')

  const real = await cleanupWorktrees(main, { skipPr: true, graceHours: 0 })
  assert.deepEqual(real.removed.map(r => r.branch), ['feat/merged'])
  assert.ok(real.attention.some(a => a.path.endsWith('wt-dirty') && /uncommitted/.test(a.reason)))
  assert.ok(real.kept.some(k => k.path.endsWith('wt-open')))
  assert.ok(real.kept.some(k => k.path.endsWith('wt-fresh') && /no commits of its own/.test(k.reason)), 'a fresh worktree is never swept')
  assert.deepEqual(real.errors, [])
  const after = await scanWorktrees(main, { skipPr: true })
  assert.deepEqual(after.worktrees.map(w => w.path.split('/').pop()).sort(), ['main', 'wt-dirty', 'wt-fresh', 'wt-open'])
  const branches = await git(main, 'branch', '--format=%(refname:short)')
  assert.ok(!branches.includes('feat/merged'), 'merged branch deleted')
  assert.ok(branches.includes('feat/open'))
  assert.ok(branches.includes('feat/fresh'), 'the fresh branch survives the sweep')
  void root
})

test('worktreeAddPath extracts the path from the common forms', () => {
  assert.equal(worktreeAddPath('git worktree add ../repo-x -b feat/x origin/main', '/r/main'), '/r/repo-x')
  assert.equal(worktreeAddPath('git fetch && git worktree add -b feat/y "../my dir" main', '/r/main'), '/r/my dir')
  assert.equal(worktreeAddPath('git worktree add --detach /abs/wt', '/r/main'), '/abs/wt')
  assert.equal(worktreeAddPath('git worktree list', '/r/main'), undefined)
})
