/**
 * Model-facing tools. Deterministic — no model calls — so they behave the same
 * under every provider and cost no tokens beyond their output.
 * @module dsh-skill-presets/host/tools
 */

import type { PracticeTracker } from './practices/index.ts'
import type { SkillPresetsService } from './service.ts'
import type { Telemetry } from './telemetry.ts'
import { PRACTICE_INFO, STAGE_ORDER } from './curated.ts'
import { STAGE_TITLE, annotateRelevance, gateFor, nextStage, positionOf } from './flows.ts'
import { STAGE_KEYWORDS } from './placement.ts'

/**
 * Local tool builder, mirroring the registry's shape: per-property `required`
 * hoisted into a top-level array; `render` returns content BLOCKS.
 */
export function makeTool(options: {
  name: string
  description: string
  parameters: Record<string, Record<string, unknown>>
  execute(args: Record<string, unknown>, exec: { agent?: { session: { id: string, header: { cwd?: string } } }, signal: AbortSignal }): Promise<unknown>
}): unknown {
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(options.parameters)) {
    const { required: isRequired, ...rest } = spec
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return {
    name: options.name,
    description: options.description,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: renderValue(value) }],
    },
    execute: async (args: unknown, exec: unknown) => await options.execute(
      (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
      exec as { agent?: { session: { id: string, header: { cwd?: string } } }, signal: AbortSignal },
    ),
  }
}

function renderValue(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'text' in value && typeof (value as { text: unknown }).text === 'string') {
    return (value as { text: string }).text
  }
  return JSON.stringify(value, null, 2)
}

export interface ToolDeps {
  service: SkillPresetsService
  tracker: PracticeTracker
  telemetry: Telemetry
  /** Whether a team is attached for this agent (tool visibility). */
  teamAttached: (agent: unknown) => boolean
}

