#!/usr/bin/env node
/**
 * Write `examples/*.json` and `examples/*.schema.json` from the declaration.
 * `test/examples.test.mjs` fails when the checked-in copies differ.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXAMPLES, SCHEMAS, renderJson } from '../host/schema.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'examples')
await mkdir(out, { recursive: true })
for (const [name, value] of Object.entries({ ...EXAMPLES, ...SCHEMAS })) {
  await writeFile(join(out, name), renderJson(value), 'utf8')
  console.log(`wrote examples/${name}`)
}
