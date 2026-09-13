/**
 * Plan-drift: does the diff stay inside what `plan.md` names?
 *
 * Paths are read from the plan's backticked spans and bare path-like tokens;
 * a directory mention covers everything below it; `*` and `**` are honoured.
 * Pure — the index feeds it the plan text and an edited path.
 * @module dsh-skill-presets/host/practices/plan
 */

import { isAbsolute, relative, sep } from 'node:path'

/** Extract file/dir path patterns from plan markdown. */
export function planPaths(markdown: string): string[] {
  const out = new Set<string>()
  const consider = (raw: string): void => {
    const token = raw.trim().replace(/^\.\//u, '').replace(/[),.;:]+$/u, '')
    if (token.length === 0 || token.includes(' ') || token.startsWith('http') || token.startsWith('-')) return
    // Looks like a path: has a slash, or a file extension, or a glob.
    if (!/[/*]/u.test(token) && !/\.[a-z0-9]{1,6}$/iu.test(token)) return
    if (/^[a-z]+:\/\//u.test(token)) return
    out.add(token)
  }
  for (const m of markdown.matchAll(/`([^`\n]+)`/gu)) consider(m[1])
  for (const m of markdown.matchAll(/(?:^|[\s(])((?:[\w.-]+\/)+[\w.*-]+)/gmu)) consider(m[1])
  // Bare filenames with a real extension (README.md, package.json) — but not
  // abbreviations like "e.g." or "i.e.", which have no letters after the dot run.
  for (const m of markdown.matchAll(/(?:^|[\s(])([A-Za-z0-9_-]+\.(?:md|json|ya?ml|ts|tsx|js|mjs|cjs|py|rs|go|toml|txt|sh))(?=[\s),.;:]|$)/gmu)) consider(m[1])
  return [...out]
}

/** Glob → RegExp (`**` any depth, `*` one segment). */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.split('**').map(part => part.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')).join('.*')
  return new RegExp(`^${escaped}$`, 'u')
}

/**
 * Whether an edited path is covered by the plan.
 * @param edited - path as the tool saw it (absolute or relative).
 * @param topLevel - repository top level, to relativise absolute paths.
 * @param patterns - from {@link planPaths}.
 */
export function coveredByPlan(edited: string, topLevel: string | undefined, patterns: readonly string[]): boolean {
  let rel = edited
  if (isAbsolute(edited)) {
    if (topLevel === undefined) return true // cannot judge; never accuse
    rel = relative(topLevel, edited)
    if (rel.startsWith('..')) return true // outside the repo: not this plan's business
  }
  rel = rel.split(sep).join('/')
  for (const pattern of patterns) {
    const p = pattern.replace(/\/$/u, '')
    if (rel === p) return true
    if (rel.startsWith(`${p}/`)) return true // directory mention
    if (/[*]/u.test(p) && globToRegExp(p).test(rel)) return true
    // A bare filename in the plan matches that file anywhere.
    if (!p.includes('/') && rel.endsWith(`/${p}`)) return true
  }
  return false
}

/** Files the plan itself lives in never count as drift. */
export function isPlanArtifact(path: string): boolean {
  return /(?:^|\/)docs\/sdlc\/.*\.md$|(?:^|\/)(?:intent|spec|plan)\.md$/u.test(path.split(sep).join('/'))
}
