/**
 * Pure practice detectors.
 *
 * Each fold takes the session's observed tool calls plus git facts and returns
 * a traffic-light result with evidence. Nothing here reads assistant prose or a
 * vendor transcript format — only tool names, arguments, results, and git —
 * so the same fold behaves identically under every provider, and it can be
 * replayed from recorded fixtures.
 * @module dsh-skill-presets/host/practices/detectors
 */

import type { GitFacts } from './git.ts'
import type { PracticeId, PracticeResult, Stage } from '../types.ts'

/** One observed tool call, the only per-call data detectors keep. */
export interface ObservedCall {
  readonly t: string
  readonly turn: number
  readonly name: string
  /** File path for write/edit; command for bash; skill name for skill. */
  readonly target?: string
  readonly isError: boolean
  /** First line of the rendered result, for URL sniffing. */
  readonly resultHead?: string
}

/** Session-level inputs to the detectors. */
export interface SessionView {
  readonly calls: readonly ObservedCall[]
  readonly facts?: GitFacts
  /** Whether `team_delegate` is visible to this agent (a team is attached). */
  readonly teamAttached: boolean
  /** Whether the team's own instructions demand approval before the first delegation. Default true. */
  readonly approvalRequired?: boolean
  /** Turn indices at which the user spoke (a new turn began). */
  readonly userTurns: readonly number[]
  readonly activeStage?: Stage
  readonly protectedBranches: readonly string[]
  /** Whether the session has ended (final checks apply). */
  readonly ended: boolean
  /** Edited paths not covered by plan.md, in order; plan.md itself edited later clears them. */
  readonly drift?: readonly { path: string, t: string }[]
  readonly planUpdated?: boolean
  /** Worktree scan summary for the work root's repo. */
  readonly worktrees?: { removable: number, attention: string[], stale: number, symlinked: number, total: number }
}

/**
 * Evidence is rendered into the model's own system prompt, so anything
 * interpolated from a tool call must be bounded. A `bash` target is the ENTIRE
 * command — a 5000-character heredoc once landed verbatim in an evidence line
 * and flooded the context window. Collapsing whitespace also keeps a
 * multi-line command on one evidence line.
 */
export function short(text: string, max = 120): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const WRITE_TOOLS = new Set(['write', 'edit', 'Write', 'Edit', 'multi_edit', 'MultiEdit', 'notebook_edit'])
const BASH_TOOLS = new Set(['bash', 'Bash', 'shell', 'terminal'])

/** Whether a bash command plausibly mutates the working tree or repository. */
export function isMutatingCommand(command: string | undefined): boolean {
  if (command === undefined) return false
  const c = command.trim()
  if (c.length === 0) return false
  // Output redirection mutates regardless of the command in front of it.
  if (/(?:^|[^<>])>{1,2}\s*[^&\s]/u.test(c)) return true
  // Read-only prefixes.
  if (/^(?:git\s+(?:status|log|diff|show|branch(?:\s+--show-current|\s+-a|\s+-r|\s*$)|rev-parse|remote\s+-v|worktree\s+list)|ls|cat|head|tail|grep|rg|find|pwd|echo|which|node\s+-e|npm\s+(?:test|run\s+\w+|ls)|pnpm\s+(?:test|run\s+\w+))\b/u.test(c)) {
    return false
  }
  return /(?:^|[;&|]\s*)(?:git\s+(?:add|commit|checkout\s+-b|switch\s+-c|merge|rebase|reset|rm|mv|stash|apply|cherry-pick|push)|rm\b|mv\b|cp\b|mkdir\b|touch\b|sed\s+-i|tee\b|>\s*\S|>>\s*\S|npm\s+(?:install|i|uninstall)|pnpm\s+(?:add|install|remove)|yarn\s+add|cargo\s+add|pip\s+install)/u.test(c)
}

/** Whether a call mutates files (write/edit, or a mutating bash command). */
export function isMutatingCall(call: ObservedCall): boolean {
  if (WRITE_TOOLS.has(call.name)) return true
  if (BASH_TOOLS.has(call.name)) return isMutatingCommand(call.target)
  return false
}

const PR_URL = /https?:\/\/[^\s)]+\/(?:pull|pulls|merge_requests|pull-requests)\/\d+/u

/** Whether text carries a pull/merge request URL from any forge. */
export function findPrUrl(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return text.match(PR_URL)?.[0]
}

