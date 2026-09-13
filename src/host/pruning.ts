/**
 * Stale-skill pruning and missing-skill hints — the compounding rule
 * dsh-knowledge applies to insights, applied to presets.
 *
 * A skill a preset has offered in many sessions that the model almost never
 * loads is dead weight in the catalog (tokens, attention). A name the model
 * asked the `skill` tool for that does not exist is the strongest "missing
 * skill" signal there is. Both are pure folds over the usage rollup; the UI
 * turns them into one-click chips. Removal is from the PRESET, never the
 * library.
 * @module dsh-skill-presets/host/pruning
 */

import type { DiscoveredSkill } from './github.ts'
import type { Preset, Rollup } from './types.ts'
import type { SessionSummary } from './telemetry.ts'

export interface PruningThresholds {
  /** Sessions a skill must have been offered in before it can be called stale. */
  readonly minSessions: number
  /** Load rate (sessions loaded ÷ offered) at or below which it is stale. */
  readonly maxLoadRate: number
  /** Unknown-name requests at or above which we suggest adding a skill. */
  readonly minUnknown: number
}

export const DEFAULT_THRESHOLDS: PruningThresholds = { minSessions: 20, maxLoadRate: 0.1, minUnknown: 3 }

export interface StaleHint {
  readonly preset: string
  readonly ref: string
  readonly name: string
  readonly offered: number
  readonly loaded: number
  readonly rate: number
}

export interface MissingHint {
  readonly name: string
  readonly count: number
  /** Installed-but-not-in-any-preset match, if the name exists in the library. */
  readonly inLibrary?: string
  /** Upstream dirs with this name, from the last discovery, if any. */
  readonly upstream?: readonly { source: string, dir: string }[]
}

export interface PruningReport {
  readonly stale: StaleHint[]
  readonly missing: MissingHint[]
  readonly thresholds: PruningThresholds
}

/**
 * Per-preset offered/loaded counts, from session summaries (the rollup is
 * global per skill; staleness is per preset).
 */
export function presetSkillUsage(sessions: readonly SessionSummary[]): Map<string, Map<string, { offered: number, loaded: number }>> {
  const out = new Map<string, Map<string, { offered: number, loaded: number }>>()
  for (const s of sessions) {
    const preset = s.preset ?? '(none)'
    const per = out.get(preset) ?? new Map()
    out.set(preset, per)
    for (const name of s.offered) {
      const cell = per.get(name) ?? { offered: 0, loaded: 0 }
      cell.offered += 1
      if (s.loaded[name] !== undefined) cell.loaded += 1
      per.set(name, cell)
    }
  }
  return out
}

/** The fold. Pure. */
export function pruningReport(input: {
  presets: readonly Preset[]
  sessions: readonly SessionSummary[]
  rollup: Rollup
  /** exposed name → ref, for installed skills. */
  installed: ReadonlyMap<string, string>
  /** name → refs, for skills in any preset. */
  inPresets: ReadonlySet<string>
  discovered?: readonly { source: string, skills: readonly DiscoveredSkill[] }[]
  thresholds?: Partial<PruningThresholds>
}): PruningReport {
  const t = { ...DEFAULT_THRESHOLDS, ...input.thresholds }
  const usage = presetSkillUsage(input.sessions)
  const stale: StaleHint[] = []
  for (const preset of input.presets) {
    const per = usage.get(preset.id)
    if (per === undefined) continue
    for (const entry of preset.skills) {
      const ref = entry.ref
      const name = entry.as ?? [...input.installed.entries()].find(([, r]) => r === ref)?.[0] ?? ref.split('/').pop()!
      const cell = per.get(name)
      if (cell === undefined || cell.offered < t.minSessions) continue
      const rate = cell.loaded / cell.offered
      if (rate <= t.maxLoadRate) stale.push({ preset: preset.id, ref, name, offered: cell.offered, loaded: cell.loaded, rate })
    }
  }
  stale.sort((a, b) => a.rate - b.rate || b.offered - a.offered)

  const missing: MissingHint[] = []
  for (const [name, count] of Object.entries(input.rollup.unknownRequests)) {
    if (count < t.minUnknown) continue
    if (input.inPresets.has(name)) continue // it exists in some preset; the model was in the wrong preset — not a missing skill
    const inLibrary = input.installed.get(name)
    const upstream = (input.discovered ?? []).flatMap(d => d.skills.filter(s => s.dir === name).map(s => ({ source: d.source, dir: s.dir })))
    missing.push({ name, count, ...(inLibrary !== undefined ? { inLibrary } : {}), ...(upstream.length > 0 ? { upstream } : {}) })
  }
  missing.sort((a, b) => b.count - a.count)
  return { stale, missing, thresholds: t }
}
