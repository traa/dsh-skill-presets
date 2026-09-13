/**
 * Promote a dsh-knowledge insight to a local skill.
 *
 * Reads the knowledge stores read-only (`<workbench>/knowledge/global.json`
 * and `<workbench>/projects/<key>/knowledge.json`), lists insights worth
 * turning into a skill — workflow rules and conventions the model keeps
 * reading — and writes `library/local/<kebab>/SKILL.md` from a deterministic
 * template. No model call: the skill body IS the insight, framed so the
 * `skill` tool can load it. The link is kept both ways (lock `promotedFrom`,
 * `promotions.json`).
 * @module dsh-skill-presets/host/knowledge
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJson, type StorePaths } from './store.ts'

/** The slice of a dsh-knowledge node this module reads. */
export interface InsightLike {
  readonly id: string
  readonly domain: string
  readonly title: string
  readonly body: string
  readonly kind: string
  readonly confidence: number
  readonly hits?: number
  readonly retiredAt?: string
  readonly supersededBy?: string
  readonly updatedAt?: string
}

export interface Candidate extends InsightLike {
  /** Which store it came from. */
  readonly scope: 'global' | 'project'
  readonly project?: string
  /** Already promoted → the skill dir. */
  readonly promotedTo?: string
  /** Proposed skill name. */
  readonly skillName: string
}

export interface PromotionsDoc {
  readonly version: 1
  readonly promotions: { insightId: string, skill: string, at: string, title: string }[]
}

export interface PromoteOptions {
  minConfidence?: number
  /** An insight read this often is a candidate even below minConfidence. */
  minHits?: number
  kinds?: readonly string[]
}

const DEFAULTS: Required<PromoteOptions> = { minConfidence: 2, minHits: 40, kinds: ['workflow', 'convention', 'preference'] }

