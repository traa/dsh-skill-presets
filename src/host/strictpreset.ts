/**
 * One-click strict agent preset: copy a shipped agent preset into the user
 * root (`<dshHome>/.agent-presets/<id>`) with its `skill-filesystem` row
 * removed, so every skill the model can see comes from this plugin.
 *
 * Uses the harness's own authoring model — copy, then edit the copy — and
 * never touches the harness checkout. The shipped presets directory is
 * resolved through the profile's `@deepseek-ai/dsh-agent-presets` package,
 * the same way the harness finds it.
 * @module dsh-skill-presets/host/strictpreset
 */

import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { resolveDshHome } from './store.ts'

export interface StrictPresetPlan {
  readonly base: string
  readonly id: string
  readonly sourceDir: string
  readonly targetDir: string
  readonly exists: boolean
  /** Rows the copy will drop. */
  readonly dropRows: string[]
}

export interface StrictPresetOptions {
  profile?: string
  env?: Record<string, string | undefined>
  /** Override where shipped presets live (tests). */
  presetsDir?: string
  /** Rows to remove from the copy; default is the filesystem skill provider. */
  dropRows?: readonly string[]
}

/** Where the shipped presets live, resolved via the profile like the harness does. */
export function shippedPresetsDir(profile = 'web', env: Record<string, string | undefined> = process.env): string {
  const profileDir = join(resolveDshHome(env), 'profiles', profile)
  const req = createRequire(join(profileDir, 'package.json'))
  return join(dirname(req.resolve('@deepseek-ai/dsh-agent-presets/package.json')), 'presets')
}

export function userPresetsDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(env), '.agent-presets')
}

/**
 * Remove whole rows from a cordis composition YAML by id. Rows are `- id: x`
 * items whose body is every following line indented deeper than the dash;
 * a preceding comment block that belongs to the row is dropped too. Pure.
 */
export function dropRowsFromYaml(yaml: string, ids: readonly string[]): { text: string, dropped: string[] } {
  const lines = yaml.split('\n')
  const keep: string[] = []
  const dropped: string[] = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^-\s+id:\s*([A-Za-z0-9_.-]+)\s*$/u)
    if (m !== null && ids.includes(m[1])) {
      dropped.push(m[1])
      // Drop the immediately preceding comment block (attached to this row).
      while (keep.length > 0 && keep[keep.length - 1].trimStart().startsWith('#')) keep.pop()
      i += 1
      while (i < lines.length && (lines[i].trim().length === 0 || /^\s+\S/u.test(lines[i]))) {
        // A blank line ends the row only if the next non-blank line is not indented.
        if (lines[i].trim().length === 0) {
          const next = lines.slice(i + 1).find(l => l.trim().length > 0)
          if (next === undefined || !/^\s+\S/u.test(next)) { i += 1; break }
        }
        i += 1
      }
      continue
    }
    keep.push(lines[i])
    i += 1
  }
  return { text: keep.join('\n').replace(/\n{3,}/gu, '\n\n'), dropped }
}

/** Rename the display name in preset.yml; keep everything else. Pure. */
export function renamePresetYaml(yaml: string, name: string, description?: string): string {
  let out = yaml.replace(/^name:.*$/mu, `name: ${JSON.stringify(name)}`)
  if (!/^name:/mu.test(out)) out = `name: ${JSON.stringify(name)}\n${out}`
  if (description !== undefined) {
    out = /^description:/mu.test(out) ? out.replace(/^description:.*$/mu, `description: ${JSON.stringify(description)}`) : `${out.trimEnd()}\ndescription: ${JSON.stringify(description)}\n`
  }
  return out
}

export async function planStrictPreset(base: string, id: string, options: StrictPresetOptions = {}): Promise<StrictPresetPlan> {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new Error(`preset id "${id}" must be [a-z0-9][a-z0-9-]*`)
  const presetsDir = options.presetsDir ?? shippedPresetsDir(options.profile, options.env)
  const sourceDir = join(presetsDir, base)
  try { await stat(join(sourceDir, 'agent.cordis.yml')) } catch { throw new Error(`no shipped preset "${base}" at ${sourceDir}`) }
  const targetDir = join(userPresetsDir(options.env), id)
  let exists = false
  try { await stat(targetDir); exists = true } catch { /* free */ }
  return { base, id, sourceDir, targetDir, exists, dropRows: [...(options.dropRows ?? ['skill-filesystem'])] }
}

/** Perform the plan. Refuses to overwrite. */
export async function createStrictPreset(plan: StrictPresetPlan, display: { name: string, description?: string }): Promise<{ targetDir: string, dropped: string[] }> {
  if (plan.exists) throw new Error(`${plan.targetDir} already exists; pick another id or delete it first`)
  await mkdir(dirname(plan.targetDir), { recursive: true })
  await cp(plan.sourceDir, plan.targetDir, { recursive: true })
  const compositionPath = join(plan.targetDir, 'agent.cordis.yml')
  const { text, dropped } = dropRowsFromYaml(await readFile(compositionPath, 'utf8'), plan.dropRows)
  await writeFile(compositionPath, text, 'utf8')
  const presetYml = join(plan.targetDir, 'preset.yml')
  let current = ''
  try { current = await readFile(presetYml, 'utf8') } catch { /* absent */ }
  await writeFile(presetYml, renamePresetYaml(current, display.name, display.description), 'utf8')
  return { targetDir: plan.targetDir, dropped }
}

/** List user presets that already drop the filesystem row (i.e. are strict). */
export async function listStrictPresets(env: Record<string, string | undefined> = process.env): Promise<{ id: string, base?: string, name?: string }[]> {
  const root = userPresetsDir(env)
  let names: string[] = []
  try { names = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
  const out: { id: string, base?: string, name?: string }[] = []
  for (const id of names) {
    try {
      const yaml = await readFile(join(root, id, 'agent.cordis.yml'), 'utf8')
      if (/^-\s+id:\s*skill-filesystem\s*$/mu.test(yaml)) continue
      let name: string | undefined
      try { name = (await readFile(join(root, id, 'preset.yml'), 'utf8')).match(/^name:\s*(.+)$/mu)?.[1]?.replace(/^"|"$/gu, '') } catch { /* none */ }
      out.push({ id, ...(name !== undefined ? { name } : {}) })
    } catch { /* not a preset */ }
  }
  return out
}
