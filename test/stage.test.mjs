import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectStage, suggest, shouldSuggest, recordDismissal, recordAcceptance, emptySuggestions, MUTE_AFTER } from '../lib/host/stage.js'

const facts = (over = {}) => ({ inRepo: true, gitAvailable: true, ghAvailable: true, artifacts: [], instructionFiles: [], readAt: 'r', ...over })
const edit = { t: 't', turn: 1, name: 'edit', target: 'src/a.ts', isError: false }
const bash = cmd => ({ t: 't', turn: 1, name: 'bash', target: cmd, isError: false })

// Phase 7: detection reads ARTIFACTS and PR state only. Shell verbs
// (`kubectl apply`, `git revert`) and edit counts are gone: a deploy command in
// a grep, a revert of a typo, three edits — none of those are the human
// deciding to change stage, and mid-session pulses were the complaint.
test('the stage is read from committed artifacts and PR state, never from shell verbs or edit counts', () => {
  assert.equal(detectStage(undefined).stage, 'plan')
  assert.ok(detectStage(undefined).confidence < 0.7)
  assert.deepEqual([detectStage(facts()).stage, detectStage(facts()).confidence], ['plan', 0.5])
  assert.equal(detectStage(facts({ artifacts: ['docs/sdlc/x/intent.md'] })).stage, 'design')
  assert.equal(detectStage(facts({ artifacts: ['docs/sdlc/x/intent.md', 'docs/sdlc/x/spec.md'] })).confidence, 0.8)
  const build = detectStage(facts({ artifacts: ['docs/sdlc/x/plan.md'] }), [edit])
  assert.equal(build.stage, 'build')
  assert.equal(build.confidence, detectStage(facts({ artifacts: ['docs/sdlc/x/plan.md'] })).confidence, 'edits do not raise confidence')
  assert.equal(detectStage(facts({ artifacts: ['plan.md'], pr: { url: 'u', state: 'OPEN' } })).stage, 'test')
  assert.equal(detectStage(facts({ pr: { url: 'u', state: 'MERGED' } })).stage, 'deploy')
  assert.equal(detectStage(facts({ artifacts: ['docs/sdlc/incidents/2026-01-01-x.md'] })).stage, 'maintain')
  assert.equal(detectStage(facts(), [bash('kubectl rollout status deploy/x')]).stage, 'plan', 'a shell verb is not a stage')
  assert.equal(detectStage(facts(), [bash('git revert HEAD # rollback')]).stage, 'plan')
})

// Start-only: the suggestion is offered when the session has no explicit
// position yet, and again when the CURRENT stage's gate artifact appears
// (the playbook's "an accepted artifact fires the next gate"). Never because
// time passed, edits happened, or a command ran.
test('shouldSuggest: at session start, and when the current gate artifact lands — not otherwise', () => {
  const before = facts({ artifacts: ['docs/sdlc/x/intent.md'] })
  const after = facts({ artifacts: ['docs/sdlc/x/intent.md', 'docs/sdlc/x/spec.md'] })
  const planned = facts({ artifacts: ['docs/sdlc/x/intent.md', 'docs/sdlc/x/spec.md', 'docs/sdlc/x/plan.md'] })
  const open = facts({ artifacts: planned.artifacts, pr: { url: 'u', state: 'OPEN' } })
  const merged = facts({ artifacts: planned.artifacts, pr: { url: 'u', state: 'MERGED' } })
  assert.equal(shouldSuggest({ explicitPosition: false, stage: 'plan', previous: undefined, facts: before }), true, 'no explicit position yet → offer')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'plan', previous: before, facts: before }), false, 'nothing changed')
  // Design writes spec.md and then plan.md; only the LAST one ends the stage.
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'design', previous: before, facts: after }), false, 'spec.md is not Design\'s gate any more: plan.md is')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'design', previous: after, facts: planned }), true, 'plan.md is Design\'s gate: it just appeared')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'build', previous: before, facts: after }), false, 'spec.md is not Build\'s gate')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'build', previous: after, facts: planned }), false, 'plan.md is what Build READS, not what ends it')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'build', previous: planned, facts: planned }), false, 'plan.md already there, no PR change')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'build', previous: planned, facts: open }), true, 'the PR is Build\'s gate: it just appeared')
  // Review ends with the merge and Ship with an incident record: neither is an
  // artifact the git read can watch land, so they never fire it.
  for (const stage of ['test', 'deploy', 'maintain']) {
    assert.equal(shouldSuggest({ explicitPosition: true, stage, previous: planned, facts: open }), false, `${stage}: a PR appearing is not its gate`)
    assert.equal(shouldSuggest({ explicitPosition: true, stage, previous: open, facts: merged }), false, `${stage}: a merge never fires it`)
  }
  assert.equal(shouldSuggest({ explicitPosition: true, stage: null, previous: before, facts: after }), false, 'Explore never suggests')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: null, previous: planned, facts: open }), false, 'Explore never suggests, PR or not')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'design', previous: undefined, facts: after }), false, 'first facts read with an explicit position is not "an artifact appeared"')
  assert.equal(shouldSuggest({ explicitPosition: true, stage: 'build', previous: undefined, facts: open }), false, 'first facts read with a PR already open is not "a PR appeared"')
})

