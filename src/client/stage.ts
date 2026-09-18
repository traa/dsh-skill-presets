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

export const STAGE_CSS = `
.skp-ctl { display: inline-flex; flex-wrap: nowrap; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border-radius: 999px; font: inherit; font-size: 12px; font-weight: 600; line-height: 1; flex: none; width: auto; max-width: none;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); cursor: pointer; white-space: nowrap;
  transition: background 150ms ease-out, border-color 150ms ease-out; }
.skp-ctl:hover { background: var(--dsw-alias-bg-overlay); }
.skp-ctl:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.skp-ctl[aria-expanded="true"] { border-color: var(--dsw-alias-brand-primary); }
.skp-ctl .skp-swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; margin: 0; }
.skp-ctl > * { flex: none; }
.skp-ctl-count { font-weight: 700; color: var(--dsw-alias-state-error-primary); white-space: nowrap; }
.skp-ctl-caret { color: var(--dsw-alias-label-secondary); font-size: 10px; }
.skp-stage-pop { position: fixed; width: 360px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; box-sizing: border-box;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.28); color: var(--dsw-alias-label-primary); font-size: 13px; z-index: 1; }
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
.skp-report-line { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
.skp-report-line .skp-report-what { font-size: 12px; min-width: 0; }
.skp-report-line .skp-report-what b { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.skp-report-line .skp-report-what span { display: block; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skp-report-actions { display: flex; gap: 4px; }
.skp-stage-btn { font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.skp-stage-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #0b1020; }
.skp-stage-btn.quiet { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.skp-stage-btn:disabled { opacity: .55; cursor: default; }
.skp-stage-skills { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.skp-stage-skills b { color: var(--dsw-alias-label-primary); font-weight: 500; }
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
    const swatch = card?.stage === null ? 'var(--dsw-alias-border-l2)' : undefined
    return h('button', {
      ref,
      type: 'button',
      className: 'skp skp-ctl',
      'aria-haspopup': 'dialog',
      'aria-expanded': snap.open ? 'true' : 'false',
      title: card === undefined ? 'Stage' : card.stage === null
        ? `${card.flow.title} flow — no stages, guardrails off`
        : `${card.flow.title} flow · ${STAGE_TITLE[card.stage] ?? card.stage}${card.position !== undefined ? ` (${card.position.index + 1} of ${card.position.of})` : ''}${card.gate !== undefined && card.gate !== null ? ` · next gate: ${card.gate}` : ''}${count > 0 ? ` · ${count} practice${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} action` : ''}`,
      onClick: () => controller.toggle(),
      onKeyDown: (e: { key: string, preventDefault(): void }) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); controller.toggle(true) }
      },
    },
      h('span', { className: 'skp-swatch', style: { background: swatch ?? 'var(--dsw-alias-brand-primary)' } }),
      label,
      count > 0 ? h('span', { className: 'skp-ctl-count', 'aria-label': `${count} practices need action` }, `· ${count}`) : null,
      h('span', { className: 'skp-ctl-caret', 'aria-hidden': 'true' }, '▾'),
    )
  }
}

/** One red, relevant practice: what, the evidence, one action, dismiss. */
function reportLine(h: ReactLike['createElement'], p: AnnotatedPractice, controller: StageController, busy: boolean): unknown {
  const fix = PRACTICE_FIX[p.id]
  return h('div', { key: p.id, className: 'skp-report-line', role: 'listitem' },
    h('div', { className: 'skp-report-what' },
      h('b', null, PRACTICE_TITLE[p.id] ?? p.id),
      h('span', { title: p.evidence.join(' · ') }, p.evidence[0] ?? ''),
    ),
    h('div', { className: 'skp-report-actions' },
      fix !== undefined && controller.requestFix !== undefined ? h('button', {
        type: 'button', className: 'skp-stage-btn', disabled: busy,
        title: `Ask the model to load the ${fix.skill} skill`,
        onClick: () => { controller.requestFix?.(p.id, fix.skill) },
      }, fix.label) : fix !== undefined ? h('span', { className: 'skp-stage-gate', title: `Load the ${fix.skill} skill` }, fix.skill) : null,
      h('button', { type: 'button', className: 'skp-stage-btn quiet', title: 'Hide for this session (three times mutes it for the workspace)', 'aria-label': `Dismiss ${PRACTICE_TITLE[p.id] ?? p.id}`, onClick: () => { void controller.dismissPractice(p.id) } }, '✕'),
    ),
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
    const report = card.report.filter(r => !snap.hidden.includes(r.id))
    const stages = card.flow.stages
    const current = card.stage
    return h('div', {
      ref,
      className: 'skp skp-stage-pop',
      role: 'dialog',
      'aria-label': 'Flow and stage',
      style: { left, bottom, width: W },
    },
      // Flow
      h('div', { className: 'skp-stage-head' },
        h('label', { htmlFor: 'skp-flow' }, 'Flow'),
        h('select', {
          id: 'skp-flow', className: 'skp-flow-select', value: card.flow.id, disabled: busy,
          onChange: (e: { target: { value: string } }) => { void controller.move({ flow: e.target.value }) },
        }, ...card.flows.map(f => h('option', { key: f.id, value: f.id, title: f.summary }, f.title))),
        card.flow.guardrails === 'off' ? h('span', { className: 'skp-stage-gate' }, 'guardrails off') : null,
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
      ) : h('div', { className: 'skp-stage-gate' }, `${card.flow.title}: no stages, guardrails off. Skills are still offered; nothing is judged.`),
      current !== null && card.gate !== undefined && card.gate !== null
        ? h('div', { className: 'skp-stage-gate' }, 'Ends with ', h('b', null, card.gate), card.next !== undefined && card.next !== null ? ` → then ${STAGE_TITLE[card.next] ?? card.next}` : ' — last stage of this flow')
        : null,
      // Collision: several presets own this stage and none is pinned.
      card.owners.length > 1 && card.presetId === null ? h('div', { className: 'skp-stage-gate' },
        'Several presets own this stage — pick one: ',
        ...card.owners.map(id => h('button', { key: id, type: 'button', className: 'skp-stage-btn', disabled: busy, onClick: () => { void controller.move({ stage: current, pin: id }) } }, id)),
      ) : null,
      // Suggestion (start-only)
      card.suggestion !== undefined && !snap.noticeDone ? h('div', { className: 'skp-report-line' },
        h('div', { className: 'skp-report-what' }, h('b', { style: { color: 'var(--dsw-alias-label-primary)' } }, `${card.suggestion.why[0] ?? 'Artifacts'} — start in ${STAGE_TITLE[card.suggestion.to] ?? card.suggestion.to}?`)),
        h('div', { className: 'skp-report-actions' },
          h('button', { type: 'button', className: 'skp-stage-btn primary', disabled: busy, onClick: () => { void controller.acceptSuggestion() } }, 'Yes'),
          h('button', { type: 'button', className: 'skp-stage-btn quiet', disabled: busy, onClick: () => { void controller.dismissSuggestion() } }, 'Not now'),
        ),
      ) : null,
      // Report: red + relevant only. Nothing when green.
      report.length > 0 ? h('hr', { className: 'skp-stage-sep' }) : null,
      report.length > 0 ? h('div', { role: 'list', 'aria-label': 'Practices needing action', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, ...report.map(p => reportLine(h, p, controller, busy))) : null,
      snap.error !== undefined ? h('div', { className: 'skp-stage-err' }, snap.error) : null,
      h('hr', { className: 'skp-stage-sep' }),
      h('div', { className: 'skp-stage-foot' },
        h('span', null, card.presetId !== null ? `Preset: ${card.presetId}` : card.stage === null ? 'No preset' : 'No preset for this stage'),
        h('span', null, card.source === 'session' ? 'this session' : card.source === 'legacy' ? 'this session (preset)' : card.source === 'agent-preset' ? 'agent-preset default' : 'workspace default'),
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
