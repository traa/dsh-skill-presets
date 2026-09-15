/**
 * The review gate: a PR that was opened owes a routed review, and the next
 * publishing call is REFUSED until that debt is paid.
 *
 * Why this exists rather than another traffic light. The practice tracker can
 * only observe and render; it rendered `Work in a worktree [red]` beside three
 * pull requests that were opened without review on the same evening, and the
 * conductor read past it every time. Reporting red is advisory, and advice is
 * declined. `tools/pre-execute` is a waterfall that may answer `deny`, whose
 * `reason` is fed back to the model — the only seam in this plugin with teeth.
 *
 * The failure has a shape worth naming: review was skipped only on work the
 * conductor PROPOSED, never on work the user assigned. `gh pr create` reads as
 * the finish line, so review lands after it as an optional follow-up and is
 * dropped. A gate that refuses the NEXT publish makes the debt block the thing
 * the conductor wants most.
 *
 * CONTAINMENT IS THE POINT OF THIS FILE'S SHAPE. This middleware sits in tool
 * dispatch for EVERY agent in the process. A throw, a hang, or a wrong `deny`
 * here breaks tools for sessions that have nothing to do with reviews. So:
 *
 * - {@link ReviewGate.decide} is SYNCHRONOUS over in-memory state. It performs
 *   no I/O and awaits nothing, so it cannot hang and cannot wedge the waterfall.
 * - Every public method is wrapped so it returns the ALLOW-shaped answer
 *   (`undefined`) on any internal fault; none of them can throw at the caller.
 * - Repeated faults TRIP the gate off for the rest of the process
 *   ({@link FAULT_LIMIT}). A gate that is misbehaving stops gating rather than
 *   keeps rolling the dice on tool dispatch.
 * - State is memory-only. Nothing survives a restart, so no persisted record
 *   can wedge a later session.
 *
 * Evidence rules match the detectors around it: obligations are opened and
 * discharged by TOOL NAMES, TOOL ARGUMENTS and forge output — never by
 * assistant prose — so the behaviour is provider-neutral and replayable.
 * @module dsh-skill-presets/host/practices/reviewgate
 */

import { findPrUrl, isPrCreateCommand, short } from './detectors.ts'

/** Consecutive internal faults after which the gate disables itself. */
export const FAULT_LIMIT = 3

/** How long an unpaid obligation is remembered. Hygiene, not a bypass. */
export const OBLIGATION_TTL_MS = 6 * 60 * 60 * 1000

/** Per-session and total caps, so a long-lived process cannot grow unbounded. */
export const MAX_OBLIGATIONS_PER_SESSION = 16
export const MAX_SESSIONS = 200

/** Longest argument text scanned. Bounds every regex below to linear work. */
const MAX_SCAN = 20_000

/**
 * The explicit escape, declared in the arguments of the call being gated.
 *
 * Deliberately a phrase the conductor must TYPE into the PR body or a PR
 * comment, because the requirement is that the escape leave a trace: once
 * written it is public on the pull request, attributable and permanent. An
 * inferred escape ("no teammate looks like a reviewer") would be silent, and a
 * silent escape decays into the same ignorable amber this gate replaces.
 */
export const NO_REVIEWER_MARKER = /no[-\s_]?reviewer[-\s_]?available/iu

/** A pull request that was opened and has not been routed for review yet. */
export interface Obligation {
  /** How the PR is named back to the model. */
  readonly label: string
  /**
   * The string a discharging call must contain, when we have one.
   *
   * Absent means the forge printed nothing we could pin the PR to; discharge
   * then falls back to "any routed review after this moment" (see
   * {@link discharges}). Weaker, but it always leaves a way out.
   */
  readonly ref?: string
  readonly kind: 'url' | 'branch' | 'unknown'
  readonly at: number
}

/** Everything {@link ReviewGate} needs from the session, all cheap reads. */
export interface GateContext {
  /** Whether a team is attached (a reviewer can actually be routed to). */
  readonly teamAttached: boolean
  /** Current branch from git facts, used to pin a PR whose URL never printed. */
  readonly branch?: string
}

/** `off` disables the gate; `all` arms it even with no team attached. */
export type GateMode = 'default' | 'off' | 'all'