// One gate table. `gateFor` (flows.ts) is the playbook's answer to "what ends
// this stage"; `shouldSuggest` must fire on exactly that, observed. The spec's
// table is spelled out here so a regression in EITHER place fails, and the
// source check below fails a second, hand-copied table even if it agrees today.
const SPEC_GATES = { plan: 'intent.md', design: 'plan.md', build: 'PR', test: 'merge', deploy: 'incident record', maintain: undefined, cross: undefined }
const base = facts({ artifacts: [] })
const withPr = facts({ artifacts: [], pr: { url: 'u', state: 'OPEN' } })
/** Every observable transition, labelled by the gate it would be. Merge and incident record are listed so they are proven NOT to fire. */
const TRANSITIONS = [
  ['intent.md', base, facts({ artifacts: ['docs/sdlc/x/intent.md'] })],
  ['spec.md', base, facts({ artifacts: ['docs/sdlc/x/spec.md'] })],
  ['plan.md', base, facts({ artifacts: ['docs/sdlc/x/plan.md'] })],
  ['PR', base, withPr],
  ['merge', withPr, facts({ artifacts: [], pr: { url: 'u', state: 'MERGED' } })],
  ['incident record', base, facts({ artifacts: ['docs/sdlc/incidents/2026-01-01-x.md'] })],
]
const OBSERVABLE = new Set(['intent.md', 'plan.md', 'PR'])

