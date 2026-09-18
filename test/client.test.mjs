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
  // The stage name is named AND its number is spelled out as confidence, so a
  // reader cannot take "Test & Review 85%" for progress through that stage.
  assert.match(words.replace(/\s+/gu, ' '), /Detected stage: Test & Review — 85% confident/)
  assert.doesNotMatch(words, /Test & Review\s*\(85%\)/)
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

test('practices that do not apply are replaced by one muted "+N not applicable" line carrying their reasons', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx()
  const { scorecard, status } = mixedFixture()
  globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/scorecard') ? scorecard : status) })
  mod.apply(ctx)
  const Body = registrations.find(r => r.options.name === 'sidebar.right.pane.tab').component
  const props = { sessionId: 's-4', useTabInfo: () => ({ tab: { visible: true } }) }
  render(React, React.createElement(Body, props))
  React.__runEffects()
  await new Promise(r => setTimeout(r, 30))
  const tree = render(React, React.createElement(Body, props))
  const words = text(tree).join(' ')
  // The applicable practice still renders in full, with its evidence.
  assert.match(words, /Work in a worktree/)
  assert.match(words, /protected branch main/)
  // The n/a rows are gone from the list.
  assert.doesNotMatch(words, /Plan before code: n\/a/)
  assert.doesNotMatch(words, /applies in the Build stage/)
  assert.doesNotMatch(words, /no team attached/)
  // …replaced by exactly one muted summary line.
  const na = nodesWithClass(tree, 'skp-na')
  assert.equal(na.length, 1)
  assert.equal(text(na[0]).join(''), '+2 not applicable in this stage')
  // Nothing is unreachable: titles AND reasons live in the hover text.
  assert.match(na[0].props.title, /Plan before code: applies in the Build stage/)
  assert.match(na[0].props.title, /Conductor protocol: no team attached/)
  React.__runEffects()
  await new Promise(r => setTimeout(r, 5))
})

test('when every practice is n/a the muted line stands alone rather than an empty section', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx()
  const { scorecard, status } = mixedFixture()
  scorecard.practices = scorecard.practices.map(p => ({ ...p, status: 'n/a' }))
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
  assert.equal(text(na[0]).join(''), '+3 not applicable in this stage')
  // The section still has its heading, so it cannot read as a broken empty block.
  assert.match(text(tree).join(' '), /Practices/)
  React.__runEffects()
  await new Promise(r => setTimeout(r, 5))
})

test('a sub-threshold stage guess names no stage: the 0.5 fallback is muted, not announced like a finding', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx()
  const { scorecard, status } = mixedFixture()
  // What detectStage returns when nothing matched at all.
  scorecard.stageGuess = { stage: 'plan', confidence: 0.5, why: ['nothing observed yet; defaulting to Plan'] }
  globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/scorecard') ? scorecard : status) })
  mod.apply(ctx)
  const Body = registrations.find(r => r.options.name === 'sidebar.right.pane.tab').component
  const props = { sessionId: 's-6', useTabInfo: () => ({ tab: { visible: true } }) }
  render(React, React.createElement(Body, props))
  React.__runEffects()
  await new Promise(r => setTimeout(r, 30))
  const tree = render(React, React.createElement(Body, props))
  const words = text(tree).join(' ').replace(/\s+/gu, ' ')
  assert.match(words, /Detected stage: not yet clear/)
  // No stage is named and no percentage is shown on the line itself.
  assert.doesNotMatch(words, /Detected stage: Plan/)
  assert.doesNotMatch(words, /50%/)
  // The guess is muted, not discarded: stage, exact figure and reason stay on hover.
  const line = nodesWithClass(tree, 'skp-why').find(n => /not yet clear/u.test(text(n).join('')))
  assert.ok(line, 'the muted stage line should carry the skp-why class')
  assert.match(line.props.title, /Plan/)
  assert.match(line.props.title, /50% confidence/)
  assert.match(line.props.title, /nothing observed yet; defaulting to Plan/)
  // It must not be counted as a "+N not applicable" practice line.
  assert.equal(nodesWithClass(tree, 'skp-na').filter(n => /not yet clear/u.test(text(n).join(''))).length, 0)
  React.__runEffects()
  await new Promise(r => setTimeout(r, 5))
})

test('the popover hides n/a practices and shows the session scope as a neutral pill at the top, not a green paragraph', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx()
  const { scorecard, status } = mixedFixture()
  globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/scorecard') ? scorecard : status) })
  mod.apply(ctx)
  const Chip = registrations.find(r => r.options.name === 'conversation.session.header.utilities').component
  const props = { sessionId: 's-4' }
  render(React, React.createElement(Chip, props))
  React.__runEffects()
  await new Promise(r => setTimeout(r, 30))
  // Open the popover by clicking the chip, exactly as a user does.
  const closed = render(React, React.createElement(Chip, props))
  flatten(closed).find(n => (n.props?.className ?? '').startsWith('skp-hchip')).props.onClick()
  // Click the preset row: this is the real `activate(id, 'session')` path.
  const open = render(React, React.createElement(Chip, props))
  const row = flatten(open).find(n => (n.props?.className ?? '').startsWith('skp-pop-item') && text(n).join('').includes('Build'))
  assert.ok(row, 'the popover lists the Build preset')
  row.props.onClick()
  await new Promise(r => setTimeout(r, 30))
  // Activating closes the popover; reopen it to read what the switch left.
  const afterActivate = render(React, React.createElement(Chip, props))
  flatten(afterActivate).find(n => (n.props?.className ?? '').startsWith('skp-hchip')).props.onClick()
  const tree = render(React, React.createElement(Chip, props))
  const words = text(tree).join(' ')

  // FIX 2 in the popover: the n/a rows are gone, the summary line is present.
  assert.match(words, /Work in a worktree: red/)
  assert.doesNotMatch(words, /Plan before code: n\/a/)
  const na = nodesWithClass(tree, 'skp-na')
  assert.equal(na.length, 1)
  assert.equal(text(na[0]).join(''), '+2 not applicable in this stage')
  assert.match(na[0].props.title, /Conductor protocol: no team attached/)

  // FIX 3: the scope confirmation is a NEUTRAL pill (no green/amber/red
  // variant), and it sits at the top of the popover, not at the bottom.
  const pop = nodesWithClass(tree, 'skp-pop')[0]
  const pill = nodesWithClass(pop, 'skp-pill').find(n => text(n).join('') === 'session only')
  assert.ok(pill, 'a "session only" pill renders')
  assert.equal(pill.props.className, 'skp-pill', 'neutral variant: no green')
  assert.match(pill.props.title, /This session only\. Catalog updates on the model's next step\./)
  // It is no longer a green .skp-msg.ok paragraph anywhere in the popover.
  assert.deepEqual(nodesWithClass(pop, 'ok').map(n => text(n).join('')), [])
  // Top, not bottom: the pill precedes the practice list in document order.
  const flat = []
  const walk = (n) => { if (n && typeof n === 'object') { if (Array.isArray(n)) n.forEach(walk); else { flat.push(n); (n.children ?? []).forEach(walk) } } }
  walk(pop)
  assert.ok(flat.indexOf(pill) < flat.indexOf(na[0]), 'pill renders above the practice list')
})

test('a genuine success notice still renders as the green paragraph it always was', async () => {
  const { mod, React } = await load()
  const { ctx, registrations } = fakeCtx()
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
