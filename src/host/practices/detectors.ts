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
  /**
   * A call changed the set of worktrees and the cached scan has not caught up.
   * The summary above is then last-minute-old and must not be asserted as fact.
   */
  readonly worktreesStale?: boolean
  /**
   * `facts` describe a directory NO tool call ever named: the work root fell
   * back to the session cwd. That cwd is fixed at session creation and is
   * routinely a DIFFERENT repository from the one being worked in, so a
   * verdict about its contents is a guess wearing a uniform. Set by the
   * tracker from `attributedWorkRoot`; detectors that name a repository in
   * their verdict must degrade instead of asserting one.
   */
  readonly workRootAssumed?: boolean
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

/**
 * Redirection targets that are not files: a file descriptor (`2>&1`, `>&2`)
 * and the discard/console devices. Writing to any of these creates nothing, so
 * a command carrying only these redirections has written nothing.
 */
const NON_FILE_REDIRECT = /^(?:&\s*\d+|&-|\/dev\/(?:null|stderr|stdout|tty|fd\/\d+))$/u

/**
 * A redirection operator and the token it targets. The leading class rejects a
 * `<` (input) and a `>` already consumed by `>>`, and the optional `\d+|&`
 * absorbs the SOURCE descriptor of `2>`/`&>` so it is not mistaken for the
 * target. The `&\s*\d+` branch of the target keeps the `&` of `>&2`, which is
 * what tells a descriptor apart from a file called `2`.
 */
const REDIRECT = /(?:^|[^<>&\d])(?:\d+|&)?>{1,2}\s*(&\s*\d+|&-|"[^"]*"|'[^']*'|[^\s;&|<>]+)/gu

/**
 * Whether a command redirects output into a REAL FILE — the only redirection
 * that mutates anything.
 *
 * `2>/dev/null` is the common shape of a careful READ (`ls -la 2>/dev/null`,
 * `npm run build > /dev/null`), and counting it as a write made the conductor
 * practice report "conductor mutated files itself 1×: bash ls …" for a
 * directory listing and the worktree practice count it as a file mutation on a
 * protected branch. A file-descriptor target (`2>&1`, `>&2`) and a discard
 * device write nothing; `echo x > file.txt`, `cmd >> log.txt` and
 * `cmd 2> errors.log` still do.
 *
 * Quoted spans are blanked first so a `>` inside a commit message is not read
 * as an operator, and heredoc bodies are already dropped by `shellSegments`.
 */
export function redirectsToFile(command: string): boolean {
  const bare = command.replace(/"[^"]*"|'[^']*'/gu, q => ' '.repeat(q.length))
  for (const match of bare.matchAll(REDIRECT)) {
    const target = match[1].replace(/["']/gu, '')
    if (target.length > 0 && !NON_FILE_REDIRECT.test(target)) return true
  }
  return false
}

/** Whether a bash command plausibly mutates the working tree or repository. */
export function isMutatingCommand(command: string | undefined): boolean {
  if (command === undefined) return false
  const c = command.trim()
  if (c.length === 0) return false
  // Output redirection mutates regardless of the command in front of it —
  // but only when it lands in a file.
  if (redirectsToFile(c)) return true
  // Read-only prefixes.
  if (/^(?:git\s+(?:status|log|diff|show|branch(?:\s+--show-current|\s+-a|\s+-r|\s*$)|rev-parse|remote\s+-v|worktree\s+list)|ls|cat|head|tail|grep|rg|find|pwd|echo|which|node\s+-e|npm\s+(?:test|run\s+\w+|ls)|pnpm\s+(?:test|run\s+\w+))\b/u.test(c)) {
    return false
  }
  // No `>`/`>>` alternative here: redirection is decided once, above, by
  // `redirectsToFile`. Repeating it raw would re-admit `cmd; ls 2>/dev/null`.
  return /(?:^|[;&|]\s*)(?:git\s+(?:add|commit|checkout\s+-b|switch\s+-c|merge|rebase|reset|rm|mv|stash|apply|cherry-pick|push)|rm\b|mv\b|cp\b|mkdir\b|touch\b|sed\s+-i|tee\b|npm\s+(?:install|i|uninstall)|pnpm\s+(?:add|install|remove)|yarn\s+add|cargo\s+add|pip\s+install)/u.test(c)
}

/**
 * Dependency managers. Their operands are PACKAGE names, and they write into a
 * dependency directory rather than the tracked working tree, so they cannot
 * pin a mutation to a checkout.
 */
const PACKAGE_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'cargo', 'gem', 'composer', 'poetry', 'uv', 'bundle'])

