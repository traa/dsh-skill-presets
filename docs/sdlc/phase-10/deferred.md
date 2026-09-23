# Deferred — Phase 10

> **Status:** D1 and D2 were both closed in Phase 11 (PR #29). A related, older
> gap found during that review is recorded in `docs/sdlc/phase-11/deferred.md`.

## D1 — A PR body drafted to `/tmp` still counts as a self-mutation

**What.** `isConductorArtifactPath` exempts only markdown files under a
`docs/sdlc/` directory. A conductor that writes its PR body to a scratch file
(`/tmp/pr-body.md`) and passes it to `gh pr create --body-file` is still
reported as "conductor mutated files itself".

**Why not fixed.** Writing the PR body is conductor work, and the user has said
so. But exempting it means exempting scratch space: `/tmp`, `$TMPDIR`, or "any
path outside the repo". That is a much bigger exemption than the evidence
supports, and because this predicate suppresses a report, it is designed to
fail closed. The implementer drew the line narrow and documented it in the
`isConductorArtifactPath` docstring (`src/host/practices/detectors.ts`), so no
one "fixes" it back by accident.

**Workaround in use.** Pass the body inline (`gh pr create --body "…"`) instead
of through a file. There is no file write, so there is nothing to flag.

**To close it, if wanted.** Exempt a scratch path only when the same session
then passes it as `--body-file` to `gh pr create`. That ties the exemption to
the purpose rather than the location. It needs the detector to link two calls,
which it does not do today.

## D2: Other detector predicates throw when `target` is not a string

**What.** In review round 1, `isConductorArtifactPath` was changed to guard
with `typeof target !== 'string'` instead of `=== undefined`. Before that, a
`null` target threw `TypeError: Cannot read properties of null (reading
'replace')` and took down the whole practice scorecard, not just that one
call. That was verified by running the old code. Several other predicates in
`src/host/practices/detectors.ts` still check only `=== undefined`:

- `isVcsPlumbing` (~line 1029)
- `writesWorkingTreeViaVcs` (~line 1063)
- `isSyncCommand` (~line 1541)
- the call-level checks at ~lines 592 and 613, and the docs-path filter at ~1433

**How a non-string gets in.** Not from the live session log. `src/host/index.ts`
(~line 422, the `tools/result` handler) and `src/host/hooks.ts`
(`parseHookStdin`) both build `target` from a series of `typeof … === 'string'`
checks, so a live call's target is a string or undefined. The way in is **eval
fixture replay**: `src/host/evals.ts` (~line 144) loads fixtures with
`JSON.parse(…) as Fixture`, a cast that checks nothing. `replay()` then passes
`fixture.calls` to the tracker as-is. A fixture with `"target": null`, whether
edited by hand or written under an older schema, gets past the declared type.

**Why not fixed here.** This PR is about which paths count as conductor
artifacts. Hardening every predicate, or validating fixtures, is a different
change with its own risks. The one guard that was on this PR's path was fixed.

**To close it.** Validate `Fixture` where it is parsed in `evals.ts` and drop or
normalise any call whose `target` is not a string. That fixes every predicate
at once instead of each one separately, and it keeps the declared
`string | undefined` type true for everything downstream.
