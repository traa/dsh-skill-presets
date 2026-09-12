/**
 * The skill library: install, update, check, remove.
 *
 * Installs are staged under `library/.staging/<id>` and renamed into place, so
 * a failed download never leaves a half-written bundle the provider could read.
 * Upstream text is normalized on the way in (see `normalize.ts`) and both
 * digests are recorded, so the UI can show exactly what changed.
 * @module dsh-skill-presets/host/library
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { parseSkill } from './frontmatter.ts'
import { GithubClient, discoverSkills, type DiscoveredSkill } from './github.ts'
import { isNormalizable, normalizeText } from './normalize.ts'
import { emptyLock, readJson, validateLock, writeJson, type StorePaths } from './store.ts'
import type { Lock, LockedSkill, NormalizeRule, SkillSource } from './types.ts'

/** Files as `{ relative path → contents }`. */
export type Bundle = Map<string, string>

/** sha256 over sorted paths and contents. */
export function digestBundle(bundle: Bundle): string {
  const hash = createHash('sha256')
  for (const path of [...bundle.keys()].sort()) {
    hash.update(path)
    hash.update('\0')
    hash.update(bundle.get(path) ?? '')
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Read every file below a directory into a bundle. */
export async function readBundle(dir: string): Promise<Bundle> {
  const bundle: Bundle = new Map()
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) bundle.set(relative(dir, full).split('\\').join('/'), await readFile(full, 'utf8'))
    }
  }
  await walk(dir)
  return bundle
}

/** Write a bundle to a directory. */
async function writeBundle(dir: string, bundle: Bundle): Promise<void> {
  for (const [path, text] of bundle) {
    const full = join(dir, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text, 'utf8')
  }
}

/** Options for one install/update run. */
export interface InstallOptions {
  /** Restrict to these directory names; undefined installs everything discovered. */
  dirs?: readonly string[]
  /** Skip normalization for these directories (user opt-out). */
  keepUpstream?: readonly string[]
  signal?: AbortSignal
  /** Progress callback: called per skill. */
  onProgress?: (event: { source: string, dir: string, step: 'fetch' | 'write' | 'skip' | 'error', message?: string }) => void
}

/** Outcome of an install or update. */
export interface SyncReport {
  readonly source: string
  readonly commit: string
  readonly added: string[]
  readonly updated: string[]
  readonly unchanged: string[]
  readonly orphaned: string[]
  readonly failed: { dir: string, error: string }[]
  readonly note?: string
}

/** Outcome of a check (no download). */
export interface CheckReport {
  readonly source: string
  readonly lockedCommit?: string
  readonly upstreamCommit: string
  /** Directories whose upstream files differ from the locked commit's tree shas. */
  readonly changed: string[]
  readonly newUpstream: string[]
  readonly removedUpstream: string[]
}

export interface LibraryDeps {
  /** Resolved per call so a relocated workbench takes effect without a restart. */
  paths: () => StorePaths
  github?: GithubClient
  rules: () => Promise<readonly NormalizeRule[]>
  now?: () => Date
}

export class Library {
  private readonly github: GithubClient
  private readonly now: () => Date
  private lockWrite: Promise<void> = Promise.resolve()

  constructor(private readonly deps: LibraryDeps) {
    this.github = deps.github ?? new GithubClient()
    this.now = deps.now ?? (() => new Date())
  }

  /** Read the lock, tolerating absence. */
  async lock(): Promise<Lock> {
    return (await readJson(this.deps.paths().lock, emptyLock, validateLock)).value
  }

  /** Serialised lock mutation so concurrent installs cannot lose entries. */
  private async mutateLock(mutate: (lock: Lock) => Lock): Promise<Lock> {
    let result!: Lock
    this.lockWrite = this.lockWrite.then(async () => {
      const current = await this.lock()
      result = mutate(current)
      await writeJson(this.deps.paths().lock, result)
    })
    await this.lockWrite
    return result
  }

