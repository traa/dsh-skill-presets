/**
 * The stage control (Phase 7).
 *
 * One button in the composer tool row — where every shipping tool puts its
 * mode toggle — reading `◈ Build ▾`. Its popover renders through
 * `shell.overlay`, the frame-wide floating layer, so no ancestor's `overflow`
 * can clip it: the header chip it replaces drew its popover INSIDE a 40 px
 * `overflow: hidden` header and was 0 % visible. Control and popover live in
 * different slots (session vs root scope) and meet in `StageController`,
 * which carries the anchor rect and the open state.
 *
 * Operate-mode rules (Impeccable): ≤ 4 choices per decision, one primary
 * action per line, motion only for state, no pulse, no dot, no gradient.
 * @module dsh-skill-presets/client/stage
 */

import type { StageController } from './controller.ts'
import type { AnnotatedPractice } from './api.ts'
import type { ReactLike } from './views.ts'

const STAGE_TITLE: Record<string, string> = { plan: 'Plan', design: 'Design', build: 'Build', test: 'Review', deploy: 'Ship', maintain: 'Maintain', cross: 'Cross-stage' }
const PRACTICE_TITLE: Record<string, string> = {
  'worktree': 'Worktree', 'pull-request': 'Pull request', 'conductor': 'Conductor', 'artifact-chain': 'Stage artifact',
  'plan-before-code': 'Plan before code', 'plan-drift': 'Plan drift', 'worktree-hygiene': 'Worktrees', 'post-merge-sync': 'Sync',
}
/** The one action that fixes a red line; the skill the model should load. */
const PRACTICE_FIX: Record<string, { label: string, skill: string }> = {
  'worktree': { label: 'Create worktree', skill: 'worktree-first' },
  'pull-request': { label: 'Open PR', skill: 'pr-always' },
  'conductor': { label: 'Delegate', skill: 'conductor-protocol' },
  'artifact-chain': { label: 'Write artifact', skill: 'sdlc-stage-handoff' },
  'plan-before-code': { label: 'Write plan.md', skill: 'writing-plans' },
  'plan-drift': { label: 'Update plan.md', skill: 'executing-plans' },
  'worktree-hygiene': { label: 'Clean up', skill: 'worktree-cleanup' },
  'post-merge-sync': { label: 'Sync', skill: 'post-merge-sync' },
}
/**
 * What the gate word MEANS, spelled as the condition that ends the stage.
 * The host sends the bare token (`plan.md`, `PR`, `merge`); "Ends with PR"
 * says nothing to someone who has not read the flow docs, "Ends when a pull
 * request is open" says the whole thing.
 */
const GATE_LABEL: Record<string, string> = {
  'intent.md': 'intent.md is committed',
  'spec.md': 'spec.md is committed',
  'plan.md': 'plan.md is committed',
  'PR': 'a pull request is open',
  'merge': 'the PR is merged',
  'incident record': 'an incident record is committed',
}

