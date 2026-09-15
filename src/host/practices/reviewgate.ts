/**
 * The review gate: opening a pull request is not finishing the work.
 *
 * The mechanism is a REMINDER, not a ledger. The instant `gh pr create`
 * returns, `tools/post-execute` attaches a `UserMessage` to its
 * `PostToolDecision.additionalContexts` and the agent loop delivers it with the
 * model's next request — at the moment the PR exists, with its number in hand.
 * Nothing needs to be remembered for hours, expired, capped, or escaped from.
 *
 * A small deny sits behind it so the reminder is not optional: while a PR
 * opened in this session has had no review routed, the next `gh pr create` or
 * `gh pr merge` is refused and names it. That is the whole of the state.
 *
 * What the reminder encodes, and the previous design did not, is the LOOP —
 * findings come back, reach whoever implemented the change, and iterate until
 * resolved. It is instruction text rather than tracked state, because tracking
 * "was each finding resolved" is exactly the ledger this replaced.
 *
 * CONTAINMENT IS THE POINT OF THIS FILE'S SHAPE. Both listeners are waterfall
 * middleware in tool dispatch for EVERY agent in the process, and a throw in
 * post-execute turns a SUCCESSFUL tool call into an error result. So both
 * public methods are SYNCHRONOUS over in-memory state (no I/O, nothing awaited,
 * so neither can hang), both catch their own faults and answer permissively
 * (`decide` allows, `observe` injects nothing), and every scan of tool
 * arguments is bounded by {@link MAX_SCAN} before a regex touches it —
 * unbounded work in the dispatch path is a distinct risk from an uncaught
 * throw, and the bound is what stops one enormous argument stalling every agent
 * in the process. State is memory-only and dropped on `forget`.
 *
 * Evidence rules match the detectors around it: pending reviews are opened and
 * routed by TOOL NAMES, TOOL ARGUMENTS and forge output — never by assistant
 * prose — so the behaviour is provider-neutral and replayable.
 * @module dsh-skill-presets/host/practices/reviewgate
 */

import { findPrUrl, isPrCreateCommand, short } from './detectors.ts'

/** Longest argument text scanned. Bounds every regex below to linear work. */
const MAX_SCAN = 20_000

/**
 * Most pending reviews kept per session.
 *
 * Kept although the TTL and the global session cap were deleted: `forget`
 * bounds the map when a session ends, but nothing else bounds ONE long-lived
 * session that opens PR after PR without routing a review. Two lines, in the
 * dispatch path, so it stays.
 */
export const MAX_PENDING = 8

