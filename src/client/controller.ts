/**
 * Page-lifetime controllers: one for the settings page (status, library,
 * insights), one per session for the scorecard. Both are plain stores the
 * views subscribe to; all mutation goes through RPC and re-reads.
 * @module dsh-skill-presets/client/controller
 */

import { Store, rpc, type ActivateScope, type CheckReport, type CleanupResult, type DoctorReport, type InsightCandidate, type PruningReport, type TeamTemplate, type CompareCard, type JobState, type Preset, type PracticesDoc, type Rollup, type Scorecard, type SessionSummary, type SkillDetail, type Status } from './api.ts'

export interface SettingsSnapshot {
  status?: Status
  rollup?: Rollup
  recent?: SessionSummary[]
  checks?: CheckReport[]
  insights?: InsightCandidate[]
  pruning?: PruningReport
  doctor?: DoctorReport
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
      const [status, doctor] = await Promise.all([rpc<Status>('status'), rpc<DoctorReport>('doctor').catch(() => undefined)])
      this.set({ status, loading: false, ...(doctor !== undefined ? { doctor } : {}) })
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
      const [rollup, recent, insights, pruning] = await Promise.all([
        rpc<Rollup>('usage/rollup', { rebuild }),
        rpc<SessionSummary[]>('usage/recent', { limit: 40 }),
        rpc<InsightCandidate[]>('knowledge/candidates', {}).catch(() => [] as InsightCandidate[]),
        rpc<PruningReport>('pruning/report', {}).catch(() => undefined),
      ])
      this.set({ rollup, recent, insights, ...(pruning !== undefined ? { pruning } : {}) })
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

  /** Settings page: set the WORKSPACE DEFAULT (new sessions start from it). */
  async activate(id: string | null): Promise<void> {
    await this.action('activate', async () => {
      await rpc('presets/activate', { id, scope: 'default' })
      return id === null ? 'No default preset. Sessions without their own choice expose overlays only.' : `"${id}" is the workspace default. Sessions with their own choice keep it.`
    })
  }

