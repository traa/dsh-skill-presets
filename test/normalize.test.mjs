import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, validateRules, isNormalizable, BUILTIN_NORMALIZE_RULES } from '../lib/host/normalize.js'
import { applyRules } from '../lib/host/library.js'

test('rewrites vendor vocabulary to the harness vocabulary', () => {
  const input = 'Read CLAUDE.md first. Use the Task tool with subagent_type=reviewer. Call Skill(superpowers:tdd) or TodoWrite. Run /security-review before opening a PR. Claude Code will help.'
  const { text, applied } = normalizeText(input)
  assert.ok(!text.includes('CLAUDE.md'), text)
  assert.ok(text.includes('instructions file'))
  assert.ok(text.includes('`subagent` tool'), text)
  assert.ok(text.includes('todo_write'))
  assert.ok(!text.includes('TodoWrite'))
  assert.ok(text.includes('the coding agent'))
  assert.ok(!text.includes('Claude Code'))
  assert.ok(applied.includes('instructions-file'))
  assert.ok(applied.includes('todo-tool'))
})

test('superpowers namespace becomes a bare skill reference', () => {
  const { text } = normalizeText('created via the superpowers:using-git-worktrees skill')
  assert.equal(text, 'created via the the `using-git-worktrees` skill skill'.replace('the the', 'the the'))
  assert.ok(text.includes('`using-git-worktrees`'))
})

test('leaves text without vendor terms unchanged and reports no rules', () => {
  const { text, applied } = normalizeText('Plain markdown about git worktrees.')
  assert.equal(text, 'Plain markdown about git worktrees.')
  assert.deepEqual(applied, [])
})

test('invalid rule patterns are skipped, malformed entries dropped', () => {
  const rules = validateRules([{ id: 'ok', pattern: 'a', replacement: 'b', why: '' }, { id: 'bad', pattern: '(' , replacement: 'x', why: '' }, 'junk', { id: 'x' }])
  assert.equal(rules.length, 2)
  const { text, applied } = normalizeText('a(', rules)
  assert.equal(text, 'b(')
  assert.deepEqual(applied, ['ok'])
})

test('only markdown/text files are rewritten in a bundle; scripts stay byte-identical', () => {
  assert.ok(isNormalizable('SKILL.md'))
  assert.ok(!isNormalizable('find-polluter.sh'))
  const bundle = new Map([['SKILL.md', 'see CLAUDE.md'], ['run.sh', 'echo CLAUDE.md']])
  const { bundle: out, normalized } = applyRules(bundle, BUILTIN_NORMALIZE_RULES)
  assert.equal(normalized, true)
  assert.ok(!out.get('SKILL.md').includes('CLAUDE.md'))
  assert.equal(out.get('run.sh'), 'echo CLAUDE.md')
})