/** A pull request opened in this session that has had no review routed yet. */
export interface Pending {
  /** How the PR is named back to the model. */
  readonly label: string
  /**
   * The string a routing call must contain, when we have one.
   *
   * Absent means the forge printed nothing we could pin the PR to; routing
   * then falls back to "any routed review after this moment" (see
   * {@link routesReview}). Weaker, but it always leaves a way out.
   */
  readonly ref?: string
  readonly kind: 'url' | 'branch' | 'unknown'
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

/**
 * Read the process-level switch. Pure apart from the env read.
 *
 * `DSH_REVIEW_GATE=off` is the ENTIRE escape hatch, deliberately. The previous
 * in-band escape — a phrase typed into the body of the refused call — was wrong
 * twice: it cleared EVERY outstanding obligation rather than the one excused,
 * and it landed the waiver in whichever PR was being blocked, which is
 * generally not the unreviewed one, recording the wrong fact on the wrong
 * artifact. An out-of-band switch can make neither mistake: it clears no state,
 * and it is visible to whoever set it.
 */
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

/** Tools that hand work to another agent, either a teammate or a fresh one. */
const ROUTING_TOOLS = new Set(['team_delegate', 'subagent', 'subagent_fork', 'gemini_agent', 'qoder_agent'])

/**
 * Is this call an act of PUBLISHING — the class the gate refuses?
 *
 * Only `gh pr create` and `gh pr merge` (and forge equivalents). Both are pure
 * publication: neither ever appears in the middle of implementation work, so
 * refusing them cannot stall a teammate mid-edit. Pushing to the pending
 * branch was considered and REJECTED as a chokepoint: `git push` is how a
 * fixup, a rebase and a review response all reach the remote, so gating it
 * would deny the very work that resolves the review.
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
 * Does this call route a review of `p`?
 *
 * Two routes, both of them things that HAPPENED rather than things the model
 * said it would do:
 *
 * 1. A delegation — `team_delegate` to a teammate, or a `subagent` when no team
 *    is attached. The PR reference must appear in the arguments, which is what
 *    ties the delegation to THIS pull request and is exactly what the injected
 *    directive instructs.
 * 2. `gh pr comment` / `gh pr review` — review notes posted onto the PR. This
 *    is the route for a reviewer that is not a roster teammate, and it leaves
 *    its evidence on the forge rather than in this process.
 *
 * This deliberately does NOT verify that findings came back and were fixed:
 * that needs a record of each finding and its resolution, which is the ledger
 * this design removed. {@link reviewDirective} carries the loop; this answers
 * only "was a review routed at all", which is all the backstop needs.
 */
export function routesReview(p: Pending, name: string, args: Record<string, unknown>, isError: boolean): boolean {
  if (isError) return false
  const isDelegate = ROUTING_TOOLS.has(name)
  const isComment = BASH.has(name) && isPrReviewComment(clip(args.command))
  if (!isDelegate && !isComment) return false
  // Nothing identified the PR, so any routed review after it is accepted. The
  // alternative — a pending review no call can satisfy — is a wedge.
  if (p.ref === undefined) return true
  const haystack = argText(args).toLowerCase()
  if (haystack.length === 0) return false
  const ref = p.ref.toLowerCase()
  if (haystack.includes(ref)) return true
  const number = p.kind === 'url' ? /\/pull\/(\d+)|\/merge_requests\/(\d+)/u.exec(ref)?.slice(1).find(v => v !== undefined) : undefined
  // A URL also matches by its bare number (`#12`, `pull/12`): the conductor
  // routinely refers to the PR that way and the match is still exact.
  if (number !== undefined && new RegExp(`(?:#|/pull/|/merge_requests/)${number}(?!\\d)`, 'u').test(haystack)) return true
  if (isComment) {
    const target = commentTarget(clip(args.command))
    // `gh pr comment --body ...` with no selector posts to the CURRENT
    // branch's PR. There is exactly one pending PR per branch here, so
    // treating it as a routed review is correct and avoids a wedge over syntax.
    if (target === 'current') return true
    if (target !== undefined && number !== undefined && target === number) return true
    if (target !== undefined && target.toLowerCase() === ref) return true
  }
  return false
}

/** Build the pending review a successful PR-create leaves behind. */
export function pendingFrom(output: string, command: string, branch: string | undefined): Pending {
  // The forge prints the URL on its OWN line, typically after a "Creating pull
  // request..." banner, so this reads the whole captured output. The tracker's
  // `ObservedCall.resultHead` keeps only the first line and would miss it.
  const url = findPrUrl(output.slice(0, MAX_SCAN)) ?? findPrUrl(command.slice(0, MAX_SCAN))
  if (url !== undefined) return { label: url, ref: url, kind: 'url' }
  if (branch !== undefined && branch.length > 0) {
    return { label: `the PR for branch ${branch}`, ref: branch, kind: 'branch' }
  }
  return { label: `the PR opened by \`${short(command, 80)}\``, kind: 'unknown' }
}

/**
 * The directive injected into the model's context the instant the PR exists.
 *
 * Written to be hard to rationalise past. It names the PR, names the tools, and
 * closes the two gaps that actually occur: announcing a review without routing
 * one, and receiving findings without relaying them to the implementer. Pure.
 */
export function reviewDirective(p: Pending): string {
  const name = p.ref ?? p.label
  return [
    `REVIEW REQUIRED — ${p.label}`,
    '',
    'Opening this pull request did not finish the work. It is not done, and it is not ready to report as done. Before anything else:',
    '',
    `1. ROUTE THE REVIEW NOW. \`team_delegate\` to a reviewing teammate, naming ${name} in the task. If no team is attached, start a \`subagent\` instead and give it ${name}, the diff to read, and an instruction to report findings back. Do this in your next step, not later in the session.`,
    `2. RELAY EVERY FINDING to whoever implemented the change — a teammate if one did the work, otherwise yourself — and keep that loop running until each finding is fixed, or declined with a stated reason. One round is rarely enough; defects are routinely caught in the second and third.`,
    '3. ONLY THEN is this work finished. Until then, do not open another pull request, do not merge this one, and do not tell the user the work is complete.',
    '',
    'A review you announce but never route does not count. A finding you receive but never relay does not count. Saying you will review it later does not count.',
  ].join('\n')
}

/** A refusal, in the shape `tools/pre-execute` expects. */
export interface Denial {
  readonly kind: 'deny'
  readonly reason: string
}

/** Compose the text the model reads when it is refused. Pure. */
export function denialReason(p: Pending, attempt: 'create' | 'merge'): string {
  const what = attempt === 'merge' ? 'Merging' : 'Opening another pull request'
  return [
    `${what} is blocked: ${p.label} was opened in this session and no review has been routed for it.`,
    'Route it with ONE of these, then retry:',
    `  1. team_delegate (or a subagent, if no team is attached) naming ${p.label} in the task,`,
    `     then relay the findings back to the implementer until they are resolved.`,
    `  2. gh pr comment on that PR with the review notes.`,
  ].join('\n')
}

/**
 * Pending reviews per session, plus the gate decision. Memory only.
 *
 * Both methods are total: they catch their own faults and answer permissively.
 * No fault counter and no trip-wire — every fault path already degrades to
 * allow on the spot, so a trip-wire would convert a degraded-allow into a
 * degraded-allow while adding process-global state of its own.
 */
export class ReviewGate {
  private readonly sessions = new Map<string, Pending[]>()

