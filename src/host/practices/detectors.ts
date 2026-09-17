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

import { dirname, isAbsolute, relative, resolve } from 'node:path'
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
  /**
   * The session's own working directory — where a RELATIVE tool path resolves.
   *
   * Not the work root: the work root is derived from what calls named, while
   * this is fixed at session creation. Both are needed to answer "did this
   * mutation land in the checkout the facts came from?", because
   * `edit src/x.ts` resolves against THIS directory no matter which worktree a
   * `cd` in some other call reached.
   */
  readonly cwd?: string
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

/**
 * Tool-name membership, matched on a NORMALISED name.
 *
 * Tool names arrive spelled differently depending on the path: the native
 * `tools/pre-execute` seam passes the harness's own name (`MultiEdit`), while
 * the hook bridge lowercases whatever the provider sent (`multiedit`). The
 * first version of these sets listed spellings by hand — `'multi_edit'`,
 * `'MultiEdit'`, `'notebook_edit'` — and the two paths then DISAGREED about
 * MultiEdit and notebook_edit: the native gate denied and the CLI allowed,
 * which is precisely the divergence `gate.ts` was written to eliminate,
 * surviving one layer down inside the fix.
 *
 * So normalisation happens in ONE place and the sets hold one canonical
 * spelling each: case is folded and `_` is dropped, which collapses
 * snake_case and camelCase onto the same key and makes a future
 * `notebook_edit`/`notebookEdit` pair impossible to get wrong. Adding a tool
 * means adding ONE entry, spelled lowercase and without separators.
 */
const normalizeTool = (name: string): string => name.toLowerCase().replace(/[_-]/gu, '')

const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit'])
const BASH_TOOLS = new Set(['bash', 'shell', 'terminal'])

/** Whether a tool name is a file-writing tool, in any spelling. */
export function isWriteTool(name: string | undefined): boolean {
  return name !== undefined && WRITE_TOOLS.has(normalizeTool(name))
}

/** Whether a tool name is a shell tool, in any spelling. */
export function isBashTool(name: string | undefined): boolean {
  return name !== undefined && BASH_TOOLS.has(normalizeTool(name))
}

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
 *
 * NECESSARY BUT NOT SUFFICIENT: naming a path is not the same as naming a path
 * in THIS checkout. `tiedToCheckout` adds the containment half; use that one
 * whenever a verdict is about a specific repository.
 */
export function attributesLocation(call: ObservedCall): boolean {
  if (isWriteTool(call.name)) return call.target !== undefined
  if (!isBashTool(call.name) || call.target === undefined) return false
  if (DIRECTORY_DIRECTIVE.test(call.target)) return true
  return !shellSegments(call.target).every((segment) => {
    const tool = tokens(segment)[0]?.split('/').pop()
    return tool !== undefined && PACKAGE_TOOLS.has(tool)
  })
}

/**
 * The directory a mutation actually landed in, when it can be worked out.
 *
 * A write/edit target is a filesystem path: absolute, it names its own
 * directory; relative, it resolves against the SESSION cwd, because that is
 * what the file tools resolve it against — a `cd` inside some bash call does
 * not move it. A bash mutation lands in that command's effective directory
 * (`cd`, `-C`, `--cwd`), falling back to the session cwd.
 *
 * Returns undefined when the call names no path at all, or when it is relative
 * and the session cwd is unknown: "I cannot tell" — never a guess.
 */
export function mutationLandedIn(call: ObservedCall, cwd: string | undefined): string | undefined {
  if (call.target === undefined) return undefined
  if (isWriteTool(call.name)) {
    if (isAbsolute(call.target)) return dirname(call.target)
    return cwd !== undefined ? dirname(resolve(cwd, call.target)) : undefined
  }
  if (!isBashTool(call.name)) return undefined
  return commandCwd(call.target, cwd) ?? cwd
}

