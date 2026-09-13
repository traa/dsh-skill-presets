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
  assert.equal(classify({ ...base, branch: 'f', dirty: false, merged: false, aheadOfDefault: 0 }, 'main').kind, 'removable')
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

  const dry = await cleanupWorktrees(main, { skipPr: true, dryRun: true })
  assert.deepEqual(dry.removed.map(r => r.branch), ['feat/merged'])
  assert.equal((await scanWorktrees(main, { skipPr: true })).worktrees.length, 4, 'dry run removed nothing')

  const real = await cleanupWorktrees(main, { skipPr: true })
  assert.deepEqual(real.removed.map(r => r.branch), ['feat/merged'])
  assert.ok(real.attention.some(a => a.path.endsWith('wt-dirty') && /uncommitted/.test(a.reason)))
  assert.ok(real.kept.some(k => k.path.endsWith('wt-open')))
  assert.deepEqual(real.errors, [])
  const after = await scanWorktrees(main, { skipPr: true })
  assert.deepEqual(after.worktrees.map(w => w.path.split('/').pop()).sort(), ['main', 'wt-dirty', 'wt-open'])
  const branches = await git(main, 'branch', '--format=%(refname:short)')
  assert.ok(!branches.includes('feat/merged'), 'merged branch deleted')
  assert.ok(branches.includes('feat/open'))
  void root
})

test('worktreeAddPath extracts the path from the common forms', () => {
  assert.equal(worktreeAddPath('git worktree add ../repo-x -b feat/x origin/main', '/r/main'), '/r/repo-x')
  assert.equal(worktreeAddPath('git fetch && git worktree add -b feat/y "../my dir" main', '/r/main'), '/r/my dir')
  assert.equal(worktreeAddPath('git worktree add --detach /abs/wt', '/r/main'), '/abs/wt')
  assert.equal(worktreeAddPath('git worktree list', '/r/main'), undefined)
})
