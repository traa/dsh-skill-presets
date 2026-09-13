/**
 * Provider-neutral normalization of upstream skill text.
 *
 * The curated sources were written for one vendor's agent: they name its tools
 * (`Task`, `TodoWrite`, `Skill(...)`), its slash commands, and its instructions
 * file. The harness has its own vocabulary and runs any provider, so the text is
 * rewritten on install by DATA rules, each recorded with its reason. The
 * upstream digest is kept so the UI can show the diff, and a skill can opt out.
 * @module dsh-skill-presets/host/normalize
 */

import type { NormalizeRule } from './types.ts'

/** Rules shipped with the plugin; the workbench may override the file. */
export const BUILTIN_NORMALIZE_RULES: readonly NormalizeRule[] = [
  {
    id: 'vendor-home-path',
    pattern: '~/\\.(?:claude|codex|gemini)/(?:skills/)?',
    replacement: '<your agent home>/skills/',
    why: 'Vendor home directories are not where the harness keeps skills; the workbench library is.',
  },
  {
    id: 'instructions-file',
    pattern: '\\b(?:CLAUDE|GEMINI)\\.md\\b',
    replacement: 'your project\'s instructions file (AGENTS.md or equivalent)',
    why: 'The harness runs any provider; the instructions file is whatever the project configured.',
  },
  {
    id: 'skill-tool-namespace',
    pattern: '\\bsuperpowers:([a-z0-9-]+)',
    replacement: 'the `$1` skill',
    why: 'Skills are addressed by bare name through the `skill` tool; there is no plugin namespace.',
  },
  {
    id: 'skill-tool-call',
    pattern: '\\bSkill\\((?:name=)?["\']?([a-z0-9-]+)["\']?\\)',
    replacement: 'skill({ name: "$1" })',
    why: 'The harness skill loader is the `skill` tool.',
  },
  {
    id: 'todo-tool',
    pattern: '\\bTodoWrite\\b',
    replacement: 'todo_write',
    why: 'The harness todo tool is `todo_write`.',
  },
  {
    id: 'subagent-tool',
    pattern: '\\b(?:the )?Task tool\\b',
    ignoreCase: true,
    replacement: 'the `subagent` tool',
    why: 'Delegation in the harness goes through `subagent` (or `team_delegate` with a team attached).',
  },
  {
    id: 'subagent-type',
    pattern: '\\bsubagent_type\\b',
    replacement: 'subagent prompt',
    why: 'The harness has no typed subagent roster; the prompt carries the role.',
  },
  {
    id: 'slash-commands',
    pattern: '(^|\\s)/(security-review|commit|review|init)\\b',
    replacement: '$1the corresponding skill or tool if available (`$2`)',
    why: 'Vendor slash commands are not part of the harness; the equivalent is a skill or tool when one exists.',
  },
  {
    id: 'ask-user-tool',
    pattern: '`?AskUserQuestion`?(?:\\s+tool)?',
    replacement: 'the `ask_user_question` tool',
    why: 'The harness asks the user through `ask_user_question`.',
  },
  {
    id: 'cross-model-vendors',
    pattern: '\\b(?:Codex CLI|Gemini CLI|Copilot CLI|Copilot|Cursor IDE)\\b',
    replacement: 'another configured provider',
    why: 'A second opinion comes from whatever other provider the harness has; the text must not name one.',
  },
  {
    id: 'vendor-agent-name',
    pattern: '\\bClaude Code\\b',
    replacement: 'the coding agent',
    why: 'The text must read correctly under any provider.',
  },
]

/** Result of normalizing one file. */
export interface Normalized {
  readonly text: string
  /** Rule ids that changed something. */
  readonly applied: readonly string[]
}

/**
 * Compile one rule to a RegExp, or return undefined when the pattern is invalid.
 * @param rule - the data rule.
 */
export function compileRule(rule: NormalizeRule): RegExp | undefined {
  try {
    return new RegExp(rule.pattern, `g${rule.ignoreCase === true ? 'i' : ''}u`)
  } catch {
    return undefined
  }
}

/**
 * Apply the rules to one text.
 * @param text - upstream content.
 * @param rules - rules in order.
 * @returns the rewritten text and which rules fired.
 */
export function normalizeText(text: string, rules: readonly NormalizeRule[] = BUILTIN_NORMALIZE_RULES): Normalized {
  let current = text
  const applied: string[] = []
  for (const rule of rules) {
    const regex = compileRule(rule)
    if (regex === undefined) continue
    const next = current.replace(regex, rule.replacement)
    if (next !== current) {
      applied.push(rule.id)
      current = next
    }
  }
  return { text: current, applied }
}

/** Validate a rules file read from the workbench; malformed entries are dropped. */
export function validateRules(raw: unknown): NormalizeRule[] {
  if (!Array.isArray(raw)) throw new TypeError('normalize rules must be an array')
  const rules: NormalizeRule[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const rule = entry as Partial<NormalizeRule>
    if (typeof rule.id !== 'string' || typeof rule.pattern !== 'string' || typeof rule.replacement !== 'string') continue
    rules.push({
      id: rule.id,
      pattern: rule.pattern,
      replacement: rule.replacement,
      why: typeof rule.why === 'string' ? rule.why : '',
      ...(rule.ignoreCase === true ? { ignoreCase: true } : {}),
    })
  }
  return rules
}

/** Only Markdown/text files are rewritten; scripts and other resources stay byte-identical. */
export function isNormalizable(path: string): boolean {
  return /\.(?:md|markdown|txt)$/iu.test(path)
}