const DIRECTORY_DIRECTIVE = /(?:^|[;&|]\s*)cd\s+\S|\s-C\s+\S|--cwd[=\s]\S|--directory[=\s]\S/u

/**
 * Whether a call names WHERE it wrote, so a verdict may state a location.
 *
 * Git facts are read from a derived work root; a call that names no path at
 * all is not evidence that the write happened there. Asserting
 * "on protected branch main in the primary checkout" from `npm install x` is
 * inventing attribution — the practice must say it does not know instead.
 */
export function attributesLocation(call: ObservedCall): boolean {
  if (WRITE_TOOLS.has(call.name)) return call.target !== undefined
  if (!BASH_TOOLS.has(call.name) || call.target === undefined) return false
  if (DIRECTORY_DIRECTIVE.test(call.target)) return true
  return !shellSegments(call.target).every((segment) => {
    const tool = tokens(segment)[0]?.split('/').pop()
    return tool !== undefined && PACKAGE_TOOLS.has(tool)
  })
}

/** Whether a call mutates files (write/edit, or a mutating bash command). */
export function isMutatingCall(call: ObservedCall): boolean {
  if (WRITE_TOOLS.has(call.name)) return true
  if (BASH_TOOLS.has(call.name)) return isMutatingCommand(call.target)
  return false
}

/**
 * Split a shell command into its top-level segments on `&&`, `||`, `;` and `|`.
 *
 * Quote-aware, because a commit message legitimately contains those characters
 * (`git commit -m "fix: a || b"` is ONE segment), and heredoc-aware: everything
 * from a `<<`/`<<-` operator onward is body text, not commands, so
 * `git commit -F - <<'EOF' …` must not be chopped up by whatever the message
 * happens to contain.
 */
export function shellSegments(command: string): string[] {
  const head = command.split(/<<-?\s*['"]?\w/u)[0]
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i]
    if (quote !== undefined) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === '\'') { quote = ch; current += ch; continue }
    const two = head.slice(i, i + 2)
    if (two === '&&' || two === '||') { out.push(current); current = ''; i += 1; continue }
    if (ch === ';' || ch === '|') { out.push(current); current = ''; continue }
    current += ch
  }
  out.push(current)
  return out.map(s => s.trim()).filter(s => s.length > 0)
}

