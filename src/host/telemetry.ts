/**
 * Usage telemetry: one JSONL file per session plus an incremental rollup.
 *
 * "Used effectively" is measured, not asserted: which skills were OFFERED
 * (in the catalog), which were LOADED (the `skill` tool ran), at what turn,
 * how often; which names the model asked for that did not exist; which
 * practices ended green or red; how it split by provider/model. All from tool
 * events and git — never from assistant prose.
 * @module dsh-skill-presets/host/telemetry
 */

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJson, type StorePaths } from './store.ts'
import type { PracticeResult, Rollup, UsageEvent } from './types.ts'

/** A usage event without its timestamp, distributed over the union so each variant keeps its own fields. */
export type UsageInput = UsageEvent extends infer E ? E extends UsageEvent ? Omit<E, 't'> & { t?: string } : never : never

export function emptyRollup(): Rollup {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    sessions: 0,
    skills: {},
    presets: {},
    practices: {},
    unknownRequests: {},
    coUsage: {},
    byModel: {},
  }
}

/** Per-session summary derived from its events. */
export interface SessionSummary {
  readonly sessionId: string
  readonly preset: string | null
  readonly overlays: string[]
  readonly offered: string[]
  /** name → { count, firstTurn } */
  readonly loaded: Record<string, { count: number, firstTurn: number, chars: number, lastAt: string }>
  readonly unknown: string[]
  readonly practices: PracticeResult[]
  readonly denied: number
  readonly rating?: -1 | 0 | 1
  readonly provider?: string
  readonly model?: string
  readonly startedAt?: string
  readonly lastAt?: string
  readonly switches: { from: string | null, to: string | null, t: string }[]
  readonly loads: { name: string, turn: number, t: string, ok: boolean }[]
}

/** Fold one session's events into a summary. Pure. */
export function summarize(sessionId: string, events: readonly UsageEvent[]): SessionSummary {
  let preset: string | null = null
  const overlays = new Set<string>()
  const offered = new Set<string>()
  const loaded: SessionSummary['loaded'] = {}
  const unknown: string[] = []
  const practices = new Map<string, PracticeResult>()
  let denied = 0
  let rating: SessionSummary['rating']
  let provider: string | undefined
  let model: string | undefined
  const switches: SessionSummary['switches'] = []
  const loads: SessionSummary['loads'] = []
  for (const event of events) {
    switch (event.kind) {
      case 'offered':
        preset = event.preset
        for (const id of event.overlays) overlays.add(id)
        for (const name of event.skills) offered.add(name)
        break
      case 'loaded':
        loads.push({ name: event.name, turn: event.turn, t: event.t, ok: event.ok })
        if (event.unknown === true) { unknown.push(event.name); break }
        if (!event.ok) break
        loaded[event.name] ??= { count: 0, firstTurn: event.turn, chars: 0, lastAt: event.t }
        loaded[event.name].count += 1
        loaded[event.name].chars += event.chars
        loaded[event.name].lastAt = event.t
        break
      case 'preset-switch':
        preset = event.to
        switches.push({ from: event.from, to: event.to, t: event.t })
        break
      case 'overlay':
        if (event.active) overlays.add(event.id); else overlays.delete(event.id)
        break
      case 'practice':
        practices.set(event.id, { id: event.id, status: event.status, evidence: event.evidence })
        break
      case 'denied':
        denied += 1
        break
      case 'rated':
        rating = event.rating
        break
      case 'provider':
        provider = event.provider
        model = event.model
        break
      case 'session':
        break
    }
  }
  return {
    sessionId,
    preset,
    overlays: [...overlays],
    offered: [...offered].sort(),
    loaded,
    unknown,
    practices: [...practices.values()],
    denied,
    ...(rating !== undefined ? { rating } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(events.length > 0 ? { startedAt: events[0].t, lastAt: events[events.length - 1].t } : {}),
    switches,
    loads,
  }
}

/** Fold session summaries into a rollup. Pure. */
export function rollupOf(summaries: readonly SessionSummary[], now: Date = new Date()): Rollup {
  const out: Rollup = { ...emptyRollup(), updatedAt: now.toISOString(), sessions: summaries.length }
  for (const s of summaries) {
    for (const name of s.offered) {
      out.skills[name] ??= { sessionsOffered: 0, sessionsLoaded: 0, loads: 0, firstLoadTurnSum: 0, chars: 0 }
      out.skills[name].sessionsOffered += 1
    }
    const loadedNames = Object.keys(s.loaded).sort()
    for (const name of loadedNames) {
      const info = s.loaded[name]
      out.skills[name] ??= { sessionsOffered: 0, sessionsLoaded: 0, loads: 0, firstLoadTurnSum: 0, chars: 0 }
      const stats = out.skills[name]
      stats.sessionsLoaded += 1
      stats.loads += info.count
      stats.firstLoadTurnSum += info.firstTurn
      stats.chars += info.chars
      if (stats.lastUsed === undefined || stats.lastUsed < info.lastAt) stats.lastUsed = info.lastAt
    }
    for (let i = 0; i < loadedNames.length; i += 1) {
      for (let j = i + 1; j < loadedNames.length; j += 1) {
        const key = `${loadedNames[i]}|${loadedNames[j]}`
        out.coUsage[key] = (out.coUsage[key] ?? 0) + 1
      }
    }
    for (const name of s.unknown) out.unknownRequests[name] = (out.unknownRequests[name] ?? 0) + 1
    const presetKey = s.preset ?? '(none)'
    out.presets[presetKey] ??= { sessions: 0, ratingSum: 0, ratings: 0, coverageSum: 0 }
    const p = out.presets[presetKey]
    p.sessions += 1
    if (s.rating !== undefined) { p.ratingSum += s.rating; p.ratings += 1 }
    if (s.offered.length > 0) p.coverageSum += loadedNames.filter(n => s.offered.includes(n)).length / s.offered.length
    for (const practice of s.practices) {
      out.practices[practice.id] ??= { green: 0, amber: 0, red: 0, na: 0 }
      const bucket = practice.status === 'n/a' ? 'na' : practice.status
      out.practices[practice.id][bucket] += 1
    }
    const modelKey = s.provider !== undefined ? `${s.provider}/${s.model ?? '?'}` : '(unknown)'
    out.byModel[modelKey] ??= { sessions: 0, loads: 0 }
    out.byModel[modelKey].sessions += 1
    out.byModel[modelKey].loads += Object.values(s.loaded).reduce((n, v) => n + v.count, 0)
  }
  return out
}

/** Parse one JSONL text into events, skipping malformed lines. */
export function parseEvents(text: string): UsageEvent[] {
  const events: UsageEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as UsageEvent
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.kind === 'string') events.push(parsed)
    } catch {
      // A torn write at the end of a file is not a reason to lose the session.
    }
  }
  return events
}

