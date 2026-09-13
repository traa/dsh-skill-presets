/**
 * Impact: do sessions that LOADED a skill end differently from sessions that
 * were offered it and did not?
 *
 * Outcomes are the things the plugin already records: practices green at the
 * end, a PR opened, turns until the first PR signal, plan drift, denials,
 * the user's rating. Per skill (with vs without, among sessions where it was
 * offered), per preset (vs every other preset), and for one session against
 * its recent peers under the same preset. Pure folds; small samples are
 * marked, never hidden.
 * @module dsh-skill-presets/host/impact
 */

import type { SessionSummary } from './telemetry.ts'

export interface Outcomes {
  readonly sessions: number
  /** Share of sessions whose practices were all green or n/a at the end. */
  readonly greenRate?: number
  /** Share with pull-request green. */
  readonly prRate?: number
  /** Mean turn of the pr-always / pull-request signal, when known. */
  readonly meanDriftFiles?: number
  readonly meanDenied?: number
  /** Mean rating over rated sessions (-1..1). */
  readonly meanRating?: number
  readonly rated: number
  /** Mean distinct skills loaded. */
  readonly meanLoaded?: number
}

export interface ImpactRow {
  readonly key: string
  readonly with: Outcomes
  readonly without: Outcomes
  /** with − without, per metric; undefined when either side lacks it. */
  readonly delta: { greenRate?: number, prRate?: number, meanRating?: number, meanDriftFiles?: number, meanDenied?: number }
  /** Both sides have ≥ minSample sessions. */
  readonly enough: boolean
}

export const MIN_SAMPLE = 5

function mean(xs: readonly number[]): number | undefined {
  return xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Fold a group of sessions into outcomes. Pure. */
export function outcomes(group: readonly SessionSummary[]): Outcomes {
  const judged = group.filter(s => s.practices.length > 0)
  const green = judged.filter(s => s.practices.every(p => p.status === 'green' || p.status === 'n/a'))
  const prJudged = group.filter(s => s.practices.some(p => p.id === 'pull-request' && p.status !== 'n/a'))
  const prGreen = prJudged.filter(s => s.practices.some(p => p.id === 'pull-request' && p.status === 'green'))
  const rated = group.filter(s => s.rating !== undefined)
  return {
    sessions: group.length,
    ...(judged.length > 0 ? { greenRate: green.length / judged.length } : {}),
    ...(prJudged.length > 0 ? { prRate: prGreen.length / prJudged.length } : {}),
    ...(group.length > 0 ? { meanDriftFiles: mean(group.map(s => s.drift.length)) } : {}),
    ...(group.length > 0 ? { meanDenied: mean(group.map(s => s.denied)) } : {}),
    ...(rated.length > 0 ? { meanRating: mean(rated.map(s => s.rating as number)) } : {}),
    rated: rated.length,
    ...(group.length > 0 ? { meanLoaded: mean(group.map(s => Object.keys(s.loaded).length)) } : {}),
  }
}

function row(key: string, a: readonly SessionSummary[], b: readonly SessionSummary[], minSample = MIN_SAMPLE): ImpactRow {
  const w = outcomes(a)
  const wo = outcomes(b)
  const d = (k: keyof Outcomes): number | undefined => (typeof w[k] === 'number' && typeof wo[k] === 'number') ? (w[k] as number) - (wo[k] as number) : undefined
  return {
    key,
    with: w,
    without: wo,
    delta: {
      ...(d('greenRate') !== undefined ? { greenRate: d('greenRate')! } : {}),
      ...(d('prRate') !== undefined ? { prRate: d('prRate')! } : {}),
      ...(d('meanRating') !== undefined ? { meanRating: d('meanRating')! } : {}),
      ...(d('meanDriftFiles') !== undefined ? { meanDriftFiles: d('meanDriftFiles')! } : {}),
      ...(d('meanDenied') !== undefined ? { meanDenied: d('meanDenied')! } : {}),
    },
    enough: a.length >= minSample && b.length >= minSample,
  }
}

/** Per skill: sessions where it was offered, split by loaded vs not. */
export function skillImpact(sessions: readonly SessionSummary[], minSample = MIN_SAMPLE): ImpactRow[] {
  const names = new Set<string>()
  for (const s of sessions) for (const n of s.offered) names.add(n)
  const rows: ImpactRow[] = []
  for (const name of [...names].sort()) {
    const offered = sessions.filter(s => s.offered.includes(name))
    const loaded = offered.filter(s => s.loaded[name] !== undefined)
    const not = offered.filter(s => s.loaded[name] === undefined)
    if (offered.length === 0) continue
    rows.push(row(name, loaded, not, minSample))
  }
  // Strongest evidence first: enough samples, then |Δ green|.
  return rows.sort((a, b) => Number(b.enough) - Number(a.enough) || Math.abs(b.delta.greenRate ?? 0) - Math.abs(a.delta.greenRate ?? 0))
}

/** Per preset: its sessions vs every other preset's. */
export function presetImpact(sessions: readonly SessionSummary[], minSample = MIN_SAMPLE): ImpactRow[] {
  const presets = new Set(sessions.map(s => s.preset ?? '(none)'))
  return [...presets].sort().map(p => row(p, sessions.filter(s => (s.preset ?? '(none)') === p), sessions.filter(s => (s.preset ?? '(none)') !== p), minSample))
}

/** One session vs its most recent N peers under the same preset (excluding itself). */
export function sessionVsPeers(current: SessionSummary, sessions: readonly SessionSummary[], n = 20): { current: Outcomes, peers: Outcomes, peerCount: number, preset: string | null } {
  const peers = sessions
    .filter(s => s.sessionId !== current.sessionId && (s.preset ?? null) === (current.preset ?? null))
    .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
    .slice(0, n)
  return { current: outcomes([current]), peers: outcomes(peers), peerCount: peers.length, preset: current.preset }
}