export const STAGE_CSS = `
/*
 * The control is a COMPOSER CHIP, not a pill of our own invention: same recipe
 * as the shipped model/permission triggers beside it (ui-model-selection
 * ModelSelect.module.css .trigger, Figma ToggleButton 313:14108) — 28px high,
 * borderless, transparent, 24px radius, 13/20/500 secondary label, the shared
 * interactive hover token. Anything more (a border, a filled background, a
 * coloured swatch) makes the one plugin control in that row the loudest thing
 * in it.
 */
.skp-ctl { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px; font: inherit;
  min-width: 0; max-width: min(320px, 40cqw); flex-wrap: nowrap; white-space: nowrap;
  border: none; border-radius: 24px; outline: none; background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 13px; line-height: 20px; font-weight: 500; cursor: pointer; }
.skp-ctl:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.skp-ctl:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.skp-ctl[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.skp-ctl-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skp-ctl-count { flex: 0 0 auto; color: var(--dsw-alias-state-error-primary); }
.skp-ctl-caret { flex: 0 0 auto; color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 1; }
/* Same material as the shell's Menu primitive (see dsh-agent-teams .dat-picker). */
.skp-stage-pop { position: fixed; width: 360px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; box-sizing: border-box;
  background: var(--dsw-specific-menu); border: 1px solid var(--dsw-alias-border-inverted); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 10px;
  box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-label-primary); font-size: 13px; z-index: 1; }
.skp-stage-head { display: flex; align-items: center; gap: 8px; }
.skp-stage-head label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.skp-flow-select { font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: inherit; }
.skp-steps { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.skp-step { font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
  transition: background 150ms ease-out, color 150ms ease-out; }
.skp-step:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.skp-step:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.skp-step[aria-current="step"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); font-weight: 600; }
.skp-step-sep { color: var(--dsw-alias-border-l2); font-size: 11px; }
.skp-stage-gate { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.skp-stage-gate b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.skp-stage-sep { border-top: 1px solid var(--dsw-alias-border-l1); margin: 0; }
.skp-report-actions { display: flex; gap: 4px; }
.skp-stage-btn { font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.skp-stage-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted); }
.skp-stage-btn.quiet { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.skp-stage-btn:disabled { opacity: .55; cursor: default; }
/* The gate is the single most important line here: it answers "what ends this
   stage, and is it done?" in primary text, above the flow/stage controls. */
.skp-gate { font-size: 13px; line-height: 1.45; color: var(--dsw-alias-label-primary); }
.skp-gate b { font-weight: 600; }
.skp-gate-state { font-weight: 600; white-space: nowrap; }
.skp-gate-state.ok { color: var(--dsw-alias-state-success-primary); }
.skp-gate-state.todo { color: var(--dsw-alias-state-error-primary); }
.skp-gate-state.unknown { color: var(--dsw-alias-label-caption); }
/* Every relevant practice, always — the old popover showed only the red ones,
   so a green session said nothing about what was being watched. */
.skp-checks { display: flex; flex-direction: column; gap: 6px; }
.skp-check { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 8px; align-items: center; }
.skp-check > .skp-dot { margin: 0; }
.skp-check-title { font-size: 12px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skp-check-note { grid-column: 2 / 4; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-caption); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skp-check[data-status="red"] > .skp-check-note { color: var(--dsw-alias-state-error-primary); }
.skp-check .skp-report-actions { grid-row: 1; grid-column: 3; }
.skp-skills { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.skp-skills-head { font-size: 11px; color: var(--dsw-alias-label-secondary); width: 100%; }
.skp-skill { font-size: 12px; padding: 1px 7px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skp-open-tab { white-space: nowrap; }
.skp-stage-foot { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.skp-stage-err { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.skp-start-notice { display: flex; align-items: center; gap: 8px; padding: 6px 2px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.skp-start-notice b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.skp-start-notice .skp-stage-btn { padding: 2px 8px; }
`

function useStore<T>(React: ReactLike, store: { get(): T, subscribe(l: () => void): () => void }): T {
  const [value, setValue] = React.useState(() => store.get())
  React.useEffect(() => store.subscribe(() => setValue(store.get())), [store])
  return value
}

