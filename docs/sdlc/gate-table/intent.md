# Intent: gate table off by one stage

**Problem.** `GATES` in `src/host/flows.ts` says Build ends with `plan.md`. The README
(line 10), the `sdlc_status` tool, and the `sdlc-stage-handoff` / `pr-always` skills say
Build ends with the PR. Stage detection (`src/host/stage.ts`) treats a committed
`plan.md` as the signal that you are already *in* Build. `GATE_ARTIFACT` in `stage.ts` is
a hand-copied duplicate of `GATES`, so the "offer the next stage" moment fires when
`spec.md` lands in Design, one artifact early.

**Outcome.** One gate table, consistent everywhere: the artifact that ends a stage is the
one the next stage reads.

**Constraints.** No behaviour change outside gates. `stage.ts` must derive its table from
`gateFor` rather than keep a copy. Never merge.

**Evidence.** `src/host/flows.ts:63`, `src/host/stage.ts:48,75`, `src/host/tools.ts:137`,
`README.md:10,52`, `skills/pr-always/SKILL.md:9`. Asked by the user; direction chosen:
shift gates to the README drawing.
