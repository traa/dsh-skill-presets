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
import { adoptFoundation, foundationReport, type FoundationReport } from './foundation.ts'
import { Library, type CheckReport, type SyncReport } from './library.ts'
import { emptySuggestions, recordAcceptance, recordDismissal, validateSuggestions, type SuggestionsDoc } from './stage.ts'
import { cleanupWorktrees, scanWorktrees, type CleanupResult, type WorktreeInfo } from './practices/worktrees.ts'
import { lintLibrary } from './lint.ts'
import { BUILTIN_NORMALIZE_RULES, validateRules } from './normalize.ts'
import {
  clearParsedCache, resolveSet, splitRef, validateOverlaysFile, validatePreset, validatePresetsFile,
  type ResolvedSkill, type Resolution,
} from './presets.ts'
import {
  StorePaths, defaultActive, pruneSessions, readJson, resolveActive, validateActive, validatePractices, writeJson,
} from './store.ts'
import type { ActivateBy, ActivateScope, ActiveDoc, Lock, NormalizeRule, Overlay, Preset, PracticesDoc, SkillSource, Stage } from './types.ts'

/** Where the plugin's own `skills/` folder is, for seeding local skills. */
export function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills')
}

/** Status the UI and tools read in one round trip. */
export interface ServiceStatus {
  root: string
  storeReady: boolean
  active: ActiveDoc
  /** The workspace-default preset (what a new session starts from). */
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

  async suggestions(): Promise<SuggestionsDoc> {
    return (await readJson(this.paths().suggestions, emptySuggestions, validateSuggestions)).value
  }

  async dismissSuggestion(from: Stage | null, to: Stage): Promise<SuggestionsDoc> {
    const next = recordDismissal(await this.suggestions(), from, to, this.now())
    await writeJson(this.paths().suggestions, next)
    return next
  }

  async acceptSuggestion(from: Stage | null, to: Stage): Promise<SuggestionsDoc> {
    const next = recordAcceptance(await this.suggestions(), from, to)
    await writeJson(this.paths().suggestions, next)
    return next
  }

  // ------------------------------------------------------------ worktrees --

