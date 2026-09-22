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
import { isDocsPath } from './plan.ts'
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

/**
 * Segment shapes that only READ. Matched against ONE segment, never the whole
 * command: see `isMutatingCommand` for why that distinction is the whole fix.
 */
const READONLY_SEGMENT = /^(?:git\s+(?:status|log|diff|show|branch(?:\s+--show-current|\s+-a|\s+-r|\s*$)|rev-parse|remote\s+-v|worktree\s+list)|ls|cat|head|tail|grep|rg|find|pwd|echo|which|node\s+-e|npm\s+(?:test|run\s+\w+|ls)|pnpm\s+(?:test|run\s+\w+))\b/u

/**
 * Commands whose NAME alone is a write, wherever they live on PATH.
 *
 * Membership is tested against the segment's NORMALISED leading token
 * (`parts[0].split('/').pop()`), never against raw segment text — see
 * `segmentWrites` for why that distinction is the whole of Issue #21.
 */
const MUTATING_TOOLS = new Set(['rm', 'mv', 'cp', 'mkdir', 'touch', 'tee'])

/**
 * Dependency managers and the subcommands of theirs that install or remove.
 *
 * Keyed BY TOOL for the same reason as `FILTER_WRITE_FLAGS`: `install` writes
 * under `npm` and `pip`, while `pnpm remove` and `npm uninstall` are the same
 * act spelled differently. The subcommand is the first non-flag argument left
 * once `packageSubcommand` has skipped the global flags that take a value, so
 * `npm --prefix /tmp install x` is still an install.
 *
 * Every ALIAS of an install has to be listed by name, because this is a
 * membership test and not a prefix match: `npm ci` rewrites `node_modules`
 * from the lockfile exactly as `npm install` does — it deletes the directory
 * first — yet it shares no letters with `install`. Same for `pnpm i` and
 * `bun i`. The read-only spellings (`ls`, `test`, `run <script>`) are absent by
 * construction, which is what keeps `npm run install-hooks` a read.
 *
 * MEMBERSHIP RULE: a subcommand belongs here when running it changes
 * DEPENDENCY STATE — the installed package set, a lockfile, a linked package —
 * or rewrites files already in the project. Not "touches the disk at all":
 * `cargo build` and `gem build` write, but only into build OUTPUT (`target/`,
 * a `.gem`), which is ignored by the tracked tree and is not what this
 * practice is asking about. Keeping build verbs out is also what stops this
 * table from classifying every compile as a mutation on the path that DENIES
 * tool calls.
 *
 * BY THAT RULE these are deliberately ABSENT, and each was considered:
 * - build/compile verbs: `cargo build`, `cargo test`, `gem build`,
 *   `poetry build`, `uv build` — output only.
 * - read verbs: `ls`, `list`, `search`, `info`, `show`, `outdated`, `why`,
 *   `view`, `freeze`, `licenses`, `audit`/`outdated` WITHOUT a fixing flag.
 * - SCAFFOLDING verbs (`npm init`, `cargo new`, `cargo init`, `poetry new`,
 *   `uv init`): they create a project rather than change one, and admitting
 *   them would need the same care as a build verb. Left out as ONE class, on
 *   purpose, so the omission is visible rather than accidental.
 *
 * TWO KNOWN BLIND SPOTS, both structural rather than missing entries — the
 * subcommand is not where the write is decided, so neither can be fixed by
 * adding a row here:
 * - a write hidden behind a FLAG: `npm audit fix` and `pip-audit --fix` write
 *   while bare `audit` does not, so listing `audit` would be a false positive
 *   on the DENY path.
 * - a NESTED subcommand: `uv pip install x` and `uv tool install x` write
 *   while `uv pip list` does not; `packageSubcommand` reads only the first
 *   token, so `pip`/`tool` are left out rather than admitted wholesale.
 */
const PACKAGE_WRITE_SUBS: Record<string, readonly string[]> = {
  npm: ['install', 'i', 'ci', 'add', 'uninstall', 'remove', 'rm', 'un', 'update', 'up', 'prune', 'dedupe', 'rebuild', 'link', 'unlink'],
  pnpm: ['add', 'install', 'i', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'prune', 'dedupe', 'link', 'unlink', 'import', 'patch', 'patch-commit', 'rebuild'],
  yarn: ['add', 'install', 'remove', 'up', 'upgrade', 'link', 'unlink', 'import'],
  // `bun` was in `PACKAGE_TOOLS` but had NO entry here, so every `bun add`
  // and `bun install` was read as a non-mutation — the same one-half-of-the-
  // file blindness recorded on `pip` below.
  bun: ['add', 'install', 'i', 'remove', 'rm', 'update', 'link', 'unlink', 'patch'],
  // `cargo install` puts a BINARY in the cargo home rather than in the working
  // tree. It is still a write, and this function answers "does this write" —
  // whether a LOCATION can be named is `attributesLocation`'s separate job,
  // and it already declines to place any `PACKAGE_TOOLS` command. `cargo fix`
  // is here for the opposite reason: it rewrites SOURCE FILES in place.
  cargo: ['add', 'remove', 'rm', 'install', 'uninstall', 'update', 'fix'],
  // `pip` and `pip3` are one tool under two names, and `PACKAGE_TOOLS` already
  // lists both — the regex this replaced knew only `pip`, which is the same
  // one-half-of-the-file blindness as `/bin/rm`.
  pip: ['install', 'uninstall', 'download'],
  pip3: ['install', 'uninstall', 'download'],
  gem: ['install', 'uninstall', 'update', 'cleanup', 'pristine'],
  composer: ['install', 'i', 'update', 'u', 'upgrade', 'require', 'remove', 'create-project', 'dump-autoload', 'dumpautoload'],
  poetry: ['add', 'install', 'remove', 'update', 'lock', 'sync'],
  uv: ['add', 'remove', 'sync', 'lock', 'venv', 'export'],
  bundle: ['install', 'i', 'update', 'add', 'remove', 'lock', 'binstubs', 'pristine', 'cache', 'package', 'clean'],
}

