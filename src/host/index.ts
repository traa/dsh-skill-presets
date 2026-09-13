/**
 * dsh-skill-presets host plugin.
 *
 * Wires one skill provider (the active preset + per-agent overlays) into the
 * global skill registry, observes tool results for usage and practice
 * telemetry, contributes a small guardrails prompt block, and exposes reads and
 * actions to the browser and to the model.
 *
 * Provider-neutral by construction: every seam here is a harness seam
 * (`ctx.skills`, `agent/pre-step`, `tools/result`, `tools/pre-execute`,
 * `ctx.systemPrompt`), never a vendor hook or file.
 * @module dsh-skill-presets/host
 */

import type { Context } from '@deepseek-ai/cordis'
import { PracticeTracker } from './practices/index.ts'
import { createProvider, type SkillProviderLike } from './provider.ts'
import { renderGuardrails } from './prompt.ts'
import { detectStage, suggest, type Suggestion } from './stage.ts'
import { Experiments, type ForkLike } from './experiments.ts'
import { Rpc, optStr, str } from './rpc.ts'
import { SkillPresetsService } from './service.ts'
import { resolveWorkbenchFallback } from './store.ts'
import { Telemetry } from './telemetry.ts'
import { buildTools } from './tools.ts'
import type { Overlay, PracticesDoc, Preset, SkillSource } from './types.ts'

/** Plugin config. Everything is optional; the store follows the workbench. */
export interface Config {
  /** Absolute workbench root override. Normally unset. */
  root?: string
}

/**
 * Cordis re-runs `apply` once every listed service exists. `skills` is the
 * registry we contribute to; `tools` is where usage is observed and our own
 * tools live. Both are host services in every shipped composition.
 */
export const inject = ['tools', 'skills']

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillPresets: SkillPresetsService
  }
}

/** Minimal agent face this plugin reads. */
interface AgentLike {
  readonly session: { readonly id: string, readonly header: { readonly cwd?: string, readonly agentPreset?: string } }
  readonly ctx: Context
}

/** The identity the active-preset resolution keys on. */
function sessionOf(agent: AgentLike | undefined): { id?: string, agentPreset?: string } | undefined {
  if (agent?.session?.id === undefined) return undefined
  return { id: agent.session.id, ...(agent.session.header.agentPreset !== undefined ? { agentPreset: agent.session.header.agentPreset } : {}) }
}

