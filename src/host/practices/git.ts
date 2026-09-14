/**
 * Git and PR facts for one working directory.
 *
 * Read from the host with a short timeout and memoized per session; refreshed
 * only when a tool result suggests they may have changed. `git` and `gh` are
 * optional — their absence yields `undefined` fields, which detectors render as
 * amber ("unknown"), never as a violation.
 * @module dsh-skill-presets/host/practices/git
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface GitFacts {
  /** Whether `cwd` is inside a git work tree at all. */
  readonly inRepo: boolean
  /** Whether git itself was available; false → every other field is unknown. */
  readonly gitAvailable: boolean
  /** Whether the checkout is a linked worktree (git-dir differs from common dir). */
  readonly isWorktree?: boolean
  readonly branch?: string
  /** Commits ahead of the upstream branch; undefined without an upstream. */
  readonly ahead?: number
  readonly hasUpstream?: boolean
  readonly dirty?: boolean
  /** Repository top-level directory. */
  readonly topLevel?: string
  /**
   * The same top level spelled the way the CALLER reaches it, when that
   * differs from `topLevel`.
   *
   * `git rev-parse --show-toplevel` resolves symlinks, so a checkout reached
   * through one (macOS `/tmp` → `/private/tmp`, or a symlinked worktree)
   * reports `/private/var/…/repo` while every tool call carries
   * `/var/…/repo`. Anything testing whether a path lies INSIDE the checkout
   * must accept both spellings, or it silently concludes the write landed
   * somewhere else. Only this module can record it: it is the half that knows
   * which directory was asked about.
   */
  readonly topLevelAlias?: string
  /** Pull request state, when `gh` (or another forge CLI) could answer. */
  readonly pr?: { url: string, state: string }
  readonly ghAvailable: boolean
  /** Which of the configured artifact files exist, relative to top level. */
  /** Commits on origin/<default> that this branch does not have (a merged PR shows up here). */
  readonly behind?: number
  /** The remote default branch the count is against. */
  readonly defaultBranch?: string
  /** True when the checkout has a package.json with a build script and lib/ is older than src/. */
  readonly buildStale?: boolean
  readonly artifacts: readonly string[]
  /** Which instructions files exist. */
  readonly instructionFiles: readonly string[]
  readonly readAt: string
}

export interface Runner {
  (cmd: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean, stdout: string, code?: string }>
}

/** Default runner over `execFile`. Never throws; a missing binary is `ok: false, code: 'ENOENT'`. */
export const defaultRunner: Runner = (cmd, args, cwd, timeoutMs) => new Promise((resolve) => {
  execFile(cmd, [...args], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => {
    if (error !== null) {
      resolve({ ok: false, stdout: String(stdout ?? ''), code: (error as NodeJS.ErrnoException).code })
      return
    }
    resolve({ ok: true, stdout: String(stdout) })
  })
})

export interface ReadFactsOptions {
  run?: Runner
  timeoutMs?: number
  /** Root (relative to top level) where stage artifacts live, plus root-level fallbacks. */
  artifactRoot?: string
  instructionFiles?: readonly string[]
  /** Skip the `gh` call (e.g. when it was already known absent). */
  skipPr?: boolean
}

const ARTIFACT_FILES = ['intent.md', 'spec.md', 'plan.md']

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read the facts for one cwd.
 * @param cwd - working directory.
 * @param options - runner and timeouts.
 */
