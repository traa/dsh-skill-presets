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
  version: 1, strictSkills: boolean, instructionFiles: string[], protectedBranches: string[], practices: PracticeConfig[]
}
export interface ActiveDoc { version: 1, preset: string | null, since: string, by: string }
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
}
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
