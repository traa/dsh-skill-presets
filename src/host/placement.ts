/**
 * Where does a skill belong? Score its name, description and when-to-use
 * against each preset's stage keywords and summary; return the top presets
 * with the words that matched. Deterministic, provider-neutral, and the same
 * table `skill_preset_suggest` uses for tasks.
 * @module dsh-skill-presets/host/placement
 */

import type { Lock, Preset, Stage } from './types.ts'

/** Stage vocabulary — one table for tasks (tool) and skills (placement). */
export const STAGE_KEYWORDS: Record<Stage, readonly string[]> = {
  plan: ['idea', 'intent', 'requirement', 'why', 'problem', 'scope', 'brainstorm', 'interview', 'refine', 'question'],
  design: ['spec', 'plan', 'architecture', 'interface', 'api', 'design', 'break down', 'ticket', 'domain', 'model', 'adr', 'document'],
  build: ['implement', 'build', 'code', 'feature', 'fix', 'write', 'worktree', 'commit', 'tdd', 'test-first', 'incremental', 'execute'],
  test: ['review', 'test', 'pr', 'pull request', 'security', 'quality', 'verify', 'verification', 'finish', 'browser'],
  deploy: ['deploy', 'ship', 'release', 'ci', 'pipeline', 'migration', 'launch', 'deprecat'],
  maintain: ['bug', 'incident', 'debug', 'slow', 'crash', 'alert', 'postmortem', 'performance', 'observab', 'triage', 'diagnos'],
  cross: ['delegate', 'team', 'parallel', 'subagent', 'conductor', 'dispatch'],
}

export interface Placement {
  readonly preset: string
  readonly title: string
  readonly stage: Stage
  readonly score: number
  readonly matched: string[]
}

/** Score one text against the presets. Pure. */
export function suggestPlacement(text: string, presets: readonly Preset[], limit = 2): Placement[] {
  const t = text.toLowerCase()
  const scored = presets.map((preset) => {
    const stageHits = STAGE_KEYWORDS[preset.stage].filter(k => t.includes(k))
    const summaryWords = `${preset.title} ${preset.summary}`.toLowerCase().split(/[^a-z0-9-]+/u).filter(w => w.length > 4)
    const summaryHits = [...new Set(summaryWords.filter(w => t.includes(w)))]
    return { preset: preset.id, title: preset.title, stage: preset.stage, score: stageHits.length * 2 + summaryHits.length, matched: [...stageHits, ...summaryHits.filter(w => !stageHits.includes(w))] }
  })
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.preset.localeCompare(b.preset)).slice(0, limit)
}

/** Installed skills that appear in no preset, with a placement for each. */
export function orphanSkills(lock: Lock, presets: readonly Preset[], descriptions: ReadonlyMap<string, string>): { ref: string, name: string, placements: Placement[] }[] {
  const inPresets = new Set(presets.flatMap(p => p.skills.map(s => s.ref)))
  return lock.skills
    .filter(s => s.orphaned !== true && !inPresets.has(`${s.source}/${s.dir}`))
    .map(s => ({ ref: `${s.source}/${s.dir}`, name: s.name, placements: suggestPlacement(`${s.name} ${descriptions.get(`${s.source}/${s.dir}`) ?? s.description}`, presets) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
