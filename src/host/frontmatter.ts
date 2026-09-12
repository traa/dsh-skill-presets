/**
 * Minimal `SKILL.md` frontmatter parser.
 *
 * Reads exactly the keys the harness's local provider honours — `name`,
 * `description`, `when-to-use`, `disable-model-invocation`, `user-invocable` —
 * and nothing else. YAML here is the simple `key: value` subset every one of
 * the curated repositories actually uses; a full YAML parser is not a
 * dependency an out-of-tree plugin can take for granted.
 * @module dsh-skill-presets/host/frontmatter
 */

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Whether a string is a valid kebab-case skill name. */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** Parsed skill file. */
export interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  /** Markdown body after the frontmatter. */
  readonly body: string
  /** Every frontmatter key, verbatim, for the UI. */
  readonly raw: Record<string, string>
}

/** Strip matching quotes around a scalar. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\'', '\'')
    }
  }
  return trimmed
}

/** Interpret a YAML-ish boolean. */
function asBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  switch (value.trim().toLowerCase()) {
    case 'true': case 'yes': case 'on': return true
    case 'false': case 'no': case 'off': return false
    default: return undefined
  }
}

/**
 * Split frontmatter from body and parse the simple key/value subset.
 *
 * Supports `key: value`, `key: |` / `key: >` block scalars, and `key:` followed
 * by indented continuation lines.
 * @param text - full file contents.
 * @returns the parsed frontmatter, or undefined when there is none.
 */
export function splitFrontmatter(text: string): { data: Record<string, string>, body: string } | undefined {
  const normalized = text.replace(/^\uFEFF/u, '')
  if (!normalized.startsWith('---')) return undefined
  const firstLineEnd = normalized.indexOf('\n')
  if (firstLineEnd === -1) return undefined
  const rest = normalized.slice(firstLineEnd + 1)
  const close = rest.match(/^---[ \t]*$/mu)
  if (close === null || close.index === undefined) return undefined
  const block = rest.slice(0, close.index)
  const body = rest.slice(close.index + close[0].length).replace(/^(?:[ \t]*\r?\n)+/u, '')

  const data: Record<string, string> = {}
  const lines = block.split(/\r?\n/u)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/u)
    if (match === null) { i += 1; continue }
    const key = match[1]
    let value = match[2].trim()
    if (value === '|' || value === '>' || value === '|-' || value === '>-' || value === '') {
      const parts: string[] = []
      i += 1
      while (i < lines.length && (/^\s+\S/u.test(lines[i]) || lines[i].trim() === '')) {
        if (lines[i].trim() === '' && (i + 1 >= lines.length || !/^\s+\S/u.test(lines[i + 1]))) break
        parts.push(lines[i].replace(/^\s+/u, ''))
        i += 1
      }
      value = value.startsWith('>') ? parts.join(' ').trim() : parts.join('\n').trim()
      data[key] = value
      continue
    }
    data[key] = unquote(value)
    i += 1
  }
  return { data, body }
}

/**
 * Parse a `SKILL.md` into the fields the provider needs.
 * @param text - file contents.
 * @returns the parsed skill, or an error string explaining the rejection.
 */
export function parseSkill(text: string): ParsedSkill | { error: string } {
  const split = splitFrontmatter(text)
  if (split === undefined) return { error: 'missing frontmatter' }
  const { data, body } = split
  const name = data.name?.trim()
  if (name === undefined || name.length === 0) return { error: 'frontmatter lacks name' }
  if (!isSkillName(name)) return { error: `name "${name}" is not kebab-case` }
  const description = (data.description ?? '').replaceAll(/\s+/gu, ' ').trim()
  if (description.length === 0) return { error: 'frontmatter lacks description' }
  const disableModel = asBoolean(data['disable-model-invocation'])
  const userInvocable = asBoolean(data['user-invocable'])
  const whenToUse = data['when-to-use']?.replaceAll(/\s+/gu, ' ').trim()
  return {
    name,
    description,
    ...(whenToUse !== undefined && whenToUse.length > 0 ? { whenToUse } : {}),
    modelInvocable: disableModel !== true,
    userInvocable: userInvocable !== false,
    body,
    raw: data,
  }
}
