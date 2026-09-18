/**
 * dsh-skill-presets client half.
 *
 * | Surface          | Slot                                       | Kind        |
 * | ---------------- | ------------------------------------------ | ----------- |
 * | Settings → Skills| `settings.section` (id `skills`)           | list/root   |
 * | Stage control    | `conversation.input.right` (id `skill-presets-stage`) | list/session |
 * | Stage popover    | `shell.overlay` (id `skill-presets-stage-pop`)        | list/root    |
 * | Start notice     | `conversation.composer.dock` (id `skill-presets-start`)| list/session |
 * | Session Skills tab| `sidebar.right.pane.tab` (key = tab id) — opened from the right sidebar's Guide page ("New tab" +) | keyed/session|
 * | Plugin card      | `settings.plugin.item` (key `skill-presets`)| keyed      |
 *
 * The header chip (`conversation.session.header.utilities`) is GONE since
 * Phase 7: its popover rendered inside a 40 px `overflow: hidden` header and
 * was 0 % visible. The control now sits in the composer tool row, where every
 * shipping tool puts its mode toggle, and its popover goes through
 * `shell.overlay` — the frame-wide floating layer nothing can clip.
 *
 * Everything this plugin reads from the shell must be listed in `inject`:
 * `ctx.get(name)` returns `undefined` for a service that is not injected, even
 * when the shell provides it. Phase 8 fixed exactly that bug — `sidebarRightTabs`
 * was missing, so the tab type never registered and the Skills card never
 * appeared on the Guide page. `slots` is the only hard requirement; the rest is
 * still read defensively so a shell missing one still renders the rest.
 * @module dsh-skill-presets/client
 */

// `react` is a loader module-table row; no @types/react here, `ReactLike` states the surface used.
// @ts-expect-error -- resolved at bundle time by the module table, not by tsc.
import * as ReactNamespace from 'react'
import { Store } from './api.ts'
import { ScorecardController, SettingsController, StageController } from './controller.ts'
import { STAGE_CSS, makeStageControl, makeStagePopover, makeStartNotice } from './stage.ts'
import { CSS, makePluginCard, makeSettingsPage, makeSidebarBody, type ReactLike } from './views.ts'

interface ClientLike {
  get(name: string): unknown
  effect(callback: () => (() => void) | void, label?: string): () => void
}

interface SlotsLike {
  inject(key: string, callback: () => (() => void) | void): () => void
  register(
    options: { name: string, key?: string, id?: string, order?: number, label?: () => string, locale?: string },
    component: (props: never) => unknown,
  ): () => void
}

interface StylesLike { insert(css: string): () => void }

/** The shell's layout service; only `openRightbar` is used. */
interface LayoutLike { openRightbar(track: boolean, fullscreen: boolean): void }

interface SidebarTabsLike {
  register(definition: {
    id: string
    kind: string
    priority?: 'extension' | 'builtin' | 'fallback'
    title(address: string): string
    guide?: { order: number, title(): string, description?(): string }[]
  }): () => void
}

export const name = 'client-ui-skill-presets'
export const inject = ['slots', 'sidebarRightTabs', 'layout']

const TAB_ID = 'dsh-skill-presets'
const TAB_KIND = 'skills'