/** Persistence for usage events and the rollup. */
export class Telemetry {
  private readonly warned = new Set<string>()
  private readonly buffers = new Map<string, UsageEvent[]>()
  private flushTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly paths: StorePaths,
    private readonly log: (message: string) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Queue one event; flushed within a short window. */
  record(sessionId: string, event: UsageInput): void {
    const full = { ...event, t: event.t ?? this.now().toISOString() } as UsageEvent
    const buffer = this.buffers.get(sessionId) ?? []
    buffer.push(full)
    this.buffers.set(sessionId, buffer)
    this.flushTimer ??= setTimeout(() => { void this.flush() }, 250)
  }

  /** Write buffered events. Failures are logged once per session and never thrown. */
  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    const pending = [...this.buffers.entries()]
    this.buffers.clear()
    for (const [sessionId, events] of pending) {
      if (events.length === 0) continue
      try {
        await mkdir(this.paths.usage, { recursive: true })
        await appendFile(this.paths.usageFile(sessionId), `${events.map(e => JSON.stringify(e)).join('\n')}\n`, 'utf8')
      } catch (error) {
        if (!this.warned.has(sessionId)) {
          this.warned.add(sessionId)
          this.log(`usage log for ${sessionId} not written: ${(error as Error).message}`)
        }
      }
    }
  }

  /** Read one session's events (buffered + on disk). */
  async events(sessionId: string): Promise<UsageEvent[]> {
    let onDisk: UsageEvent[] = []
    try {
      onDisk = parseEvents(await readFile(this.paths.usageFile(sessionId), 'utf8'))
    } catch {
      onDisk = []
    }
    return [...onDisk, ...(this.buffers.get(sessionId) ?? [])]
  }

  async summary(sessionId: string): Promise<SessionSummary> {
    return summarize(sessionId, await this.events(sessionId))
  }

  /** Rebuild the rollup from every usage file. */
  async rebuildRollup(): Promise<Rollup> {
    await this.flush()
    let files: string[] = []
    try {
      files = (await readdir(this.paths.usage)).filter(name => name.endsWith('.jsonl'))
    } catch {
      files = []
    }
    const summaries: SessionSummary[] = []
    for (const file of files) {
      try {
        const events = parseEvents(await readFile(join(this.paths.usage, file), 'utf8'))
        if (events.length > 0) summaries.push(summarize(file.slice(0, -'.jsonl'.length), events))
      } catch {
        // skip unreadable file
      }
    }
    const rollup = rollupOf(summaries, this.now())
    try {
      await writeJson(this.paths.rollup, rollup)
    } catch (error) {
      this.log(`rollup not written: ${(error as Error).message}`)
    }
    return rollup
  }

  /** Read the stored rollup, or rebuild when absent. */
  async rollup(): Promise<Rollup> {
    const loaded = await readJson(this.paths.rollup, emptyRollup)
    if (loaded.note !== undefined) return await this.rebuildRollup()
    return loaded.value
  }

  /** Recent session summaries, newest first, for the Insights tab. */
  async recentSessions(limit = 50): Promise<SessionSummary[]> {
    await this.flush()
    let files: string[] = []
    try {
      files = (await readdir(this.paths.usage)).filter(name => name.endsWith('.jsonl'))
    } catch {
      return []
    }
    const summaries: SessionSummary[] = []
    for (const file of files) {
      try {
        const events = parseEvents(await readFile(join(this.paths.usage, file), 'utf8'))
        if (events.length > 0) summaries.push(summarize(file.slice(0, -'.jsonl'.length), events))
      } catch {
        // skip
      }
    }
    summaries.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
    return summaries.slice(0, limit)
  }
}
