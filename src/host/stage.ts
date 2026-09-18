/**
 * Stage detection: a pure fold from git facts and recent tool calls to
 * `{ stage, confidence, why[] }`, plus the suggestion lifecycle (accept,
 * dismiss, mute after repeated dismissals).
 *
 * Detection only ever SUGGESTS. The playbook keeps humans at the gates; the
 * chip pulses, the user clicks. No model call, so it costs nothing and behaves
 * the same under every provider.
 * @module dsh-skill-presets/host/stage
 */

import type { GitFacts } from './practices/git.ts'
import type { ObservedCall } from './practices/detectors.ts'
import type { Stage } from './types.ts'

export interface StageGuess {
  readonly stage: Stage
  /**
   * 0..1 certainty in the GUESS — never progress through the stage. Suggestions
   * fire at ≥ `SUGGEST_AT`; anything at or below 0.5 is a fallback reached
   * because nothing matched, so renderers must not present it as a finding.
   */
  readonly confidence: number
  readonly why: readonly string[]
}

const has = (facts: GitFacts, file: string): boolean => facts.artifacts.some(a => a.endsWith(`/${file}`) || a === file)

/**
 * Guess the stage from committed artifacts, PR state, and recent commands.
 * @param facts - git facts; undefined → plan with low confidence.
 * @param recent - the last few observed calls (newest last).
 */
export function detectStage(facts: GitFacts | undefined, _recent: readonly ObservedCall[] = []): StageGuess {
  // The two fallbacks below describe the DETECTOR's own position ("I have
  // nothing to go on"), never the repository's. A `why` that reads as a
  // complaint about the workspace is a defect: the user did nothing wrong by
  // starting outside a repo or before the first artifact exists.
  if (facts === undefined || !facts.inRepo) return { stage: 'plan', confidence: 0.2, why: ['no repository read yet; defaulting to Plan'] }
  // Phase 7: artifacts and PR state ONLY. Shell verbs and edit counts used to
  // feed this and made the chip pulse mid-session; a `kubectl` in a grep or a
  // `git revert` of a typo is not the human changing stage.
  if (facts.artifacts.some(a => /incidents?\//u.test(a))) return { stage: 'maintain', confidence: 0.75, why: ['incident record present'] }
  if (facts.pr !== undefined) {
    if (/merged/iu.test(facts.pr.state)) return { stage: 'deploy', confidence: 0.75, why: [`PR merged: ${facts.pr.url}`] }
    return { stage: 'test', confidence: 0.85, why: [`PR open: ${facts.pr.url}`] }
  }
  if (has(facts, 'plan.md')) return { stage: 'build', confidence: 0.8, why: ['plan.md committed'] }
  if (has(facts, 'spec.md') || has(facts, 'intent.md')) {
    return { stage: 'design', confidence: has(facts, 'spec.md') ? 0.8 : 0.7, why: [has(facts, 'spec.md') ? 'spec.md present, no plan.md' : 'intent.md present, no spec.md'] }
  }
  return { stage: 'plan', confidence: 0.5, why: ['nothing observed yet; defaulting to Plan'] }
}

/**
 * Whether NOW is a moment to offer a suggestion at all. Pure.
 *
 * Two moments, from the playbook: the start of a session that has no explicit
 * position yet ("where should I start?"), and the appearance of the CURRENT
 * stage's gate artifact ("an accepted artifact fires the next gate"). Nothing
 * else — not edits, not commands, not time.
 */
export function shouldSuggest(input: { explicitPosition: boolean, stage: Stage | null, previous: GitFacts | undefined, facts: GitFacts | undefined }): boolean {
  if (input.stage === null) return false
  if (!input.explicitPosition) return true
  if (input.previous === undefined || input.facts === undefined) return false
  const gate = GATE_ARTIFACT[input.stage]
  if (gate === undefined) return false
  const had = gate === 'PR' ? input.previous.pr !== undefined : has(input.previous, gate)
  const now = gate === 'PR' ? input.facts.pr !== undefined : has(input.facts, gate)
  return !had && now
}

/** The artifact whose appearance ends a stage. Mirrors `flows.ts` `gateFor` for the file-shaped ones. */
const GATE_ARTIFACT: Readonly<Partial<Record<Stage, string>>> = { plan: 'intent.md', design: 'spec.md', build: 'plan.md', test: 'PR' }

/** Dismissal memory per workspace, keyed by `<from>→<to>`. */
export interface SuggestionsDoc {
  readonly version: 1
  readonly dismissed: Record<string, { count: number, lastAt: string }>
}

export function emptySuggestions(): SuggestionsDoc {
  return { version: 1, dismissed: {} }
}

export function validateSuggestions(raw: unknown): SuggestionsDoc {
  const doc = raw as Partial<SuggestionsDoc>
  if (doc === null || typeof doc !== 'object') throw new TypeError('suggestions is not an object')
  const dismissed: SuggestionsDoc['dismissed'] = {}
  if (typeof doc.dismissed === 'object' && doc.dismissed !== null) {
    for (const [k, v] of Object.entries(doc.dismissed)) {
      if (typeof v === 'object' && v !== null && typeof (v as { count: unknown }).count === 'number') dismissed[k] = { count: (v as { count: number }).count, lastAt: String((v as { lastAt?: unknown }).lastAt ?? '') }
    }
  }
  return { version: 1, dismissed }
}

export const MUTE_AFTER = 3
export const SUGGEST_AT = 0.7

export interface Suggestion {
  readonly from: Stage | null
  readonly to: Stage
  /** The preset id to activate, when exactly one preset owns the stage. */
  readonly presetId?: string
  readonly confidence: number
  readonly why: readonly string[]
}

/**
 * Decide whether to suggest a switch.
 * @param guess - detected stage.
 * @param activeStage - stage of the session's active preset (undefined = none/cross).
 * @param presetsByStage - stage → preset ids.
 * @param doc - dismissal memory.
 */
export function suggest(
  guess: StageGuess,
  activeStage: Stage | undefined,
  presetsByStage: ReadonlyMap<Stage, readonly string[]>,
  doc: SuggestionsDoc,
): Suggestion | undefined {
  if (guess.confidence < SUGGEST_AT) return undefined
  if (activeStage === guess.stage) return undefined
  const key = transitionKey(activeStage ?? null, guess.stage)
  if ((doc.dismissed[key]?.count ?? 0) >= MUTE_AFTER) return undefined
  const owners = presetsByStage.get(guess.stage) ?? []
  return {
    from: activeStage ?? null,
    to: guess.stage,
    ...(owners.length === 1 ? { presetId: owners[0] } : {}),
    confidence: guess.confidence,
    why: guess.why,
  }
}

export function transitionKey(from: Stage | null, to: Stage): string {
  return `${from ?? 'none'}→${to}`
}

export function recordDismissal(doc: SuggestionsDoc, from: Stage | null, to: Stage, now: Date): SuggestionsDoc {
  const key = transitionKey(from, to)
  const previous = doc.dismissed[key]
  return { ...doc, dismissed: { ...doc.dismissed, [key]: { count: (previous?.count ?? 0) + 1, lastAt: now.toISOString() } } }
}

/** Accepting clears the dismissal history for that transition. */
export function recordAcceptance(doc: SuggestionsDoc, from: Stage | null, to: Stage): SuggestionsDoc {
  const key = transitionKey(from, to)
  if (!(key in doc.dismissed)) return doc
  const { [key]: _dropped, ...dismissed } = doc.dismissed
  return { ...doc, dismissed }
}
