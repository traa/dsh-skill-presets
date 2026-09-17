/**
 * Store paths and atomic JSON persistence.
 *
 * Every read tolerates an absent or malformed file and returns a default plus a
 * `note`, because this plugin runs on the load path: a corrupt lock must never
 * take the skill provider down with it.
 * @module dsh-skill-presets/host/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ActiveDoc, Lock, PracticesDoc } from './types.ts'

/** Environment shape read by the resolver. Injected so tests never mutate globals. */
export type Env = Readonly<Record<string, string | undefined>>

/** Whether an environment value is present and not just whitespace. */
function usable(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

/** Expand a leading `~`. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the harness home: `$DSH_HOME` or `~/.dsh`.
 * @param env - environment source.
 * @returns absolute path.
 */
export function resolveDshHome(env: Env = process.env): string {
  const configured = env.DSH_HOME
  return usable(configured) ? resolve(expandHome(configured.trim())) : join(homedir(), '.dsh')
}

/**
 * Resolve the workbench root the same way dsh-workbench does when the service is
 * absent: `$DSH_WORKBENCH`, `$DSH_SETTINGS_REPO`, then `<dsh home>/settings-repo`.
 * @param env - environment source.
 * @returns absolute path.
 */
export function resolveWorkbenchFallback(env: Env = process.env): string {
  for (const key of ['DSH_WORKBENCH', 'DSH_SETTINGS_REPO']) {
    const value = env[key]
    if (usable(value)) return resolve(expandHome(value.trim()))
  }
  return join(resolveDshHome(env), 'settings-repo')
}

/** Every path the plugin touches, derived from one root. */
export class StorePaths {
  constructor(readonly root: string) {}

  /** `<workbench>/skills`. */
  get skills(): string { return join(this.root, 'skills') }
  get library(): string { return join(this.skills, 'library') }
  get staging(): string { return join(this.library, '.staging') }
  get sources(): string { return join(this.skills, 'sources.json') }
  get lock(): string { return join(this.skills, 'lock.json') }
  get presets(): string { return join(this.skills, 'presets.json') }
  get overlays(): string { return join(this.skills, 'overlays.json') }
  get practices(): string { return join(this.skills, 'practices.json') }
  get normalizeRules(): string { return join(this.skills, 'normalize-rules.json') }
  get active(): string { return join(this.skills, 'active.json') }
  get suggestions(): string { return join(this.skills, 'suggestions.json') }
  get experiments(): string { return join(this.skills, 'experiments.json') }
  get worktrees(): string { return join(this.skills, 'worktrees.json') }
  get usage(): string { return join(this.skills, 'usage') }
  get rollup(): string { return join(this.skills, 'usage-rollup.json') }
  get migrated(): string { return join(this.skills, 'MIGRATED.md') }

  /** Directory of one installed skill bundle. */
  skillDir(source: string, dir: string): string {
    return join(this.library, source, dir)
  }

  /** Usage log for one session. */
  usageFile(sessionId: string): string {
    return join(this.usage, `${sessionId.replaceAll(/[^A-Za-z0-9_-]/gu, '_')}.jsonl`)
  }
}

/** Result of a tolerant read. */
export interface Loaded<T> {
  value: T
  /** Present when the default was used and why. */
  note?: string
}

/**
 * Read a JSON file, falling back to a default.
 * @param path - file path.
 * @param fallback - value when absent or malformed.
 * @param validate - optional shape check; a throw counts as malformed.
 * @returns the value plus a note when the fallback was used.
 */
export async function readJson<T>(
  path: string,
  fallback: () => T,
  validate?: (raw: unknown) => T,
): Promise<Loaded<T>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { value: fallback(), note: `${path} is absent` }
  }
  try {
    const raw: unknown = JSON.parse(text)
    return { value: validate === undefined ? raw as T : validate(raw) }
  } catch (error) {
    return { value: fallback(), note: `${path} is malformed: ${(error as Error).message}` }
  }
}

/**
 * Write JSON atomically: temp file in the same directory, then rename.
 * @param path - destination.
 * @param value - JSON-serialisable value.
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/** Empty lock. */
export function emptyLock(): Lock {
  return { version: 1, sources: {}, skills: [] }
}

/** Validate the lock shape loosely: arrays exist and entries have the keys we index by. */
export function validateLock(raw: unknown): Lock {
  const doc = raw as Partial<Lock>
  if (doc === null || typeof doc !== 'object') throw new TypeError('lock is not an object')
  if (!Array.isArray(doc.skills)) throw new TypeError('lock.skills is not an array')
  for (const skill of doc.skills) {
    if (typeof skill.source !== 'string' || typeof skill.dir !== 'string' || typeof skill.name !== 'string') {
      throw new TypeError('lock.skills entry lacks source/dir/name')
    }
  }
  return {
    version: 1,
    sources: typeof doc.sources === 'object' && doc.sources !== null ? doc.sources : {},
    skills: doc.skills,
  }
}

/** Default active document: nothing active anywhere. */
export function defaultActive(): ActiveDoc {
  return { version: 2, default: null, byAgentPreset: {}, sessions: {}, since: new Date(0).toISOString(), by: 'default' }
}

const BY_VALUES = new Set(['ui', 'tool', 'default', 'cli', 'experiment'])
const asBy = (value: unknown): ActiveDoc['by'] => typeof value === 'string' && BY_VALUES.has(value) ? value as ActiveDoc['by'] : 'default'
const asPreset = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null

/**
 * Validate the active document. A Phase-1 v1 document (`{ preset }`) migrates
 * to v2 by becoming the workspace default — the one global switch it was.
 */
