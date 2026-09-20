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
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-skill-presets"/, 'artifact must be a loader closure factory')
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

function fakeCtx(inject = [], { withTabs = true, withStyles = true, withLayout = true, withSidebarRight = true, withSidebarRightError = false } = {}) {
  const registrations = []
  const tabTypes = []
  const calls = { openTab: [], openRightbar: [] }
  const slots = {
    inject: (key, cb) => { const off = cb(); return typeof off === 'function' ? off : () => {} },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  }
  const available = {
    slots,
    ...(withTabs ? { sidebarRightTabs: { register: (d) => { tabTypes.push(d); return () => {} } } } : {}),
    ...(withLayout ? { layout: { openRightbar: (t, f) => { calls.openRightbar.push([t, f]) } } } : {}),
    ...(withSidebarRight ? { sidebarRight: { openTab: (kind) => { calls.openTab.push(kind); if (withSidebarRightError) throw new Error('fake error') } } } : {}),
  }
  const services = {}
  for (const name of inject) {
    services[name] = available[name]
  }
  if (withStyles) services.styles = { insert: () => () => {} }

  const ctx = {
    get: name => services[name],
    effect: (cb) => { const off = cb(); return typeof off === 'function' ? off : () => {} },
  }
  return { ctx, registrations, tabTypes, calls }
}

test('inject declares every service the bundle reaches for', async () => {
  // The real page gives a plugin only what it injects. If it reaches for a service
  // not in inject, ctx.get returns undefined and it breaks silently.
  const { mod } = await load()
  const source = await readFile(ARTIFACT, 'utf8')
  const srcIndex = await readFile(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
  const gets = [...source.matchAll(/ctx\.get\(['"]([^'"]+)['"]\)/g)].map(m => m[1])
  for (const name of new Set(gets)) {
    if (name === 'styles') {
      // styles is optional and read defensively, so we allow it to be missing from inject
      assert.match(srcIndex, /!==\s*undefined/, 'styles must be guarded')
      continue
    }
    assert.ok(mod.inject.includes(name), `Service ${name} is requested but not in mod.inject`)
  }
})

test('artifact exports name/inject/apply and registers every surface — the header chip is gone', async () => {
  const { mod } = await load()
  assert.equal(mod.name, 'client-ui-skill-presets')
  assert.deepEqual(mod.inject, ['slots', 'sidebarRightTabs', 'layout', 'sidebarRight'])
  const { ctx, registrations, tabTypes } = fakeCtx(mod.inject)
  mod.apply(ctx)
  const names = registrations.map(r => `${r.options.name}${r.options.key !== undefined ? `#${r.options.key}` : r.options.id !== undefined ? `@${r.options.id}` : ''}`).sort()
  assert.deepEqual(names, [
    'conversation.composer.dock@skill-presets-start',
    'conversation.input.right@skill-presets-stage',
    'settings.plugin.item#skill-presets',
    'settings.section@skills',
    'shell.overlay@skill-presets-stage-pop',
    'sidebar.right.pane.tab#dsh-skill-presets',
  ])
  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].kind, 'skills')
  assert.equal(tabTypes[0].title(''), 'Skills')
  assert.equal(tabTypes[0].guide[0].title(), 'Skills')
  assert.match(tabTypes[0].guide[0].description(), /flow.*stage.*checked.*skills/i)
  const section = registrations.find(r => r.options.name === 'settings.section')
  assert.equal(section.options.label(), 'Skills')
})

test('without sidebarRightTabs the other five surfaces still register', async () => {
  const { mod } = await load()
  const { ctx, registrations } = fakeCtx(mod.inject, { withTabs: false })
  mod.apply(ctx)
  assert.equal(registrations.length, 5)
})

