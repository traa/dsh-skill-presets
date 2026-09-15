/**
 * The single pure decision behind the `worktree` hard gate.
 *
 * WHY THIS MODULE EXISTS: the practice had two independent enforcement paths —
 * the CLI hook bridge (`src/bin/cli.ts check --hook`) and the native
 * `tools/pre-execute` gate (`src/host/index.ts`) — each with its OWN copy of
 * the condition. They disagreed. The CLI synthesised the pending call and
 * judged it before the write; the native gate read the retroactive tracker
 * verdict, which by construction can only describe mutations that ALREADY
 * happened, so the gate that mattered most never fired on the edit it was
 * supposed to stop. Two constructions of one rule is the bug, not an
 * implementation detail: this module is the rule, and both paths call it.
 *
 * DECIDED FROM INJECTED FACTS ONLY. No I/O, no async, no git. The caller
 * supplies the facts it already has, which is what lets the CLI (facts read
 * for a hook payload) and the host (facts memoized per session) reach the same
 * verdict from the same inputs, and what lets the whole rule be tested without
 * a repository.
 *
 * DEGRADES TO ALLOW. Every fault — malformed doc, absent facts, an exception
 * from anything below — answers `allow`. A guardrail that throws would block
 * unrelated work and be switched off wholesale within the hour, which costs
 * more than the violation it was trying to prevent.
 *
 * ONE EXCEPTION, AND IT RUNS THE OTHER WAY: a malformed EXEMPTION fails closed.
 * Doubt about whether a rule applies allows the call; doubt about whether
 * enforcement was deliberately switched off does not, because that doubt
 * resolves to "the gate is off" and an override nobody can account for is
 * indistinguishable from the gate being broken. See `exemptionLive`.
 * @module dsh-skill-presets/host/practices/gate
 */

import { basename } from 'node:path'
import type { GateDecision, PendingCall, PracticesDoc } from '../types.ts'
import type { GitFacts } from './git.ts'
import { mutatesFiles } from './detectors.ts'

/**
 * Whether an explicit, operator-granted exemption covers this repository now.
 *
 * Written by `dsh-skill-presets exempt worktree`. A gate with no legitimate
 * override is a gate the user disables wholesale the first time it is wrong,
 * so the sanctioned escape hatch is named in the deny message itself.
 *
 * ONE RECORD, TWO FIELDS, BOTH REQUIRED. `exemptRepos` and `exemptUntil` are
 * not alternative forms — they are the scope and the lifetime of a single
 * grant, and `exemptWorktree` has always written them as a pair. Treating them
 * as an independent OR (the first cut of this function did) produced two
 * failures that were worse than the hole this phase set out to close, because
 * in both the gate still LOOKED enforced:
 * - an expired grant kept working, since a matching repo returned early and
 *   the expiry was never consulted — "just this once" became permanent;
 * - a live grant for repo A disabled the gate in EVERY repository, since the
 *   repo check simply fell through to a future timestamp.
 *
 * FAIL-CLOSED ON A MALFORMED EXEMPTION, fail-open on malformed FACTS. These
 * are different axes and collapsing them is what caused the bug above. An
 * exemption is a claim that enforcement should stop, so anything doubtful
 * about it — no expiry, an unparseable expiry, no repository list, a checkout
 * whose top level cannot be determined — means NO exemption and the gate
 * applies as normal. Doubt about the git facts, by contrast, still allows the
 * call: see `decideWorktreeGate`.
 *
 * Both spellings of the top level are accepted, because
 * `git rev-parse --show-toplevel` resolves symlinks while the caller may reach
 * the same directory through one (`/tmp` → `/private/tmp` on macOS). Comparing
 * only one spelling would silently drop a grant the user did make.
 */
function exemptionLive(facts: GitFacts, doc: PracticesDoc, now: number): boolean {
  const repos = Array.isArray(doc.exemptRepos) ? doc.exemptRepos.filter(r => typeof r === 'string') : []
  // No fields at all: there is no exemption to evaluate. Reached on every
  // ordinary deny, so it must not be mistaken for a vacuously satisfied one.
  if (repos.length === 0 || typeof doc.exemptUntil !== 'string') return false
  const until = Date.parse(doc.exemptUntil)
  if (!Number.isFinite(until) || until <= now) return false
  return [facts.topLevel, facts.topLevelAlias].some(top => top !== undefined && repos.includes(top))
}

