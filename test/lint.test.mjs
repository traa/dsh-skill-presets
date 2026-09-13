import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintSkillText, lintLibrary } from '../lib/host/lint.js'
import { normalizeText } from '../lib/host/normalize.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const skill = (fm, body = 'body') => `---\n${fm}\n---\n${body}`

test('content rules: trigger, when-to-use, long description, long body, vendor terms with line numbers', () => {
  const clean = lintSkillText(skill('name: a\ndescription: Use when starting a task.\nwhen-to-use: x'))
  assert.deepEqual(clean, [])
  const topic = lintSkillText(skill('name: a\ndescription: Git workflow practices.'))
  assert.deepEqual(topic.map(f => f.rule).sort(), ['no-trigger', 'no-when-to-use'])
  const vendor = lintSkillText(skill('name: a\ndescription: Use when x.\nwhen-to-use: y', 'Read CLAUDE.md.\nThen call TodoWrite.'))
  // Line numbers are file lines (the 5-line frontmatter comes first).
  assert.deepEqual(vendor.map(f => [f.rule, f.line]), [['vendor-term', 6], ['vendor-term', 7]])
  assert.equal(vendor[0].severity, 'error')
  const long = lintSkillText(skill('name: a\ndescription: Use when x.\nwhen-to-use: y', Array.from({ length: 301 }, () => 'l').join('\n')))
  assert.ok(long.some(f => f.rule === 'long-body'))
  assert.equal(lintSkillText('# no frontmatter')[0].rule, 'frontmatter')
  // A word that merely CONTAINS a term is not a hit (word boundary on the left).
  assert.deepEqual(lintSkillText(skill('name: a\ndescription: Use when x.\nwhen-to-use: y', 'autocopilot mode')).filter(f => f.rule === 'vendor-term'), [])
})

test('the normalize rules remove every vendor term the lint knows for the phrasings seen upstream', () => {
  const upstream = 'Use the `AskUserQuestion` tool. Want a second opinion? Options: Gemini CLI, Codex CLI, Copilot. See CLAUDE.md and ~/.claude/skills/x. Call TodoWrite.'
  const { text } = normalizeText(upstream)
  const findings = lintSkillText(skill('name: a\ndescription: Use when x.\nwhen-to-use: y', text)).filter(f => f.rule === 'vendor-term')
  assert.deepEqual(findings, [], text)
})

test('the shipped local skills lint clean of errors and warnings', async () => {
  const dir = join(ROOT, 'skills')
  for (const name of await readdir(dir)) {
    const text = await readFile(join(dir, name, 'SKILL.md'), 'utf8')
    const bad = lintSkillText(text).filter(f => f.severity !== 'info')
    assert.deepEqual(bad, [], `${name}: ${JSON.stringify(bad)}`)
  }
})

test('lintLibrary adds the usage rule and counts by severity', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { StorePaths } = await import('../lib/host/store.js')
  const root = await mkdtemp(join(tmpdir(), 'skp-lint-'))
  const paths = new StorePaths(root)
  await mkdir(paths.skillDir('s', 'x'), { recursive: true })
  await writeFile(join(paths.skillDir('s', 'x'), 'SKILL.md'), skill('name: x\ndescription: Use when y.\nwhen-to-use: z'))
  const lock = { version: 1, sources: {}, skills: [{ source: 's', dir: 'x', name: 'x', description: 'd', digest: 'd', normalized: false, commit: 'c', installedAt: 't', files: 1 }, { source: 's', dir: 'gone', name: 'gone', description: 'd', digest: 'd', normalized: false, commit: 'c', installedAt: 't', files: 1 }] }
  const rollup = { version: 1, updatedAt: '', sessions: 0, skills: { x: { sessionsOffered: 40, sessionsLoaded: 0, loads: 0, firstLoadTurnSum: 0, chars: 0 } }, presets: {}, practices: {}, unknownRequests: {}, coUsage: {}, byModel: {}, suggestions: { suggested: 0, accepted: 0, dismissed: 0, acceptMsSum: 0 } }
  const lint = await lintLibrary(lock, paths, rollup)
  assert.deepEqual(lint.byRef['s/x'].map(f => f.rule), ['unused'])
  assert.equal(lint.byRef['s/gone'][0].rule, 'missing-file')
  assert.deepEqual(lint.counts, { error: 1, warn: 0, info: 1 })
})
