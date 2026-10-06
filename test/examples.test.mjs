// The checked-in examples and schemas are generated from the declaration; a
// mismatch means someone edited one side without the other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXAMPLES, SCHEMAS, renderJson } from '../lib/host/schema.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('examples/ matches the declaration (run `npm run gen:examples` after changing curated.ts)', async () => {
  for (const [name, value] of Object.entries({ ...EXAMPLES, ...SCHEMAS })) {
    const onDisk = await readFile(join(ROOT, 'examples', name), 'utf8')
    assert.equal(onDisk, renderJson(value), `examples/${name} drifted`)
  }
})

test('sources.schema.json admits a `skills` pick list of { path } objects', () => {
  const item = SCHEMAS['sources.schema.json'].items
  const skills = item.properties.skills
  assert.ok(skills, 'sources.schema.json has additionalProperties: false, so `skills` must be declared')
  assert.equal(skills.type, 'array')
  assert.equal(skills.items.type, 'object')
  assert.deepEqual(skills.items.required, ['path'])
  assert.equal(skills.items.properties.path.type, 'string')
})

test('every curated preset skill ref names a local skill that ships, or an upstream dir', async () => {
  const presets = EXAMPLES['presets.json']
  const { readdir } = await import('node:fs/promises')
  const shipped = new Set(await readdir(join(ROOT, 'skills')))
  for (const preset of presets) {
    for (const s of preset.skills) {
      const [source, dir] = s.ref.split('/')
      if (source === 'local' && !['gemini-agent', 'qoder-agent'].includes(dir)) {
        assert.ok(shipped.has(dir), `${preset.id} references local/${dir} which is not in skills/`)
      }
    }
  }
})