  /** Settings page: default for one harness agent preset (standard, cordis, …). */
  async setAgentPresetDefault(agentPreset: string, id: string | null): Promise<void> {
    await this.action('activate', async () => {
      await rpc('presets/activate', { id, scope: 'agent-preset', agentPreset })
      return `Sessions under agent preset "${agentPreset}" now start from ${id ?? 'the workspace default'}.`
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

  async exportBundle(): Promise<void> {
    await this.action('export', async () => {
      const bundle = await rpc<{ presets: { id: string }[] }>('bundle/export', {})
      const text = JSON.stringify(bundle, null, 2)
      if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `skill-presets-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      return `Exported ${bundle.presets.length} preset(s).`
    })
  }

  async importBundle(text: string, onCollision: 'skip' | 'replace' | 'rename' = 'skip'): Promise<void> {
    await this.action('import', async () => {
      let bundle: unknown
      try { bundle = JSON.parse(text) } catch { throw new Error('that file is not JSON') }
      const out = await rpc<{ ok: boolean, plan: { presets: { id: string, action: string }[], toInstall: unknown[], problems: string[], collisions: string[] }, result?: { written: string[], installed: string[], skipped: string[] } }>('bundle/apply', { bundle, onCollision })
      if (!out.ok) throw new Error(`import refused: ${out.plan.problems.join('; ')}`)
      const r = out.result!
      return `Imported: ${r.written.join(', ') || 'nothing new'}${r.installed.length > 0 ? `; installed ${r.installed.length} skill(s)` : ''}${r.skipped.length > 0 ? `; kept ours: ${r.skipped.join(', ')}` : ''}.`
    })
  }

  async pruneFromPreset(preset: string, ref: string): Promise<void> {
    await this.action('prune', async () => {
      await rpc('pruning/remove', { preset, ref })
      await this.loadInsights()
      return `Removed ${ref.split('/').pop()} from "${preset}". It stays in the library.`
    })
  }

  async addToPreset(preset: string, ref: string): Promise<void> {
    await this.action('prune', async () => {
      await rpc('pruning/add', { preset, ref })
      await this.loadInsights()
      return `Added ${ref.split('/').pop()} to "${preset}".`
    })
  }

  async searchMissingUpstream(): Promise<void> {
    await this.action('search', async () => {
      const pruning = await rpc<PruningReport>('pruning/report', { searchUpstream: true })
      this.set({ pruning })
      return `Searched ${pruning.missing.filter(m => m.upstream !== undefined).length} name(s) upstream.`
    })
  }

  async promoteInsight(id: string, name?: string): Promise<void> {
    await this.action('promote', async () => {
      const out = await rpc<{ ok: boolean, ref: string, name: string }>('knowledge/promote', { insightId: id, ...(name !== undefined ? { name } : {}) })
      await this.loadInsights()
      await this.openSkill(out.ref)
      return `Promoted to local skill "${out.name}". Edit the body into a checklist, then add it to a preset.`
    })
  }

  async generateHooks(): Promise<void> {
    await this.action('hooks', async () => {
      const out = await rpc<{ ok: boolean, files: string[] }>('hooks/generate', {})
      return `Wrote ${out.files.join(' and ')}. Mount dsh-hooks-claude-code or dsh-hooks-codex with configPath pointing at one of them.`
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
  templates?: TeamTemplate[]
  agentTeamsPresent?: boolean
  status?: Status
  loading: boolean
  error?: string
  notice?: string
  busy?: string
  popover: boolean
  compare?: CompareCard[]
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

  /** Switch for THIS session by default; `scope` widens it. */
  async activate(id: string | null, scope: ActivateScope = 'session'): Promise<void> {
    this.set({ busy: 'activate', error: undefined })
    try {
      await rpc('presets/activate', { id, sessionId: this.sessionId, scope })
      await this.refresh(true)
      this.set({ busy: undefined, popover: false, notice: scope === 'session' ? 'This session only. Catalog updates on the model\'s next step.' : scope === 'default' ? 'Workspace default updated.' : 'Agent-preset default updated.' })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  /** Drop this session's own choice; fall back to the defaults. */
  async useDefault(): Promise<void> {
    this.set({ busy: 'activate' })
    try {
      await rpc('presets/clear-session', { sessionId: this.sessionId })
      await this.refresh(true)
      this.set({ busy: undefined, popover: false })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async acceptSuggestion(presetId?: string): Promise<void> {
    this.set({ busy: 'suggest' })
    try {
      const out = await rpc<{ ok: boolean, message?: string }>('suggestion/accept', { sessionId: this.sessionId, ...(presetId !== undefined ? { presetId } : {}) })
      await this.refresh(true)
      this.set({ busy: undefined, ...(out.ok ? {} : { error: out.message }) })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async dismissSuggestion(): Promise<void> {
    try {
      const out = await rpc<{ ok: boolean, muted?: boolean }>('suggestion/dismiss', { sessionId: this.sessionId })
      await this.refresh()
      if (out.muted === true) this.set({ notice: 'This suggestion is muted for this workspace.' })
    } catch (error) {
      this.set({ error: (error as Error).message })
    }
  }

  async fork(preset: string | null): Promise<void> {
    this.set({ busy: 'fork', error: undefined })
    try {
      const out = await rpc<{ ok: boolean, message?: string, experiment?: { child: string } }>('experiments/fork', { sessionId: this.sessionId, preset })
      await this.refresh()
      this.set({ busy: undefined, ...(out.ok ? { notice: `Forked as ${out.experiment?.child.slice(0, 8)} under ${preset ?? 'no preset'}. Open it from the session list to run the same task.` } : { error: out.message }) })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async loadTemplates(): Promise<void> {
    try {
      const out = await rpc<{ templates: TeamTemplate[], agentTeamsPresent: boolean }>('teams/templates', {})
      this.set({ templates: out.templates, agentTeamsPresent: out.agentTeamsPresent })
    } catch (error) {
      this.set({ error: (error as Error).message })
    }
  }

  async attachTemplate(templateId: string): Promise<void> {
    this.set({ busy: 'team', error: undefined })
    try {
      const out = await rpc<{ ok: boolean, message?: string, teamName?: string }>('teams/attach-template', { sessionId: this.sessionId, templateId })
      await this.refresh(true)
      this.set({ busy: undefined, ...(out.ok ? { notice: `Team "${out.teamName}" attached. The conductor protocol overlay applies on the model's next step.` } : { error: out.message }) })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async cleanupWorktrees(only?: string[], dryRun = false): Promise<void> {
    this.set({ busy: 'worktrees', error: undefined })
    try {
      const out = await rpc<{ ok: boolean, message?: string, result?: CleanupResult }>('worktrees/cleanup', { sessionId: this.sessionId, ...(only !== undefined ? { only } : {}), dryRun })
      await this.refresh(true)
      const r = out.result
      this.set({ busy: undefined, ...(out.ok && r !== undefined
        ? { notice: `${r.dryRun ? 'Would remove' : 'Removed'} ${r.removed.length} worktree${r.removed.length === 1 ? '' : 's'}${r.attention.length > 0 ? `; ${r.attention.length} need attention` : ''}${r.errors.length > 0 ? `; ${r.errors.length} error(s)` : ''}.` }
        : { error: out.message ?? 'cleanup failed' }) })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async saveFixture(): Promise<void> {
    this.set({ busy: 'fixture', error: undefined })
    try {
      const out = await rpc<{ ok: boolean, dir?: string, message?: string }>('evals/save', { sessionId: this.sessionId })
      this.set({ busy: undefined, ...(out.ok ? { notice: `Saved as an eval fixture at ${out.dir}. \`dsh-skill-presets eval\` replays it; edit expected.json to pin the intended outcome.` } : { error: out.message }) })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async compare(sessionIds: string[]): Promise<void> {
    try {
      const { cards } = await rpc<{ cards: CompareCard[] }>('experiments/compare', { sessionIds })
      this.set({ compare: cards })
    } catch (error) {
      this.set({ error: (error as Error).message })
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
