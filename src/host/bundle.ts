/**
 * Preset bundles: export one or more presets — with the overlays they rely on,
 * the sources their skills come from, and the exact lock entries (commit +
 * digest) — into one JSON file another workbench can import.
 *
 * Import is a two-step: `planImport` reports collisions and what would be
 * installed without touching anything; `applyImport` performs it. Missing
 * sources are added DISABLED so nothing fetches without a click; local skills
 * travel with their text because they exist nowhere else.
 * @module dsh-skill-presets/host/bundle
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { splitRef, validatePreset } from './presets.ts'
import type { Lock, LockedSkill, Overlay, Preset, SkillSource } from './types.ts'

export interface Bundle {
  readonly version: 1
  readonly exportedAt: string
  readonly presets: Preset[]
  readonly overlays: Overlay[]
  readonly sources: SkillSource[]
  /** Lock entries for every referenced skill, so the importer can pin versions. */
  readonly lock: LockedSkill[]
  /** Bodies of referenced LOCAL skills (`<dir>` → files), since they exist nowhere upstream. */
  readonly localSkills: Record<string, Record<string, string>>
}

export interface ExportInput {
  presetIds: readonly string[]
  presets: readonly Preset[]
  overlays: readonly Overlay[]
  sources: readonly SkillSource[]
  lock: Lock
  /** Read a local skill dir's files. */
  readLocal: (dir: string) => Promise<Record<string, string>>
  now?: Date
}

export async function exportBundle(input: ExportInput): Promise<Bundle> {
  const presets = input.presets.filter(p => input.presetIds.includes(p.id))
  if (presets.length !== input.presetIds.length) {
    const missing = input.presetIds.filter(id => !presets.some(p => p.id === id))
    throw new Error(`unknown preset(s): ${missing.join(', ')}`)
  }
  const refs = new Set<string>()
  for (const p of presets) for (const s of p.skills) refs.add(s.ref)
  // Overlays are workspace-wide; include them all so the importer sees the same behaviour.
  for (const o of input.overlays) for (const s of o.skills) refs.add(s.ref)
  const sourceIds = new Set([...refs].map(r => splitRef(r)?.source).filter((s): s is string => s !== undefined))
  const lock = input.lock.skills.filter(s => refs.has(`${s.source}/${s.dir}`))
  const localSkills: Record<string, Record<string, string>> = {}
  for (const entry of lock.filter(s => s.source === 'local')) localSkills[entry.dir] = await input.readLocal(entry.dir)
  return {
    version: 1,
    exportedAt: (input.now ?? new Date()).toISOString(),
    presets: presets.map(p => ({ ...p, builtin: undefined })).map(({ builtin: _b, ...rest }) => rest),
    overlays: [...input.overlays],
    sources: input.sources.filter(s => sourceIds.has(s.id)),
    lock,
    localSkills,
  }
}

export function validateBundle(raw: unknown): Bundle {
  const b = raw as Partial<Bundle>
  if (typeof b !== 'object' || b === null || b.version !== 1 || !Array.isArray(b.presets)) throw new TypeError('not a dsh-skill-presets bundle (version 1 with presets[])')
  return {
    version: 1,
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '',
    presets: b.presets,
    overlays: Array.isArray(b.overlays) ? b.overlays : [],
    sources: Array.isArray(b.sources) ? b.sources : [],
    lock: Array.isArray(b.lock) ? b.lock : [],
    localSkills: typeof b.localSkills === 'object' && b.localSkills !== null ? b.localSkills as Bundle['localSkills'] : {},
  }
}

export interface ImportPlan {
  /** Presets that would be written (after any rename). */
  readonly presets: { id: string, from: string, action: 'create' | 'replace' | 'skip' }[]
  readonly collisions: string[]
  /** Sources to add (disabled) because the bundle references them. */
  readonly newSources: SkillSource[]
  /** Skills referenced but not installed here, per source. */
  readonly toInstall: { source: string, dir: string, pinnedCommit?: string }[]
  /** Local skills that would be written (new) or skipped (exist). */
  readonly localSkills: { dir: string, action: 'write' | 'skip' }[]
  readonly problems: string[]
}

export interface ImportContext {
  presets: readonly Preset[]
  sources: readonly SkillSource[]
  lock: Lock
  /** `replace` overwrites same-id presets; `skip` keeps ours; `rename` appends a suffix. */
  onCollision?: 'replace' | 'skip' | 'rename'
  renameSuffix?: string
}

