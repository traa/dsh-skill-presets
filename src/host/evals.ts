/**
 * Replay evals: recorded sessions run through the SAME pure folds the live
 * plugin uses, compared against an expected scorecard.
 *
 * The playbook's rule — re-run the eval set whenever a skill, a practice, or
 * a context file changes — needs fixtures that are cheap, deterministic and
 * private. A fixture holds only tool names, the file path / command / skill
 * name argument, error flags, first result line, and a git-facts snapshot: no
 * prompt text, no transcript, no provider-specific format. `npm test` runs
 * them; the CLI can update expectations after an intended change.
 * @module dsh-skill-presets/host/evals
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PracticeTracker } from './practices/index.ts'
import type { ObservedCall } from './practices/detectors.ts'
import type { GitFacts } from './practices/git.ts'
import { detectStage } from './stage.ts'
import { summarize } from './telemetry.ts'
import type { PracticeStatus, PracticesDoc, Stage, UsageEvent } from './types.ts'

/** One recorded session, redacted. */
export interface Fixture {
  readonly name: string
  readonly description?: string
  /** Practices doc the session ran under (mode, protected branches, …). */
  readonly practices: PracticesDoc
  readonly activeStage?: Stage
  readonly teamAttached: boolean
  readonly cwd: string
  /** Facts as read at the end of the session; the replay serves them for every read. */
  readonly facts: GitFacts
  /** Tool calls, in order, plus the turn each user message opened. */
  readonly calls: readonly ObservedCall[]
  readonly userTurns: readonly number[]
  /** Usage events (offered/loaded/…), for the skills side of the expectation. */
  readonly events: readonly UsageEvent[]
}

/** What the replay must reproduce. */
export interface Expected {
  readonly practices: Record<string, PracticeStatus>
  readonly stage: Stage
  readonly loaded: string[]
  readonly unknown: string[]
}

export interface EvalResult {
  readonly name: string
  readonly pass: boolean
  readonly actual: Expected
  readonly expected?: Expected
  readonly diffs: string[]
}

/** Run one fixture through the tracker and folds. Pure apart from the tracker's async plumbing. */
export async function replay(fixture: Fixture): Promise<Expected> {
  const tracker = new PracticeTracker({
    practices: async () => fixture.practices,
    activeStage: async () => fixture.activeStage,
    onResult: () => {},
    // Serve the recorded facts verbatim (artifacts included — they live on a
    // filesystem the replay does not have); git/gh calls the worktree scanner
    // still makes answer from the same snapshot.
    factsOverride: () => fixture.facts,
    run: async (cmd, args) => fakeGit(fixture.facts, cmd, args),
  })
  const id = fixture.name
  tracker.session(id, fixture.cwd)
  let turn = 0
  const turnsSeen = new Set<number>()
  for (const call of fixture.calls) {
    if (call.turn !== turn && !turnsSeen.has(call.turn)) {
      turn = call.turn
      turnsSeen.add(turn)
      await tracker.onPreStep(id, turn, fixture.teamAttached, fixture.cwd)
    }
    await tracker.onToolResult(id, call)
  }
  const final = await tracker.onDisposed(id)
  const practices: Record<string, PracticeStatus> = {}
  for (const r of final) practices[r.id] = r.status
  const summary = summarize(id, fixture.events)
  return {
    practices,
    stage: detectStage(fixture.facts, fixture.calls.slice(-12)).stage,
    loaded: Object.keys(summary.loaded).sort(),
    unknown: [...new Set(summary.unknown)].sort(),
  }
}

/**
 * Answer git/gh from a facts snapshot. Only the commands the facts reader and
 * worktree scanner issue are modelled; anything else is "not ok".
 */
export function fakeGit(facts: GitFacts, cmd: string, args: readonly string[]): { ok: boolean, stdout: string, code?: string } {
  const a = args.join(' ')
  if (cmd === 'gh') {
    if (!facts.ghAvailable) return { ok: false, stdout: '', code: 'ENOENT' }
    if (a.startsWith('pr view') && facts.pr !== undefined) return { ok: true, stdout: JSON.stringify({ url: facts.pr.url, state: facts.pr.state }) }
    return { ok: false, stdout: 'no pull requests found' }
  }
  if (cmd !== 'git') return { ok: false, stdout: '', code: 'ENOENT' }
  if (!facts.gitAvailable) return { ok: false, stdout: '', code: 'ENOENT' }
  if (a === 'rev-parse --is-inside-work-tree') return facts.inRepo ? { ok: true, stdout: 'true\n' } : { ok: false, stdout: 'fatal: not a git repository' }
  if (a === 'rev-parse --git-dir') return { ok: true, stdout: facts.isWorktree === true ? `${facts.topLevel ?? '/repo'}/.git/worktrees/x\n` : `${facts.topLevel ?? '/repo'}/.git\n` }
  if (a === 'rev-parse --git-common-dir') return { ok: true, stdout: `${facts.topLevel ?? '/repo'}/.git\n` }
  if (a === 'branch --show-current') return { ok: true, stdout: `${facts.branch ?? ''}\n` }
  if (a === 'rev-parse --show-toplevel') return { ok: true, stdout: `${facts.topLevel ?? '/repo'}\n` }
  if (a === 'status --porcelain') return { ok: true, stdout: facts.dirty === true ? ' M a\n' : '' }
  if (a === 'rev-list --count @{upstream}..HEAD') return facts.hasUpstream === true ? { ok: true, stdout: `${facts.ahead ?? 0}\n` } : { ok: false, stdout: 'fatal: no upstream' }
  if (a === 'worktree list --porcelain') return { ok: true, stdout: `worktree ${facts.topLevel ?? '/repo'}\nHEAD 0000\nbranch refs/heads/${facts.branch ?? 'main'}\n\n` }
  if (a.startsWith('symbolic-ref')) return { ok: true, stdout: 'origin/main\n' }
  if (a.startsWith('rev-parse --verify')) return { ok: true, stdout: '' }
  if (a.startsWith('merge-base') || a.startsWith('rev-list --count') || a.startsWith('log -1')) return { ok: true, stdout: '0\n' }
  return { ok: false, stdout: '' }
}