/** Read the process-level switch. Pure apart from the env read. */
export function modeFrom(env: Record<string, string | undefined>): GateMode {
  const raw = (env.DSH_REVIEW_GATE ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off'
  if (raw === 'all' || raw === 'always') return 'all'
  return 'default'
}

function clip(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_SCAN) : ''
}

/** Every string argument worth scanning, joined and bounded. */
export function argText(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['command', 'task', 'member', 'body', 'message', 'title', 'prompt', 'description']) {
    const value = clip(args[key])
    if (value.length > 0) parts.push(value)
  }
  return parts.join('\n').slice(0, MAX_SCAN)
}

/** Whether a bash command merges a PR/MR through a known CLI. */
export function isPrMergeCommand(command: string | undefined): boolean {
  if (command === undefined) return false
  return /\b(?:gh\s+pr\s+merge|glab\s+mr\s+merge|az\s+repos\s+pr\s+update[^\n]*--status\s+completed|bb\s+pr\s+merge)\b/u
    .test(command.slice(0, MAX_SCAN))
}

/** Whether a bash command posts review notes onto a PR/MR. */
export function isPrReviewComment(command: string | undefined): boolean {
  if (command === undefined) return false
  return /\b(?:gh\s+pr\s+(?:comment|review)|glab\s+mr\s+(?:note|approve))\b/u.test(command.slice(0, MAX_SCAN))
}

/**
 * The PR a review-comment command targets, when it names one positionally.
 *
 * `gh pr comment 12 --body ...` identifies the pull request by BARE number —
 * no `#`, no URL — which is the most natural way to post review notes and the
 * form a plain substring match against the PR URL silently misses. Returns
 * `'current'` when no selector is given (`gh pr comment --body ...` targets the
 * current branch's PR).
 */
export function commentTarget(command: string): string | undefined {
  const match = /\b(?:gh\s+pr\s+(?:comment|review)|glab\s+mr\s+(?:note|approve))\s+([^\s-][^\s]*)?/u
    .exec(command.slice(0, MAX_SCAN))
  if (match === null) return undefined
  const selector = match[1]
  if (selector === undefined || selector.length === 0) return 'current'
  return selector
}

const BASH = new Set(['bash', 'Bash', 'shell', 'terminal'])

/**
 * Is this call an act of PUBLISHING — the class the gate refuses?
 *
 * Only `gh pr create` and `gh pr merge` (and forge equivalents). Both are pure
 * publication: neither ever appears in the middle of implementation work, so
 * refusing them cannot stall a teammate mid-edit. Pushing to the obligated
 * branch was considered and REJECTED as a chokepoint: `git push` is how a
 * fixup, a rebase and a review response all reach the remote, so gating it
 * would deny the very work that discharges the debt.
 */
export function isPublishingCall(name: string, args: Record<string, unknown>): 'create' | 'merge' | undefined {
  if (!BASH.has(name)) return undefined
  const command = clip(args.command)
  if (command.length === 0) return undefined
  if (isPrMergeCommand(command)) return 'merge'
  if (isPrCreateCommand(command)) return 'create'
  return undefined
}

/**
 * Does this call route a review of `ob`?
 *
 * Two routes, both of them things that HAPPENED rather than things the model
 * said it would do:
 *
 * 1. `team_delegate` — work handed to a teammate. The PR reference must appear
 *    in the arguments, which is what ties the delegation to THIS pull request
 *    and is exactly what the denial text instructs.
 * 2. `gh pr comment` / `gh pr review` — review notes posted onto the PR. This
 *    is the route for a reviewer that is not a roster teammate, and it leaves
 *    its evidence on the forge rather than in this process.
 *
 * The roster's `reviews` field was considered as a third route (delegate to
 * whoever is configured as a reviewer, no PR reference needed). It is NOT used:
 * reading it would make this an async lookup against a sibling plugin's
 * service, and `decide` must stay synchronous to stay containable. Requiring
 * the PR reference is also strictly better evidence — it discharges one named
 * PR instead of any delegation that happens to follow one.
 */