/** Whether a bash command creates a PR/MR through a known CLI. */
export function isPrCreateCommand(command: string | undefined): boolean {
  if (command === undefined) return false
  return /\b(?:gh\s+pr\s+create|glab\s+mr\s+create|az\s+repos\s+pr\s+create|bb\s+pr\s+create)\b/u.test(command)
}

function result(id: PracticeId, status: PracticeResult['status'], evidence: string[], firstViolationAt?: string): PracticeResult {
  return { id, status, evidence, ...(firstViolationAt !== undefined ? { firstViolationAt } : {}) }
}

export function detectWorktree(view: SessionView): PracticeResult {
  const facts = view.facts
  const mutating = view.calls.filter(isMutatingCall)
  if (mutating.length === 0) return result('worktree', 'n/a', ['no file mutations yet'])
  if (facts === undefined || !facts.gitAvailable) return result('worktree', 'amber', ['git facts unavailable'])
  if (!facts.inRepo) return result('worktree', 'n/a', ['cwd is not inside a git repository'])
  const onProtected = facts.branch !== undefined && view.protectedBranches.includes(facts.branch)
  if (facts.isWorktree === true) {
    return result('worktree', 'green', [`linked worktree on branch ${facts.branch ?? '(detached)'}`])
  }
  if (!onProtected && facts.branch !== undefined) {
    return result('worktree', 'green', [`primary checkout but on feature branch ${facts.branch}`])
  }
  if (facts.isWorktree === undefined) return result('worktree', 'amber', ['could not determine worktree state'])
  return result(
    'worktree',
    'red',
    [
      `${mutating.length} file mutation${mutating.length === 1 ? '' : 's'} on protected branch ${facts.branch ?? '(detached)'} in the primary checkout`,
      `first: ${mutating[0].name}${mutating[0].target !== undefined ? ` ${short(mutating[0].target)}` : ''}`,
    ],
    mutating[0].t,
  )
}

export function detectPullRequest(view: SessionView): PracticeResult {
  const facts = view.facts
  const created = view.calls.find(call => BASH_TOOLS.has(call.name) && !call.isError && isPrCreateCommand(call.target))
  const url = view.calls.map(call => findPrUrl(call.resultHead)).find((u): u is string => u !== undefined)
    ?? (created !== undefined ? findPrUrl(created.resultHead) : undefined)
  if (facts?.pr !== undefined) return result('pull-request', 'green', [`PR ${facts.pr.state.toLowerCase()}: ${facts.pr.url}`])
  if (url !== undefined) return result('pull-request', 'green', [`PR opened: ${short(url)}`])
  if (created !== undefined) return result('pull-request', 'green', ['PR creation command ran'])
  const mutating = view.calls.some(isMutatingCall)
  if (!mutating) return result('pull-request', 'n/a', ['no file mutations yet'])
  if (facts === undefined || !facts.gitAvailable) return result('pull-request', 'amber', ['git facts unavailable'])
  if (!facts.inRepo) return result('pull-request', 'n/a', ['cwd is not inside a git repository'])
  if (!facts.ghAvailable && facts.ahead === undefined) return result('pull-request', 'amber', ['no forge CLI (gh) and no upstream to compare against'])
  const ahead = facts.ahead ?? 0
  if (view.ended) {
    const problems: string[] = []
    if (ahead > 0) problems.push(`${ahead} commit${ahead === 1 ? '' : 's'} ahead of upstream with no PR`)
    if (facts.dirty === true) problems.push('uncommitted edits left in the working tree')
    if (problems.length > 0) return result('pull-request', 'red', problems, view.calls.find(isMutatingCall)?.t)
    if (facts.hasUpstream === false) return result('pull-request', 'red', ['branch was never pushed; no PR'], view.calls.find(isMutatingCall)?.t)
    return result('pull-request', 'amber', ['no PR detected; nothing ahead of upstream'])
  }
  if (ahead > 0) return result('pull-request', 'amber', [`${ahead} commit${ahead === 1 ? '' : 's'} ahead of upstream, no PR yet`])
  return result('pull-request', 'amber', ['work in progress; no PR yet'])
}

