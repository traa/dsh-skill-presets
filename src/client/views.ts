/**
 * Views, written with `React.createElement` throughout — no JSX, because a
 * packaged out-of-tree bundle gets no JSX transform. Every colour is a harness
 * theme token so light and dark both work.
 * @module dsh-skill-presets/client/views
 */

import type { CompareCard, LockedSkill, Preset, PracticeResult, PracticesDoc, Rollup, Scorecard, SessionSummary, Status } from './api.ts'
import type { ScorecardController, SettingsController, SettingsSnapshot } from './controller.ts'

export interface ReactLike {
  createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  useState<T>(initial: T | (() => T)): [T, (next: T) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
  Fragment?: unknown
}

export const CSS = `
.skp { font-size: 13px; color: var(--dsw-alias-label-primary); }
.skp-page { display: flex; flex-direction: column; gap: 14px; max-width: 980px; }
.skp-h1 { font-size: 18px; font-weight: 650; margin: 0; }
.skp-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.skp-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.skp-tab { font: inherit; font-size: 12px; font-weight: 600; padding: 7px 12px; border: 0; background: none; cursor: pointer;
  color: var(--dsw-alias-label-secondary); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.skp-tab.on { color: var(--dsw-alias-brand-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.skp-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.skp-col { display: flex; flex-direction: column; gap: 6px; }
.skp-btn { font: inherit; font-size: 12px; font-weight: 550; padding: 6px 12px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.skp-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.skp-btn:disabled { opacity: .5; cursor: not-allowed; }
.skp-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.skp-btn.small { padding: 3px 8px; font-size: 11px; }
.skp-btn.danger { color: var(--dsw-alias-state-error-primary); }
.skp-input { font: inherit; font-size: 13px; padding: 6px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); width: 100%; box-sizing: border-box; }
.skp-input.small { width: auto; font-size: 11px; padding: 2px 6px; }
.skp-msg { font-size: 12px; line-height: 1.5; }
.skp-msg.error { color: var(--dsw-alias-state-error-primary); }
.skp-msg.ok { color: var(--dsw-alias-state-success-primary); }
.skp-pill { font-size: 11px; font-weight: 650; padding: 1px 8px; border-radius: 9px; display: inline-flex; align-items: center; gap: 5px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); }
.skp-pill.green { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent); color: var(--dsw-alias-state-success-primary); border-color: transparent; }
.skp-pill.amber { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 17%, transparent); color: var(--dsw-alias-state-warn-primary); border-color: transparent; }
.skp-pill.red { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent); color: var(--dsw-alias-state-error-primary); border-color: transparent; }
.skp-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; background: var(--dsw-alias-border-l2); }
.skp-dot.green { background: var(--dsw-alias-state-success-primary); }
.skp-dot.amber { background: var(--dsw-alias-state-warn-primary); }
.skp-dot.red { background: var(--dsw-alias-state-error-primary); }
.skp-loop { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.skp-stage { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
  background: var(--dsw-alias-bg-layer-1); position: relative; }
.skp-stage.on { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent); }
.skp-stage-h { display: flex; align-items: center; gap: 8px; }
.skp-swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.skp-stage-t { font-weight: 650; font-size: 13px; }
.skp-stage-s { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.45; }
.skp-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.skp-chip { font-size: 11px; padding: 1px 7px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.skp-chip.miss { border-style: dashed; color: var(--dsw-alias-state-warn-primary); }
.skp-chip.overlay { border-color: var(--dsw-alias-brand-primary); }
.skp-bar { height: 5px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.skp-bar > i { display: block; height: 100%; background: var(--dsw-alias-state-success-primary); }
.skp-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.skp-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.skp-table td { padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.skp-table tr.click { cursor: pointer; }
.skp-table tr.click:hover td { background: var(--dsw-alias-bg-layer-2); }
.skp-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.skp-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 8px; }
.skp-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(640px, 92vw); z-index: 60; background: var(--dsw-alias-bg-base);
  border-left: 1px solid var(--dsw-alias-border-l1); box-shadow: -8px 0 30px rgba(0,0,0,.18); display: flex; flex-direction: column; }
.skp-drawer-h { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.skp-drawer-b { padding: 12px 14px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; }
.skp-pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5;
  background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 10px 12px; margin: 0; }
.skp-hchip { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 9px;
  cursor: pointer; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); position: relative; }
.skp-hchip:hover { background: var(--dsw-alias-bg-layer-2); }
.skp-pop { position: absolute; top: calc(100% + 6px); right: 0; width: 340px; z-index: 50; background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.18); padding: 10px; display: flex; flex-direction: column; gap: 8px; text-align: left; }
.skp-pop-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.skp-pop-item:hover { background: var(--dsw-alias-bg-layer-2); }
.skp-pop-item.on { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.skp-pop-t { font-weight: 650; font-size: 12px; }
.skp-pop-s { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.4; }
.skp-side { padding: 12px; display: flex; flex-direction: column; gap: 12px; overflow: auto; height: 100%; box-sizing: border-box; }
.skp-side h3 { font-size: 12px; font-weight: 650; margin: 0; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .04em; }
.skp-skill-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.skp-skill-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skp-skill-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); flex: none; }
.skp-timeline { display: flex; gap: 3px; flex-wrap: wrap; }
.skp-tick { width: 10px; height: 10px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.skp-tick.hit { background: var(--dsw-alias-state-success-primary); border-color: transparent; }
.skp-ev { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.4; margin-left: 16px; }
.skp-rate { display: flex; gap: 6px; }
.skp-graph { position: relative; height: 240px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.skp-node { position: absolute; transform: translate(-50%, -50%); font-size: 11px; padding: 2px 7px; border-radius: 8px; background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.skp-edge { position: absolute; height: 1px; background: var(--dsw-alias-border-l2); transform-origin: 0 0; }
.skp-lock { opacity: .7; }
.skp-pulse { animation: skp-pulse 1.4s ease-in-out infinite; }
@keyframes skp-pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
`

/** Bind `useState`+`useEffect` to a store. */
function useStoreHook<T>(React: ReactLike, store: { get(): T, subscribe(l: () => void): () => void }): T {
  const [value, setValue] = React.useState<T>(() => store.get())
  React.useEffect(() => store.subscribe(() => setValue(store.get())), [])
  return value
}

const STAGE_LABEL: Record<string, string> = { plan: 'Plan', design: 'Design', build: 'Build', test: 'Test & Review', deploy: 'Deploy', maintain: 'Maintain', cross: 'Cross-stage' }

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

// ---------------------------------------------------------------- Settings --

export function makeSettingsPage(React: ReactLike, controller: SettingsController): () => unknown {
  const h = React.createElement.bind(React)

  const practicePill = (r: PracticeResult | undefined, label: string): unknown =>
    h('span', { className: `skp-pill ${r?.status ?? ''}` }, h('i', { className: `skp-dot ${r?.status ?? ''}` }), label)

  function StagesTab({ snap, status }: { snap: SettingsSnapshot, status: Status }): unknown {
    const active = status.active.default
    const rollup = snap.rollup
    const lockedNames = new Set(status.lock.skills.filter(s => s.orphaned === undefined).map(s => `${s.source}/${s.dir}`))
    const stagePresets = status.stages.map(stage => ({ stage, presets: status.presets.filter(p => p.stage === stage) }))
    const cross = status.presets.filter(p => p.stage === 'cross')
    const card = (preset: Preset): unknown => {
      const on = preset.id === active
      const missing = preset.skills.filter(s => !lockedNames.has(s.ref))
      const stats = rollup?.presets[preset.id]
      const coverage = stats !== undefined && stats.sessions > 0 ? stats.coverageSum / stats.sessions : undefined
      return h('div', { className: `skp-stage${on ? ' on' : ''}`, key: preset.id },
        h('div', { className: 'skp-stage-h' },
          h('span', { className: 'skp-swatch', style: { background: preset.color ?? 'var(--dsw-alias-border-l2)' } }),
          h('span', { className: 'skp-stage-t' }, preset.title),
          h('span', { className: 'skp-sub' }, STAGE_LABEL[preset.stage] ?? preset.stage),
          on ? h('span', { className: 'skp-pill green' }, 'default') : null,
        ),
        h('div', { className: 'skp-stage-s' }, preset.summary),
        h('div', { className: 'skp-chips' }, ...preset.skills.map(s => h('span', {
          key: s.ref, className: `skp-chip${lockedNames.has(s.ref) ? '' : ' miss'}`, title: lockedNames.has(s.ref) ? s.ref : `${s.ref} — not installed`,
        }, s.as ?? s.ref.split('/').pop()))),
        coverage !== undefined ? h('div', { className: 'skp-col' },
          h('div', { className: 'skp-sub' }, `${stats!.sessions} session${stats!.sessions === 1 ? '' : 's'} · ${pct(coverage)} of skills used on average${stats!.ratings > 0 ? ` · rating ${(stats!.ratingSum / stats!.ratings).toFixed(1)}` : ''}`),
          h('div', { className: 'skp-bar' }, h('i', { style: { width: pct(coverage) } })),
        ) : null,
        missing.length > 0 ? h('div', { className: 'skp-msg error' }, `${missing.length} skill${missing.length === 1 ? '' : 's'} not installed`) : null,
        ...(snap.pruning?.stale.filter(x => x.preset === preset.id) ?? []).map(x => h('div', { key: x.ref, className: 'skp-row' },
          h('span', { className: 'skp-pill amber', title: `offered in ${x.offered} sessions, loaded in ${x.loaded}` }, `${x.name}: loaded ${pct(x.rate)} of ${x.offered} sessions`),
          h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined, onClick: () => { void controller.pruneFromPreset(preset.id, x.ref) } }, 'remove from preset?'),
        )),
        h('div', { className: 'skp-row' },
          h('button', { className: `skp-btn small${on ? '' : ' primary'}`, disabled: snap.busy !== undefined || on, onClick: () => { void controller.activate(preset.id) } }, on ? 'Default' : 'Make default'),
          h('button', { className: 'skp-btn small', onClick: () => controller.startEdit(preset) }, 'Edit'),
          h('button', { className: 'skp-btn small', onClick: () => { void controller.duplicatePreset(preset.id) } }, 'Duplicate'),
          preset.builtin === true ? null : h('button', { className: 'skp-btn small danger', onClick: () => { void controller.deletePreset(preset.id) } }, 'Delete'),
        ),
      )
    }
    return h('div', { className: 'skp-col', style: { gap: '14px' } },
      h('div', { className: 'skp-sub' },
        'The lifecycle is a loop: each stage ends by committing an artifact (intent.md → spec.md → plan.md → PR → incident record) that the next stage reads. ',
        'One preset is active at a time; overlays add skills when a team is attached or the session is inside a git repository.'),
      !status.foundationInstalled ? h('div', { className: 'skp-card' },
        h('div', { style: { fontWeight: 650 } }, 'Install the foundation'),
        h('div', { className: 'skp-sub' }, `Fetch the curated skills from ${status.sources.filter(s => s.kind === 'github' && s.enabled).map(s => s.title).join(', ')} into this workbench. Nothing is fetched until you click.`),
        h('div', { className: 'skp-row' }, h('button', { className: 'skp-btn primary', disabled: snap.busy !== undefined, onClick: () => { void controller.installFoundation() } }, 'Install foundation')),
      ) : null,
      h('div', { className: 'skp-row' },
        h('span', { className: 'skp-sub' }, 'Workspace default: '),
        h('strong', null, status.activePreset?.title ?? 'none'),
        active !== null ? h('button', { className: 'skp-btn small', onClick: () => { void controller.activate(null) } }, 'Clear default') : null,
        h('span', { className: 'skp-sub' }, `· ${Object.keys(status.active.sessions).length} session${Object.keys(status.active.sessions).length === 1 ? '' : 's'} with their own choice`),
        h('span', { style: { flex: 1 } }),
        h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined, onClick: () => { void controller.exportBundle() }, title: 'Download every preset with overlays, pinned versions, and local skill bodies as one JSON file' }, 'Export all'),
        h('label', { className: 'skp-btn small', title: 'Import a bundle; same-id presets are kept as ours unless you choose otherwise' }, 'Import…',
          h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' }, onChange: (e: { target: { files?: { 0?: { text(): Promise<string> } } } }) => {
            const file = e.target.files?.[0]
            if (file !== undefined) void file.text().then(text => controller.importBundle(text, 'rename'))
          } })),
        h('button', { className: 'skp-btn small', onClick: () => controller.newPreset() }, '+ New preset'),
      ),
      h('div', {
        className: 'skp-sub', style: { border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: 8, padding: '8px 10px' },
        onDragOver: (e: { preventDefault(): void }) => e.preventDefault(),
        onDrop: (e: { preventDefault(): void, dataTransfer?: { files?: { 0?: { text(): Promise<string> } } } }) => {
          e.preventDefault()
          const file = e.dataTransfer?.files?.[0]
          if (file !== undefined) void file.text().then(text => controller.importBundle(text, 'rename'))
        },
      }, 'Drop a preset bundle here to import it (same-id presets are imported with an -imported suffix).'),
      h('div', { className: 'skp-card' },
        h('strong', null, 'Defaults per harness agent preset'),
        h('div', { className: 'skp-sub' }, 'A new session under this agent preset starts from the chosen skill preset; a session\'s own choice (header chip) still wins. Leave blank to inherit the workspace default.'),
        ...['standard', 'cordis', 'ptc', ...Object.keys(status.active.byAgentPreset).filter(k => !['standard', 'cordis', 'ptc'].includes(k))].map(ap => h('div', { key: ap, className: 'skp-row' },
          h('span', { className: 'skp-mono', style: { minWidth: 90 } }, ap),
          h('select', {
            className: 'skp-input small', value: status.active.byAgentPreset[ap] ?? '',
            onChange: (e: { target: { value: string } }) => { void controller.setAgentPresetDefault(ap, e.target.value.length > 0 ? e.target.value : null) },
          },
            h('option', { value: '' }, '(workspace default)'),
            ...status.presets.map(p => h('option', { key: p.id, value: p.id }, p.title))),
        )),
      ),
      ...stagePresets.filter(g => g.presets.length > 0).map(group => h('div', { key: group.stage, className: 'skp-col' },
        h('div', { className: 'skp-sub', style: { fontWeight: 650 } }, STAGE_LABEL[group.stage] ?? group.stage),
        h('div', { className: 'skp-loop' }, ...group.presets.map(card)),
      )),
      cross.length > 0 ? h('div', { className: 'skp-col' },
        h('div', { className: 'skp-sub', style: { fontWeight: 650 } }, 'Cross-stage'),
        h('div', { className: 'skp-loop' }, ...cross.map(card)),
      ) : null,
      h('div', { className: 'skp-col' },
        h('div', { className: 'skp-sub', style: { fontWeight: 650 } }, 'Overlays'),
        ...status.overlays.map(o => h('div', { key: o.id, className: 'skp-row' },
          h('span', { className: `skp-pill${o.enabled ? ' green' : ''}` }, o.title),
          h('span', { className: 'skp-sub' }, `when ${o.when === 'tool-visible:team_delegate' ? 'a team is attached' : o.when === 'git-work-tree' ? 'inside a git repository' : 'always'} → `),
          h('span', { className: 'skp-chips' }, ...o.skills.map(s => h('span', { key: s.ref, className: 'skp-chip overlay' }, s.ref.split('/').pop()))),
        )),
      ),
      status.resolution.unresolved.length > 0 ? h('div', { className: 'skp-msg error' }, `Active preset has unresolved skills: ${status.resolution.unresolved.map(u => `${u.ref} (${u.reason})`).join('; ')}`) : null,
    )
  }

  function Editor({ snap, status }: { snap: SettingsSnapshot, status: Status }): unknown {
    const editing = snap.editing!
    const installed = status.lock.skills.filter(s => s.orphaned === undefined)
    const bySource = new Map<string, LockedSkill[]>()
    for (const s of installed) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s])
    const exposed = new Map<string, number>()
    for (const ref of editing.skills) {
      const locked = installed.find(s => `${s.source}/${s.dir}` === ref.ref)
      const name = ref.as ?? locked?.name ?? ref.ref.split('/').pop()!
      exposed.set(name, (exposed.get(name) ?? 0) + 1)
    }
    const dupes = [...exposed.entries()].filter(([, n]) => n > 1).map(([n]) => n)
    return h('div', { className: 'skp-drawer' },
      h('div', { className: 'skp-drawer-h' },
        h('strong', null, editing.builtin === true ? `Edit ${editing.title}` : editing.id.length > 0 ? `Edit ${editing.id}` : 'New preset'),
        h('span', { style: { flex: 1 } }),
        h('button', { className: 'skp-btn small', onClick: () => controller.cancelEdit() }, 'Cancel'),
        h('button', { className: 'skp-btn small primary', disabled: snap.busy !== undefined || dupes.length > 0 || editing.id.length === 0, onClick: () => { void controller.savePreset() } }, 'Save'),
      ),
      h('div', { className: 'skp-drawer-b' },
        h('div', { className: 'skp-row' },
          h('input', { className: 'skp-input', placeholder: 'id (kebab-case)', value: editing.id, disabled: editing.builtin === true, onChange: (e: { target: { value: string } }) => controller.editField({ id: e.target.value.toLowerCase().replaceAll(/[^a-z0-9-]/gu, '-') }) }),
          h('input', { className: 'skp-input', placeholder: 'Title', value: editing.title, onChange: (e: { target: { value: string } }) => controller.editField({ title: e.target.value }) }),
        ),
        h('div', { className: 'skp-row' },
          h('select', { className: 'skp-input', value: editing.stage, onChange: (e: { target: { value: string } }) => controller.editField({ stage: e.target.value }) },
            ...['plan', 'design', 'build', 'test', 'deploy', 'maintain', 'cross'].map(s => h('option', { key: s, value: s }, STAGE_LABEL[s]))),
          h('input', { className: 'skp-input', placeholder: 'Colour (CSS)', value: editing.color ?? '', onChange: (e: { target: { value: string } }) => controller.editField({ color: e.target.value }) }),
        ),
        h('textarea', { className: 'skp-input', rows: 2, placeholder: 'Summary — what this stage produces', value: editing.summary, onChange: (e: { target: { value: string } }) => controller.editField({ summary: e.target.value }) }),
        dupes.length > 0 ? h('div', { className: 'skp-msg error' }, `Exposed name collision: ${dupes.join(', ')}. Set an alias on one of them.`) : null,
        h('div', { className: 'skp-sub' }, `${editing.skills.length} selected. Tick skills from the library; set an alias when two share a name.`),
        ...[...bySource.entries()].map(([source, skills]) => h('div', { key: source, className: 'skp-col' },
          h('div', { className: 'skp-sub', style: { fontWeight: 650 } }, status.sources.find(s => s.id === source)?.title ?? source),
          ...skills.sort((a, b) => a.name.localeCompare(b.name)).map((s) => {
            const ref = `${s.source}/${s.dir}`
            const picked = editing.skills.find(x => x.ref === ref)
            return h('label', { key: ref, className: 'skp-skill-row', style: { cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: picked !== undefined, onChange: () => controller.toggleSkill(ref) }),
              h('span', { className: 'skp-skill-name', title: s.description }, h('span', { className: 'skp-mono' }, s.name), ' ', h('span', { className: 'skp-sub' }, s.description.slice(0, 90))),
              picked !== undefined ? h('input', { className: 'skp-input small', placeholder: 'alias', value: picked.as ?? '', onClick: (e: { stopPropagation(): void }) => e.stopPropagation(), onChange: (e: { target: { value: string } }) => controller.setAlias(ref, e.target.value.trim()) }) : null,
            )
          }),
        )),
      ),
    )
  }

  function LibraryTab({ snap, status }: { snap: SettingsSnapshot, status: Status }): unknown {
    const checks = snap.checks ?? []
    const job = snap.job
    return h('div', { className: 'skp-col', style: { gap: '12px' } },
      h('div', { className: 'skp-row' },
        h('button', { className: 'skp-btn', disabled: snap.busy !== undefined, onClick: () => { void controller.check() } }, 'Check for updates'),
        h('button', { className: 'skp-btn primary', disabled: snap.busy !== undefined, onClick: () => { void controller.updateSource() } }, status.foundationInstalled ? 'Update all' : 'Install foundation'),
        h('span', { className: 'skp-sub' }, `${status.lock.skills.length} installed · library at ${status.root}/skills/library`),
      ),
      job !== undefined ? h('div', { className: 'skp-card' },
        h('div', { style: { fontWeight: 650 } }, job.done ? 'Done' : 'Working…'),
        ...job.reports.map(r => h('div', { key: r.source, className: 'skp-sub' }, `${r.source}: +${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged${r.orphaned.length > 0 ? `, ${r.orphaned.length} orphaned` : ''}${r.failed.length > 0 ? `, ${r.failed.length} failed (${r.failed.map(f => `${f.dir}: ${f.error}`).join('; ')})` : ''}${r.note !== undefined ? ` — ${r.note}` : ''}`)),
        !job.done ? h('div', { className: 'skp-sub skp-mono' }, job.progress.slice(-3).join(' · ')) : null,
      ) : null,
      ...status.sources.map((source) => {
        const skills = status.lock.skills.filter(s => s.source === source.id).sort((a, b) => a.name.localeCompare(b.name))
        const check = checks.find(c => c.source === source.id)
        const locked = status.lock.sources[source.id]
        return h('div', { key: source.id, className: 'skp-card' },
          h('div', { className: 'skp-row' },
            h('strong', null, source.title),
            source.repo !== undefined ? h('a', { className: 'skp-sub', href: `https://github.com/${source.repo}`, target: '_blank', rel: 'noreferrer' }, source.repo) : null,
            h('span', { style: { flex: 1 } }),
            locked !== undefined ? h('span', { className: 'skp-sub skp-mono' }, `${locked.commit.slice(0, 7)} · ${new Date(locked.fetchedAt).toLocaleDateString()}`) : h('span', { className: 'skp-sub' }, 'not installed'),
            source.kind === 'github' ? h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined, onClick: () => { void controller.updateSource(source.id) } }, locked !== undefined ? 'Update' : 'Install') : null,
          ),
          source.note !== undefined ? h('div', { className: 'skp-sub' }, source.note) : null,
          check !== undefined ? h('div', { className: `skp-msg${check.changed.length + check.newUpstream.length > 0 ? ' ok' : ''}` },
            check.note ?? `${check.changed.length} changed, ${check.newUpstream.length} new upstream, ${check.removedUpstream.length} removed upstream`) : null,
          skills.length > 0 ? h('table', { className: 'skp-table' },
            h('thead', null, h('tr', null, h('th', null, 'Skill'), h('th', null, 'Description'), h('th', null, 'Files'), h('th', null, 'Installed'), h('th', null, ''))),
            h('tbody', null, ...skills.map(s => h('tr', { key: s.dir, className: 'click', onClick: () => { void controller.openSkill(`${s.source}/${s.dir}`) } },
              h('td', { className: 'skp-mono' }, s.name, s.orphaned === true ? h('span', { className: 'skp-pill amber', style: { marginLeft: 6 } }, 'orphaned') : null, check?.changed.includes(s.dir) === true ? h('span', { className: 'skp-pill amber', style: { marginLeft: 6 } }, 'update available') : null),
              h('td', null, s.description.length > 120 ? `${s.description.slice(0, 120)}…` : s.description),
              h('td', null, String(s.files)),
              h('td', { className: 'skp-sub' }, new Date(s.installedAt).toLocaleDateString(), s.normalized ? h('span', { className: 'skp-pill', style: { marginLeft: 6 }, title: 'Vendor-specific wording was rewritten to the harness vocabulary' }, 'normalized') : null),
              h('td', null),
            ))),
          ) : null,
        )
      }),
    )
  }

  function SkillDrawer({ snap }: { snap: SettingsSnapshot }): unknown {
    const detail = snap.detail!
    return h('div', { className: 'skp-drawer' },
      h('div', { className: 'skp-drawer-h' },
        h('strong', { className: 'skp-mono' }, detail.ref),
        h('span', { style: { flex: 1 } }),
        detail.locked?.source !== 'local' ? h('button', { className: 'skp-btn small danger', onClick: () => { void controller.removeSkill(detail.ref) } }, 'Remove') : null,
        h('button', { className: 'skp-btn small', onClick: () => controller.closeSkill() }, 'Close'),
      ),
      h('div', { className: 'skp-drawer-b' },
        detail.locked !== undefined ? h('div', { className: 'skp-sub' },
          `commit ${detail.locked.commit.slice(0, 7)} · installed ${new Date(detail.locked.installedAt).toLocaleString()} · ${detail.locked.files} files`,
          detail.locked.normalized ? ' · normalized from upstream' : '',
          detail.locked.history !== undefined && detail.locked.history.length > 0 ? ` · ${detail.locked.history.length} previous version${detail.locked.history.length === 1 ? '' : 's'}` : '',
        ) : null,
        detail.usedBy.length > 0 ? h('div', { className: 'skp-row' }, h('span', { className: 'skp-sub' }, 'In presets:'), ...detail.usedBy.map(p => h('span', { key: p, className: 'skp-chip' }, p))) : h('div', { className: 'skp-sub' }, 'Not in any preset.'),
        h('div', { className: 'skp-chips' }, ...detail.files.map(f => h('span', { key: f.path, className: 'skp-chip' }, `${f.path} (${f.bytes} B)`))),
        h('pre', { className: 'skp-pre' }, detail.text ?? '(SKILL.md unreadable)'),
      ),
    )
  }

  function PracticesTab({ snap, status }: { snap: SettingsSnapshot, status: Status }): unknown {
    const doc = status.practices
    const rollup = snap.rollup
    const save = (patch: Partial<PracticesDoc>): void => { void controller.savePractices({ ...doc, ...patch }) }
    return h('div', { className: 'skp-col', style: { gap: '12px' } },
      h('div', { className: 'skp-sub' }, 'Practices are observed from tool calls and git — never from the model\'s prose — so they behave identically under every provider. Advisory adds a line to the prompt when a practice is at risk; hard denies the offending tool call with a reason that names the skill to load.'),
      ...doc.practices.map((p) => {
        const info = status.practiceInfo[p.id]
        const stats = rollup?.practices[p.id]
        const total = stats !== undefined ? stats.green + stats.amber + stats.red : 0
        return h('div', { key: p.id, className: 'skp-card' },
          h('div', { className: 'skp-row' },
            h('strong', null, info?.title ?? p.id),
            h('span', { className: 'skp-chip' }, info?.skill ?? ''),
            h('span', { style: { flex: 1 } }),
            ...(['off', 'advisory', 'hard'] as const).map(mode => h('button', {
              key: mode, className: `skp-btn small${p.mode === mode ? ' primary' : ''}`, disabled: snap.busy !== undefined,
              onClick: () => save({ practices: doc.practices.map(x => x.id === p.id ? { ...x, mode } : x) }),
            }, mode)),
          ),
          h('div', { className: 'skp-sub' }, info?.summary ?? ''),
          total > 0 ? h('div', { className: 'skp-row' },
            practicePill({ id: p.id, status: 'green', evidence: [] }, `${stats!.green} green`),
            practicePill({ id: p.id, status: 'amber', evidence: [] }, `${stats!.amber} amber`),
            practicePill({ id: p.id, status: 'red', evidence: [] }, `${stats!.red} red`),
            h('span', { className: 'skp-sub' }, `${pct(stats!.green / total)} adherence over ${total} session${total === 1 ? '' : 's'}`),
          ) : h('div', { className: 'skp-sub' }, 'No sessions recorded yet.'),
        )
      }),
      h('div', { className: 'skp-card' },
        h('div', { className: 'skp-row' },
          h('strong', null, 'Strict skill catalog'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: `skp-btn small${doc.strictSkills ? ' primary' : ''}`, onClick: () => save({ strictSkills: !doc.strictSkills }) }, doc.strictSkills ? 'on' : 'off'),
        ),
        h('div', { className: 'skp-sub' },
          'When on, the model\'s skill catalog for each session is narrowed to the resolved set (preset + overlays) through the harness\'s `ctx.skills.restrict()`, and a `skill` call for anything else is denied with a reason. ',
          status.restrictSeam === true ? h('span', { className: 'skp-pill green' }, 'restrict seam present — catalog is hidden, not just denied')
            : status.restrictSeam === false ? h('span', { className: 'skp-pill amber' }, 'restrict seam absent in this harness — guard only (denial), catalog still lists other skills')
              : h('span', { className: 'skp-pill' }, 'seam support unknown until a session runs'),
        ),
      ),
      h('div', { className: 'skp-card' },
        h('div', { className: 'skp-row' },
          h('strong', null, 'Export as hooks (optional)'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined, onClick: () => { void controller.generateHooks() } }, 'Generate hook files'),
        ),
        h('div', { className: 'skp-sub' }, 'Writes the same detectors as command hooks for BOTH bridges the harness ships (dsh-hooks-claude-code and dsh-hooks-codex) into <workbench>/hooks/. Each hook runs `dsh-skill-presets check <practice>` and blocks only when the practice is red and hard. The native gate above is the primary mechanism; this is for setups that already run hooks.'),
      ),
      h('div', { className: 'skp-card' },
        h('div', { className: 'skp-row' },
          h('strong', null, 'Auto-clean worktrees'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: `skp-btn small${doc.autoCleanWorktrees ? ' primary' : ''}`, onClick: () => save({ autoCleanWorktrees: !doc.autoCleanWorktrees }) }, doc.autoCleanWorktrees ? 'on' : 'off'),
        ),
        h('div', { className: 'skp-sub' }, 'When a session ends (and hourly), linked worktrees whose branch is merged into the default branch AND whose tree is clean are removed together with the branch. Dirty, unmerged, locked, or detached worktrees are never touched — they are listed in the session\'s Skills tab instead.'),
      ),
      h('div', { className: 'skp-card' },
        h('strong', null, 'Protected branches'),
        h('input', { className: 'skp-input', defaultValue: doc.protectedBranches.join(', '), onBlur: (e: { target: { value: string } }) => save({ protectedBranches: e.target.value.split(',').map(s => s.trim()).filter(s => s.length > 0) }) }),
        h('strong', null, 'Instructions files recognised'),
        h('div', { className: 'skp-sub' }, 'Any of these counts as the project\'s instructions file. Provider-neutral: add whatever your projects use.'),
        h('input', { className: 'skp-input', defaultValue: doc.instructionFiles.join(', '), onBlur: (e: { target: { value: string } }) => save({ instructionFiles: e.target.value.split(',').map(s => s.trim()).filter(s => s.length > 0) }) }),
      ),
    )
  }

  function InsightsTab({ snap }: { snap: SettingsSnapshot }): unknown {
    const rollup = snap.rollup
    if (rollup === undefined) return h('div', { className: 'skp-sub' }, 'Loading insights…')
    const rows = Object.entries(rollup.skills).map(([name, s]) => ({
      name, ...s,
      rate: s.sessionsOffered > 0 ? s.sessionsLoaded / s.sessionsOffered : 0,
      meanTurn: s.sessionsLoaded > 0 ? s.firstLoadTurnSum / s.sessionsLoaded : undefined,
    })).sort((a, b) => b.rate - a.rate || b.loads - a.loads)
    const unknown = Object.entries(rollup.unknownRequests).sort((a, b) => b[1] - a[1])
    const models = Object.entries(rollup.byModel).sort((a, b) => b[1].sessions - a[1].sessions)
    return h('div', { className: 'skp-col', style: { gap: '14px' } },
      h('div', { className: 'skp-row' },
        h('span', { className: 'skp-sub' }, `${rollup.sessions} session${rollup.sessions === 1 ? '' : 's'} · updated ${new Date(rollup.updatedAt).toLocaleString()}`),
        h('span', { style: { flex: 1 } }),
        h('button', { className: 'skp-btn small', onClick: () => { void controller.loadInsights(true) } }, 'Rebuild'),
      ),
      h('div', { className: 'skp-col' },
        h('div', { className: 'skp-sub', style: { fontWeight: 650 } }, 'Skill load rate — of the sessions a skill was offered in, how many loaded it'),
        rows.length === 0 ? h('div', { className: 'skp-sub' }, 'No usage yet.') : h('table', { className: 'skp-table' },
          h('thead', null, h('tr', null, h('th', null, 'Skill'), h('th', null, 'Load rate'), h('th', null, 'Offered'), h('th', null, 'Loads'), h('th', null, 'First load (turn)'), h('th', null, '~Tokens'), h('th', null, 'Last used'))),
          h('tbody', null, ...rows.map(r => h('tr', { key: r.name },
            h('td', { className: 'skp-mono' }, r.name),
            h('td', null, h('div', { className: 'skp-row' }, h('div', { className: 'skp-bar', style: { width: 80 } }, h('i', { style: { width: pct(r.rate) } })), pct(r.rate))),
            h('td', null, String(r.sessionsOffered)), h('td', null, String(r.loads)),
            h('td', null, r.meanTurn !== undefined ? r.meanTurn.toFixed(1) : '—'),
            h('td', null, String(Math.round(r.chars / 4))),
            h('td', { className: 'skp-sub' }, r.lastUsed !== undefined ? new Date(r.lastUsed).toLocaleDateString() : '—'),
          ))),
        ),
      ),
      h('div', { className: 'skp-col' },
        h('div', { className: 'skp-sub', style: { fontWeight: 650 } }, 'Co-usage — skills loaded in the same session'),
        h(CoUsageGraph, { rollup }),
      ),
      h('div', { className: 'skp-loop' },
        h('div', { className: 'skp-card' },
          h('strong', null, 'Stage suggestions'),
          h('div', { className: 'skp-sub' }, 'How often the chip suggested a stage switch and how often you took it.'),
          h('div', { className: 'skp-row' },
            h('span', { className: 'skp-pill' }, `${rollup.suggestions.suggested} suggested`),
            h('span', { className: 'skp-pill green' }, `${rollup.suggestions.accepted} accepted`),
            h('span', { className: 'skp-pill amber' }, `${rollup.suggestions.dismissed} dismissed`),
            rollup.suggestions.accepted > 0 ? h('span', { className: 'skp-sub' }, `median-ish time to accept ${Math.round(rollup.suggestions.acceptMsSum / rollup.suggestions.accepted / 1000)} s`) : null,
          ),
        ),
        h('div', { className: 'skp-card' },
          h('div', { className: 'skp-row' },
            h('strong', null, 'Requested but unknown'),
            h('span', { style: { flex: 1 } }),
            h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined, onClick: () => { void controller.searchMissingUpstream() } }, 'Search upstream'),
          ),
          h('div', { className: 'skp-sub' }, `Names the model asked the \`skill\` tool for that were not in its catalog — the strongest signal of a missing skill. Hints appear at ≥ ${snap.pruning?.thresholds.minUnknown ?? 3} requests.`),
          unknown.length === 0 ? h('div', { className: 'skp-sub' }, 'None.') : h('div', { className: 'skp-chips' }, ...unknown.map(([n, c]) => h('span', { key: n, className: 'skp-chip miss' }, `${n} ×${c}`))),
          ...(snap.pruning?.missing ?? []).map(m => h('div', { key: m.name, className: 'skp-row' },
            h('span', { className: 'skp-mono' }, m.name), h('span', { className: 'skp-sub' }, `×${m.count}`),
            m.inLibrary !== undefined && snap.status?.activePreset !== undefined
              ? h('button', { className: 'skp-btn small primary', disabled: snap.busy !== undefined, onClick: () => { void controller.addToPreset(snap.status!.activePreset!.id, m.inLibrary!) } }, `add to ${snap.status.activePreset.title}?`)
              : m.upstream !== undefined && m.upstream.length > 0
                ? h('span', { className: 'skp-sub' }, `available upstream: ${m.upstream.map(u => `${u.source}/${u.dir}`).join(', ')} — install it from the Library tab`)
                : h('span', { className: 'skp-sub' }, 'not in the library or upstream — write it as a local skill?'),
          )),
        ),
        h('div', { className: 'skp-card' },
          h('strong', null, 'By provider / model'),
          h('div', { className: 'skp-sub' }, 'Data, not a dependency: see whether a preset lands differently under different models.'),
          ...models.map(([k, v]) => h('div', { key: k, className: 'skp-row' }, h('span', { className: 'skp-mono' }, k), h('span', { className: 'skp-sub' }, `${v.sessions} sessions · ${v.loads} loads`))),
        ),
      ),
      h('div', { className: 'skp-card' },
        h('strong', null, 'Promotable insights'),
        h('div', { className: 'skp-sub' }, 'Knowledge the model keeps re-reading (workflow rules, conventions, preferences with confidence ≥ 2 or ≥ 40 reads). Promote one to a local skill the catalog names next to the task; the insight stays and links to it.'),
        snap.insights === undefined || snap.insights.length === 0 ? h('div', { className: 'skp-sub' }, 'None qualify yet.') : h('table', { className: 'skp-table' },
          h('thead', null, h('tr', null, h('th', null, 'Insight'), h('th', null, 'Kind'), h('th', null, 'Conf.'), h('th', null, 'Reads'), h('th', null, 'Skill'), h('th', null, ''))),
          h('tbody', null, ...snap.insights.map(i => h('tr', { key: i.id, title: i.body.slice(0, 300) },
            h('td', null, i.title, h('div', { className: 'skp-sub' }, `${i.domain} · ${i.scope}${i.project !== undefined ? ` ${i.project}` : ''}`)),
            h('td', null, i.kind), h('td', null, String(i.confidence)), h('td', null, String(i.hits ?? 0)),
            h('td', { className: 'skp-mono' }, i.promotedTo ?? i.skillName),
            h('td', null, i.promotedTo !== undefined
              ? h('button', { className: 'skp-btn small', onClick: () => { void controller.openSkill(`local/${i.promotedTo}`) } }, 'Open')
              : h('button', { className: 'skp-btn small primary', disabled: snap.busy !== undefined, onClick: () => { void controller.promoteInsight(i.id) } }, 'Promote')),
          ))),
        ),
      ),
      snap.recent !== undefined && snap.recent.length > 0 ? h('div', { className: 'skp-col' },
        h('div', { className: 'skp-sub', style: { fontWeight: 650 } }, 'Recent sessions'),
        h('table', { className: 'skp-table' },
          h('thead', null, h('tr', null, h('th', null, 'Session'), h('th', null, 'Preset'), h('th', null, 'Loaded / offered'), h('th', null, 'Practices'), h('th', null, 'Rating'), h('th', null, 'Model'))),
          h('tbody', null, ...snap.recent.map(s => h('tr', { key: s.sessionId },
            h('td', { className: 'skp-mono' }, s.sessionId.slice(0, 8)),
            h('td', null, s.preset ?? '—'),
            h('td', null, `${Object.keys(s.loaded).length} / ${s.offered.length}`),
            h('td', null, h('div', { className: 'skp-row' }, ...s.practices.map(p => h('i', { key: p.id, className: `skp-dot ${p.status}`, title: `${p.id}: ${p.status}` })))),
            h('td', null, s.rating === undefined ? '—' : s.rating > 0 ? '👍' : s.rating < 0 ? '👎' : '·'),
            h('td', { className: 'skp-sub' }, s.model ?? '—'),
          ))),
        ),
      ) : null,
    )
  }

  function CoUsageGraph({ rollup }: { rollup: Rollup }): unknown {
    const pairs = Object.entries(rollup.coUsage).sort((a, b) => b[1] - a[1]).slice(0, 40)
    if (pairs.length === 0) return h('div', { className: 'skp-sub' }, 'Not enough sessions with two or more skills loaded.')
    const names = [...new Set(pairs.flatMap(([k]) => k.split('|')))]
    const W = 900, H = 240
    const pos = new Map(names.map((n, i) => {
      const angle = (i / names.length) * Math.PI * 2
      return [n, { x: W / 2 + Math.cos(angle) * (W / 2 - 90), y: H / 2 + Math.sin(angle) * (H / 2 - 30) }]
    }))
    const max = pairs[0][1]
    return h('div', { className: 'skp-graph', style: { width: '100%' } },
      ...pairs.map(([k, w]) => {
        const [a, b] = k.split('|')
        const pa = pos.get(a)!, pb = pos.get(b)!
        const dx = pb.x - pa.x, dy = pb.y - pa.y
        return h('div', { key: k, className: 'skp-edge', title: `${a} + ${b}: ${w}`, style: { left: `${pa.x / W * 100}%`, top: pa.y, width: Math.hypot(dx, dy), transform: `rotate(${Math.atan2(dy, dx)}rad)`, opacity: 0.25 + 0.75 * (w / max), height: Math.max(1, Math.round(3 * w / max)) } })
      }),
      ...names.map(n => h('span', { key: n, className: 'skp-node', style: { left: `${pos.get(n)!.x / W * 100}%`, top: pos.get(n)!.y } }, n)),
    )
  }

  return function SkillsSettingsPage(): unknown {
    const snap = useStoreHook(React, controller)
    React.useEffect(() => { void controller.refresh(); void controller.loadInsights() }, [])
    const status = snap.status
    const tabs: [SettingsSnapshot['tab'], string][] = [['stages', 'Stages & presets'], ['library', 'Library'], ['practices', 'Practices'], ['insights', 'Insights']]
    return h('div', { className: 'skp skp-page' },
      h('div', null,
        h('h2', { className: 'skp-h1' }, 'Skills'),
        h('div', { className: 'skp-sub' }, 'Curated, versioned skill presets per SDLC stage; practice guardrails; usage insight. Provider-neutral.'),
      ),
      h('div', { className: 'skp-tabs' }, ...tabs.map(([id, label]) => h('button', { key: id, className: `skp-tab${snap.tab === id ? ' on' : ''}`, onClick: () => controller.setTab(id) }, label))),
      snap.error !== undefined ? h('div', { className: 'skp-msg error' }, snap.error) : null,
      snap.notice !== undefined ? h('div', { className: 'skp-msg ok' }, snap.notice) : null,
      status === undefined
        ? h('div', { className: 'skp-sub' }, snap.loading ? 'Reading the skill store…' : 'Status unavailable.')
        : snap.tab === 'stages' ? h(StagesTab, { snap, status })
          : snap.tab === 'library' ? h(LibraryTab, { snap, status })
            : snap.tab === 'practices' ? h(PracticesTab, { snap, status })
              : h(InsightsTab, { snap }),
      status !== undefined && snap.editing !== undefined ? h(Editor, { snap, status }) : null,
      snap.detail !== undefined ? h(SkillDrawer, { snap }) : null,
      status !== undefined && status.notes.length > 0 ? h('div', { className: 'skp-sub' }, status.notes.join(' · ')) : null,
    )
  }
}

