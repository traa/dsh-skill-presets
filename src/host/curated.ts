/**
 * The curated foundation — declared ONCE as data.
 *
 * Sources, stage presets, overlays, and practice defaults live here so the
 * examples, the JSON Schema, the bootstrap, and the runtime validation all
 * derive from the same declaration; a test fails if `examples/` drifts. The
 * workbench copy is what runs; this is the fallback and the seed.
 *
 * Grounded in the AI-native SDLC playbook's six stages (Plan → Design → Build →
 * Test → Deploy → Maintain) and its artifact chain (intent → spec → plan → PR).
 * Provider-neutral by construction: no preset names a vendor, and every local
 * skill speaks the harness's tool vocabulary.
 * @module dsh-skill-presets/host/curated
 */

import type { Overlay, PracticesDoc, Preset, SkillSource, Stage } from './types.ts'

const EPOCH = '2026-01-01T00:00:00.000Z'

/** Source ids, used to build refs below. */
export const SRC = {
  addy: 'addyosmani-agent-skills',
  superpowers: 'obra-superpowers',
  matt: 'mattpocock-skills',
  local: 'local',
} as const

export const CURATED_SOURCES: readonly SkillSource[] = [
  {
    id: SRC.addy,
    title: 'addyosmani/agent-skills',
    kind: 'github',
    repo: 'addyosmani/agent-skills',
    paths: ['skills'],
    enabled: true,
    note: 'Production-grade engineering skills; MIT.',
  },
  {
    id: SRC.superpowers,
    title: 'obra/superpowers',
    kind: 'github',
    repo: 'obra/superpowers',
    paths: ['skills'],
    enabled: true,
    note: 'Process skills: brainstorming, plans, TDD, worktrees, review; MIT.',
  },
  {
    id: SRC.matt,
    title: 'mattpocock/skills',
    kind: 'github',
    repo: 'mattpocock/skills',
    paths: ['skills/engineering', 'skills/productivity'],
    enabled: true,
    note: 'Engineering and productivity skills; `in-progress` and `misc` are excluded by default.',
  },
  {
    id: SRC.local,
    title: 'Local (this workbench)',
    kind: 'local',
    enabled: true,
    note: 'Hand-written skills, including the SDLC practice skills seeded by dsh-skill-presets.',
  },
]

const ref = (source: string, dir: string, extra: { as?: string, whenToUse?: string } = {}): Preset['skills'][number] =>
  ({ ref: `${source}/${dir}`, ...extra })

const preset = (id: string, title: string, stage: Stage, summary: string, color: string, skills: Preset['skills']): Preset =>
  ({ id, title, stage, summary, color, skills, createdAt: EPOCH, updatedAt: EPOCH, builtin: true })