/** Whether `dir` is `root` or lives underneath it. */
export function isInside(root: string, dir: string): boolean {
  const rel = relative(root, dir)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Whether a mutation is genuinely tied to the checkout the git facts describe.
 *
 * THE RULE: a mutation may be named as evidence about a checkout only when its
 * landing directory is KNOWN and lies inside that checkout's top level.
 *
 * Two independent gates, and both are needed:
 *
 * 1. `attributesLocation` — did the call name WHERE it wrote at all? `npm
 *    install left-pad` writes into a dependency directory and names no path,
 *    so it can never be evidence about a checkout.
 * 2. Containment — does the path it named actually land in THIS checkout?
 *    This is the hole PR #11 left open. A relative `edit src/x.ts` passes gate
 *    1 (it named a path) but says nothing about which checkout it landed in
 *    until it is resolved against the session cwd; once resolved it either
 *    lands under the root the facts were read from or it does not. An absolute
 *    write to `/other/repo/x.ts` passes gate 1 and fails here outright.
 *
 * Rejected alternative: "count relative writes when the session has exactly
 * one plausible root". That reasons about the session instead of the call, and
 * it still names a file it cannot place — the resolution above is not a
 * heuristic, it is what the filesystem tools literally do.
 *
 * The practice stays falsifiable: with `cwd` inside the primary checkout, a
 * relative write resolves INTO it and the red verdict still fires — which is
 * the real case the practice exists for.
 *
 * @param call - the mutating call being considered as evidence.
 * @param roots - the checkout's top level, plus its unresolved spelling when a
 *   symlink makes the two differ (see `GitFacts.topLevelAlias`). A path under
 *   EITHER is inside the checkout — they name one directory.
 * @param cwd - the session cwd, for resolving relative targets.
 */
export function tiedToCheckout(call: ObservedCall, roots: readonly (string | undefined)[], cwd: string | undefined): boolean {
  if (!attributesLocation(call)) return false
  const known = roots.filter((r): r is string => r !== undefined)
  if (known.length === 0) return false
  const landed = mutationLandedIn(call, cwd)
  return landed !== undefined && known.some(root => isInside(root, landed))
}

/**
 * Whether a tool NAME plus its target mutates files. The tool-shape-neutral
 * core of `isMutatingCall`.
 *
 * Split out because the `worktree` hard gate judges a call that has not run
 * yet, so it has a name and an argument but no `ObservedCall` (no timestamp,
 * no turn, no result). Both callers must agree on what "mutating" means — the
 * gate denying an edit the detector would not have counted, or the reverse, is
 * exactly the divergence `gate.ts` exists to remove — so the membership tests
 * live here once and every caller funnels through them.
 *
 * Tolerates an undefined name: a malformed payload is not a mutation.
 */
export function mutatesFiles(name: string | undefined, target: string | undefined): boolean {
  if (name === undefined) return false
  if (isWriteTool(name)) return true
  if (isBashTool(name)) return isMutatingCommand(target)
  return false
}

/** Whether a call mutates files (write/edit, or a mutating bash command). */
export function isMutatingCall(call: ObservedCall): boolean {
  return mutatesFiles(call.name, call.target)
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

/** Commands whose `-C <dir>` really means "run in this directory". */
const DASH_C_TOOLS = new Set(['git', 'jj', 'make', 'tar'])

const CD_TARGET = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u

function expand(path: string): string {
  return path.replace(/^~(?=\/|$)/u, process.env.HOME ?? '~')
}

/**
 * The directory a shell command actually runs in, from ANY segment.
 *
 * `npm ci && cd /wt && git commit` and `git -C /wt commit` both work in `/wt`,
 * not in the session cwd — reading only a LEADING `cd` was the root cause of
 * "file mutations on protected branch main in the primary checkout" while
 * every write landed in a linked worktree. The LAST directive wins, because
 * that is where the command ended up. Relative targets resolve against `cwd`.
 *
 * Lives here rather than in `workroot.ts` because it is pure command parsing
 * over `shellSegments`, and because the detectors need it to decide whether a
 * bash mutation landed inside the checkout being judged — and `detectors.ts`
 * may not import `workroot.ts`, which imports this module.
 */
export function commandCwd(command: string, cwd: string | undefined): string | undefined {
  let found: string | undefined
  for (const segment of shellSegments(command)) {
    const cd = segment.match(CD_TARGET)
    if (cd !== null) {
      found = expand(cd[1] ?? cd[2] ?? cd[3])
      continue
    }
    const parts = segment.match(/(?:"[^"]*"|'[^']*'|\S)+/gu) ?? []
    const tool = parts[0]?.replace(/["']/gu, '').split('/').pop()
    if (tool === undefined) continue
    for (let i = 1; i < parts.length; i += 1) {
      const token = parts[i].replace(/["']/gu, '')
      const inline = token.match(/^--(?:cwd|directory)=(.+)$/u)
      if (inline !== null) { found = expand(inline[1]); continue }
      const isFlag = token === '--cwd' || token === '--directory' || (token === '-C' && DASH_C_TOOLS.has(tool))
      if (!isFlag) continue
      const value = parts[i + 1]?.replace(/["']/gu, '')
      if (value !== undefined && !value.startsWith('-')) { found = expand(value); i += 1 }
    }
  }
  if (found === undefined) return undefined
  if (isAbsolute(found)) return found
  return cwd !== undefined ? resolve(cwd, found) : undefined
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

/**
 * Marks an `n/a` verdict that reports EXPOSURE rather than irrelevance.
 *
 * The client tells an at-risk `n/a` from a quiet one by testing this prefix on
 * the evidence, because `PracticeResult` carries no structural flag for it and
 * that type is frozen.
 *
 * THIS DECLARATION IS THE SOURCE OF TRUTH, and `atRiskEvidence` below builds
 * its line from it instead of repeating the literal — otherwise the coupling
 * merely moves from the reader to the writer.
 *
 * The browser half does NOT import this. It keeps its own copy in
 * `src/client/api.ts`, mirrored like every other host shape, because the
 * client bundle takes nothing from `src/host/` at runtime; a test asserts the
 * two literals are equal, so the mirror cannot drift silently. Do not
 * "simplify" that into a direct import: it would work — the bundler drops the
 * rest of this module, `node:path` included — right up until an unrelated
 * top-level side effect here leaked a Node builtin into a browser artifact,
 * and that failure would not announce itself.
 */
export const AT_RISK_PREFIX = 'at risk — '

/**
 * "Nothing judged yet" rendered as the same silent `n/a` as "nothing to
 * report" is how a panel tells a user everything is fine right up to the
 * moment their edit is denied.
 *
 * Status stays `n/a` — no violation HAS occurred, and claiming otherwise would
 * make the practice lie in the other direction. Only the evidence changes: it
 * names the exposure, so the state the gate is about to act on is visible
 * BEFORE the denial rather than explained after it.
 *
 * Subject to `refuseAssumedRoot` like every other fact-derived line here: when
 * no tool call ever named a path, these facts may describe a repository the
 * session never opened, and "the next edit will be denied" about the wrong
 * repository is precisely the confident-but-wrong claim that guard exists to
 * prevent. The caller applies the guard first.
 */
function atRiskEvidence(facts: GitFacts | undefined, protectedBranches: readonly string[]): string | undefined {
  if (facts === undefined || !facts.gitAvailable || !facts.inRepo) return undefined
  if (facts.isWorktree !== false) return undefined
  const branch = facts.branch
  if (branch === undefined || !protectedBranches.includes(branch)) return undefined
  return `${AT_RISK_PREFIX}on protected branch ${branch} in the primary checkout; the next edit will be denied`
}

export function detectWorktree(view: SessionView): PracticeResult {
  const facts = view.facts
  const mutating = view.calls.filter(isMutatingCall)
  if (mutating.length === 0) {
    // The assumed-root guard applies to the at-risk line too — it is a claim
    // about a specific checkout. Without it the verdict stays the plain,
    // truthful "nothing observed".
    const risk = view.workRootAssumed === true ? undefined : atRiskEvidence(facts, view.protectedBranches)
    return result('worktree', 'n/a', risk !== undefined ? ['no file mutations yet', risk] : ['no file mutations yet'])
  }
  if (facts === undefined || !facts.gitAvailable) return result('worktree', 'amber', ['git facts unavailable'])
  if (!facts.inRepo) return result('worktree', 'n/a', ['cwd is not inside a git repository'])
  // Branch, worktree-ness and checkout identity all come from the work root,
  // so an assumed root can produce a false green ("linked worktree") just as
  // easily as a false red. Both are refused. This asks whether ANY call pinned
  // the root the facts were read from; `tiedToCheckout` below then asks, per
  // mutation, whether THAT mutation landed inside it. Both must hold.
  const refusal = refuseAssumedRoot('worktree', view, 'where these mutations landed')
  if (refusal !== undefined) return refusal
  // Every verdict below names this checkout — green ("linked worktree") as
  // loudly as red — so it may only be stated about mutations that provably
  // landed in it. See `tiedToCheckout` for the rule and why.
  const tied = mutating.filter(call => tiedToCheckout(call, [facts.topLevel, facts.topLevelAlias], view.cwd))
  if (tied.length === 0) {
    const n = mutating.length
    return result('worktree', 'amber', [`${n} file mutation${n === 1 ? '' : 's'} that cannot be placed in ${facts.topLevel ?? 'this checkout'}; not judging where they landed`])
  }
  const onProtected = facts.branch !== undefined && view.protectedBranches.includes(facts.branch)
  if (facts.isWorktree === true) {
    return result('worktree', 'green', [`linked worktree on branch ${facts.branch ?? '(detached)'}`])
  }
  if (!onProtected && facts.branch !== undefined) {
    return result('worktree', 'green', [`primary checkout but on feature branch ${facts.branch}`])
  }
  if (facts.isWorktree === undefined) return result('worktree', 'amber', ['could not determine worktree state'])
  const skipped = mutating.length - tied.length
  return result(
    'worktree',
    'red',
    [
      `${tied.length} file mutation${tied.length === 1 ? '' : 's'} on protected branch ${facts.branch ?? '(detached)'} in the primary checkout`,
      `first: ${tied[0].name}${tied[0].target !== undefined ? ` ${short(tied[0].target)}` : ''}`,
      ...(skipped > 0 ? [`${skipped} further mutation${skipped === 1 ? '' : 's'} could not be placed in this checkout and are not counted`] : []),
    ],
    tied[0].t,
  )
}

export function detectPullRequest(view: SessionView): PracticeResult {
  const facts = view.facts
  const created = view.calls.find(call => isBashTool(call.name) && !call.isError && isPrCreateCommand(call.target))
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
  if (isWriteTool(call.name)) return true
  if (!isBashTool(call.name)) return false
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
  // Only ever reached with artifacts present: the empty case returns below.
  // Kept free of the old "no stage artifacts" phrasing so a future reorder
  // cannot resurrect an accusation about a repository that simply never
  // planned a phase.
  const evidence = [`present: ${have.join(', ')}`]
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
  const first = view.calls.find(call => isWriteTool(call.name))
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
