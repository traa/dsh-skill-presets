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
import { access } from 'node:fs/promises'
import { join } from 'node:path'

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
  /** Pull request state, when `gh` (or another forge CLI) could answer. */
  readonly pr?: { url: string, state: string }
  readonly ghAvailable: boolean
  /** Which of the configured artifact files exist, relative to top level. */
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
    dirty: status.ok ? status.stdout.trim().length > 0 : undefined,
    ...(topLevel !== undefined ? { topLevel } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ghAvailable,
    artifacts,
    instructionFiles,
  }
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

function normalizeDir(text: string): string {
  return text.trim().replace(/\/+$/u, '')
}
