/**
 * Team attachment, read through `ctx.agentTeams` when dsh-agent-teams
 * publishes it, else inferred from `team_delegate` tool visibility (the
 * Phase-1 seam). Also derives whether the attached team's own conductor
 * instructions demand an approval turn before the first delegation — the
 * rule the conductor practice enforces only when the team asked for it.
 * @module dsh-skill-presets/host/teams
 */

/** The slice of dsh-agent-teams' service this plugin reads. */
export interface AgentTeamsLike {
  attachment(sessionId: string): Promise<{ teamId: string, teamName: string } | undefined>
  teamFor(sessionId: string): Promise<{ id: string, name: string, conductorInstructions?: string, members: readonly { id: string, name: string }[] } | undefined>
  onAttachmentChange(listener: (sessionId: string, team: unknown) => void): () => void
}

export interface TeamView {
  readonly attached: boolean
  readonly teamName?: string
  /** Whether the team's instructions require approval before delegating. Undefined when unknown. */
  readonly approvalRequired?: boolean
  readonly source: 'service' | 'tool-visibility' | 'none'
}

/**
 * Does this text ask the conductor to propose and wait before delegating?
 * Pure; conservative — matches the shipped default instructions and the
 * obvious phrasings, and nothing else.
 */
export function requiresApproval(instructions: string | undefined): boolean | undefined {
  if (instructions === undefined || instructions.trim().length === 0) return undefined
  const text = instructions.toLowerCase()
  const asks = /\b(?:wait for|get|ask for|require|obtain)\b[^.\n]{0,40}\bapprov/u.test(text)
    || /\bbefore delegating\b[^.\n]{0,60}\b(?:approv|tell the user|propose)/u.test(text)
    || /\b(?:propose|tell the user)\b[^.\n]{0,80}\bthen wait\b/u.test(text)
  const waives = /\b(?:no approval|without approval|delegate immediately|fan out immediately|do not wait)\b/u.test(text)
  if (waives) return false
  if (asks) return true
  return undefined
}

export class TeamReader {
  private readonly cache = new Map<string, { view: TeamView, at: number }>()

  constructor(
    private readonly service: () => AgentTeamsLike | undefined,
    private readonly toolVisible: (agent: unknown) => boolean,
    private readonly ttlMs = 5000,
  ) {}

  /** Invalidate one session (called from onAttachmentChange). */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  /** Resolve the view; cached briefly because pre-step calls it every step. */
  async view(sessionId: string, agent: unknown): Promise<TeamView> {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < this.ttlMs) return cached.view
    let view: TeamView
    const service = this.service()
    if (service !== undefined) {
      try {
        const team = await service.teamFor(sessionId)
        view = team === undefined
          ? { attached: false, source: 'service' }
          : { attached: true, teamName: team.name, source: 'service', ...(requiresApproval(team.conductorInstructions) !== undefined ? { approvalRequired: requiresApproval(team.conductorInstructions)! } : {}) }
      } catch {
        view = { attached: this.toolVisible(agent), source: 'tool-visibility' }
      }
    } else {
      view = { attached: this.toolVisible(agent), source: 'tool-visibility' }
    }
    this.cache.set(sessionId, { view, at: Date.now() })
    return view
  }

  /** Synchronous best-effort read for hot paths (pre-execute gates). */
  peek(sessionId: string, agent: unknown): boolean {
    const cached = this.cache.get(sessionId)
    return cached !== undefined ? cached.view.attached : this.toolVisible(agent)
  }
}
