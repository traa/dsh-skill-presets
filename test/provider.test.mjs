import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, toCandidate, PROVIDER_NAME, RANK } from '../lib/host/provider.js'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** The registry's candidate validation, restated (packages/skill/skill validateCandidate). */
function validateCandidate(c) {
  assert.equal(typeof c.name, 'string'); assert.match(c.name, SKILL_NAME)
  assert.equal(typeof c.description, 'string'); assert.ok(c.description.length > 0)
  assert.equal(typeof c.invocation.modelInvocable, 'boolean'); assert.equal(typeof c.invocation.userInvocable, 'boolean')
  assert.equal(typeof c.source, 'string'); assert.equal(c.provider, PROVIDER_NAME)
  assert.ok(Number.isFinite(c.rank)); assert.equal(c.rank, RANK)
  assert.ok('locator' in c)
  if (c.resourceBase !== undefined) { assert.equal(c.resourceBase.kind, 'directory'); assert.equal(typeof c.resourceBase.path, 'string') }
}

async function skillOnDisk(name, body = 'the body') {
  const dir = await mkdtemp(join(tmpdir(), 'skp-prov-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d ${name}\n---\n${body}`)
  return dir
}

test('list() maps the resolved set to registry-valid candidates', async () => {
  const dir = await skillOnDisk('alpha')
  const provider = createProvider({
    setFor: async () => ({ skills: [{ ref: 's/a', name: 'alpha', description: 'd alpha', modelInvocable: true, userInvocable: true, dir, locked: {}, via: 'preset' }], complete: true }),
  })
  const out = await provider.list({ scope: {}, cwd: '/x' })
  assert.equal(out.complete, true)
  assert.equal(out.candidates.length, 1)
  validateCandidate(out.candidates[0])
  assert.equal(out.candidates[0].metadata.via, 'preset')
})

test('get() re-reads the body and reports the EXPOSED (aliased) name so the registry accepts it', async () => {
  const dir = await skillOnDisk('upstream-name', 'hello body')
  const skill = { ref: 's/x', name: 'my-alias', description: 'd', whenToUse: 'w', modelInvocable: true, userInvocable: false, dir, locked: {}, via: { overlay: 'team' } }
  const provider = createProvider({ setFor: async () => ({ skills: [skill], complete: true }) })
  const candidate = toCandidate(skill)
  assert.equal(candidate.metadata.via, 'overlay:team')
  const def = await provider.get(candidate, {})
  assert.equal(def.name, 'my-alias')
  assert.equal(def.content, 'hello body')
  assert.deepEqual(def.resourceBase, { kind: 'directory', path: dir })
  // Invocation policy is re-read from the file (the source of truth), not the candidate.
  assert.equal(def.invocation.userInvocable, true)
})

test('get() returns undefined for a vanished file; list() propagates incomplete', async () => {
  const provider = createProvider({ setFor: async () => ({ skills: [], complete: false }) })
  assert.equal((await provider.list({})).complete, false)
  assert.equal(await provider.get({ locator: { dir: '/nonexistent/x', ref: 'r', exposedName: 'n' } }, {}), undefined)
  assert.equal(await provider.get({}, {}), undefined)
})
