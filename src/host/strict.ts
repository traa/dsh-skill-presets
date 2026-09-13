/**
 * Strict catalog: make "exactly this set of skills" true for an agent.
 *
 * Uses the harness's `ctx.skills.restrict()` (a per-scope allow-list over
 * inherited skills) when the running harness has it, and re-applies it
 * whenever the session's resolved set changes. Without the seam the `skill`
 * pre-execute guard is the only enforcement, and the UI says so. Nothing here
 * depends on a vendor; it is a harness registry contract.
 * @module dsh-skill-presets/host/strict
 */

/** The slice of a scoped skills registry this module needs. */
export interface RestrictableSkills {
  restrict?(filter: { allow?: readonly string[], deny?: readonly string[] }): () => void
}

/** Whether the running harness exposes the seam on this agent's scoped context. */
export function canRestrict(agentCtx: unknown): boolean {
  const skills = (agentCtx as { skills?: RestrictableSkills } | undefined)?.skills
    ?? (agentCtx as { get?(name: string): unknown } | undefined)?.get?.('skills') as RestrictableSkills | undefined
  return typeof skills?.restrict === 'function'
}

function skillsOf(agentCtx: unknown): RestrictableSkills | undefined {
  const direct = (agentCtx as { skills?: RestrictableSkills } | undefined)?.skills
  if (direct !== undefined) return direct
  return (agentCtx as { get?(name: string): unknown } | undefined)?.get?.('skills') as RestrictableSkills | undefined
}

/**
 * Keeps one live restriction per session and swaps it when the allowed set
 * changes. Idempotent for an unchanged set (no churn, no `skills/change`).
 */
export class StrictCatalog {
  private readonly live = new Map<string, { key: string, dispose: () => void }>()

  constructor(private readonly log: (message: string) => void = () => {}) {}

  /**
   * Apply (or re-apply) the allow-list for a session.
   * @returns `applied` when a restriction is live, `unsupported` when the seam is absent.
   */
  apply(sessionId: string, agentCtx: unknown, allow: readonly string[]): 'applied' | 'unsupported' | 'unchanged' {
    const skills = skillsOf(agentCtx)
    if (typeof skills?.restrict !== 'function') return 'unsupported'
    const key = [...allow].sort().join(',')
    const current = this.live.get(sessionId)
    if (current?.key === key) return 'unchanged'
    current?.dispose()
    this.live.delete(sessionId)
    try {
      // An empty allow-list is a legitimate "nothing inherited": pass a
      // sentinel name so the registry accepts the filter as non-empty.
      const dispose = skills.restrict({ allow: allow.length > 0 ? allow : ['no-inherited-skills'] })
      this.live.set(sessionId, { key, dispose })
      return 'applied'
    } catch (error) {
      this.log(`strict catalog for ${sessionId}: ${(error as Error).message}`)
      return 'unsupported'
    }
  }

  /** Lift the restriction for a session (strict turned off, or session gone). */
  release(sessionId: string): void {
    const current = this.live.get(sessionId)
    if (current === undefined) return
    try { current.dispose() } catch { /* already disposed with the scope */ }
    this.live.delete(sessionId)
  }

  releaseAll(): void {
    for (const id of [...this.live.keys()]) this.release(id)
  }

  isApplied(sessionId: string): boolean {
    return this.live.has(sessionId)
  }
}
