/**
 * Flows: an ordered subset of stages a piece of work passes through.
 *
 * Not every project needs the same loop. The playbook's six stages are the
 * FULL flow; a bug fix is Build → Review; a spike is nothing at all. A session
 * sits at `{ flow, stage }`, chosen by the human, and the PRESET the model sees
 * is derived from the stage — so the skill provider, the guardrails block and
 * the status tools keep their shape while the user thinks in flows.
 *
 * Everything here is pure. Persistence lives in `store.ts`/`service.ts`.
 * @module dsh-skill-presets/host/flows
 */

import type { Preset, Stage } from './types.ts'

export interface Flow {
  readonly id: string
  readonly title: string
  /** Stages in order. Empty = no stages, no preset (Explore). */
  readonly stages: readonly Stage[]
  /** `off` turns every practice off for a session in this flow. */
  readonly guardrails: 'on' | 'off'
  /** Preset to use when several own a stage, keyed by stage. */
  readonly pins?: Readonly<Partial<Record<Stage, string>>>
  readonly summary?: string
  /** Shipped with the plugin; may be edited but not deleted. */
  readonly builtin?: true
}

export interface FlowsDoc {
  readonly version: 1
  readonly flows: readonly Flow[]
}

export const STAGES: readonly Stage[] = ['plan', 'design', 'build', 'test', 'deploy', 'maintain', 'cross']
const STAGE_SET = new Set<string>(STAGES)

export const BUILTIN_FLOWS: readonly Flow[] = [
  {
    id: 'full',
    title: 'Full',
    summary: 'Plan → Design → Build → Review → Ship. Anything larger than one PR.',
    stages: ['plan', 'design', 'build', 'test', 'deploy'],
    guardrails: 'on',
    builtin: true,
  },
  {
    id: 'explore',
    title: 'Explore',
    summary: 'No stages, no guardrails. Spikes, prototypes, looking around.',
    stages: [],
    guardrails: 'off',
    builtin: true,
  },
]

/** Human-readable stage names, shared by prompt, tools, and UI copy. */
export const STAGE_TITLE: Readonly<Record<Stage, string>> = {
  plan: 'Plan', design: 'Design', build: 'Build', test: 'Review', deploy: 'Ship', maintain: 'Maintain', cross: 'Cross-stage',
}

/** The artifact that ends a stage — the gate the next stage reads. */
const GATES: Readonly<Partial<Record<Stage, string>>> = {
  plan: 'intent.md', design: 'spec.md', build: 'plan.md', test: 'PR', deploy: 'merge', maintain: 'incident record',
}