/**
 * The remedy naming the literal command that resolves the denial.
 *
 * `<slug>` stays a placeholder on purpose: only the agent knows what the work
 * is about, and a generated name would be worse than an obvious blank. The
 * repository name and the base branch are filled in, because those the plugin
 * does know and getting them wrong is how a suggested command fails silently.
 */
function remedyFor(facts: GitFacts): string {
  const repo = facts.topLevel !== undefined ? basename(facts.topLevel) : 'repo'
  const base = facts.defaultBranch ?? facts.branch ?? 'main'
  return `git worktree add ../${repo}-<slug> -b feat/<slug> origin/${base}`
}

/**
 * Decide whether one pending tool call may proceed under the `worktree`
 * practice.
 *
 * Denies if and only if ALL hold: the practice is in `hard` mode, the call
 * actually mutates, the cwd is in a repository, that checkout is the PRIMARY
 * one (not a linked worktree), the branch is known and protected, and no
 * exemption is live.
 *
 * TAKES THE DOC AS GIVEN. Only an explicit `mode: 'hard'` denies; this does not
 * apply defaults. `validatePractices` has already merged the shipped defaults
 * in for every real caller — including the `hard` default for a file that never
 * mentioned `worktree` — and a deliberate `advisory` survives that merge, so an
 * upgrade never silently starts denying a user who opted out.
 *
 * @param facts - git facts for the directory the call would write in.
 * @param pending - the tool call under evaluation, tool-shape-neutral.
 * @param doc - the practices document in force.
 * @param now - epoch ms used for exemption expiry; injected for testability.
 * @returns the decision; `allow: false` carries `reason` and `remedy`.
 */
export function decideWorktreeGate(facts: GitFacts, pending: PendingCall, doc: PracticesDoc, now: number = Date.now()): GateDecision {
  const allow: GateDecision = { allow: true, practice: 'worktree' }
  try {
    if (facts === undefined || facts === null || doc === undefined || doc === null || pending === undefined || pending === null) return allow
    const practices = Array.isArray(doc.practices) ? doc.practices : []
    // Only an explicit `hard` denies. An ABSENT entry allows here rather than
    // assuming the shipped default, because filling defaults is the store's
    // job, not the gate's: every real caller passes a doc that already went
    // through `validatePractices`, which substitutes the `hard` default for a
    // practice an existing file never mentioned. Re-deriving it here would put
    // the default in two places and let them drift — the exact failure this
    // module exists to eliminate — and would make a hand-built or truncated
    // doc deny, which violates degrade-to-allow.
    if (practices.find(p => p?.id === 'worktree')?.mode !== 'hard') return allow
    if (!mutatesFiles(pending.name, pending.filePath ?? pending.command)) return allow
    if (facts.inRepo !== true) return allow
    if (facts.isWorktree !== false) return allow
    const branch = facts.branch
    const protectedBranches = Array.isArray(doc.protectedBranches) ? doc.protectedBranches : []
    if (branch === undefined || !protectedBranches.includes(branch)) return allow
    if (exemptionLive(facts, doc, now)) return allow
    return {
      allow: false,
      practice: 'worktree',
      reason: `practice "Work in a worktree" is enforced: you are on protected branch ${branch} in the primary checkout, so this ${pending.name} is denied. Load the \`worktree-first\` skill and work in a linked worktree instead.`,
      remedy: remedyFor(facts),
    }
  } catch {
    // Unreachable by design; kept because the cost of a throwing gate is a
    // blocked session and the cost of this catch is nothing.
    return allow
  }
}

/**
 * The sanctioned override, appended to a deny message.
 *
 * Kept next to the decision so the escape hatch cannot drift out of sync with
 * the rule that makes it necessary.
 */
export function exemptionHint(): string {
  return 'If this repository genuinely must be edited directly, record it: dsh-skill-presets exempt worktree --hours 4 --reason "<why>".'
}