export function validateActive(raw: unknown): ActiveDoc {
  const doc = raw as Record<string, unknown>
  if (doc === null || typeof doc !== 'object') throw new TypeError('active is not an object')
  const since = typeof doc.since === 'string' ? doc.since : new Date(0).toISOString()
  if (doc.version !== 2) {
    return { version: 2, default: asPreset(doc.preset), byAgentPreset: {}, sessions: {}, since, by: asBy(doc.by) }
  }
  const byAgentPreset: ActiveDoc['byAgentPreset'] = {}
  if (typeof doc.byAgentPreset === 'object' && doc.byAgentPreset !== null) {
    for (const [key, value] of Object.entries(doc.byAgentPreset as Record<string, unknown>)) byAgentPreset[key] = asPreset(value)
  }
  const sessions: Record<string, ActiveDoc['sessions'][string]> = {}
  if (typeof doc.sessions === 'object' && doc.sessions !== null) {
    for (const [key, value] of Object.entries(doc.sessions as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const entry = value as Record<string, unknown>
      sessions[key] = {
        preset: asPreset(entry.preset),
        since: typeof entry.since === 'string' ? entry.since : since,
        by: asBy(entry.by),
        ...(typeof entry.disposedAt === 'string' ? { disposedAt: entry.disposedAt } : {}),
      }
    }
  }
  return { version: 2, default: asPreset(doc.default), byAgentPreset, sessions, since, by: asBy(doc.by) }
}

/**
 * Resolve the preset for one session: session choice → agent-preset default →
 * workspace default. Pure.
 */
export function resolveActive(doc: ActiveDoc, sessionId?: string, agentPreset?: string): { preset: string | null, source: 'session' | 'agent-preset' | 'default' } {
  if (sessionId !== undefined) {
    const entry = doc.sessions[sessionId]
    if (entry !== undefined) return { preset: entry.preset, source: 'session' }
  }
  if (agentPreset !== undefined && Object.hasOwn(doc.byAgentPreset, agentPreset)) {
    return { preset: doc.byAgentPreset[agentPreset], source: 'agent-preset' }
  }
  return { preset: doc.default, source: 'default' }
}

/** Drop session entries disposed longer ago than the retention window. Pure. */
export function pruneSessions(doc: ActiveDoc, now: Date, retentionDays = 7): ActiveDoc {
  const cutoff = now.getTime() - retentionDays * 86_400_000
  const sessions: ActiveDoc['sessions'] = {}
  for (const [id, entry] of Object.entries(doc.sessions)) {
    if (entry.disposedAt !== undefined && Date.parse(entry.disposedAt) < cutoff) continue
    sessions[id] = entry
  }
  return { ...doc, sessions }
}

/**
 * Validate the practices document, filling defaults for missing fields.
 *
 * MIGRATION RULE, and the reason this function is the only place it lives: a
 * practices.json that EXISTS keeps every mode it declares. Only an absent file
 * (handled by `readJson` falling back to `defaultPractices`) or an entry absent
 * from an existing file takes the current shipped default.
 *
 * This matters because phase 6 flipped `worktree` from `advisory` to `hard`. A
 * user who deliberately chose `advisory` must not start getting their edits
 * DENIED because they upgraded the plugin — silently tightening enforcement
 * under someone is how a guardrail gets uninstalled. The per-entry merge below
 * gives exactly that: `found` wins when it parses, `entry` (the default) fills
 * the gap when the file never mentioned the practice.
 */
export function validatePractices(raw: unknown, fallback: () => PracticesDoc): PracticesDoc {
  const base = fallback()
  const doc = raw as Partial<PracticesDoc>
  if (doc === null || typeof doc !== 'object') throw new TypeError('practices is not an object')
  const practices = Array.isArray(doc.practices)
    ? base.practices.map((entry) => {
        const found = (doc.practices as PracticesDoc['practices']).find(p => p.id === entry.id)
        if (found === undefined) return entry
        const mode = found.mode === 'off' || found.mode === 'advisory' || found.mode === 'hard' ? found.mode : entry.mode
        const params = typeof found.params === 'object' && found.params !== null ? found.params : entry.params
        return { id: entry.id, mode, params }
      })
    : base.practices
  return {
    version: 1,
    strictSkills: doc.strictSkills === true,
    autoCleanWorktrees: doc.autoCleanWorktrees !== false,
    pruning: {
      minSessions: typeof doc.pruning?.minSessions === 'number' ? doc.pruning.minSessions : base.pruning.minSessions,
      maxLoadRate: typeof doc.pruning?.maxLoadRate === 'number' ? doc.pruning.maxLoadRate : base.pruning.maxLoadRate,
      minUnknown: typeof doc.pruning?.minUnknown === 'number' ? doc.pruning.minUnknown : base.pruning.minUnknown,
    },
    instructionFiles: Array.isArray(doc.instructionFiles) && doc.instructionFiles.every(f => typeof f === 'string')
      ? doc.instructionFiles
      : base.instructionFiles,
    protectedBranches: Array.isArray(doc.protectedBranches) && doc.protectedBranches.every(f => typeof f === 'string')
      ? doc.protectedBranches
      : base.protectedBranches,
    practices,
    // Exemptions survive a round-trip. Every write goes through here, so
    // dropping these would delete an operator's `exempt worktree` grant the
    // next time any unrelated practice setting was saved.
    ...(Array.isArray(doc.exemptRepos) && doc.exemptRepos.every(r => typeof r === 'string')
      ? { exemptRepos: doc.exemptRepos }
      : {}),
    ...(typeof doc.exemptUntil === 'string' ? { exemptUntil: doc.exemptUntil } : {}),
  }
}
