// The stage shell: enough of the page's plugin runtime for `lib/client.js` to
// run unmodified. Loader handoff, `require('react')`, a `slots` registry that
// mounts occupants into DOM regions named like the real slots, a `styles`
// service, `sidebarRightTabs`, and the `fetch` header that picks the fixture.
/* global React, ReactDOM */
(() => {
  const params = new URLSearchParams(location.search)
  const FIXTURE = params.get('fixture') ?? 'green'
  const SESSION_ID = params.get('session') ?? 'stage-session'
  document.title = `stage · ${FIXTURE}`

  // Every RPC carries the fixture so one server can serve several tabs.
  const realFetch = window.fetch.bind(window)
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('/plugins/dsh-skill-presets/rpc/')) {
      init = { ...init, headers: { ...(init.headers ?? {}), 'x-stage-fixture': FIXTURE } }
    }
    return realFetch(input, init)
  }

  // ------------------------------------------------------------ slots ------
  // A registration is `{ options: { name, id?, key?, order? }, component }`.
  // `list` slots render every occupant in `order`; `keyed`/`single` render the
  // matching key. Props mirror what the shell passes: `sessionId` for
  // session-scoped slots, `useTabInfo` for the pane tab.
  const regions = Object.fromEntries([...document.querySelectorAll('[data-slot]')].map(el => [el.dataset.slot, el]))
  const occupants = new Map() // slot name -> registration[]
  const roots = new Map() // slot name -> ReactDOM root
  const SESSION_SCOPED = new Set(['conversation.session.header.utilities', 'conversation.input.left', 'conversation.input.right', 'conversation.input.dock', 'conversation.composer.dock', 'sidebar.right.pane.tab', 'shell.overlay'])
  const activeTab = { key: null }
  const activeSection = { id: null }

  function render(name) {
    const region = regions[name]
    if (region === undefined) return
    let root = roots.get(name)
    if (root === undefined) { root = ReactDOM.createRoot(region); roots.set(name, root) }
    const regs = [...(occupants.get(name) ?? [])].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
    const props = SESSION_SCOPED.has(name) ? { sessionId: SESSION_ID } : {}
    let children
    if (name === 'sidebar.right.pane.tab') {
      const reg = regs.find(r => r.options.key === activeTab.key)
      children = reg ? [React.createElement(reg.component, { key: reg.options.key, ...props, useTabInfo: () => ({ tab: { visible: true } }) })] : []
    } else if (name === 'settings.section') {
      const reg = regs.find(r => r.options.id === activeSection.id) ?? regs[0]
      children = reg ? [React.createElement(reg.component, { key: reg.options.id, ...props })] : []
    } else {
      children = regs.map(r => React.createElement(r.component, { key: r.options.id ?? r.options.key, ...props }))
    }
    root.render(React.createElement(React.Fragment, null, ...children))
  }

  const slots = {
    inject(_key, cb) { const off = cb(); return typeof off === 'function' ? off : () => {} },
    register(options, component) {
      const list = occupants.get(options.name) ?? []
      const reg = { options, component }
      list.push(reg)
      occupants.set(options.name, list)
      if (options.name === 'settings.section') renderSettingsNav()
      // The tab TYPE registers before the tab BODY; the first body to arrive for
      // the active tab is what the pane should show.
      if (options.name === 'sidebar.right.pane.tab' && activeTab.key === null) activeTab.key = options.key
      render(options.name)
      return () => {
        const cur = occupants.get(options.name) ?? []
        occupants.set(options.name, cur.filter(r => r !== reg))
        render(options.name)
      }
    },
  }

  const styles = {
    insert(css) {
      const tag = document.createElement('style')
      tag.dataset.stage = 'plugin'
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    },
  }

  const tabTypes = []
  const sidebarRightTabs = {
    register(definition) {
      tabTypes.push(definition)
      renderTabs()
      if (activeTab.key === null) { activeTab.key = definition.id; render('sidebar.right.pane.tab') }
      return () => { const i = tabTypes.indexOf(definition); if (i !== -1) tabTypes.splice(i, 1); renderTabs() }
    },
  }

  function renderTabs() {
    const host = document.getElementById('right-tabs')
    host.innerHTML = ''
    for (const t of tabTypes) {
      const b = document.createElement('button')
      b.textContent = t.title(SESSION_ID)
      b.dataset.tab = t.id
      b.className = t.id === activeTab.key ? 'on' : ''
      b.onclick = () => { activeTab.key = t.id; renderTabs(); render('sidebar.right.pane.tab') }
      host.appendChild(b)
    }
  }

  function renderSettingsNav() {
    const host = document.getElementById('settings-nav')
    host.innerHTML = ''
    for (const r of occupants.get('settings.section') ?? []) {
      const b = document.createElement('button')
      b.textContent = typeof r.options.label === 'function' ? r.options.label() : (r.options.label ?? r.options.id)
      b.dataset.section = r.options.id
      b.className = (activeSection.id ?? r.options.id) === r.options.id ? 'on' : ''
      b.onclick = () => { activeSection.id = r.options.id; renderSettingsNav(); render('settings.section') }
      host.appendChild(b)
    }
  }

  // Sidebar nav between the conversation and settings views.
  for (const a of document.querySelectorAll('[data-stage-nav]')) {
    a.onclick = (e) => {
      e.preventDefault()
      for (const x of document.querySelectorAll('[data-stage-nav]')) x.classList.toggle('on', x === a)
      for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === `view-${a.dataset.stageNav}`)
    }
  }

  // Fixture switcher (server-side list).
  fetch('/__stage/fixtures').then(r => r.json()).then((names) => {
    const host = document.getElementById('fixtures')
    for (const n of names) {
      const a = document.createElement('a')
      a.href = `/?fixture=${n}`
      a.textContent = n
      a.className = n === FIXTURE ? 'on' : ''
      host.appendChild(a)
    }
  }).catch(() => {})

  // ------------------------------------------------------------ loader -----
  const services = { slots, styles, sidebarRightTabs }
  const ctx = {
    get: name => services[name],
    effect: (cb) => { const off = cb(); return typeof off === 'function' ? off : () => {} },
  }
  window.__STAGE__ = { fixture: FIXTURE, sessionId: SESSION_ID, occupants, tabTypes, regions, applied: false, error: undefined }
  window.__ModuleLoader__ = {
    load({ id, factory }) {
      try {
        const mod = factory((name) => {
          if (name === 'react') return React
          throw new Error(`stage: unexpected require(${name})`)
        })
        window.__STAGE__.module = { id, name: mod.name, inject: mod.inject }
        mod.apply(ctx)
        window.__STAGE__.applied = true
        document.documentElement.dataset.stageReady = '1'
      } catch (error) {
        window.__STAGE__.error = String(error?.stack ?? error)
        document.documentElement.dataset.stageError = '1'
        console.error(error)
      }
    },
  }
  const script = document.createElement('script')
  script.src = '/plugins/dsh-skill-presets/client.js'
  document.body.appendChild(script)
})()