/**
 * Global flags of a package manager that swallow the NEXT token, so the
 * subcommand sits after their value rather than being the first non-flag
 * argument.
 *
 * THE SAME RULE AS `XARGS_VALUE_FLAGS` AND `GIT_GLOBAL_VALUE_FLAGS`: a flag
 * belongs here only when its argument is MANDATORY and SEPARATE. A boolean
 * flag consumes nothing and must stay out — `-g`, `--global`, `--silent`,
 * `--force`, `--save-dev`/`-D` are all boolean, and listing one would eat the
 * subcommand behind it (`npm -g install x` would read as no subcommand at
 * all). An ATTACHED value (`--prefix=/tmp`, `-C/tmp`) already consumes
 * nothing further, which is why the `=` form is excluded at the call site and
 * why membership is an EXACT token match.
 *
 * Keyed BY TOOL, and that is not decoration: `-w` takes a workspace NAME under
 * npm and is the BOOLEAN `--workspace-root` under pnpm. A pooled set would
 * make `pnpm -w add x` skip the `add`.
 *
 * WHY NOT just look for `install` anywhere in the segment: this function feeds
 * `decideWorktreeGate`, which DENIES a tool call, and `npm run install-hooks`
 * would then be reported as a mutation. Skipping by ARITY reaches the real
 * subcommand without ever reading a token out of position — exactly what
 * `vcsParts` already does for `git -C /wt commit`.
 *
 * ARITY IS THE ONLY QUESTION — NOT whether the tool calls the flag "global".
 * An earlier version of this set also demanded that a flag be accepted BEFORE
 * the subcommand, and dropped `gem --config-file`, `bundle --gemfile` and
 * `uv --python` because the installed binaries reject or ignore them in that
 * position (`gem --config-file f install` → "Invalid option";
 * `bundle --gemfile G install` → "called with arguments [install]";
 * `uv --python 3.11 tree` → "unexpected argument"). That rule was WRONG HERE,
 * and the reasoning is worth keeping because it looks right:
 * - This walk sees whatever tokens the CALLER actually wrote. It steps over a
 *   leading `--flag value` pair before the tool ever runs, so a flag the tool
 *   would only accept later still displaces the subcommand IN THIS PARSE.
 *   Refusing to list it leaves the value itself read as the subcommand — the
 *   precise false negative this whole mechanism exists to remove.
 * - Neither error direction costs anything. Listing a value-taking flag can
 *   only ever REVEAL the subcommand behind it; it cannot invent one, because
 *   the token it lands on still has to be in `PACKAGE_WRITE_SUBS`. And where
 *   the real tool errors out, the command writes nothing either way, so the
 *   verdict is unobservable rather than a false positive on a live session.
 * The asymmetry that DOES matter is unchanged: a BOOLEAN wrongly listed eats
 * the subcommand and silently turns a real write into a miss. So the bar to
 * add a flag is only "its value is mandatory and separate", and the bar to
 * leave one out is any doubt about that.
 */
const PACKAGE_GLOBAL_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['--prefix', '-C', '--workspace', '-w', '--userconfig', '--globalconfig', '--cache']),
  pnpm: new Set(['--dir', '-C', '--filter']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd']),
  // `-Z` is nightly-only and `-C` is unstable, but both take a mandatory
  // separate value when present, which is the only question this set asks.
  cargo: new Set(['--color', '--config', '--explain', '-Z', '-C', '--manifest-path', '--target']),
  // `-d` is composer's short `--working-dir`. Per-tool keying matters here for
  // the same reason as npm's `-w`: `-d` is a BOOLEAN in other tools.
  composer: new Set(['--working-dir', '-d']),
  poetry: new Set(['-C', '--directory', '-P', '--project']),
  // `-C` is gem's only flag accepted before the subcommand; `--config-file` is
  // a per-COMMAND option and gem rejects it there. Listed anyway, per the
  // arity rule above — it takes a mandatory separate value, so a caller who
  // writes it first would otherwise have `/tmp/f` read as the subcommand.
  gem: new Set(['-C', '--config-file']),
  uv: new Set(['--color', '--directory', '--project', '--config-file', '--allow-insecure-host', '--python']),
  // Bundler's pre-command globals are `--no-color`/`--verbose`, both BOOLEAN
  // and correctly absent. `--gemfile` and `--path` are per-command options
  // that take a mandatory separate value, listed for the same reason as gem's
  // `--config-file`. `--retry`/`--jobs` also take values but are omitted:
  // the short forms are ambiguous across bundler versions and an unverified
  // guess here is the one error that costs a missed write.
  bundle: new Set(['--gemfile', '--path']),
}

