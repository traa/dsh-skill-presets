# Spec: add one skill from a GitHub link, and recommend `show-me`

Intent: [intent.md](./intent.md). Decisions confirmed by the user: follow the branch in the
link (lock records the commit); reject a second pick whose directory name clashes inside one
source; UI field included; Playwright tests out of scope for this PR.

## Objective
Let a user install ONE skill from a public GitHub repo by pasting the link to its
`SKILL.md`, from the CLI, the RPC and the Sources view. Ship `show-me` through it and
recommend it in an always-on overlay.

## Data model
`SkillSource` gains an optional field:

```ts
/** Install exactly these skill directories instead of scanning `paths`. */
readonly skills?: readonly { readonly path: string }[]
```

- `path` is a repo-relative skill directory, e.g. `plugins/show-me/skills/show-me`. The
  skill's `dir` (the `<dir>` in `<source>/<dir>` refs) is its last path segment.
- When `skills` is present and non-empty, `paths` is ignored for that source.
- A source without `skills` behaves exactly as today. Stored `sources.json` files
  without the field stay valid; `sources.schema.json`, `validateSourcesFile`,
  `curated.ts` and the client `SkillSource` type all carry the field.
- Validation drops entries with a path that is empty, absolute, contains `..`, an empty
  segment, a backslash or a control character (U+0000–U+001F, U+007F); a single trailing `/`
  is stripped first (`skills/tool/` is the pick `skills/tool`); and drops a
  duplicate `dir` within one source (first wins). Sources arriving through a shared bundle
  (`planImport`) pass the same validation before they are saved or synced; a malformed
  `skills` value (not an array of `{ path: string }`) drops the source, never throws.

## Behaviour

### B1. `parseSkillUrl(url)` (pure, in `github.ts`)
Returns `{ repo, ref, path }` or `{ error }` (never throws).

| Input | Result |
|---|---|
| `https://github.com/o/r/blob/main/a/b/SKILL.md` | `{ repo: 'o/r', ref: 'main', path: 'a/b' }` |
| `https://github.com/o/r/tree/main/a/b` | `{ repo: 'o/r', ref: 'main', path: 'a/b' }` |
| `https://raw.githubusercontent.com/o/r/main/a/b/SKILL.md` | `{ repo: 'o/r', ref: 'main', path: 'a/b' }` |
| `blob` URL with a 40-hex ref | ref kept as given (a pinned commit) |
| trailing `?query`, `#fragment`, whitespace | ignored |
| non-GitHub host, `http:` scheme, unparsable text | `{ error }` |
| `blob` URL whose file is not `SKILL.md` | `{ error }` |
| `SKILL.md` at the repo root (empty path) | `{ error }` |
| path containing `..` or an empty segment | `{ error }` |
| `.git` suffix on the repo name | stripped |

The ref is the single segment after `blob`/`tree`/the raw prefix. Branch names that
contain `/` are not supported (documented limitation); they cannot be told apart from a
valid link at parse time, so B4 step 2 (verification against the tree) is what rejects them
with a message that says to link a commit.

Review round 1 additions (all rows return `{ error }` or the stated result, never throw):

| Input | Result |
|---|---|
| `raw.githubusercontent.com/o/r/refs/heads/main/a/b/SKILL.md` | `{ repo: 'o/r', ref: 'main', path: 'a/b' }` |
| `raw.githubusercontent.com/o/r/refs/tags/v1/a/b/SKILL.md` | `{ repo: 'o/r', ref: 'v1', path: 'a/b' }` |
| `tree` URL whose last segment is `SKILL.md` | trailing `SKILL.md` stripped: `…/tree/main/a/b/SKILL.md` gives path `a/b` |
| a path segment with a control character (U+0000–U+001F, U+007F), including percent-encoded | `{ error }` |

### B2. Discovery of picks (`github.ts`)
`pickSkills(entries, picks)` returns `DiscoveredSkill[]` with `dir` = last segment,
`path` = the pick path, `files` = every blob under it. A pick without a `SKILL.md` blob
directly in it is not returned. Sorted by path, like `discoverSkills`.

### B3. Library
`Library.sync` and `Library.check` choose discovery by source: picks when `skills` is
set, otherwise `paths`. The orphan, `newUpstream`, `removedUpstream` and `changed`
logic is unchanged and works on whichever set was discovered. A pick that is missing at
the ref produces a `SyncReport.note` of the form `skill "<path>" not found at <ref>`
and is not silently dropped. A scoped sync (`options.dirs`, as add-skill runs) whose pick has
gone missing upstream marks the existing lock entry orphaned (files kept), exactly as an
unscoped sync does; it never deletes the lock entry. Bundle file names are relative to the
pick path. A sync over a truncated tree that lacks an accepted pick reports the truncation note
together with the not-found note.

### B4. `Service.addSkillFromUrl(url)`
1. Parse (B1); on error throw with the parser's message.
2. Find the existing source for the same repo (case-insensitive):
   - none: create `{ id, title, kind: 'github', repo, ref, skills: [{ path }], enabled: true }`
     where `id` is `<owner>-<repo>` lowercased with characters outside `[a-z0-9._-]`
     replaced by `-`, and `title` is `<owner>/<repo>`. If that id is already used by a
     different repo, throw.
   - a whole-repo source (no `skills`): throw `"<id>" already installs the whole repository`.
   - a pick source with a different `ref`: throw naming the existing ref.
   - a pick source with the same `ref`: append the pick; if the same `path` is already
     present, change nothing (idempotent); if another pick has the same `dir`, throw.
   - an existing source that is DISABLED: throw `"<id>" is disabled; enable it first`
     (the CLI installs regardless of `enabled` but the RPC/UI job does not, so adding into a
     disabled source would silently install nothing on one surface). Order matters: the
     whole-repo rule comes BEFORE the disabled rule, so a disabled whole-repo source says
     "already installs the whole repository" and the user is never told to enable a source
     that would still refuse the add.
   - an existing pick source with no `ref`: the different-ref error must tell the user how
     to proceed (set `ref` on that source in sources.json), not only name the default branch.
