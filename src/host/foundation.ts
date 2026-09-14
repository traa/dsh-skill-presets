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

/**
 * Display label for a skill reference. The alias is shown because that is what
 * the user sees at resolution time, but it is NOT part of the identity — see
 * {@link diffSkills}.
 */
const refOf = (s: PresetSkillRef): string => s.as === undefined ? s.ref : `${s.ref} as ${s.as}`

/**
 * Identity is the canonical `ref` ALONE, never `ref as alias`.
 *
 * Folding the alias into the identity made an aliased curated skill look both
 * missing (the shipped bare ref) and extra (the stored aliased ref), so a merge
 * injected the same underlying skill twice and collided on name. `as` and
 * `whenToUse` are user-facing tweaks to an entry the foundation already ships,
 * not a different skill.
 *
 * Consequence for `extra`: an alias on a curated skill is no longer reported,
 * so it cannot by itself flip an entry to `customized`. `extra` keeps its one
 * intended meaning — the user added a skill of their own — while per-entry
 * edits like an alias are simply preserved by the merge instead of being
 * signalled.
 */
function diffSkills(shipped: readonly PresetSkillRef[], stored: readonly PresetSkillRef[]): { missing: string[], extra: string[] } {
  const a = new Set(shipped.map(s => s.ref))
  const b = new Set(stored.map(s => s.ref))
  return {
    missing: shipped.filter(s => !b.has(s.ref)).map(refOf),
    extra: stored.filter(s => !a.has(s.ref)).map(refOf),
  }
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
    // `color` counts: a recoloured preset is an edit like any other, and
    // omitting it classified that user as `updatable` and offered a silent
    // overwrite path.
    const changedFields = (['title', 'summary', 'stage', 'color'] as const).filter(f => shipped[f] !== stored[f])
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
 * Apply the report. **Merges**: the stored array is preserved VERBATIM — same
 * order, same per-skill fields (`as`, `whenToUse`) — and the shipped skills
 * whose `ref` the store lacks are APPENDED after it. The user's order outranks
 * the curator's: rebuilding from the shipped array first reordered presets the
 * user had arranged by hand and overwrote their per-skill edits, which is a
 * worse failure than a new skill landing at the end. A `local` entry is never
 * touched. Pure: returns the new arrays.
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
      // The curated constant carries a fixed seed epoch; adoption is when this
      // store actually gained the preset, so both stamps are the adoption time.
      // Read the clock once so the two stamps cannot straddle a millisecond.
      const at = now()
      presets.push({ ...shipped, createdAt: at, updatedAt: at })
      applied.push({ kind: 'preset', id: diff.id, added: diff.missingSkills })
      continue
    }
    const index = presets.findIndex(p => p.id === diff.id)
    const stored = presets[index]
    // The stored array verbatim, then only what is genuinely new by `ref`: an
    // entry present on both sides keeps the USER'S object, alias and all.
    const storedRefs = new Set(stored.skills.map(s => s.ref))
    const merged = [...stored.skills, ...shipped.skills.filter(s => !storedRefs.has(s.ref))]
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
    // Same rule as presets: stored order and stored objects win; append only
    // refs the store does not already carry under any alias.
    const storedRefs = new Set(stored.skills.map(s => s.ref))
    const merged = [...stored.skills, ...shipped.skills.filter(s => !storedRefs.has(s.ref))]
    // `enabled` is the user's switch: never reset by an update.
    overlays[index] = { ...stored, skills: merged }
    applied.push({ kind: 'overlay', id: diff.id, added: diff.missingSkills })
  }

  return { presets, overlays, applied }
}
