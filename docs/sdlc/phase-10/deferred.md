# Deferred — Phase 10

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
