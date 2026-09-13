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

