/**
 * The `skillPresets` service: one object every seam (provider, RPC, tools,
 * prompt, practices) reads and mutates, so the browser and the model see the
 * same truth.
 * @module dsh-skill-presets/host/service
 */

import { access, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURATED_OVERLAYS, CURATED_PRESETS, CURATED_SOURCES, PRACTICE_INFO, SRC, STAGE_ORDER, defaultPractices } from './curated.ts'
import { Library, type CheckReport, type SyncReport } from './library.ts'
import { BUILTIN_NORMALIZE_RULES, validateRules } from './normalize.ts'
import {
  clearParsedCache, resolveSet, splitRef, validateOverlaysFile, validatePreset, validatePresetsFile,
  type ResolvedSkill, type Resolution,
} from './presets.ts'
import {
  StorePaths, defaultActive, readJson, validateActive, validatePractices, writeJson,
} from './store.ts'
import type { ActiveDoc, Lock, NormalizeRule, Overlay, Preset, PracticesDoc, SkillSource, Stage } from './types.ts'

/** Where the plugin's own `skills/` folder is, for seeding local skills. */
export function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills')
}

/** Status the UI and tools read in one round trip. */
export interface ServiceStatus {
  root: string
  storeReady: boolean
  active: ActiveDoc
  activePreset?: Preset
  presets: Preset[]
  overlays: Overlay[]
  sources: SkillSource[]
  lock: Lock
  practices: PracticesDoc
  practiceInfo: typeof PRACTICE_INFO
  stages: readonly Stage[]
  /** Resolution of the active preset with no overlays (overlays are per agent). */
  resolution: Resolution
  notes: string[]
  /** Whether the library has never been installed (first-run CTA). */
  foundationInstalled: boolean
}

export interface ServiceDeps {
  root: () => string
  library?: Library
  log?: (message: string) => void
  now?: () => Date
}

export class SkillPresetsService {
  private pathsCache: { root: string, paths: StorePaths } | undefined
  readonly library: Library
  private readonly log: (message: string) => void
  private readonly now: () => Date
  /** Listeners notified when the exposed set may have changed. */
  private readonly changeListeners = new Set<() => void>()
  private bootstrapped: Promise<void> | undefined
  private bootstrappedRoot: string | undefined
  /** Long-running jobs (install/update), polled by the UI. */
  private readonly jobs = new Map<string, JobState>()
  private nextJob = 1

  constructor(private readonly deps: ServiceDeps) {
    this.log = deps.log ?? (() => {})
    this.now = deps.now ?? (() => new Date())
    this.library = deps.library ?? new Library({
      paths: () => this.paths(),
      rules: async () => await this.rules(),
      now: this.now,
    })
  }