export const CURATED_PRESETS: readonly Preset[] = [
  preset('plan', 'Plan', 'plan',
    'Turn an idea, ticket, or alert into a committed intent.md: problem, outcome, constraints, evidence.',
    '#7c3aed', [
      ref(SRC.superpowers, 'brainstorming'),
      ref(SRC.addy, 'idea-refine'),
      ref(SRC.addy, 'interview-me'),
      ref(SRC.addy, 'spec-driven-development'),
      ref(SRC.matt, 'grill-me'),
      ref(SRC.matt, 'to-spec'),
      ref(SRC.local, 'sdlc-stage-handoff'),
      ref(SRC.local, 'writing-skills-from-insights'),
    ]),
  preset('design', 'Design', 'design',
    'Shape the intent into spec.md and an implementation plan.md that names files, order, and the tests that prove it.',
    '#2563eb', [
      ref(SRC.superpowers, 'writing-plans'),
      ref(SRC.addy, 'planning-and-task-breakdown'),
      ref(SRC.addy, 'api-and-interface-design'),
      ref(SRC.addy, 'documentation-and-adrs'),
      ref(SRC.matt, 'codebase-design'),
      ref(SRC.matt, 'domain-modeling'),
      ref(SRC.matt, 'to-tickets'),
      ref(SRC.local, 'sdlc-stage-handoff'),
    ]),
  preset('build', 'Build', 'build',
    'Execute the plan in an isolated worktree with a test-first loop; finish by opening a PR, never by merging.',
    '#059669', [
      ref(SRC.superpowers, 'executing-plans'),
      ref(SRC.superpowers, 'test-driven-development'),
      ref(SRC.superpowers, 'using-git-worktrees'),
      ref(SRC.superpowers, 'verification-before-completion'),
      ref(SRC.addy, 'incremental-implementation'),
      ref(SRC.addy, 'git-workflow-and-versioning'),
      ref(SRC.matt, 'implement'),
      ref(SRC.local, 'worktree-first'),
      ref(SRC.local, 'pr-always'),
      ref(SRC.local, 'worktree-cleanup'),
    ]),
  preset('test-review', 'Test & Review', 'test',
    'Review the diff against plan.md and spec.md, write findings into the PR, and reserve human review for the risky parts.',
    '#d97706', [
      ref(SRC.superpowers, 'requesting-code-review'),
      ref(SRC.superpowers, 'receiving-code-review'),
      ref(SRC.superpowers, 'finishing-a-development-branch'),
      ref(SRC.addy, 'code-review-and-quality'),
      ref(SRC.addy, 'security-and-hardening'),
      ref(SRC.addy, 'browser-testing-with-devtools'),
      ref(SRC.matt, 'code-review'),
      ref(SRC.local, 'pr-review-against-plan'),
      ref(SRC.local, 'pr-always'),
      ref(SRC.local, 'worktree-cleanup'),
    ]),
  preset('deploy', 'Deploy', 'deploy',
    'Ship through the pipeline with evidence: environment checks, migrations, flags, canary, telemetry, rollback.',
    '#dc2626', [
      ref(SRC.addy, 'ci-cd-and-automation'),
      ref(SRC.addy, 'shipping-and-launch'),
      ref(SRC.addy, 'deprecation-and-migration'),
      ref(SRC.local, 'pr-always'),
    ]),
  preset('maintain', 'Maintain', 'maintain',
    'Diagnose a breached control band, write the incident record, and turn it into the next intent.md.',
    '#0891b2', [
      ref(SRC.superpowers, 'systematic-debugging'),
      ref(SRC.addy, 'debugging-and-error-recovery'),
      ref(SRC.addy, 'observability-and-instrumentation'),
      ref(SRC.addy, 'performance-optimization'),
      ref(SRC.matt, 'diagnosing-bugs'),
      ref(SRC.matt, 'triage'),
      ref(SRC.local, 'incident-to-intent'),
    ]),
  preset('delegate', 'Delegate', 'cross',
    'Conduct a team or fan work out to subagents with self-contained briefs; reconcile and report.',
    '#4b5563', [
      ref(SRC.superpowers, 'dispatching-parallel-agents'),
      ref(SRC.superpowers, 'subagent-driven-development'),
      ref(SRC.local, 'conductor-protocol'),
      ref(SRC.local, 'gemini-agent'),
      ref(SRC.local, 'qoder-agent'),
    ]),
]

export const CURATED_OVERLAYS: readonly Overlay[] = [
  {
    id: 'team-attached',
    title: 'Team attached (conductor)',
    when: 'tool-visible:team_delegate',
    skills: [ref(SRC.local, 'conductor-protocol')],
    enabled: true,
  },
  {
    id: 'git-repo',
    title: 'Inside a git repository',
    when: 'git-work-tree',
    skills: [ref(SRC.local, 'worktree-first'), ref(SRC.local, 'pr-always'), ref(SRC.local, 'worktree-cleanup'), ref(SRC.local, 'post-merge-sync')],
    enabled: true,
  },
]