  constructor(
    private readonly mode: GateMode = 'default',
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Pending reviews for a session, freshest last. For tests and the panel. */
  outstanding(sessionId: string): readonly Pending[] {
    try {
      return this.sessions.get(sessionId) ?? []
    } catch {
      return []
    }
  }

  /** Forget a session (it ended). */
  forget(sessionId: string): void {
    try { this.sessions.delete(sessionId) } catch { /* nothing to undo */ }
  }

  /**
   * Record a finished tool call and return the directive to inject, if any.
   *
   * SYNCHRONOUS, no I/O, cannot hang, never throws: a fault yields `undefined`,
   * which the caller reads as "inject nothing" and passes the result through.
   * @param output - the call's captured text output (full, not just line one).
   * @returns the text to deliver to the model, or `undefined` for nothing.
   */
  observe(sessionId: string, name: string, args: Record<string, unknown>, isError: boolean, output: string, ctx: GateContext): string | undefined {
    if (this.mode === 'off') return undefined
    try {
      if (this.mode !== 'all' && !ctx.teamAttached) return undefined
      const list = this.sessions.get(sessionId) ?? []
      const kept = list.filter(p => !routesReview(p, name, args, isError))
      if (kept.length !== list.length) {
        this.log(`review gate: review routed for ${list.length - kept.length} PR(s) in ${sessionId}`)
      }
      if (isError || isPublishingCall(name, args) !== 'create') {
        this.store(sessionId, kept)
        return undefined
      }
      const pending = pendingFrom(output, clip(args.command), ctx.branch)
      this.store(sessionId, [...kept, pending])
      this.log(`review gate: ${pending.label} opened in ${sessionId}; review directive injected`)
      return reviewDirective(pending)
    } catch (error) {
      this.log(`review gate observe fault, injecting nothing: ${(error as Error)?.message ?? String(error)}`)
      return undefined
    }
  }

  /**
   * The backstop decision. SYNCHRONOUS, no I/O, cannot hang.
   * @returns a denial, or `undefined` meaning allow (also on any fault).
   */
  decide(sessionId: string, name: string, args: Record<string, unknown>, ctx: GateContext): Denial | undefined {
    if (this.mode === 'off') return undefined
    try {
      if (this.mode !== 'all' && !ctx.teamAttached) return undefined
      const attempt = isPublishingCall(name, args)
      if (attempt === undefined) return undefined
      const oldest = (this.sessions.get(sessionId) ?? [])[0]
      if (oldest === undefined) return undefined
      const reason = denialReason(oldest, attempt)
      // Belt and braces: a malformed reason must not become a deny with no
      // explanation, which would be an unexplainable wall for the model.
      if (typeof reason !== 'string' || reason.length === 0) return undefined
      return { kind: 'deny', reason }
    } catch (error) {
      this.log(`review gate decide fault, allowing: ${(error as Error)?.message ?? String(error)}`)
      return undefined
    }
  }

  private store(sessionId: string, list: readonly Pending[]): void {
    if (list.length === 0) { this.sessions.delete(sessionId); return }
    this.sessions.set(sessionId, list.slice(-MAX_PENDING))
  }
}
