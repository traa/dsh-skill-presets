/**
 * The curated foundation is *updateable*, like the library it draws from.
 *
 * `presets.json` and `overlays.json` were seeded once and never revisited, so
 * every later curated change — a skill added to an overlay, a new practice
 * skill in a preset — stayed invisible to anyone whose store predated it.
 * This module diffs stored builtins against the shipped ones and reports what
 * a newer foundation would add, so the user can adopt it. Never silent: a
 * builtin the user edited is reported as *customized* and left alone unless
 * they ask for it explicitly.
 * @module dsh-skill-presets/host/foundation
 */

import type { Overlay, Preset, PresetSkillRef } from './types.ts'

export type FoundationStatus = 'current' | 'updatable' | 'customized' | 'new' | 'local'

export interface FoundationDiff {
  readonly kind: 'preset' | 'overlay'
  readonly id: string
  readonly title: string
  readonly status: FoundationStatus
  /** Refs the shipped version has that the stored one lacks. */
  readonly missingSkills: string[]
  /** Refs the stored version has that the shipped one lacks (user additions, or removed upstream). */
  readonly extraSkills: string[]
  /** Non-skill fields that differ, e.g. summary or stage. */
  readonly changedFields: string[]
}

export interface FoundationReport {
  readonly diffs: FoundationDiff[]
  readonly updatable: number
  readonly customized: number
  readonly added: number
}

const refOf = (s: PresetSkillRef): string => s.as === undefined ? s.ref : `${s.ref} as ${s.as}`

function diffSkills(shipped: readonly PresetSkillRef[], stored: readonly PresetSkillRef[]): { missing: string[], extra: string[] } {
  const a = new Set(shipped.map(refOf))
  const b = new Set(stored.map(refOf))
  return { missing: [...a].filter(x => !b.has(x)), extra: [...b].filter(x => !a.has(x)) }
}

/**
 * Compare stored presets/overlays with the shipped ones.
 *
 * - `new`: shipped, absent from the store → adopting adds it.
 * - `updatable`: stored builtin missing skills the shipped one has, and no
 *   user additions or field edits → safe to adopt.
 * - `customized`: the user changed it (extra skills or edited fields) AND the
 *   shipped one moved on → adoption is offered but merges, never replaces.
 * - `current` / `local`: nothing to do.
 */
export function foundationReport(
  shippedPresets: readonly Preset[], storedPresets: readonly Preset[],
  shippedOverlays: readonly Overlay[], storedOverlays: readonly Overlay[],
): FoundationReport {
  const diffs: FoundationDiff[] = []

  for (const shipped of shippedPresets) {
    const stored = storedPresets.find(p => p.id === shipped.id)
    if (stored === undefined) {
      diffs.push({ kind: 'preset', id: shipped.id, title: shipped.title, status: 'new', missingSkills: shipped.skills.map(refOf), extraSkills: [], changedFields: [] })
      continue
    }
    const { missing, extra } = diffSkills(shipped.skills, stored.skills)
    const changedFields = (['title', 'summary', 'stage'] as const).filter(f => shipped[f] !== stored[f])
    const edited = extra.length > 0 || changedFields.length > 0
    const status: FoundationStatus = missing.length === 0 && !edited ? 'current' : edited ? 'customized' : 'updatable'
    diffs.push({ kind: 'preset', id: shipped.id, title: stored.title, status, missingSkills: missing, extraSkills: extra, changedFields: [...changedFields] })
  }
  for (const stored of storedPresets) {
    if (shippedPresets.some(p => p.id === stored.id)) continue
    diffs.push({ kind: 'preset', id: stored.id, title: stored.title, status: 'local', missingSkills: [], extraSkills: [], changedFields: [] })
  }

  for (const shipped of shippedOverlays) {
    const stored = storedOverlays.find(o => o.id === shipped.id)
    if (stored === undefined) {
      diffs.push({ kind: 'overlay', id: shipped.id, title: shipped.title, status: 'new', missingSkills: shipped.skills.map(refOf), extraSkills: [], changedFields: [] })
      continue
    }
    const { missing, extra } = diffSkills(shipped.skills, stored.skills)
    const changedFields = (['title', 'when'] as const).filter(f => shipped[f] !== stored[f])
    const edited = extra.length > 0 || changedFields.length > 0
    const status: FoundationStatus = missing.length === 0 && !edited ? 'current' : edited ? 'customized' : 'updatable'
    diffs.push({ kind: 'overlay', id: shipped.id, title: stored.title, status, missingSkills: missing, extraSkills: extra, changedFields: [...changedFields] })
  }
  for (const stored of storedOverlays) {
    if (shippedOverlays.some(o => o.id === stored.id)) continue
    diffs.push({ kind: 'overlay', id: stored.id, title: stored.title, status: 'local', missingSkills: [], extraSkills: [], changedFields: [] })
  }

  const pending = diffs.filter(d => d.status === 'updatable' || d.status === 'new' || (d.status === 'customized' && d.missingSkills.length > 0))
  return {
    diffs,
    updatable: pending.filter(d => d.status === 'updatable').length,
    customized: diffs.filter(d => d.status === 'customized' && d.missingSkills.length > 0).length,
    added: pending.filter(d => d.status === 'new').length,
  }
}

