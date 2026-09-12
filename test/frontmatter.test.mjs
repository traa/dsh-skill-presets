import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSkill, splitFrontmatter, isSkillName } from '../lib/host/frontmatter.js'

// Real frontmatter shapes from the three curated sources.
const SUPERPOWERS = `---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans
body`

const ADDY = `---
name: planning-and-task-breakdown
description: Breaks work into ordered tasks. Use when you have a spec and need to break work into implementable tasks. Use when a task feels too large to start.
---
# Planning`

const MATT = `---
name: tdd
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---
# TDD`

test('parses the three curated frontmatter shapes', () => {
  for (const [text, name] of [[SUPERPOWERS, 'writing-plans'], [ADDY, 'planning-and-task-breakdown'], [MATT, 'tdd']]) {
    const parsed = parseSkill(text)
    assert.ok(!('error' in parsed), JSON.stringify(parsed))
    assert.equal(parsed.name, name)
    assert.ok(parsed.description.length > 10)
    assert.equal(parsed.modelInvocable, true)
    assert.equal(parsed.userInvocable, true)
    assert.ok(parsed.body.startsWith('# '))
  }
})

test('honours the harness invocation keys and when-to-use', () => {
  const parsed = parseSkill(`---
name: x-y
description: "quoted desc"
when-to-use: >
  first line
  second line
disable-model-invocation: true
user-invocable: no
---
body`)
  assert.ok(!('error' in parsed))
  assert.equal(parsed.description, 'quoted desc')
  assert.equal(parsed.whenToUse, 'first line second line')
  assert.equal(parsed.modelInvocable, false)
  assert.equal(parsed.userInvocable, false)
})

test('rejects missing frontmatter, missing name, bad name, missing description', () => {
  assert.deepEqual(parseSkill('# no frontmatter'), { error: 'missing frontmatter' })
  assert.deepEqual(parseSkill('---\ndescription: d\n---\n'), { error: 'frontmatter lacks name' })
  assert.match(parseSkill('---\nname: Bad_Name\ndescription: d\n---\n').error, /kebab-case/)
  assert.deepEqual(parseSkill('---\nname: ok\n---\n'), { error: 'frontmatter lacks description' })
})

test('block scalars and a BOM are handled', () => {
  const split = splitFrontmatter('\uFEFF---\nname: a\ndescription: |\n  line one\n  line two\n---\nbody')
  assert.equal(split.data.description, 'line one\nline two')
  assert.equal(split.body, 'body')
})

test('isSkillName', () => {
  assert.ok(isSkillName('a-b-c1'))
  assert.ok(!isSkillName('A'))
  assert.ok(!isSkillName('a--b'))
  assert.ok(!isSkillName('-a'))
})
