/**
 * RPC client and shared types for the browser half.
 * @module dsh-skill-presets/client/api
 */

export const RPC_BASE = '/plugins/dsh-skill-presets/rpc'

/** POST one method; surfaces a readable message on failure. */
export async function rpc<T>(method: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${RPC_BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new Error(`skill-presets: ${method} returned malformed JSON`)
  }
  if (!response.ok) {
    throw new Error((parsed as { error?: string }).error ?? `skill-presets: ${method} failed (${response.status})`)
  }
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string') {
    throw new Error((parsed as { error: string }).error)
  }
  return parsed as T
}

// Wire shapes (mirrors of host types, kept structural so nothing is imported at runtime).

export interface PresetSkillRef { ref: string, as?: string, whenToUse?: string }
export interface Preset {
  id: string, title: string, stage: string, summary: string, color?: string,
  skills: PresetSkillRef[], createdAt: string, updatedAt: string, builtin?: true
}
export interface Overlay { id: string, title: string, when: string, skills: PresetSkillRef[], enabled: boolean }
export interface SkillSource {
  id: string, title: string, kind: 'github' | 'local', repo?: string, ref?: string, paths?: string[], enabled: boolean, note?: string
}
export interface LockedSkill {
  source: string, dir: string, name: string, description: string, digest: string, upstreamDigest?: string,
  normalized: boolean, commit: string, installedAt: string, files: number,
  history?: { commit: string, digest: string, at: string }[], orphaned?: true
}
export interface Lock { version: 1, sources: Record<string, { commit: string, fetchedAt: string }>, skills: LockedSkill[] }
export interface PracticeConfig { id: string, mode: 'off' | 'advisory' | 'hard', params: Record<string, unknown> }
export interface PracticesDoc {
  version: 1, strictSkills: boolean, autoCleanWorktrees: boolean, pruning: { minSessions: number, maxLoadRate: number, minUnknown: number },
  instructionFiles: string[], protectedBranches: string[], practices: PracticeConfig[]
}
export interface PruningReport {
  stale: { preset: string, ref: string, name: string, offered: number, loaded: number, rate: number }[]
  missing: { name: string, count: number, inLibrary?: string, upstream?: { source: string, dir: string }[] }[]
  thresholds: { minSessions: number, maxLoadRate: number, minUnknown: number }
}
export interface WorktreeRow {
  path: string, head: string, branch?: string, primary: boolean, locked?: string | true, prunable?: string, detached: boolean,
  dirty?: boolean, merged?: boolean, ahead?: number, hasUpstream?: boolean, aheadOfDefault?: number, nodeModulesSymlink?: string,
  ageDays?: number, prState?: string, prUrl?: string, createdBy?: string, createdAt?: string
  verdict: { kind: 'keep' | 'removable' | 'attention', reason: string }
}
export interface CleanupResult {
  removed: { path: string, branch?: string, reason: string }[], kept: { path: string, reason: string }[],
  attention: { path: string, reason: string }[], errors: { path: string, error: string }[], dryRun: boolean
}
export interface ActiveDoc {
  version: 2
  default: string | null
  byAgentPreset: Record<string, string | null>
  sessions: Record<string, { preset: string | null, since: string, by: string, disposedAt?: string }>
  since: string
  by: string
}
export type ActivateScope = 'session' | 'default' | 'agent-preset'
export interface StageGuess { stage: string, confidence: number, why: string[] }
export interface Suggestion { from: string | null, to: string, presetId?: string, confidence: number, why: string[] }
export interface Experiment { id: string, parent: string, child: string, parentPreset: string | null, childPreset: string | null, at: string, note?: string }
export interface CompareCard {
  sessionId: string, live: boolean, preset: string | null, practices: PracticeResult[], loaded: number, offered: number,
  loads: number, turns: number, rating?: -1 | 0 | 1, denied: number, drift: number, model?: string
}
export interface Resolution {
  skills: { ref: string, name: string, description: string, via: 'preset' | { overlay: string } }[]
  unresolved: { ref: string, reason: string }[]
  collisions: string[]
}
export interface Status {
  root: string
  storeReady: boolean
  active: ActiveDoc
  activePreset?: Preset
  presets: Preset[]
  overlays: Overlay[]
  sources: SkillSource[]
  lock: Lock
  practices: PracticesDoc
  practiceInfo: Record<string, { title: string, summary: string, skill: string }>
  stages: string[]
  resolution: Resolution
  notes: string[]
  foundationInstalled: boolean
  /** Whether the running harness has ctx.skills.restrict(); undefined until an agent was seen. */
  restrictSeam?: boolean
}
export interface PracticeResult { id: string, status: 'green' | 'amber' | 'red' | 'n/a', evidence: string[], firstViolationAt?: string }
export interface GitFacts {
  inRepo: boolean, gitAvailable: boolean, isWorktree?: boolean, branch?: string, ahead?: number, hasUpstream?: boolean,
  dirty?: boolean, topLevel?: string, pr?: { url: string, state: string }, ghAvailable: boolean, artifacts: string[], instructionFiles: string[]
}
export interface SessionSummary {
  sessionId: string
  preset: string | null
  overlays: string[]
  offered: string[]
  loaded: Record<string, { count: number, firstTurn: number, chars: number, lastAt: string }>
  unknown: string[]
  practices: PracticeResult[]
  denied: number
  drift: string[]
  suggestions: { kind: 'suggested' | 'accepted' | 'dismissed', from: string | null, to: string, afterMs?: number }[]
  rating?: -1 | 0 | 1
  provider?: string
  model?: string
  startedAt?: string
  lastAt?: string
  switches: { from: string | null, to: string | null, t: string }[]
  loads: { name: string, turn: number, t: string, ok: boolean }[]
}
export interface Scorecard {
  sessionId: string
  live: boolean
  active: ActiveDoc
  activePreset?: Preset
  /** Which rung answered for this session. */
  activeSource: 'session' | 'agent-preset' | 'default'
  agentPreset?: string
  stageGuess: StageGuess
  suggestion?: Suggestion
  experiments: Experiment[]
  /** Strict catalog state for this session. `seam` undefined = not yet known. */
  strict: { enabled: boolean, seam?: boolean, applied: boolean }
  worktrees?: { defaultBranch: string, list: WorktreeRow[] }
  overlays: string[]
  offered: { name: string, via: string, description: string }[]
  unresolved: { ref: string, reason: string }[]
  practices: PracticeResult[]
  worst: PracticeResult['status']
  facts?: GitFacts
  summary: SessionSummary
}
export interface Rollup {
  version: 1
  updatedAt: string
  sessions: number
  skills: Record<string, { sessionsOffered: number, sessionsLoaded: number, loads: number, firstLoadTurnSum: number, chars: number, lastUsed?: string }>
  presets: Record<string, { sessions: number, ratingSum: number, ratings: number, coverageSum: number }>
  practices: Record<string, { green: number, amber: number, red: number, na: number }>
  unknownRequests: Record<string, number>
  coUsage: Record<string, number>
  byModel: Record<string, { sessions: number, loads: number }>
  suggestions: { suggested: number, accepted: number, dismissed: number, acceptMsSum: number }
}
export interface InsightCandidate { id: string, domain: string, title: string, body: string, kind: string, confidence: number, hits?: number, scope: 'global' | 'project', project?: string, promotedTo?: string, skillName: string }
export interface TeamTemplate { id: string, name: string, stage: string, objective: string, members: { id: string, name: string, responsibility: string }[], conductorInstructions: string }
export interface Outcomes { sessions: number, greenRate?: number, prRate?: number, meanDriftFiles?: number, meanDenied?: number, meanRating?: number, rated: number, meanLoaded?: number }
export interface ImpactRow { key: string, with: Outcomes, without: Outcomes, delta: { greenRate?: number, prRate?: number, meanRating?: number, meanDriftFiles?: number, meanDenied?: number }, enough: boolean }
export interface ImpactReport { skills: ImpactRow[], presets: ImpactRow[], sessions: number }
export interface PeerComparison { current: Outcomes, peers: Outcomes, peerCount: number, preset: string | null }
export interface ExperimentsAggregate {
  results: { experiment: Experiment, parent: Outcomes, child: Outcomes, winner: 'parent' | 'child' | null, why: string }[]
  pairs: { a: string, b: string, experiments: number, aWins: number, bWins: number, ties: number }[]
}
export interface LibraryLint { byRef: Record<string, { rule: string, severity: 'error' | 'warn' | 'info', message: string, line?: number }[]>, counts: { error: number, warn: number, info: number } }
export interface Placement { preset: string, title: string, stage: string, score: number, matched: string[] }
export interface OrphanSkill { ref: string, name: string, placements: Placement[] }
export interface DoctorReport { findings: { id: string, severity: 'ok' | 'warn' | 'fail', message: string, fix?: string }[], worst: 'ok' | 'warn' | 'fail', probedAt: string }
export interface CheckReport { source: string, lockedCommit?: string, upstreamCommit: string, changed: string[], newUpstream: string[], removedUpstream: string[], note?: string }
export interface JobState { id: string, done: boolean, progress: string[], reports: { source: string, added: string[], updated: string[], unchanged: string[], orphaned: string[], failed: { dir: string, error: string }[], note?: string }[] }
export interface SkillDetail { ref: string, text?: string, files: { path: string, bytes: number }[], locked?: LockedSkill, usedBy: string[] }

/** Minimal external store: snapshot + subscribe, the shape `useSyncExternalStore` wants. */
export class Store<T> {
  private listeners = new Set<() => void>()
  constructor(private value: T) {}
  get(): T { return this.value }
  set(patch: Partial<T>): void {
    this.value = { ...this.value, ...patch }
    for (const l of this.listeners) l()
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
