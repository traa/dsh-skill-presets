/**
 * SDLC team templates: agent-teams blueprints whose conductor instructions
 * name the practice skills. Shipped as data under `templates/teams/`; the
 * workbench may hold more under `<workbench>/teams/templates/`.
 *
 * Attaching goes through dsh-agent-teams' own RPC (`teams.save`, then
 * `mode.attach`), reached over the same HTTP prefix its panel uses, and only
 * when that plugin is composed. Members leave `provider`/`model` unset so they
 * inherit the session's provider — provider-neutral by construction.
 * @module dsh-skill-presets/host/templates
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Stage } from './types.ts'

export interface TeamTemplate {
  readonly id: string
  readonly name: string
  readonly stage: Stage
  readonly objective: string
  readonly members: readonly {
    readonly id: string
    readonly name: string
    readonly responsibility: string
    readonly engine: 'harness' | 'cli'
    readonly context: 'fresh' | 'fork'
    readonly autoStart: boolean
    readonly reviews?: readonly string[]
    readonly cliProvider?: string
    readonly provider?: string
    readonly model?: string
  }[]
  readonly conductorInstructions: string
}

/** The plugin's own templates directory. */
export function bundledTemplatesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'teams')
}

/** Validate against the agent-teams blueprint field rules we can check statically. */
export function validateTemplate(raw: unknown): TeamTemplate {
  if (typeof raw !== 'object' || raw === null) throw new TypeError('template must be an object')
  const t = raw as Record<string, unknown>
  for (const key of ['id', 'name', 'objective', 'conductorInstructions']) {
    if (typeof t[key] !== 'string' || (t[key] as string).trim().length === 0) throw new TypeError(`template.${key} is required`)
  }
  if (!Array.isArray(t.members) || t.members.length === 0) throw new TypeError('template.members must be a non-empty array')
  const names = new Set<string>()
  const ids = new Set<string>()
  const members = t.members.map((m, i) => {
    if (typeof m !== 'object' || m === null) throw new TypeError(`members[${i}] must be an object`)
    const r = m as Record<string, unknown>
    for (const key of ['id', 'name', 'responsibility']) {
      if (typeof r[key] !== 'string' || (r[key] as string).trim().length === 0) throw new TypeError(`members[${i}].${key} is required`)
    }
    if (names.has(r.name as string)) throw new TypeError(`two members are named "${r.name as string}"`)
    names.add(r.name as string)
    ids.add(r.id as string)
    const engine: 'cli' | 'harness' = r.engine === 'cli' ? 'cli' : 'harness'
    if (engine === 'cli' && typeof r.cliProvider !== 'string') throw new TypeError(`members[${i}] with engine cli needs cliProvider`)
    return {
      id: r.id as string,
      name: r.name as string,
      responsibility: r.responsibility as string,
      engine,
      context: r.context === 'fork' ? 'fork' as const : 'fresh' as const,
      autoStart: r.autoStart === true,
      ...(Array.isArray(r.reviews) ? { reviews: r.reviews.filter((x): x is string => typeof x === 'string') } : {}),
      ...(typeof r.cliProvider === 'string' ? { cliProvider: r.cliProvider } : {}),
      ...(typeof r.provider === 'string' ? { provider: r.provider } : {}),
      ...(typeof r.model === 'string' ? { model: r.model } : {}),
    }
  })
  for (const m of members) for (const rev of m.reviews ?? []) if (!ids.has(rev)) throw new TypeError(`member ${m.id} reviews unknown member ${rev}`)
  const stage = typeof t.stage === 'string' ? t.stage as Stage : 'cross'
  return { id: t.id as string, name: t.name as string, stage, objective: t.objective as string, members, conductorInstructions: t.conductorInstructions as string }
}

/** Load every template from the bundled dir plus an optional workbench dir. */
export async function loadTemplates(extraDir?: string): Promise<{ templates: TeamTemplate[], problems: string[] }> {
  const templates: TeamTemplate[] = []
  const problems: string[] = []
  for (const dir of [bundledTemplatesDir(), ...(extraDir !== undefined ? [extraDir] : [])]) {
    let names: string[] = []
    try { names = (await readdir(dir)).filter(n => n.endsWith('.json')) } catch { continue }
    for (const name of names) {
      try {
        const parsed = validateTemplate(JSON.parse(await readFile(join(dir, name), 'utf8')))
        if (!templates.some(t => t.id === parsed.id)) templates.push(parsed)
      } catch (error) {
        problems.push(`${join(dir, name)}: ${(error as Error).message}`)
      }
    }
  }
  return { templates, problems }
}

/** The body agent-teams' `teams.save` expects (its own normalizer fills the rest). */
export function toBlueprintInput(template: TeamTemplate): Record<string, unknown> {
  return {
    name: template.name,
    objective: template.objective,
    members: template.members.map(m => ({ ...m })),
    conductorInstructions: template.conductorInstructions,
  }
}
