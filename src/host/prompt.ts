/**
 * The guardrails prompt block.
 *
 * At most a few lines, and only what is actionable right now: the active
 * preset and its skills (so the model knows what to reach for), the detected
 * stage, and the practices currently AT RISK with the skill that fixes each.
 * Nothing when everything is green and no preset is active. Provider-neutral
 * plain text — no vendor file names, no vendor tool names.
 * @module dsh-skill-presets/host/prompt
 */

import { PRACTICE_INFO } from './curated.ts'
import { STAGE_TITLE, gateFor, positionOf, type AnnotatedPractice, type Flow } from './flows.ts'
import { short } from './practices/detectors.ts'
import type { ResolvedSkill } from './presets.ts'
import type { PracticeResult, Preset, Stage } from './types.ts'

export interface PromptInput {
  preset?: Preset
  skills: readonly Pick<ResolvedSkill, 'name' | 'via'>[]
  overlays: readonly string[]
  /** Raw results (legacy: red+amber listed) or annotated ones (only red+relevant listed). */
  practices: readonly (PracticeResult | AnnotatedPractice)[]
  artifacts?: readonly string[]
  /** Phase 7: the session's position. With a flow, only red + relevant practices are named. */
  flow?: Flow
  stage?: Stage | null
}

/** Render the block; empty string contributes nothing. */
export function renderGuardrails(input: PromptInput): string {
  const lines: string[] = []
  const flow = input.flow
  if (flow !== undefined && flow.guardrails === 'off') {
    // Explore: one line, then nothing. The skills still appear so the model can
    // reach for one; no preset, no practices.
    lines.push(`${flow.title} flow: guardrails are off for this session.`)
    const names = input.skills.map(s => s.name)
    if (names.length > 0) lines.push(`Skills available: ${names.join(', ')}. Load one with the \`skill\` tool when it matches the task.`)
    return ['# Skill presets and practices', ...lines].join('\n')
  }
  if (flow !== undefined && input.stage !== undefined && input.stage !== null) {
    const pos = positionOf(flow, input.stage)
    const gate = gateFor(input.stage)
    lines.push(`Flow: ${flow.title}${pos !== undefined ? ` · stage ${pos.index + 1} of ${pos.of}` : ''}: ${STAGE_TITLE[input.stage]}${gate !== undefined ? ` → next gate: ${gate}` : ''}. Moving to another stage is the user's call; say when the gate artifact is ready.`)
  }
  if (input.preset !== undefined || input.skills.length > 0) {
    const names = input.skills.map(s => s.name)
    const head = input.preset !== undefined
      ? `Active skill preset: ${input.preset.title} (${input.preset.stage} stage) — ${input.preset.summary}`
      : 'Active skills (overlays only)'
    lines.push(head)
    if (names.length > 0) {
      lines.push(`Skills in play: ${names.join(', ')}. Load one with the \`skill\` tool before acting on a matching task.`)
    }
    if (input.overlays.length > 0) lines.push(`Overlays active: ${input.overlays.join(', ')}.`)
  }
  if (input.artifacts !== undefined && input.artifacts.length > 0) {
    lines.push(`Stage artifacts present: ${input.artifacts.join(', ')}.`)
  }
  // With a flow: only RED and RELEVANT, never "unknown". Without one (legacy
  // caller, replays): the old red+amber list.
  const atRisk = flow !== undefined
    ? input.practices.filter((p): p is AnnotatedPractice => p.status === 'red' && (p as AnnotatedPractice).relevant === true && (p as AnnotatedPractice).kind !== 'unknown')
    : input.practices.filter(p => p.status === 'red' || p.status === 'amber')
  if (atRisk.length > 0) {
    lines.push('Practices at risk:')
    for (const p of atRisk) {
      const info = PRACTICE_INFO[p.id]
      const fix = input.skills.some(s => s.name === info.skill) ? ` — load the \`${info.skill}\` skill` : ''
      // Defensive: a detector interpolating an unbounded tool argument (a bash
      // command can be thousands of characters) must not be able to flood the
      // model's context through this block.
      lines.push(`- ${info.title} [${p.status}]: ${short(p.evidence[0] ?? '', 160)}${fix}`)
    }
  }
  if (lines.length === 0) return ''
  return ['# Skill presets and practices', ...lines].join('\n')
}