export async function readGitFacts(cwd: string, options: ReadFactsOptions = {}): Promise<GitFacts> {
  const run = options.run ?? defaultRunner
  const timeoutMs = options.timeoutMs ?? 3000
  const readAt = new Date().toISOString()
  const base = { readAt, artifacts: [] as string[], instructionFiles: [] as string[] }

  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], cwd, timeoutMs)
  if (!inside.ok) {
    const gitAvailable = inside.code !== 'ENOENT'
    return { ...base, inRepo: false, gitAvailable, ghAvailable: false }
  }
  if (inside.stdout.trim() !== 'true') return { ...base, inRepo: false, gitAvailable: true, ghAvailable: false }

  const [gitDir, commonDir, branch, top, status] = await Promise.all([
    run('git', ['rev-parse', '--git-dir'], cwd, timeoutMs),
    run('git', ['rev-parse', '--git-common-dir'], cwd, timeoutMs),
    run('git', ['branch', '--show-current'], cwd, timeoutMs),
    run('git', ['rev-parse', '--show-toplevel'], cwd, timeoutMs),
    run('git', ['status', '--porcelain'], cwd, timeoutMs),
  ])
  const topLevel = top.ok ? top.stdout.trim() : undefined
  const topLevelAlias = topLevel !== undefined ? aliasTopLevel(cwd, topLevel) : undefined
  const isWorktree = gitDir.ok && commonDir.ok
    ? normalizeDir(gitDir.stdout) !== normalizeDir(commonDir.stdout)
    : undefined
  const branchName = branch.ok ? branch.stdout.trim() : undefined

  let ahead: number | undefined
  let hasUpstream: boolean | undefined
  const upstream = await run('git', ['rev-list', '--count', '@{upstream}..HEAD'], cwd, timeoutMs)
  if (upstream.ok) {
    hasUpstream = true
    ahead = Number.parseInt(upstream.stdout.trim(), 10)
    if (Number.isNaN(ahead)) ahead = undefined
  } else {
    hasUpstream = false
  }

  // How far behind the remote default branch — a merged PR appears here on the
  // next fetch. Read-only: never fetches, so a session's facts are as fresh as
  // the last fetch the agent (or the sync command) performed.
  let behind: number | undefined
  let defaultBranch: string | undefined
  const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd, timeoutMs)
  defaultBranch = head.ok ? head.stdout.trim().replace(/^origin\//u, '') : undefined
  if (defaultBranch === undefined) {
    for (const candidate of ['main', 'master']) {
      const exists = await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`], cwd, timeoutMs)
      if (exists.ok && exists.stdout.trim().length > 0) { defaultBranch = candidate; break }
    }
  }
  if (defaultBranch !== undefined) {
    const count = await run('git', ['rev-list', '--count', `HEAD..refs/remotes/origin/${defaultBranch}`], cwd, timeoutMs)
    if (count.ok) {
      const parsed = Number.parseInt(count.stdout.trim(), 10)
      if (!Number.isNaN(parsed)) behind = parsed
    }
  }

  let pr: GitFacts['pr']
  let ghAvailable = false
  if (options.skipPr !== true) {
    const gh = await run('gh', ['pr', 'view', '--json', 'url,state'], cwd, timeoutMs)
    ghAvailable = gh.code !== 'ENOENT'
    if (gh.ok) {
      try {
        const parsed = JSON.parse(gh.stdout) as { url?: string, state?: string }
        if (typeof parsed.url === 'string') pr = { url: parsed.url, state: parsed.state ?? 'OPEN' }
      } catch {
        pr = undefined
      }
    }
  }

  const buildStale = topLevel !== undefined ? await isBuildStale(topLevel) : undefined

  const artifacts: string[] = []
  const instructionFiles: string[] = []
  if (topLevel !== undefined) {
    const root = options.artifactRoot ?? 'docs/sdlc'
    for (const file of ARTIFACT_FILES) {
      if (await exists(join(topLevel, root, file))) artifacts.push(`${root}/${file}`)
      else if (await exists(join(topLevel, file))) artifacts.push(file)
      else {
        // One level of slug directories under the root: docs/sdlc/<slug>/plan.md
        const found = await findInSlugDirs(join(topLevel, root), file)
        if (found !== undefined) artifacts.push(`${root}/${found}`)
      }
    }
    for (const file of options.instructionFiles ?? ['AGENTS.md']) {
      if (await exists(join(topLevel, file))) instructionFiles.push(file)
    }
  }

  return {
    readAt,
    inRepo: true,
    gitAvailable: true,
    ...(isWorktree !== undefined ? { isWorktree } : {}),
    ...(branchName !== undefined && branchName.length > 0 ? { branch: branchName } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    hasUpstream,
    ...(behind !== undefined ? { behind } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(buildStale !== undefined ? { buildStale } : {}),
    dirty: status.ok ? status.stdout.trim().length > 0 : undefined,
    ...(topLevel !== undefined ? { topLevel } : {}),
    ...(topLevelAlias !== undefined ? { topLevelAlias } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ghAvailable,
    artifacts,
    instructionFiles,
  }
}

/**
 * The top level spelled the way `cwd` reaches it, when a symlink makes that
 * differ from git's resolved answer.
 *
 * `cwd` and `topLevel` name the same directory by construction — git was asked
 * about `cwd` — but git resolved symlinks and the caller did not. Walking
 * `cwd` up by however many segments separate the RESOLVED cwd from the
 * resolved top level lands on the caller's own spelling of it. Returns
 * undefined when nothing resolves differently, so the common case adds no
 * field at all.
 */
function aliasTopLevel(cwd: string, topLevel: string): string | undefined {
  let realCwd: string
  try {
    realCwd = realpathSync(cwd)
  } catch {
    return undefined
  }
  if (realCwd === cwd) return undefined
  const down = relative(topLevel, realCwd)
  if (down.startsWith('..') || isAbsolute(down)) return undefined
  const up = down === '' ? 0 : down.split(sep).length
  const alias = resolve(cwd, ...Array.from({ length: up }, () => '..'))
  return alias === topLevel ? undefined : alias
}

async function findInSlugDirs(root: string, file: string): Promise<string | undefined> {
  const { readdir } = await import('node:fs/promises')
  let entries: { name: string, isDirectory(): boolean }[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await exists(join(root, entry.name, file))) return `${entry.name}/${file}`
  }
  return undefined
}

/**
 * A checkout whose `lib/` is older than its `src/` (or missing) while its
 * package.json declares a build script — i.e. someone pulled and did not
 * rebuild. Cheap: compares the newest mtime on each side, no walk of
 * node_modules.
 */
export async function isBuildStale(topLevel: string): Promise<boolean | undefined> {
  const { readFile } = await import('node:fs/promises')
  try {
    const pkg = JSON.parse(await readFile(`${topLevel}/package.json`, 'utf8')) as { scripts?: Record<string, string> }
    if (typeof pkg.scripts?.build !== 'string') return undefined
  } catch {
    return undefined
  }
  const newest = async (dir: string, ext: string): Promise<number | undefined> => {
    const { readdir, stat } = await import('node:fs/promises')
    let out: number | undefined
    const walk = async (current: string): Promise<void> => {
      let entries
      try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const full = `${current}/${e.name}`
        if (e.isDirectory()) await walk(full)
        else if (e.name.endsWith(ext)) {
          const m = (await stat(full)).mtimeMs
          if (out === undefined || m > out) out = m
        }
      }
    }
    await walk(dir)
    return out
  }
  const [src, lib] = await Promise.all([newest(`${topLevel}/src`, '.ts'), newest(`${topLevel}/lib`, '.js')])
  if (src === undefined) return undefined
  return lib === undefined || src > lib + 1000
}

function normalizeDir(text: string): string {
  return text.trim().replace(/\/+$/u, '')
}