export function gateFor(stage: Stage): string | undefined {
  return GATES[stage]
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/u

/** Structural problems with one flow; empty when valid. */
export function validateFlow(flow: unknown): string[] {
  const problems: string[] = []
  const f = flow as Partial<Flow>
  if (f === null || typeof f !== 'object') return ['flow is not an object']
  if (typeof f.id !== 'string' || !ID_RE.test(f.id)) problems.push('id must be kebab-case (a-z, 0-9, -)')
  if (typeof f.title !== 'string' || f.title.trim().length === 0) problems.push('title is required')
  if (!Array.isArray(f.stages)) problems.push('stages must be an array')
  else {
    const seen = new Set<string>()
    for (const s of f.stages as unknown[]) {
      if (typeof s !== 'string' || !STAGE_SET.has(s)) { problems.push(`unknown stage ${JSON.stringify(s)}`); continue }
      if (seen.has(s)) problems.push(`stage ${s} listed twice`)
      seen.add(s)
    }
  }
  if (f.guardrails !== 'on' && f.guardrails !== 'off') problems.push("guardrails must be 'on' or 'off'")
  if (f.pins !== undefined) {
    if (typeof f.pins !== 'object' || f.pins === null) problems.push('pins must be an object')
    else for (const [k, v] of Object.entries(f.pins)) { if (!STAGE_SET.has(k) || typeof v !== 'string') problems.push(`bad pin ${k}`) }
  }
  return problems
}

function cleanFlow(raw: Flow, builtin: boolean): Flow {
  const pins: Partial<Record<Stage, string>> = {}
  if (raw.pins !== undefined) for (const [k, v] of Object.entries(raw.pins)) { if (STAGE_SET.has(k) && typeof v === 'string') pins[k as Stage] = v }
  return {
    id: raw.id,
    title: raw.title.trim(),
    stages: [...raw.stages],
    guardrails: raw.guardrails,
    ...(Object.keys(pins).length > 0 ? { pins } : {}),
    ...(typeof raw.summary === 'string' && raw.summary.length > 0 ? { summary: raw.summary } : {}),
    ...(builtin ? { builtin: true as const } : {}),
  }
}

/**
 * Validate a stored list. Junk entries are dropped; the built-ins are always
 * present (edited copies win over the shipped ones, but keep `builtin`), in
 * shipped order, followed by custom flows in stored order.
 */
export function validateFlows(raw: unknown): Flow[] {
  if (!Array.isArray(raw)) throw new TypeError('flows is not an array')
  const stored = new Map<string, Flow>()
  const order: string[] = []
  for (const entry of raw) {
    if (validateFlow(entry).length > 0) continue
    const f = entry as Flow
    if (!stored.has(f.id)) order.push(f.id)
    stored.set(f.id, f)
  }
  const out: Flow[] = []
  for (const shipped of BUILTIN_FLOWS) out.push(cleanFlow(stored.get(shipped.id) ?? shipped, true))
  const builtinIds = new Set(BUILTIN_FLOWS.map(f => f.id))
  for (const id of order) if (!builtinIds.has(id)) out.push(cleanFlow(stored.get(id) as Flow, false))
  return out
}

export function flowsDoc(flows: readonly Flow[]): FlowsDoc {
  return { version: 1, flows: flows.map(f => cleanFlow(f, f.builtin === true)) }
}

/** Presets that own a stage (cross-stage presets own nothing). */
function ownersOf(stage: Stage, presets: readonly Preset[]): Preset[] {
  if (stage === 'cross') return []
  return presets.filter(p => p.stage === stage)
}

/**
 * The preset a stage maps to: the single owner, or the pinned one when several
 * own it. Undefined when none does, or when several do and nothing is pinned —
 * the caller must ask, never guess.
 */
export function presetForStage(stage: Stage, presets: readonly Preset[], pins?: Readonly<Partial<Record<Stage, string>>>): Preset | undefined {
  const owners = ownersOf(stage, presets)
  if (owners.length === 1) return owners[0]
  const pinned = pins?.[stage]
  if (pinned !== undefined) return owners.find(p => p.id === pinned)
  return undefined
}
presetForStage.ownersOf = ownersOf

/** The stage a preset owns — for migrating a session that only knows its preset. */
export function stageOfPreset(presetId: string, presets: readonly Preset[]): Stage | undefined {
  return presets.find(p => p.id === presetId)?.stage
}

export function positionOf(flow: Flow, stage: Stage | null): { index: number, of: number } | undefined {
  if (stage === null) return undefined
  const index = flow.stages.indexOf(stage)
  return index === -1 ? undefined : { index, of: flow.stages.length }
}

export function nextStage(flow: Flow, stage: Stage | null): Stage | undefined {
  const pos = positionOf(flow, stage)
  if (pos === undefined) return undefined
  return flow.stages[pos.index + 1]
}

// ------------------------------------------------------------ positions ----

/** Where one session (or a default rung) sits: which flow, which stage in it. */
export interface Position {
  readonly flow: string
  /** Null in a flow with no stages (Explore). */
  readonly stage: Stage | null
}

/**
 * Per-rung positions, parallel to `active.json`'s preset rungs. `active.json`
 * keeps answering "which preset" for the provider; this answers "which flow and
 * stage" for the human. Setting a position also activates the derived preset,
 * so the two never disagree.
 */
export interface PositionsDoc {
  readonly version: 1
  readonly default: Position
  readonly byAgentPreset: Record<string, Position>
  readonly sessions: Record<string, Position & { since: string, disposedAt?: string }>
}

export const DEFAULT_POSITION: Position = { flow: 'full', stage: 'plan' }

export function defaultPositions(): PositionsDoc {
  return { version: 1, default: DEFAULT_POSITION, byAgentPreset: {}, sessions: {} }
}

function asPosition(raw: unknown, fallback: Position): Position {
  const p = raw as Partial<Position>
  if (p === null || typeof p !== 'object' || typeof p.flow !== 'string') return fallback
  const stage = typeof p.stage === 'string' && STAGE_SET.has(p.stage) ? p.stage as Stage : null
  return { flow: p.flow, stage }
}

export function validatePositions(raw: unknown): PositionsDoc {
  const doc = raw as Record<string, unknown>
  if (doc === null || typeof doc !== 'object') throw new TypeError('positions is not an object')
  const byAgentPreset: Record<string, Position> = {}
  if (typeof doc.byAgentPreset === 'object' && doc.byAgentPreset !== null) {
    for (const [k, v] of Object.entries(doc.byAgentPreset)) byAgentPreset[k] = asPosition(v, DEFAULT_POSITION)
  }
  const sessions: PositionsDoc['sessions'] = {}
  if (typeof doc.sessions === 'object' && doc.sessions !== null) {
    for (const [k, v] of Object.entries(doc.sessions as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue
      const e = v as Record<string, unknown>
      sessions[k] = { ...asPosition(v, DEFAULT_POSITION), since: typeof e.since === 'string' ? e.since : new Date(0).toISOString(), ...(typeof e.disposedAt === 'string' ? { disposedAt: e.disposedAt } : {}) }
    }
  }
  return { version: 1, default: asPosition(doc.default, DEFAULT_POSITION), byAgentPreset, sessions }
}

/** Resolve the position for one session: session → agent-preset → default. Pure. */
export function resolvePosition(doc: PositionsDoc, sessionId?: string, agentPreset?: string): { position: Position, source: 'session' | 'agent-preset' | 'default' } {
  if (sessionId !== undefined && Object.hasOwn(doc.sessions, sessionId)) {
    const { flow, stage } = doc.sessions[sessionId]
    return { position: { flow, stage }, source: 'session' }
  }
  if (agentPreset !== undefined && Object.hasOwn(doc.byAgentPreset, agentPreset)) return { position: doc.byAgentPreset[agentPreset], source: 'agent-preset' }
  return { position: doc.default, source: 'default' }
}

/**
 * Derive a position from a preset choice that predates flows (migration and
 * the legacy `presets/activate` path): the preset's stage inside the Full flow;
 * a cross-stage or unknown preset lands in Full at Build with the preset pinned.
 */
export function positionFromPreset(presetId: string | null, presets: readonly Preset[]): Position {
  if (presetId === null) return { flow: 'explore', stage: null }
  const stage = stageOfPreset(presetId, presets)
  if (stage === undefined || stage === 'cross') return { flow: 'full', stage: 'build' }
  return { flow: 'full', stage }
}

/**
 * Move to a stage inside a flow. A stage the flow does not contain is refused —
 * the flow IS the set of allowed stages. A flow with no stages accepts only null.
 */
export function moveTo(flow: Flow, stage: Stage | null): Position {
  if (flow.stages.length === 0) {
    if (stage !== null) throw new Error(`flow "${flow.id}" has no stages`)
    return { flow: flow.id, stage: null }
  }
  if (stage === null || !flow.stages.includes(stage)) throw new Error(`stage ${String(stage)} is not in flow "${flow.id}" (${flow.stages.join(' → ')})`)
  return { flow: flow.id, stage }
}

/**
 * Switch flows, keeping the stage when the new flow has it, else its first
 * stage (or null for a stage-less flow).
 */
export function switchFlow(to: Flow, current: Position): Position {
  if (to.stages.length === 0) return { flow: to.id, stage: null }
  if (current.stage !== null && to.stages.includes(current.stage)) return { flow: to.id, stage: current.stage }
  return { flow: to.id, stage: to.stages[0] }
}