export function defaultPractices(): PracticesDoc {
  return {
    version: 1,
    strictSkills: false,
    // OFF by default since Phase 7: the sweep once deleted a fresh worktree and
    // its branch mid-session. Removal is an action the user takes (sidebar
    // Remove, `worktrees --clean`); opt in here to run it on session end + hourly.
    autoCleanWorktrees: false,
    pruning: { minSessions: 20, maxLoadRate: 0.1, minUnknown: 3 },
    // Provider-neutral: any of these counts as "the project's instructions file".
    instructionFiles: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.agents/AGENTS.md', 'CONTRIBUTING.md'],
    protectedBranches: ['main', 'master', 'develop', 'trunk'],
    practices: [
      // `hard` since phase 6: advisory enforcement never stopped an edit on a
      // protected branch, which is the single thing this practice exists to
      // prevent. Only a store with NO practices.json — or one whose file omits
      // this entry — picks this up; see `validatePractices` for why an existing
      // `advisory` is never silently upgraded.
      { id: 'worktree', mode: 'hard', params: {} },
      { id: 'pull-request', mode: 'advisory', params: { checkEveryTurns: 10 } },
      { id: 'conductor', mode: 'advisory', params: {} },
      { id: 'artifact-chain', mode: 'advisory', params: { root: 'docs/sdlc' } },
      { id: 'plan-before-code', mode: 'advisory', params: {} },
      { id: 'plan-drift', mode: 'advisory', params: {} },
      { id: 'worktree-hygiene', mode: 'advisory', params: { staleDays: 14 } },
    ],
  }
}

/** Human-readable practice descriptions, for the UI and the prompt. */
export const PRACTICE_INFO: Record<PracticesDoc['practices'][number]['id'], { title: string, summary: string, skill: string }> = {
  'worktree': {
    title: 'Work in a worktree',
    summary: 'Edits happen on a feature branch in a git worktree, never on a protected branch in the primary checkout.',
    skill: 'worktree-first',
  },
  'pull-request': {
    title: 'Always open a PR',
    summary: 'Work ends with a pushed branch and an open pull request carrying intent, plan, and test evidence — never a merge.',
    skill: 'pr-always',
  },
  'conductor': {
    title: 'Follow the conductor protocol',
    summary: 'With a team attached the main agent delegates and reconciles; it does not edit code a teammate owns.',
    skill: 'conductor-protocol',
  },
  'artifact-chain': {
    title: 'Commit the stage artifact',
    summary: 'Each stage ends by committing its artifact (intent.md, spec.md, plan.md, PR) for the next stage to read.',
    skill: 'sdlc-stage-handoff',
  },
  'plan-before-code': {
    title: 'Plan before code',
    summary: 'In the Build stage, no file is edited before a plan.md exists.',
    skill: 'sdlc-stage-handoff',
  },
  'post-merge-sync': {
    title: 'Sync after a merge',
    summary: 'A merged PR means the local checkout is behind: further edits are written against stale code and the running server keeps serving the old build.',
    skill: 'post-merge-sync',
  },
  'worktree-hygiene': {
    title: 'Clean up worktrees',
    summary: 'Merged worktrees are removed with their branch; no worktree carries a node_modules symlink; none is left stale.',
    skill: 'worktree-cleanup',
  },
  'plan-drift': {
    title: 'Keep plan.md in step with the diff',
    summary: 'In the Build stage, a file plan.md never names is edited only if plan.md is updated in the same branch.',
    skill: 'sdlc-stage-handoff',
  },
}

/** Which stage each artifact belongs to, in loop order. */
export const STAGE_ARTIFACTS: readonly { stage: Stage, file: string }[] = [
  { stage: 'plan', file: 'intent.md' },
  { stage: 'design', file: 'spec.md' },
  { stage: 'design', file: 'plan.md' },
]

export const STAGE_ORDER: readonly Stage[] = ['plan', 'design', 'build', 'test', 'deploy', 'maintain']