test('settings page renders tabs and a loading state before any RPC answers', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx(mod.inject)
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

// The stage control replaced the header chip (Phase 7). The fake React here
// proves registration and the closed state only; open/anchor/clip/outside-click
// are DOM facts and live in stage/tests/control.spec.mjs (Playwright).
test('stage control renders nothing without a session id and reads the stage with one', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx(mod.inject)
  const card = { sessionId: 's-1', flow: { id: 'full', title: 'Full', stages: ['plan', 'design', 'build', 'test', 'deploy'], guardrails: 'on', builtin: true }, flows: [], stage: 'build', source: 'session', presetId: 'build', owners: ['build'], position: { index: 2, of: 5 }, gate: 'plan.md', next: 'test', practices: [], report: [] }
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(card) })
  mod.apply(ctx)
  const Control = registrations.find(r => r.options.name === 'conversation.input.right').component
  assert.equal(render(React, React.createElement(Control, {})), null)
  let tree = render(React, React.createElement(Control, { sessionId: 's-1' }))
  assert.match(text(tree).join(' '), /…/)
  React.__runEffects()
  await new Promise(r => setTimeout(r, 30))
  tree = render(React, React.createElement(Control, { sessionId: 's-1' }))
  assert.match(text(tree).join(' '), /Build/)
  const button = flatten(tree).find(n => (n.props?.className ?? '').includes('skp-ctl'))
  assert.equal(button.props['aria-expanded'], 'false')
  assert.match(button.props.title, /Full · Build \(3 of 5\) · ends with plan\.md/)
  assert.equal(nodesWithClass(button, 'skp-swatch').length, 0)
  assert.equal(nodesWithClass(button, 'skp-ctl-label').length, 1)
  assert.equal(text(nodesWithClass(button, 'skp-ctl-label')[0]).join(''), 'Build')
  assert.equal(nodesWithClass(button, 'skp-ctl-caret').length, 1)
  // Green: no count, no dot.
  assert.equal(nodesWithClass(tree, 'skp-ctl-count').length, 0)
  assert.equal(nodesWithClass(tree, 'skp-dot').length, 0)
  // The overlay renders nothing while closed.
  const Overlay = registrations.find(r => r.options.name === 'shell.overlay').component
  assert.deepEqual(nodesWithClass(render(React, React.createElement(Overlay, {})), 'skp-stage-pop'), [])
})

test('sidebar body renders a scorecard from a fake RPC answer', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx(mod.inject)
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
  // Phase 2 surfaces still here: preset source, drift, experiments.
  assert.match(words, /this session/)
  // Phase 7: the sidebar no longer announces a DETECTED stage or a mid-session
  // "Switch to …?" — the stage is the human's choice in the composer control,
  // and the start-only suggestion lives there. A red, relevant practice is a
  // "Needs action" line with the skill that fixes it.
  assert.doesNotMatch(words, /Detected stage/)
  assert.doesNotMatch(words, /Switch to Test & Review\?/)
  assert.doesNotMatch(words, /Needs action/)
  assert.match(words, /Checked in this stage.*Work in a worktree.*2 file mutations on protected branch main/)
  assert.match(words, /unplanned\.ts/)
  assert.match(words, /s-3/)
  assert.match(words, /Why each load/)
  assert.match(words, /implement the plan/)
  assert.match(words, /nudged/)
  // Stop the poll loop the body's watch() started.
  React.__runEffects()
  await new Promise(r => setTimeout(r, 5))
})