/**
 * The subcommand a package manager will run, past its value-taking global
 * flags — or undefined when the invocation names none (`npm` alone, or the
 * malformed `npm --prefix` whose value is missing, which npm itself rejects
 * without writing anything).
 */
function packageSubcommand(tool: string, args: readonly string[]): string | undefined {
  const valueFlags = PACKAGE_GLOBAL_VALUE_FLAGS[tool]
  let i = 0
  while (i < args.length) {
    const token = args[i]
    if (!token.startsWith('-') || token === '-') break
    if (token === '--') { i += 1; break }
    i += valueFlags?.has(token) === true ? 2 : 1
  }
  return args[i]
}

/** `git` subcommands that record history or rewrite the working tree. */
const GIT_MUTATING_SUBS = new Set([
  'add', 'commit', 'merge', 'rebase', 'reset', 'rm', 'mv', 'stash', 'apply',
  'cherry-pick', 'push',
])

/** Whether a `git` subcommand, already peeled past global flags, writes. */
function gitSubcommandWrites(sub: string, rest: readonly string[]): boolean {
  if (GIT_MUTATING_SUBS.has(sub)) return true
  // Only the branch-CREATING forms; a plain `checkout`/`switch` moves HEAD and
  // is classified by `writesWorkingTree` for the callers that care.
  if (sub === 'checkout') return rest.includes('-b')
  if (sub === 'switch') return rest.includes('-c')
  return false
}

/**
 * Whether a `sed` invocation edits a file rather than filtering stdin.
 *
 * Uses the SAME `SED_IN_PLACE_FLAGS` + `hasFlag` pair as the exclusion side, so
 * `--in-place`, `-i.bak`, `-ibak` and the clustered `-ni.bak` all land on one
 * verdict; the literal `sed\s+-i` this replaced saw only the first of those.
 *
 * `-f`/`--file` is deliberately NOT read as a write here even though
 * `FILTER_WRITE_FLAGS` lists it: there it means "the script is INVISIBLE, do
 * not suppress a report", which is the fail-closed direction. On THIS side a
 * verdict DENIES a tool call, so an unreadable script is not evidence of a
 * write — and its presence instead means the first positional argument is an
 * input file rather than the program, which is what `program` below encodes.
 */
function sedWrites(args: readonly string[]): boolean {
  if (args.some(a => SED_IN_PLACE_FLAGS.some(f => hasFlag(a, f)))) return true
  const scripts: string[] = []
  let fromFile = false
  let sawExpression = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (hasFlag(arg, '-f') || hasFlag(arg, '--file')) { fromFile = true; continue }
    if (arg === '-e' || arg === '--expression') {
      const value = args[i + 1]
      if (value !== undefined) { scripts.push(value); sawExpression = true; i += 1 }
      continue
    }
    if (arg.startsWith('--expression=') || (arg.startsWith('-e') && arg.length > 2)) {
      scripts.push(arg)
      sawExpression = true
    }
  }
  // With no `-e` and no `-f`, sed takes its PROGRAM from the first positional
  // argument; with either, every positional is an input FILE. Getting this
  // wrong is how `sed -f clean.sed w.ts` would read a filename as a program.
  if (!sawExpression && !fromFile) {
    const first = args.find(a => !a.startsWith('-'))
    if (first !== undefined) scripts.push(first)
  }
  return scripts.some(sedProgramWrites)
}

/**
 * Whether ONE segment's own command writes, judged from its NORMALISED name.
 *
 * THIS IS THE ISSUE #21 FIX. The regex this replaced matched RAW segment text,
 * while `vcsParts`, `attributesLocation`, `isReadOnlyFilter` and `xargsOperand`
 * all normalise with `parts[0].split('/').pop()` — so one half of this file
 * understood `/bin/rm -rf foo` and `git -C /wt commit` and the other half did
 * not, and the half that reports mutations was the blind one. Classifying from
 * the same normalised token everywhere closes that asymmetry, and it widens by
 * RECOGNISING a command already named as a writer, never by loosening an
 * anchor: `/bin/rm`, `/usr/bin/rm` and a bare `rm` are one command.
 *
 * It also makes `xargs /bin/rm` work for free — `xargsOperand` hands its
 * operand string back through `segmentMutates`, which arrives here.
 *
 * No `>`/`>>` test here: redirection is decided ONCE for the whole command by
 * `redirectsToFile`. Repeating it would re-admit `cmd; ls 2>/dev/null`, whose
 * redirection writes nothing. Segment splitting is QUOTE-AWARE upstream, which
 * is what keeps `gh issue comment -b "done; rm -rf tmp"` a single read-only
 * segment rather than a hidden `rm`.
 */
