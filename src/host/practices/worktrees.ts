/**
 * Worktree lifecycle: list, classify, and clean up the linked worktrees of a
 * repository.
 *
 * `worktree-first` creates worktrees; nothing removed them. Phase 2 left its
 * own behind, with a committed `node_modules` symlink that broke the main
 * build. This module makes removal safe and automatic: a worktree is removed
 * only when its branch is MERGED into the default branch AND its tree is
 * CLEAN; the branch goes with it; dirty or unmerged trees are reported, never
 * touched. Pure classification + thin git shell; the runner is injectable.
 * @module dsh-skill-presets/host/practices/worktrees
 */

import { lstat, readlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { defaultRunner, type Runner } from './git.ts'

export interface WorktreeInfo {
  readonly path: string
  readonly head: string
  readonly branch?: string
  /** True for the main checkout (`git worktree list` first row). */
  readonly primary: boolean
  readonly locked?: string | true
  readonly prunable?: string
  readonly detached: boolean
  /** Uncommitted changes present. */
  readonly dirty?: boolean
  /** Branch is an ancestor of the default branch tip (or its PR is merged). */
  readonly merged?: boolean
  /** Commits ahead of upstream; undefined without an upstream. */
  readonly ahead?: number
  readonly hasUpstream?: boolean
  /** Commits on this branch that the default branch does not have. */
  readonly aheadOfDefault?: number
  /** `node_modules` inside the worktree is a symlink — the footgun. */
  readonly nodeModulesSymlink?: string
  /** Age in days of the newest commit on the branch. */
  readonly ageDays?: number
  readonly prState?: string
  readonly prUrl?: string
  /** Session that created it, when the plugin observed the `git worktree add`. */
  readonly createdBy?: string
  readonly createdAt?: string
}

export type WorktreeVerdict =
  | { kind: 'keep', reason: string }
  | { kind: 'removable', reason: string }
  | { kind: 'attention', reason: string }

/** Decide what to do with a worktree. Pure. */
export function classify(info: WorktreeInfo, defaultBranch: string): WorktreeVerdict {
  if (info.primary) return { kind: 'keep', reason: 'primary checkout' }
  if (info.locked !== undefined) return { kind: 'keep', reason: `locked${typeof info.locked === 'string' && info.locked.length > 0 ? `: ${info.locked}` : ''}` }
  if (info.prunable !== undefined) return { kind: 'removable', reason: `prunable: ${info.prunable}` }
  if (info.dirty === true) return { kind: 'attention', reason: 'uncommitted changes — commit, stash, or remove by hand' }
  if (info.detached) return { kind: 'attention', reason: 'detached HEAD — no branch to judge merged state' }
  if (info.branch === defaultBranch) return { kind: 'keep', reason: `on the default branch ${defaultBranch}` }
  if (info.merged === true) return { kind: 'removable', reason: `branch ${info.branch ?? ''} is merged into ${defaultBranch}` }
  if (info.prState !== undefined && /merged/iu.test(info.prState)) return { kind: 'removable', reason: `PR merged: ${info.prUrl ?? ''}` }
  if (info.nodeModulesSymlink !== undefined) return { kind: 'attention', reason: `node_modules is a symlink → ${info.nodeModulesSymlink}; replace with npm ci before committing` }
  if ((info.aheadOfDefault ?? 1) === 0) return { kind: 'removable', reason: `branch ${info.branch ?? ''} has no commits beyond ${defaultBranch}` }
  return { kind: 'keep', reason: `branch ${info.branch ?? ''} has unmerged work${info.aheadOfDefault !== undefined ? ` (${info.aheadOfDefault} commit${info.aheadOfDefault === 1 ? '' : 's'} beyond ${defaultBranch}${info.hasUpstream === false ? ', not pushed' : ''})` : ''}` }
}

/** Parse `git worktree list --porcelain`. Pure. */
export function parsePorcelain(text: string): Pick<WorktreeInfo, 'path' | 'head' | 'branch' | 'primary' | 'locked' | 'prunable' | 'detached'>[] {
  const out: Pick<WorktreeInfo, 'path' | 'head' | 'branch' | 'primary' | 'locked' | 'prunable' | 'detached'>[] = []
  let current: Record<string, string | true> | undefined
  const flush = (): void => {
    if (current?.worktree === undefined) return
    out.push({
      path: String(current.worktree),
      head: String(current.HEAD ?? ''),
      ...(typeof current.branch === 'string' ? { branch: current.branch.replace(/^refs\/heads\//u, '') } : {}),
      primary: out.length === 0,
      ...(current.locked !== undefined ? { locked: current.locked === true ? true : String(current.locked) } : {}),
      ...(current.prunable !== undefined ? { prunable: String(current.prunable) } : {}),
      detached: current.detached === true,
    })
  }
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) { flush(); current = undefined; continue }
    current ??= {}
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? true : line.slice(space + 1)
    current[key] = value
  }
  flush()
  return out
}

export interface WorktreeScanOptions {
  run?: Runner
  timeoutMs?: number
  /** Known creations, keyed by worktree path. */
  created?: Record<string, { sessionId: string, at: string }>
  skipPr?: boolean
}

/** Resolve the default branch name (origin/HEAD, else main/master present). */
export async function defaultBranchOf(repo: string, run: Runner, timeoutMs: number): Promise<string> {
  const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repo, timeoutMs)
  if (head.ok && head.stdout.trim().length > 0) return head.stdout.trim().replace(/^origin\//u, '')
  for (const candidate of ['main', 'master', 'develop', 'trunk']) {
    const exists = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], repo, timeoutMs)
    if (exists.ok) return candidate
  }
  return 'main'
}

