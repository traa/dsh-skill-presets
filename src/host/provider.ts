/**
 * The `SkillProvider` that exposes the active preset (plus overlays) to the
 * harness skill registry.
 *
 * Registered from a host row it lands in the GLOBAL layer, so the set reaches
 * every agent preset. `list()` receives the viewing scope (the live Agent), so
 * overlay conditions — a team attached, a git repository — are evaluated per
 * agent, and `control.invalidate()` is the single lever that makes a change
 * visible: `dsh-tool-skill` republishes the catalog at the next step.
 * @module dsh-skill-presets/host/provider
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkill } from './frontmatter.ts'
import type { ResolvedSkill } from './presets.ts'

/** The registry's candidate shape, restated structurally so no runtime import of `@deepseek-ai/dsh-skill` is needed. */
export interface SkillCandidateLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { readonly modelInvocable: boolean, readonly userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly path?: string
  readonly resourceBase?: { readonly kind: 'directory', readonly path: string }
  readonly rank: number
  readonly locator: unknown
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SkillDefinitionLike extends Omit<SkillCandidateLike, 'rank' | 'locator'> {
  readonly content: string
}

export interface LookupLike {
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly scope?: object
}

export interface SkillProviderLike {
  readonly name: string
  list(options: LookupLike): Promise<{ candidates: readonly SkillCandidateLike[], complete: boolean }>
  get(candidate: SkillCandidateLike, options: LookupLike): Promise<SkillDefinitionLike | undefined>
}

export const PROVIDER_NAME = 'skill-presets'
export const SOURCE_LABEL = 'preset'
/** Same rank as `customSkillDirs`, below project skills, above user skills. */
export const RANK = 300

interface Locator {
  readonly ref: string
  readonly dir: string
  readonly exposedName: string
}

/** What the provider needs from the plugin: the set for a given scope. */
export interface ProviderDeps {
  /** Resolve the exposed set for the viewing agent. Never throws. */
  setFor(scope: object | undefined, cwd: string | undefined, signal?: AbortSignal): Promise<{ skills: ResolvedSkill[], complete: boolean }>
}

/** Build the provider object. */
export function createProvider(deps: ProviderDeps): SkillProviderLike {
  return {
    name: PROVIDER_NAME,
    async list(options) {
      const { skills, complete } = await deps.setFor(options.scope, options.cwd, options.signal)
      const candidates: SkillCandidateLike[] = skills.map(skill => toCandidate(skill))
      return { candidates, complete }
    },
    async get(candidate) {
      const locator = candidate.locator as Locator | undefined
      if (locator === undefined) return undefined
      let text: string
      try {
        text = await readFile(join(locator.dir, 'SKILL.md'), 'utf8')
      } catch {
        return undefined
      }
      const parsed = parseSkill(text)
      if ('error' in parsed) return undefined
      return {
        // The registry rejects a definition whose name differs from the
        // candidate's, so an `as` alias must be reported as the exposed name.
        name: locator.exposedName,
        description: parsed.description,
        ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
        invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
        source: SOURCE_LABEL,
        provider: PROVIDER_NAME,
        path: join(locator.dir, 'SKILL.md'),
        resourceBase: { kind: 'directory', path: locator.dir },
        content: parsed.body,
        metadata: { ref: locator.ref },
      }
    },
  }
}

/** Map a resolved skill to a registry candidate. */
export function toCandidate(skill: ResolvedSkill): SkillCandidateLike {
  const locator: Locator = { ref: skill.ref, dir: skill.dir, exposedName: skill.name }
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
    source: SOURCE_LABEL,
    provider: PROVIDER_NAME,
    path: join(skill.dir, 'SKILL.md'),
    resourceBase: { kind: 'directory', path: skill.dir },
    rank: RANK,
    locator,
    metadata: { ref: skill.ref, via: skill.via === 'preset' ? 'preset' : `overlay:${skill.via.overlay}` },
  }
}