// ------------------------------------------------------------- Header chip --

export function makeHeaderChip(React: ReactLike, controller: ScorecardController): () => unknown {
  const h = React.createElement.bind(React)
  return function SkillPresetChip(): unknown {
    const snap = useStoreHook(React, controller)
    React.useEffect(() => controller.watch(), [])
    const card = snap.card
    const status = snap.status
    const title = card?.activePreset?.title ?? (snap.loading ? '…' : 'no preset')
    const worst = card?.worst ?? 'n/a'
    const suggestion = card?.suggestion
    const sourceLabel = card?.activeSource === 'session' ? 'this session' : card?.activeSource === 'agent-preset' ? `agent preset ${card.agentPreset ?? ''}` : 'workspace default'
    return h('div', { className: 'skp', style: { position: 'relative', display: 'inline-flex' } },
      h('button', {
        className: `skp-hchip${suggestion !== undefined ? ' skp-pulse' : ''}`,
        title: `Skill preset (${sourceLabel}) and practice status — click to switch${suggestion !== undefined ? ` · suggestion: ${STAGE_LABEL[suggestion.to] ?? suggestion.to}` : ''}`,
        onClick: () => controller.togglePopover(),
      },
        h('i', { className: `skp-dot ${worst === 'n/a' ? '' : worst}` }),
        h('span', { className: 'skp-swatch', style: { background: card?.activePreset?.color ?? 'var(--dsw-alias-border-l2)' } }),
        title,
        card?.strict.enabled === true ? h('span', { className: 'skp-lock', title: card.strict.applied ? 'Strict: catalog narrowed to this set' : 'Strict: guard only (harness lacks skills.restrict)' }, card.strict.applied ? '🔒' : '🔐') : null,
        card !== undefined && card.overlays.length > 0 ? h('span', { className: 'skp-sub' }, `+${card.overlays.length}`) : null,
        suggestion !== undefined ? h('span', { className: 'skp-sub' }, `→ ${STAGE_LABEL[suggestion.to] ?? suggestion.to}?`) : null,
      ),
      snap.popover && status !== undefined ? h('div', { className: 'skp-pop' },
        suggestion !== undefined ? h('div', { className: 'skp-card', style: { padding: '8px 10px' } },
          h('div', { className: 'skp-pop-t' }, `Artifacts say ${STAGE_LABEL[suggestion.to] ?? suggestion.to} — switch?`),
          h('div', { className: 'skp-pop-s' }, suggestion.why.join(' · ')),
          h('div', { className: 'skp-row' },
            suggestion.presetId !== undefined
              ? h('button', { className: 'skp-btn small primary', disabled: snap.busy !== undefined, onClick: () => { void controller.acceptSuggestion() } }, `Switch to ${status.presets.find(p => p.id === suggestion.presetId)?.title ?? suggestion.presetId}`)
              : h('span', { className: 'skp-pop-s' }, 'Several presets own this stage — pick one below.'),
            h('button', { className: 'skp-btn small', onClick: () => { void controller.dismissSuggestion() } }, 'Not now'),
          ),
        ) : null,
        h('div', { className: 'skp-pop-s' }, `Switching applies to this session; the catalog updates on the model's next step. Now: ${sourceLabel}.`),
        ...status.presets.map(p => h('div', { key: p.id, className: `skp-pop-item${p.id === card?.activePreset?.id ? ' on' : ''}`, onClick: () => { void controller.activate(p.id) } },
          h('span', { className: 'skp-swatch', style: { background: p.color ?? 'var(--dsw-alias-border-l2)', marginTop: 3 } }),
          h('div', { className: 'skp-col', style: { gap: 2, flex: 1 } }, h('div', { className: 'skp-pop-t' }, `${p.title} · ${STAGE_LABEL[p.stage] ?? p.stage}`), h('div', { className: 'skp-pop-s' }, `${p.summary} (${p.skills.length} skills)`)),
          h('button', { className: 'skp-btn small', title: 'Make this the workspace default too', onClick: (e: { stopPropagation(): void }) => { e.stopPropagation(); void controller.activate(p.id, 'default') } }, 'default'),
        )),
        h('div', { className: 'skp-pop-item', onClick: () => { void controller.activate(null) } }, h('div', { className: 'skp-pop-s' }, 'No preset for this session (overlays only)')),
        card?.activeSource === 'session' ? h('div', { className: 'skp-pop-item', onClick: () => { void controller.useDefault() } }, h('div', { className: 'skp-pop-s' }, 'Forget this session\'s choice; follow the defaults')) : null,
        card !== undefined ? h('div', { className: 'skp-col', style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 } },
          h('div', { className: 'skp-pop-s' }, `Detected stage: ${STAGE_LABEL[card.stageGuess.stage] ?? card.stageGuess.stage} (${Math.round(card.stageGuess.confidence * 100)}%) — ${card.stageGuess.why[0] ?? ''}`),
          card.overlays.length > 0 ? h('div', { className: 'skp-pop-s' }, `Overlays: ${card.overlays.join(', ')}`) : null,
          ...card.practices.map(p => h('div', { key: p.id, className: 'skp-row' }, h('i', { className: `skp-dot ${p.status}` }), h('span', { className: 'skp-pop-s' }, `${status.practiceInfo[p.id]?.title ?? p.id}: ${p.status}${p.evidence[0] !== undefined ? ` — ${p.evidence[0]}` : ''}`))),
        ) : null,
        snap.notice !== undefined ? h('div', { className: 'skp-msg ok' }, snap.notice) : null,
        snap.error !== undefined ? h('div', { className: 'skp-msg error' }, snap.error) : null,
      ) : null,
    )
  }
}

