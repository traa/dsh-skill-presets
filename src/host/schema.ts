/**
 * JSON Schemas for the workbench data files, derived from the declaration.
 *
 * Generated into `examples/` by `bin/gen-examples`, and a test asserts the
 * checked-in copies match — so the documented format can never drift from what
 * the runtime validates.
 * @module dsh-skill-presets/host/schema
 */

import { CURATED_OVERLAYS, CURATED_PRESETS, CURATED_SOURCES, defaultPractices } from './curated.ts'
import { BUILTIN_NORMALIZE_RULES } from './normalize.ts'

const STAGES = ['plan', 'design', 'build', 'test', 'deploy', 'maintain', 'cross']
const PRACTICE_IDS = defaultPractices().practices.map(p => p.id)

const skillRef = {
  type: 'object',
  additionalProperties: false,
  required: ['ref'],
  properties: {
    ref: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*/[A-Za-z0-9._-]+$', description: '<source-id>/<skill-dir>' },
    as: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', description: 'Exposed name override' },
    whenToUse: { type: 'string' },
  },
}

export const SCHEMAS: Record<string, unknown> = {
  'sources.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'dsh-skill-presets sources',
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'kind', 'enabled'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        title: { type: 'string' },
        kind: { enum: ['github', 'local'] },
        repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
        ref: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        enabled: { type: 'boolean' },
        note: { type: 'string' },
      },
    },
  },
  'presets.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'dsh-skill-presets presets',
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'stage', 'summary', 'skills', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
        title: { type: 'string' },
        stage: { enum: STAGES },
        summary: { type: 'string' },
        color: { type: 'string' },
        skills: { type: 'array', items: skillRef },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
        builtin: { const: true },
      },
    },
  },
  'overlays.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'dsh-skill-presets overlays',
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'when', 'skills', 'enabled'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
        title: { type: 'string' },
        when: { enum: ['tool-visible:team_delegate', 'git-work-tree', 'always'] },
        skills: { type: 'array', items: skillRef },
        enabled: { type: 'boolean' },
      },
    },
  },
  'practices.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'dsh-skill-presets practices',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'strictSkills', 'autoCleanWorktrees', 'pruning', 'instructionFiles', 'protectedBranches', 'practices'],
    properties: {
      version: { const: 1 },
      strictSkills: { type: 'boolean' },
      autoCleanWorktrees: { type: 'boolean' },
      pruning: {
        type: 'object', additionalProperties: false, required: ['minSessions', 'maxLoadRate', 'minUnknown'],
        properties: { minSessions: { type: 'integer', minimum: 1 }, maxLoadRate: { type: 'number', minimum: 0, maximum: 1 }, minUnknown: { type: 'integer', minimum: 1 } },
      },
      instructionFiles: { type: 'array', items: { type: 'string' } },
      protectedBranches: { type: 'array', items: { type: 'string' } },
      practices: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'mode', 'params'],
          properties: {
            id: { enum: PRACTICE_IDS },
            mode: { enum: ['off', 'advisory', 'hard'] },
            params: { type: 'object' },
          },
        },
      },
    },
  },
  'normalize-rules.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'dsh-skill-presets normalize rules',
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'pattern', 'replacement', 'why'],
      properties: {
        id: { type: 'string' },
        pattern: { type: 'string' },
        ignoreCase: { type: 'boolean' },
        replacement: { type: 'string' },
        why: { type: 'string' },
      },
    },
  },
}

/** Example files, byte-for-byte what the bootstrap seeds. */
export const EXAMPLES: Record<string, unknown> = {
  'sources.json': CURATED_SOURCES,
  'presets.json': CURATED_PRESETS,
  'overlays.json': CURATED_OVERLAYS,
  'practices.json': defaultPractices(),
  'normalize-rules.json': BUILTIN_NORMALIZE_RULES,
}

/** Render one file the way the generator and the drift test both do. */
export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