/** The composer-row button. Reports its rect to the controller so the overlay can anchor. */
export function makeStageControl(React: ReactLike, controller: StageController): () => unknown {
  const h = React.createElement.bind(React)
  return function StageControl(): unknown {
    const snap = useStore(React, controller)
    React.useEffect(() => controller.watch(), [])
    const ref = React.useRef<HTMLElement | null>(null)
    // Anchor: measured on open and on every layout-affecting event while open.
    React.useEffect(() => {
      if (!snap.open || typeof window === 'undefined') return undefined
      const measure = (): void => {
        const r = ref.current?.getBoundingClientRect()
        if (r !== undefined) controller.setAnchor({ x: r.left, y: r.top, width: r.width, height: r.height })
      }
      measure()
      window.addEventListener('resize', measure)
      window.addEventListener('scroll', measure, true)
      return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
    }, [snap.open])
    const card = snap.card
    const label = card === undefined ? (snap.loading ? '…' : 'Stage') : card.stage === null ? card.flow.title : STAGE_TITLE[card.stage] ?? card.stage
    const count = card?.report.filter(r => !snap.hidden.includes(r.id)).length ?? 0
    return h('button', {
      ref,
      type: 'button',
      className: 'skp skp-ctl',
      'aria-haspopup': 'dialog',
      'aria-expanded': snap.open ? 'true' : 'false',
      title: card === undefined ? 'Stage' : card.stage === null
        ? `${card.flow.title} flow — no stages, guardrails off`
        : `${card.flow.title} · ${STAGE_TITLE[card.stage] ?? card.stage}${card.position !== undefined ? ` (${card.position.index + 1} of ${card.position.of})` : ''}${card.gate !== undefined && card.gate !== null ? ` · ends with ${card.gate}` : ''}${count > 0 ? ` · ${count} practice${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} action` : ''}`,
      onClick: () => controller.toggle(),
      onKeyDown: (e: { key: string, preventDefault(): void }) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); controller.toggle(true) }
      },
    },
      h('span', { className: 'skp-ctl-label' }, label),
      count > 0 ? h('span', { className: 'skp-ctl-count', 'aria-label': `${count} practices need action` }, `· ${count}`) : null,
      h('span', { className: 'skp-ctl-caret', 'aria-hidden': 'true' }, '⌄'),
    )
  }
}

/**
 * The actions column of a red practice: the one fix, then dismiss.
 *
 * Since Phase 8 this is the ONLY thing left of the old report line — the
 * popover no longer has a red-only report block, so what a practice IS
 * (title, evidence) is rendered by `renderChecks` for every relevant
 * practice and this contributes just the buttons for the red ones.
 */
function checkActions(h: ReactLike['createElement'], p: AnnotatedPractice, controller: StageController, busy: boolean): unknown {
  const fix = PRACTICE_FIX[p.id]
  return h('div', { className: 'skp-report-actions' },
      fix !== undefined && controller.requestFix !== undefined ? h('button', {
        type: 'button', className: 'skp-stage-btn', disabled: busy,
        title: `Ask the model to load the ${fix.skill} skill`,
        onClick: () => { controller.requestFix?.(p.id, fix.skill) },
      }, fix.label ?? `Use ${fix.skill}`) : fix !== undefined ? h('span', { className: 'skp-stage-gate', title: `Load the ${fix.skill} skill` }, fix.skill) : null,
      h('button', { type: 'button', className: 'skp-stage-btn quiet', title: 'Hide for this session (three times mutes it for the workspace)', 'aria-label': `Dismiss ${PRACTICE_TITLE[p.id] ?? p.id}`, onClick: () => { void controller.dismissPractice(p.id) } }, '✕'),
  )
}

/** What the gate line reads from. The popover has a `PositionCard`, the sidebar a `Scorecard`; both can produce this. */
export interface GateFacts { artifacts?: string[], pr?: { url: string, state: string } | null }

/**
 * Is the gate condition met? `undefined` facts mean UNKNOWN, not "no": the
 * host does not always send git facts, and rendering "✗ not yet" for a gate
 * nobody looked at would be a lie the user cannot tell from a real verdict.
 */
function gateDone(gate: string, facts: GateFacts | undefined): 'ok' | 'todo' | 'unknown' {
  if (facts === undefined) return 'unknown'
  if (gate === 'PR') return facts.pr === undefined ? 'unknown' : facts.pr === null ? 'todo' : 'ok'
  if (gate === 'merge') {
    if (facts.pr === undefined) return 'unknown'
    return facts.pr !== null && /merged/iu.test(facts.pr.state) ? 'ok' : 'todo'
  }
  if (facts.artifacts === undefined) return 'unknown'
  const want = gate === 'incident record' ? 'incident' : gate
  return facts.artifacts.some(a => a.endsWith(want) || a.includes(want)) ? 'ok' : 'todo'
}

const GATE_STATE_TEXT: Record<'ok' | 'todo' | 'unknown', string> = { ok: '✓ done', todo: '✗ not yet', unknown: '? unknown' }

/**
 * The gate line — the most important sentence in either surface: what ends
 * this stage, whether it is done, and what comes after. Shared by the popover
 * and the Skills tab so the two cannot drift.
 */
