/**
 * A/B experiments: fork a session under a different preset and compare.
 *
 * The record links parent and child so the sidebar can show both scorecards
 * side by side and Insights can aggregate "preset A vs B on comparable
 * tasks". The child's preset is pinned BEFORE its first step, so its catalog
 * differs from the parent's from turn one.
 * @module dsh-skill-presets/host/experiments
 */

import { readJson, writeJson, type StorePaths } from './store.ts'
import { outcomes, type Outcomes } from './impact.ts'
import type { SessionSummary } from './telemetry.ts'

export interface Experiment {
  readonly id: string
  readonly parent: string
  readonly child: string
  /** Parent's preset at fork time (null = none). */
  readonly parentPreset: string | null
  readonly childPreset: string | null
  readonly at: string
  readonly note?: string
}

export interface ExperimentsDoc {
  readonly version: 1
  readonly experiments: Experiment[]
}

export function emptyExperiments(): ExperimentsDoc {
  return { version: 1, experiments: [] }
}

export function validateExperiments(raw: unknown): ExperimentsDoc {
  const doc = raw as Partial<ExperimentsDoc>
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.experiments)) throw new TypeError('experiments malformed')
  return {
    version: 1,
    experiments: doc.experiments.filter((e): e is Experiment =>
      typeof e === 'object' && e !== null && typeof (e as Experiment).parent === 'string' && typeof (e as Experiment).child === 'string'),
  }
}

/** The forking face this module needs; the session controller provides it. */
export interface ForkLike {
  fork(request: { sessionId: string, atSeq?: number }): Promise<{ sessionId: string }>
}

export class Experiments {
  constructor(
    private readonly paths: () => StorePaths,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<Experiment[]> {
    return (await readJson(this.paths().experiments, emptyExperiments, validateExperiments)).value.experiments
  }

  /** Every experiment a session takes part in, as parent or child. */
  async forSession(sessionId: string): Promise<Experiment[]> {
    return (await this.list()).filter(e => e.parent === sessionId || e.child === sessionId)
  }

  /**
   * Fork and record. `pin` runs between the fork and the record so the child's
   * preset is set before anything can step it.
   */
  async fork(
    forker: ForkLike,
    parent: string,
    parentPreset: string | null,
    childPreset: string | null,
    pin: (childId: string) => Promise<void>,
    options: { atSeq?: number, note?: string } = {},
  ): Promise<Experiment> {
    const { sessionId: child } = await forker.fork({ sessionId: parent, ...(options.atSeq !== undefined ? { atSeq: options.atSeq } : {}) })
    await pin(child)
    const experiment: Experiment = {
      id: `${parent.slice(0, 8)}-${child.slice(0, 8)}`,
      parent,
      child,
      parentPreset,
      childPreset,
      at: this.now().toISOString(),
      ...(options.note !== undefined ? { note: options.note } : {}),
    }
    const current = await this.list()
    await writeJson(this.paths().experiments, { version: 1, experiments: [...current, experiment] })
    return experiment
  }
}


/** One experiment with both sides' outcomes and a verdict. */
export interface ExperimentResult {
  readonly experiment: Experiment
  readonly parent: Outcomes
  readonly child: Outcomes
  /** Which preset came out ahead on green → PR → fewer denials → rating; null when tied or unjudged. */
  readonly winner: 'parent' | 'child' | null
  readonly why: string
}

/** Per preset pair: how often each side won. */
export interface PairTotals {
  readonly a: string
  readonly b: string
  readonly experiments: number
  readonly aWins: number
  readonly bWins: number
  readonly ties: number
}

function judge(p: Outcomes, c: Outcomes): { winner: ExperimentResult['winner'], why: string } {
  const cmp = (key: keyof Outcomes, higherIsBetter: boolean, label: string): { winner: ExperimentResult['winner'], why: string } | undefined => {
    const a = p[key]
    const b = c[key]
    if (typeof a !== 'number' || typeof b !== 'number' || a === b) return undefined
    const parentBetter = higherIsBetter ? a > b : a < b
    return { winner: parentBetter ? 'parent' : 'child', why: `${label}: ${fmt(a)} vs ${fmt(b)}` }
  }
  return cmp('greenRate', true, 'all green') ?? cmp('prRate', true, 'PR opened') ?? cmp('meanDenied', false, 'denials') ?? cmp('meanRating', true, 'rating') ?? { winner: null, why: 'no judged difference' }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** Aggregate every experiment whose both sessions have summaries. Pure. */
export function aggregateExperiments(experiments: readonly Experiment[], summaries: readonly SessionSummary[]): { results: ExperimentResult[], pairs: PairTotals[] } {
  const byId = new Map(summaries.map(s => [s.sessionId, s]))
  const results: ExperimentResult[] = []
  const pairMap = new Map<string, PairTotals>()
  for (const e of experiments) {
    const ps = byId.get(e.parent)
    const cs = byId.get(e.child)
    if (ps === undefined || cs === undefined) continue
    const parent = outcomes([ps])
    const child = outcomes([cs])
    const { winner, why } = judge(parent, child)
    results.push({ experiment: e, parent, child, winner, why })
    const a = e.parentPreset ?? '(none)'
    const b = e.childPreset ?? '(none)'
    const key = [a, b].sort().join('|')
    const flipped = key !== `${a}|${b}`
    const t = pairMap.get(key) ?? { a: flipped ? b : a, b: flipped ? a : b, experiments: 0, aWins: 0, bWins: 0, ties: 0 }
    const win = winner === null ? 'tie' : (winner === 'parent') !== flipped ? 'a' : 'b'
    pairMap.set(key, { ...t, experiments: t.experiments + 1, aWins: t.aWins + (win === 'a' ? 1 : 0), bWins: t.bWins + (win === 'b' ? 1 : 0), ties: t.ties + (win === 'tie' ? 1 : 0) })
  }
  return { results: results.sort((x, y) => y.experiment.at.localeCompare(x.experiment.at)), pairs: [...pairMap.values()].sort((x, y) => y.experiments - x.experiments) }
}