/**
 * List and enrich every worktree of the repository containing `cwd`.
 * @returns worktrees plus the default branch used for judgement.
 */
export async function scanWorktrees(cwd: string, options: WorktreeScanOptions = {}): Promise<{ defaultBranch: string, worktrees: WorktreeInfo[] }> {
  const run = options.run ?? defaultRunner
  const timeoutMs = options.timeoutMs ?? 5000
  const list = await run('git', ['worktree', 'list', '--porcelain'], cwd, timeoutMs)
  if (!list.ok) return { defaultBranch: 'main', worktrees: [] }
  const rows = parsePorcelain(list.stdout)
  const primary = rows.find(r => r.primary)?.path ?? cwd
  const defaultBranch = await defaultBranchOf(primary, run, timeoutMs)
  const worktrees: WorktreeInfo[] = []
  for (const row of rows) {
    let info: WorktreeInfo = { ...row }
    if (row.prunable === undefined) {
      const [status, merged, upstream, age, beyond] = await Promise.all([
        run('git', ['status', '--porcelain'], row.path, timeoutMs),
        row.branch !== undefined ? run('git', ['merge-base', '--is-ancestor', row.head, `refs/heads/${defaultBranch}`], primary, timeoutMs) : Promise.resolve({ ok: false, stdout: '' }),
        run('git', ['rev-list', '--count', '@{upstream}..HEAD'], row.path, timeoutMs),
        run('git', ['log', '-1', '--format=%ct'], row.path, timeoutMs),
        run('git', ['rev-list', '--count', `refs/heads/${defaultBranch}..${row.head}`], primary, timeoutMs),
      ])
      const ts = Number.parseInt(age.stdout.trim(), 10)
      info = {
        ...info,
        dirty: status.ok ? status.stdout.trim().length > 0 : undefined,
        ...(row.branch !== undefined ? { merged: merged.ok } : {}),
        hasUpstream: upstream.ok,
        ...(upstream.ok ? { ahead: Number.parseInt(upstream.stdout.trim(), 10) || 0 } : {}),
        ...(beyond.ok ? { aheadOfDefault: Number.parseInt(beyond.stdout.trim(), 10) || 0 } : {}),
        ...(Number.isFinite(ts) ? { ageDays: Math.floor((Date.now() / 1000 - ts) / 86_400) } : {}),
      }
      try {
        const nm = join(row.path, 'node_modules')
        const st = await lstat(nm)
        if (st.isSymbolicLink()) info = { ...info, nodeModulesSymlink: await readlink(nm) }
      } catch { /* absent */ }
      if (!row.primary && options.skipPr !== true && row.branch !== undefined && info.merged !== true) {
        const pr = await run('gh', ['pr', 'view', row.branch, '--json', 'state,url'], primary, timeoutMs)
        if (pr.ok) {
          try {
            const parsed = JSON.parse(pr.stdout) as { state?: string, url?: string }
            info = { ...info, ...(parsed.state !== undefined ? { prState: parsed.state } : {}), ...(parsed.url !== undefined ? { prUrl: parsed.url } : {}) }
          } catch { /* ignore */ }
        }
      }
    }
    const created = options.created?.[resolve(row.path)]
    if (created !== undefined) info = { ...info, createdBy: created.sessionId, createdAt: created.at }
    worktrees.push(info)
  }
  return { defaultBranch, worktrees }
}