/** Flatten a rendered tree into document order. */
function flatten(tree, out = []) {
  if (tree === null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { for (const t of tree) flatten(t, out); return out }
  out.push(tree)
  for (const c of tree.children ?? []) flatten(c, out)
  return out
}

/** The first clickable node whose rendered text equals `label`. */
function clickable(tree, label) {
  return flatten(tree).find(n => typeof n.props?.onClick === 'function' && text(n).join('').trim() === label)
}

/** Every node in a rendered tree whose className contains `cls`. */
function nodesWithClass(tree, cls, out = []) {
  if (tree === null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { for (const t of tree) nodesWithClass(t, cls, out); return out }
  const className = tree.props?.className
  if (typeof className === 'string' && className.split(/\s+/).includes(cls)) out.push(tree)
  for (const c of tree.children ?? []) nodesWithClass(c, cls, out)
  return out
}

/** A scorecard/status pair with a mix of applicable and n/a practices. */
function mixedFixture() {
  const activePreset = { id: 'build', title: 'Build', stage: 'build', summary: 's', color: '#0f0', skills: [], createdAt: 'a', updatedAt: 'b' }
  const scorecard = {
    sessionId: 's-4', live: true,
    active: { version: 2, default: 'build', byAgentPreset: {}, sessions: {}, since: 'x', by: 'ui' },
    activePreset, activeSource: 'session',
    stageGuess: { stage: 'build', confidence: 0.9, why: ['plan.md present'] },
    experiments: [], strict: { enabled: false, seam: false, applied: false }, loadTrace: [], overlays: [],
    offered: [], unresolved: [],
    practices: [
      { id: 'worktree', status: 'red', evidence: ['2 file mutations on protected branch main in the primary checkout'] },
      { id: 'plan-before-code', status: 'n/a', evidence: ['applies in the Build stage'] },
      { id: 'conductor', status: 'n/a', evidence: ['no team attached'] },
    ],
    worst: 'red',
    facts: { inRepo: true, gitAvailable: true, isWorktree: false, branch: 'main', ghAvailable: true, artifacts: [], instructionFiles: [] },
    summary: { sessionId: 's-4', preset: 'build', overlays: [], offered: [], loaded: {}, unknown: [], practices: [], denied: 0, drift: [], suggestions: [], switches: [], loads: [] },
  }
  const status = {
    root: '/wb', storeReady: true, active: scorecard.active, activePreset, presets: [activePreset], overlays: [], sources: [],
    lock: { version: 1, sources: {}, skills: [] }, practices: { version: 1, strictSkills: false, instructionFiles: [], protectedBranches: ['main'], practices: [] },
    practiceInfo: {
      'worktree': { title: 'Work in a worktree', summary: '', skill: 'worktree-first' },
      'plan-before-code': { title: 'Plan before code', summary: '', skill: 'executing-plans' },
      'conductor': { title: 'Conductor protocol', summary: '', skill: 'teams' },
    },
    stages: [], resolution: { skills: [], unresolved: [], collisions: [] }, notes: [], foundationInstalled: true,
  }
  return { scorecard, status }
}

test('relevant n/a practices render as normal check rows, not folded', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx(mod.inject)
  const { scorecard, status } = mixedFixture()
  scorecard.practices = scorecard.practices.map(p => ({ ...p, relevant: true }))
  globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/scorecard') ? scorecard : status) })
  mod.apply(ctx)
  const Body = registrations.find(r => r.options.name === 'sidebar.right.pane.tab').component
  const props = { sessionId: 's-4', useTabInfo: () => ({ tab: { visible: true } }) }
  render(React, React.createElement(Body, props))
  React.__runEffects()
  await new Promise(r => setTimeout(r, 30))
  const tree = render(React, React.createElement(Body, props))
  
  const naRows = nodesWithClass(tree, 'skp-check').filter(n => n.props['data-status'] === 'n/a')
  assert.equal(naRows.length, 2, 'the two n/a practices render as individual rows')
  assert.equal(nodesWithClass(tree, 'skp-na').length, 0, 'no folded +N line when all are relevant')
  React.__runEffects()
  await new Promise(r => setTimeout(r, 5))
})

test('irrelevant practices fold into one +N not judged line', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx(mod.inject)
  const { scorecard, status } = mixedFixture()
  scorecard.practices = [
    { id: 'worktree', status: 'red', relevant: true, evidence: ['x'] },
    { id: 'p1', status: 'green', relevant: false, evidence: ['y'] },
    { id: 'p2', status: 'red', relevant: false, evidence: ['z'] }
  ]
  globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/scorecard') ? scorecard : status) })
  mod.apply(ctx)
  const Body = registrations.find(r => r.options.name === 'sidebar.right.pane.tab').component
  const props = { sessionId: 's-5', useTabInfo: () => ({ tab: { visible: true } }) }
  render(React, React.createElement(Body, props))
  React.__runEffects()
  await new Promise(r => setTimeout(r, 30))
  const tree = render(React, React.createElement(Body, props))
  
  const na = nodesWithClass(tree, 'skp-na')
  assert.equal(na.length, 1)
  assert.equal(text(na[0]).join(''), '+2 not judged in this stage')
  assert.match(na[0].props.title, /p1: not judged/)
  assert.match(na[0].props.title, /p2: not judged/)
  React.__runEffects()
  await new Promise(r => setTimeout(r, 5))
})

test('explore style fixture where no practice is relevant renders no checks element', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx(mod.inject)
  const { scorecard, status } = mixedFixture()
  scorecard.practices = scorecard.practices.map(p => ({ ...p, relevant: false }))
  globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/scorecard') ? scorecard : status) })
  mod.apply(ctx)
  const Body = registrations.find(r => r.options.name === 'sidebar.right.pane.tab').component
  const props = { sessionId: 's-6', useTabInfo: () => ({ tab: { visible: true } }) }
  render(React, React.createElement(Body, props))
  React.__runEffects()
  await new Promise(r => setTimeout(r, 30))
  const tree = render(React, React.createElement(Body, props))
  
  assert.equal(nodesWithClass(tree, 'skp-checks').length, 0, 'the entire checks container is suppressed')
  assert.equal(nodesWithClass(tree, 'skp-na').length, 0, 'no folded line either')
  React.__runEffects()
  await new Promise(r => setTimeout(r, 5))
})