export function planImport(bundle: Bundle, ctx: ImportContext): ImportPlan {
  const mode = ctx.onCollision ?? 'skip'
  const suffix = ctx.renameSuffix ?? '-imported'
  const presets: ImportPlan['presets'] = []
  const collisions: string[] = []
  const problems: string[] = []
  for (const p of bundle.presets) {
    const problemsHere = validatePreset(p)
    if (problemsHere.length > 0) { problems.push(`${p.id}: ${problemsHere.join('; ')}`); continue }
    const exists = ctx.presets.some(x => x.id === p.id)
    if (!exists) { presets.push({ id: p.id, from: p.id, action: 'create' }); continue }
    collisions.push(p.id)
    if (mode === 'replace') presets.push({ id: p.id, from: p.id, action: 'replace' })
    else if (mode === 'rename') presets.push({ id: `${p.id}${suffix}`, from: p.id, action: 'create' })
    else presets.push({ id: p.id, from: p.id, action: 'skip' })
  }
  const newSources = bundle.sources.filter(s => !ctx.sources.some(x => x.id === s.id)).map(s => ({ ...s, enabled: false }))
  const installed = new Set(ctx.lock.skills.map(s => `${s.source}/${s.dir}`))
  const toInstall: ImportPlan['toInstall'] = []
  const localSkills: ImportPlan['localSkills'] = []
  const refs = new Set<string>()
  for (const p of bundle.presets) for (const s of p.skills) refs.add(s.ref)
  for (const o of bundle.overlays) for (const s of o.skills) refs.add(s.ref)
  for (const ref of refs) {
    const split = splitRef(ref)
    if (split === undefined) { problems.push(`malformed ref ${ref}`); continue }
    if (split.source === 'local') {
      localSkills.push({ dir: split.dir, action: installed.has(ref) ? 'skip' : bundle.localSkills[split.dir] !== undefined ? 'write' : 'skip' })
      if (!installed.has(ref) && bundle.localSkills[split.dir] === undefined) problems.push(`local skill ${split.dir} is referenced but not included in the bundle`)
      continue
    }
    if (installed.has(ref)) continue
    const pinned = bundle.lock.find(l => l.source === split.source && l.dir === split.dir)
    toInstall.push({ source: split.source, dir: split.dir, ...(pinned !== undefined ? { pinnedCommit: pinned.commit } : {}) })
  }
  return { presets, collisions, newSources, toInstall, localSkills, problems }
}

export interface ApplyDeps {
  savePreset: (p: Preset) => Promise<unknown>
  saveSources: (s: SkillSource[]) => Promise<void>
  libraryRoot: string
  /** Install listed dirs of a source (network). */
  sync: (source: SkillSource, dirs: string[]) => Promise<unknown>
  sources: readonly SkillSource[]
}

/** Perform a plan. Local skills first (so refs resolve), then sources, installs, presets. */
export async function applyImport(bundle: Bundle, plan: ImportPlan, deps: ApplyDeps): Promise<{ written: string[], installed: string[], skipped: string[] }> {
  const written: string[] = []
  const installed: string[] = []
  const skipped: string[] = []
  for (const l of plan.localSkills) {
    if (l.action !== 'write') { skipped.push(`local/${l.dir}`); continue }
    const files = bundle.localSkills[l.dir]
    for (const [rel, text] of Object.entries(files)) {
      const full = join(deps.libraryRoot, 'local', l.dir, rel)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, text, 'utf8')
    }
    written.push(`local/${l.dir}`)
  }
  if (plan.newSources.length > 0) await deps.saveSources([...deps.sources, ...plan.newSources])
  const allSources = [...deps.sources, ...plan.newSources]
  const bySource = new Map<string, string[]>()
  for (const t of plan.toInstall) bySource.set(t.source, [...(bySource.get(t.source) ?? []), t.dir])
  for (const [sourceId, dirs] of bySource) {
    const source = allSources.find(s => s.id === sourceId)
    if (source === undefined) continue
    await deps.sync({ ...source, enabled: true }, dirs)
    installed.push(...dirs.map(d => `${sourceId}/${d}`))
  }
  for (const p of plan.presets) {
    if (p.action === 'skip') { skipped.push(p.id); continue }
    const source = bundle.presets.find(x => x.id === p.from)!
    await deps.savePreset({ ...source, id: p.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    written.push(`preset ${p.id}`)
  }
  return { written, installed, skipped }
}

/** Read every file below a local skill dir (for export). */
export async function readLocalSkill(libraryRoot: string, dir: string): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises')
  const root = join(libraryRoot, 'local', dir)
  const out: Record<string, string> = {}
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(current, entry.name), rel)
      else if (entry.isFile()) out[rel] = await readFile(join(current, entry.name), 'utf8')
    }
  }
  await walk(root, '')
  return out
}