function segmentWrites(segment: string): boolean {
  const parts = tokens(segment)
  const lead = parts[0]?.split('/').pop()
  if (lead === undefined || lead.length === 0) return false
  if (MUTATING_TOOLS.has(lead)) return true
  if (lead === 'sed') return sedWrites(parts.slice(1))
  const packageSubs = PACKAGE_WRITE_SUBS[lead]
  if (packageSubs !== undefined) {
    // NOT `find(a => !a.startsWith('-'))`: that returns the VALUE of a global
    // flag, so `npm --prefix /tmp install x` classified `/tmp` as the
    // subcommand and never reached the `install`. `packageSubcommand` skips a
    // value-taking flag by arity, the way `vcsParts` does for `git -C /wt`.
    const sub = packageSubcommand(lead, parts.slice(1))
    return sub !== undefined && packageSubs.includes(sub)
  }
  // `vcsParts` already knows how to skip `-C /wt`, `-c k=v`, `--git-dir …` to
  // reach the real subcommand, so `git -C /wt commit` is seen as `git commit`
  // while `git -C /wt status` and `git -C /wt log` stay read-only.
  const vcs = vcsParts(segment)
  if (vcs?.tool !== 'git' || vcs.sub === undefined) return false
  return gitSubcommandWrites(vcs.sub, vcs.rest)
}

/**
 * `xargs` flags that consume the NEXT token as their value, so the token after
 * them is an argument and not the operand command.
 *
 * ONE RULE GOVERNS BOTH LISTS: a flag belongs here only when its argument is
 * MANDATORY and SEPARATE. A flag whose argument is OPTIONAL carries it
 * ATTACHED (`-i{}`, `--replace=X`), because that is the only spelling an
 * optional argument has — so a BARE occurrence consumes nothing and the very
 * next token is the operand command. Listing one of those swallows the
 * operand: `xargs --replace rm` would read as no command at all and the `rm`
 * would go unreported.
 *
 * So `-i`/`-e`/`-l` are OUT, and review found their GNU long forms
 * `--replace`/`--eof`/`--max-lines` had been left IN, contradicting this very
 * comment; they are now out too. `-0`, `-r`, `-t`, `-p`, `-x` take nothing.
 *
 * BSD/macOS `-J`, `-R` and `-S` are here because their arguments are
 * mandatory and separate (`-J %`, `-R 5`, `-S 4096`). Omitting them was worse
 * than a miss: `xargs -J rm echo` stopped at the flag's value and read
 * `rm echo` as the operand, reporting a read-only `echo` as a mutation on the
 * path that DENIES tool calls. Adding a flag here fixes a false positive and a
 * false negative at once — `xargs -J % rm %` now reports the `rm`.
 *
 * The long list omits `--null`, `--no-run-if-empty`, `--verbose`,
 * `--interactive` and `--exit` for the same reason as their short forms: they
 * take no argument.
 */
const XARGS_VALUE_FLAGS = new Set(['-a', '-d', '-E', '-I', '-J', '-L', '-n', '-P', '-R', '-s', '-S'])
const XARGS_LONG_VALUE_FLAGS = new Set([
  '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars',
  '--process-slot-var',
])

/**
 * The command `xargs` will RUN, or undefined when this segment is not an
 * `xargs` invocation (or names no operand, in which case xargs defaults to
 * `echo` and writes nothing).
 *
 * WHY: `xargs` is not a writer, it is a LAUNCHER — `git ls-files | xargs rm`
 * deletes every tracked file while the segment's leading token is `xargs`, so
 * an anchored mutation test sees nothing. `READONLY_FILTERS` already records
 * the mirror-image rule ("deliberately EXCLUDED … because it executes an
 * arbitrary command chosen by its operands"); that exclusion only stops xargs
 * from LAUNDERING a mutation, and this is the half that reports one.
 *
 * Quotes are stripped by `tokens`, so an operand that only exists inside a
 * quoted program (`xargs -I{} sh -c "rm -rf $1"`) is NOT reconstructed as a
 * command. That is deliberate: `sh`/`bash`/`node` are unclassifiable anyway,
 * and inventing a verdict from fragments of a quoted script would produce
 * false positives in a function that DENIES tool calls.
 */
function xargsOperand(segment: string): string | undefined {
  // The flag walk reads RAW tokens: `tokens()` strips quotes, and `-I""` then
  // collapses to a bare `-I` that swallows the following `rm` as its value —
  // `xargs -I"" rm` and `xargs -d"" rm` both reported no mutation at all
  // (Issue #21). An ATTACHED value, even an empty one, means the flag consumes
  // nothing more, and only the quote still says so. Quotes are stripped when
  // the operand is BUILT, below, so `tokens()`'s own contract is untouched.
  const parts = rawTokens(segment)
  if (stripQuotes(parts[0] ?? '').split('/').pop() !== 'xargs') return undefined
  let i = 1
  while (i < parts.length) {
    const token = parts[i]
    if (!token.startsWith('-') || token === '-') break
    if (token === '--') { i += 1; break }
    if (token.startsWith('--')) {
      i += !token.includes('=') && XARGS_LONG_VALUE_FLAGS.has(token) ? 2 : 1
      continue
    }
    // A short flag longer than two characters carries its value attached
    // (`-n1`, `-I{}`, `-d\n`, `-I""`), so it consumes nothing further.
    i += token.length === 2 && XARGS_VALUE_FLAGS.has(token) ? 2 : 1
  }
  const operand = parts.slice(i).map(stripQuotes).join(' ')
  return operand.length > 0 ? operand : undefined
}

