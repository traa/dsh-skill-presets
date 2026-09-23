# Intent — Phase 11: close Phase 10's two deferred items

Branch `fix/phase-11-deferred` in worktree `../dsh-skill-presets-phase-11`.
Follows Phase 10 (PR #28, merged `eb1bace`). User asked for both items.

Background and evidence for each item: `docs/sdlc/phase-10/deferred.md`.

## D1: A PR body drafted to a temp file counts against the conductor

**Problem.** When the conductor writes a PR body to `/tmp/body.md` and then runs
`gh pr create --body-file /tmp/body.md`, the conductor practice counts that
write as doing a teammate's job. Writing the PR body is the conductor's job.

**Outcome.** A write is exempt only if **both** of these are true:
1. the path is in a system temp directory (`/tmp/`, `/private/tmp/`,
   `/var/folders/`, or `$TMPDIR`), **and**
2. a `gh pr create` (or `gh pr edit`) call in the same session names that
   exact path in `--body-file` / `-F`.

**The trap, and why both conditions are needed.** With condition 2 alone,
`write src/x.ts` followed by `gh pr create --body-file src/x.ts` would clear a
real source edit. With condition 1 alone, any temp file would be exempt,
whatever it is used for. The exemption must stay narrow and fail closed.

## D2: Eval fixtures are cast from JSON and never checked

**Problem.** `src/host/evals.ts` reads each fixture with
`JSON.parse(...) as Fixture` and hands `fixture.calls` directly to the
detectors. A fixture with `"target": null` breaks the `string | undefined`
type, and the detectors that only check `=== undefined` then throw.

**Outcome.** Check each fixture at the point it is parsed. Reject a malformed
fixture with an error that names the fixture and the field, so a bad fixture
file is caught instead of quietly changing the replay. After this, the
declared types hold everywhere downstream, and the per-predicate guards
listed in phase-10 D2 are no longer needed.

## Constraints

- The 3 existing fixtures in `evals/fixtures/` must still load and replay
  exactly as before.
- No change to what counts as a conductor violation, other than the D1
  exemption.