// ------------------------------------------------------------ Sidebar tab --

export function makeSidebarBody(React: ReactLike, controllerFor: (sessionId: string) => ScorecardController): (props: { sessionId: string, useTabInfo?: () => { tab: { visible: boolean } } }) => unknown {
  const h = React.createElement.bind(React)
  return function SkillsTabBody(props): unknown {
    const controller = controllerFor(props.sessionId)
    const snap = useStoreHook(React, controller)
    const visible = props.useTabInfo !== undefined ? props.useTabInfo().tab.visible : true
    React.useEffect(() => visible ? controller.watch() : undefined, [visible])
    React.useEffect(() => { if (snap.templates === undefined) void controller.loadTemplates() }, [])
    const card = snap.card
    const status = snap.status
    if (card === undefined || status === undefined) return h('div', { className: 'skp skp-side' }, h('div', { className: 'skp-sub' }, snap.error ?? 'Reading scorecard…'))
    const loaded = card.summary.loaded
    const maxTurn = Math.max(1, ...card.summary.loads.map(l => l.turn))
    const facts = card.facts
    return h('div', { className: 'skp skp-side' },
      h('div', { className: 'skp-col' },
        h('h3', null, 'Preset'),
        h('div', { className: 'skp-row' },
          h('span', { className: 'skp-swatch', style: { background: card.activePreset?.color ?? 'var(--dsw-alias-border-l2)' } }),
          h('strong', null, card.activePreset?.title ?? 'none'),
          card.activePreset !== undefined ? h('span', { className: 'skp-sub' }, STAGE_LABEL[card.activePreset.stage] ?? card.activePreset.stage) : null,
          h('span', { className: 'skp-pill', title: 'Which rung set it: this session, the agent-preset default, or the workspace default' }, card.activeSource === 'session' ? 'this session' : card.activeSource === 'agent-preset' ? `agent preset` : 'workspace default'),
          card.overlays.length > 0 ? h('span', { className: 'skp-pill' }, `+ ${card.overlays.join(', ')}`) : null,
          !card.live ? h('span', { className: 'skp-pill amber' }, 'session not live') : null,
        ),
        h('div', { className: 'skp-sub' }, `Detected: ${STAGE_LABEL[card.stageGuess.stage] ?? card.stageGuess.stage} (${Math.round(card.stageGuess.confidence * 100)}%) — ${card.stageGuess.why.join(' · ')}`),
        card.suggestion !== undefined ? h('div', { className: 'skp-card skp-pulse', style: { padding: '8px 10px' } },
          h('div', { style: { fontWeight: 650 } }, `Switch to ${STAGE_LABEL[card.suggestion.to] ?? card.suggestion.to}?`),
          h('div', { className: 'skp-row' },
            card.suggestion.presetId !== undefined ? h('button', { className: 'skp-btn small primary', disabled: snap.busy !== undefined, onClick: () => { void controller.acceptSuggestion() } }, 'Switch') : null,
            h('button', { className: 'skp-btn small', onClick: () => { void controller.dismissSuggestion() } }, 'Not now'),
          ),
        ) : null,
      ),
      h('div', { className: 'skp-col' },
        h('h3', null, 'Stage & artifacts'),
        facts === undefined ? h('div', { className: 'skp-sub' }, 'No git facts yet.')
          : !facts.inRepo ? h('div', { className: 'skp-sub' }, 'Not inside a git repository.')
            : h('div', { className: 'skp-col' },
              h('div', { className: 'skp-sub' }, `branch ${facts.branch ?? '(detached)'} · ${facts.isWorktree === true ? 'linked worktree' : 'primary checkout'}${facts.ahead !== undefined ? ` · ${facts.ahead} ahead` : ''}${facts.dirty === true ? ' · dirty' : ''}`),
              h('div', { className: 'skp-chips' }, ...['intent.md', 'spec.md', 'plan.md'].map(f => h('span', { key: f, className: `skp-chip${facts.artifacts.some(a => a.endsWith(f)) ? '' : ' miss'}` }, `${facts.artifacts.some(a => a.endsWith(f)) ? '✓' : '✗'} ${f}`)),
                h('span', { className: `skp-chip${facts.pr !== undefined ? '' : ' miss'}` }, facts.pr !== undefined ? `✓ PR ${facts.pr.state}` : facts.ghAvailable ? '✗ PR' : '? PR (no gh)')),
            ),
      ),
      h('div', { className: 'skp-col' },
        h('h3', null, 'Practices'),
        ...card.practices.map(p => h('div', { key: p.id, className: 'skp-col', style: { gap: 2 } },
          h('div', { className: 'skp-row' }, h('i', { className: `skp-dot ${p.status}` }), h('span', null, status.practiceInfo[p.id]?.title ?? p.id), h('span', { className: `skp-pill ${p.status}` }, p.status)),
          ...p.evidence.slice(0, 2).map((e, i) => h('div', { key: i, className: 'skp-ev' }, e)),
        )),
      ),
      h('div', { className: 'skp-col' },
        h('h3', null, `Skills · ${Object.keys(loaded).length} of ${card.offered.length} loaded`),
        ...card.offered.map((s) => {
          const l = loaded[s.name]
          return h('div', { key: s.name, className: 'skp-skill-row', title: s.description },
            h('i', { className: `skp-dot${l !== undefined ? ' green' : ''}` }),
            h('span', { className: 'skp-skill-name skp-mono' }, s.name),
            s.via !== 'preset' ? h('span', { className: 'skp-chip overlay' }, 'overlay') : null,
            h('span', { className: 'skp-skill-meta' }, l !== undefined ? `×${l.count} · turn ${l.firstTurn}` : 'offered'),
          )
        }),
        card.unresolved.length > 0 ? h('div', { className: 'skp-msg error' }, `Unresolved: ${card.unresolved.map(u => `${u.ref} (${u.reason})`).join('; ')}`) : null,
        card.summary.unknown.length > 0 ? h('div', { className: 'skp-row' }, h('span', { className: 'skp-sub' }, 'Requested but unknown:'), ...[...new Set(card.summary.unknown)].map(n => h('span', { key: n, className: 'skp-chip miss' }, n))) : null,
      ),
      card.summary.loads.length > 0 ? h('div', { className: 'skp-col' },
        h('h3', null, 'Timeline (turns)'),
        h('div', { className: 'skp-timeline' }, ...Array.from({ length: maxTurn }, (_, i) => {
          const hits = card.summary.loads.filter(l => l.turn === i + 1)
          return h('i', { key: i, className: `skp-tick${hits.length > 0 ? ' hit' : ''}`, title: hits.length > 0 ? `turn ${i + 1}: ${hits.map(x => x.name).join(', ')}` : `turn ${i + 1}` })
        })),
      ) : null,
      card.summary.drift.length > 0 ? h('div', { className: 'skp-col' },
        h('h3', null, 'Plan drift'),
        h('div', { className: 'skp-sub' }, 'Edited but not named in plan.md:'),
        h('div', { className: 'skp-chips' }, ...[...new Set(card.summary.drift)].map(p => h('span', { key: p, className: 'skp-chip miss' }, p.split('/').slice(-2).join('/')))),
      ) : null,
      card.worktrees !== undefined && card.worktrees.list.length > 1 ? h('div', { className: 'skp-col' },
        h('h3', null, `Worktrees · ${card.worktrees.list.length - 1} linked`),
        ...card.worktrees.list.filter(w => !w.primary).map(w => h('div', { key: w.path, className: 'skp-skill-row', title: w.path },
          h('i', { className: `skp-dot ${w.verdict.kind === 'removable' ? 'amber' : w.verdict.kind === 'attention' ? 'red' : 'green'}` }),
          h('span', { className: 'skp-skill-name' }, h('span', { className: 'skp-mono' }, w.path.split('/').pop()), w.branch !== undefined ? h('span', { className: 'skp-sub' }, ` ${w.branch}`) : null),
          h('span', { className: 'skp-skill-meta', title: w.verdict.reason }, w.verdict.kind === 'removable' ? 'merged' : w.verdict.kind === 'attention' ? 'attention' : `${w.aheadOfDefault ?? '?'} ahead${w.ageDays !== undefined ? ` · ${w.ageDays}d` : ''}`),
          w.verdict.kind === 'removable' ? h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined, onClick: () => { void controller.cleanupWorktrees([w.path]) } }, 'Remove') : null,
        )),
        card.worktrees.list.some(w => !w.primary && w.verdict.kind === 'attention') ? h('div', { className: 'skp-ev' }, card.worktrees.list.filter(w => !w.primary && w.verdict.kind === 'attention').map(w => `${w.path.split('/').pop()}: ${w.verdict.reason}`).join(' · ')) : null,
        card.worktrees.list.filter(w => !w.primary && w.verdict.kind === 'removable').length > 1
          ? h('div', { className: 'skp-row' }, h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined, onClick: () => { void controller.cleanupWorktrees() } }, 'Remove all merged'))
          : null,
      ) : null,
      snap.templates !== undefined && snap.templates.length > 0 ? h('div', { className: 'skp-col' },
        h('h3', null, 'SDLC teams'),
        h('div', { className: 'skp-sub' }, snap.agentTeamsPresent === true
          ? 'Attach a team whose conductor instructions follow the practice skills. Members inherit this session\'s provider.'
          : 'Templates for dsh-agent-teams. Install that plugin to attach with one click.'),
        ...snap.templates.map(t => h('div', { key: t.id, className: 'skp-skill-row', title: t.objective },
          h('span', { className: `skp-dot${card.activePreset?.stage === t.stage ? ' green' : ''}` }),
          h('span', { className: 'skp-skill-name' }, h('strong', null, t.name), h('span', { className: 'skp-sub' }, ` · ${t.members.length} members · ${STAGE_LABEL[t.stage] ?? t.stage}`)),
          h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined || card.summary.overlays.includes('team-attached'), onClick: () => { void controller.attachTemplate(t.id) } }, 'Attach'),
        )),
      ) : null,
      h('div', { className: 'skp-col' },
        h('h3', null, 'Experiment'),
        h('div', { className: 'skp-sub' }, 'Fork this session under another preset, run the same task there, then compare.'),
        h('div', { className: 'skp-row' },
          h('select', { className: 'skp-input small', id: `skp-fork-${card.sessionId}`, defaultValue: '' },
            h('option', { value: '' }, 'no preset'),
            ...status.presets.map(p => h('option', { key: p.id, value: p.id }, p.title))),
          h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined, onClick: () => {
            const sel = typeof document !== 'undefined' ? document.getElementById(`skp-fork-${card.sessionId}`) as { value?: string } | null : null
            void controller.fork(sel?.value !== undefined && sel.value.length > 0 ? sel.value : null)
          } }, 'Fork under…'),
        ),
        card.experiments.length > 0 ? h('div', { className: 'skp-col' },
          ...card.experiments.map(e => h('div', { key: e.id, className: 'skp-row' },
            h('span', { className: 'skp-mono' }, `${e.parent.slice(0, 8)} (${e.parentPreset ?? 'none'})`), h('span', { className: 'skp-sub' }, '→'),
            h('span', { className: 'skp-mono' }, `${e.child.slice(0, 8)} (${e.childPreset ?? 'none'})`),
            h('button', { className: 'skp-btn small', onClick: () => { void controller.compare([e.parent, e.child]) } }, 'Compare'),
          )),
        ) : null,
        snap.compare !== undefined ? h('table', { className: 'skp-table' },
          h('thead', null, h('tr', null, h('th', null, ''), ...snap.compare.map(c => h('th', { key: c.sessionId, className: 'skp-mono' }, c.sessionId.slice(0, 8))))),
          h('tbody', null,
            ...([
              ['Preset', c => c.preset ?? 'none'],
              ['Skills loaded / offered', c => `${c.loaded} / ${c.offered}`],
              ['Skill loads', c => String(c.loads)],
              ['Turns (last load)', c => String(c.turns)],
              ['Practices', c => c.practices.map((p: PracticeResult) => `${p.id}:${p.status}`).join(', ') || '—'],
              ['Denied calls', c => String(c.denied)],
              ['Plan drift', c => String(c.drift)],
              ['Rating', c => c.rating === undefined ? '—' : c.rating > 0 ? '👍' : c.rating < 0 ? '👎' : '·'],
              ['Model', c => c.model ?? '—'],
            ] as [string, (c: CompareCard) => string][]).map(([label, f]) => h('tr', { key: label }, h('td', { className: 'skp-sub' }, label), ...snap.compare!.map(c => h('td', { key: c.sessionId }, f(c))))),
          ),
        ) : null,
      ),
      h('div', { className: 'skp-col' },
        h('h3', null, 'Eval fixture'),
        h('div', { className: 'skp-sub' }, 'Record this session (tool names, paths, git facts — no prompt text) so a future change to a skill or practice is checked against it.'),
        h('div', { className: 'skp-row' }, h('button', { className: 'skp-btn small', disabled: snap.busy !== undefined, onClick: () => { void controller.saveFixture() } }, 'Save as fixture')),
      ),
      h('div', { className: 'skp-col' },
        h('h3', null, 'Rate this preset for this session'),
        h('div', { className: 'skp-rate' },
          h('button', { className: `skp-btn small${card.summary.rating === 1 ? ' primary' : ''}`, onClick: () => { void controller.rate(1) } }, '👍 helped'),
          h('button', { className: `skp-btn small${card.summary.rating === -1 ? ' primary' : ''}`, onClick: () => { void controller.rate(-1) } }, '👎 got in the way'),
        ),
      ),
      snap.notice !== undefined ? h('div', { className: 'skp-msg ok' }, snap.notice) : null,
      snap.error !== undefined ? h('div', { className: 'skp-msg error' }, snap.error) : null,
    )
  }
}