/** Kebab-case a title into a valid skill name (≤ 48 chars). */
export function skillNameFor(title: string): string {
  const base = title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').replaceAll(/-{2,}/gu, '-')
  const words = base.split('-').filter(w => w.length > 0 && !['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'it', 'its', 'with', 'never', 'not'].includes(w))
  let name = ''
  for (const w of words) {
    if (name.length + w.length + 1 > 48) break
    name = name.length === 0 ? w : `${name}-${w}`
  }
  if (name.length === 0) name = base.slice(0, 48).replace(/-+$/u, '')
  if (name.length === 0) return 'insight'
  if (!/^[a-z]/u.test(name)) name = `rule-${name}`
  return name
}

/** Render the SKILL.md. Deterministic; the body is the insight. */
export function renderSkill(insight: InsightLike, name: string): string {
  const first = insight.body.split(/(?<=[.!?])\s+/u)[0] ?? insight.body
  const description = `${insight.title}. ${first}`.replaceAll(/\s+/gu, ' ').slice(0, 300).trim()
  return [
    '---',
    `name: ${name}`,
    `description: ${yamlScalar(description)}`,
    `when-to-use: ${yamlScalar(`Working in the ${insight.domain} area; before an action this rule constrains.`)}`,
    '---',
    '',
    `# ${insight.title}`,
    '',
    `> Promoted from a dsh-knowledge ${insight.kind} (id \`${insight.id}\`, domain \`${insight.domain}\`, confidence ${insight.confidence}${insight.hits !== undefined ? `, read ${insight.hits}×` : ''}).`,
    '> Edit freely; the link back is in the library lock.',
    '',
    insight.body.trim(),
    '',
    '## Apply it',
    '',
    '- Check the rule holds before the action it constrains; say so in one line when it changed what you did.',
    '- If the rule turns out wrong, tell the user and record the correction with `learn` (supersede the insight) rather than working around it silently.',
    '',
  ].join('\n')
}

function yamlScalar(text: string): string {
  return JSON.stringify(text)
}

export class KnowledgeBridge {
  constructor(private readonly paths: () => StorePaths, private readonly now: () => Date = () => new Date()) {}

  private promotionsPath(): string {
    return join(this.paths().skills, 'promotions.json')
  }

  async promotions(): Promise<PromotionsDoc> {
    return (await readJson(this.promotionsPath(), (): PromotionsDoc => ({ version: 1, promotions: [] }), (raw): PromotionsDoc => {
      const d = raw as Partial<PromotionsDoc>
      if (typeof d !== 'object' || d === null || !Array.isArray(d.promotions)) throw new TypeError('promotions malformed')
      return { version: 1 as const, promotions: d.promotions }
    })).value
  }

  /** Every readable store: global plus each project's. */
  private async stores(): Promise<{ scope: 'global' | 'project', project?: string, nodes: InsightLike[] }[]> {
    const root = this.paths().root
    const out: { scope: 'global' | 'project', project?: string, nodes: InsightLike[] }[] = []
    const read = async (path: string): Promise<InsightLike[]> => {
      try {
        const doc = JSON.parse(await readFile(path, 'utf8')) as { nodes?: unknown }
        return Array.isArray(doc.nodes) ? doc.nodes.filter((n): n is InsightLike => typeof n === 'object' && n !== null && typeof (n as InsightLike).id === 'string' && typeof (n as InsightLike).title === 'string' && typeof (n as InsightLike).body === 'string') : []
      } catch {
        return []
      }
    }
    out.push({ scope: 'global', nodes: await read(join(root, 'knowledge', 'global.json')) })
    try {
      for (const entry of await readdir(join(root, 'projects'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const nodes = await read(join(root, 'projects', entry.name, 'knowledge.json'))
        if (nodes.length > 0) out.push({ scope: 'project', project: entry.name, nodes })
      }
    } catch { /* no projects dir */ }
    return out
  }

  /** Insights worth promoting, best first. */
  async candidates(options: PromoteOptions = {}): Promise<Candidate[]> {
    const o = { ...DEFAULTS, ...options }
    const promoted = new Map((await this.promotions()).promotions.map(p => [p.insightId, p.skill]))
    const out: Candidate[] = []
    for (const store of await this.stores()) {
      for (const n of store.nodes) {
        if (n.retiredAt !== undefined || n.supersededBy !== undefined) continue
        if (!o.kinds.includes(n.kind)) continue
        if ((n.confidence ?? 0) < o.minConfidence && (n.hits ?? 0) < o.minHits) continue
        out.push({ ...n, scope: store.scope, ...(store.project !== undefined ? { project: store.project } : {}), ...(promoted.has(n.id) ? { promotedTo: promoted.get(n.id)! } : {}), skillName: skillNameFor(n.title) })
      }
    }
    return out.sort((a, b) => (b.confidence - a.confidence) || ((b.hits ?? 0) - (a.hits ?? 0)))
  }

  /**
   * Write the skill. Refuses to overwrite an existing local skill of the same
   * name unless `force`; returns the dir so the caller can re-index local.
   */
  async promote(insightId: string, options: { name?: string, force?: boolean } = {}): Promise<{ dir: string, name: string, existed: boolean }> {
    const all = await this.candidates({ minConfidence: 0, minHits: 0, kinds: ['workflow', 'convention', 'preference', 'gotcha', 'architecture', 'candidate'] })
    const insight = all.find(n => n.id === insightId)
    if (insight === undefined) throw new Error(`insight ${insightId} not found in the knowledge stores`)
    const name = options.name ?? insight.skillName
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) throw new Error(`"${name}" is not a valid skill name`)
    const dir = this.paths().skillDir('local', name)
    let existed = false
    try { await readFile(join(dir, 'SKILL.md'), 'utf8'); existed = true } catch { /* free */ }
    if (existed && options.force !== true) throw new Error(`local skill "${name}" already exists; pick another name or force`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), renderSkill(insight, name), 'utf8')
    const doc = await this.promotions()
    await writeJson(this.promotionsPath(), {
      version: 1,
      promotions: [...doc.promotions.filter(p => p.insightId !== insightId), { insightId, skill: name, at: this.now().toISOString(), title: insight.title }],
    })
    return { dir, name, existed }
  }
}