export interface CleanupResult {
  readonly removed: { path: string, branch?: string, reason: string }[]
  readonly kept: { path: string, reason: string }[]
  readonly attention: { path: string, reason: string }[]
  readonly errors: { path: string, error: string }[]
  readonly dryRun: boolean
}

/**
 * Remove every `removable` worktree (and its branch), prune, report the rest.
 * Never touches `keep`/`attention`.
 */
export async function cleanupWorktrees(cwd: string, options: WorktreeScanOptions & { dryRun?: boolean, only?: string[] } = {}): Promise<CleanupResult> {
  const run = options.run ?? defaultRunner
  const timeoutMs = options.timeoutMs ?? 10_000
  const { defaultBranch, worktrees } = await scanWorktrees(cwd, options)
  const primary = worktrees.find(w => w.primary)?.path ?? cwd
  const result: CleanupResult = { removed: [], kept: [], attention: [], errors: [], dryRun: options.dryRun === true }
  for (const wt of worktrees) {
    if (options.only !== undefined && !options.only.some(p => resolve(p) === resolve(wt.path))) continue
    const verdict = classify(wt, defaultBranch)
    if (verdict.kind === 'keep') { result.kept.push({ path: wt.path, reason: verdict.reason }); continue }
    if (verdict.kind === 'attention') { result.attention.push({ path: wt.path, reason: verdict.reason }); continue }
    if (options.dryRun === true) { result.removed.push({ path: wt.path, ...(wt.branch !== undefined ? { branch: wt.branch } : {}), reason: verdict.reason }); continue }
    const rm = wt.prunable !== undefined
      ? { ok: true, stdout: '' }
      : await run('git', ['worktree', 'remove', wt.path], primary, timeoutMs)
    if (!rm.ok) { result.errors.push({ path: wt.path, error: rm.stdout.trim() || 'git worktree remove failed' }); continue }
    if (wt.branch !== undefined && wt.branch !== defaultBranch) {
      const del = await run('git', ['branch', '-d', wt.branch], primary, timeoutMs)
      if (!del.ok) result.errors.push({ path: wt.path, error: `worktree removed; branch ${wt.branch} kept: ${del.stdout.trim() || 'not fully merged'}` })
    }
    result.removed.push({ path: wt.path, ...(wt.branch !== undefined ? { branch: wt.branch } : {}), reason: verdict.reason })
  }
  if (options.dryRun !== true) await run('git', ['worktree', 'prune'], primary, timeoutMs)
  return result
}

/** Detect a `git worktree add …` in a shell command and return the path it creates. Pure. */
export function worktreeAddPath(command: string, cwd: string): string | undefined {
  const m = command.match(/\bgit\s+worktree\s+add\s+(?:(?:-b|-B|--detach|--lock|--force|-f|--checkout|--no-checkout|--track|--no-track|--quiet|-q|--orphan)\s*(?:\S+\s+)?)*(?:"([^"]+)"|'([^']+)'|(\S+))/u)
  if (m === null) return undefined
  const raw = (m[1] ?? m[2] ?? m[3]).replace(/^~(?=\/|$)/u, process.env.HOME ?? '~')
  if (raw.startsWith('-')) return undefined
  return resolve(cwd, raw)
}

/**
 * Whether a shell command changes WHICH worktrees exist. Pure.
 *
 * The scan behind `worktree-hygiene` is cached for a minute, so a sweep left
 * the verdict asserting "1 merged worktree still present" while the tree was
 * already gone. Any command that adds, removes, moves or prunes a worktree —
 * including this plugin's own `worktrees --clean` and `sync`, which sweep
 * merged ones — must invalidate that cache. `git worktree list` is read-only
 * and deliberately excluded.
 */
export function changesWorktrees(command: string | undefined): boolean {
  if (command === undefined) return false
  if (/\bgit\s+(?:-[^\s]+\s+\S+\s+)*worktree\s+(?:add|remove|move|prune)\b/u.test(command)) return true
  return /\bworktrees\b[^&|;]*--clean\b/u.test(command) || /\bdsh-skill-presets\s+sync\b/u.test(command)
}

/** Short display name for a worktree path. */
export function worktreeLabel(path: string): string {
  return basename(path)
}
