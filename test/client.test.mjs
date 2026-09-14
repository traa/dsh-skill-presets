// Execute the built client artifact the way the page's module loader does and
// assert what it REGISTERS. "The bundle loads" proves nothing: a client half
// that fails a packaging contract still serves HTTP 200 and registers nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT = join(ROOT, 'lib', 'client.js')

/** A React stand-in that records trees; hooks are replayed per render. */
function fakeReact() {
  const state = { cells: [], i: 0, effects: [] }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const i = state.i++
      if (!(i in state.cells)) state.cells[i] = typeof initial === 'function' ? initial() : initial
      return [state.cells[i], (next) => { state.cells[i] = next }]
    },
    useEffect(effect) { state.effects.push(effect) },
    useRef(initial) {
      const i = state.i++
      if (!(i in state.cells)) state.cells[i] = { current: initial }
      return state.cells[i]
    },
    Fragment: 'Fragment',
    __render(component, props = {}) {
      state.i = 0
      state.effects = []
      const tree = typeof component === 'function' ? component(props) : component
      return tree
    },
    __runEffects() { const fx = state.effects; state.effects = []; for (const f of fx) f() },
  }
  return React
}

/** Deep-walk a createElement tree and resolve function components. */
function render(React, node, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(n => render(React, n, depth))
  if (typeof node.type === 'function' && depth < 12) return render(React, React.__render(node.type, node.props), depth + 1)
  return { ...node, children: node.children.map(c => render(React, c, depth)) }
}

function text(tree, out = []) {
  if (tree === null || tree === undefined) return out
  if (typeof tree === 'string' || typeof tree === 'number') { out.push(String(tree)); return out }
  if (Array.isArray(tree)) { for (const t of tree) text(t, out); return out }
  if (typeof tree === 'object') { for (const c of tree.children ?? []) text(c, out) }
  return out
}

async function load() {
  const source = await readFile(ARTIFACT, 'utf8')
  assert.ok(source.startsWith('window.__ModuleLoader__.load({ id: "dsh-skill-presets"'), 'artifact must be a loader closure factory')
  let captured
  const React = fakeReact()
  const win = { __ModuleLoader__: { load: (entry) => { captured = entry } } }
  const fn = new Function('window', 'document', source)
  fn(win, undefined)
  assert.ok(captured, 'loader handoff did not run')
  const mod = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  return { mod, React }
}

function fakeCtx({ withTabs = true } = {}) {
  const registrations = []
  const tabTypes = []
  const slots = {
    inject: (key, cb) => { const off = cb(); return typeof off === 'function' ? off : () => {} },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  }
  const services = {
    slots,
    ...(withTabs ? { sidebarRightTabs: { register: (d) => { tabTypes.push(d); return () => {} } } } : {}),
  }
  const ctx = {
    get: name => services[name],
    effect: (cb) => { const off = cb(); return typeof off === 'function' ? off : () => {} },
  }
  return { ctx, registrations, tabTypes }
}

test('artifact exports name/inject/apply and registers all four surfaces', async () => {
  const { mod } = await load()
  assert.equal(mod.name, 'client-ui-skill-presets')
  assert.deepEqual(mod.inject, ['slots'])
  const { ctx, registrations, tabTypes } = fakeCtx()
  mod.apply(ctx)
  const names = registrations.map(r => `${r.options.name}${r.options.key !== undefined ? `#${r.options.key}` : r.options.id !== undefined ? `@${r.options.id}` : ''}`).sort()
  assert.deepEqual(names, [
    'conversation.session.header.utilities@skill-presets',
    'settings.plugin.item#skill-presets',
    'settings.section@skills',
    'sidebar.right.pane.tab#dsh-skill-presets',
  ])
  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].kind, 'skills')
  assert.equal(tabTypes[0].title(''), 'Skills')
  assert.equal(tabTypes[0].guide[0].title(), 'Skills')
  const section = registrations.find(r => r.options.name === 'settings.section')
  assert.equal(section.options.label(), 'Skills')
})

test('without sidebarRightTabs the other three surfaces still register', async () => {
  const { mod } = await load()
  const { ctx, registrations } = fakeCtx({ withTabs: false })
  mod.apply(ctx)
  assert.equal(registrations.length, 3)
})

test('settings page renders tabs and a loading state before any RPC answers', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx()
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({}) })
  mod.apply(ctx)
  const Page = registrations.find(r => r.options.name === 'settings.section').component
  const tree = render(React, React.createElement(Page, {}))
  const words = text(tree).join(' ')
  assert.match(words, /Skills/)
  assert.match(words, /Stages & presets/)
  assert.match(words, /Library/)
  assert.match(words, /Practices/)
  assert.match(words, /Insights/)
  assert.match(words, /Reading the skill store/)
})

