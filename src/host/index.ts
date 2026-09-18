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
import { ReviewGate, modeFrom } from './practices/reviewgate.ts'
import { createProvider, type SkillProviderLike } from './provider.ts'
import { renderGuardrails } from './prompt.ts'
import { detectStage, shouldSuggest, suggest, type Suggestion } from './stage.ts'
import { annotateRelevance, gateFor, nextStage, positionOf, type Flow } from './flows.ts'
import type { Stage } from './types.ts'
import { Experiments, aggregateExperiments, type ForkLike } from './experiments.ts'
import { StrictCatalog } from './strict.ts'
import { TeamReader, type AgentTeamsLike } from './teams.ts'
import { loadTemplates, toBlueprintInput } from './templates.ts'
import { KnowledgeBridge } from './knowledge.ts'
import { pruningReport } from './pruning.ts'
import { applyImport, exportBundle, planImport, readLocalSkill, validateBundle } from './bundle.ts'
import { diagnose, probe, worstSeverity } from './doctor.ts'
import { presetImpact, sessionVsPeers, skillImpact } from './impact.ts'
import { lintLibrary } from './lint.ts'
import { orphanSkills, suggestPlacement } from './placement.ts'
import { createStrictPreset, listStrictPresets, planStrictPreset, shippedPresetsDir } from './strictpreset.ts'
import { discoverSkills, GithubClient } from './github.ts'
import { renderHookFile } from './hooks.ts'
import { runEvals, saveFixture } from './evals.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideWorktreeGate, exemptionHint } from './practices/gate.ts'
import { mutatesFiles } from './practices/detectors.ts'
import { Rpc, optStr, str } from './rpc.ts'
import { SkillPresetsService } from './service.ts'
import { resolveWorkbenchFallback } from './store.ts'
import { Telemetry, practiceDeltaAround } from './telemetry.ts'
import { buildTools } from './tools.ts'
import type { Overlay, PendingCall, PracticesDoc, Preset, SkillSource } from './types.ts'

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

/**
 * Read one pending tool call into the tool-shape-neutral `PendingCall` the
 * gates take.
 *
 * WHY A HELPER: the pre-execute handler used to reach into `arguments` three
 * different ways in three different branches — `args.file_path` here,
 * `args.path` there, `args.command` in a third — so whether a practice saw the
 * path at all depended on which branch happened to read it. Tool arguments are
 * a provider-shaped surface (`file_path` in one dialect, `path` in another);
 * that mapping belongs in ONE place, stated once, or the gates quietly enforce
 * different things.
 */