export function detectConductor(view: SessionView): PracticeResult {
  if (!view.teamAttached) return result('conductor', 'n/a', ['no team attached'])
  const selfEdits = view.calls.filter(isMutatingCall)
  const delegations = view.calls.filter(call => call.name === 'team_delegate' && !call.isError)
  const evidence: string[] = []
  let firstViolation: string | undefined
  if (selfEdits.length > 0) {
    evidence.push(`conductor mutated files itself ${selfEdits.length}×: ${selfEdits.slice(0, 3).map(c => `${c.name}${c.target !== undefined ? ` ${short(c.target, 60)}` : ''}`).join(', ')}`)
    firstViolation = selfEdits[0].t
  }
  // Approval rule: the first delegation must come in a turn AFTER the one in
  // which the conductor first spoke — i.e. the user had a chance to approve.
  // Applies unless the team's own instructions waive it.
  if (delegations.length > 0 && view.approvalRequired !== false) {
    const first = delegations[0]
    const firstUserTurn = view.userTurns[0] ?? 1
    if (first.turn <= firstUserTurn) {
      evidence.push(`first delegation in turn ${first.turn} without a prior approval turn`)
      firstViolation ??= first.t
    }
  }
  if (view.ended && delegations.length === 0 && view.calls.length > 0) {
    evidence.push('no delegation happened while a team was attached')
    firstViolation ??= view.calls[0].t
  }
  if (evidence.length > 0) return result('conductor', 'red', evidence, firstViolation)
  if (delegations.length === 0) return result('conductor', 'amber', ['team attached; no delegation yet'])
  return result('conductor', 'green', [`${delegations.length} delegation${delegations.length === 1 ? '' : 's'}, no self-edits`])
}

export function detectArtifactChain(view: SessionView): PracticeResult {
  const facts = view.facts
  if (facts === undefined || !facts.inRepo) return result('artifact-chain', 'n/a', ['not inside a git repository'])
  const have = facts.artifacts
  const has = (file: string): boolean => have.some(path => path.endsWith(`/${file}`) || path === file)
  const evidence = have.length > 0 ? [`present: ${have.join(', ')}`] : ['no stage artifacts found']
  const stage = view.activeStage
  if (stage === undefined) return result('artifact-chain', have.length > 0 ? 'green' : 'amber', evidence)
  const required: Record<string, string | undefined> = {
    plan: undefined,
    design: 'intent.md',
    build: 'plan.md',
    test: 'plan.md',
    deploy: undefined,
    maintain: undefined,
    cross: undefined,
  }
  const need = required[stage]
  if (need === undefined) return result('artifact-chain', have.length > 0 ? 'green' : 'amber', evidence)
  if (has(need)) return result('artifact-chain', 'green', evidence)
  return result('artifact-chain', 'red', [...evidence, `stage "${stage}" expects ${need} to be committed first`])
}

export function detectPlanBeforeCode(view: SessionView): PracticeResult {
  if (view.activeStage !== 'build') return result('plan-before-code', 'n/a', ['applies in the Build stage'])
  const facts = view.facts
  const first = view.calls.find(call => WRITE_TOOLS.has(call.name))
  if (first === undefined) return result('plan-before-code', 'n/a', ['no file edits yet'])
  if (facts === undefined || !facts.inRepo) return result('plan-before-code', 'n/a', ['not inside a git repository'])
  const hasPlan = facts.artifacts.some(path => path.endsWith('plan.md'))
  if (hasPlan) return result('plan-before-code', 'green', ['plan.md present before edits'])
  return result('plan-before-code', 'red', [`edited ${first.target !== undefined ? short(first.target) : 'a file'} with no plan.md in the repository`], first.t)
}

export function detectPlanDrift(view: SessionView): PracticeResult {
  if (view.activeStage !== 'build') return result('plan-drift', 'n/a', ['applies in the Build stage'])
  const hasPlan = view.facts?.artifacts.some(a => a.endsWith('plan.md')) === true
  if (!hasPlan) return result('plan-drift', 'n/a', ['no plan.md to drift from'])
  const drift = view.drift ?? []
  if (drift.length === 0) return result('plan-drift', 'green', ['every edit is named in plan.md'])
  if (view.planUpdated === true) return result('plan-drift', 'green', [`plan.md updated after ${drift.length} unplanned edit${drift.length === 1 ? '' : 's'}`])
  return result('plan-drift', 'amber', [`${drift.length} file${drift.length === 1 ? '' : 's'} not in plan.md: ${drift.slice(0, 3).map(d => d.path).join(', ')}`, 'update plan.md in the same branch, or say why'], drift[0].t)
}

