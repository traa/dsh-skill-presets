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

test('isDocsPath: docs/, Markdown, and the usual top-level prose files are documentation; source is not', async () => {
  const { isDocsPath } = await import('../lib/host/practices/plan.js')
  for (const p of ['docs/sdlc/phase-7/intent.md', '/repo/doc/guide.rst', 'README.md', 'README', 'LICENSE', 'CHANGELOG.md', 'notes/todo.txt', 'src/thing.mdx']) assert.ok(isDocsPath(p), p)
  for (const p of ['src/x.ts', 'test/a.test.mjs', 'package.json', 'docs.ts', 'src/docs/render.ts'.replace('docs/', 'docz/'), 'Makefile']) assert.ok(!isDocsPath(p), p)
})

// Found while dogfooding Phase 7's own plan.md: two real files it named were
// reported as drift because the parser did not see them.
test('planPaths: dotfiles and a backticked path followed by punctuation are paths', async () => {
  const { planPaths } = await import('../lib/host/practices/plan.js')
  const p = planPaths([
    '`.gitignore` (`stage/shots/*`), `.npmrc`, and `.github/workflows/ci.yml`.',
    'Files: `src/host/flows.ts` (x), `src/host/index.ts`, (RPC',
    'also `package.json`; then `lib/`',
  ].join('\n'))
  for (const want of ['.gitignore', '.npmrc', '.github/workflows/ci.yml', 'src/host/flows.ts', 'src/host/index.ts', 'package.json', 'lib/']) {
    assert.ok(p.includes(want), `${want} missing from ${JSON.stringify(p)}`)
  }
  // Still not paths: abbreviations and prose.
  for (const not of ['e.g', 'i.e', 'RPC']) assert.ok(!p.includes(not), `${not} should not be a path`)
})

// Issue #23. Observed while dogfooding Phase 7: the drift list said "19 files
// not in plan.md" long after plan.md named every one of them. The tracker
// appended to `state.drift` as edits arrived and never re-checked that list
// against the CURRENT plan; a plan.md edit only set a flag, and the next edit
// after it brought the whole stale list back. The list must always reflect the
// plan as it is now.
test('tracker: editing plan.md to name the drifted files clears them; only genuinely unplanned edits remain', async () => {
  const { PracticeTracker } = await import('../lib/host/practices/index.js')
  const { defaultPractices } = await import('../lib/host/curated.js')
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const top = await mkdtemp(join(tmpdir(), 'skp-drift-'))
  await mkdir(join(top, 'docs/sdlc/x'), { recursive: true })
  await mkdir(join(top, 'src'), { recursive: true })
  const plan = join(top, 'docs/sdlc/x/plan.md')
  await writeFile(plan, '# Plan\nFiles: `src/a.ts`.\n')
  let readAt = 1
  const facts = () => ({ inRepo: true, gitAvailable: true, ghAvailable: false, isWorktree: true, branch: 'feat/x', topLevel: top, artifacts: ['docs/sdlc/x/plan.md'], instructionFiles: [], readAt: String(readAt++) })
  const tracker = new PracticeTracker({ practices: async () => defaultPractices(), activeStage: async () => 'build', onResult: () => {}, factsOverride: facts })
  const S = 's'
  tracker.session(S, top)
  const edit = (target, t) => tracker.onToolResult(S, { t, turn: 1, name: 'edit', target, isError: false })
  const drift = () => tracker.results(S)?.results.find(r => r.id === 'plan-drift')

  await tracker.refresh(S)
  await edit(join(top, 'src/a.ts'), 't1')          // planned
  await edit(join(top, 'src/b.ts'), 't2')          // NOT planned
  await edit(join(top, 'src/c.ts'), 't3')          // NOT planned
  await tracker.refresh(S)
  assert.equal(drift().status, 'amber')
  assert.match(drift().evidence[0], /2 files not in plan\.md/)

  // The human updates plan.md to name b.ts and c.ts.
  await writeFile(plan, '# Plan\nFiles: `src/a.ts`, `src/b.ts`, `src/c.ts`.\n')
  await edit(plan, 't4')
  await tracker.refresh(S)
  assert.equal(drift().status, 'green', drift().evidence.join(' | '))

  // A further PLANNED edit must not resurrect the old list…
  await edit(join(top, 'src/b.ts'), 't5')
  await tracker.refresh(S)
  assert.equal(drift().status, 'green', drift().evidence.join(' | '))
  // …and a genuinely unplanned one lists exactly that file, not the old ones.
  await edit(join(top, 'src/d.ts'), 't6')
  await tracker.refresh(S)
  assert.equal(drift().status, 'amber')
  assert.match(drift().evidence[0], /^1 file not in plan\.md: .*d\.ts/)
  assert.doesNotMatch(drift().evidence[0], /b\.ts|c\.ts/)
})
