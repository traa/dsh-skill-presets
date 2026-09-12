/**
 * Presets and overlays: validation and resolution against the library.
 *
 * Resolution never throws on a missing skill — an uninstalled or orphaned ref
 * is reported as `unresolved` so the UI can say which one and the provider can
 * skip it while keeping the catalog complete.
 * @module dsh-skill-presets/host/presets
 */

import { join } from 'node:path'
import { parseSkill, isSkillName, type ParsedSkill } from './frontmatter.ts'
import { readFile } from 'node:fs/promises'
import type { StorePaths } from './store.ts'
import type { Lock, LockedSkill, Overlay, Preset, PresetSkillRef } from './types.ts'

/** Split `<source>/<dir>`. */
export function splitRef(ref: string): { source: string, dir: string } | undefined {
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { source: ref.slice(0, slash), dir: ref.slice(slash + 1) }
}

/** One skill ready to be exposed to the model. */
export interface ResolvedSkill {
  readonly ref: string
  /** The exposed (model-facing) name. */
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  /** Absolute bundle directory. */
  readonly dir: string
  readonly locked: LockedSkill
  /** Whether the ref came from an overlay rather than the preset. */
  readonly via: 'preset' | { overlay: string }
}

export interface Resolution {
  readonly skills: ResolvedSkill[]
  readonly unresolved: { ref: string, reason: string, via: ResolvedSkill['via'] }[]
  /** Exposed names that appeared more than once; later occurrences dropped. */
  readonly collisions: string[]
}

/** Validate one preset's shape and internal consistency. Returns problems, empty when fine. */
export function validatePreset(preset: Preset, lock?: Lock): string[] {
  const problems: string[] = []
  if (!isSkillName(preset.id)) problems.push(`id "${preset.id}" must be kebab-case`)
  if (preset.title.trim().length === 0) problems.push('title is empty')
  const names = new Map<string, string>()
  for (const entry of preset.skills) {
    const split = splitRef(entry.ref)
    if (split === undefined) { problems.push(`ref "${entry.ref}" is not <source>/<dir>`); continue }
    if (entry.as !== undefined && !isSkillName(entry.as)) problems.push(`as "${entry.as}" must be kebab-case`)
    const locked = lock?.skills.find(s => s.source === split.source && s.dir === split.dir)
    const exposed = entry.as ?? locked?.name ?? split.dir
    const previous = names.get(exposed)
    if (previous !== undefined) {
      problems.push(`exposed name "${exposed}" is used by both ${previous} and ${entry.ref}; set "as" on one of them`)
    } else {
      names.set(exposed, entry.ref)
    }
  }
  return problems
}

/** Validate the presets file read from disk; drops entries that are not objects with an id. */
export function validatePresetsFile(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) throw new TypeError('presets must be an array')
  const out: Preset[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const p = entry as Partial<Preset>
    if (typeof p.id !== 'string' || !Array.isArray(p.skills)) continue
    out.push({
      id: p.id,
      title: typeof p.title === 'string' ? p.title : p.id,
      stage: typeof p.stage === 'string' ? p.stage as Preset['stage'] : 'cross',
      summary: typeof p.summary === 'string' ? p.summary : '',
      ...(typeof p.color === 'string' ? { color: p.color } : {}),
      skills: p.skills.filter((s): s is PresetSkillRef => typeof s === 'object' && s !== null && typeof (s as PresetSkillRef).ref === 'string'),
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date(0).toISOString(),
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date(0).toISOString(),
      ...(p.builtin === true ? { builtin: true } : {}),
    })
  }
  return out
}

/** Validate the overlays file. */
export function validateOverlaysFile(raw: unknown): Overlay[] {
  if (!Array.isArray(raw)) throw new TypeError('overlays must be an array')
  const out: Overlay[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const o = entry as Partial<Overlay>
    if (typeof o.id !== 'string' || !Array.isArray(o.skills)) continue
    const when = o.when === 'tool-visible:team_delegate' || o.when === 'git-work-tree' || o.when === 'always' ? o.when : 'always'
    out.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : o.id,
      when,
      skills: o.skills.filter((s): s is PresetSkillRef => typeof s === 'object' && s !== null && typeof (s as PresetSkillRef).ref === 'string'),
      enabled: o.enabled !== false,
    })
  }
  return out
}

/** In-memory cache of parsed SKILL.md keyed by dir + digest so a preset switch does not re-read every file. */
const parsedCache = new Map<string, ParsedSkill>()

async function loadParsed(paths: StorePaths, locked: LockedSkill): Promise<ParsedSkill | { error: string }> {
  const key = `${locked.source}/${locked.dir}@${locked.digest}`
  const cached = parsedCache.get(key)
  if (cached !== undefined) return cached
  let text: string
  try {
    text = await readFile(join(paths.skillDir(locked.source, locked.dir), 'SKILL.md'), 'utf8')
  } catch {
    return { error: 'SKILL.md missing on disk' }
  }
  const parsed = parseSkill(text)
  if (!('error' in parsed)) parsedCache.set(key, parsed)
  return parsed
}

/** Drop cached parses (after an install/update). */
export function clearParsedCache(): void {
  parsedCache.clear()
}

/**
 * Resolve a preset plus active overlays into the exposed skill set.
 * @param paths - store paths.
 * @param lock - the current lock.
 * @param preset - the active preset, or undefined.
 * @param overlays - overlays whose condition currently holds.
 */
export async function resolveSet(
  paths: StorePaths,
  lock: Lock,
  preset: Preset | undefined,
  overlays: readonly Overlay[],
): Promise<Resolution> {
  const skills: ResolvedSkill[] = []
  const unresolved: Resolution['unresolved'] = []
  const collisions: string[] = []
  const seen = new Set<string>()

  const consider = async (entry: PresetSkillRef, via: ResolvedSkill['via']): Promise<void> => {
    const split = splitRef(entry.ref)
    if (split === undefined) { unresolved.push({ ref: entry.ref, reason: 'malformed ref', via }); return }
    const locked = lock.skills.find(s => s.source === split.source && s.dir === split.dir)
    if (locked === undefined) { unresolved.push({ ref: entry.ref, reason: 'not installed', via }); return }
    if (locked.orphaned === true) { unresolved.push({ ref: entry.ref, reason: 'orphaned upstream (files kept)', via }); return }
    const parsed = await loadParsed(paths, locked)
    if ('error' in parsed) { unresolved.push({ ref: entry.ref, reason: parsed.error, via }); return }
    const name = entry.as ?? parsed.name
    if (!isSkillName(name)) { unresolved.push({ ref: entry.ref, reason: `exposed name "${name}" is not kebab-case`, via }); return }
    if (seen.has(name)) { collisions.push(name); return }
    seen.add(name)
    const whenToUse = [parsed.whenToUse, entry.whenToUse].filter((s): s is string => s !== undefined && s.length > 0).join(' ')
    skills.push({
      ref: entry.ref,
      name,
      description: parsed.description,
      ...(whenToUse.length > 0 ? { whenToUse } : {}),
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
      dir: paths.skillDir(locked.source, locked.dir),
      locked,
      via,
    })
  }

  for (const entry of preset?.skills ?? []) await consider(entry, 'preset')
  for (const overlay of overlays) {
    for (const entry of overlay.skills) await consider(entry, { overlay: overlay.id })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { skills, unresolved, collisions }
}
