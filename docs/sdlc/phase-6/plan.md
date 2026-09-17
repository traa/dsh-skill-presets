# Plan — Phase 6: make the worktree practice prevent the edit

Branch `feat/phase-6`, worktree `../dsh-skill-presets-phase-6`. Ends with a PR.

Team ownership (conductor protocol): `types-and-contracts-author` owns
`src/host/types.ts` and any `*.d.ts`; `plugin-core-developer` owns every other
file under `src/`; `test-engineer` owns everything under `test/`;
`cross-model-reviewer` reviews the PR diff and may touch lint/build config
only. No file is owned by two agents. Shared names are frozen in Task 1 and
every later brief quotes them verbatim.

## Task 1 — Freeze the contract (types author, FIRST, blocking)
Files: `src/host/types.ts`.
Add the decision type both gate paths will return, so implementation and tests
compile against one source of truth:

```ts
export interface GateDecision {
  readonly allow: boolean
  readonly practice: PracticeId
  /** Present iff allow === false. Names the skill and the remedy. */
  readonly reason?: string
  /** The literal command that fixes it, for the deny message. */
  readonly remedy?: string
}
export interface PendingCall {
  readonly name: string
  readonly filePath?: string
  readonly command?: string
}
```
Also: `PracticeMode` must already admit `'hard'` (verify, do not redefine), and
add `exemptRepos?: readonly string[]` + `exemptUntil?: string` to `PracticesDoc`
for Task 5. Frozen names: `GateDecision`, `PendingCall`, `decideWorktreeGate`,
`exemptRepos`, `exemptUntil`. Do not rename these downstream.

## Task 2 — One pure gate decision (core developer)
Files: `src/host/practices/gate.ts` (new), `src/host/index.ts`,
`src/bin/cli.ts`.
`decideWorktreeGate(facts: GitFacts, pending: PendingCall, doc: PracticesDoc):
GateDecision` — pure, no I/O. Denies iff: the practice is `hard`, the pending
call mutates, `facts.inRepo`, `facts.isWorktree === false`, and `facts.branch`
is in `doc.protectedBranches`. Returns `allow: true` in every other case,
including every fault (degrade to allow — never block on an internal error).
The `remedy` string carries the real command, derived from the repo basename
and default branch:
`git worktree add ../<repo>-<slug> -b feat/<slug> origin/<default>`.
Then make BOTH call sites delegate to it: the `worktree` branch of
`tools/pre-execute` in `src/host/index.ts`, and the `check` case in
`src/bin/cli.ts`. Neither may keep its own copy of the condition. Critically,
the native gate must stop consulting the retroactive tracker verdict
(`current?.results.find(x => x.id === 'worktree')`) for the DECISION — it may
still quote its evidence in the message.
READ THE SOURCE FIRST: `src/bin/cli.ts` already synthesises the pending call
correctly; follow what it does over this description and report any
discrepancy rather than breaking it to match.

## Task 3 — Flip the default, keep existing installs (core developer)
Files: `src/host/curated.ts`, `src/host/store.ts`.
`defaultPractices()` sets `{ id: 'worktree', mode: 'hard' }`. Migration rule:
a `practices.json` that EXISTS keeps every mode it declares; only an absent
file or an absent `worktree` entry picks up `hard`. Record this in
`validateActive`/the practices validator so an upgrade cannot silently start
blocking a user who deliberately chose advisory.

## Task 4 — "Not judged" ≠ "satisfied" (core developer)
Files: `src/host/practices/detectors.ts`, `src/client/views.ts`.
`detectWorktree` keeps `n/a` for "no mutations yet" but gains evidence that
states the live risk when facts are known and unsafe: `at risk — on protected
branch <b> in the primary checkout; the next edit will be denied`. Status stays
`n/a` (no violation has occurred) but the evidence is no longer silent. The
client renders an at-risk `n/a` distinctly from a satisfied one.
Do NOT change `refuseAssumedRoot` semantics — an assumed work root must still
refuse to assert, and this new evidence line is subject to that same guard.

## Task 5 — Explicit exemption (core developer)
Files: `src/host/service.ts`, `src/bin/cli.ts`, `src/client/views.ts`.
`dsh-skill-presets exempt worktree [--repo <path>] [--hours N] --reason <text>`
writes `exemptRepos`/`exemptUntil` into `practices.json`. `decideWorktreeGate`
honours it and the deny message names it as the escape hatch. A gate with no
sanctioned override is a gate users turn off entirely; this keeps the override
visible, scoped, and expiring.

## Task 6 — Tests (test engineer, parallel with 2–5 once Task 1 lands)
Files: `test/gate.test.mjs` (new), plus additions to the existing worktree
practice tests — do not rewrite files you do not own.
Cases: (a) deny on protected branch + primary checkout + hard + mutating
pending call, with NO prior observed mutation — this is the regression that
defines the phase; (b) allow in a linked worktree; (c) allow on a feature
branch in the primary checkout; (d) allow when advisory; (e) allow on every
malformed/faulting input (degrade-to-allow); (f) CLI `check worktree --hook`
and the native gate return the SAME decision for one shared table of fact
fixtures — the anti-divergence test; (g) an existing `practices.json` with
`advisory` is not migrated to `hard`; (h) exemption suppresses the deny and
expires. You do not change `src/` to make tests pass; report a minimal
reproducing case instead.

## Task 7 — Subagent inheritance regression (test engineer)
Prove the claim rather than asserting it: a gate decision computed for a child
session id with the parent's cwd denies identically. This documents that
worktree isolation is per unit of work, NOT per agent, and prevents a future
change from giving each subagent its own tree.

## Task 8 — README + PR
README: the practice modes table, the new default, the exemption command, and
one paragraph stating the per-work-unit (not per-agent) rule. `npm test` green,
`doctor` clean, PR against main.

## Riskiest step
Task 3. Flipping a default from advisory to hard changes behaviour for every
existing install that never wrote a config, and a false deny blocks all work —
the worst failure mode this plugin has. Mitigation: `decideWorktreeGate`
degrades to allow on every fault; the deny requires four positive facts, not
the absence of evidence; `refuseAssumedRoot`'s lesson (a confident verdict
about the wrong directory) is why the decision reads only facts pinned to a
named work root. If Task 2's fixture table shows any disagreement between the
two paths, fix the divergence before Task 3 flips anything.

## Options rejected
- **A worktree per writing subagent.** N agents on one feature produce N
  branches needing a merge before the PR, and concurrent edits stop seeing each
  other. The session's work root is the unit; the fan-out shares it.
- **Blocking from the detector verdict alone.** It cannot answer before the
  first mutation, which is precisely the case that matters.
- **Making the skill mandatory via `strictSkills`.** Forcing the catalog does
  not force the model to load or obey a skill; the mechanism has to be a gate,
  not a suggestion.