  /** Store paths for the current root. */
  paths(): StorePaths {
    const root = this.deps.root()
    if (this.pathsCache?.root !== root) this.pathsCache = { root, paths: new StorePaths(root) }
    return this.pathsCache.paths
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  private notify(): void {
    clearParsedCache()
    for (const listener of this.changeListeners) {
      try { listener() } catch (error) { this.log(`change listener failed: ${(error as Error).message}`) }
    }
  }

  // ------------------------------------------------------------ documents --

  async sources(): Promise<SkillSource[]> {
    const loaded = await readJson(this.paths().sources, () => [...CURATED_SOURCES], validateSourcesFile)
    return loaded.value
  }

  async presets(): Promise<Preset[]> {
    return (await readJson(this.paths().presets, () => [...CURATED_PRESETS], validatePresetsFile)).value
  }

  async overlays(): Promise<Overlay[]> {
    return (await readJson(this.paths().overlays, () => [...CURATED_OVERLAYS], validateOverlaysFile)).value
  }

  async practices(): Promise<PracticesDoc> {
    return (await readJson(this.paths().practices, defaultPractices, raw => validatePractices(raw, defaultPractices))).value
  }

  async active(): Promise<ActiveDoc> {
    return (await readJson(this.paths().active, defaultActive, validateActive)).value
  }

  async rules(): Promise<readonly NormalizeRule[]> {
    return (await readJson(this.paths().normalizeRules, () => [...BUILTIN_NORMALIZE_RULES], validateRules)).value
  }

  async activePreset(): Promise<Preset | undefined> {
    const active = await this.active()
    if (active.preset === null) return undefined
    return (await this.presets()).find(p => p.id === active.preset)
  }

  async activeStage(): Promise<Stage | undefined> {
    const preset = await this.activePreset()
    return preset?.stage === 'cross' ? undefined : preset?.stage
  }

  // ------------------------------------------------------------ bootstrap --

  /**
   * Make the store usable: seed defaults, migrate legacy `skills/*` bundles
   * into `library/local/`, seed the plugin's own SDLC skills, index local.
   * Memoized per root; never throws.
   */
  async ensure(): Promise<void> {
    const root = this.deps.root()
    if (this.bootstrappedRoot !== root || this.bootstrapped === undefined) {
      this.bootstrappedRoot = root
      this.bootstrapped = this.bootstrap().catch((error) => {
        this.log(`bootstrap failed: ${(error as Error).message}`)
      })
    }
    await this.bootstrapped
  }

  private async bootstrap(): Promise<void> {
    const paths = this.paths()
    await mkdir(paths.library, { recursive: true })
    await mkdir(paths.usage, { recursive: true })
    const seed = async (path: string, value: unknown): Promise<void> => {
      try { await access(path) } catch { await writeJson(path, value) }
    }
    await seed(paths.sources, CURATED_SOURCES)
    await seed(paths.presets, CURATED_PRESETS)
    await seed(paths.overlays, CURATED_OVERLAYS)
    await seed(paths.practices, defaultPractices())
    await seed(paths.normalizeRules, BUILTIN_NORMALIZE_RULES)
    await seed(paths.active, defaultActive())

    // Legacy: `<workbench>/skills/<name>/SKILL.md` bundles that predate the
    // library. Moved (never deleted) so the old filesystem row, if still on,
    // stops double-exposing them.
    const localRoot = join(paths.library, SRC.local)
    await mkdir(localRoot, { recursive: true })
    const moved: string[] = []
    for (const entry of await readdir(paths.skills, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'library' || entry.name === 'usage' || entry.name.startsWith('.')) continue
      const from = join(paths.skills, entry.name)
      try { await access(join(from, 'SKILL.md')) } catch { continue }
      const to = join(localRoot, entry.name)
      try { await access(to); continue } catch { /* free */ }
      await rename(from, to)
      moved.push(entry.name)
    }
    if (moved.length > 0) {
      await writeFile(paths.migrated, [
        '# Skills moved into the library',
        '',
        'dsh-skill-presets moved these bundles from `skills/<name>/` into',
        '`skills/library/local/<name>/` so they are versioned and preset-addressable:',
        '',
        ...moved.map(name => `- ${name}`),
        '',
        'Nothing was deleted. Disable the profile\'s `skill-filesystem` row that pointed',
        'at `skills/` to avoid exposing them twice.',
        '',
      ].join('\n'), 'utf8')
      this.log(`migrated ${moved.length} legacy skill bundle(s) into library/local`)
    }

    // Seed the plugin's own SDLC skills without overwriting user edits.
    let seeded = 0
    try {
      for (const entry of await readdir(bundledSkillsDir(), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const target = join(localRoot, entry.name)
        try { await access(target); continue } catch { /* free */ }
        await copyDir(join(bundledSkillsDir(), entry.name), target)
        seeded += 1
      }
    } catch (error) {
      this.log(`seeding bundled skills skipped: ${(error as Error).message}`)
    }
    // Index local so refs resolve immediately.
    const local = (await this.sources()).find(s => s.id === SRC.local)
    if (local !== undefined) await this.library.sync(local)
    if (seeded > 0) this.log(`seeded ${seeded} SDLC skill(s) into library/local`)
    this.notify()
  }

  // -------------------------------------------------------------- reading --

  async status(): Promise<ServiceStatus> {
    await this.ensure()
    const paths = this.paths()
    const notes: string[] = []
    const [sources, presets, overlays, practices, active, lock] = await Promise.all([
      this.sources(), this.presets(), this.overlays(), this.practices(), this.active(), this.library.lock(),
    ])
    const activePreset = active.preset === null ? undefined : presets.find(p => p.id === active.preset)
    if (active.preset !== null && activePreset === undefined) notes.push(`active preset "${active.preset}" no longer exists; treated as none`)
    const resolution = await resolveSet(paths, lock, activePreset, [])
    const foundationInstalled = lock.skills.some(s => s.source !== SRC.local)
    return {
      root: paths.root,
      storeReady: true,
      active,
      ...(activePreset !== undefined ? { activePreset } : {}),
      presets,
      overlays,
      sources,
      lock,
      practices,
      practiceInfo: PRACTICE_INFO,
      stages: STAGE_ORDER,
      resolution,
      notes,
      foundationInstalled,
    }
  }

  /**
   * Resolve the exposed set for one agent: the active preset plus the overlays
   * whose condition holds for it.
   */
  async setFor(conditions: { teamAttached: boolean, inGitRepo: boolean }): Promise<{ skills: ResolvedSkill[], overlays: string[], resolution: Resolution }> {
    await this.ensure()
    const [preset, overlays, lock] = await Promise.all([this.activePreset(), this.overlays(), this.library.lock()])
    const activeOverlays = overlays.filter(o => o.enabled && (
      o.when === 'always'
      || (o.when === 'tool-visible:team_delegate' && conditions.teamAttached)
      || (o.when === 'git-work-tree' && conditions.inGitRepo)
    ))
    const resolution = await resolveSet(this.paths(), lock, preset, activeOverlays)
    return { skills: resolution.skills, overlays: activeOverlays.map(o => o.id), resolution }
  }

  // ------------------------------------------------------------- mutation --

  async activate(presetId: string | null, by: ActiveDoc['by']): Promise<{ from: string | null, to: string | null }> {
    await this.ensure()
    const current = await this.active()
    if (presetId !== null) {
      const preset = (await this.presets()).find(p => p.id === presetId)
      if (preset === undefined) throw new Error(`preset "${presetId}" does not exist`)
      const problems = validatePreset(preset, await this.library.lock())
      if (problems.length > 0) throw new Error(`preset "${presetId}" is invalid: ${problems.join('; ')}`)
    }
    await writeJson(this.paths().active, { version: 1, preset: presetId, since: this.now().toISOString(), by } satisfies ActiveDoc)
    this.notify()
    return { from: current.preset, to: presetId }
  }

  async savePreset(input: Preset): Promise<Preset> {
    await this.ensure()
    const presets = await this.presets()
    const existing = presets.find(p => p.id === input.id)
    const preset: Preset = {
      ...input,
      createdAt: existing?.createdAt ?? this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      ...(existing?.builtin === true ? { builtin: true } : {}),
    }
    const problems = validatePreset(preset, await this.library.lock())
    if (problems.length > 0) throw new Error(problems.join('; '))
    const next = existing === undefined ? [...presets, preset] : presets.map(p => p.id === preset.id ? preset : p)
    await writeJson(this.paths().presets, next)
    if ((await this.active()).preset === preset.id) this.notify()
    return preset
  }

  async deletePreset(id: string): Promise<void> {
    await this.ensure()
    const presets = await this.presets()
    if (!presets.some(p => p.id === id)) throw new Error(`preset "${id}" does not exist`)
    await writeJson(this.paths().presets, presets.filter(p => p.id !== id))
    if ((await this.active()).preset === id) await this.activate(null, 'default')
  }

  async duplicatePreset(id: string, newId: string, title?: string): Promise<Preset> {
    const source = (await this.presets()).find(p => p.id === id)
    if (source === undefined) throw new Error(`preset "${id}" does not exist`)
    const { builtin: _builtin, ...rest } = source
    return await this.savePreset({ ...rest, id: newId, title: title ?? `${source.title} (copy)`, createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() })
  }

  async saveOverlays(overlays: Overlay[]): Promise<void> {
    await this.ensure()
    await writeJson(this.paths().overlays, validateOverlaysFile(overlays))
    this.notify()
  }

  async savePractices(doc: PracticesDoc): Promise<PracticesDoc> {
    await this.ensure()
    const valid = validatePractices(doc, defaultPractices)
    await writeJson(this.paths().practices, valid)
    return valid
  }

  async saveSources(sources: SkillSource[]): Promise<void> {
    await this.ensure()
    await writeJson(this.paths().sources, validateSourcesFile(sources))
  }

  // -------------------------------------------------------------- library --

  /** Start an install/update job for one source or all; returns the job id. */
  startSync(sourceIds: string[] | undefined, dirs?: string[]): string {
    const id = `job-${this.nextJob++}`
    const job: JobState = { id, kind: 'sync', startedAt: this.now().toISOString(), done: false, progress: [], reports: [] }
    this.jobs.set(id, job)
    void (async () => {
      try {
        await this.ensure()
        const sources = (await this.sources()).filter(s => s.enabled && (sourceIds === undefined || sourceIds.includes(s.id)))
        for (const source of sources) {
          try {
            const report = await this.library.sync(source, {
              ...(dirs !== undefined ? { dirs } : {}),
              onProgress: (event) => { job.progress.push(`${event.source}/${event.dir}: ${event.step}${event.message !== undefined ? ` — ${event.message}` : ''}`) },
            })
            job.reports.push(report)
          } catch (error) {
            job.reports.push({ source: source.id, commit: '', added: [], updated: [], unchanged: [], orphaned: [], failed: [], note: (error as Error).message })
          }
        }
      } finally {
        job.done = true
        job.finishedAt = this.now().toISOString()
        this.notify()
      }
    })()
    return id
  }

  job(id: string): JobState | undefined {
    return this.jobs.get(id)
  }

  async check(sourceIds?: string[]): Promise<CheckReport[]> {
    await this.ensure()
    const sources = (await this.sources()).filter(s => s.enabled && s.kind === 'github' && (sourceIds === undefined || sourceIds.includes(s.id)))
    const reports: CheckReport[] = []
    for (const source of sources) {
      try {
        reports.push(await this.library.check(source))
      } catch (error) {
        reports.push({ source: source.id, upstreamCommit: '', changed: [], newUpstream: [], removedUpstream: [], ...({ note: (error as Error).message } as object) })
      }
    }
    return reports
  }

  async removeSkill(ref: string): Promise<void> {
    const split = splitRef(ref)
    if (split === undefined) throw new Error(`malformed ref ${ref}`)
    await this.library.remove(split.source, split.dir)
    this.notify()
  }

  /** Everything the drawer shows for one installed skill. */
  async skillDetail(ref: string): Promise<{ ref: string, text?: string, files: { path: string, bytes: number }[], locked?: Lock['skills'][number], usedBy: string[] }> {
    const split = splitRef(ref)
    if (split === undefined) throw new Error(`malformed ref ${ref}`)
    const [text, files, lock, presets] = await Promise.all([
      this.library.readSkillFile(split.source, split.dir),
      this.library.listFiles(split.source, split.dir),
      this.library.lock(),
      this.presets(),
    ])
    const locked = lock.skills.find(s => s.source === split.source && s.dir === split.dir)
    return {
      ref,
      ...(text !== undefined ? { text } : {}),
      files,
      ...(locked !== undefined ? { locked } : {}),
      usedBy: presets.filter(p => p.skills.some(s => s.ref === ref)).map(p => p.id),
    }
  }
}

export interface JobState {
  id: string
  kind: 'sync'
  startedAt: string
  finishedAt?: string
  done: boolean
  progress: string[]
  reports: SyncReport[]
}

/** Validate the sources file. */
export function validateSourcesFile(raw: unknown): SkillSource[] {
  if (!Array.isArray(raw)) throw new TypeError('sources must be an array')
  const out: SkillSource[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const s = entry as Partial<SkillSource>
    if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(s.id)) continue
    const kind = s.kind === 'local' ? 'local' : 'github'
    if (kind === 'github' && (typeof s.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(s.repo))) continue
    out.push({
      id: s.id,
      title: typeof s.title === 'string' ? s.title : s.id,
      kind,
      ...(typeof s.repo === 'string' ? { repo: s.repo } : {}),
      ...(typeof s.ref === 'string' ? { ref: s.ref } : {}),
      ...(Array.isArray(s.paths) && s.paths.every(p => typeof p === 'string') ? { paths: s.paths } : {}),
      enabled: s.enabled !== false,
      ...(typeof s.note === 'string' ? { note: s.note } : {}),
    })
  }
  // Local is always present so seeding has somewhere to go.
  if (!out.some(s => s.id === SRC.local)) out.push(CURATED_SOURCES.find(s => s.id === SRC.local)!)
  return out
}

async function copyDir(from: string, to: string): Promise<void> {
  const { cp } = await import('node:fs/promises')
  await cp(from, to, { recursive: true })
}
