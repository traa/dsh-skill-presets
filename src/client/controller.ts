/**
 * Page-lifetime controllers: one for the settings page (status, library,
 * insights), one per session for the scorecard. Both are plain stores the
 * views subscribe to; all mutation goes through RPC and re-reads.
 * @module dsh-skill-presets/client/controller
 */

import { Store, rpc, type ActivateScope, type CheckReport, type CleanupResult, type DoctorReport, type ExperimentsAggregate, type FoundationReport, type ImpactReport, type LibraryLint, type OrphanSkill, type Placement, type StrictPresets, type InsightCandidate, type PeerComparison, type PruningReport, type TeamTemplate, type CompareCard, type JobState, type Preset, type PracticesDoc, type Rollup, type Scorecard, type SessionSummary, type SkillDetail, type Status, type PositionCard, type Flow } from './api.ts'

/**
 * The right-sidebar page type's KIND, as registered with `sidebarRightTabs` and
 * as looked up by `sidebarRight.openTab`. Not the tab id (`dsh-skill-presets`):
 * the tab-type registry is keyed by kind, and passing the id throws. It lives
 * here rather than in `index.ts` because both the registration and the popover's
 * open path need it, and `index.ts` already imports this module.
 */
export const TAB_KIND = 'skills'

export interface SettingsSnapshot {
  status?: Status
  /** Phase 7: flows (Full, Explore, custom). */
  flows?: Flow[]
  /** A flow being edited (or a new one). */
  flowDraft?: { id: string, title: string, stages: string[], guardrails: 'on' | 'off', isNew: boolean }
  rollup?: Rollup
  recent?: SessionSummary[]
  checks?: CheckReport[]
  insights?: InsightCandidate[]
  pruning?: PruningReport
  doctor?: DoctorReport
  /** Curated presets/overlays that moved on since this store was seeded. */
  foundation?: FoundationReport
  impact?: ImpactReport
  experiments?: ExperimentsAggregate
  lint?: LibraryLint
  orphans?: OrphanSkill[]
  strictPresets?: StrictPresets
  /** After a promotion: where the new skill could go. */
  lastPromotion?: { ref: string, name: string, suggestedPresets: Placement[] }
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
      const [status, doctor, orphans, foundation, flows] = await Promise.all([
        rpc<Status>('status'),
        rpc<DoctorReport>('doctor').catch(() => undefined),
        rpc<OrphanSkill[]>('placement/orphans').catch(() => undefined),
        rpc<FoundationReport>('foundation/report').catch(() => undefined),
        rpc<{ flows: Flow[] }>('flows/list').then(r => r.flows).catch(() => undefined),
      ])
      this.set({ status, loading: false, ...(doctor !== undefined ? { doctor } : {}), ...(orphans !== undefined ? { orphans } : {}), ...(foundation !== undefined ? { foundation } : {}), ...(flows !== undefined ? { flows } : {}) })
    } catch (error) {
      this.set({ loading: false, error: (error as Error).message })
    }
  }

  setTab(tab: SettingsSnapshot['tab']): void {
    this.set({ tab, notice: undefined, error: undefined })
    if (tab === 'insights' && this.get().rollup === undefined) void this.loadInsights()
    if (tab === 'library' && this.get().lint === undefined) void this.loadLint()
    if (tab === 'practices' && this.get().strictPresets === undefined) void this.loadStrictPresets()
  }

  async loadStrictPresets(): Promise<void> {
    try { this.set({ strictPresets: await rpc<StrictPresets>('strict/presets', {}) }) } catch { /* advisory */ }
  }

  async createStrictPreset(base: string, skillPreset?: string): Promise<void> {
    await this.action('strict', async () => {
      const out = await rpc<{ ok: boolean, id: string, targetDir: string, dropped: string[], note: string }>('strict/create', { base, ...(skillPreset !== undefined ? { skillPreset } : {}) })
      await this.loadStrictPresets()
      return `Created agent preset "${out.id}" at ${out.targetDir} (dropped: ${out.dropped.join(', ') || 'nothing'}). ${out.note}`
    })
  }

  async loadLint(): Promise<void> {
    try { this.set({ lint: await rpc<LibraryLint>('lint', {}) }) } catch { /* advisory */ }
  }

  async loadInsights(rebuild = false): Promise<void> {
    try {
      const [rollup, recent, insights, pruning, impact, experiments] = await Promise.all([
        rpc<Rollup>('usage/rollup', { rebuild }),
        rpc<SessionSummary[]>('usage/recent', { limit: 40 }),
        rpc<InsightCandidate[]>('knowledge/candidates', {}).catch(() => [] as InsightCandidate[]),
        rpc<PruningReport>('pruning/report', {}).catch(() => undefined),
        rpc<ImpactReport>('impact/report', {}).catch(() => undefined),
        rpc<ExperimentsAggregate>('experiments/aggregate', {}).catch(() => undefined),
      ])
      this.set({ rollup, recent, insights, ...(pruning !== undefined ? { pruning } : {}), ...(impact !== undefined ? { impact } : {}), ...(experiments !== undefined ? { experiments } : {}) })
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

  /**
   * Adopt the curated foundation, all of it or the given ids.
   *
   * Merging, never replacing, so this is safe to offer as a single button even
   * for a preset the user has edited; the notice names what was added so the
   * change is never silent.
   */
  async adoptFoundation(ids?: string[]): Promise<void> {
    await this.action('foundation', async () => {
      const out = await rpc<{ ok: boolean, applied: { kind: string, id: string, added: string[] }[] }>('foundation/adopt', ids !== undefined ? { ids } : {})
      if (out.applied.length === 0) return 'Already current; nothing to adopt.'
      const added = [...new Set(out.applied.flatMap(a => a.added))]
      return `Adopted ${out.applied.length} update${out.applied.length === 1 ? '' : 's'}${added.length > 0 ? `: added ${added.join(', ')}` : ''}. Offered on the model's next step.`
    })
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
      const out = await rpc<{ ok: boolean, ref: string, name: string, suggestedPresets: Placement[] }>('knowledge/promote', { insightId: id, ...(name !== undefined ? { name } : {}) })
      await this.loadInsights()
      this.set({ lastPromotion: { ref: out.ref, name: out.name, suggestedPresets: out.suggestedPresets } })
      await this.openSkill(out.ref)
      return `Promoted to local skill "${out.name}". Edit the body into a checklist${out.suggestedPresets.length > 0 ? `; it looks like a ${out.suggestedPresets.map(p => p.title).join(' or ')} skill — add it from the drawer` : ''}.`
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
  // ---- flows (Phase 7)
  newFlow(): void {
    this.set({ flowDraft: { id: '', title: '', stages: ['build', 'test'], guardrails: 'on', isNew: true } })
  }

  editFlow(flow: Flow): void {
    this.set({ flowDraft: { id: flow.id, title: flow.title, stages: [...flow.stages], guardrails: flow.guardrails, isNew: false } })
  }

  patchFlowDraft(patch: Partial<NonNullable<SettingsSnapshot['flowDraft']>>): void {
    const d = this.get().flowDraft
    if (d !== undefined) this.set({ flowDraft: { ...d, ...patch } })
  }

  /** Toggle a stage in the draft, keeping canonical stage order. */
  toggleDraftStage(stage: string): void {
    const d = this.get().flowDraft
    if (d === undefined) return
    const order = ['plan', 'design', 'build', 'test', 'deploy', 'maintain']
    const set = new Set(d.stages)
    if (set.has(stage)) set.delete(stage); else set.add(stage)
    this.set({ flowDraft: { ...d, stages: order.filter(s => set.has(s)) } })
  }

  cancelFlow(): void { this.set({ flowDraft: undefined }) }

  async saveFlow(): Promise<void> {
    const d = this.get().flowDraft
    if (d === undefined) return
    this.set({ busy: 'flow', error: undefined })
    try {
      const id = d.isNew ? (d.id.length > 0 ? d.id : d.title.toLowerCase().trim().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')) : d.id
      const existing = this.get().flows?.find(f => f.id === id)
      const { flows } = await rpc<{ flows: Flow[] }>('flows/save', { flow: { ...(existing ?? {}), id, title: d.title, stages: d.stages, guardrails: d.guardrails } })
      this.set({ flows, flowDraft: undefined, busy: undefined, notice: `Saved flow ${d.title}.` })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async deleteFlow(id: string): Promise<void> {
    this.set({ busy: 'flow', error: undefined })
    try {
      const { flows } = await rpc<{ flows: Flow[] }>('flows/delete', { id })
      this.set({ flows, busy: undefined, notice: `Deleted flow ${id}; sessions in it fall back to Full.` })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  /** Workspace / agent-preset DEFAULT position: what a new session starts in. */
  async setDefaultPosition(target: { agentPreset?: string }, change: { flow?: string, stage?: string | null }): Promise<void> {
    this.set({ busy: 'position', error: undefined })
    try {
      await rpc('session/move', { scope: target.agentPreset !== undefined ? 'agent-preset' : 'default', ...(target.agentPreset !== undefined ? { agentPreset: target.agentPreset } : {}), ...change })
      await this.refresh()
      this.set({ busy: undefined })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }
}

export interface ScorecardSnapshot {
  card?: Scorecard
  templates?: TeamTemplate[]
  agentTeamsPresent?: boolean
  peers?: PeerComparison
  status?: Status
  loading: boolean
  error?: string
  notice?: string
  /**
   * A SCOPE confirmation — which rung a preset switch was written to — as
   * opposed to a success event.
   *
   * Kept apart from `notice` because the two deserve different weight. A
   * notice reports that something HAPPENED ("Team X attached", "Saved as an
   * eval fixture at …") and earns the green `.skp-msg.ok` paragraph. This one
   * only restates the scope of the click the user just made; rendered in that
   * same green body text it read as a large success announcement out of
   * keeping with the rest of the panel. It renders as a neutral pill at the
   * top of the popover instead, with the full sentence on hover.
   */
  scopeNote?: { label: string, detail: string }
  busy?: string
  popover: boolean
  compare?: CompareCard[]
  revision: number
}

/**
 * Pill wording per activation scope: a two-word label, the full sentence on
 * hover.
 *
 * A pill has room for a label, not a sentence, so the label carries the scope
 * (the thing the user needs at a glance) and `detail` keeps what the green
 * paragraph used to say — including the "next step" caveat, which is
 * information, not decoration.
 */
const SCOPE_NOTE: Record<ActivateScope, { label: string, detail: string }> = {
  'session': { label: 'session only', detail: 'This session only. Catalog updates on the model\'s next step.' },
  'default': { label: 'workspace default', detail: 'Workspace default updated. Catalog updates on the model\'s next step.' },
  'agent-preset': { label: 'agent-preset default', detail: 'Agent-preset default updated. Catalog updates on the model\'s next step.' },
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
      const [card, status, peers] = await Promise.all([
        rpc<Scorecard>('scorecard', { sessionId: this.sessionId, refresh: refreshFacts }),
        rpc<Status>('status'),
        rpc<PeerComparison>('impact/session', { sessionId: this.sessionId }).catch(() => undefined),
      ])
      this.set({ card, status, loading: false, error: undefined, ...(peers !== undefined ? { peers } : {}) })
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
      // All three answer "which rung did that write to?", so all three are
      // scope confirmations rather than success events — see `scopeNote`.
      this.set({ busy: undefined, popover: false, notice: undefined, scopeNote: SCOPE_NOTE[scope] })
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
      // This is the one action that REVOKES a session scope, so leaving the
      // previous "session only" pill up would state the opposite of what just
      // happened.
      this.set({ busy: undefined, popover: false, scopeNote: undefined })
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

// ------------------------------------------------------------ Phase 7 -----

export interface StageSnapshot {
  card?: PositionCard
  loading: boolean
  error?: string
  busy?: string
  open: boolean
  /** Viewport rect of the control button; the overlay popover anchors to it. */
  anchor?: { x: number, y: number, width: number, height: number }
  /** Index of the step that has keyboard focus while the popover is open. */
  focusStep?: number
  /** The start suggestion was dismissed or accepted in this page; hide the notice. */
  noticeDone: boolean
  /** Practice ids hidden for this session (dismiss). */
  hidden: string[]
  revision: number
}

/**
 * One per session. Owns the position card, the open state and the anchor
 * rect — the control lives in `conversation.input.right` (session scope) and
 * the popover in `shell.overlay` (root scope); they meet here, not in props.
 */
export class StageController extends Store<StageSnapshot> {
  private timer: ReturnType<typeof setTimeout> | undefined
  private visible = 0

  constructor(readonly sessionId: string, private readonly intervalMs = 4000) {
    super({ loading: true, open: false, noticeDone: false, hidden: [], revision: 0 })
  }

  override set(patch: Partial<StageSnapshot>): void {
    super.set({ ...patch, revision: this.get().revision + 1 })
  }

  async refresh(): Promise<void> {
    try {
      const card = await rpc<PositionCard>('session/position', { sessionId: this.sessionId })
      this.set({ card, loading: false, error: undefined })
    } catch (error) {
      this.set({ loading: false, error: (error as Error).message })
    }
  }

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
    ;(timer as { unref?: () => void }).unref?.()
    this.timer = timer
  }

  setAnchor(anchor: StageSnapshot['anchor']): void {
    const cur = this.get().anchor
    if (cur !== undefined && anchor !== undefined && cur.x === anchor.x && cur.y === anchor.y && cur.width === anchor.width && cur.height === anchor.height) return
    this.set({ anchor })
  }

  toggle(open?: boolean): void {
    const next = open ?? !this.get().open
    const card = this.get().card
    const at = card?.stage !== null && card?.stage !== undefined ? card.flow.stages.indexOf(card.stage) : -1
    this.set({ open: next, focusStep: next && at >= 0 ? at : undefined })
  }

  focusStep(index: number): void {
    const n = this.get().card?.flow.stages.length ?? 0
    if (n === 0) return
    this.set({ focusStep: Math.max(0, Math.min(n - 1, index)) })
  }

  /** Move THIS session; `flow` switches flows (stage kept when the new flow has it). */
  async move(change: { flow?: string, stage?: string | null, pin?: string }): Promise<void> {
    this.set({ busy: 'move', error: undefined })
    try {
      await rpc('session/move', { sessionId: this.sessionId, ...change })
      await this.refresh()
      this.set({ busy: undefined, noticeDone: true })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async acceptSuggestion(presetId?: string): Promise<void> {
    this.set({ busy: 'suggest', error: undefined })
    try {
      await rpc('suggestion/accept', { sessionId: this.sessionId, ...(presetId !== undefined ? { presetId } : {}) })
      await this.refresh()
      this.set({ busy: undefined, noticeDone: true })
    } catch (error) {
      this.set({ busy: undefined, error: (error as Error).message })
    }
  }

  async dismissSuggestion(): Promise<void> {
    try { await rpc('suggestion/dismiss', { sessionId: this.sessionId }) } catch { /* advisory */ }
    this.set({ noticeDone: true })
    await this.refresh()
  }

  /**
   * "Fix" on a report line. The client cannot edit the composer's draft
   * programmatically (see knowledge: reference chips lose data), so this is a
   * seam: the host half registers the handler when it has a way to ask the
   * model; until then the button is hidden.
   */
  requestFix?: (practiceId: string, skill: string) => void

  /**
   * The shell's layout service, when the plugin got one. The DEGRADED path for
   * "Open Skills tab": it reveals the column without selecting a tab, so it is
   * used only when `sidebarRight` is missing or refuses. Optional because a
   * shell without it must still render the popover — with neither service the
   * button then just closes it.
   */
  private layout: { openRightbar(track: boolean, fullscreen: boolean): void } | undefined

  attachLayout(layout: { openRightbar(track: boolean, fullscreen: boolean): void } | undefined): void {
    this.layout = layout
  }

  /**
   * The shell's right-sidebar navigation service, when the plugin got one. The
   * PRIMARY path for "Open Skills tab": `openTab` selects the page type and
   * expands the column in one step. Optional — `sidebarRight` and
   * `sidebarRightTabs` are separate services and a shell may provide either.
   */
  private sidebarRight: { openTab(kind: string): void } | undefined

  attachSidebarRight(sidebarRight: { openTab(kind: string): void } | undefined): void {
    this.sidebarRight = sidebarRight
  }

  /**
   * Open THIS plugin's Skills tab in the right sidebar, and close the popover
   * behind it.
   *
   * `sidebarRight.openTab(TAB_KIND)` selects the page type and reveals the
   * column in the same step, so `layout.openRightbar` must NOT also run on the
   * success path — the sidebar owns that intent.
   *
   * `openTab` reports failure by throwing, never by returning a status, and all
   * three of its throw paths are reachable from a click: the service was never
   * provided, no tab type is registered for the kind (registration needs the
   * separate `sidebarRightTabs` service), or no session surface is mounted.
   * Each degrades to `layout.openRightbar(true, false)` — the user must get
   * something visible, because swallowing the failure would reproduce the bug
   * this replaced. With neither service the popover simply closes.
   *
   * No throw escapes the click handler, and the popover closes on every path.
   */
  openSkillsTab(): void {
    try {
      if (this.sidebarRight !== undefined) this.sidebarRight.openTab(TAB_KIND)
      else this.layout?.openRightbar(true, false)
    } catch {
      try { this.layout?.openRightbar(true, false) } catch { /* the shell is beyond help; the popover still closes */ }
    }
    this.toggle(false)
  }

  async dismissPractice(id: string): Promise<void> {
    this.set({ hidden: [...this.get().hidden, id] })
    try { await rpc('practice/dismiss', { sessionId: this.sessionId, id }) } catch { /* advisory */ }
    await this.refresh()
  }
}