/** Build the tool definitions. */
export function buildTools(deps: ToolDeps): unknown[] {
  const statusTool = makeTool({
    name: 'skill_preset_status',
    description: 'Report the active skill preset, the skills it exposes to you, the active overlays, and this session\'s'
      + ' practice scorecard (worktree, pull request, conductor protocol, stage artifacts). Use it when unsure which'
      + ' skills are in play or why a practice is flagged.',
    parameters: {},
    execute: async (_args, exec) => {
      const status = await deps.service.status()
      const sessionId = exec.agent?.session.id
      const agentPreset = sessionId !== undefined && deps.tracker.has(sessionId) ? deps.tracker.session(sessionId).agentPreset : undefined
      const identity = sessionId !== undefined ? { id: sessionId, ...(agentPreset !== undefined ? { agentPreset } : {}) } : undefined
      const set = await deps.service.setFor({
        teamAttached: deps.teamAttached(exec.agent),
        inGitRepo: sessionId !== undefined ? deps.tracker.results(sessionId)?.facts?.inRepo === true : false,
      }, identity)
      const scorecard = sessionId !== undefined ? deps.tracker.results(sessionId) : undefined
      const resolved = await deps.service.activeFor(identity)
      const lines = [
        `Active preset for this session: ${set.preset !== undefined ? `${set.preset.title} (${set.preset.id}, ${set.preset.stage} stage)` : 'none'} — set at ${resolved.source} scope`,
        `Workspace default: ${status.activePreset?.id ?? 'none'}`,
        `Skills exposed (${set.skills.length}): ${set.skills.map(s => s.name).join(', ') || '(none)'}`,
        `Overlays active: ${set.overlays.join(', ') || '(none)'}`,
      ]
      if (set.resolution.unresolved.length > 0) lines.push(`Unresolved refs: ${set.resolution.unresolved.map(u => `${u.ref} (${u.reason})`).join('; ')}`)
      if (scorecard !== undefined) {
        lines.push('', 'Practices:')
        for (const r of scorecard.results) lines.push(`- ${PRACTICE_INFO[r.id].title}: ${r.status}${r.evidence.length > 0 ? ` — ${r.evidence[0]}` : ''}`)
      }
      if (sessionId !== undefined) {
        const summary = await deps.telemetry.summary(sessionId)
        const loaded = Object.entries(summary.loaded).map(([name, info]) => `${name}×${info.count}`)
        lines.push('', `Skills loaded this session: ${loaded.join(', ') || '(none yet)'}`)
        if (summary.unknown.length > 0) lines.push(`Requested but unknown: ${[...new Set(summary.unknown)].join(', ')}`)
      }
      return { text: lines.join('\n') }
    },
  })

  const sdlcTool = makeTool({
    name: 'sdlc_status',
    description: 'Report the current SDLC position for this session: which stage artifacts (intent.md, spec.md, plan.md)'
      + ' exist, the git state (worktree, branch, ahead, PR), the practice statuses, and the next artifact to write.'
      + ' Deterministic and cheap; call it before starting or finishing a stage.',
    parameters: {},
    execute: async (_args, exec) => {
      const sessionId = exec.agent?.session.id
      if (sessionId !== undefined) await deps.tracker.refresh(sessionId)
      const scorecard = sessionId !== undefined ? deps.tracker.results(sessionId) : undefined
      const facts = scorecard?.facts
      const agentPreset = sessionId !== undefined && deps.tracker.has(sessionId) ? deps.tracker.session(sessionId).agentPreset : undefined
      const identity = sessionId !== undefined ? { id: sessionId, ...(agentPreset !== undefined ? { agentPreset } : {}) } : undefined
      const position = await deps.service.positionFor(identity)
      const lines: string[] = []
      if (position.stage === null) {
        lines.push(`Flow: ${position.flow.title} — no stages, guardrails off. Practices are not judged in this flow.`)
      } else {
        const pos = positionOf(position.flow, position.stage)
        const gate = gateFor(position.stage)
        const following = nextStage(position.flow, position.stage)
        lines.push(`Flow: ${position.flow.title} (${position.flow.stages.map(st => STAGE_TITLE[st]).join(' → ')})`)
        lines.push(`Stage: ${STAGE_TITLE[position.stage]}${pos !== undefined ? ` (${pos.index + 1} of ${pos.of})` : ''}${position.presetId !== undefined ? ` · preset ${position.presetId}` : position.owners.length > 1 ? ` · several presets own this stage (${position.owners.join(', ')}) — the user picks one` : ''}`)
        lines.push(`Gate: ${gate ?? 'none'}${following !== undefined ? ` → then ${STAGE_TITLE[following]}` : ' → last stage of this flow'}. Moving stage is the user's decision.`)
      }
      if (facts === undefined) lines.push('Git: unknown (no facts yet)')
      else if (!facts.inRepo) lines.push('Git: cwd is not inside a repository')
      else {
        lines.push(`Git: branch ${facts.branch ?? '(detached)'}${facts.isWorktree === true ? ' in a linked worktree' : ' in the primary checkout'}`
          + `${facts.ahead !== undefined ? `, ${facts.ahead} ahead of upstream` : facts.hasUpstream === false ? ', no upstream' : ''}`
          + `${facts.dirty === true ? ', uncommitted changes' : ''}`)
        lines.push(`PR: ${facts.pr !== undefined ? `${facts.pr.state} ${facts.pr.url}` : facts.ghAvailable ? 'none' : 'unknown (no forge CLI)'}`)
        lines.push(`Artifacts: ${facts.artifacts.join(', ') || 'none'}`)
        if (facts.instructionFiles.length > 0) lines.push(`Instructions file: ${facts.instructionFiles.join(', ')}`)
      }
      const has = (f: string): boolean => facts?.artifacts.some(a => a.endsWith(f)) === true
      const next = !has('intent.md') ? 'intent.md (Plan)' : !has('spec.md') ? 'spec.md (Design)' : !has('plan.md') ? 'plan.md (Design)' : facts?.pr === undefined ? 'a pull request (Build → Test)' : 'review findings in the PR (Test)'
      lines.push(`Next artifact: ${next}`)
      if (scorecard !== undefined && scorecard.results.length > 0) {
        // Phase 7: only what the model must act on. Red + relevant; unknowns
        // are listed as such in one line; everything else is not mentioned.
        const annotated = annotateRelevance(scorecard.results, position.flow, position.stage)
        const act = annotated.filter(r => r.status === 'red' && r.relevant && r.kind !== 'unknown')
        const unknown = annotated.filter(r => r.kind === 'unknown' && r.relevant)
        if (act.length > 0) {
          lines.push('Practices needing action:')
          for (const r of act) lines.push(`- ${PRACTICE_INFO[r.id].title}: ${r.evidence[0] ?? ''} — load the \`${PRACTICE_INFO[r.id].skill}\` skill`)
        } else if (position.flow.guardrails === 'on') {
          lines.push('Practices: nothing needs action.')
        }
        if (unknown.length > 0) lines.push(`Not judged (facts unavailable): ${unknown.map(r => PRACTICE_INFO[r.id].title).join(', ')}`)
      }
      return { text: lines.join('\n') }
    },
  })

  const suggestTool = makeTool({
    name: 'skill_preset_suggest',
    description: 'Suggest which skill preset fits a described task, from the preset summaries and the SDLC stage'
      + ' order. NEVER switches the preset — switching is the user\'s decision in the GUI. Returns the suggestion'
      + ' and why, so you can ask the user.',
    parameters: {
      task: { type: 'string', required: true, description: 'One or two sentences describing the work about to start.' },
    },
    execute: async (args) => {
      const task = String(args.task ?? '').toLowerCase()
      const status = await deps.service.status()
      const scored = status.presets.map((preset) => {
        const words = `${preset.title} ${preset.summary} ${preset.stage}`.toLowerCase().split(/[^a-z0-9]+/u).filter(w => w.length > 3)
        const hits = words.filter(w => task.includes(w)).length
        const stageHits = STAGE_KEYWORDS[preset.stage].filter(k => task.includes(k)).length * 2
        return { preset, score: hits + stageHits }
      }).sort((a, b) => b.score - a.score)
      const best = scored[0]
      if (best === undefined || best.score === 0) {
        return { text: `No strong match. Stage order is ${STAGE_ORDER.join(' → ')}; ask the user which stage this work is in.` }
      }
      const current = status.activePreset?.id
      return {
        text: [
          `Suggested preset: ${best.preset.title} (${best.preset.id}) — ${best.preset.summary}`,
          current === best.preset.id ? 'It is already active.' : `Currently active: ${current ?? 'none'}. Ask the user to switch in the header chip if they agree.`,
          scored[1] !== undefined && scored[1].score > 0 ? `Runner-up: ${scored[1].preset.title}.` : '',
        ].filter(l => l.length > 0).join('\n'),
      }
    },
  })

  return [statusTool, sdlcTool, suggestTool]
}