  /**
   * Install or update every discoverable skill of one source.
   * @param source - source descriptor.
   * @param options - filters, opt-outs, progress.
   */
  async sync(source: SkillSource, options: InstallOptions = {}): Promise<SyncReport> {
    if (source.kind === 'local') return await this.syncLocal(source, options)
    if (source.repo === undefined) throw new Error(`source "${source.id}" has no repo`)
    const tree = await this.github.tree(source.repo, source.ref, options.signal)
    const roots = source.paths ?? ['skills']
    const discovered = discoverSkills(tree.entries, roots)
      .filter(skill => options.dirs === undefined || options.dirs.includes(skill.dir))
    const rules = await this.deps.rules()
    const lock = await this.lock()
    const report: SyncReport = {
      source: source.id, commit: tree.commit, added: [], updated: [], unchanged: [], orphaned: [], failed: [],
      ...(tree.truncated ? { note: 'GitHub truncated the tree listing; some skills may be missing' } : {}),
    }
    const installed: LockedSkill[] = []

    for (const skill of discovered) {
      options.signal?.throwIfAborted()
      const existing = lock.skills.find(entry => entry.source === source.id && entry.dir === skill.dir)
      try {
        options.onProgress?.({ source: source.id, dir: skill.dir, step: 'fetch' })
        const upstream = await this.fetchBundle(source.repo, tree.commit, skill, options.signal)
        const upstreamDigest = digestBundle(upstream)
        const keep = options.keepUpstream?.includes(skill.dir) === true
        const { bundle, normalized } = keep ? { bundle: upstream, normalized: false } : applyRules(upstream, rules)
        const digest = digestBundle(bundle)
        if (existing !== undefined && existing.digest === digest && existing.orphaned === undefined) {
          report.unchanged.push(skill.dir)
          installed.push({ ...existing, commit: tree.commit })
          options.onProgress?.({ source: source.id, dir: skill.dir, step: 'skip' })
          continue
        }
        const parsed = parseSkill(bundle.get('SKILL.md') ?? '')
        if ('error' in parsed) throw new Error(`SKILL.md rejected: ${parsed.error}`)
        options.onProgress?.({ source: source.id, dir: skill.dir, step: 'write' })
        await this.stageAndPlace(source.id, skill.dir, bundle)
        const history = existing === undefined
          ? undefined
          : [{ commit: existing.commit, digest: existing.digest, at: existing.installedAt }, ...(existing.history ?? [])].slice(0, 5)
        installed.push({
          source: source.id,
          dir: skill.dir,
          name: parsed.name,
          description: parsed.description,
          digest,
          ...(upstreamDigest !== digest ? { upstreamDigest } : {}),
          normalized,
          commit: tree.commit,
          installedAt: this.now().toISOString(),
          files: bundle.size,
          ...(history !== undefined ? { history } : {}),
        })
        ;(existing === undefined ? report.added : report.updated).push(skill.dir)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        report.failed.push({ dir: skill.dir, error: message })
        options.onProgress?.({ source: source.id, dir: skill.dir, step: 'error', message })
        if (existing !== undefined) installed.push(existing)
      }
    }

    // Anything locked for this source that upstream no longer has is orphaned —
    // files are kept, presets referencing it show "unresolved", nothing is deleted.
    if (options.dirs === undefined) {
      for (const entry of lock.skills.filter(e => e.source === source.id)) {
        if (!discovered.some(skill => skill.dir === entry.dir)) {
          report.orphaned.push(entry.dir)
          installed.push({ ...entry, orphaned: true })
        }
      }
    } else {
      for (const entry of lock.skills.filter(e => e.source === source.id && !options.dirs!.includes(e.dir))) {
        installed.push(entry)
      }
    }

    await this.mutateLock(current => ({
      version: 1,
      sources: { ...current.sources, [source.id]: { commit: tree.commit, fetchedAt: this.now().toISOString() } },
      skills: [...current.skills.filter(entry => entry.source !== source.id), ...installed],
    }))
    return report
  }