/** Split a segment into tokens, honouring quotes and stripping them. */
function tokens(segment: string): string[] {
  const found = segment.match(/(?:"[^"]*"|'[^']*'|\S)+/gu) ?? []
  return found.map(t => t.replace(/["']/gu, ''))
}

/** Version-control / forge CLIs whose history commands are the conductor's own job. */
const VCS_TOOLS = new Set(['git', 'gh', 'jj', 'glab'])

/** Global `git` flags that swallow the next token, so the subcommand is later. */
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** `git` subcommands that rewrite working-tree CONTENT rather than record history. */
const GIT_TREE_WRITERS = new Set(['restore', 'apply', 'am', 'revert', 'cherry-pick', 'merge', 'rebase', 'rm', 'mv', 'clean'])

/** Peel a VCS invocation into tool, subcommand and remaining arguments. */
function vcsParts(segment: string): { tool: string, sub?: string, rest: string[] } | undefined {
  const parts = tokens(segment)
  if (parts.length === 0) return undefined
  const tool = parts[0].split('/').pop() ?? parts[0]
  if (!VCS_TOOLS.has(tool)) return undefined
  let i = 1
  while (i < parts.length && parts[i].startsWith('-')) {
    const flag = parts[i].split('=')[0]
    i += GIT_GLOBAL_VALUE_FLAGS.has(flag) && !parts[i].includes('=') ? 2 : 1
  }
  const sub = parts[i]
  return { tool, ...(sub !== undefined ? { sub } : {}), rest: parts.slice(i + 1) }
}

/** Whether a `git` subcommand changes files in the working tree. */
function writesWorkingTree(sub: string, rest: readonly string[]): boolean {
  if (GIT_TREE_WRITERS.has(sub)) return true
  if (sub === 'reset') return rest.some(a => a === '--hard' || a === '--merge' || a === '--keep')
  if (sub === 'stash') {
    const first = rest.find(a => !a.startsWith('-'))
    return first === undefined || !['list', 'show', 'drop', 'clear', 'create'].includes(first)
  }
  if (sub === 'checkout') {
    // `git checkout <branch>` moves HEAD (plumbing, same as `switch`);
    // `git checkout -- <path>` / `-p` / `checkout <file.ts>` OVERWRITES files.
    if (rest.includes('--') || rest.includes('-p') || rest.includes('--patch')) return true
    const first = rest.find(a => !a.startsWith('-'))
    return first !== undefined && (first === '.' || first.startsWith('./') || first.startsWith('/') || /\.\w+$/u.test(first))
  }
  return false
}

/**
 * Whether a shell command is pure version-control / publishing plumbing.
 *
 * Committing, pushing and opening a PR are EXPLICITLY the conductor's job in
 * the team protocol, yet `isMutatingCommand` classifies them as mutating —
 * correctly, for the worktree and pull-request practices, which must count a
 * `git`-driven write. Only the conductor practice ("did it do a teammate's
 * job?") needs to look past them, so the exclusion lives here rather than in
 * the mutation classifier.
 *
 * Every segment must be a VCS invocation: `rm -rf x && git commit` is not
 * plumbing. A bare `cd`/`set` prefix is allowed because it writes nothing and
 * is how an agent reaches a linked worktree before committing in it.
 * Subcommands that rewrite working-tree CONTENT (`git restore`, `git apply`,
 * `git checkout -- path`, `stash pop`, `revert`, `cherry-pick`, `merge`,
 * `rebase`) are NOT plumbing — those are edits by another name.
 */
export function isVcsPlumbing(target: string | undefined): boolean {
  if (target === undefined) return false
  const segments = shellSegments(target)
  if (segments.length === 0) return false
  let sawVcs = false
  for (const segment of segments) {
    // A redirection writes a file whatever sits in front of it — same rule as
    // `isMutatingCommand`, so `git log 2>/dev/null` stays plumbing while
    // `git log > out.txt` does not.
    if (redirectsToFile(segment)) return false
    const lead = tokens(segment)[0]?.split('/').pop()
    if (lead === 'cd' || lead === 'set') continue
    const parts = vcsParts(segment)
    if (parts === undefined) return false
    sawVcs = true
    if (parts.tool !== 'git' || parts.sub === undefined) continue
    if (writesWorkingTree(parts.sub, parts.rest)) return false
  }
  return sawVcs
}

/**
 * Whether a command rewrites working-tree content through a VCS subcommand.
 *
 * The complement of `isVcsPlumbing`, and NOT simply its negation: it answers
 * positively, so a caller can spot `git restore src/a.ts` even though
 * `isMutatingCommand` — which lists only some write-y subcommands — does not
 * classify it as a mutation. Needed because the conductor practice must catch
 * a teammate's job done through git as readily as through an editor tool.
 */
export function writesWorkingTreeViaVcs(target: string | undefined): boolean {
  if (target === undefined) return false
  return shellSegments(target).some((segment) => {
    const parts = vcsParts(segment)
    return parts?.tool === 'git' && parts.sub !== undefined && writesWorkingTree(parts.sub, parts.rest)
  })
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

/**
 * Refuse to state a verdict about a repository nobody worked in.
 *
 * `facts` are read from the work root, which FALLS BACK to the session cwd
 * when no tool call ever named a path. That cwd is fixed at session creation
 * and is routinely a DIFFERENT checkout from the one being worked in: a live
 * session reported "N commits ahead with no PR" and "no plan.md in the
 * repository" about a project it had never opened, which is how a panel
 * teaches its user to ignore it.
 *
 * Only the tracker can tell the two apart, because only it knows the session
 * cwd — and a detector cannot recompute it, since `workroot.ts` imports THIS
 * module and the dependency may not run back the other way. So the tracker
 * passes the single flag `workRootAssumed` and every fact-reading detector
 * consults it here. One guard rather than one `if` per detector: the rule is
 * stated once, the wording of the refusal cannot drift, and a new fact-reading
 * practice has an obvious place to opt in.
 *
 * Deliberately NOT applied to verdicts derived from the observed CALLS alone
 * (a `gh pr create` that ran, a worktree scan invalidated by a sweep, files
 * edited outside plan.md): those stay true no matter which directory the facts
 * came from, so each detector answers them ABOVE this guard.
 *
 * @param id - the practice that would otherwise speak.
 * @param view - the session view, for the flag and for the root being refused.
 * @param claim - what is not being asserted, named in the evidence.
 * @returns the `n/a` result to return, or undefined when facts are trustworthy.
 */
export function refuseAssumedRoot(id: PracticeId, view: SessionView, claim: string): PracticeResult | undefined {
  if (view.workRootAssumed !== true) return undefined
  return result(id, 'n/a', [`no tool call named a path; not judging ${claim} in ${view.facts?.topLevel ?? 'the session directory'}`])
}

export function detectWorktree(view: SessionView): PracticeResult {
  const facts = view.facts
  const mutating = view.calls.filter(isMutatingCall)
  if (mutating.length === 0) return result('worktree', 'n/a', ['no file mutations yet'])
  if (facts === undefined || !facts.gitAvailable) return result('worktree', 'amber', ['git facts unavailable'])
  if (!facts.inRepo) return result('worktree', 'n/a', ['cwd is not inside a git repository'])
  // Branch, worktree-ness and checkout identity all come from the work root,
  // so an assumed root can produce a false green ("linked worktree") just as
  // easily as a false red. Both are refused. This is the stronger sibling of
  // the `attributesLocation` gate below: that one asks whether a MUTATION
  // named a path, this asks whether ANY call pinned the root the facts were
  // read from. They can disagree — a relative `edit src/x.ts` attributes a
  // location but names no root — and when they do, this one wins, because a
  // relative path says nothing about WHICH checkout it landed in.
  const refusal = refuseAssumedRoot('worktree', view, 'where these mutations landed')
  if (refusal !== undefined) return refusal
  const onProtected = facts.branch !== undefined && view.protectedBranches.includes(facts.branch)
  if (facts.isWorktree === true) {
    return result('worktree', 'green', [`linked worktree on branch ${facts.branch ?? '(detached)'}`])
  }
  if (!onProtected && facts.branch !== undefined) {
    return result('worktree', 'green', [`primary checkout but on feature branch ${facts.branch}`])
  }
  if (facts.isWorktree === undefined) return result('worktree', 'amber', ['could not determine worktree state'])
  // Only mutations that name where they landed can carry a location claim.
  const attributed = mutating.filter(attributesLocation)
  if (attributed.length === 0) {
    return result('worktree', 'amber', [`${mutating.length} file mutation${mutating.length === 1 ? '' : 's'} that name no path; cannot tie them to a checkout`])
  }
  return result(
    'worktree',
    'red',
    [
      `${attributed.length} file mutation${attributed.length === 1 ? '' : 's'} on protected branch ${facts.branch ?? '(detached)'} in the primary checkout`,
      `first: ${attributed[0].name}${attributed[0].target !== undefined ? ` ${short(attributed[0].target)}` : ''}`,
    ],
    attributed[0].t,
  )
}

export function detectPullRequest(view: SessionView): PracticeResult {
  const facts = view.facts
  const created = view.calls.find(call => BASH_TOOLS.has(call.name) && !call.isError && isPrCreateCommand(call.target))
  const url = view.calls.map(call => findPrUrl(call.resultHead)).find((u): u is string => u !== undefined)
    ?? (created !== undefined ? findPrUrl(created.resultHead) : undefined)
  // Call-derived evidence first, and it outranks `facts.pr`: a PR URL this
  // session printed, or a create command it ran, happened wherever the agent
  // was working, so it survives an assumed root. `facts.pr` is read from the
  // work root and does not.
  if (url !== undefined) return result('pull-request', 'green', [`PR opened: ${short(url)}`])
  if (created !== undefined) return result('pull-request', 'green', ['PR creation command ran'])
  const refusal = refuseAssumedRoot('pull-request', view, 'the branch/PR state')
  if (refusal !== undefined) return refusal
  if (facts?.pr !== undefined) return result('pull-request', 'green', [`PR ${facts.pr.state.toLowerCase()}: ${facts.pr.url}`])
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

/**
 * Whether a call is the conductor doing a TEAMMATE's job.
 *
 * Not the same question as `isMutatingCall`, in both directions: recording or
 * publishing history (`git commit`, `push`, `gh pr create`) is the conductor's
 * own duty and does not count, while rewriting working-tree content through
 * git (`git restore`, `git checkout -- path`) does count even where
 * `isMutatingCommand` does not list that subcommand.
 */
export function isConductorSelfMutation(call: ObservedCall): boolean {
  if (WRITE_TOOLS.has(call.name)) return true
  if (!BASH_TOOLS.has(call.name)) return false
  if (writesWorkingTreeViaVcs(call.target)) return true
  return isMutatingCommand(call.target) && !isVcsPlumbing(call.target)
}

export function detectConductor(view: SessionView): PracticeResult {
  if (!view.teamAttached) return result('conductor', 'n/a', ['no team attached'])
  // Committing, pushing and opening the PR are the conductor's OWN duties in
  // the team protocol, so they cannot count as doing a teammate's job — even
  // though `isMutatingCall` rightly reports them as mutations elsewhere.
  const selfEdits = view.calls.filter(call => isConductorSelfMutation(call))
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

/**
 * Whether the SDLC paper trail is intact for the active stage.
 *
 * Two rules keep this honest, both learned from false reds that trained the
 * user to ignore the panel:
 *
 * 1. The verdict describes a SPECIFIC repository, so it may only be stated
 *    when a tool call actually named that repository — see
 *    `refuseAssumedRoot`, the rule every fact-reading practice shares.
 * 2. Red means a chain that was STARTED AND DROPPED, never merely absent. A
 *    one-file bugfix reported from a screenshot is legitimate work with no
 *    planned phase behind it; demanding plan.md from it is noise. So red
 *    needs evidence of a phase in flight — some artifact present — with the
 *    stage's next artifact missing.
 */
export function detectArtifactChain(view: SessionView): PracticeResult {
  const facts = view.facts
  if (facts === undefined || !facts.inRepo) return result('artifact-chain', 'n/a', ['not inside a git repository'])
  // Rule 1: an assumed root means these artifacts belong to whatever repo the
  // session happened to start in, which is not evidence about the work.
  const refusal = refuseAssumedRoot('artifact-chain', view, 'the artifact chain')
  if (refusal !== undefined) return refusal
  const have = facts.artifacts
  const has = (file: string): boolean => have.some(path => path.endsWith(`/${file}`) || path === file)
  const evidence = have.length > 0 ? [`present: ${have.join(', ')}`] : ['no stage artifacts in this repository']
  // Rule 2: nothing committed anywhere means no phase was ever planned here.
  if (have.length === 0) return result('artifact-chain', 'n/a', ['no planned phase in this repository; artifact chain not applicable'])
  const stage = view.activeStage
  if (stage === undefined) return result('artifact-chain', 'green', evidence)
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
  if (need === undefined) return result('artifact-chain', 'green', evidence)
  if (has(need)) return result('artifact-chain', 'green', evidence)
  return result('artifact-chain', 'red', [...evidence, `stage "${stage}" expects ${need} to be committed first`])
}

export function detectPlanBeforeCode(view: SessionView): PracticeResult {
  if (view.activeStage !== 'build') return result('plan-before-code', 'n/a', ['applies in the Build stage'])
  const facts = view.facts
  const first = view.calls.find(call => WRITE_TOOLS.has(call.name))
  if (first === undefined) return result('plan-before-code', 'n/a', ['no file edits yet'])
  if (facts === undefined || !facts.inRepo) return result('plan-before-code', 'n/a', ['not inside a git repository'])
  // "no plan.md in the repository" names a repository, and `facts.artifacts`
  // were listed in the work root. Under an assumed root this was the worst
  // offender of all: a confident mid-session red about a checkout the agent
  // never opened, while the plan it was following sat in the one it did.
  const refusal = refuseAssumedRoot('plan-before-code', view, 'whether a plan.md exists')
  if (refusal !== undefined) return refusal
  const hasPlan = facts.artifacts.some(path => path.endsWith('plan.md'))
  if (hasPlan) return result('plan-before-code', 'green', ['plan.md present before edits'])
  return result('plan-before-code', 'red', [`edited ${first.target !== undefined ? short(first.target) : 'a file'} with no plan.md in the repository`], first.t)
}

/** First-seen-order unique paths, so a repeatedly edited file counts once. */
function dedupeByPath(entries: readonly { path: string, t: string }[]): { path: string, t: string }[] {
  const seen = new Set<string>()
  const out: { path: string, t: string }[] = []
  for (const entry of entries) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    out.push(entry)
  }
  return out
}

export function detectPlanDrift(view: SessionView): PracticeResult {
  if (view.activeStage !== 'build') return result('plan-drift', 'n/a', ['applies in the Build stage'])
  const hasPlan = view.facts?.artifacts.some(a => a.endsWith('plan.md')) === true
  if (!hasPlan) return result('plan-drift', 'n/a', ['no plan.md to drift from'])
  // One entry is recorded per EDIT, so a file edited three times appears three
  // times. The practice judges drifting FILES, so count distinct paths —
  // otherwise one file reads as three and the evidence lists it three times.
  const drift = dedupeByPath(view.drift ?? [])
  if (drift.length === 0) return result('plan-drift', 'green', ['every edit is named in plan.md'])
  if (view.planUpdated === true) return result('plan-drift', 'green', [`plan.md updated after ${drift.length} unplanned edit${drift.length === 1 ? '' : 's'}`])
  // Raw evidence is persisted to telemetry and the scorecard, not only
  // rendered into the prompt, so the cap has to happen here as well.
  return result('plan-drift', 'amber', [`${drift.length} file${drift.length === 1 ? '' : 's'} not in plan.md: ${short(drift.slice(0, 3).map(d => d.path).join(', '))}`, 'update plan.md in the same branch, or say why'], drift[0].t)
}

export function detectWorktreeHygiene(view: SessionView): PracticeResult {
  const wt = view.worktrees
  // A sweep or an add invalidates the cached scan. Reporting the old numbers
  // then asserts a worktree that no longer exists ("1 merged worktree still
  // present" right after it was removed), which is worse than saying nothing.
  if (view.worktreesStale === true) return result('worktree-hygiene', 'n/a', ['worktree state changed; rescanning'])
  if (wt === undefined || !(view.facts?.inRepo === true)) return result('worktree-hygiene', 'n/a', ['no worktree scan'])
  // The scan was taken OF the work root's repository. Under an assumed root
  // those are somebody else's worktrees, and "N merged worktrees still
  // present" sends the agent sweeping a checkout it never worked in.
  const refusal = refuseAssumedRoot('worktree-hygiene', view, 'the worktrees')
  if (refusal !== undefined) return refusal
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
  // `behind`, `defaultBranch` and `buildStale` are all read from the work
  // root, and the verdict names the remote it compared against. Under an
  // assumed root it announced that a merge had landed in a repository nobody
  // had touched, and sent the agent to pull it.
  const refusal = refuseAssumedRoot('post-merge-sync', view, 'how far behind the checkout is')
  if (refusal !== undefined) return refusal
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