function insertStyles(styles: StylesLike | undefined): () => void {
  const all = CSS + STAGE_CSS
  if (styles !== undefined) return styles.insert(all)
  if (typeof document === 'undefined') return () => {}
  const TAG = 'dsh-skill-presets'
  if (document.querySelector(`style[data-plugin="${TAG}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = TAG
  tag.textContent = all
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

export function apply(ctx: ClientLike): void {
  const slots = ctx.get('slots') as SlotsLike | undefined
  if (slots === undefined) return
  const React = ReactNamespace as unknown as ReactLike
  if (typeof React?.createElement !== 'function') return

  ctx.effect(() => insertStyles(ctx.get('styles') as StylesLike | undefined), 'skill-presets: styles')

  const settings = new SettingsController()
  const scorecards = new Map<string, ScorecardController>()
  const scorecardFor = (sessionId: string): ScorecardController => {
    let c = scorecards.get(sessionId)
    if (c === undefined) { c = new ScorecardController(sessionId); scorecards.set(sessionId, c) }
    return c
  }

  const Page = makeSettingsPage(React, settings)
  ctx.effect(() => slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'skills',
    order: 40,
    label: () => 'Skills',
  }, Page as (props: never) => unknown)), 'skill-presets: settings section')

  const Card = makePluginCard(React, settings)
  ctx.effect(() => slots.inject('settings.plugin.item', () => slots.register({
    name: 'settings.plugin.item',
    key: 'skill-presets',
  }, Card as (props: never) => unknown)), 'skill-presets: plugin card')

  // Stage control (composer row) + its popover (shell.overlay) + the start
  // notice (under the composer). One controller per session, shared by all
  // three: the control measures its own rect into the controller and the
  // root-scoped popover reads it back — the two slots never see each other.
  const stages = new Map<string, StageController>()
  // The root-scoped overlay must re-render when a session controller is
  // created after it mounted; this store's version bumps on every creation.
  const roster = new Store<{ n: number }>({ n: 0 })
  // The popover's "Open Skills tab" needs the shell's layout service; absent
  // in a shell without it, and the button then only closes the popover.
  const layout = ctx.get('layout') as LayoutLike | undefined
  const stageFor = (sessionId: string): StageController => {
    let c = stages.get(sessionId)
    if (c === undefined) { c = new StageController(sessionId); c.attachLayout(layout); stages.set(sessionId, c); roster.set({ n: roster.get().n + 1 }) }
    return c
  }
  const perSession = (make: (c: StageController) => () => unknown): ((props: { sessionId?: string }) => unknown) => {
    const cache = new Map<string, () => unknown>()
    return (props) => {
      const sessionId = props.sessionId
      if (sessionId === undefined) return null
      let component = cache.get(sessionId)
      if (component === undefined) { component = make(stageFor(sessionId)); cache.set(sessionId, component) }
      return React.createElement(component, null)
    }
  }
  ctx.effect(() => slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'skill-presets-stage',
    order: 30,
  }, perSession(c => makeStageControl(React, c)) as (props: never) => unknown)), 'skill-presets: stage control')
  ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register({
    name: 'conversation.composer.dock',
    id: 'skill-presets-start',
    order: 30,
  }, perSession(c => makeStartNotice(React, c)) as (props: never) => unknown)), 'skill-presets: start notice')
  // `shell.overlay` is ROOT-scoped: no sessionId in props. Render every
  // session's popover; each renders null unless open, and only one can be
  // open at a time because a pointerdown elsewhere closes the others.
  const Overlay = (): unknown => {
    const [, setN] = React.useState(0)
    React.useEffect(() => roster.subscribe(() => setN(roster.get().n)), [])
    return React.createElement(React.Fragment ?? 'div', null,
      ...[...stages.values()].map(c => React.createElement(makeStagePopoverFor(c), { key: c.sessionId })))
  }
  const popCache = new Map<StageController, () => unknown>()
  const makeStagePopoverFor = (c: StageController): (() => unknown) => {
    let component = popCache.get(c)
    if (component === undefined) { component = makeStagePopover(React, c); popCache.set(c, component) }
    return component
  }
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'skill-presets-stage-pop',
    order: 40,
  }, Overlay as (props: never) => unknown)), 'skill-presets: stage popover')

  // Right sidebar tab: needs the tab-type registry; skipped when absent.
  const tabs = ctx.get('sidebarRightTabs') as SidebarTabsLike | undefined
  if (tabs !== undefined) {
    ctx.effect(() => tabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      priority: 'extension',
      title: () => 'Skills',
      guide: [{ order: 40, title: () => 'Skills', description: () => 'Flow, stage and what ends it; what is being checked; the skills in play; every skill the model loaded this session.' }],
    }), 'skill-presets: tab type')
    const Body = makeSidebarBody(React, scorecardFor)
    ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
    }, Body as unknown as (props: never) => unknown)), 'skill-presets: tab body')
  }
}