  /** Re-index a local source: read what is on disk and record it. */
  private async syncLocal(source: SkillSource, options: InstallOptions): Promise<SyncReport> {
    const root = join(this.deps.paths().library, source.id)
    await mkdir(root, { recursive: true })
    const dirs = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name)
    const lock = await this.lock()
    const report: SyncReport = { source: source.id, commit: 'local', added: [], updated: [], unchanged: [], orphaned: [], failed: [] }
    const installed: LockedSkill[] = []
    for (const dir of dirs) {
      if (options.dirs !== undefined && !options.dirs.includes(dir)) continue
      const existing = lock.skills.find(entry => entry.source === source.id && entry.dir === dir)
      try {
        const bundle = await readBundle(join(root, dir))
        const parsed = parseSkill(bundle.get('SKILL.md') ?? '')
        if ('error' in parsed) throw new Error(`SKILL.md rejected: ${parsed.error}`)
        const digest = digestBundle(bundle)
        if (existing?.digest === digest) {
          report.unchanged.push(dir)
          installed.push(existing)
          continue
        }
        installed.push({
          source: source.id, dir, name: parsed.name, description: parsed.description, digest, normalized: false,
          commit: 'local', installedAt: this.now().toISOString(), files: bundle.size,
          ...(existing?.promotedFrom !== undefined ? { promotedFrom: existing.promotedFrom } : {}),
        })
        ;(existing === undefined ? report.added : report.updated).push(dir)
      } catch (error) {
        report.failed.push({ dir, error: error instanceof Error ? error.message : String(error) })
      }
    }
    for (const entry of lock.skills.filter(e => e.source === source.id && !dirs.includes(e.dir))) {
      report.orphaned.push(entry.dir)
    }
    await this.mutateLock(current => ({
      version: 1,
      sources: { ...current.sources, [source.id]: { commit: 'local', fetchedAt: this.now().toISOString() } },
      skills: [...current.skills.filter(entry => entry.source !== source.id), ...installed],
    }))
    return report
  }

  /** Compare upstream against the lock without downloading bundles. */
  async check(source: SkillSource, signal?: AbortSignal): Promise<CheckReport> {
    if (source.kind === 'local' || source.repo === undefined) {
      return { source: source.id, upstreamCommit: 'local', changed: [], newUpstream: [], removedUpstream: [] }
    }
    const lock = await this.lock()
    const locked = lock.sources[source.id]
    const tree = await this.github.tree(source.repo, source.ref, signal)
    const discovered = discoverSkills(tree.entries, source.paths ?? ['skills'])
    const lockedSkills = lock.skills.filter(entry => entry.source === source.id)
    const report: CheckReport = {
      source: source.id,
      ...(locked !== undefined ? { lockedCommit: locked.commit } : {}),
      upstreamCommit: tree.commit,
      changed: [],
      newUpstream: discovered.filter(skill => !lockedSkills.some(entry => entry.dir === skill.dir)).map(skill => skill.dir),
      removedUpstream: lockedSkills.filter(entry => !discovered.some(skill => skill.dir === entry.dir)).map(entry => entry.dir),
    }
    if (locked !== undefined && locked.commit !== tree.commit) {
      // Without the old tree we cannot diff per skill cheaply; compare the old
      // tree's shas when the commit differs.
      try {
        const old = await this.github.tree(source.repo, locked.commit, signal)
        const oldByPath = new Map(old.entries.map(entry => [entry.path, entry.sha]))
        for (const skill of discovered) {
          if (!lockedSkills.some(entry => entry.dir === skill.dir)) continue
          const differs = skill.files.some(file => oldByPath.get(file.path) !== file.sha)
            || old.entries.some(entry => entry.path.startsWith(`${skill.path}/`) && !skill.files.some(f => f.path === entry.path))
          if (differs) report.changed.push(skill.dir)
        }
      } catch {
        // Fall back to "commit moved" without per-skill detail.
        report.changed.push(...lockedSkills.map(entry => entry.dir))
      }
    }
    return report
  }

  /** Remove one installed skill: files and lock entry. */
  async remove(sourceId: string, dir: string): Promise<void> {
    await rm(this.deps.paths().skillDir(sourceId, dir), { recursive: true, force: true })
    await this.mutateLock(current => ({
      ...current,
      skills: current.skills.filter(entry => !(entry.source === sourceId && entry.dir === dir)),
    }))
  }

  /** Read the installed SKILL.md text of one skill. */
  async readSkillFile(sourceId: string, dir: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.deps.paths().skillDir(sourceId, dir), 'SKILL.md'), 'utf8')
    } catch {
      return undefined
    }
  }

  /** List files of one installed skill. */
  async listFiles(sourceId: string, dir: string): Promise<{ path: string, bytes: number }[]> {
    const root = this.deps.paths().skillDir(sourceId, dir)
    try {
      const bundle = await readBundle(root)
      const files: { path: string, bytes: number }[] = []
      for (const path of [...bundle.keys()].sort()) {
        const info = await stat(join(root, path))
        files.push({ path, bytes: info.size })
      }
      return files
    } catch {
      return []
    }
  }

  private async fetchBundle(repo: string, commit: string, skill: DiscoveredSkill, signal?: AbortSignal): Promise<Bundle> {
    const bundle: Bundle = new Map()
    for (const file of skill.files) {
      signal?.throwIfAborted()
      const rel = file.path.slice(skill.path.length + 1)
      bundle.set(rel, await this.github.raw(repo, commit, file.path, signal))
    }
    return bundle
  }

  private async stageAndPlace(sourceId: string, dir: string, bundle: Bundle): Promise<void> {
    const stage = join(this.deps.paths().staging, `${sourceId}--${dir}--${process.pid}`)
    await rm(stage, { recursive: true, force: true })
    await mkdir(stage, { recursive: true })
    try {
      await writeBundle(stage, bundle)
      const target = this.deps.paths().skillDir(sourceId, dir)
      await mkdir(dirname(target), { recursive: true })
      const backup = `${target}.previous`
      await rm(backup, { recursive: true, force: true })
      try {
        await rename(target, backup)
      } catch {
        // No previous install.
      }
      await rename(stage, target)
      await rm(backup, { recursive: true, force: true })
    } catch (error) {
      await rm(stage, { recursive: true, force: true })
      throw error
    }
  }
}

/** Apply normalization rules to the text files of a bundle. */
export function applyRules(upstream: Bundle, rules: readonly NormalizeRule[]): { bundle: Bundle, normalized: boolean } {
  const bundle: Bundle = new Map()
  let normalized = false
  for (const [path, text] of upstream) {
    if (!isNormalizable(path)) {
      bundle.set(path, text)
      continue
    }
    const result = normalizeText(text, rules)
    if (result.applied.length > 0) normalized = true
    bundle.set(path, result.text)
  }
  return { bundle, normalized }
}