/**
 * Whether ONE already-split segment writes.
 *
 * A read-only segment returns false for ITSELF only — the caller keeps
 * scanning. `depth` bounds the `xargs xargs …` unwrap; a pathological nest
 * simply stops being classified rather than looping.
 */
function segmentMutates(segment: string, depth = 0): boolean {
  if (READONLY_SEGMENT.test(segment)) return false
  const operand = xargsOperand(segment)
  if (operand !== undefined) return depth < 4 && segmentMutates(operand, depth + 1)
  return segmentWrites(segment)
}

/**
 * Whether a bash command plausibly mutates the working tree or repository.
 *
 * EVERY segment is scanned, the way `isVcsPlumbing` already scans them. The
 * previous version tested both regexes against the WHOLE trimmed command and
 * returned false the moment a READ-ONLY PREFIX matched, which handed the
 * verdict to the FIRST command in the chain: `git ls-files | xargs rm` and
 * `git log | sed -i.bak s/a/b/ x.ts` both deleted or rewrote files and both
 * reported nothing, because `git ls-files`/`git log` answered first (Issue
 * #19). A read-only segment is evidence about THAT segment and nothing else,
 * so it is now skipped rather than being an early exit for the whole command.
 *
 * Redirection is still decided ONCE, for the whole command, by
 * `redirectsToFile` — see the comment on `segmentWrites` for why the segment
 * test must not carry a raw `>` alternative of its own.
 *
 * THE INVARIANT THAT SETS THE ERROR BUDGET, and it points both ways:
 * - As a RULE this fails OPEN. `mutatesFiles` wraps it and `decideWorktreeGate`
 *   DENIES a tool call on the strength of it, so a false positive blocks a
 *   user's real session. An unrecognised shape is therefore left alone rather
 *   than guessed at — see the quoted-operand note on `xargsOperand`.
 * - As DETECTION it fails CLOSED. `isConductorSelfMutation` uses it to answer
 *   "did the conductor do a teammate's job?", and there a MISSED mutation is
 *   the expensive error: the report is simply never made, and nobody learns
 *   that the practice was silent. Anything that demonstrably writes — a later
 *   segment, an `xargs` operand — must be reported.
 * Where the two pull against each other, precision wins: widen by naming a
 * concrete writing command, never by loosening an anchor.
 */