export function renderGate(
  h: ReactLike['createElement'],
  position: { flowTitle: string, stage: string | null, gate?: string | null, next?: string | null },
  facts?: GateFacts,
): unknown {
  if (position.stage === null) {
    return h('div', { className: 'skp-gate' }, `${position.flowTitle}: no stages, guardrails off. Skills are still offered; nothing is judged.`)
  }
  const gate = position.gate
  if (gate === undefined || gate === null) {
    return h('div', { className: 'skp-gate' }, 'No gate for this stage.',
      position.next !== undefined && position.next !== null ? ` → then ${STAGE_TITLE[position.next] ?? position.next}` : ' — last stage of this flow')
  }
  const state = gateDone(gate, facts)
  return h('div', { className: 'skp-gate' },
    'Ends when ',
    h('b', null, GATE_LABEL[gate] ?? gate),
    ' ',
    h('span', { className: `skp-gate-state ${state}`, title: state === 'unknown' ? 'The host has not reported this fact yet' : undefined }, GATE_STATE_TEXT[state]),
    position.next !== undefined && position.next !== null ? ` → then ${STAGE_TITLE[position.next] ?? position.next}` : ' — last stage of this flow',
  )
}

/** One practice row's dot class and note, from its verdict. */
function checkNote(p: AnnotatedPractice, dismissed: boolean): { status: string, note: string, muted: boolean } {
  const evidence = p.evidence[0] ?? ''
  if (dismissed) return { status: 'green', note: 'dismissed', muted: true }
  if (p.kind === 'unknown') return { status: 'amber', note: `not judged — ${evidence}`, muted: true }
  if (p.status === 'red') return { status: 'red', note: evidence, muted: false }
  if (p.status === 'amber') return { status: 'amber', note: `${evidence} · advisory`, muted: true }
  if (p.status === 'n/a') return { status: 'n/a', note: evidence, muted: true }
  return { status: 'green', note: evidence, muted: true }
}

/**
 * EVERY relevant practice, in the order the host sent them — the point of
 * Phase 8's "make what it checks visible": a green session used to render an
 * empty popover, which reads as "nothing is watched" rather than "all clear".
 * Red rows keep the fix/dismiss actions; everything else is one quiet line.
 *
 * Returns a node ARRAY (the list, then the "+N not judged" footnote) so the
 * footnote stays outside `role="list"`.
 */
export function renderChecks(
  h: ReactLike['createElement'],
  practices: AnnotatedPractice[],
  options: { title?: (id: string) => string, controller?: StageController, busy?: boolean, hidden?: string[] } = {},
): unknown[] {
  const titleOf = options.title ?? ((id: string) => PRACTICE_TITLE[id] ?? id)
  const hidden = options.hidden ?? []
  const relevant = practices.filter(p => p.relevant)
  const skipped = practices.filter(p => !p.relevant && p.status !== 'n/a')
  const rows = relevant.map((p) => {
    const dismissed = hidden.includes(p.id)
    const { status, note } = checkNote(p, dismissed)
    const actionable = !dismissed && p.status === 'red' && p.kind !== 'unknown' && options.controller !== undefined
    return h('div', { key: p.id, className: 'skp-check', role: 'listitem', 'data-status': status },
      h('i', { className: `skp-dot ${status}` }),
      h('span', { className: 'skp-check-title' }, titleOf(p.id)),
      actionable ? checkActions(h, p, options.controller!, options.busy === true) : null,
      h('span', { className: 'skp-check-note', title: p.evidence.join(' · ') }, note),
    )
  })
  return [
    // No empty `role="list"`: a flow with guardrails off judges nothing, and
    // an empty list announced to a screen reader is noise.
    rows.length > 0 ? h('div', { key: 'checks', className: 'skp-checks', role: 'list', 'aria-label': 'Checked in this stage' }, ...rows) : null,
    skipped.length > 0
      ? h('div', { key: 'na', className: 'skp-na', title: skipped.map(p => `${titleOf(p.id)}: not judged in this stage`).join('\n') },
        `+${skipped.length} not judged in this stage`)
      : null,
  ]
}