/**
 * Apply the report. **Merges**: adds the shipped skills the stored entry
 * lacks, in the shipped order, and keeps every user addition and field edit.
 * A `local` entry is never touched. Pure: returns the new arrays.
 */
export function adoptFoundation(
  report: FoundationReport,
  shippedPresets: readonly Preset[], storedPresets: readonly Preset[],
  shippedOverlays: readonly Overlay[], storedOverlays: readonly Overlay[],
  only?: readonly string[],
  now: () => string = () => new Date().toISOString(),
): { presets: Preset[], overlays: Overlay[], applied: { kind: string, id: string, added: string[] }[] } {
  const applied: { kind: string, id: string, added: string[] }[] = []
  const wanted = (d: FoundationDiff): boolean =>
    (only === undefined || only.includes(d.id)) && (d.status === 'new' || d.missingSkills.length > 0)

  const presets = [...storedPresets]
  const overlays = [...storedOverlays]

  for (const diff of report.diffs.filter(d => d.kind === 'preset' && wanted(d))) {
    const shipped = shippedPresets.find(p => p.id === diff.id)
    if (shipped === undefined) continue
    if (diff.status === 'new') {
      presets.push({ ...shipped })
      applied.push({ kind: 'preset', id: diff.id, added: diff.missingSkills })
      continue
    }
    const index = presets.findIndex(p => p.id === diff.id)
    const stored = presets[index]
    // Shipped order first (so a new practice skill lands where the curator put
    // it), then the user's own additions, in their order.
    const storedRefs = new Set(stored.skills.map(refOf))
    const merged = [
      ...shipped.skills.filter(s => storedRefs.has(refOf(s)) || diff.missingSkills.includes(refOf(s))),
      ...stored.skills.filter(s => !shipped.skills.some(x => refOf(x) === refOf(s))),
    ]
    presets[index] = { ...stored, skills: merged, updatedAt: now() }
    applied.push({ kind: 'preset', id: diff.id, added: diff.missingSkills })
  }

  for (const diff of report.diffs.filter(d => d.kind === 'overlay' && wanted(d))) {
    const shipped = shippedOverlays.find(o => o.id === diff.id)
    if (shipped === undefined) continue
    if (diff.status === 'new') {
      overlays.push({ ...shipped })
      applied.push({ kind: 'overlay', id: diff.id, added: diff.missingSkills })
      continue
    }
    const index = overlays.findIndex(o => o.id === diff.id)
    const stored = overlays[index]
    const storedRefs = new Set(stored.skills.map(refOf))
    const merged = [
      ...shipped.skills.filter(s => storedRefs.has(refOf(s)) || diff.missingSkills.includes(refOf(s))),
      ...stored.skills.filter(s => !shipped.skills.some(x => refOf(x) === refOf(s))),
    ]
    // `enabled` is the user's switch: never reset by an update.
    overlays[index] = { ...stored, skills: merged }
    applied.push({ kind: 'overlay', id: diff.id, added: diff.missingSkills })
  }

  return { presets, overlays, applied }
}