2b. **Verify before saving** (review round 1). After the rules above accept the link and
   before anything is written, resolve the repo at the link's ref with the injected
   `GithubClient.tree` and require that the pick exists (`pickSkills` returns it). If the
   tree cannot be fetched, or the pick is not found, throw and leave `sources.json`
   untouched. The not-found message names the path and ref and says that branch names
   containing `/` are unsupported and a commit can be linked instead. Verification applies to
   every add, including a second pick into an existing source. The "branch names containing
   `/`" hint is added to the not-found error AND to a ref-lookup failure where GitHub says the
   ref does not exist (HTTP 404 or 422 on resolving the ref, which is what a link into branch
   `feature/x` produces, read as ref `feature`); it is NOT added to network errors, 403, 429 or
   5xx. If GitHub
   reports the tree as truncated and the pick is not in it, absence cannot be proven: the add
   is accepted without verification and the later install reports the truncation note.
   `skills: null` in a stored source is read as absent (whole-repo), not a reason to drop the
   source. A bundle with an invalid source is reported as a blocking problem whose message says
   the bundle will not be imported (wording valid for both the `bundle/plan` preview and apply:
"blocks the import"). The README claims only that a link is checked when it is first
   added (an already-saved pick is not re-checked) and that writes made through the service
   run in order within one process. Consequence: no source
   or pick is ever saved that the install cannot find, so a bad link never blocks the
   corrected one. Verification fetches the tree only (no bundle files).
3. Persist through `saveSources`, return `{ source, dir, created }`. All writes to
   `sources.json` (`saveSources` included, not only `addSkillFromUrl`) go through the same
   serialised edit queue, and concurrent writes never collide on a temp file name.
4. The caller then installs only that skill: `startSync([source], [dir])` for RPC/UI,
   `library.sync(source, { dirs: [dir] })` for the CLI.

### B5. Surfaces
- RPC `sources/add-skill` `{ url }` → `{ source, dir, created, job }`; errors come back
  as the RPC error channel, like every other handler.
- CLI `dsh-skill-presets add-skill <url>`: adds, installs, prints
  `<source>/<dir>: +1 …` like `install`; exit code 1 and the message on a rejected link.
  The usage text lists it.
- UI: the Sources view gets a text input with placeholder
  `https://github.com/owner/repo/blob/main/path/SKILL.md` and an **Add skill** button,
  disabled while busy or the input is empty. It calls `controller.addSkill(url)`, which
  calls the RPC, then follows the returned job like `updateSource`. A rejected link
  shows in the existing error banner. Pick sources list their skills like any source.
  The typed link is cleared only when the add succeeds; a rejected link keeps its text so
  it can be corrected. `addSkill` ignores a call made while another action is busy (a
  double click starts one job, not two).

### B6. Recommending `show-me`
- `CURATED_SOURCES` gains `humanlayer-skills`:
  `{ repo: 'humanlayer/skills', ref: 'main', skills: [{ path: 'plugins/show-me/skills/show-me' }] }`,
  with a note crediting Dex Horthy / HumanLayer.
- `CURATED_OVERLAYS` gains `recommended` (`when: 'always'`, enabled) carrying
  `humanlayer-skills/show-me`. It is data in `curated.ts`, mirrored in
  `examples/overlays.json` and `examples/sources.json` (regenerated, drift test green)
  and in the README overlay and source tables.
- Upstream sets `disable-model-invocation: true`; that is kept. `show-me` is listed in
  every conversation and runs when the user invokes it. It is not offered to the model.

### B7. Existing workbenches
The foundation adopter merges presets and overlays, not sources. An existing workbench
therefore gets the `recommended` overlay on adoption but not the source; `show-me` shows
as unresolved until `dsh-skill-presets add-skill <show-me url>` (or the UI field) runs.
Adopting curated sources is a follow-up, not part of this PR.

## Commands
```
npm run build      # tsc + client bundle
npm run typecheck
npm test           # node --test "test/*.test.mjs" (pretest builds)
npm run gen:examples   # regenerate examples/*.json from curated.ts
```

## Boundaries
- Always: tests use an injected `FetchLike`; the network is never touched.
- Ask first: new dependencies, changing the lock format.
- Never: edit upstream skill text; merge the PR; touch `test/` from the developer side.

## Success criteria
1. `parseSkillUrl` returns exactly the B1 table for each row.
2. A source with `skills` installs only the picked directory from a fake tree that also
   contains sibling skills, and `check` reports no sibling as `newUpstream`.
3. `addSkillFromUrl` produces the B4 outcomes for: new repo, same repo second pick,
   repeated pick, dir clash, whole-repo source, different ref, id taken by another repo.
4. `validateSourcesFile` round-trips `skills` and drops the unsafe paths in the data model.
5. `CURATED_SOURCES` has `humanlayer-skills`; the `recommended` overlay is `always` and
   carries `humanlayer-skills/show-me`; `examples/` matches (drift test passes).
6. The Sources view renders the input and button against fake DOM, and the button
   calls `addSkill` with the typed value.
7. `npm run build`, `npm run typecheck` and `npm test` exit 0; count ≥ baseline + new.

## Non-goals
Branch names containing `/`; private repos beyond what `GITHUB_TOKEN` already gives;
removing a pick from the UI (the existing per-skill Remove stays); adopting curated
sources into existing workbenches; Playwright tests.

## Open questions
None.