/** The live "Skills in play" block: what the model is actually being offered. */
export function renderSkills(h: ReactLike['createElement'], skills: { name: string, via: string }[] | undefined): unknown {
  if (skills === undefined || skills.length === 0) return null
  const CAP = 16
  const shown = skills.slice(0, CAP)
  const rest = skills.slice(CAP)
  return h('div', { className: 'skp-skills' },
    h('span', { className: 'skp-skills-head' }, `Skills in play · ${skills.length}`),
    ...shown.map(s => h('span', {
      key: s.name,
      className: 'skp-skill',
      ...(s.via.startsWith('overlay:') ? { title: `from overlay ${s.via.slice('overlay:'.length)}` } : {}),
    }, s.name)),
    rest.length > 0 ? h('span', { className: 'skp-skill', title: rest.map(s => s.name).join('\n') }, `+${rest.length} more`) : null,
  )
}

/**
 * The popover, registered into `shell.overlay` (root scope). Renders nothing
 * while closed; positions itself above the anchor, clamped to the viewport.
 */
export function makeStagePopover(React: ReactLike, controller: StageController): () => unknown {
  const h = React.createElement.bind(React)
  return function StagePopover(): unknown {
    const snap = useStore(React, controller)
    const ref = React.useRef<HTMLElement | null>(null)
    const open = snap.open
    // Outside pointerdown / Escape close it. `pointerdown`, not `click`: the
    // click that opens also reaches document. The control's own rect is
    // excluded so its onClick keeps toggling.
    React.useEffect(() => {
      if (!open || typeof document === 'undefined') return undefined
      const inAnchor = (x: number, y: number): boolean => {
        const a = snap.anchor
        return a !== undefined && x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height
      }
      const onDown = (e: PointerEvent): void => {
        if (ref.current?.contains(e.target as Node) === true) return
        if (inAnchor(e.clientX, e.clientY)) return
        controller.toggle(false)
      }
      const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') controller.toggle(false) }
      document.addEventListener('pointerdown', onDown, true)
      document.addEventListener('keydown', onKey)
      return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey) }
    }, [open, snap.anchor])
    // Keyboard focus follows `focusStep`.
    React.useEffect(() => {
      if (!open || snap.focusStep === undefined || ref.current === null) return
      const el = ref.current.querySelectorAll<HTMLElement>('.skp-step')[snap.focusStep]
      el?.focus()
    }, [open, snap.focusStep])
    if (!open || snap.card === undefined) return null
    const card = snap.card
    const a = snap.anchor
    // Above the anchor, right-aligned to it, clamped into the viewport. Width is
    // fixed so we can compute the left edge before the first paint.
    const W = 360
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
    const left = a === undefined ? 8 : Math.max(8, Math.min(vw - W - 8, a.x + a.width - W))
    const bottom = a === undefined ? 8 : Math.max(8, (typeof window !== 'undefined' ? window.innerHeight : 800) - a.y + 6)
    const busy = snap.busy !== undefined
    const stages = card.flow.stages
    const current = card.stage
    return h('div', {
      ref,
      className: 'skp skp-stage-pop',
      role: 'dialog',
      'aria-label': 'Flow and stage',
      style: { left, bottom, width: W },
    },
      // The gate comes FIRST: "what ends this stage, and is it done?" is the
      // question this popover exists to answer.
      renderGate(h, { flowTitle: card.flow.title, stage: current, gate: card.gate, next: card.next }, { artifacts: card.artifacts, pr: card.pr }),
      // Flow
      h('div', { className: 'skp-stage-head' },
        h('label', { htmlFor: 'skp-flow' }, 'Flow'),
        h('select', {
          id: 'skp-flow', className: 'skp-flow-select', value: card.flow.id, disabled: busy,
          onChange: (e: { target: { value: string } }) => { void controller.move({ flow: e.target.value }) },
        }, ...card.flows.map(f => h('option', { key: f.id, value: f.id, title: f.summary }, f.title))),
      ),
      // Stages
      stages.length > 0 ? h('div', { className: 'skp-steps', role: 'group', 'aria-label': 'Stages' },
        ...stages.flatMap((s, i) => [
          i > 0 ? h('span', { key: `sep-${s}`, className: 'skp-step-sep', 'aria-hidden': 'true' }, '→') : null,
          h('button', {
            key: s, type: 'button', className: 'skp-step', disabled: busy,
            'aria-current': s === current ? 'step' : undefined,
            tabIndex: snap.focusStep === undefined ? (s === current ? 0 : -1) : (i === snap.focusStep ? 0 : -1),
            title: s === current ? `Current stage` : `Move to ${STAGE_TITLE[s] ?? s}`,
            onClick: () => { if (s !== current) void controller.move({ stage: s }) },
            onKeyDown: (e: { key: string, preventDefault(): void }) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); controller.focusStep(i + 1) }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); controller.focusStep(i - 1) }
              if (e.key === 'Home') { e.preventDefault(); controller.focusStep(0) }
              if (e.key === 'End') { e.preventDefault(); controller.focusStep(stages.length - 1) }
            },
          }, STAGE_TITLE[s] ?? s),
        ]),
      ) : null,
      // Collision: several presets own this stage and none is pinned.
      card.owners.length > 1 && card.presetId === null ? h('div', { className: 'skp-stage-gate' },
        'Several presets own this stage — pick one: ',
        ...card.owners.map(id => h('button', { key: id, type: 'button', className: 'skp-stage-btn', disabled: busy, onClick: () => { void controller.move({ stage: current, pin: id }) } }, id)),
      ) : null,
      // What is being checked — ALL of it, not just the failures.
      card.practices.some(p => p.relevant) ? h('hr', { className: 'skp-stage-sep' }) : null,
      ...renderChecks(h, card.practices, { controller, busy, hidden: snap.hidden }),
      // What the model is actually carrying right now.
      renderSkills(h, card.skills),
      // Suggestion (start-only). The Yes / Not now live in the notice under the
      // composer — ONE place to decide. Here it is a quiet pointer: clicking the
      // suggested stage in the step row above is the same move.
      card.suggestion !== undefined && !snap.noticeDone ? h('div', { className: 'skp-stage-gate' },
        `${card.suggestion.why[0] ?? 'Artifacts'} — `, h('b', null, STAGE_TITLE[card.suggestion.to] ?? card.suggestion.to), ' is suggested; pick it above, or answer under the composer.') : null,
      snap.error !== undefined ? h('div', { className: 'skp-stage-err' }, snap.error) : null,
      h('hr', { className: 'skp-stage-sep' }),
      h('div', { className: 'skp-stage-foot' },
        h('span', null, card.presetId !== null ? `Preset: ${card.presetId}` : card.stage === null ? 'No preset' : 'No preset for this stage'),
        h('button', {
          type: 'button', className: 'skp-stage-btn quiet skp-open-tab',
          title: `Open the Skills tab — set by ${card.source === 'session' || card.source === 'legacy' ? 'this session' : card.source === 'agent-preset' ? 'the agent-preset default' : 'the workspace default'}`,
          onClick: () => { controller.openSkillsTab() },
        }, 'Open Skills tab'),
      ),
    )
  }
}

/** The one-line start suggestion under the composer. Disappears on accept/dismiss. */
export function makeStartNotice(React: ReactLike, controller: StageController): () => unknown {
  const h = React.createElement.bind(React)
  return function StartNotice(): unknown {
    const snap = useStore(React, controller)
    React.useEffect(() => controller.watch(), [])
    const s = snap.card?.suggestion
    if (s === undefined || snap.noticeDone) return null
    const busy = snap.busy !== undefined
    return h('div', { className: 'skp skp-start-notice', role: 'status' },
      h('span', null, `${s.why[0] ?? 'Artifacts'} — start in `, h('b', null, STAGE_TITLE[s.to] ?? s.to), '?'),
      h('button', { type: 'button', className: 'skp-stage-btn primary', disabled: busy, onClick: () => { void controller.acceptSuggestion() } }, 'Yes'),
      h('button', { type: 'button', className: 'skp-stage-btn quiet', disabled: busy, onClick: () => { void controller.dismissSuggestion() } }, 'Not now'),
    )
  }
}
