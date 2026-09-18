/**
 * Per-session practice tracking.
 *
 * Holds the observed calls and cached git facts for each live agent, re-runs
 * the pure detectors when something relevant happens, records status changes
 * as telemetry, and answers the scorecard RPC. Git facts are refreshed lazily
 * and only when a call could have changed them.
 * @module dsh-skill-presets/host/practices
 */

import { evaluate, isMutatingCall, worst, type ObservedCall, type SessionView } from './detectors.ts'
import { readGitFacts, type GitFacts, type Runner } from './git.ts'
import { coveredByPlan, isDocsPath, isPlanArtifact, planPaths } from './plan.ts'
import { attributedWorkRoot, currentWorkRoot } from './workroot.ts'
import { changesWorktrees, classify, scanWorktrees, worktreeAddPath, type WorktreeInfo } from './worktrees.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PracticeId, PracticeResult, PracticesDoc, Stage } from '../types.ts'

export interface SessionState {
  readonly sessionId: string
  cwd?: string
  agentPreset?: string
  calls: ObservedCall[]
  userTurns: number[]
  currentTurn: number
  facts?: GitFacts
  factsDirty: boolean
  factsPending?: Promise<void>
  teamAttached: boolean
  approvalRequired?: boolean
  ended: boolean
  results: PracticeResult[]
  lastReported: Map<PracticeId, string>
  turnsSincePrCheck: number
  /** The directory facts were last read for (derived from calls, else cwd). */
  workRoot?: string
  /** Parsed plan.md patterns, keyed by the plan path they came from. */
  plan?: { path: string, patterns: string[], readAt: string }
  drift: { path: string, t: string }[]
  planUpdated: boolean
  worktrees?: { defaultBranch: string, list: WorktreeInfo[], scannedAt: number }
  /** A worktree-changing call landed; the scan is invalid until it is redone. */
  worktreesStale: boolean
  /** Paths already announced as drift (one context line each). */
  announced: Set<string>
}

export interface TrackerDeps {
  practices: () => Promise<PracticesDoc>
  /** Worktrees the plugin saw created, keyed by absolute path. */
  createdWorktrees?: () => Promise<Record<string, { sessionId: string, at: string }>>
  /** A `git worktree add` was observed. */
  onWorktreeCreated?: (sessionId: string, path: string) => void
  activeStage: (sessionId: string, agentPreset?: string) => Promise<Stage | undefined>
  /** Emit a practice status change. */
  onResult: (sessionId: string, result: PracticeResult) => void
  run?: Runner
  log?: (message: string) => void
  /** Replays: serve these facts instead of reading git (the fixture's snapshot). */
  factsOverride?: (cwd: string) => GitFacts
}

export class PracticeTracker {
  private readonly sessions = new Map<string, SessionState>()

  constructor(private readonly deps: TrackerDeps) {}