// ------------------------------------------------------------ Plugin card --

export function makePluginCard(React: ReactLike, controller: SettingsController, openSkills?: () => void): () => unknown {
  const h = React.createElement.bind(React)
  return function SkillPresetsCard(): unknown {
    const snap = useStoreHook(React, controller)
    React.useEffect(() => { if (snap.status === undefined) void controller.refresh() }, [])
    const status = snap.status
    return h('div', { className: 'skp skp-col' },
      status === undefined ? h('div', { className: 'skp-sub' }, snap.loading ? 'Reading…' : snap.error ?? 'Unavailable.') : h('div', { className: 'skp-col' },
        h('div', { className: 'skp-row' }, h('span', { className: 'skp-sub' }, 'Workspace default'), h('strong', null, status.activePreset?.title ?? 'none')),
        h('div', { className: 'skp-row' }, h('span', { className: 'skp-sub' }, 'Library'), h('span', null, `${status.lock.skills.length} skills · ${status.presets.length} presets · ${status.overlays.filter(o => o.enabled).length} overlays`)),
        h('div', { className: 'skp-row' }, h('span', { className: 'skp-sub' }, 'Store'), h('span', { className: 'skp-mono' }, `${status.root}/skills`)),
        openSkills !== undefined ? h('div', { className: 'skp-row' }, h('button', { className: 'skp-btn small', onClick: openSkills }, 'Open Skills settings')) : null,
      ),
    )
  }
}

/** Exposed for tests. */
export const _internal = { STAGE_LABEL, pct }
export type { SessionSummary }