export function isMutatingCommand(command: string | undefined): boolean {
  if (command === undefined) return false
  const c = command.trim()
  if (c.length === 0) return false
  // Output redirection mutates regardless of the command in front of it —
  // but only when it lands in a file.
  if (redirectsToFile(c)) return true
  return shellSegments(c).some(segment => segmentMutates(segment))
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

/**
 * Split a segment into tokens, honouring quotes but KEEPING them.
 *
 * Needed because a quote is sometimes the only remaining evidence of a token's
 * shape: `-I""` and `-I` are the same 2 characters once quotes are gone, yet
 * the first carries an (empty) attached value and consumes nothing while the
 * second swallows the next token. See `xargsOperand`.
 */
function rawTokens(segment: string): string[] {
  return segment.match(/(?:"[^"]*"|'[^']*'|\S)+/gu) ?? []
}

const stripQuotes = (token: string): string => token.replace(/["']/gu, '')

/** Split a segment into tokens, honouring quotes and stripping them. */
function tokens(segment: string): string[] {
  return rawTokens(segment).map(stripQuotes)
}

/** Version-control / forge CLIs whose history commands are the conductor's own job. */
const VCS_TOOLS = new Set(['git', 'gh', 'jj', 'glab'])

/** Global `git` flags that swallow the next token, so the subcommand is later. */
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** `git` subcommands that rewrite working-tree CONTENT rather than record history. */
const GIT_TREE_WRITERS = new Set(['restore', 'apply', 'am', 'revert', 'cherry-pick', 'merge', 'rebase', 'rm', 'mv', 'clean'])

/**
 * Commands that only READ their stdin and write nothing, so having one on the
 * receiving end of a pipe cannot turn a read into a mutation.
 *
 * Membership is decided by one question: can this command, by itself, create or
 * modify a file, or run a program that does? Every entry here writes to stdout
 * only. Deliberately EXCLUDED even though they are common pipe consumers:
 * - `xargs`, because it executes an arbitrary command chosen by its operands —
 *   `… | xargs rm` is exactly the mutation this practice exists to catch;
 * - `tee` and `dd` and `split`, whose entire purpose is writing files;
 * - `sh`/`bash`/`node`/`python`, which run arbitrary programs;
 * - `awk`, removed after review: it writes with NO shell operator and no flag
 *   to key on, through `system("touch o.txt")`, `print | "tee out.txt"`, and
 *   `printf > f` inside the program text, in a real language whose spellings
 *   cannot be enumerated by a regex. Recognising a safe `git log | awk
 *   '{print $1}'` is not worth a laundering path for an arbitrary command, so
 *   `awk` costs a false positive rather than a missed mutation;
 * - `less`, removed for the same reason: `less +'!rm -rf x'` runs a shell
 *   command from argv alone, and `less -o log` saves its input to a file.
 * `more`, `jq`, `column`, `strings`, `rev`, `nl` were re-audited and kept: none
 * of them can spawn a process or open a file for writing from their arguments
 * (`jq` only gained `--rawfile`/`--slurpfile`, which READ). `sed` stays, but
 * only survives the write checks below — it is the one member whose read-only
 * use is common enough to be worth parsing precisely.
 */
const READONLY_FILTERS = new Set([
  'tail', 'head', 'cat', 'grep', 'rg', 'egrep', 'fgrep', 'wc', 'sort', 'uniq',
  'tr', 'cut', 'more', 'nl', 'column', 'jq', 'sed', 'rev', 'strings',
])

/**
 * Flags that turn a specific read-only filter into a writer or an executor.
 *
 * Keyed BY COMMAND rather than pooled, because the same spelling means
 * opposite things per tool: `sed -i` edits the file in place, while `grep -i`
 * merely ignores case and `grep -o` prints only the match. A pooled list would
 * disqualify `git push | grep -i error` — re-introducing the very false
 * positive this change removes, just on a different flag.
 *
 * `sed -f` and `rg --pre` / `sort --compress-program` are here not because they
 * write, but because the file or program they name is INVISIBLE from the
 * command line: an external sed script may hold `w out.txt`, and a preprocessor
 * is an arbitrary executable.
 */
/**
 * The `sed` flags that edit the INPUT FILE rather than stdout — the one part of
 * `FILTER_WRITE_FLAGS.sed` that is positive evidence of a write.
 *
 * Named separately because BOTH sides of this file need it and they need
 * different amounts of it: the exclusion below also distrusts `-f`/`--file`
 * (an unreadable script must not suppress a report), while `sedWrites` may use
 * only these — see its comment. `FILTER_WRITE_FLAGS.sed` is composed from this
 * so the two can never drift into disagreeing about how `-i` is spelled.
 */
const SED_IN_PLACE_FLAGS = ['-i', '--in-place'] as const

const FILTER_WRITE_FLAGS: Record<string, readonly string[]> = {
  sed: [...SED_IN_PLACE_FLAGS, '-f', '--file'],
  sort: ['-o', '--output', '--compress-program'],
  uniq: ['-o'],
  rg: ['--pre', '--hostname-bin'],
}

/**
 * Whether a token invokes `flag`, including the spellings that attach a value.
 *
 * WHY: the first version of this test was `writeFlags.includes(t.split('=')[0])`,
 * which only matched a bare token or `--flag=value`. Review found three live
 * launderings of a real write past the exclusion — `sed -i.bak s/a/b/ src/x.ts`,
 * `sed -ibak …` and `sort -oout.txt` — because a SHORT flag carries its value
 * attached with no separator, and may be clustered behind other short flags
 * (`sed -ni.bak`). Do not simplify this back to an exact-token comparison.
 */
function hasFlag(token: string, flag: string): boolean {
  if (token === flag) return true
  if (flag.startsWith('--')) return token.startsWith(`${flag}=`)
  if (!token.startsWith('-') || token.startsWith('--')) return false
  // `-i.bak`, and `-ni.bak` where the letter hides in a short-flag cluster:
  // scan the leading run of letters, which is where a bundled flag can sit.
  const cluster = token.slice(1).match(/^[A-Za-z]*/u)?.[0] ?? ''
  return cluster.includes(flag.slice(1))
}

/**
 * Whether a quoted `sed` PROGRAM asks sed to write a file or run a command.
 *
 * `sed` creates files through its script, with no shell operator for the caller
 * to see, so the previous `/\/w\s+\S/u` test — which demanded a leading `/` and
 * whitespace — missed `sed -n 'w out.txt'`, `sed '1,5w out.txt'` and the POSIX
 * `sed 's/a/b/wout.txt'` spelling with no space. All three laundered a write.
 *
 * COVERED: `w`/`W` as a command at the start of the program, after `;`, `{`,
 * `}`, a newline or a `!`, or directly after a numeric / `$` / `/regex/`
 * address, with or without space before the filename; the `w` and `e` FLAGS of
 * `s///` for any delimiter; GNU `e` as a command.
 * KNOWINGLY NOT COVERED: a program assembled at runtime, one read from `-f`
 * (handled by FILTER_WRITE_FLAGS instead), and a filename supplied as a later
 * separate token. Deliberately NOT matched, to keep ordinary edits read-only:
 * a plain `sed 's/warn/W/'`, where the `w`/`W` is payload text rather than a
 * command — a preceding letter cannot introduce an address, so the regex
 * requires a command position.
 */
function sedProgramWrites(token: string): boolean {
  // `--expression=`/`-e` carry the program in the same token; drop the prefix
  // so the program is matched from its true start.
  const program = token.replace(/^(?:--expression=|-e)/u, '')
  const address = String.raw`(?:\d+(?:\s*,\s*(?:\d+|\$))?|\$|(?<![A-Za-z])\/(?:[^/\\]|\\.)*\/)`
  if (new RegExp(String.raw`(?:^|[;{}\n!]|${address})\s*!?\s*[wWe](?![A-Za-z])`, 'u').test(program)) return true
  // `s/a/b/w file`, `s|a|b|w file`, and the GNU `e` flag that shells out.
  return /s(.)(?:[^\\]|\\.)*?\1(?:[^\\]|\\.)*?\1[0-9gpiImM]*[wWe]/u.test(program)
}

/**
 * Whether a segment is a read-only consumer of piped input.
 *
 * WHY THIS EXISTS: `shellSegments` splits on `|` as well as `&&`/`;`, so a
 * command piped into a pager arrived here as two segments. The second one is
 * not a VCS invocation, which made `isVcsPlumbing` reject the WHOLE chain, and
 * the conductor practice then reported `git push … 2>&1 | tail -4` as
 * "conductor mutated files itself" while the unpiped `git push …` was fine. An
 * output pager writes NOTHING; appending one cannot change what a command did,
 * and a verdict that flips on the presence of `| tail` is reporting the pipe,
 * not the mutation. This is the same false-positive class as the `bash ls
 * 2>/dev/null` case recorded on `redirectsToFile`.
 *
 * Conservative by construction, and it must STAY that way: this is an override
 * that suppresses a report, so every uncertain case has to return false. A
 * miss costs a false positive that was already there; a wrong `true` LAUNDERS
 * a real mutation, which is the failure review caught in the first version.
 */
function isReadOnlyFilter(segment: string): boolean {
  const parts = tokens(segment)
  const lead = parts[0]?.split('/').pop()
  if (lead === undefined || !READONLY_FILTERS.has(lead)) return false
  const args = parts.slice(1)
  const writeFlags = FILTER_WRITE_FLAGS[lead] ?? []
  if (args.some(t => writeFlags.some(f => hasFlag(t, f)))) return false
  // `uniq <in> <out>` writes its SECOND operand — the one shape in this set
  // where a plain positional argument is an output file rather than an input.
  // `-` is the stdin OPERAND, not a flag: dropping it made `uniq - out.txt`
  // count as one operand and laundered the write.
  if (lead === 'uniq') {
    let operands = 0
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '-' || !arg.startsWith('-')) { operands += 1; continue }
      if (['-f', '-s', '-w'].includes(arg)) i += 1 // these consume a count
    }
    if (operands >= 2) return false
  }
  if (lead === 'sed' && args.some(sedProgramWrites)) return false
  // A `>` that survived tokenisation was QUOTED, which is exactly where
  // `redirectsToFile` blanks it out: a write through PROGRAM text, with no
  // shell operator for the caller to see.
  return !args.some(t => t.includes('>'))
}

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
 * plumbing. Two kinds of segment are tolerated alongside them, on the SAME
 * grounds — they write nothing, so they cannot change what the chain did:
 * - a bare `cd`/`set` prefix, which is how an agent reaches a linked worktree
 *   before committing in it;
 * - a read-only pipe consumer (`isReadOnlyFilter`), because `shellSegments`
 *   splits on `|` too, so `git push … 2>&1 | tail -4` arrived as a git segment
 *   plus a `tail` segment and the `tail` disqualified the whole chain. Piping
 *   a push into a pager was reported as the conductor mutating files while the
 *   identical unpiped push was not.
 * At least one VCS invocation is still REQUIRED (`sawVcs`): `ls | tail` writes
 * nothing either, but it is not plumbing, and letting it through would hand a
 * blanket exemption to any command ending in a pipe.
 *
 * The filter exclusion is an OVERRIDE that suppresses a report, so it fails
 * CLOSED by design. Review of the first version found `sed -i.bak`, `sort
 * -oout.txt`, `sed -n 'w out.txt'`, `uniq - out.txt` and `awk 'BEGIN{system(…)}'`
 * all laundered past it — the segment was skipped, the chain read as plumbing,
 * and a real conductor self-mutation went unreported. When extending
 * `READONLY_FILTERS`, the bar is that the command cannot write a file OR spawn
 * a process from its arguments; if that is uncertain, leave it out.
 *
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
    // Checked BEFORE `vcsParts` so a filter segment is skipped rather than
    // rejected, and AFTER `redirectsToFile` so `git log | tail > out.txt`
    // still fails: the pager wrote nothing, but the redirection did.
    if (isReadOnlyFilter(segment)) continue
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
 * Resolve a tool path to a canonical, always-absolute-looking form for
 * SEGMENT matching — not for filesystem access.
 *
 * `.` and empty segments are dropped and `..` pops, so
 * `docs/sdlc/../../src/a.ts` cannot wear an artifact prefix it climbed out of.
 * The result always starts with `/`, which lets a caller match a leading
 * directory with one pattern whether the tool named a relative or an absolute
 * path — both spellings occur: observed calls carry absolute paths, while a
 * hand-written test or a model's own call is routinely relative.
 */
function canonicalSegments(raw: string): string {
  const out: string[] = []
  for (const segment of raw.replace(/\\/gu, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { out.pop(); continue }
    out.push(segment)
  }
  return `/${out.join('/')}`
}

/**
 * A PROSE file inside some `docs/sdlc/` directory, at any depth.
 *
 * Both halves carry weight. `/docs/sdlc/` is anchored on segment boundaries, so
 * `mydocs/sdlc/x.ts` is not an artifact path. The markdown extension is what
 * keeps `src/docs/sdlc/thing.ts` a violation: a stage artifact is a document,
 * and a source file does not stop being a teammate's work by sitting under a
 * directory with the right name.
 */
const STAGE_ARTIFACT = /\/docs\/sdlc\/(?:[^/]+\/)*[^/]+\.mdx?$/u

/**
 * Whether a written path is a stage artifact the CONDUCTOR itself owns.
 *
 * WHAT IS EXEMPT: a markdown file under a `docs/sdlc/` directory — `intent.md`,
 * `spec.md`, `plan.md`, `deferred.md` and the rest of a phase directory. WHY:
 * the SDLC skills instruct the conductor to write exactly these, no teammate is
 * ever assigned that directory, and the practice asks "did the conductor do a
 * TEAMMATE's job?". Producing a required artifact is the conductor's own duty,
 * the same class as the git duties carved out below, and counting it made
 * `detectConductor` report red for a correctly conducted phase — every one of
 * Phase 9's ten reported "self-mutations" was a `docs/sdlc/**` write.
 *
 * WHERE THE LINE IS DRAWN, and why not wider:
 * - NOT `docs/` generally. Reference docs, READMEs and guides are ordinary
 *   deliverables a teammate can be assigned; only the SDLC paper trail is
 *   structurally the conductor's.
 * - NOT non-markdown files under the directory. A `.ts` in a path containing
 *   `docs/sdlc/` is code — `src/docs/sdlc/thing.ts` is a source write wearing
 *   an artifact-shaped prefix, and exempting it would hand away sensitivity for
 *   a directory name anyone can create.
 * - NOT scratch space (`/tmp`, `$TMPDIR`) even though a PR body drafted there
 *   is also conductor-owned. "Any path outside the repo" is a much larger
 *   exemption than the evidence demands, and this predicate suppresses a
 *   report, so it fails CLOSED by design — the same bar the `READONLY_FILTERS`
 *   note above sets. A PR body written to a temp file therefore still counts;
 *   that is a known, deliberate residual, not an oversight.
 * - NOT reachable from the bash branch at all. This is consulted ONLY for
 *   write-tool calls, so `sed -i` into `src/**`, a redirect into a source file,
 *   and a command touching an artifact AND a source path are all judged by the
 *   unchanged command classifiers. A path exemption that trusted a bash
 *   command's arguments would be exactly the laundering hole `isVcsPlumbing`
 *   was hardened against.
 *
 * A target that is not a string is NOT exempt: a write whose path cannot be
 * read is still a write. That covers `undefined` and, because an observed call
 * can be rebuilt from JSON that was cast to `ObservedCall` without validation,
 * a `null` or any other non-string a malformed record smuggles past the type.
 * The guard is on the TYPE rather than on `undefined` alone so the predicate
 * stays total: a bad record is counted as a self-mutation — failing CLOSED,
 * like every other carve-out here — instead of throwing out of
 * `canonicalSegments` and taking the whole scorecard down with the one call.
 */
export function isConductorArtifactPath(target: string | undefined): boolean {
  if (typeof target !== 'string') return false
  return STAGE_ARTIFACT.test(canonicalSegments(target))
}

/**
 * Whether a call is the conductor doing a TEAMMATE's job.
 *
 * Not the same question as `isMutatingCall`, in both directions: recording or
 * publishing history (`git commit`, `push`, `gh pr create`) is the conductor's
 * own duty and does not count, while rewriting working-tree content through
 * git (`git restore`, `git checkout -- path`) does count even where
 * `isMutatingCommand` does not list that subcommand.
 *
 * A write tool is judged by its PATH, not by its name: the conductor's own
 * stage artifacts are exempt (`isConductorArtifactPath`), every other path —
 * `src/**`, `test/**`, configuration, anything a teammate owns — still counts.
 */
export function isConductorSelfMutation(call: ObservedCall): boolean {
  if (isWriteTool(call.name)) return !isConductorArtifactPath(call.target)
  if (!isBashTool(call.name)) return false
  if (writesWorkingTreeViaVcs(call.target)) return true
  return isMutatingCommand(call.target) && !isVcsPlumbing(call.target)
}

export function detectConductor(view: SessionView): PracticeResult {
  if (!view.teamAttached) return result('conductor', 'n/a', ['no team attached'])
  // Committing, pushing, opening the PR and authoring the `docs/sdlc/**` stage
  // artifacts are the conductor's OWN duties in the team protocol, so they
  // cannot count as doing a teammate's job — even though `isMutatingCall`
  // rightly reports them as mutations elsewhere.
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
  // Documentation is not code: writing intent.md / README / notes is not the
  // thing the plan was supposed to precede. Judge the first SOURCE edit.
  const first = view.calls.find(call => isWriteTool(call.name) && (call.target === undefined || !isDocsPath(call.target)))
  if (first === undefined) return result('plan-before-code', 'n/a', ['no source edits yet'])
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