export function discharges(ob: Obligation, name: string, args: Record<string, unknown>, isError: boolean): boolean {
  if (isError) return false
  const isDelegate = name === 'team_delegate'
  const isComment = BASH.has(name) && isPrReviewComment(clip(args.command))
  if (!isDelegate && !isComment) return false
  // Nothing identified the PR, so any routed review after it is accepted. The
  // alternative — an obligation no call can satisfy — is a wedge.
  if (ob.ref === undefined) return true
  const haystack = argText(args).toLowerCase()
  if (haystack.length === 0) return false
  const ref = ob.ref.toLowerCase()
  if (haystack.includes(ref)) return true
  const number = ob.kind === 'url' ? /\/pull\/(\d+)|\/merge_requests\/(\d+)/u.exec(ref)?.slice(1).find(v => v !== undefined) : undefined
  // A URL also discharges by its bare number (`#12`, `pull/12`): the conductor
  // routinely refers to the PR that way and the match is still exact.
  if (number !== undefined && new RegExp(`(?:#|/pull/|/merge_requests/)${number}(?!\\d)`, 'u').test(haystack)) return true
  if (isComment) {
    const target = commentTarget(clip(args.command))
    // `gh pr comment --body ...` with no selector posts to the CURRENT
    // branch's PR. There is exactly one outstanding PR per branch here, so
    // treating it as a discharge is correct and avoids a wedge over syntax.
    if (target === 'current') return true
    if (target !== undefined && number !== undefined && target === number) return true
    if (target !== undefined && target.toLowerCase() === ref) return true
  }
  return false
}

/** Whether the arguments carry the explicit "no reviewer available" escape. */
export function declaresNoReviewer(args: Record<string, unknown>): boolean {
  return NO_REVIEWER_MARKER.test(argText(args))
}

/** Build the obligation a successful PR-create leaves behind. */
export function obligationFrom(output: string, command: string, branch: string | undefined, now: number): Obligation {
  // The forge prints the URL on its OWN line, typically after a "Creating pull
  // request..." banner, so this reads the whole captured output. The tracker's
  // `ObservedCall.resultHead` keeps only the first line and would miss it.
  const url = findPrUrl(output.slice(0, MAX_SCAN)) ?? findPrUrl(command.slice(0, MAX_SCAN))
  if (url !== undefined) return { label: url, ref: url, kind: 'url', at: now }
  if (branch !== undefined && branch.length > 0) {
    return { label: `the PR for branch ${branch}`, ref: branch, kind: 'branch', at: now }
  }
  return { label: `the PR opened by \`${short(command, 80)}\``, kind: 'unknown', at: now }
}

/** A refusal, in the shape `tools/pre-execute` expects. */
export interface Denial {
  readonly kind: 'deny'
  readonly reason: string
}

/** Compose the text the model reads when it is refused. Pure. */
export function denialReason(ob: Obligation, attempt: 'create' | 'merge'): string {
  const what = attempt === 'merge' ? 'Merging' : 'Opening another pull request'
  return [
    `${what} is blocked: ${ob.label} was opened in this session and no review has been routed for it.`,
    'Discharge it with ONE of these, then retry:',
    `  1. team_delegate to your reviewing teammate, naming ${ob.label} in the task.`,
    `  2. gh pr comment on that PR with the review notes.`,
    'If this repository has no reviewer, say so explicitly and it will be allowed:',
    'include the exact phrase "no reviewer available" in the --body of this call'
    + ' (it is recorded on the pull request, so the decision stays visible).',
  ].join('\n')
}

/**
 * Per-session obligations plus the gate decision. Memory only.
 *
 * Every method is total: it catches its own faults, counts them, and answers
 * the permissive result. After {@link FAULT_LIMIT} faults the gate trips off
 * permanently for this process.
 */
export class ReviewGate {
  private readonly sessions = new Map<string, Obligation[]>()
  private faults = 0
  private tripped = false

