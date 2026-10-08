# Spec: gate table

## Behaviour
`gateFor(stage)` returns:

| Stage | Gate |
|---|---|
| plan | `intent.md` |
| design | `plan.md` (written after `spec.md`) |
| build | `PR` |
| test | `merge` |
| deploy | `incident record` |
| maintain | `undefined` (the incident record starts a new intent) |
| cross | `undefined` |

- The prompt block reads `Flow: Full · stage 3 of 5: Build → next gate: PR`.
- `shouldSuggest` with an explicit position fires when the CURRENT stage's gate lands:
  Design on `plan.md` appearing (NOT on `spec.md`), Build on a PR appearing. Stages whose
  gate is not an observable artifact (`merge`, `incident record`) never fire it.
- `stage.ts` has no second gate table; it uses `gateFor`.
- The client chip title reads `ends with <gate>` from the host card; no client change.

## Non-goals
Stage detection (`detectStage`) is unchanged.

## Acceptance
- `npm test` green, count >= 240 + new tests.
- No test or doc asserts `build → plan.md`.
