/**
 * Self-update: when a plugin's `main` moves on the remote (a PR merged),
 * pull, install, build, sweep merged worktrees, run the doctor, and record
 * that a restart is pending. The running process never restarts itself —
 * the supervisor (`dsh-skill-presets serve`) does that when no session is
 * mid-turn, or the user presses Restart.
 *
 * Every step is a plain shell command with a timeout; a failure at any step
 * leaves the checkout on the previous commit's build (we only `git pull`
 * after `fetch` shows fast-forwardable work, and `npm run build` writes
 * `lib/` last). Pure decision logic is separated for tests.
 * @module dsh-skill-presets/host/sync
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SyncTarget {
  /** Absolute path of the primary checkout. */
  readonly root: string
  /** Display name. */
  readonly name: string
  /** Commands to run after pull, in order. Default: npm ci, npm run build. */
  readonly build?: readonly string[][]
  /** Whether the running server must restart to pick the change up. */
  readonly needsRestart: boolean
}

export interface SyncCheck {
  readonly target: string
  readonly local: string
  readonly remote: string
  /** origin/main is strictly ahead and local is an ancestor (fast-forward). */
  readonly behind: boolean
  readonly dirty: boolean
  readonly note?: string
}

export interface SyncResult {
  readonly target: string
  readonly from: string
  readonly to: string
  readonly steps: { step: string, ok: boolean, ms: number, note?: string }[]
  readonly ok: boolean
  readonly restartPending: boolean
}

export type Run = (cmd: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<{ ok: boolean, stdout: string, stderr: string }>

export const shellRun: Run = (cmd, args, cwd, timeoutMs) => new Promise((resolve) => {
  execFile(cmd, [...args], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1' } }, (error, stdout, stderr) => {
    resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? (error?.message ?? '')) })
  })
})

/** Fetch and compare. Never mutates the working tree. */
export async function checkSync(target: SyncTarget, run: Run = shellRun): Promise<SyncCheck> {
  const t = 30_000
  const fetch = await run('git', ['fetch', '--quiet', 'origin'], target.root, t)
  if (!fetch.ok) return { target: target.name, local: '', remote: '', behind: false, dirty: false, note: `fetch failed: ${fetch.stderr.trim().slice(0, 200)}` }
  const [local, remote, status, branch] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], target.root, t),
    run('git', ['rev-parse', 'origin/main'], target.root, t),
    run('git', ['status', '--porcelain'], target.root, t),
    run('git', ['branch', '--show-current'], target.root, t),
  ])
  if (!remote.ok) return { target: target.name, local: local.stdout.trim(), remote: '', behind: false, dirty: false, note: 'no origin/main' }
  const l = local.stdout.trim()
  const r = remote.stdout.trim()
  if (branch.stdout.trim() !== 'main') return { target: target.name, local: l, remote: r, behind: false, dirty: false, note: `checkout is on ${branch.stdout.trim() || 'a detached HEAD'}, not main; not touching it` }
  if (l === r) return { target: target.name, local: l, remote: r, behind: false, dirty: status.stdout.trim().length > 0 }
  const ff = await run('git', ['merge-base', '--is-ancestor', l, r], target.root, t)
  return { target: target.name, local: l, remote: r, behind: ff.ok, dirty: status.stdout.trim().length > 0, ...(ff.ok ? {} : { note: 'local main has commits origin/main lacks; not touching it' }) }
}

/** Pull + build + sweep. Assumes `checkSync` said behind && !dirty. */
export async function performSync(target: SyncTarget, check: SyncCheck, run: Run = shellRun, cleanupWorktrees?: (root: string) => Promise<{ removed: { path: string }[] }>): Promise<SyncResult> {
  const steps: SyncResult['steps'] = []
  const step = async (name: string, cmd: string, args: readonly string[], timeoutMs: number): Promise<boolean> => {
    const started = Date.now()
    const out = await run(cmd, args, target.root, timeoutMs)
    steps.push({ step: name, ok: out.ok, ms: Date.now() - started, ...(out.ok ? {} : { note: (out.stderr || out.stdout).trim().slice(0, 300) }) })
    return out.ok
  }
  let ok = await step('git pull --ff-only', 'git', ['pull', '--ff-only', '--quiet', 'origin', 'main'], 60_000)
  for (const cmd of ok ? (target.build ?? [['npm', 'ci', '--no-audit', '--no-fund'], ['npm', 'run', 'build']]) : []) {
    ok = await step(cmd.join(' '), cmd[0], cmd.slice(1), 300_000)
    if (!ok) break
  }
  if (ok && cleanupWorktrees !== undefined) {
    const started = Date.now()
    try {
      const r = await cleanupWorktrees(target.root)
      steps.push({ step: 'worktrees --clean', ok: true, ms: Date.now() - started, ...(r.removed.length > 0 ? { note: `removed ${r.removed.map(x => x.path.split('/').pop()).join(', ')}` } : {}) })
    } catch (error) {
      steps.push({ step: 'worktrees --clean', ok: false, ms: Date.now() - started, note: (error as Error).message })
    }
  }
  return { target: target.name, from: check.local, to: check.remote, steps, ok, restartPending: ok && target.needsRestart }
}

// ------------------------------------------------------------ restart flag --

export interface RestartState {
  readonly pending: boolean
  readonly reason?: string
  readonly since?: string
  /** Commits (name → sha) the running server does NOT have yet. */
  readonly updates?: Record<string, string>
}

export function restartFlagPath(dshHome: string): string {
  return join(dshHome, 'skill-presets.restart.json')
}

export async function readRestartFlag(dshHome: string): Promise<RestartState> {
  try {
    return JSON.parse(await readFile(restartFlagPath(dshHome), 'utf8')) as RestartState
  } catch {
    return { pending: false }
  }
}

export async function writeRestartFlag(dshHome: string, state: RestartState): Promise<void> {
  await writeFile(restartFlagPath(dshHome), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** What the supervisor reads: exit with this code means "restart me". */
export const RESTART_EXIT_CODE = 75