/** Whether `team_delegate` is visible to an agent — the seam that says "a team is attached". */
function teamAttachedFor(ctx: Context, agent: unknown): boolean {
  if (typeof agent !== 'object' || agent === null) return false
  try {
    const tools = ctx.get('tools') as { get(name: string, scope?: unknown): unknown } | undefined
    return tools?.get('team_delegate', agent) !== undefined
  } catch {
    return false
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const log = (message: string): void => { ctx.logger?.info?.(`skill-presets: ${message}`) }
  const warn = (message: string): void => { ctx.logger?.warn?.(`skill-presets: ${message}`) }

  const root = (): string => {
    if (config.root !== undefined) return config.root
    const workbench = ctx.get('workbench') as { root(): string } | undefined
    if (workbench !== undefined) {
      try { return workbench.root() } catch { /* fall through */ }
    }
    return resolveWorkbenchFallback()
  }

  const service = new SkillPresetsService({ root, log: warn })
  ctx.provide('skillPresets', service)
  const telemetry = new Telemetry(service.paths(), warn)

  // ------------------------------------------------------------ practices --
  const tracker = new PracticeTracker({
    practices: async () => await service.practices(),
    createdWorktrees: async () => await service.createdWorktrees(),
    onWorktreeCreated: (sessionId, path) => {
      void service.rememberWorktree(path, sessionId)
      telemetry.record(sessionId, { kind: 'worktree', action: 'created', path })
    },
    activeStage: async (sessionId, agentPreset) => await service.activeStage({ id: sessionId, ...(agentPreset !== undefined ? { agentPreset } : {}) }),
    onResult: (sessionId, result) => {
      telemetry.record(sessionId, { kind: 'practice', id: result.id, status: result.status, evidence: [...result.evidence] })
    },
    log: warn,
  })

  // -------------------------------------------------------------- provider --
  // Per-agent overlay conditions are cached so `list()` stays cheap, and a
  // flip calls `invalidate()` so the catalog is republished on the next step.
  const overlayState = new Map<string, string>()
  let invalidate: (() => void) | undefined
  const provider: SkillProviderLike = createProvider({
    setFor: async (scope, cwd) => {
      try {
        const agent = scope as AgentLike | undefined
        const sessionId = agent?.session?.id
        const teamAttached = teamAttachedFor(ctx, scope)
        const facts = sessionId !== undefined ? tracker.results(sessionId)?.facts : undefined
        let inGitRepo = facts?.inRepo === true
        if (facts === undefined && sessionId !== undefined && cwd !== undefined) {
          // First look: read facts now so the git overlay applies from step one.
          tracker.session(sessionId, cwd, agent?.session.header.agentPreset)
          await tracker.refresh(sessionId)
          inGitRepo = tracker.results(sessionId)?.facts?.inRepo === true
        }
        const set = await service.setFor({ teamAttached, inGitRepo }, sessionOf(agent))
        if (sessionId !== undefined) {
          const key = set.overlays.join(',')
          const previous = overlayState.get(sessionId)
          if (previous !== undefined && previous !== key) {
            for (const id of set.overlays.filter(o => !previous.split(',').includes(o))) telemetry.record(sessionId, { kind: 'overlay', id, active: true })
            for (const id of previous.split(',').filter(o => o.length > 0 && !set.overlays.includes(o))) telemetry.record(sessionId, { kind: 'overlay', id, active: false })
          }
          overlayState.set(sessionId, key)
        }
        return { skills: set.skills, complete: true }
      } catch (error) {
        warn(`provider list failed: ${(error as Error).message}`)
        return { skills: [], complete: false }
      }
    },
  })
  const skills = ctx.get('skills') as {
    registerProvider(create: (control: { signal: AbortSignal, invalidate: () => void }) => SkillProviderLike): () => void
  } | undefined
  if (skills !== undefined) {
    ctx.effect(() => skills.registerProvider((control) => {
      invalidate = control.invalidate
      return provider
    }), 'skill-presets: provider')
    ctx.effect(() => service.onChange(() => { invalidate?.() }), 'skill-presets: invalidate on change')
  } else {
    warn('skill registry unavailable; presets are not exposed to the model')
  }

  // ------------------------------------------------- per-agent observation --
  // Which agents we have seen, with the set offered at their last step, so
  // `offered` telemetry is written once per change rather than every step.
  const offeredState = new Map<string, string>()
  const lastPreset = new Map<string, string | null>()

  ctx.on('agent/created' as never, ((payload: { agent: AgentLike }) => {
    const agent = payload.agent
    const sessionId = agent.session.id
    tracker.session(sessionId, agent.session.header.cwd, agent.session.header.agentPreset)
    telemetry.record(sessionId, {
      kind: 'session',
      ...(agent.session.header.cwd !== undefined ? { cwd: agent.session.header.cwd } : {}),
      ...(agent.session.header.agentPreset !== undefined ? { agentPreset: agent.session.header.agentPreset } : {}),
    })
  }) as never)

  // Auto-clean: merged + clean worktrees of the repo a session worked in are
  // removed when the session ends, and once an hour for every live repo.
  const autoClean = async (cwd: string, sessionId?: string): Promise<void> => {
    try {
      if (!(await service.practices()).autoCleanWorktrees) return
      const result = await service.cleanupWorktrees(cwd)
      for (const r of result.removed) {
        log(`removed merged worktree ${r.path}${r.branch !== undefined ? ` (branch ${r.branch})` : ''}: ${r.reason}`)
        if (sessionId !== undefined) telemetry.record(sessionId, { kind: 'worktree', action: 'removed', path: r.path, ...(r.branch !== undefined ? { branch: r.branch } : {}), reason: r.reason })
      }
      for (const e of result.errors) warn(`worktree cleanup ${e.path}: ${e.error}`)
    } catch (error) {
      warn(`worktree cleanup failed: ${(error as Error).message}`)
    }
  }
  const hourly = setInterval(() => {
    const roots = new Set<string>()
    for (const id of tracker.live()) { const top = tracker.results(id)?.facts?.topLevel; if (top !== undefined) roots.add(top) }
    for (const root of roots) void autoClean(root)
  }, 3_600_000)
  hourly.unref?.()
  ctx.effect(() => () => clearInterval(hourly), 'skill-presets: hourly worktree sweep')

  ctx.on('agent/disposed' as never, ((payload: { agent: AgentLike }) => {
    const sessionId = payload.agent.session.id
    const top = tracker.results(sessionId)?.facts?.topLevel
    void tracker.onDisposed(sessionId).then(async () => {
      await service.sessionDisposed(sessionId)
      if (top !== undefined) await autoClean(top, sessionId)
      offeredState.delete(sessionId)
      overlayState.delete(sessionId)
      lastPreset.delete(sessionId)
      await telemetry.flush()
      await telemetry.rebuildRollup()
    })
  }) as never)

  ctx.on('agent/pre-step' as never, (async (
    payload: { agent: AgentLike, turn: number, signal: AbortSignal },
    next: () => Promise<unknown>,
  ) => {
    const decision = await next()
    try {
      const agent = payload.agent
      const sessionId = agent.session.id
      const teamAttached = teamAttachedFor(ctx, agent)
      await tracker.onPreStep(sessionId, payload.turn, teamAttached, agent.session.header.cwd, agent.session.header.agentPreset)
      const facts = tracker.results(sessionId)?.facts
      const set = await service.setFor({ teamAttached, inGitRepo: facts?.inRepo === true }, sessionOf(agent))
      const activeId = set.preset?.id ?? null
      const key = `${activeId ?? ''}|${set.overlays.join(',')}|${set.skills.map(s => s.name).join(',')}`
      if (offeredState.get(sessionId) !== key) {
        offeredState.set(sessionId, key)
        telemetry.record(sessionId, { kind: 'offered', preset: activeId, overlays: set.overlays, skills: set.skills.map(s => s.name) })
      }
      const previous = lastPreset.get(sessionId)
      if (previous !== undefined && previous !== activeId) {
        const doc = await service.active()
        const own = doc.sessions[sessionId]
        telemetry.record(sessionId, { kind: 'preset-switch', from: previous, to: activeId, by: own?.by ?? doc.by, scope: own !== undefined ? 'session' : 'default' })
      }
      lastPreset.set(sessionId, activeId)
    } catch (error) {
      warn(`pre-step observation failed: ${(error as Error).message}`)
    }
    return decision
  }) as never)

  // Provider/model split for Insights — read from the call config, never a vendor header.
  const modelSeen = new Map<string, string>()
  ctx.on('agent/request' as never, (async (
    payload: { agent: AgentLike },
    next: () => Promise<{ provider?: string, model?: string }>,
  ) => {
    const cfg = await next()
    try {
      const sessionId = payload.agent.session.id
      const key = `${cfg.provider ?? '?'}/${cfg.model ?? '?'}`
      if (modelSeen.get(sessionId) !== key) {
        modelSeen.set(sessionId, key)
        telemetry.record(sessionId, { kind: 'provider', provider: cfg.provider ?? '?', model: cfg.model ?? '?' })
      }
    } catch { /* never affect the request */ }
    return cfg
  }) as never)

  ctx.on('tools/result' as never, ((
    exec: { name: string, arguments: unknown, agent?: AgentLike },
    result: { isError: boolean, content?: { type: string, text?: string }[], error?: { message?: string } },
  ) => {
    const sessionId = exec.agent?.session.id
    if (sessionId === undefined) return
    try {
      const args = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
      const turn = tracker.session(sessionId).currentTurn
      const head = result.content?.find(b => b.type === 'text')?.text?.split('\n')[0]?.slice(0, 300)
      const target = typeof args.file_path === 'string' ? args.file_path
        : typeof args.path === 'string' ? args.path
          : typeof args.command === 'string' ? args.command
            : typeof args.name === 'string' ? args.name : undefined
      if (exec.name === 'skill') {
        const name = typeof args.name === 'string' ? args.name : '?'
        const message = result.error?.message ?? ''
        const unknown = result.isError && /unknown|no longer available|not available/iu.test(message)
        const chars = result.content?.reduce((n, b) => n + (b.text?.length ?? 0), 0) ?? 0
        telemetry.record(sessionId, { kind: 'loaded', name, turn, ok: !result.isError, ...(unknown ? { unknown: true } : {}), chars })
      }
      void tracker.onToolResult(sessionId, {
        t: new Date().toISOString(),
        turn,
        name: exec.name,
        ...(target !== undefined ? { target } : {}),
        isError: result.isError,
        ...(head !== undefined ? { resultHead: head } : {}),
      }).then((outcome) => {
        // One event per drifting path; the guardrails prompt block carries the
        // advisory to the model on its next step (no injected message needed).
        if (outcome.drift !== undefined) telemetry.record(sessionId, { kind: 'drift', path: outcome.drift })
      })
    } catch (error) {
      warn(`tools/result observation failed: ${(error as Error).message}`)
    }
  }) as never)

  // ------------------------------------------------------------ hard gates --
  // Off unless a practice is in `hard` mode. Denial reasons name the skill to
  // load. Advisory never denies.
  ctx.on('tools/pre-execute' as never, (async (
    exec: { name: string, arguments: unknown, agent?: AgentLike },
    next: () => Promise<{ kind: string }>,
  ) => {
    const sessionId = exec.agent?.session.id
    if (sessionId === undefined) return await next()
    let doc: PracticesDoc
    try { doc = await service.practices() } catch { return await next() }
    const hard = new Set(doc.practices.filter(p => p.mode === 'hard').map(p => p.id))
    if (hard.size === 0) return await next()
    const current = tracker.results(sessionId)
    const args = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
    const mutating = ['write', 'edit', 'Write', 'Edit', 'multi_edit'].includes(exec.name)
      || (['bash', 'Bash'].includes(exec.name) && typeof args.command === 'string' && /\b(?:rm|mv|cp|sed -i|>|git (?:commit|add|push|reset))\b/u.test(args.command))
    const deny = (reason: string): { kind: 'deny', reason: string } => {
      telemetry.record(sessionId, { kind: 'denied', tool: exec.name, reason })
      return { kind: 'deny', reason }
    }
    if (mutating && hard.has('worktree')) {
      const r = current?.results.find(x => x.id === 'worktree')
      const facts = current?.facts
      if (facts?.inRepo === true && facts.isWorktree === false && facts.branch !== undefined && doc.protectedBranches.includes(facts.branch)) {
        return deny(`practice "Work in a worktree" is enforced: you are on protected branch ${facts.branch} in the primary checkout. Load the \`worktree-first\` skill and create a worktree before editing.${r?.evidence[0] !== undefined ? ` (${r.evidence[0]})` : ''}`)
      }
    }
    if (mutating && hard.has('conductor') && current?.teamAttached === true) {
      return deny('practice "Follow the conductor protocol" is enforced: a team is attached, so file changes belong to a teammate. Load the `conductor-protocol` skill and use `team_delegate`.')
    }
    if (mutating && hard.has('plan-before-code') && ['write', 'edit', 'Write', 'Edit'].includes(exec.name)) {
      const stage = await service.activeStage(sessionOf(exec.agent))
      const facts = current?.facts
      if (stage === 'build' && facts?.inRepo === true && !facts.artifacts.some(a => a.endsWith('plan.md'))) {
        return deny('practice "Plan before code" is enforced: no plan.md exists in this repository. Load the `sdlc-stage-handoff` skill and commit a plan first.')
      }
    }
    if (hard.has('plan-drift') && ['write', 'edit', 'Write', 'Edit'].includes(exec.name)) {
      const r = current?.results.find(x => x.id === 'plan-drift')
      const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined
      if (r?.status === 'amber' && path !== undefined && !/(?:^|\/)(?:docs\/sdlc\/.*\.md|plan\.md)$/u.test(path)) {
        return deny(`practice "Keep plan.md in step with the diff" is enforced: ${r.evidence[0]}. Update plan.md first (skill \`sdlc-stage-handoff\`), then continue.`)
      }
    }
    if (exec.name === 'skill' && doc.strictSkills) {
      const name = typeof args.name === 'string' ? args.name : ''
      const set = await service.setFor({ teamAttached: current?.teamAttached === true, inGitRepo: current?.facts?.inRepo === true }, sessionOf(exec.agent))
      if (!set.skills.some(s => s.name === name)) {
        const active = set.preset
        return deny(`skill "${name}" is not in the active preset${active !== undefined ? ` "${active.id}"` : ''}. Ask the user to switch presets or add it.`)
      }
    }
    return await next()
  }) as never)

  // ----------------------------------------------------------------- prompt --
  const systemPrompt = ctx.get('systemPrompt') as { context(entry: { name: string, order: number, text: (c: { scope?: unknown, agent?: unknown }) => string }): () => void } | undefined
  if (systemPrompt !== undefined) {
    // Prompt assembly is synchronous; render from a cache the pre-step keeps warm.
    const promptCache = new Map<string, string>()
    const refreshPrompt = async (agent: AgentLike): Promise<void> => {
      const sessionId = agent.session.id
      try {
        const teamAttached = teamAttachedFor(ctx, agent)
        const score = tracker.results(sessionId)
        const set = await service.setFor({ teamAttached, inGitRepo: score?.facts?.inRepo === true }, sessionOf(agent))
        const preset = set.preset
        promptCache.set(sessionId, renderGuardrails({
          ...(preset !== undefined ? { preset } : {}),
          skills: set.skills,
          overlays: set.overlays,
          practices: score?.results ?? [],
          ...(score?.facts !== undefined ? { artifacts: score.facts.artifacts } : {}),
        }))
      } catch {
        promptCache.delete(sessionId)
      }
    }
    ctx.on('agent/pre-step' as never, (async (payload: { agent: AgentLike }, next: () => Promise<unknown>) => {
      const decision = await next()
      await refreshPrompt(payload.agent)
      return decision
    }) as never)
    ctx.on('agent/disposed' as never, ((payload: { agent: AgentLike }) => { promptCache.delete(payload.agent.session.id) }) as never)
    ctx.effect(() => systemPrompt.context({
      name: 'skill-presets:guardrails',
      order: 70,
      text: (c) => {
        const agent = (c.agent ?? c.scope) as AgentLike | undefined
        if (agent?.session?.id === undefined) return ''
        return promptCache.get(agent.session.id) ?? ''
      },
    }), 'skill-presets: prompt')
  }

  // ------------------------------------------------------------ suggestion --
  // First time a given transition was suggested per session, for time-to-accept.
  const suggestedAt = new Map<string, { key: string, at: number }>()
  const suggestionFor = async (sessionId: string): Promise<{ guess: ReturnType<typeof detectStage>, suggestion?: Suggestion }> => {
    const state = tracker.has(sessionId) ? tracker.session(sessionId) : undefined
    const score = tracker.results(sessionId)
    const guess = detectStage(score?.facts, state?.calls.slice(-12) ?? [])
    const identity = { id: sessionId, ...(state?.agentPreset !== undefined ? { agentPreset: state.agentPreset } : {}) }
    const activeStage = await service.activeStage(identity)
    const suggestion = suggest(guess, activeStage, await service.presetsByStage(), await service.suggestions())
    if (suggestion !== undefined) {
      const key = `${suggestion.from ?? 'none'}→${suggestion.to}`
      if (suggestedAt.get(sessionId)?.key !== key) {
        suggestedAt.set(sessionId, { key, at: Date.now() })
        telemetry.record(sessionId, { kind: 'suggested', from: suggestion.from, to: suggestion.to, confidence: suggestion.confidence })
      }
    }
    return { guess, ...(suggestion !== undefined ? { suggestion } : {}) }
  }
  const elapsed = (sessionId: string): number => {
    const at = suggestedAt.get(sessionId)?.at
    return at === undefined ? 0 : Date.now() - at
  }

  // ------------------------------------------------------------------ RPC --
  const rpc = new Rpc(ctx)
  rpc.handle('status', async () => await service.status())
  rpc.handle('library/list', async () => ({ lock: await service.library.lock(), sources: await service.sources() }))
  rpc.handle('library/check', async (args) => await service.check(Array.isArray(args.sources) ? args.sources as string[] : undefined))
  rpc.handle('library/install', async (args) => ({
    job: service.startSync(Array.isArray(args.sources) ? args.sources as string[] : undefined, Array.isArray(args.dirs) ? args.dirs as string[] : undefined),
  }))
  rpc.handle('library/update', async (args) => ({ job: service.startSync(Array.isArray(args.sources) ? args.sources as string[] : undefined) }))
  rpc.handle('library/job', async args => service.job(str(args, 'id')) ?? { error: 'unknown job' })
  rpc.handle('library/remove', async (args) => { await service.removeSkill(str(args, 'ref')); return { ok: true } })
  rpc.handle('library/skill', async args => await service.skillDetail(str(args, 'ref')))
  rpc.handle('sources/save', async (args) => { await service.saveSources(args.sources as SkillSource[]); return { ok: true } })
  rpc.handle('presets/save', async args => await service.savePreset(args.preset as Preset))
  rpc.handle('presets/delete', async (args) => { await service.deletePreset(str(args, 'id')); return { ok: true } })
  rpc.handle('presets/duplicate', async args => await service.duplicatePreset(str(args, 'id'), str(args, 'newId'), optStr(args, 'title')))
  rpc.handle('presets/activate', async (args) => {
    const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : null
    const sessionId = optStr(args, 'sessionId')
    const scope = args.scope === 'session' || args.scope === 'default' || args.scope === 'agent-preset' ? args.scope : undefined
    const agentPreset = optStr(args, 'agentPreset') ?? (sessionId !== undefined ? tracker.session(sessionId).agentPreset : undefined)
    const change = await service.activate(id, 'ui', {
      ...(scope !== undefined ? { scope } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(agentPreset !== undefined ? { agentPreset } : {}),
    })
    // The switch is observed at each session's next pre-step; a session that never
    // steps again gets it recorded here so Insights still sees the intent.
    if (change.scope === 'session' && sessionId !== undefined) {
      telemetry.record(sessionId, { kind: 'preset-switch', from: change.from, to: change.to, by: 'ui', scope: 'session' })
    }
    return { ...change, status: await service.status() }
  })
  rpc.handle('suggestion/accept', async (args) => {
    const sessionId = str(args, 'sessionId')
    const { suggestion } = await suggestionFor(sessionId)
    if (suggestion === undefined) return { ok: false, message: 'nothing to accept' }
    await service.acceptSuggestion(suggestion.from, suggestion.to)
    telemetry.record(sessionId, { kind: 'suggestion-accepted', from: suggestion.from, to: suggestion.to, afterMs: elapsed(sessionId) })
    const presetId = optStr(args, 'presetId') ?? suggestion.presetId
    if (presetId === undefined) return { ok: false, message: `several presets own the ${suggestion.to} stage; pick one` }
    const state = tracker.has(sessionId) ? tracker.session(sessionId) : undefined
    const change = await service.activate(presetId, 'ui', { sessionId, ...(state?.agentPreset !== undefined ? { agentPreset: state.agentPreset } : {}) })
    suggestedAt.delete(sessionId)
    return { ok: true, ...change }
  })
  rpc.handle('suggestion/dismiss', async (args) => {
    const sessionId = str(args, 'sessionId')
    const { suggestion } = await suggestionFor(sessionId)
    if (suggestion === undefined) return { ok: false }
    const doc = await service.dismissSuggestion(suggestion.from, suggestion.to)
    telemetry.record(sessionId, { kind: 'suggestion-dismissed', from: suggestion.from, to: suggestion.to, afterMs: elapsed(sessionId) })
    suggestedAt.delete(sessionId)
    return { ok: true, muted: (doc.dismissed[`${suggestion.from ?? 'none'}→${suggestion.to}`]?.count ?? 0) >= 3 }
  })
  // ---- experiments: fork this session under another preset
  const experiments = new Experiments(() => service.paths())
  rpc.handle('experiments/fork', async (args) => {
    const parent = str(args, 'sessionId')
    const childPreset = typeof args.preset === 'string' && args.preset.length > 0 ? args.preset : null
    const controller = ctx.get('sessionController') as ForkLike | undefined
    if (controller === undefined || typeof controller.fork !== 'function') {
      return { ok: false, message: 'session forking is not available in this composition; fork from the session menu, then pick the preset in the new session\'s chip' }
    }
    const state = tracker.has(parent) ? tracker.session(parent) : undefined
    const parentPreset = (await service.activeFor({ id: parent, ...(state?.agentPreset !== undefined ? { agentPreset: state.agentPreset } : {}) })).preset
    try {
      const experiment = await experiments.fork(
        controller, parent, parentPreset, childPreset,
        async (child) => { await service.activate(childPreset, 'experiment', { sessionId: child, ...(state?.agentPreset !== undefined ? { agentPreset: state.agentPreset } : {}) }) },
        { ...(typeof args.atSeq === 'number' ? { atSeq: args.atSeq } : {}), ...(optStr(args, 'note') !== undefined ? { note: optStr(args, 'note') } : {}) },
      )
      return { ok: true, experiment }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'fork failed' }
    }
  })
  rpc.handle('experiments/list', async args => await (optStr(args, 'sessionId') !== undefined ? experiments.forSession(str(args, 'sessionId')) : experiments.list()))
  rpc.handle('experiments/compare', async (args) => {
    const ids = Array.isArray(args.sessionIds) ? (args.sessionIds as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const cards = []
    for (const sessionId of ids) {
      const score = tracker.results(sessionId)
      const summary = await telemetry.summary(sessionId)
      cards.push({
        sessionId,
        live: score !== undefined,
        preset: summary.preset,
        practices: score?.results ?? summary.practices,
        loaded: Object.keys(summary.loaded).length,
        offered: summary.offered.length,
        loads: summary.loads.length,
        turns: Math.max(0, ...summary.loads.map(l => l.turn)),
        rating: summary.rating,
        denied: summary.denied,
        drift: summary.drift.length,
        model: summary.model,
      })
    }
    return { cards }
  })
  // ---- worktrees
  rpc.handle('worktrees/list', async (args) => {
    const sessionId = optStr(args, 'sessionId')
    const cwd = optStr(args, 'cwd') ?? (sessionId !== undefined ? tracker.results(sessionId)?.facts?.topLevel : undefined)
    if (cwd === undefined) return { defaultBranch: 'main', worktrees: [], note: 'no repository for this session yet' }
    const scan = await service.worktrees(cwd)
    const { classify } = await import('./practices/worktrees.ts')
    return { ...scan, worktrees: scan.worktrees.map(w => ({ ...w, verdict: classify(w, scan.defaultBranch) })) }
  })
  rpc.handle('worktrees/cleanup', async (args) => {
    const sessionId = optStr(args, 'sessionId')
    const cwd = optStr(args, 'cwd') ?? (sessionId !== undefined ? tracker.results(sessionId)?.facts?.topLevel : undefined)
    if (cwd === undefined) return { ok: false, message: 'no repository for this session yet' }
    const result = await service.cleanupWorktrees(cwd, {
      ...(args.dryRun === true ? { dryRun: true } : {}),
      ...(Array.isArray(args.only) ? { only: (args.only as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
    })
    if (sessionId !== undefined) {
      for (const r of result.removed) telemetry.record(sessionId, { kind: 'worktree', action: 'removed', path: r.path, ...(r.branch !== undefined ? { branch: r.branch } : {}), reason: r.reason })
      tracker.invalidateWorktrees(sessionId)
    }
    return { ok: true, result }
  })
  rpc.handle('presets/clear-session', async (args) => { await service.clearSession(str(args, 'sessionId')); return { ok: true } })
  rpc.handle('overlays/save', async (args) => { await service.saveOverlays(args.overlays as Overlay[]); return { ok: true } })
  rpc.handle('practices/save', async args => await service.savePractices(args.practices as PracticesDoc))
  rpc.handle('usage/session', async args => await telemetry.summary(str(args, 'sessionId')))
  rpc.handle('usage/rollup', async args => args.rebuild === true ? await telemetry.rebuildRollup() : await telemetry.rollup())
  rpc.handle('usage/recent', async args => await telemetry.recentSessions(typeof args.limit === 'number' ? args.limit : 50))
  rpc.handle('usage/rate', async (args) => {
    const sessionId = str(args, 'sessionId')
    const rating = args.rating === -1 || args.rating === 0 || args.rating === 1 ? args.rating : 0
    const state = tracker.has(sessionId) ? tracker.session(sessionId) : undefined
    telemetry.record(sessionId, { kind: 'rated', preset: (await service.activeFor({ id: sessionId, ...(state?.agentPreset !== undefined ? { agentPreset: state.agentPreset } : {}) })).preset, rating, ...(optStr(args, 'note') !== undefined ? { note: optStr(args, 'note') } : {}) })
    await telemetry.flush()
    return { ok: true }
  })
  rpc.handle('scorecard', async (args) => {
    const sessionId = str(args, 'sessionId')
    if (args.refresh === true) await tracker.refresh(sessionId)
    const score = tracker.results(sessionId)
    const summary = await telemetry.summary(sessionId)
    const active = await service.active()
    const state = tracker.has(sessionId) ? tracker.session(sessionId) : undefined
    const identity = { id: sessionId, ...(state?.agentPreset !== undefined ? { agentPreset: state.agentPreset } : {}) }
    const set = await service.setFor({ teamAttached: score?.teamAttached === true, inGitRepo: score?.facts?.inRepo === true }, identity)
    const resolved = await service.activeFor(identity)
    const { guess, suggestion } = await suggestionFor(sessionId)
    const related = await experiments.forSession(sessionId)
    const wt = tracker.worktreesOf(sessionId)
    const { classify } = await import('./practices/worktrees.ts')
    return {
      sessionId,
      live: score !== undefined,
      experiments: related,
      ...(wt !== undefined ? { worktrees: { defaultBranch: wt.defaultBranch, list: wt.list.map(w => ({ ...w, verdict: classify(w, wt.defaultBranch) })) } } : {}),
      stageGuess: guess,
      ...(suggestion !== undefined ? { suggestion } : {}),
      active,
      activePreset: set.preset,
      /** Which rung answered: session / agent-preset / default. */
      activeSource: resolved.source,
      agentPreset: state?.agentPreset,
      overlays: set.overlays,
      offered: set.skills.map(s => ({ name: s.name, via: s.via === 'preset' ? 'preset' : `overlay:${s.via.overlay}`, description: s.description })),
      unresolved: set.resolution.unresolved,
      practices: score?.results ?? summary.practices,
      worst: score?.worst ?? 'n/a',
      facts: score?.facts,
      summary,
    }
  })
  rpc.install()

  // ---------------------------------------------------------------- tools --
  const tools = ctx.get('tools') as { register(definition: unknown): () => void } | undefined
  if (tools === undefined) {
    warn('tool registry unavailable; status tools not registered')
  } else {
    for (const tool of buildTools({ service, tracker, telemetry, teamAttached: agent => teamAttachedFor(ctx, agent) })) {
      ctx.effect(() => tools.register(tool), 'skill-presets: tool')
    }
  }

  // Kick the bootstrap so first-step latency is not paid by the model.
  void service.ensure().then(() => log(`store at ${service.paths().skills}`))
}
