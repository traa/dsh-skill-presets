/**
 * dsh-skill-presets client half.
 *
 * | Surface          | Slot                                       | Kind        |
 * | ---------------- | ------------------------------------------ | ----------- |
 * | Settings → Skills| `settings.section` (id `skills`)           | list/root   |
 * | Header chip      | `conversation.session.header.utilities`    | list/session|
 * | Session Skills tab| `sidebar.right.pane.tab` (key = tab id)   | keyed/session|
 * | Plugin card      | `settings.plugin.item` (key `skill-presets`)| keyed      |
 *
 * `slots` is the only hard requirement; `sidebarRightTabs` and `styles` are
 * read defensively so a shell missing one still renders the rest.
 * @module dsh-skill-presets/client
 */

// `react` is a loader module-table row; no @types/react here, `ReactLike` states the surface used.
// @ts-expect-error -- resolved at bundle time by the module table, not by tsc.
import * as ReactNamespace from 'react'
import { ScorecardController, SettingsController } from './controller.ts'
import { CSS, makeHeaderChip, makePluginCard, makeSettingsPage, makeSidebarBody, type ReactLike } from './views.ts'

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
export const inject = ['slots']

const TAB_ID = 'dsh-skill-presets'
const TAB_KIND = 'skills'

function insertStyles(styles: StylesLike | undefined): () => void {
  if (styles !== undefined) return styles.insert(CSS)
  if (typeof document === 'undefined') return () => {}
  const TAG = 'dsh-skill-presets'
  if (document.querySelector(`style[data-plugin="${TAG}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = TAG
  tag.textContent = CSS
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

  // Header chip: one component, per-session controller resolved from props.
  const chipCache = new Map<string, () => unknown>()
  const Chip = (props: { sessionId?: string }): unknown => {
    const sessionId = props.sessionId
    if (sessionId === undefined) return null
    let component = chipCache.get(sessionId)
    if (component === undefined) { component = makeHeaderChip(React, scorecardFor(sessionId)); chipCache.set(sessionId, component) }
    return React.createElement(component, null)
  }
  ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register({
    name: 'conversation.session.header.utilities',
    id: 'skill-presets',
    order: 40,
  }, Chip as (props: never) => unknown)), 'skill-presets: header chip')

  // Right sidebar tab: needs the tab-type registry; skipped when absent.
  const tabs = ctx.get('sidebarRightTabs') as SidebarTabsLike | undefined
  if (tabs !== undefined) {
    ctx.effect(() => tabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      priority: 'extension',
      title: () => 'Skills',
      guide: [{ order: 40, title: () => 'Skills', description: () => 'Active preset, practice scorecard, and which skills the model loaded this session.' }],
    }), 'skill-presets: tab type')
    const Body = makeSidebarBody(React, scorecardFor)
    ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
    }, Body as unknown as (props: never) => unknown)), 'skill-presets: tab body')
  }
}