  /** Create or fetch state for a session. */
  session(sessionId: string, cwd?: string, agentPreset?: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId, calls: [], userTurns: [], currentTurn: 0, factsDirty: true, teamAttached: false, ended: false,
        results: [], lastReported: new Map(), turnsSincePrCheck: 0, drift: [], planUpdated: false, announced: new Set(),
        worktreesStale: false,
      }
      this.sessions.set(sessionId, state)
    }
    if (cwd !== undefined && state.cwd !== cwd) { state.cwd = cwd; state.factsDirty = true }
    if (agentPreset !== undefined) state.agentPreset = agentPreset
    return state
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** A new step is about to run; `turn` comes from the loop. */
  async onPreStep(sessionId: string, turn: number, teamAttached: boolean, cwd?: string, agentPreset?: string, approvalRequired?: boolean): Promise<void> {
    const state = this.session(sessionId, cwd, agentPreset)
    state.approvalRequired = approvalRequired
    if (turn !== state.currentTurn) {
      state.currentTurn = turn
      state.userTurns.push(turn)
      state.turnsSincePrCheck += 1
      const every = Number((await this.deps.practices()).practices.find(p => p.id === 'pull-request')?.params.checkEveryTurns ?? 10)
      if (state.turnsSincePrCheck >= every) { state.turnsSincePrCheck = 0; state.factsDirty = true }
    }
    if (state.teamAttached !== teamAttached) state.teamAttached = teamAttached
    await this.evaluate(state)
  }

  /** A tool finished. */
  async onToolResult(sessionId: string, call: ObservedCall): Promise<{ drift?: string }> {
    const state = this.session(sessionId)
    state.calls.push(call)
    if (isMutatingCall(call) || (call.target !== undefined && /\b(?:git|gh|glab)\b/u.test(call.target))) state.factsDirty = true
    const root = currentWorkRoot(state.calls, state.cwd)
    if (root !== state.workRoot) { state.workRoot = root; state.factsDirty = true }
    if (['bash', 'Bash', 'shell'].includes(call.name) && call.target !== undefined && !call.isError) {
      const created = worktreeAddPath(call.target, state.workRoot ?? state.cwd ?? process.cwd())
      if (created !== undefined) this.deps.onWorktreeCreated?.(sessionId, created)
      // The cached scan is now describing worktrees that may be gone. Drop it
      // and rescan; until fresh facts land the detector says so rather than
      // repeating a verdict the sweep already invalidated.
      if (changesWorktrees(call.target)) {
        state.worktrees = undefined
        state.worktreesStale = true
        state.factsDirty = true
      }
    }
    let drift: string | undefined
    if (['write', 'edit', 'Write', 'Edit', 'multi_edit'].includes(call.name) && call.target !== undefined && !call.isError) {
      if (isPlanArtifact(call.target)) {
        state.planUpdated = state.drift.length > 0
        state.plan = undefined // re-read next time
      } else if (state.plan !== undefined && !isDocsPath(call.target) && !coveredByPlan(call.target, state.facts?.topLevel, state.plan.patterns)) {
        state.drift.push({ path: call.target, t: call.t })
        state.planUpdated = false
        if (!state.announced.has(call.target)) { state.announced.add(call.target); drift = call.target }
      }
    }
    await this.evaluate(state)
    return drift !== undefined ? { drift } : {}
  }

  /** Scan the work root's worktrees (at most once per 60 s per session). */
  private async scanWorktrees(state: SessionState): Promise<void> {
    if (state.facts?.inRepo !== true || state.facts.topLevel === undefined) {
      state.worktrees = undefined
      state.worktreesStale = false
      return
    }
    if (state.worktrees !== undefined && Date.now() - state.worktrees.scannedAt < 60_000) return
    try {
      const created = await this.deps.createdWorktrees?.()
      const scan = await scanWorktrees(state.facts.topLevel, {
        ...(this.deps.run !== undefined ? { run: this.deps.run } : {}),
        ...(created !== undefined ? { created } : {}),
        skipPr: state.facts.ghAvailable === false,
      })
      state.worktrees = { defaultBranch: scan.defaultBranch, list: scan.worktrees, scannedAt: Date.now() }
      state.worktreesStale = false
    } catch (error) {
      // No fresh facts, but the old ones are still invalid: clear the flag so
      // the detector falls back to "no worktree scan" instead of claiming both.
      state.worktreesStale = false
      this.deps.log?.(`worktree scan for ${state.sessionId}: ${(error as Error).message}`)
    }
  }

  /** The scan, for the sidebar. */
  worktreesOf(sessionId: string): { defaultBranch: string, list: WorktreeInfo[] } | undefined {
    const wt = this.sessions.get(sessionId)?.worktrees
    return wt === undefined ? undefined : { defaultBranch: wt.defaultBranch, list: wt.list }
  }

  /** Force a rescan (after a cleanup). */
  invalidateWorktrees(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state !== undefined) { state.worktrees = undefined; state.worktreesStale = true; state.factsDirty = true }
  }

  /** Read plan.md patterns when the facts say one exists and we have none cached. */
  private async loadPlan(state: SessionState): Promise<void> {
    const facts = state.facts
    if (facts?.topLevel === undefined) return
    const planRel = facts.artifacts.find(a => a.endsWith('plan.md'))
    if (planRel === undefined) { state.plan = undefined; return }
    const path = join(facts.topLevel, planRel)
    if (state.plan?.path === path && state.plan.readAt === facts.readAt) return
    try {
      state.plan = { path, patterns: planPaths(await readFile(path, 'utf8')), readAt: facts.readAt }
    } catch {
      state.plan = undefined
    }
  }

  /** The session is over; run the final checks and forget it. */
  async onDisposed(sessionId: string): Promise<PracticeResult[]> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return []
    state.ended = true
    state.factsDirty = true
    await this.evaluate(state, true)
    this.sessions.delete(sessionId)
    return state.results
  }

  /** Current results for the scorecard. */
  results(sessionId: string): { results: PracticeResult[], facts?: GitFacts, worst: PracticeResult['status'], teamAttached: boolean, calls: number, workRoot?: string } | undefined {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return undefined
    return {
      results: state.results,
      ...(state.workRoot !== undefined ? { workRoot: state.workRoot } : {}),
      ...(state.facts !== undefined ? { facts: state.facts } : {}),
      worst: worst(state.results),
      teamAttached: state.teamAttached,
      calls: state.calls.length,
    }
  }

  /** Force a re-read of git facts (after a preset switch, for the scorecard). */
  async refresh(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    state.factsDirty = true
    await this.evaluate(state, true)
  }

  private async evaluate(state: SessionState, awaitFacts = false): Promise<void> {
    const doc = await this.deps.practices()
    const enabled = doc.practices.filter(p => p.mode !== 'off').map(p => p.id)
    const readFrom = state.workRoot ?? currentWorkRoot(state.calls, state.cwd)
    if (state.factsDirty && readFrom !== undefined) {
      state.factsDirty = false
      state.workRoot = readFrom
      const root = String(doc.practices.find(p => p.id === 'artifact-chain')?.params.root ?? 'docs/sdlc')
      const read = this.deps.factsOverride !== undefined
        ? Promise.resolve(this.deps.factsOverride(readFrom))
        : readGitFacts(readFrom, {
            ...(this.deps.run !== undefined ? { run: this.deps.run } : {}),
            artifactRoot: root,
            instructionFiles: doc.instructionFiles,
            skipPr: state.facts?.ghAvailable === false,
          })
      const pending = read.then(async (facts) => { state.facts = facts; await this.loadPlan(state); await this.scanWorktrees(state) }).catch((error) => {
        this.deps.log?.(`git facts for ${state.sessionId}: ${(error as Error).message}`)
      })
      state.factsPending = pending
      if (awaitFacts) await pending
      else void pending.then(() => this.evaluate(state))
    }
    const view: SessionView = {
      calls: state.calls,
      ...(state.facts !== undefined ? { facts: state.facts } : {}),
      teamAttached: state.teamAttached,
      ...(state.approvalRequired !== undefined ? { approvalRequired: state.approvalRequired } : {}),
      userTurns: state.userTurns,
      // Where a RELATIVE tool path resolves, so a detector can tell whether
      // `edit src/x.ts` landed in the checkout the facts came from.
      ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
      protectedBranches: doc.protectedBranches,
      ended: state.ended,
      drift: state.drift,
      planUpdated: state.planUpdated,
      ...(state.worktrees !== undefined ? { worktrees: summarizeWorktrees(state.worktrees.list, state.worktrees.defaultBranch, Number(doc.practices.find(p => p.id === 'worktree-hygiene')?.params.staleDays ?? 14)) } : {}),
      ...(state.worktreesStale ? { worktreesStale: true } : {}),
      // No call ever named a path, so `facts` describe whichever repository
      // the session started in — not evidence about the work being done.
      ...(attributedWorkRoot(state.calls, state.cwd) === undefined ? { workRootAssumed: true } : {}),
    }
    const stage = await this.deps.activeStage(state.sessionId, state.agentPreset)
    const results = evaluate({ ...view, ...(stage !== undefined ? { activeStage: stage } : {}) }, enabled)
    state.results = results
    for (const result of results) {
      const key = `${result.status}:${result.evidence.join('|')}`
      if (state.lastReported.get(result.id) !== key) {
        state.lastReported.set(result.id, key)
        this.deps.onResult(state.sessionId, result)
      }
    }
  }

  /** Every session whose work root lives in this repository top level. */
  sessionsInRepo(topLevel: string): string[] {
    return [...this.sessions.values()].filter(s => s.facts?.topLevel === topLevel).map(s => s.sessionId)
  }

  /** Every live session id. */
  live(): string[] {
    return [...this.sessions.keys()]
  }
}

/** Fold a scan into the numbers the detector reads. Pure. */
export function summarizeWorktrees(list: readonly WorktreeInfo[], defaultBranch: string, staleDays: number): NonNullable<SessionView['worktrees']> {
  let removable = 0
  let stale = 0
  let symlinked = 0
  const attention: string[] = []
  for (const wt of list) {
    if (wt.primary) continue
    const verdict = classify(wt, defaultBranch)
    if (verdict.kind === 'removable') removable += 1
    if (verdict.kind === 'attention') attention.push(`${wt.path.split('/').pop() ?? wt.path}: ${verdict.reason}`)
    if (wt.nodeModulesSymlink !== undefined) symlinked += 1
    if ((wt.ageDays ?? 0) >= staleDays && verdict.kind !== 'removable') stale += 1
  }
  return { removable, attention, stale, symlinked, total: list.length }
}