  /** Worktrees the plugin observed being created: absolute path → session + time. */
  async createdWorktrees(): Promise<Record<string, { sessionId: string, at: string }>> {
    return (await readJson(this.paths().worktrees, () => ({}) as Record<string, { sessionId: string, at: string }>, (raw) => {
      if (typeof raw !== 'object' || raw === null) throw new TypeError('worktrees malformed')
      const out: Record<string, { sessionId: string, at: string }> = {}
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'object' && v !== null && typeof (v as { sessionId: unknown }).sessionId === 'string') out[k] = { sessionId: (v as { sessionId: string }).sessionId, at: String((v as { at?: unknown }).at ?? '') }
      }
      return out
    })).value
  }

  async rememberWorktree(path: string, sessionId: string): Promise<void> {
    const current = await this.createdWorktrees()
    await writeJson(this.paths().worktrees, { ...current, [path]: { sessionId, at: this.now().toISOString() } })
  }

  async forgetWorktrees(paths: readonly string[]): Promise<void> {
    const current = await this.createdWorktrees()
    for (const p of paths) delete current[p]
    await writeJson(this.paths().worktrees, current)
  }

  /** Scan the repository containing `cwd`. */
  async worktrees(cwd: string): Promise<{ defaultBranch: string, worktrees: WorktreeInfo[] }> {
    return await scanWorktrees(cwd, { created: await this.createdWorktrees() })
  }

  /**
   * Remove merged + clean worktrees (and their branches) in the repository
   * containing `cwd`. Dirty or unmerged trees are reported, never touched.
   */
  async cleanupWorktrees(cwd: string, options: { dryRun?: boolean, only?: string[] } = {}): Promise<CleanupResult> {
    const result = await cleanupWorktrees(cwd, { created: await this.createdWorktrees(), ...options })
    if (options.dryRun !== true && result.removed.length > 0) await this.forgetWorktrees(result.removed.map(r => r.path))
    return result
  }

  /** stage → preset ids, for suggestion targeting. */
  async presetsByStage(): Promise<Map<Stage, string[]>> {
    const map = new Map<Stage, string[]>()
    for (const p of await this.presets()) map.set(p.stage, [...(map.get(p.stage) ?? []), p.id])
    return map
  }

  async rules(): Promise<readonly NormalizeRule[]> {
    return (await readJson(this.paths().normalizeRules, () => [...BUILTIN_NORMALIZE_RULES], validateRules)).value
  }

  /** A session's identity for resolution. Both optional: no session → workspace default. */
  async activeFor(session?: { id?: string, agentPreset?: string }): Promise<{ preset: string | null, source: 'session' | 'agent-preset' | 'default' }> {
    return resolveActive(await this.active(), session?.id, session?.agentPreset)
  }

  async activePreset(session?: { id?: string, agentPreset?: string }): Promise<Preset | undefined> {
    const { preset } = await this.activeFor(session)
    if (preset === null) return undefined
    return (await this.presets()).find(p => p.id === preset)
  }

  async activeStage(session?: { id?: string, agentPreset?: string }): Promise<Stage | undefined> {
    const preset = await this.activePreset(session)
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
    const activePreset = active.default === null ? undefined : presets.find(p => p.id === active.default)
    if (active.default !== null && activePreset === undefined) notes.push(`default preset "${active.default}" no longer exists; treated as none`)
    for (const [key, id] of Object.entries(active.byAgentPreset)) {
      if (id !== null && !presets.some(p => p.id === id)) notes.push(`agent preset "${key}" maps to missing preset "${id}"`)
    }
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
  async setFor(
    conditions: { teamAttached: boolean, inGitRepo: boolean },
    session?: { id?: string, agentPreset?: string },
  ): Promise<{ skills: ResolvedSkill[], overlays: string[], resolution: Resolution, preset: Preset | undefined }> {
    await this.ensure()
    const [preset, overlays, lock] = await Promise.all([this.activePreset(session), this.overlays(), this.library.lock()])
    const activeOverlays = overlays.filter(o => o.enabled && (
      o.when === 'always'
      || (o.when === 'tool-visible:team_delegate' && conditions.teamAttached)
      || (o.when === 'git-work-tree' && conditions.inGitRepo)
    ))
    const resolution = await resolveSet(this.paths(), lock, preset, activeOverlays)
    return { skills: resolution.skills, overlays: activeOverlays.map(o => o.id), resolution, preset }
  }

  // ------------------------------------------------------------- mutation --

  /**
   * Activate a preset at one scope.
   * - `session`: this session only (needs `target.sessionId`); survives until pruned.
   * - `agent-preset`: every new session created under that harness agent preset.
   * - `default`: the workspace default.
   * Returns what the affected session(s) saw before and after.
   */
  async activate(
    presetId: string | null,
    by: ActivateBy,
    target: { scope?: ActivateScope, sessionId?: string, agentPreset?: string } = {},
  ): Promise<{ from: string | null, to: string | null, scope: ActivateScope }> {
    await this.ensure()
    if (presetId !== null) {
      const preset = (await this.presets()).find(p => p.id === presetId)
      if (preset === undefined) throw new Error(`preset "${presetId}" does not exist`)
      const problems = validatePreset(preset, await this.library.lock())
      if (problems.length > 0) throw new Error(`preset "${presetId}" is invalid: ${problems.join('; ')}`)
    }
    const scope: ActivateScope = target.scope ?? (target.sessionId !== undefined ? 'session' : 'default')
    const current = await this.active()
    const now = this.now().toISOString()
    let next: ActiveDoc
    let from: string | null
    if (scope === 'session') {
      if (target.sessionId === undefined) throw new Error('session scope needs a sessionId')
      from = resolveActive(current, target.sessionId, target.agentPreset).preset
      next = { ...current, sessions: { ...current.sessions, [target.sessionId]: { preset: presetId, since: now, by } } }
    } else if (scope === 'agent-preset') {
      if (target.agentPreset === undefined) throw new Error('agent-preset scope needs an agentPreset')
      from = Object.hasOwn(current.byAgentPreset, target.agentPreset) ? current.byAgentPreset[target.agentPreset] : current.default
      next = { ...current, byAgentPreset: { ...current.byAgentPreset, [target.agentPreset]: presetId }, since: now, by }
    } else {
      from = current.default
      next = { ...current, default: presetId, since: now, by }
    }
    await writeJson(this.paths().active, next)
    this.notify()
    return { from, to: presetId, scope }
  }

  /** Forget a session's own choice so it falls back to the defaults. */
  async clearSession(sessionId: string): Promise<void> {
    const current = await this.active()
    if (!Object.hasOwn(current.sessions, sessionId)) return
    const { [sessionId]: _dropped, ...sessions } = current.sessions
    await writeJson(this.paths().active, { ...current, sessions })
    this.notify()
  }

  /** Mark a session disposed (starts its retention clock) and prune old ones. */
  async sessionDisposed(sessionId: string): Promise<void> {
    const current = await this.active()
    const entry = current.sessions[sessionId]
    const now = this.now()
    const marked = entry === undefined
      ? current
      : { ...current, sessions: { ...current.sessions, [sessionId]: { ...entry, disposedAt: now.toISOString() } } }
    const pruned = pruneSessions(marked, now)
    if (pruned !== current) await writeJson(this.paths().active, pruned)
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
    // Any scope may reference it; invalidating is cheap.
    this.notify()
    return preset
  }

  async deletePreset(id: string): Promise<void> {
    await this.ensure()
    const presets = await this.presets()
    if (!presets.some(p => p.id === id)) throw new Error(`preset "${id}" does not exist`)
    await writeJson(this.paths().presets, presets.filter(p => p.id !== id))
    const active = await this.active()
    const sessions: ActiveDoc['sessions'] = {}
    for (const [k, v] of Object.entries(active.sessions)) sessions[k] = v.preset === id ? { ...v, preset: null } : v
    const byAgentPreset: ActiveDoc['byAgentPreset'] = {}
    for (const [k, v] of Object.entries(active.byAgentPreset)) byAgentPreset[k] = v === id ? null : v
    await writeJson(this.paths().active, { ...active, default: active.default === id ? null : active.default, sessions, byAgentPreset })
    this.notify()
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

  /**
   * What a newer curated foundation would add to this store.
   *
   * Read-only: the store is seeded once, so a user whose `presets.json`
   * predates a curated change never sees it. Comparing against the shipped
   * constants on every call is cheap and always reflects the installed plugin
   * version, so no migration marker has to be persisted.
   */
  async foundation(): Promise<FoundationReport> {
    return foundationReport(CURATED_PRESETS, await this.presets(), CURATED_OVERLAYS, await this.overlays())
  }

  /**
   * Adopt the pending foundation changes, optionally only the given ids.
   *
   * Merges rather than replaces (see foundation.ts), so a preset the user
   * edited keeps their edits. Writes both documents and notifies, so the
   * model's catalog and the browser pick the new skills up on the next step.
   */
  async adoptFoundation(only?: readonly string[]): Promise<{ kind: string, id: string, added: string[] }[]> {
    await this.ensure()
    const storedPresets = await this.presets()
    const storedOverlays = await this.overlays()
    const report = foundationReport(CURATED_PRESETS, storedPresets, CURATED_OVERLAYS, storedOverlays)
    const { presets, overlays, applied } = adoptFoundation(
      report, CURATED_PRESETS, storedPresets, CURATED_OVERLAYS, storedOverlays,
      only,
      () => this.now().toISOString(),
    )
    if (applied.length === 0) return applied
    if (applied.some(a => a.kind === 'preset')) await writeJson(this.paths().presets, presets)
    if (applied.some(a => a.kind === 'overlay')) await writeJson(this.paths().overlays, overlays)
    this.notify()
    return applied
  }

  /**
   * Record an explicit, EXPIRING exemption from the `worktree` hard gate.
   *
   * A gate with no legitimate override is a gate the user turns off entirely
   * the first time it is wrong about their situation — and a practice set to
   * `off` never comes back on. This keeps the escape hatch inside the system:
   * it is scoped to one repository, it carries a reason, and it dies on its
   * own, so "just this once" cannot quietly become the permanent state.
   *
   * EACH GRANT REPLACES THE PREVIOUS ONE — SO ONLY ONE REPOSITORY CAN BE
   * EXEMPT AT A TIME. Exempting repo B REVOKES an existing exemption on repo
   * A. There is no way to hold two at once through this method; do not expect
   * one.
   *
   * That is forced by the schema, not chosen: `PracticesDoc` carries a single
   * `exemptUntil` timestamp for the whole `exemptRepos` list, so the list
   * cannot express per-grant lifetimes. Appending would therefore have been
   * worse than replacing — every new grant would silently reset the shared
   * clock and resurrect every earlier repo's EXPIRED exemption. Given one
   * clock, replacing is the only form that keeps "expiring" true.
   *
   * The honest model is a list of `{ repo, until, reason }` records, which
   * would let grants coexist and expire independently. That is a follow-up: it
   * changes `PracticesDoc`, which this PR treats as frozen.
   *
   * @param repo - repository top level the exemption covers.
   * @param hours - lifetime; the exemption is dead after it elapses.
   * @param reason - why, kept for the audit trail in the log.
   * @returns the saved document.
   */
  async exemptWorktree(repo: string, hours: number, reason: string): Promise<PracticesDoc> {
    const doc = await this.practices()
    const until = new Date(this.now().getTime() + hours * 3_600_000).toISOString()
    const replaced = (doc.exemptRepos ?? []).filter(r => r !== repo)
    if (replaced.length > 0) this.log(`worktree exemption replaced for ${replaced.join(', ')}`)
    this.log(`worktree exemption for ${repo} until ${until}: ${reason}`)
    return await this.savePractices({ ...doc, exemptRepos: [repo], exemptUntil: until })
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
        // Lint what just landed so a vendor term re-introduced upstream is visible now.
        try {
          const lint = await lintLibrary(await this.library.lock(), this.paths())
          if (lint.counts.error > 0) job.progress.push(`lint: ${lint.counts.error} error(s) — ${Object.entries(lint.byRef).filter(([, f]) => f.some(x => x.severity === 'error')).map(([r]) => r).slice(0, 5).join(', ')}`)
          job.lint = lint.counts
        } catch { /* lint is advisory */ }
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
  lint?: { error: number, warn: number, info: number }
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
