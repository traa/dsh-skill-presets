# Deferred — Phase 11

## D4: A command substitution inside a git command is not checked

**What.** `isConductorSelfMutation` does not look inside `$(...)` or backticks
when they are arguments to an allowed git command. These are all reported as
not a mutation, even though each one deletes a source file:

- `git commit -m "$(rm src/x.ts)"`
- `cd $(rm src/x.ts) && git commit -m x`
- `git log | tail $(rm src/x.ts)`: a read-only filter (`tail`, `head`,
  `grep`…) at the end of a pipe is skipped because of its first word, the same
  way `sleep` was. See `isReadOnlyFilter` and `READONLY_FILTERS`.
- `git push 2>&1 | grep $(rm src/x.ts)`

This was checked against the compiled build on `origin/main` (before Phase 11)
and on this branch. Both miss them. It is not a regression from Phase 11.

**What Phase 11 did fix.** Phase 11's D3 briefly added one more case of this:
`sleep $(rm src/x.ts) && git commit`. That was caught in review and fixed. A
segment that contains `$(`, a backtick, `<(` or `>(` is no longer skipped as a
harmless prefix. That fix covers `cd`, `set`, `sleep`, `true` and `:` segments
(the harmless prefixes), but not the arguments of the git command itself.

**Why not fixed here.** The simple fix is to count any git command that
contains a substitution as a mutation. That would also flag the common, safe
`git commit -m "$(cat msg.txt)"` and similar. Getting this right means parsing
what runs inside the substitution and applying the same read-only rules to it.
That is a separate design question, and too big to tack onto this PR.

**To close it.** In `isVcsPlumbing`, pull out every `$(...)` and backtick body
in a segment, and require each one to pass the same read-only check as a
top-level segment. Then `$(cat msg.txt)` and `$(date)` still pass, and
`$(rm x)` fails. Do the same for `isReadOnlyFilter`. The general rule: any
exemption that trusts a segment's first word must also check what runs inside
that segment's substitutions.

**Risk if left open.** Low. The conductor practice only reports; it does not
block anything. Hiding a deletion this way takes a deliberately unusual command.
But it is a real hole in a check that is supposed to fail closed.