  constructor(
    private readonly mode: GateMode = 'default',
    private readonly log: (message: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the gate has disabled itself after repeated faults. */
  get isTripped(): boolean {
    return this.tripped
  }

  /** Outstanding obligations for a session, freshest last. For tests and the panel. */
  outstanding(sessionId: string): readonly Obligation[] {
    try {
      return this.prune(sessionId)
    } catch {
      return []
    }
  }

  /** Forget a session (it ended). */
  forget(sessionId: string): void {
    try { this.sessions.delete(sessionId) } catch { /* nothing to undo */ }
  }

  /**
   * Record a finished tool call: open an obligation on a successful PR-create,
   * discharge matching ones on a routed review. Never throws.
   * @param output - the call's captured text output (full, not just line one).
   */
  observe(sessionId: string, name: string, args: Record<string, unknown>, isError: boolean, output: string, ctx: GateContext): void {
    if (this.tripped || this.mode === 'off') return
    try {
      if (this.mode !== 'all' && !ctx.teamAttached) return
      const list = this.prune(sessionId)
      const kept = list.filter(ob => !discharges(ob, name, args, isError))
      if (kept.length !== list.length) {
        this.log(`review gate: ${list.length - kept.length} obligation(s) discharged in ${sessionId}`)
      }
      let next = kept
      if (!isError && isPublishingCall(name, args) === 'create') {
        const ob = obligationFrom(output, clip(args.command), ctx.branch, this.now())
        // An explicit "no reviewer available" on the CREATE itself means the
        // debt is never taken on. The declaration is already in the PR body.
        if (!declaresNoReviewer(args)) next = [...kept, ob]
        else this.log(`review gate: ${ob.label} declared no-reviewer-available at creation`)
      }
      this.store(sessionId, next)
      this.faults = 0
    } catch (error) {
      this.fault('observe', error)
    }
  }

  /**
   * The gate decision. SYNCHRONOUS, no I/O, cannot hang.
   * @returns a denial, or `undefined` meaning allow (also on any fault).
   */
  decide(sessionId: string, name: string, args: Record<string, unknown>, ctx: GateContext): Denial | undefined {
    if (this.tripped || this.mode === 'off') return undefined
    try {
      if (this.mode !== 'all' && !ctx.teamAttached) return undefined
      const attempt = isPublishingCall(name, args)
      if (attempt === undefined) return undefined
      const list = this.prune(sessionId)
      const oldest = list[0]
      if (oldest === undefined) return undefined
      // The escape is read off the call being refused, so the declaration and
      // the act it excuses are the same event and land together on the forge.
      if (declaresNoReviewer(args)) {
        this.log(`review gate: escape declared for ${oldest.label} in ${sessionId}; allowing ${attempt}`)
        this.store(sessionId, [])
        return undefined
      }
      const reason = denialReason(oldest, attempt)
      // Belt and braces: a malformed reason must not become a deny with no
      // explanation, which would be an unexplainable wall for the model.
      if (typeof reason !== 'string' || reason.length === 0) return undefined
      this.faults = 0
      return { kind: 'deny', reason }
    } catch (error) {
      this.fault('decide', error)
      return undefined
    }
  }

  /** Drop expired obligations and return what remains. */
  private prune(sessionId: string): Obligation[] {
    const list = this.sessions.get(sessionId) ?? []
    const cutoff = this.now() - OBLIGATION_TTL_MS
    const live = list.filter(ob => ob.at >= cutoff)
    if (live.length !== list.length) this.sessions.set(sessionId, live)
    return live
  }

  private store(sessionId: string, list: readonly Obligation[]): void {
    if (list.length === 0) { this.sessions.delete(sessionId); return }
    this.sessions.set(sessionId, list.slice(-MAX_OBLIGATIONS_PER_SESSION))
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done !== true) this.sessions.delete(oldest.value)
    }
  }

  /**
   * Count a fault and trip the gate off once they accumulate.
   *
   * A gate that keeps faulting is a gate whose answers cannot be trusted, and
   * an untrusted answer in tool dispatch is worse than no gate at all.
   */
  private fault(where: string, error: unknown): void {
    this.faults += 1
    this.log(`review gate ${where} fault (${this.faults}/${FAULT_LIMIT}): ${(error as Error)?.message ?? String(error)}`)
    if (this.faults >= FAULT_LIMIT) {
      this.tripped = true
      this.log('review gate: disabled for this process after repeated faults; tool calls are no longer gated')
    }
  }
}