test('shouldSuggest fires on exactly the gate gateFor names, for every stage — no second table', async () => {
  const { gateFor } = await import('../lib/host/flows.js')
  for (const [stage, gate] of Object.entries(SPEC_GATES)) {
    assert.equal(gateFor(stage), gate, `gateFor(${stage}) per the spec table`)
    for (const [label, previous, now] of TRANSITIONS) {
      const expected = gate !== undefined && OBSERVABLE.has(gate) && label === gate
      assert.equal(shouldSuggest({ explicitPosition: true, stage, previous, facts: now }), expected, `${stage}: ${label} appearing ${expected ? 'fires' : 'must not fire'} (gate: ${gate})`)
    }
  }
  // Structural half of the spec: "stage.ts has no second gate table; it uses gateFor".
  // A copy can be an object (quoted keys or not), a Map, a tuple array, a
  // switch, or an if-chain; banning one SHAPE misses the others. So the guard
  // bans the INGREDIENTS instead: outside the few call sites that legitimately
  // need them, stage.ts may not spell a gate token at all, shouldSuggest may
  // not spell a stage name, and nothing but types may come from a module other
  // than flows.ts (so the table cannot move next door and be imported).
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(new URL('../src/host/stage.ts', import.meta.url), 'utf8')
  // Comments are prose, not code. `//` only counts at line start or after
  // whitespace, so the regex literal `/incidents?\//u` is not mistaken for one.
  const src = raw.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/.*$/gmu, '$1')
  /** The `{ … }` body of `function name(…)`: match the parameter parens, then the body braces. */
  const bodyOf = (name) => {
    const at = src.indexOf(`function ${name}(`)
    assert.notEqual(at, -1, `stage.ts defines function ${name}`)
    let i = src.indexOf('(', at)
    for (let depth = 0; ; i += 1) { if (src[i] === '(') depth += 1; else if (src[i] === ')' && (depth -= 1) === 0) break }
    let end = src.indexOf('{', i)
    const open = end
    for (let depth = 0; ; end += 1) { if (src[end] === '{') depth += 1; else if (src[end] === '}' && (depth -= 1) === 0) break }
    return src.slice(open, end + 1)
  }
  // (1) The gate comes from flows.ts, and only types come from anywhere else.
  assert.match(src, /import\s*\{[^}]*\bgateFor\b[^}]*\}\s*from\s*['"]\.\/flows\.(?:ts|js)['"]/u, 'stage.ts derives its gate from flows.ts gateFor')
  const valueImports = [...src.matchAll(/^\s*import\s+(?!type\b)[^'"]*from\s*['"]([^'"]+)['"]/gmu)].map(m => m[1]).filter(from => !/^\.\/flows\.(?:ts|js)$/u.test(from))
  assert.deepEqual(valueImports, [], 'stage.ts imports values only from ./flows — a table in a sibling module is still a second table')
  // (2) shouldSuggest asks gateFor, and never names a stage itself.
  const should = bodyOf('shouldSuggest')
  assert.match(should, /\bgateFor\(\s*input\.stage\s*\)/u, 'shouldSuggest takes its gate from gateFor(input.stage)')
  const stageNames = should.match(/(['"`])(?:plan|design|build|test|deploy|maintain|cross)\1/gu)
  assert.equal(stageNames, null, `shouldSuggest special-cases a stage by name: ${stageNames?.join(', ')}`)
  // (3) Gate tokens appear only where they are not a mapping: detectStage's
  // `has(facts, '…')` artifact probes, and shouldSuggest's `gate === 'PR'`.
  const GATE_TOKEN = /(['"`])(?:intent\.md|spec\.md|plan\.md|PR|merge|incident record)\1/gu
  const detect = bodyOf('detectStage')
  const rest = src.replace(detect, '').replace(should, '')
  const strays = [
    ...(rest.match(GATE_TOKEN) ?? []),
    ...(detect.replace(/\bhas\(\s*\w+\s*,\s*(['"])(?:intent|spec|plan)\.md\1\s*\)/gu, '').match(GATE_TOKEN) ?? []),
    ...(should.replace(/\bgate\s*===\s*(['"])PR\1/gu, '').match(GATE_TOKEN) ?? []),
  ]
  assert.deepEqual(strays, [], `stage.ts spells gate tokens outside detection probes — a second gate table in some shape: ${strays.join(', ')}`)
})

test('suggest fires only above the threshold, when the stage differs, and until muted', () => {
  const owners = new Map([['build', ['build']], ['test', ['test-review', 'qa']]])
  let doc = emptySuggestions()
  const guess = { stage: 'build', confidence: 0.9, why: ['plan.md committed'] }
  assert.equal(suggest({ ...guess, confidence: 0.6 }, 'design', owners, doc), undefined)
  assert.equal(suggest(guess, 'build', owners, doc), undefined)
  const s = suggest(guess, 'design', owners, doc)
  assert.deepEqual([s.from, s.to, s.presetId], ['design', 'build', 'build'])
  // Two owners → no presetId; the UI asks.
  assert.equal(suggest({ stage: 'test', confidence: 0.85, why: [] }, 'build', owners, doc).presetId, undefined)
  // Cross/none active stage counts as a transition from none.
  assert.equal(suggest(guess, undefined, owners, doc).from, null)
  for (let i = 0; i < MUTE_AFTER; i += 1) doc = recordDismissal(doc, 'design', 'build', new Date())
  assert.equal(suggest(guess, 'design', owners, doc), undefined, 'muted after repeated dismissals')
  assert.notEqual(suggest(guess, 'plan', owners, doc), undefined, 'a different transition is not muted')
  doc = recordAcceptance(doc, 'design', 'build')
  assert.notEqual(suggest(guess, 'design', owners, doc), undefined, 'acceptance clears the mute')
})
