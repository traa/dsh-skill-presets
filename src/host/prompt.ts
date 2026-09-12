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
import type { ResolvedSkill } from './presets.ts'
import type { PracticeResult, Preset } from './types.ts'

export interface PromptInput {
  preset?: Preset
  skills: readonly Pick<ResolvedSkill, 'name' | 'via'>[]
  overlays: readonly string[]
  practices: readonly PracticeResult[]
  artifacts?: readonly string[]
}

/** Render the block; empty string contributes nothing. */
export function renderGuardrails(input: PromptInput): string {
  const lines: string[] = []
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
  const atRisk = input.practices.filter(p => p.status === 'red' || p.status === 'amber')
  if (atRisk.length > 0) {
    lines.push('Practices at risk:')
    for (const p of atRisk) {
      const info = PRACTICE_INFO[p.id]
      const fix = input.skills.some(s => s.name === info.skill) ? ` — load the \`${info.skill}\` skill` : ''
      lines.push(`- ${info.title} [${p.status}]: ${p.evidence[0] ?? ''}${fix}`)
    }
  }
  if (lines.length === 0) return ''
  return ['# Skill presets and practices', ...lines].join('\n')
}