export function detectWorktreeHygiene(view: SessionView): PracticeResult {
  const wt = view.worktrees
  if (wt === undefined || !(view.facts?.inRepo === true)) return result('worktree-hygiene', 'n/a', ['no worktree scan'])
  if (wt.total <= 1) return result('worktree-hygiene', 'green', ['no linked worktrees'])
  const evidence: string[] = []
  if (wt.removable > 0) evidence.push(`${wt.removable} merged worktree${wt.removable === 1 ? '' : 's'} still present`)
  if (wt.symlinked > 0) evidence.push(`${wt.symlinked} worktree${wt.symlinked === 1 ? '' : 's'} with a node_modules symlink`)
  if (wt.stale > 0) evidence.push(`${wt.stale} stale worktree${wt.stale === 1 ? '' : 's'}`)
  evidence.push(...wt.attention.slice(0, 2))
  if (wt.symlinked > 0) return result('worktree-hygiene', 'red', evidence)
  if (evidence.length > 0) return result('worktree-hygiene', 'amber', evidence)
  return result('worktree-hygiene', 'green', [`${wt.total - 1} linked worktree${wt.total === 2 ? '' : 's'}, all with live work`])
}

/** Every detector, in display order. */
/**
 * When a PR of this repo is merged, the local checkout must be brought level
 * BEFORE more work happens: pull, install, rebuild, sweep the merged worktree.
 * Otherwise the next edits are written against yesterday's code and the
 * running server keeps serving a stale build — which is exactly how two
 * "suspiciously fast build" incidents happened.
 *
 * Red when the remote default branch is ahead (a merge landed), or when a
 * pull happened and nothing was rebuilt afterwards. Green once the checkout
 * is level and the build is newer than the source.
 */
export function detectPostMergeSync(view: SessionView): PracticeResult {
  const facts = view.facts
  if (facts?.inRepo !== true) return { id: 'post-merge-sync', status: 'n/a', evidence: ['not a git repository'] }
  const synced = view.calls.filter(c => isSyncCommand(c.target)).length
  if (facts.behind === undefined) {
    return { id: 'post-merge-sync', status: 'n/a', evidence: ['no remote default branch to compare with'] }
  }
  if (facts.behind > 0) {
    return {
      id: 'post-merge-sync',
      status: 'red',
      evidence: [`origin/${facts.defaultBranch ?? 'main'} is ${facts.behind} commit${facts.behind === 1 ? '' : 's'} ahead of this checkout — a merge landed`, ...(synced > 0 ? ['a sync was run but the checkout is still behind; check its output'] : [])],
    }
  }
  if (facts.buildStale === true) {
    return { id: 'post-merge-sync', status: 'red', evidence: ['the checkout is level with the remote but lib/ is older than src/ — the build never ran after the pull'] }
  }
  return {
    id: 'post-merge-sync',
    status: 'green',
    evidence: [`level with origin/${facts.defaultBranch ?? 'main'}${facts.buildStale === false ? ', build is current' : ''}`],
  }
}

/** `dsh-skill-presets sync`, or the hand-rolled equivalent. */
function isSyncCommand(target: string | undefined): boolean {
  if (target === undefined) return false
  return /\bdsh-skill-presets\s+sync\b/u.test(target) || (/\bgit\s+pull\b/u.test(target) && /\bnpm\s+(?:ci|install)\b|\bnpm\s+run\s+build\b/u.test(target))
}

export const DETECTORS: Record<PracticeId, (view: SessionView) => PracticeResult> = {
  'worktree': detectWorktree,
  'pull-request': detectPullRequest,
  'conductor': detectConductor,
  'artifact-chain': detectArtifactChain,
  'plan-before-code': detectPlanBeforeCode,
  'plan-drift': detectPlanDrift,
  'worktree-hygiene': detectWorktreeHygiene,
  'post-merge-sync': detectPostMergeSync,
}

/** Run every enabled detector. */
export function evaluate(view: SessionView, enabled: readonly PracticeId[]): PracticeResult[] {
  return enabled.map(id => DETECTORS[id](view))
}

/** Worst status across results, for the header dot. */
export function worst(results: readonly PracticeResult[]): PracticeResult['status'] {
  const order: PracticeResult['status'][] = ['red', 'amber', 'green', 'n/a']
  for (const status of order) if (results.some(r => r.status === status)) return status
  return 'n/a'
}
