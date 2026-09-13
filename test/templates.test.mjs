import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTemplates, validateTemplate, toBlueprintInput } from '../lib/host/templates.js'

test('the shipped templates validate, name the practice skills, and inherit the provider', async () => {
  const { templates, problems } = await loadTemplates()
  assert.deepEqual(problems, [])
  assert.deepEqual(templates.map(t => t.id).sort(), ['sdlc-build-team', 'sdlc-review-board'])
  for (const t of templates) {
    assert.match(t.conductorInstructions, /conductor-protocol/)
    for (const m of t.members) { assert.equal(m.provider, undefined); assert.equal(m.model, undefined); assert.equal(m.engine, 'harness') }
    const input = toBlueprintInput(t)
    assert.deepEqual(Object.keys(input).sort(), ['conductorInstructions', 'members', 'name', 'objective'])
  }
  const build = templates.find(t => t.id === 'sdlc-build-team')
  assert.match(build.conductorInstructions, /worktree-first/)
  assert.match(build.conductorInstructions, /pr-always/)
  assert.deepEqual(build.members.find(m => m.id === 'reviewer').reviews, ['implementer'])
})

test('validateTemplate rejects the shapes agent-teams would reject', () => {
  const ok = { id: 'x', name: 'X', objective: 'o', conductorInstructions: 'c', members: [{ id: 'a', name: 'A', responsibility: 'r' }] }
  assert.equal(validateTemplate(ok).members[0].engine, 'harness')
  assert.throws(() => validateTemplate({ ...ok, members: [] }), /non-empty/)
  assert.throws(() => validateTemplate({ ...ok, members: [ok.members[0], { id: 'b', name: 'A', responsibility: 'r' }] }), /two members are named/)
  assert.throws(() => validateTemplate({ ...ok, members: [{ ...ok.members[0], reviews: ['ghost'] }] }), /unknown member/)
  assert.throws(() => validateTemplate({ ...ok, members: [{ ...ok.members[0], engine: 'cli' }] }), /cliProvider/)
  assert.throws(() => validateTemplate({ ...ok, conductorInstructions: '' }), /conductorInstructions/)
})
