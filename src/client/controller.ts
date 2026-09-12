/**
 * Page-lifetime controllers: one for the settings page (status, library,
 * insights), one per session for the scorecard. Both are plain stores the
 * views subscribe to; all mutation goes through RPC and re-reads.
 * @module dsh-skill-presets/client/controller
 */

import { Store, rpc, type CheckReport, type JobState, type Preset, type PracticesDoc, type Rollup, type Scorecard, type SessionSummary, type SkillDetail, type Status } from './api.ts'

export interface SettingsSnapshot {
  status?: Status
  rollup?: Rollup
  recent?: SessionSummary[]
  checks?: CheckReport[]
  job?: JobState
  detail?: SkillDetail
  loading: boolean
  busy?: string
  error?: string
  notice?: string
  tab: 'stages' | 'library' | 'practices' | 'insights'
  editing?: Preset
  revision: number
}

export class SettingsController extends Store<SettingsSnapshot> {
  private jobTimer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    super({ loading: true, tab: 'stages', revision: 0 })
  }

  override set(patch: Partial<SettingsSnapshot>): void {
    super.set({ ...patch, revision: this.get().revision + 1 })
  }

  async refresh(): Promise<void> {
    this.set({ loading: true, error: undefined })
    try {
      const status = await rpc<Status>('status')
      this.set({ status, loading: false })
    } catch (error) {
      this.set({ loading: false, error: (error as Error).message })
    }
  }

  setTab(tab: SettingsSnapshot['tab']): void {
    this.set({ tab, notice: undefined, error: undefined })
    if (tab === 'insights' && this.get().rollup === undefined) void this.loadInsights()
  }

  async loadInsights(rebuild = false): Promise<void> {
    try {
      const [rollup, recent] = await Promise.all([
        rpc<Rollup>('usage/rollup', { rebuild }),
        rpc<SessionSummary[]>('usage/recent', { limit: 40 }),
      ])
      this.set({ rollup, recent })
    } catch (error) {
      this.set({ error: (error as Error).message })
    }
  }

  private async action(name: string, run: () => Promise<string | undefined>): Promise<void> {
    this.set({ busy: name, error: undefined, notice: undefined })
    try {
      const notice = await run()
      await this.refresh()
      this.set({ busy: undefined, ...(notice !== undefined ? { notice } : {}) })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async activate(id: string | null): Promise<void> {
    await this.action('activate', async () => {
      await rpc('presets/activate', { id })
      return id === null ? 'No preset active. The model\'s catalog updates on its next step.' : `Preset "${id}" active. The model's catalog updates on its next step.`
    })
  }

  async installFoundation(): Promise<void> {
    await this.action('install', async () => {
      const { job } = await rpc<{ job: string }>('library/install', {})
      this.pollJob(job)
      return 'Installing the foundation… progress below.'
    })
  }

  async updateSource(sourceId?: string): Promise<void> {
    await this.action('update', async () => {
      const { job } = await rpc<{ job: string }>('library/update', sourceId !== undefined ? { sources: [sourceId] } : {})
      this.pollJob(job)
      return 'Updating… progress below.'
    })
  }

  private pollJob(id: string): void {
    if (this.jobTimer !== undefined) clearTimeout(this.jobTimer)
    const tick = async (): Promise<void> => {
      try {
        const job = await rpc<JobState>('library/job', { id })
        this.set({ job })
        if (!job.done) {
          const t = setTimeout(() => { void tick() }, 900)
          ;(t as { unref?: () => void }).unref?.()
          this.jobTimer = t
        } else {
          await this.refresh()
        }
      } catch (error) {
        this.set({ error: (error as Error).message })
      }
    }
    void tick()
  }

  async check(): Promise<void> {
    await this.action('check', async () => {
      const checks = await rpc<CheckReport[]>('library/check', {})
      this.set({ checks })
      const changed = checks.reduce((n, c) => n + c.changed.length + c.newUpstream.length, 0)
      return changed === 0 ? 'Library is up to date.' : `${changed} skill(s) changed or new upstream.`
    })
  }

  async openSkill(ref: string): Promise<void> {
    try {
      this.set({ detail: await rpc<SkillDetail>('library/skill', { ref }) })
    } catch (error) {
      this.set({ error: (error as Error).message })
    }
  }

  closeSkill(): void {
    this.set({ detail: undefined })
  }

  async removeSkill(ref: string): Promise<void> {
    await this.action('remove', async () => {
      await rpc('library/remove', { ref })
      this.set({ detail: undefined })
      return `Removed ${ref}.`
    })
  }

  startEdit(preset: Preset): void {
    this.set({ editing: { ...preset, skills: [...preset.skills] } })
  }

  newPreset(): void {
    const now = new Date().toISOString()
    this.set({ editing: { id: '', title: '', stage: 'cross', summary: '', skills: [], createdAt: now, updatedAt: now } })
  }

  editField(patch: Partial<Preset>): void {
    const editing = this.get().editing
    if (editing !== undefined) this.set({ editing: { ...editing, ...patch } })
  }

  toggleSkill(ref: string): void {
    const editing = this.get().editing
    if (editing === undefined) return
    const has = editing.skills.some(s => s.ref === ref)
    this.set({ editing: { ...editing, skills: has ? editing.skills.filter(s => s.ref !== ref) : [...editing.skills, { ref }] } })
  }

  setAlias(ref: string, as: string): void {
    const editing = this.get().editing
    if (editing === undefined) return
    this.set({ editing: { ...editing, skills: editing.skills.map(s => s.ref === ref ? { ...s, ...(as.length > 0 ? { as } : { as: undefined }) } : s) } })
  }

  cancelEdit(): void {
    this.set({ editing: undefined })
  }

  async savePreset(): Promise<void> {
    const editing = this.get().editing
    if (editing === undefined) return
    await this.action('save', async () => {
      await rpc('presets/save', { preset: editing })
      this.set({ editing: undefined })
      return `Saved preset "${editing.id}".`
    })
  }

  async deletePreset(id: string): Promise<void> {
    await this.action('delete', async () => {
      await rpc('presets/delete', { id })
      return `Deleted "${id}".`
    })
  }

  async duplicatePreset(id: string): Promise<void> {
    await this.action('duplicate', async () => {
      const copy = await rpc<Preset>('presets/duplicate', { id, newId: `${id}-copy-${Date.now().toString(36).slice(-4)}` })
      this.startEdit(copy)
      return `Duplicated as "${copy.id}".`
    })
  }

  async savePractices(doc: PracticesDoc): Promise<void> {
    await this.action('practices', async () => {
      await rpc('practices/save', { practices: doc })
      return 'Practices saved.'
    })
  }
}

export interface ScorecardSnapshot {
  card?: Scorecard
  status?: Status
  loading: boolean
  error?: string
  busy?: string
  popover: boolean
  revision: number
}

/** One per session; polls while a view says it is visible. */
export class ScorecardController extends Store<ScorecardSnapshot> {
  private timer: ReturnType<typeof setTimeout> | undefined
  private visible = 0

  constructor(readonly sessionId: string, private readonly intervalMs = 3000) {
    super({ loading: true, popover: false, revision: 0 })
  }

  override set(patch: Partial<ScorecardSnapshot>): void {
    super.set({ ...patch, revision: this.get().revision + 1 })
  }

  async refresh(refreshFacts = false): Promise<void> {
    try {
      const [card, status] = await Promise.all([
        rpc<Scorecard>('scorecard', { sessionId: this.sessionId, refresh: refreshFacts }),
        rpc<Status>('status'),
      ])
      this.set({ card, status, loading: false, error: undefined })
    } catch (error) {
      this.set({ loading: false, error: (error as Error).message })
    }
  }

  /** A view became visible; start polling. Returns the disposer. */
  watch(): () => void {
    this.visible += 1
    if (this.visible === 1) this.schedule(0)
    return () => {
      this.visible -= 1
      if (this.visible === 0 && this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    }
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    const timer = setTimeout(async () => {
      await this.refresh()
      if (this.visible > 0) this.schedule(this.intervalMs)
    }, delay)
    // In a browser this is a no-op; under node --test it lets the process exit.
    ;(timer as { unref?: () => void }).unref?.()
    this.timer = timer
  }

  togglePopover(open?: boolean): void {
    this.set({ popover: open ?? !this.get().popover })
  }

  async activate(id: string | null): Promise<void> {
    this.set({ busy: 'activate' })
    try {
      await rpc('presets/activate', { id })
      await this.refresh(true)
      this.set({ busy: undefined, popover: false })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async rate(rating: -1 | 0 | 1): Promise<void> {
    try {
      await rpc('usage/rate', { sessionId: this.sessionId, rating })
      await this.refresh()
    } catch (error) {
      this.set({ error: (error as Error).message })
    }
  }
}