// Phase 7: the sidebar never shows the detector's guess. The stage is what the
// human set in the composer control; a guess is offered ONLY as the start-only
// suggestion there. So whatever detectStage returns — sub-threshold fallback or
// a confident finding — the sidebar body is silent about it.
test('the sidebar never announces a detected stage, whatever the guess', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx(mod.inject)
  const { scorecard, status } = mixedFixture()
  for (const guess of [
    { stage: 'plan', confidence: 0.5, why: ['nothing observed yet; defaulting to Plan'] },
    { stage: 'test', confidence: 0.85, why: ['PR open: u'] },
  ]) {
    scorecard.stageGuess = guess
    globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/scorecard') ? scorecard : status) })
    mod.apply(ctx)
    const Body = registrations.find(r => r.options.name === 'sidebar.right.pane.tab').component
    const props = { sessionId: `s-guess-${guess.confidence}`, useTabInfo: () => ({ tab: { visible: true } }) }
    render(React, React.createElement(Body, props))
    React.__runEffects()
    await new Promise(r => setTimeout(r, 30))
    const words = text(render(React, React.createElement(Body, props))).join(' ').replace(/\s+/gu, ' ')
    assert.doesNotMatch(words, /Detected stage/)
    assert.doesNotMatch(words, /confident/)
    assert.equal(nodesWithClass(render(React, React.createElement(Body, props)), 'skp-why').length, 0)
    React.__runEffects()
    await new Promise(r => setTimeout(r, 5))
  }
})

// "the popover hides n/a practices and shows the session scope as a neutral
// pill" was a header-chip test; the chip is gone. Its concerns moved: n/a
// practices never reach the stage popover at all (only red + relevant do —
// stage/tests/health.spec.mjs), and the scope reads as a footer line.

test('a genuine success notice still renders as the green paragraph it always was', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx(mod.inject)
  const { scorecard, status } = mixedFixture()
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(
      url.endsWith('/scorecard') ? scorecard
        : url.endsWith('/evals/save') ? { ok: true, dir: '/wb/skills/evals/s-6' }
          : status,
    ),
  })
  mod.apply(ctx)
  const Body = registrations.find(r => r.options.name === 'sidebar.right.pane.tab').component
  const props = { sessionId: 's-6', useTabInfo: () => ({ tab: { visible: true } }) }
  render(React, React.createElement(Body, props))
  React.__runEffects()
  await new Promise(r => setTimeout(r, 30))
  // "Save as fixture" reports that something HAPPENED — the class of notice
  // that legitimately keeps the green paragraph.
  const before = render(React, React.createElement(Body, props))
  clickable(before, 'Save as fixture').props.onClick()
  await new Promise(r => setTimeout(r, 30))
  const tree = render(React, React.createElement(Body, props))
  const ok = nodesWithClass(tree, 'skp-msg').filter(n => (n.props.className ?? '').includes('ok'))
  assert.equal(ok.length, 1, 'the success notice keeps the green paragraph')
  assert.match(text(ok[0]).join(''), /Saved as an eval fixture at \/wb\/skills\/evals\/s-6/)
  React.__runEffects()
  await new Promise(r => setTimeout(r, 5))
})

test('AT_RISK_PREFIX: the client mirror matches the host constant', async () => {
  // src/client/api.ts deliberately MIRRORS this constant instead of importing
  // it: a runtime import from src/host would drag `node:path` into the browser
  // bundle. The mirror is only safe if drift fails here — otherwise changing
  // either literal alone silently disables at-risk styling in the UI.
  const { AT_RISK_PREFIX: host } = await import('../lib/host/practices/detectors.js')
  const { AT_RISK_PREFIX: client } = await import('../lib/client/api.js')
  assert.equal(client, host, 'src/client/api.ts mirrors this constant; divergence silently disables at-risk styling')
})

