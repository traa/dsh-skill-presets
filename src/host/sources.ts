/**
 * Validation of one skill source, shared by `sources.json` (service) and by
 * sources arriving in a shared bundle (`planImport`), so both admit exactly
 * the same shapes. Kept free of service imports so `bundle.ts` can use it
 * without an import cycle.
 * @module dsh-skill-presets/host/sources
 */

import type { SkillSource } from './types.ts'

/** The last segment of a pick path: the skill's `dir`. */
export function pickDir(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Whether a string contains a control character (U+0000–U+001F, U+007F). */
export function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Whether a pick path is a safe repo-relative directory: non-empty, not
 * absolute, no backslash, no control character, and no empty, `.` or `..`
 * segment.
 */
function isSafePickPath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || hasControlChar(path)) return false
  return path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

/**
 * The picks of a source. `undefined`/`null` read as absent (`[]`). Any other
 * non-array is malformed: `undefined` is returned and the caller drops the
 * source rather than let it fall back to a whole-repository install. For an
 * array, each entry that is not `{ path: string }` or whose path is unsafe is
 * dropped on its own; the remaining safe picks are returned, first one wins
 * per `dir`.
 */
function validatePicks(raw: unknown): { path: string }[] | undefined {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return undefined
  const out: { path: string }[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const path: unknown = (entry as { path?: unknown }).path
    if (typeof path !== 'string' || !isSafePickPath(path)) continue
    if (out.some(pick => pickDir(pick.path) === pickDir(path))) continue
    out.push({ path })
  }
  return out
}

/**
 * Validate one source entry; `undefined` drops it. Never throws.
 *
 * `skills` absent, `null` or `[]` means a whole-repository source (scan
 * `paths`). An array keeps its safe `{ path: string }` entries and drops the
 * rest one by one. A non-array `skills` value, or a non-empty array with no
 * safe pick left, drops the whole source: keeping it without picks would
 * silently install the whole repository.
 */
export function validateSource(entry: unknown): SkillSource | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const s = entry as Partial<Record<keyof SkillSource, unknown>>
  if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(s.id)) return undefined
  const kind = s.kind === 'local' ? 'local' : 'github'
  if (kind === 'github' && (typeof s.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(s.repo))) return undefined
  const skills = validatePicks(s.skills)
  if (skills === undefined) return undefined
  if (Array.isArray(s.skills) && s.skills.length > 0 && skills.length === 0) return undefined
  const paths = Array.isArray(s.paths) && s.paths.every((p: unknown) => typeof p === 'string') ? s.paths.filter((p: unknown): p is string => typeof p === 'string') : undefined
  return {
    id: s.id,
    title: typeof s.title === 'string' ? s.title : s.id,
    kind,
    ...(typeof s.repo === 'string' ? { repo: s.repo } : {}),
    ...(typeof s.ref === 'string' ? { ref: s.ref } : {}),
    ...(paths !== undefined ? { paths } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    enabled: s.enabled !== false,
    ...(typeof s.note === 'string' ? { note: s.note } : {}),
  }
}