function pendingCallOf(name: string, args: Record<string, unknown>): PendingCall {
  const filePath = typeof args.file_path === 'string' ? args.file_path
    : typeof args.path === 'string' ? args.path
      : undefined
  return {
    name,
    ...(filePath !== undefined ? { filePath } : {}),
    ...(typeof args.command === 'string' ? { command: args.command } : {}),
  }
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

  /** When THIS host process loaded the plugin — the reference for "server older than build". */
  const startedAt = Date.now()
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

  /**
   * The review gate. Unlike the practices above it can REFUSE a tool call, so
   * it is deliberately independent of them: it holds its own memory-only state,
   * decides synchronously, and degrades to allow. See `practices/reviewgate.ts`.
   */
  const reviewGate = new ReviewGate(modeFrom(process.env), warn)

  /** The registry's invalidate control, set when the provider registers. */
  let invalidate: (() => void) | undefined

  // ----------------------------------------------------------------- teams --
  // Service first (dsh-agent-teams ≥ the ctx.agentTeams PR), tool visibility else.
  const teams = new TeamReader(() => ctx.get('agentTeams') as AgentTeamsLike | undefined, agent => teamAttachedFor(ctx, agent))
  ctx.inject(['agentTeams'], (teamsCtx) => {
    const service = (teamsCtx as unknown as { agentTeams: AgentTeamsLike }).agentTeams
    teamsCtx.effect(() => service.onAttachmentChange((sessionId) => {
      teams.invalidate(sessionId)
      invalidate?.() // the team-attached overlay may have flipped
    }), 'skill-presets: attachment listener')
  })

  // ---------------------------------------------------------------- strict --
  // With `strictSkills`, the session's inherited catalog is narrowed to the
  // resolved set through `agent.ctx.skills.restrict()` when the harness has it.
  const strict = new StrictCatalog(warn)
  ctx.effect(() => () => strict.releaseAll(), 'skill-presets: strict catalog')
  const strictSupport = new Map<string, boolean>()
  const applyStrict = async (agent: AgentLike, names: readonly string[]): Promise<void> => {
    const sessionId = agent.session.id
    const doc = await service.practices()
    if (!doc.strictSkills) { strict.release(sessionId); return }
    const outcome = strict.apply(sessionId, agent.ctx, names)
    strictSupport.set(sessionId, outcome !== 'unsupported')
  }

  // -------------------------------------------------------------- provider --
  // Per-agent overlay conditions are cached so `list()` stays cheap, and a
  // flip calls `invalidate()` so the catalog is republished on the next step.
  const overlayState = new Map<string, string>()
  const provider: SkillProviderLike = createProvider({
    setFor: async (scope, cwd) => {
      try {
        const agent = scope as AgentLike | undefined
        const sessionId = agent?.session?.id
        const teamAttached = sessionId !== undefined ? (await teams.view(sessionId, scope)).attached : teamAttachedFor(ctx, scope)
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

  /** Rendered guardrails text per session (filled by the prompt block below); read by the why-trace. */
  const promptCacheRef = new Map<string, string>()

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
    strict.release(sessionId)
    strictSupport.delete(sessionId)
    // Obligations are memory-only and die with the session: nothing persisted
    // can wedge a later one, and a restart is always a clean slate.
    reviewGate.forget(sessionId)
    void tracker.onDisposed(sessionId).then(async () => {
      await service.sessionDisposed(sessionId)
      if (top !== undefined) await autoClean(top, sessionId)
      offeredState.delete(sessionId)
      overlayState.delete(sessionId)
      lastPreset.delete(sessionId)
      for (const key of [...userLines.keys()]) if (key.startsWith(`${sessionId}#`)) userLines.delete(key)
      await telemetry.flush()
      await telemetry.rebuildRollup()
    })
  }) as never)

  /** First user line per session+turn, for the why-trace on skill loads. */
  const userLines = new Map<string, string>()
  const userLineOf = (messages: unknown): string | undefined => {
    if (!Array.isArray(messages)) return undefined
    for (const m of messages as { source?: { kind?: string }, content?: unknown }[]) {
      if (m?.source?.kind !== 'user') continue
      const blocks = Array.isArray(m.content) ? m.content as { type?: string, text?: string }[] : []
      const text = blocks.find(b => b.type === 'text' && typeof b.text === 'string')?.text
      if (text !== undefined) return text.split('\n').find(l => l.trim().length > 0)?.trim().slice(0, 120)
    }
    return undefined
  }
  ctx.on('agent/pre-step' as never, (async (
    payload: { agent: AgentLike, turn: number, signal: AbortSignal, messages?: unknown },
    next: () => Promise<unknown>,
  ) => {
    const decision = await next()
    try {
      const agent = payload.agent
      const sessionId = agent.session.id
      const line = userLineOf(payload.messages)
      if (line !== undefined) userLines.set(`${sessionId}#${payload.turn}`, line)
      const team = await teams.view(sessionId, agent)
      const teamAttached = team.attached
      await tracker.onPreStep(sessionId, payload.turn, teamAttached, agent.session.header.cwd, agent.session.header.agentPreset, team.approvalRequired)
      const facts = tracker.results(sessionId)?.facts
      const set = await service.setFor({ teamAttached, inGitRepo: facts?.inRepo === true }, sessionOf(agent))
      await applyStrict(agent, set.skills.map(s => s.name))
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

  // The review reminder. `tools/post-execute` is the ONLY seam that can put a
  // message in front of the model at the moment a tool returns: its
  // `PostToolDecision.additionalContexts` is drained by the agent loop when the
  // result is committed, so the directive is delivered with the next request —
  // PR number in hand, no state to remember. `tools/result` cannot do this; it
  // is an observation with no return path.
  //
  // CONTAINMENT: this is waterfall middleware, and a throw here turns the
  // SUCCESSFUL tool call it wraps into an error result. So `next()` is awaited
  // first and its decision is the return value on every path, `observe` is
  // synchronous and swallows its own faults, and this try/catch is the second
  // wall: any fault returns the downstream decision untouched.
  ctx.on('tools/post-execute' as never, (async (
    exec: { name: string, arguments: unknown, agent?: AgentLike },
    result: { isError: boolean, content?: { type: string, text?: string }[] },
    next: () => Promise<Record<string, unknown>>,
  ) => {
    const decision = await next()
    try {
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) return decision
      const gateArgs = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
      const current = tracker.results(sessionId)
      // The FULL output: a forge prints the PR URL on its own line, and the
      // tracker's `resultHead` keeps only line one, which would miss it.
      const text = (result.content ?? []).map(b => b.text ?? '').join('\n')
      const directive = reviewGate.observe(sessionId, exec.name, gateArgs, result.isError, text, {
        teamAttached: current?.teamAttached === true,
        ...(current?.facts?.branch !== undefined ? { branch: current.facts.branch } : {}),
      })
      if (directive === undefined) return decision
      // Deliberately no telemetry event: the only kinds available are a denial
      // and the usage events, and an injected reminder is neither. Recording it
      // as `denied` would corrupt the denial counts the panel reports. A
      // `directive` kind belongs in `types.ts`, which is the types author's
      // file — flagged in the handoff rather than edited here.
      const injected = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: directive }],
        source: { kind: 'plugin', plugin: 'dsh-skill-presets', form: 'notice', summary: 'Review required for the pull request just opened' },
      }
      // Append, never replace: another listener's contexts must survive.
      const existing = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
      return { ...decision, additionalContexts: [...existing, injected] }
    } catch (error) {
      warn(`review gate injection failed, passing result through: ${(error as Error).message}`)
      return decision
    }
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
        const userLine = userLines.get(`${sessionId}#${turn}`)
        const mentioned = promptCacheRef.get(sessionId)?.includes(name) === true
        telemetry.record(sessionId, { kind: 'loaded', name, turn, ok: !result.isError, ...(unknown ? { unknown: true } : {}), chars, ...(userLine !== undefined ? { userLine } : {}), mentioned })
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
    // The review gate answers BEFORE the practice gates and independently of
    // them: it is not a `mode: hard` practice, so none of the early returns
    // below may skip it. Synchronous, and `decide` returns undefined on any
    // internal fault, so the worst case here is that the call is allowed.
    try {
      const gateArgs = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
      const current = tracker.results(sessionId)
      const verdict = reviewGate.decide(sessionId, exec.name, gateArgs, {
        teamAttached: current?.teamAttached === true,
        ...(current?.facts?.branch !== undefined ? { branch: current.facts.branch } : {}),
      })
      if (verdict !== undefined) {
        telemetry.record(sessionId, { kind: 'denied', tool: exec.name, reason: verdict.reason })
        return verdict
      }
    } catch (error) {
      warn(`review gate decision failed, allowing: ${(error as Error).message}`)
    }
    let doc: PracticesDoc
    try { doc = await service.practices() } catch { return await next() }
    const hard = new Set(doc.practices.filter(p => p.mode === 'hard').map(p => p.id))
    const current = tracker.results(sessionId)
    const args = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
    const pending = pendingCallOf(exec.name, args)
    // One definition of "mutating", shared with the detectors and the CLI. The
    // ad-hoc regex that used to live here counted `ls > /dev/null` as a write
    // and missed `npm install`.
    const mutating = mutatesFiles(pending.name, pending.filePath ?? pending.command)
    const deny = (reason: string): { kind: 'deny', reason: string } => {
      telemetry.record(sessionId, { kind: 'denied', tool: exec.name, reason })
      return { kind: 'deny', reason }
    }
    // The `worktree` gate answers from the shared pure decision, NOT from the
    // tracker verdict. The tracker is retroactive by construction — it reports
    // mutations already observed — so asking it whether to allow the NEXT call
    // meant the gate could never fire on the first edit, which is the only one
    // worth stopping. Its evidence is still quoted, as evidence, never as the
    // decision. The mode check lives inside `decideWorktreeGate`, so this is
    // deliberately not behind `hard.has('worktree')`.
    const facts = current?.facts
    if (facts !== undefined) {
      const decision = decideWorktreeGate(facts, pending, doc)
      if (!decision.allow) {
        const evidence = current?.results.find(x => x.id === 'worktree')?.evidence[0]
        return deny([
          decision.reason,
          decision.remedy !== undefined ? `Run: ${decision.remedy}` : undefined,
          exemptionHint(),
          evidence !== undefined ? `(tracker: ${evidence})` : undefined,
        ].filter(part => part !== undefined).join(' '))
      }
    }
    if (hard.size === 0) return await next()
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
      const path = pending.filePath
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
    const promptCache = promptCacheRef
    const refreshPrompt = async (agent: AgentLike): Promise<void> => {
      const sessionId = agent.session.id
      try {
        const teamAttached = (await teams.view(sessionId, agent)).attached
        const score = tracker.results(sessionId)
        const set = await service.setFor({ teamAttached, inGitRepo: score?.facts?.inRepo === true }, sessionOf(agent))
        const preset = set.preset
        const position = await service.positionFor(sessionOf(agent))
        promptCache.set(sessionId, renderGuardrails({
          ...(preset !== undefined ? { preset } : {}),
          skills: set.skills,
          overlays: set.overlays,
          practices: annotateRelevance(score?.results ?? [], position.flow, position.stage),
          ...(score?.facts !== undefined ? { artifacts: score.facts.artifacts } : {}),
          flow: position.flow,
          stage: position.stage,
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
  /** Facts as of the last suggestion check, per session — `shouldSuggest` compares against these. */
  const lastFacts = new Map<string, ReturnType<typeof tracker.results> extends infer R ? (R extends { facts?: infer F } ? F : never) : never>()
  /** A suggestion that is currently OFFERED (start-only; cleared on accept/dismiss/first message). */
  const offered = new Map<string, Suggestion>()
  const suggestionFor = async (sessionId: string): Promise<{ guess: ReturnType<typeof detectStage>, suggestion?: Suggestion }> => {
    const state = tracker.has(sessionId) ? tracker.session(sessionId) : undefined
    const score = tracker.results(sessionId)
    const guess = detectStage(score?.facts)
    const identity = { id: sessionId, ...(state?.agentPreset !== undefined ? { agentPreset: state.agentPreset } : {}) }
    const position = await service.positionFor(identity)
    const previous = lastFacts.get(sessionId)
    if (score?.facts !== undefined) lastFacts.set(sessionId, score.facts)
    // Phase 7: offer only at the two playbook moments. Once offered it stays
    // until accepted/dismissed or the user's first message; it is never
    // recomputed mid-session because an edit happened.
    let suggestion = offered.get(sessionId)
    if (suggestion === undefined) {
      const moment = shouldSuggest({ explicitPosition: position.source === 'session', stage: position.stage, previous, facts: score?.facts })
      if (moment) {
        const candidate = suggest(guess, position.stage ?? undefined, await service.presetsByStage(), await service.suggestions())
        // Only stages the current flow contains are worth suggesting.
        if (candidate !== undefined && position.flow.stages.includes(candidate.to)) { suggestion = candidate; offered.set(sessionId, candidate) }
      }
    }
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
  rpc.handle('status', async () => ({
    ...await service.status(),
    // The seam is a property of the running harness; report it once any agent has been seen.
    restrictSeam: [...strictSupport.values()].some(Boolean) ? true : strictSupport.size > 0 ? false : undefined,
  }))
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
    const state = tracker.has(sessionId) ? tracker.session(sessionId) : undefined
    // Accepting MOVES the session to the suggested stage; the preset is derived
    // (a `presetId` pins a collision).
    const moved = await service.setPosition(
      { sessionId, ...(state?.agentPreset !== undefined ? { agentPreset: state.agentPreset } : {}) },
      { stage: suggestion.to, ...(optStr(args, 'presetId') !== undefined ? { pin: optStr(args, 'presetId') } : {}) },
      'ui',
    )
    suggestedAt.delete(sessionId)
    offered.delete(sessionId)
    if (moved.presetId === null && moved.owners.length > 1) return { ok: false, message: `several presets own the ${suggestion.to} stage; pick one`, owners: moved.owners }
    return { ok: true, from: suggestion.from, to: moved.presetId, stage: moved.stage }
  })
  rpc.handle('suggestion/dismiss', async (args) => {
    const sessionId = str(args, 'sessionId')
    const { suggestion } = await suggestionFor(sessionId)
    if (suggestion === undefined) return { ok: false }
    const doc = await service.dismissSuggestion(suggestion.from, suggestion.to)
    telemetry.record(sessionId, { kind: 'suggestion-dismissed', from: suggestion.from, to: suggestion.to, afterMs: elapsed(sessionId) })
    suggestedAt.delete(sessionId)
    offered.delete(sessionId)
    return { ok: true, muted: (doc.dismissed[`${suggestion.from ?? 'none'}→${suggestion.to}`]?.count ?? 0) >= 3 }
  })
  // ---- flows and the session's position (Phase 7)
  rpc.handle('flows/list', async () => ({ flows: await service.flows() }))
  rpc.handle('flows/save', async args => ({ flows: await service.saveFlow(args.flow as Flow) }))
  rpc.handle('flows/delete', async args => ({ flows: await service.deleteFlow(str(args, 'id')) }))
  rpc.handle('session/position', async (args) => {
    const sessionId = str(args, 'sessionId')
    const state = tracker.has(sessionId) ? tracker.session(sessionId) : undefined
    return await positionCard(sessionId, state?.agentPreset)
  })
  /**
   * Move a session (or a default rung) to `{ flow?, stage?, pin? }`. The
   * derived preset is activated at the same rung; the catalog updates on the
   * model's next step.
   */
  rpc.handle('session/move', async (args) => {
    const sessionId = optStr(args, 'sessionId')
    const scope = (optStr(args, 'scope') ?? (sessionId !== undefined ? 'session' : 'default')) as 'session' | 'default' | 'agent-preset'
    const state = sessionId !== undefined && tracker.has(sessionId) ? tracker.session(sessionId) : undefined
    const agentPreset = optStr(args, 'agentPreset') ?? state?.agentPreset
    const stageArg = args.stage
    const moved = await service.setPosition(
      { scope, ...(sessionId !== undefined ? { sessionId } : {}), ...(agentPreset !== undefined ? { agentPreset } : {}) },
      {
        ...(optStr(args, 'flow') !== undefined ? { flow: optStr(args, 'flow') } : {}),
        ...(stageArg === null ? { stage: null } : typeof stageArg === 'string' ? { stage: stageArg as Stage } : {}),
        ...(optStr(args, 'pin') !== undefined ? { pin: optStr(args, 'pin') } : {}),
      },
      'ui',
    )
    if (sessionId !== undefined) {
      offered.delete(sessionId)
      telemetry.record(sessionId, { kind: 'preset-switch', from: null, to: moved.presetId, by: 'ui' } as never)
      await tracker.refresh(sessionId)
    }
    return { ok: true, flow: moved.flow.id, stage: moved.stage, presetId: moved.presetId, owners: moved.owners }
  })
  /** Hide one practice line for this session; three dismissals in a workspace mute it there. */
  const dismissedPractices = new Map<string, Set<string>>()
  rpc.handle('practice/dismiss', async (args) => {
    const sessionId = str(args, 'sessionId')
    const id = str(args, 'id')
    const set = dismissedPractices.get(sessionId) ?? new Set<string>()
    set.add(id)
    dismissedPractices.set(sessionId, set)
    const doc = await service.dismissSuggestion(null, `practice:${id}` as never)
    return { ok: true, muted: (doc.dismissed[`none→practice:${id}`]?.count ?? 0) >= 3 }
  })
  /** The position card the composer control renders from. */
  const positionCard = async (sessionId: string, agentPreset?: string): Promise<Record<string, unknown>> => {
    const identity = { id: sessionId, ...(agentPreset !== undefined ? { agentPreset } : {}) }
    const position = await service.positionFor(identity)
    const score = tracker.results(sessionId)
    const practices = annotateRelevance(score?.results ?? [], position.flow, position.stage)
    const muted = await service.suggestions()
    const hidden = dismissedPractices.get(sessionId) ?? new Set<string>()
    const isMuted = (id: string): boolean => hidden.has(id) || (muted.dismissed[`none→practice:${id}`]?.count ?? 0) >= 3
    const pos = position.stage !== null ? positionOf(position.flow, position.stage) : undefined
    const { suggestion } = await suggestionFor(sessionId)
    const set = await service.setFor({ teamAttached: score?.teamAttached === true, inGitRepo: score?.facts?.inRepo === true }, identity)
    return {
      sessionId,
      flow: position.flow,
      flows: await service.flows(),
      stage: position.stage,
      source: position.source,
      presetId: position.presetId ?? null,
      owners: position.owners,
      ...(pos !== undefined ? { position: pos } : {}),
      ...(position.stage !== null ? { gate: gateFor(position.stage) ?? null, next: nextStage(position.flow, position.stage) ?? null } : {}),
      practices,
      /** Red + relevant + not unknown + not dismissed: the lines the control shows. */
      report: practices.filter(p => p.status === 'red' && p.relevant && p.kind !== 'unknown' && !isMuted(p.id)),
      /** Committed stage artifacts, so the client can say whether the gate is met. */
      artifacts: [...(score?.facts?.artifacts ?? [])],
      /**
       * Absent = we could not look (no forge CLI), so the gate renders "? unknown";
       * null = we looked and found none; object = the open PR.
       */
      pr: score?.facts?.pr ?? (score?.facts?.ghAvailable === false ? undefined : null),
      /** The skills actually offered this session, for the "Skills in play" chips. */
      skills: set.skills.map(s => ({ name: s.name, via: s.via === 'preset' ? 'preset' : `overlay:${s.via.overlay}` })),
      ...(suggestion !== undefined ? { suggestion } : {}),
    }
  }
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
  rpc.handle('experiments/aggregate', async () => aggregateExperiments(await experiments.list(), await telemetry.recentSessions(1000)))
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
  // ---- strict agent preset: copy a shipped preset into the user root minus its filesystem skill row
  rpc.handle('strict/presets', async () => {
    let shipped: string[] = []
    try {
      const { readdir } = await import('node:fs/promises')
      shipped = (await readdir(shippedPresetsDir(), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
    } catch { /* profile cannot resolve agent-presets */ }
    return { shipped, strict: await listStrictPresets() }
  })
  rpc.handle('strict/create', async (args) => {
    const base = str(args, 'base')
    const id = optStr(args, 'id') ?? `${base}-strict`
    const skillPreset = optStr(args, 'skillPreset')
    const plan = await planStrictPreset(base, id)
    const created = await createStrictPreset(plan, {
      name: optStr(args, 'name') ?? `${base} (strict skills)`,
      description: `Copy of the shipped "${base}" agent preset without local skill discovery: every skill the model sees comes from dsh-skill-presets.`,
    })
    // Map it so new sessions under it start from the chosen skill preset.
    if (skillPreset !== undefined) await service.activate(skillPreset, 'ui', { scope: 'agent-preset', agentPreset: id })
    return { ok: true, ...created, id, dropped: created.dropped, note: 'Restart the profile so the agent-preset picker lists it; then pick it for new sessions.' }
  })
  // ---- lint: provider-neutrality and routing quality of the library
  rpc.handle('lint', async () => {
    const [lock, rollup] = await Promise.all([service.library.lock(), telemetry.rollup()])
    return await lintLibrary(lock, service.paths(), rollup)
  })
  // ---- impact: outcomes with vs without a skill / a preset
  rpc.handle('impact/report', async (args) => {
    const sessions = await telemetry.recentSessions(typeof args.limit === 'number' ? args.limit : 500)
    return { skills: skillImpact(sessions), presets: presetImpact(sessions), sessions: sessions.length }
  })
  rpc.handle('impact/session', async (args) => {
    const sessionId = str(args, 'sessionId')
    const [current, sessions] = await Promise.all([telemetry.summary(sessionId), telemetry.recentSessions(500)])
    return sessionVsPeers(current, sessions, typeof args.n === 'number' ? args.n : 20)
  })
  // ---- doctor: is the running plugin the source, and are its seams present?
  rpc.handle('doctor', async () => {
    const foundation = await service.foundation()
    const results = await probe({
      paths: service.paths(),
      foundation: { updatable: foundation.updatable, customized: foundation.customized, added: foundation.added },
      host: {
        startedAt,
        ...([...strictSupport.values()].some(Boolean) ? { restrictSeam: true } : strictSupport.size > 0 ? { restrictSeam: false } : {}),
        agentTeams: ctx.get('agentTeams') !== undefined,
      },
      runEvals: async () => {
        const shipped = await runEvals(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'fixtures'))
        return { total: shipped.length, failed: shipped.filter(r => !r.pass).length }
      },
    })
    const findings = diagnose(results)
    return { findings, worst: worstSeverity(findings), probedAt: new Date().toISOString() }
  })
  // ---- bundles: export / import presets across workbenches
  rpc.handle('bundle/export', async (args) => {
    const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).filter((x): x is string => typeof x === 'string') : (await service.presets()).map(p => p.id)
    const [presets, overlays, sources, lock] = await Promise.all([service.presets(), service.overlays(), service.sources(), service.library.lock()])
    return await exportBundle({ presetIds: ids, presets, overlays, sources, lock, readLocal: dir => readLocalSkill(service.paths().library, dir) })
  })
  rpc.handle('bundle/plan', async (args) => {
    const bundle = validateBundle(args.bundle)
    const [presets, sources, lock] = await Promise.all([service.presets(), service.sources(), service.library.lock()])
    const onCollision = args.onCollision === 'replace' || args.onCollision === 'rename' ? args.onCollision : 'skip'
    return planImport(bundle, { presets, sources, lock, onCollision })
  })
  rpc.handle('bundle/apply', async (args) => {
    const bundle = validateBundle(args.bundle)
    const [presets, sources, lock] = await Promise.all([service.presets(), service.sources(), service.library.lock()])
    const onCollision = args.onCollision === 'replace' || args.onCollision === 'rename' ? args.onCollision : 'skip'
    const plan = planImport(bundle, { presets, sources, lock, onCollision })
    if (plan.problems.length > 0) return { ok: false, plan }
    const result = await applyImport(bundle, plan, {
      savePreset: p => service.savePreset(p),
      saveSources: s => service.saveSources(s),
      libraryRoot: service.paths().library,
      sync: (source, dirs) => service.library.sync(source, { dirs }),
      sources,
    })
    const local = (await service.sources()).find(s => s.id === 'local')
    if (local !== undefined && result.written.some(w => w.startsWith('local/'))) await service.library.sync(local)
    return { ok: true, plan, result }
  })
  // ---- pruning: stale skills per preset, missing skills the model asked for
  rpc.handle('pruning/report', async (args) => {
    const [presets, sessions, rollup, lock, doc] = await Promise.all([
      service.presets(), telemetry.recentSessions(1000), telemetry.rollup(), service.library.lock(), service.practices(),
    ])
    const installed = new Map(lock.skills.filter(s => s.orphaned === undefined).map(s => [s.name, `${s.source}/${s.dir}`]))
    const inPresets = new Set<string>()
    for (const p of presets) for (const e of p.skills) inPresets.add(e.as ?? lock.skills.find(s => `${s.source}/${s.dir}` === e.ref)?.name ?? e.ref.split('/').pop()!)
    // Optional upstream lookup for missing names (network; only when asked).
    let discovered: { source: string, skills: ReturnType<typeof discoverSkills> }[] | undefined
    if (args.searchUpstream === true) {
      discovered = []
      const gh = new GithubClient()
      for (const source of (await service.sources()).filter(s => s.kind === 'github' && s.enabled && s.repo !== undefined)) {
        try {
          const tree = await gh.tree(source.repo!, source.ref)
          discovered.push({ source: source.id, skills: discoverSkills(tree.entries, source.paths ?? ['skills']) })
        } catch { /* offline: no upstream hints */ }
      }
    }
    return pruningReport({ presets, sessions, rollup, installed, inPresets, ...(discovered !== undefined ? { discovered } : {}), thresholds: doc.pruning })
  })
  rpc.handle('pruning/remove', async (args) => {
    const presetId = str(args, 'preset')
    const ref = str(args, 'ref')
    const preset = (await service.presets()).find(p => p.id === presetId)
    if (preset === undefined) throw new Error(`preset "${presetId}" does not exist`)
    await service.savePreset({ ...preset, skills: preset.skills.filter(s => s.ref !== ref) })
    return { ok: true }
  })
  rpc.handle('pruning/add', async (args) => {
    // Add an installed skill (by ref) to a preset — the "add x?" one-click.
    const presetId = str(args, 'preset')
    const ref = str(args, 'ref')
    const preset = (await service.presets()).find(p => p.id === presetId)
    if (preset === undefined) throw new Error(`preset "${presetId}" does not exist`)
    if (preset.skills.some(s => s.ref === ref)) return { ok: true, already: true }
    await service.savePreset({ ...preset, skills: [...preset.skills, { ref }] })
    return { ok: true }
  })
  // ---- knowledge → skill (reads dsh-knowledge's stores read-only)
  const knowledge = new KnowledgeBridge(() => service.paths())
  rpc.handle('knowledge/candidates', async args => await knowledge.candidates({
    ...(typeof args.minConfidence === 'number' ? { minConfidence: args.minConfidence } : {}),
    ...(typeof args.minHits === 'number' ? { minHits: args.minHits } : {}),
  }))
  rpc.handle('knowledge/promote', async (args) => {
    const out = await knowledge.promote(str(args, 'insightId'), { ...(optStr(args, 'name') !== undefined ? { name: optStr(args, 'name') } : {}), ...(args.force === true ? { force: true } : {}) })
    const local = (await service.sources()).find(s => s.id === 'local')
    if (local !== undefined) await service.library.sync(local, { dirs: [out.name] })
    // Record the reverse link in the lock.
    const lock = await service.library.lock()
    const entry = lock.skills.find(s => s.source === 'local' && s.dir === out.name)
    if (entry !== undefined) {
      const { writeJson } = await import('./store.ts')
      await writeJson(service.paths().lock, { ...lock, skills: lock.skills.map(s => s === entry ? { ...s, promotedFrom: str(args, 'insightId') } : s) })
    }
    const text = await service.library.readSkillFile('local', out.name)
    const suggestedPresets = suggestPlacement(text ?? out.name, await service.presets())
    return { ok: true, ...out, ref: `local/${out.name}`, suggestedPresets }
  })
  rpc.handle('placement/orphans', async () => {
    const [lock, presets] = await Promise.all([service.library.lock(), service.presets()])
    return orphanSkills(lock, presets, new Map(lock.skills.map(s => [`${s.source}/${s.dir}`, s.description])))
  })
  rpc.handle('placement/suggest', async args => suggestPlacement(str(args, 'text'), await service.presets()))
  // ---- SDLC team templates → dsh-agent-teams (feature-detected via its HTTP RPC)
  const agentTeamsRpc = async (method: string, body: unknown): Promise<unknown> => {
    const webServer = ctx.get('webServer') as { port?: number, address?: () => { port?: number } } | undefined
    const harnessRef = (globalThis as { harness?: { call?(method: string, args: unknown): Promise<unknown> } }).harness
    // Same-process first: the flat transport agent-teams also binds.
    if (typeof harnessRef?.call === 'function') return await harnessRef.call(`agent-teams/${method}`, body)
    const port = webServer?.port ?? webServer?.address?.().port
    if (port === undefined) throw new Error('dsh-agent-teams RPC is not reachable from here; attach the team from the Agent Teams panel')
    const response = await fetch(`http://127.0.0.1:${port}/plugins/dsh-agent-teams/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await response.text()
    const parsed = text.length > 0 ? JSON.parse(text) as { error?: string } : {}
    if (!response.ok || typeof parsed.error === 'string') throw new Error(parsed.error ?? `agent-teams ${method} failed (${response.status})`)
    return parsed
  }
  rpc.handle('teams/templates', async () => {
    const { templates, problems } = await loadTemplates(join(service.paths().root, 'teams', 'templates'))
    return { templates, problems, agentTeamsPresent: ctx.get('agentTeams') !== undefined }
  })
  rpc.handle('teams/attach-template', async (args) => {
    const sessionId = str(args, 'sessionId')
    const templateId = str(args, 'templateId')
    const { templates } = await loadTemplates(join(service.paths().root, 'teams', 'templates'))
    const template = templates.find(t => t.id === templateId)
    if (template === undefined) throw new Error(`unknown template ${templateId}`)
    if (ctx.get('agentTeams') === undefined && ctx.get('webServer') === undefined) {
      return { ok: false, message: 'dsh-agent-teams is not composed; install it to attach teams' }
    }
    try {
      const saved = await agentTeamsRpc('teams.save', { sessionId, team: toBlueprintInput(template) }) as { id: string, name: string }
      await agentTeamsRpc('mode.attach', { sessionId, teamId: saved.id })
      teams.invalidate(sessionId)
      invalidate?.()
      return { ok: true, teamId: saved.id, teamName: saved.name }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'attach failed' }
    }
  })
  // ---- evals: save this session as a fixture; run the workbench set
  rpc.handle('evals/save', async (args) => {
    const sessionId = str(args, 'sessionId')
    const state = tracker.has(sessionId) ? tracker.session(sessionId) : undefined
    const score = tracker.results(sessionId)
    if (state === undefined || score?.facts === undefined) return { ok: false, message: 'session is not live or has no git facts yet' }
    const stage = await service.activeStage({ id: sessionId, ...(state.agentPreset !== undefined ? { agentPreset: state.agentPreset } : {}) })
    const dir = await saveFixture(join(service.paths().skills, 'evals'), optStr(args, 'name') ?? sessionId.slice(0, 8), {
      practices: await service.practices(),
      ...(stage !== undefined ? { activeStage: stage } : {}),
      teamAttached: score.teamAttached,
      cwd: state.cwd ?? '/repo',
      facts: score.facts,
      calls: state.calls,
      userTurns: state.userTurns,
      events: await telemetry.events(sessionId),
    }, optStr(args, 'description'))
    // Write expected.json from the current folds so the fixture guards against regressions from here on.
    await runEvals(join(service.paths().skills, 'evals'), { only: dir.split('/').pop() ?? '' })
    return { ok: true, dir }
  })
  rpc.handle('evals/run', async args => await runEvals(join(service.paths().skills, 'evals'), { update: args.update === true }))
  // ---- hooks export (optional; both bridges)
  rpc.handle('hooks/generate', async () => {
    const dir = join(service.paths().root, 'hooks')
    await mkdir(dir, { recursive: true })
    const files: string[] = []
    for (const dialect of ['claude-code', 'codex'] as const) {
      const file = join(dir, `skill-presets.${dialect}.json`)
      await writeFile(file, renderHookFile(dialect), 'utf8')
      files.push(file)
    }
    return { ok: true, files }
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
  // ---- foundation: adopt curated presets/overlays that moved on since seeding
  rpc.handle('foundation/report', async () => await service.foundation())
  rpc.handle('foundation/adopt', async (args) => {
    const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).filter((x): x is string => typeof x === 'string') : undefined
    const applied = await service.adoptFoundation(ids)
    // Adopting adds skill refs to presets/overlays, so the catalog the model
    // sees is stale until it is republished — otherwise the newly adopted
    // skills are invisible until the next restart.
    invalidate?.()
    return { ok: true, applied }
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
    const position = await service.positionFor(identity)
    const { guess, suggestion } = await suggestionFor(sessionId)
    const related = await experiments.forSession(sessionId)
    const wt = tracker.worktreesOf(sessionId)
    const { classify } = await import('./practices/worktrees.ts')
    return {
      sessionId,
      live: score !== undefined,
      experiments: related,
      strict: {
        enabled: (await service.practices()).strictSkills,
        seam: strictSupport.get(sessionId) ?? (score !== undefined ? false : undefined),
        applied: strict.isApplied(sessionId),
      },
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
      practices: annotateRelevance(score?.results ?? summary.practices, position.flow, position.stage),
      flow: position.flow,
      stage: position.stage,
      positionSource: position.source,
      ...(position.stage !== null ? { gate: gateFor(position.stage) ?? null, next: nextStage(position.flow, position.stage) ?? null } : {}),
      worst: score?.worst ?? 'n/a',
      facts: score?.facts,
      summary,
      /** Why-trace per load: what changed in the practices until the next load. */
      loadTrace: summary.loads.map((l, i) => ({
        ...l,
        deltas: practiceDeltaAround(summary.practiceTimeline, l.t, summary.loads[i + 1]?.t),
      })),
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