/** Compare, listing every difference. */
export function diffExpected(actual: Expected, expected: Expected): string[] {
  const diffs: string[] = []
  for (const key of new Set([...Object.keys(actual.practices), ...Object.keys(expected.practices)])) {
    if (actual.practices[key] !== expected.practices[key]) diffs.push(`practice ${key}: expected ${expected.practices[key] ?? '(absent)'}, got ${actual.practices[key] ?? '(absent)'}`)
  }
  if (actual.stage !== expected.stage) diffs.push(`stage: expected ${expected.stage}, got ${actual.stage}`)
  if (actual.loaded.join(',') !== expected.loaded.join(',')) diffs.push(`loaded: expected [${expected.loaded}], got [${actual.loaded}]`)
  if (actual.unknown.join(',') !== expected.unknown.join(',')) diffs.push(`unknown: expected [${expected.unknown}], got [${actual.unknown}]`)
  return diffs
}

/** Run every fixture directory under `root`; `update` rewrites expected.json. */
export async function runEvals(root: string, options: { update?: boolean, only?: string } = {}): Promise<EvalResult[]> {
  let names: string[] = []
  try {
    names = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()
  } catch {
    return []
  }
  const results: EvalResult[] = []
  for (const name of names) {
    if (options.only !== undefined && name !== options.only) continue
    const dir = join(root, name)
    const fixture = JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8')) as Fixture
    const actual = await replay({ ...fixture, name })
    let expected: Expected | undefined
    try {
      expected = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')) as Expected
    } catch {
      expected = undefined
    }
    if (options.update === true || expected === undefined) {
      await writeFile(join(dir, 'expected.json'), `${JSON.stringify(actual, null, 2)}\n`, 'utf8')
      results.push({ name, pass: true, actual, ...(expected !== undefined ? { expected } : {}), diffs: expected === undefined ? ['(expected.json written)'] : diffExpected(actual, expected).map(d => `updated: ${d}`) })
      continue
    }
    const diffs = diffExpected(actual, expected)
    results.push({ name, pass: diffs.length === 0, actual, expected, diffs })
  }
  return results
}

/** Redact and write a fixture from live session state. */
export async function saveFixture(root: string, name: string, fixture: Omit<Fixture, 'name'>, description?: string): Promise<string> {
  const safe = name.toLowerCase().replaceAll(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'session'
  const dir = join(root, safe)
  await mkdir(dir, { recursive: true })
  const redacted: Fixture = {
    name: safe,
    ...(description !== undefined ? { description } : {}),
    practices: fixture.practices,
    ...(fixture.activeStage !== undefined ? { activeStage: fixture.activeStage } : {}),
    teamAttached: fixture.teamAttached,
    cwd: '/repo',
    facts: { ...fixture.facts, topLevel: '/repo', ...(fixture.facts.pr !== undefined ? { pr: { url: 'https://forge.example/pr/1', state: fixture.facts.pr.state } } : {}) },
    calls: fixture.calls.map(c => ({ ...c, ...(c.target !== undefined ? { target: relocate(c.target, fixture.facts.topLevel) } : {}), ...(c.resultHead !== undefined ? { resultHead: c.resultHead.slice(0, 120) } : {}) })),
    userTurns: fixture.userTurns,
    events: fixture.events.filter(e => e.kind !== 'session' && e.kind !== 'provider'),
  }
  await writeFile(join(dir, 'fixture.json'), `${JSON.stringify(redacted, null, 2)}\n`, 'utf8')
  return dir
}

function relocate(target: string, topLevel: string | undefined): string {
  if (topLevel !== undefined && target.startsWith(topLevel)) return `/repo${target.slice(topLevel.length)}`
  return target.replace(/\/Users\/[^/]+/u, '/home/user')
}
