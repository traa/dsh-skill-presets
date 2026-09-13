import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPaths, coveredByPlan, isPlanArtifact } from '../lib/host/practices/plan.js'
import { detectPlanDrift } from '../lib/host/practices/detectors.js'
import { workRootOf, currentWorkRoot, leadingCd } from '../lib/host/practices/workroot.js'

const PLAN = `# Plan
Files: \`src/host/types.ts\`, \`src/host/store.ts\` (migrate), and everything under \`src/client/\`.
Tests: test/*.test.mjs. Also touch README.md and the glob \`docs/**/*.md\`.
See https://example.com/not-a-path and the word e.g. in prose.
`

test('planPaths pulls backticked and bare path tokens, ignores URLs and prose', () => {
  const paths = planPaths(PLAN)
  for (const expected of ['src/host/types.ts', 'src/host/store.ts', 'src/client/', 'test/*.test.mjs', 'README.md', 'docs/**/*.md']) {
    assert.ok(paths.includes(expected), `${expected} in ${JSON.stringify(paths)}`)
  }
  assert.ok(!paths.some(p => p.includes('example.com')))
  assert.ok(!paths.includes('e.g'))
})

test('coveredByPlan: exact, directory, glob, bare filename, outside-repo, unknown top level', () => {
  const p = planPaths(PLAN)
  const top = '/repo'
  assert.ok(coveredByPlan('/repo/src/host/types.ts', top, p))
  assert.ok(coveredByPlan('src/client/views.ts', top, p))
  assert.ok(coveredByPlan('test/foo.test.mjs', top, p))
  assert.ok(coveredByPlan('docs/sdlc/x/plan.md', top, p))
  assert.ok(coveredByPlan('/repo/packages/x/README.md', top, p), 'bare filename matches anywhere')
  assert.ok(!coveredByPlan('/repo/src/host/github.ts', top, p))
  assert.ok(coveredByPlan('/elsewhere/file.ts', top, p), 'outside the repo is not drift')
  assert.ok(coveredByPlan('/repo/anything.ts', undefined, p), 'no top level → never accuse')
})

test('plan artifacts are never drift', () => {
  assert.ok(isPlanArtifact('/r/docs/sdlc/x/plan.md'))
  assert.ok(isPlanArtifact('plan.md'))
  assert.ok(!isPlanArtifact('src/plan.ts'))
})

test('detectPlanDrift: n/a outside build or without a plan; amber on drift; green after plan update', () => {
  const facts = { inRepo: true, gitAvailable: true, ghAvailable: true, artifacts: ['docs/sdlc/x/plan.md'], instructionFiles: [], readAt: 'r' }
  const base = { calls: [], teamAttached: false, userTurns: [1], protectedBranches: [], ended: false, facts }
  assert.equal(detectPlanDrift({ ...base, activeStage: 'design' }).status, 'n/a')
  assert.equal(detectPlanDrift({ ...base, activeStage: 'build', facts: { ...facts, artifacts: [] } }).status, 'n/a')
  assert.equal(detectPlanDrift({ ...base, activeStage: 'build' }).status, 'green')
  const amber = detectPlanDrift({ ...base, activeStage: 'build', drift: [{ path: 'src/x.ts', t: 't1' }] })
  assert.equal(amber.status, 'amber'); assert.match(amber.evidence[0], /src\/x\.ts/); assert.equal(amber.firstViolationAt, 't1')
  assert.equal(detectPlanDrift({ ...base, activeStage: 'build', drift: [{ path: 'src/x.ts', t: 't1' }], planUpdated: true }).status, 'green')
})

test('work root follows absolute edits and leading cd, else the session cwd', () => {
  assert.equal(leadingCd('cd /a/b && git commit'), '/a/b')
  assert.equal(leadingCd('set -e; cd "/a b/c" && ls'), '/a b/c')
  assert.equal(leadingCd('git status'), undefined)
  assert.equal(workRootOf({ name: 'edit', target: '/wt/src/x.ts', isError: false, t: 't', turn: 1 }, '/cwd'), '/wt/src')
  assert.equal(workRootOf({ name: 'edit', target: 'src/x.ts', isError: false, t: 't', turn: 1 }, '/cwd'), undefined)
  assert.equal(workRootOf({ name: 'bash', target: 'cd ../wt && git add -A', isError: false, t: 't', turn: 1 }, '/repo/main'), '/repo/wt')
  const calls = [
    { name: 'bash', target: 'git status', isError: false, t: 't', turn: 1 },
    { name: 'edit', target: '/wt/a.ts', isError: false, t: 't', turn: 1 },
    { name: 'bash', target: 'ls', isError: false, t: 't', turn: 1 },
  ]
  assert.equal(currentWorkRoot(calls, '/cwd'), '/wt')
  assert.equal(currentWorkRoot([calls[0]], '/cwd'), '/cwd')
})