test('header chip renders and toggles nothing without a session id', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx()
  mod.apply(ctx)
  const Chip = registrations.find(r => r.options.name === 'conversation.session.header.utilities').component
  assert.equal(render(React, React.createElement(Chip, {})), null)
  const tree = render(React, React.createElement(Chip, { sessionId: 's-1' }))
  const words = text(tree).join(' ')
  assert.match(words, /…|no preset/)
})

test('sidebar body renders a scorecard from a fake RPC answer', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx()
  const scorecard = {
    sessionId: 's-2', live: true,
    active: { version: 2, default: 'plan', byAgentPreset: {}, sessions: { 's-2': { preset: 'build', since: 'x', by: 'ui' } }, since: 'x', by: 'ui' },
    activePreset: { id: 'build', title: 'Build', stage: 'build', summary: 's', color: '#0f0', skills: [], createdAt: 'a', updatedAt: 'b' },
    activeSource: 'session',
    stageGuess: { stage: 'test', confidence: 0.85, why: ['PR open: https://x/pull/1'] },
    suggestion: { from: 'build', to: 'test', presetId: 'test-review', confidence: 0.85, why: ['PR open'] },
    experiments: [{ id: 'e1', parent: 's-2', child: 's-3', parentPreset: 'build', childPreset: 'design', at: 't' }],
    strict: { enabled: true, seam: true, applied: true },
    loadTrace: [{ name: 'executing-plans', turn: 1, t: 't', ok: true, userLine: 'implement the plan', mentioned: true, deltas: [{ id: 'worktree', from: 'red', to: 'green' }] }],
    overlays: ['git-repo'],
    offered: [{ name: 'worktree-first', via: 'overlay:git-repo', description: 'd' }, { name: 'executing-plans', via: 'preset', description: 'd' }],
    unresolved: [],
    practices: [{ id: 'worktree', status: 'red', evidence: ['2 file mutations on protected branch main in the primary checkout'] }],
    worst: 'red',
    facts: { inRepo: true, gitAvailable: true, isWorktree: false, branch: 'main', ghAvailable: true, artifacts: ['docs/sdlc/x/plan.md'], instructionFiles: [] },
    summary: { sessionId: 's-2', preset: 'build', overlays: [], offered: [], loaded: { 'executing-plans': { count: 2, firstTurn: 1, chars: 10, lastAt: 't' } }, unknown: ['ghost'], practices: [], denied: 0, drift: ['src/unplanned.ts'], suggestions: [], switches: [], loads: [{ name: 'executing-plans', turn: 1, t: 't', ok: true }] },
  }
  const status = {
    root: '/wb', storeReady: true, active: scorecard.active, activePreset: scorecard.activePreset, presets: [scorecard.activePreset, { id: 'test-review', title: 'Test & Review', stage: 'test', summary: 's', skills: [], createdAt: 'a', updatedAt: 'b' }], overlays: [], sources: [],
    lock: { version: 1, sources: {}, skills: [] }, practices: { version: 1, strictSkills: false, instructionFiles: [], protectedBranches: ['main'], practices: [] },
    practiceInfo: { worktree: { title: 'Work in a worktree', summary: '', skill: 'worktree-first' } }, stages: [], resolution: { skills: [], unresolved: [], collisions: [] }, notes: [], foundationInstalled: true,
  }
  globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/scorecard') ? scorecard : status) })
  mod.apply(ctx)
  const Body = registrations.find(r => r.options.name === 'sidebar.right.pane.tab').component
  // First render: loading. Run effects (watch → refresh) and wait for the poll.
  render(React, React.createElement(Body, { sessionId: 's-2', useTabInfo: () => ({ tab: { visible: true } }) }))
  React.__runEffects()
  await new Promise(r => setTimeout(r, 30))
  const tree = render(React, React.createElement(Body, { sessionId: 's-2', useTabInfo: () => ({ tab: { visible: true } }) }))
  const words = text(tree).join(' ')
  assert.match(words, /Build/)
  assert.match(words, /Work in a worktree/)
  assert.match(words, /protected branch main/)
  assert.match(words, /executing-plans/)
  assert.match(words, /×2/)
  assert.match(words, /ghost/)
  assert.match(words, /plan\.md/)
  assert.match(words, /1 of 2 loaded/)
  // Phase 2 surfaces: preset source, detected stage + suggestion, drift, experiments.
  assert.match(words, /this session/)
  assert.match(words, /Detected: Test & Review/)
  assert.match(words, /Switch to Test & Review\?/)
  assert.match(words, /unplanned\.ts/)
  assert.match(words, /s-3/)
  assert.match(words, /Why each load/)
  assert.match(words, /implement the plan/)
  assert.match(words, /nudged/)
  // Stop the poll loop the body's watch() started.
  React.__runEffects()
  await new Promise(r => setTimeout(r, 5))
})
