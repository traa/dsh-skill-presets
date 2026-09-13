/**
 * Skill lint: provider-neutrality and routing quality of the library.
 *
 * Content rules run over the parsed SKILL.md (vendor terms the normalize rules
 * missed, a description with no trigger, no `when-to-use`, an over-long body);
 * usage rules run over the rollup (offered often, never loaded). Pure; the
 * shipped local skills must lint clean in `npm test`, and every install/update
 * reports findings per skill so an upstream change that re-introduces
 * `CLAUDE.md` is visible the moment it lands.
 * @module dsh-skill-presets/host/lint
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkill } from './frontmatter.ts'
import type { StorePaths } from './store.ts'
import type { Lock, Rollup } from './types.ts'

export type LintSeverity = 'error' | 'warn' | 'info'

export interface LintFinding {
  readonly rule: string
  readonly severity: LintSeverity
  readonly message: string
  readonly line?: number
}

/** Vendor terms that must not survive normalization. Case-insensitive, word-bounded. */
export const VENDOR_TERMS: readonly string[] = [
  'CLAUDE\\.md', 'GEMINI\\.md', '\\.claude/', '\\.codex/', '\\.gemini/', '\\.cursor/',
  'Claude Code', 'Codex CLI', 'Gemini CLI', 'Cursor IDE', 'Copilot',
  'TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'WebFetch\\b', 'subagent_type',
  'superpowers:', '\\$\\{CLAUDE_PLUGIN_ROOT\\}', 'claude-docs',
]

const TRIGGER = /\b(?:use (?:when|before|after|whenever|for)|when (?:you|the user|a|an|starting|about|asked)|before (?:you|writing|editing|committing|opening)|whenever)\b/iu

export interface LintOptions {
  maxBodyLines?: number
  /** Skip vendor-term checks for these dirs (e.g. a skill ABOUT vendor tooling). */
  allowVendorTerms?: readonly string[]
}

/** Lint one skill's text. Pure. */
export function lintSkillText(text: string, options: LintOptions = {}): LintFinding[] {
  const findings: LintFinding[] = []
  const parsed = parseSkill(text)
  if ('error' in parsed) return [{ rule: 'frontmatter', severity: 'error', message: parsed.error }]
  if (!TRIGGER.test(parsed.description) && parsed.whenToUse === undefined) {
    findings.push({ rule: 'no-trigger', severity: 'warn', message: 'description states a topic but not a trigger ("Use when …"); the model matches tasks against it' })
  }
  if (parsed.whenToUse === undefined) findings.push({ rule: 'no-when-to-use', severity: 'info', message: 'no `when-to-use` frontmatter; a second routing hint helps the catalog' })
  if (parsed.description.length > 400) findings.push({ rule: 'long-description', severity: 'warn', message: `description is ${parsed.description.length} chars; the catalog truncates at 500 and long ones dilute matching` })
  const bodyLines = parsed.body.split('\n').length
  const max = options.maxBodyLines ?? 300
  if (bodyLines > max) findings.push({ rule: 'long-body', severity: 'warn', message: `body is ${bodyLines} lines (> ${max}); every load costs ~${Math.round(parsed.body.length / 4)} tokens — split or move reference material into sibling files` })
  const lines = text.split('\n')
  for (const term of VENDOR_TERMS) {
    const re = new RegExp(`(?<![A-Za-z0-9_-])${term}`, 'iu')
    const at = lines.findIndex(l => re.test(l))
    if (at !== -1) findings.push({ rule: 'vendor-term', severity: 'error', message: `vendor-specific term /${term}/ at line ${at + 1}: "${lines[at].trim().slice(0, 80)}"`, line: at + 1 })
  }
  return findings
}

export interface LibraryLint {
  /** ref → findings (only refs with findings). */
  readonly byRef: Record<string, LintFinding[]>
  readonly counts: { error: number, warn: number, info: number }
}

/**
 * Lint every installed skill (content) plus usage rules from the rollup.
 * @param never - a skill offered in ≥ this many sessions with zero loads gets an `unused` info.
 */
export async function lintLibrary(lock: Lock, paths: StorePaths, rollup?: Rollup, options: LintOptions & { neverLoadedAfter?: number } = {}): Promise<LibraryLint> {
  const byRef: Record<string, LintFinding[]> = {}
  const counts = { error: 0, warn: 0, info: 0 }
  for (const s of lock.skills) {
    if (s.orphaned === true) continue
    const ref = `${s.source}/${s.dir}`
    let text: string
    try { text = await readFile(join(paths.skillDir(s.source, s.dir), 'SKILL.md'), 'utf8') } catch { byRef[ref] = [{ rule: 'missing-file', severity: 'error', message: 'SKILL.md missing on disk' }]; counts.error += 1; continue }
    const findings = lintSkillText(text, options).filter(f => !(f.rule === 'vendor-term' && options.allowVendorTerms?.includes(s.dir) === true))
    const stats = rollup?.skills[s.name]
    const threshold = options.neverLoadedAfter ?? 30
    if (stats !== undefined && stats.sessionsOffered >= threshold && stats.loads === 0) {
      findings.push({ rule: 'unused', severity: 'info', message: `offered in ${stats.sessionsOffered} sessions, never loaded — check the description's trigger or remove from the preset` })
    }
    if (findings.length > 0) {
      byRef[ref] = findings
      for (const f of findings) counts[f.severity] += 1
    }
  }
  return { byRef, counts }
}
