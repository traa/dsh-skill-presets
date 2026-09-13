/**
 * `sync`: the one command the `post-merge-sync` practice tells the agent to
 * run when a PR of a checkout has been merged.
 *
 * It is deliberately a COMMAND, not a background job: the agent runs it as a
 * step of its work, sees the output, and reports the one thing it cannot do
 * itself — the server restart. Refuses anything that is not a clean,
 * fast-forwardable default branch, so work in progress is never touched.
 * @module dsh-skill-presets/host/sync
 */

import { execFile } from 'node:child_process'
import { isBuildStale } from './practices/git.ts'

export interface SyncTarget {
  readonly root: string
  readonly name: string
  /** Commands after the pull; default `npm ci` then `npm run build`. */
  readonly build?: readonly string[][]
}

export interface SyncCheck {
  readonly target: string
  readonly local: string
  readonly remote: string
  readonly defaultBranch: string
  /** Remote default branch is strictly ahead AND local is an ancestor of it. */
  readonly behind: boolean
  /** lib/ is older than src/ in a checkout that declares a build script. */
  readonly buildStale?: boolean
  /** Anything to do at all: pull, or just rebuild. */
  readonly work: 'pull' | 'build-only' | 'none'
  readonly dirty: boolean
  /** Set when the checkout must not be touched, with the reason. */
  readonly refused?: string
}

export interface SyncResult {
  readonly target: string
  readonly from: string
  readonly to: string
  readonly steps: { step: string, ok: boolean, ms: number, note?: string }[]
  readonly ok: boolean
  /** The running server still holds the previous build — a human must restart it. */
  readonly restartNeeded: boolean
}

export type Run = (cmd: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<{ ok: boolean, stdout: string, stderr: string }>

export const shellRun: Run = (cmd, args, cwd, timeoutMs) => new Promise((resolve) => {
  execFile(cmd, [...args], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1' } }, (error, stdout, stderr) => {
    resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? (error?.message ?? '')) })
  })
})

/** Fetch and decide. Never mutates the working tree. */
export async function checkSync(target: SyncTarget, run: Run = shellRun): Promise<SyncCheck> {
  const t = 30_000
  const empty = { target: target.name, local: '', remote: '', defaultBranch: '', behind: false, dirty: false, work: 'none' as const }
  const fetch = await run('git', ['fetch', '--quiet', 'origin'], target.root, t)
  if (!fetch.ok) return { ...empty, refused: `git fetch failed: ${fetch.stderr.trim().slice(0, 200)}` }
  const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], target.root, t)
  let defaultBranch = head.ok ? head.stdout.trim().replace(/^origin\//u, '') : ''
  if (defaultBranch.length === 0) {
    for (const candidate of ['main', 'master']) {
      const exists = await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`], target.root, t)
      if (exists.ok && exists.stdout.trim().length > 0) { defaultBranch = candidate; break }
    }
  }
  if (defaultBranch.length === 0) return { ...empty, refused: 'no origin default branch' }
  const stale = await isBuildStale(target.root)
  const [branch, local, remote, status] = await Promise.all([
    run('git', ['branch', '--show-current'], target.root, t),
    run('git', ['rev-parse', 'HEAD'], target.root, t),
    run('git', ['rev-parse', `refs/remotes/origin/${defaultBranch}`], target.root, t),
    run('git', ['status', '--porcelain'], target.root, t),
  ])
  const current = branch.stdout.trim()
  const base = { target: target.name, local: local.stdout.trim(), remote: remote.stdout.trim(), defaultBranch, dirty: status.stdout.trim().length > 0, ...(stale !== undefined ? { buildStale: stale } : {}) }
  if (current !== defaultBranch) return { ...base, behind: false, work: 'none', refused: `on ${current.length > 0 ? current : 'a detached HEAD'}, not ${defaultBranch} — that is someone's work in progress` }
  // Level with the remote, but the build never ran after the last pull: rebuild only.
  if (base.local === base.remote) return { ...base, behind: false, work: stale === true ? 'build-only' : 'none' }
  const ff = await run('git', ['merge-base', '--is-ancestor', base.local, base.remote], target.root, t)
  if (!ff.ok) return { ...base, behind: false, work: 'none', refused: `${defaultBranch} has local commits origin does not — push or reset them first` }
  if (base.dirty) return { ...base, behind: true, work: 'none', refused: 'uncommitted changes — commit or stash them first' }
  return { ...base, behind: true, work: 'pull' }
}

/** Pull, install, build, sweep. Stops at the first failure. */
export async function performSync(
  target: SyncTarget,
  check: SyncCheck,
  run: Run = shellRun,
  cleanupWorktrees?: (root: string) => Promise<{ removed: { path: string }[] }>,
): Promise<SyncResult> {
  const steps: SyncResult['steps'] = []
  const step = async (name: string, cmd: string, args: readonly string[], timeoutMs: number): Promise<boolean> => {
    const started = Date.now()
    const out = await run(cmd, args, target.root, timeoutMs)
    steps.push({ step: name, ok: out.ok, ms: Date.now() - started, ...(out.ok ? {} : { note: (out.stderr || out.stdout).trim().slice(0, 300) }) })
    return out.ok
  }
  let ok = check.behind
    ? await step(`git pull --ff-only origin ${check.defaultBranch}`, 'git', ['pull', '--ff-only', '--quiet', 'origin', check.defaultBranch], 60_000)
    : true
  for (const cmd of ok ? (target.build ?? [['npm', 'ci', '--no-audit', '--no-fund'], ['npm', 'run', 'build']]) : []) {
    ok = await step(cmd.join(' '), cmd[0], cmd.slice(1), 300_000)
    if (!ok) break
  }
  if (ok && cleanupWorktrees !== undefined) {
    const started = Date.now()
    try {
      const r = await cleanupWorktrees(target.root)
      steps.push({ step: 'sweep merged worktrees', ok: true, ms: Date.now() - started, note: r.removed.length > 0 ? `removed ${r.removed.map(x => x.path.split('/').pop()).join(', ')}` : 'none to remove' })
    } catch (error) {
      steps.push({ step: 'sweep merged worktrees', ok: false, ms: Date.now() - started, note: (error as Error).message })
    }
  }
  return { target: target.name, from: check.local, to: check.remote, steps, ok, restartNeeded: ok }
}