test('client bundle imports no Node built-ins', async () => {
  // The client is bundled for the browser. Any require/import of a `node:`
  // built-in means a host module leaked in — which breaks the page at runtime,
  // not at build time. Matched on the import FORM, never the bare substring
  // `node:`, which appears harmlessly inside unrelated strings.
  const bundle = await readFile(ARTIFACT, 'utf8')
  // Any form that can pull a Node built-in into a browser bundle: static or
  // dynamic, either quote style. `createRequire` is flagged separately — it is
  // the escape hatch that would smuggle one past a specifier-only match.
  const specifier = /(?:require|import)\s*\(\s*["']node:[^"']+["']\s*\)|from\s*["']node:[^"']+["']/gu
  const smuggler = /createRequire\s*\(/gu
  const hits = [...(bundle.match(specifier) ?? []), ...(bundle.match(smuggler) ?? [])]
  assert.equal(hits.length, 0, `client bundle pulls in Node built-ins: ${hits.join(', ')}`)
})

// Adding react/react-dom to devDependencies (for the browser stage) made them
// resolvable at bundle time, and tsdown silently INLINED a second React into
// lib/client.js. In the page that React's hooks ran against a null dispatcher
// inside the shell's React tree ("Cannot read properties of null (reading
// 'useState')") — eight tests here went red, and the live plugin would have
// too. `external: ['react', …]` in tsdown.client.config.ts is the fix; this
// pins it, because the failure otherwise announces itself only at runtime.
test('client bundle takes React from the loader, never inlines its own', async () => {
  const source = await readFile(ARTIFACT, 'utf8')
  assert.match(source, /require\("react"\)/, 'the bundle must require("react") from the page loader')
  assert.doesNotMatch(source, /ReactCurrentDispatcher/, 'a React internals symbol means a React copy was inlined')
  assert.doesNotMatch(source, /react-dom/, 'react-dom must not be referenced at all')
})

async function openPopoverAndClickSkillsTab(mod, React, fakeCtxOpts) {
  const { ctx, registrations, calls } = fakeCtx(mod.inject, fakeCtxOpts)
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-test', flow: { id: 'f', title: 'F', stages: [], guardrails: 'on', builtin: true }, flows: [], stage: 'b', source: 'session', presetId: 'b', owners: ['b'], position: { index: 1, of: 1 }, gate: '', next: '', practices: [], report: [] }) })
  mod.apply(ctx)
  
  const Control = registrations.find(r => r.options.name === 'conversation.input.right').component
  const Overlay = registrations.find(r => r.options.name === 'shell.overlay').component
  
  let ctlTree = render(React, React.createElement(Control, { sessionId: 's-test' }))
  React.__runEffects()
  await new Promise(r => setTimeout(r, 10))
  ctlTree = render(React, React.createElement(Control, { sessionId: 's-test' }))
  
  const ctlBtn = flatten(ctlTree).find(n => (n.props?.className ?? '').includes('skp-ctl'))
  ctlBtn.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) } })
  React.__runEffects()
  
  let popTree = render(React, React.createElement(Overlay, {}))
  const tabBtn = flatten(popTree).find(n => (n.props?.className ?? '').includes('skp-open-tab'))
  tabBtn.props.onClick({ stopPropagation: () => {}, preventDefault: () => {} })
  React.__runEffects()
  
  // Re-render to check if popover closed
  popTree = render(React, React.createElement(Overlay, {}))
  const popoverNodes = flatten(popTree).filter(n => typeof n === 'object' && n !== null && (n.props?.className ?? '').includes('skp-stage-pop'))
  
  return { calls, popoverNodes }
}

test('phase 9 shape 1: all services present: calls openTab once, openRightbar 0 times', async () => {
  const { mod, React } = await load()
  const { calls, popoverNodes } = await openPopoverAndClickSkillsTab(mod, React, { withSidebarRight: true, withLayout: true })
  assert.deepEqual(calls.openTab, ['skills'])
  assert.deepEqual(calls.openRightbar, [])
  assert.equal(popoverNodes.length, 0, 'popover must close')
})

test('phase 9 shape 2: sidebarRight absent: calls openRightbar once', async () => {
  const { mod, React } = await load()
  const { calls, popoverNodes } = await openPopoverAndClickSkillsTab(mod, React, { withSidebarRight: false, withLayout: true })
  assert.deepEqual(calls.openTab, [])
  assert.deepEqual(calls.openRightbar, [[true, false]])
  assert.equal(popoverNodes.length, 0, 'popover must close')
})

test('phase 9 shape 3: openTab throws: falls back to openRightbar once and error swallowed', async () => {
  const { mod, React } = await load()
  const { calls, popoverNodes } = await openPopoverAndClickSkillsTab(mod, React, { withSidebarRight: true, withSidebarRightError: true, withLayout: true })
  assert.deepEqual(calls.openTab, ['skills']) // It attempts it
  assert.deepEqual(calls.openRightbar, [[true, false]]) // It falls back
  assert.equal(popoverNodes.length, 0, 'popover must close')
})

test('phase 9 shape 4: neither present: nothing throws, popover closes', async () => {
  const { mod, React } = await load()
  const { calls, popoverNodes } = await openPopoverAndClickSkillsTab(mod, React, { withSidebarRight: false, withLayout: false })
  assert.deepEqual(calls.openTab, [])
  assert.deepEqual(calls.openRightbar, [])
  assert.equal(popoverNodes.length, 0, 'popover must close')
})
