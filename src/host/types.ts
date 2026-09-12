/**
 * Data model for the skill store, presets, practices, and telemetry.
 *
 * Everything here is plain JSON persisted under `<workbench>/skills/`, so it
 * commits cleanly with the rest of the workbench and a human can read it.
 * @module dsh-skill-presets/host/types
 */

/** Where skills come from. */
export interface SkillSource {
  /** Stable id, also the directory name under `library/`. */
  readonly id: string
  /** Display title. */
  readonly title: string
  /** `github` sources are fetched; `local` sources are hand-written in the workbench. */
  readonly kind: 'github' | 'local'
  /** `owner/name` for github sources. */
  readonly repo?: string
  /** Git ref (branch or tag); defaults to the repository's default branch. */
  readonly ref?: string
  /** Directories that hold `<skill>/SKILL.md` bundles; defaults to `['skills']`. */
  readonly paths?: readonly string[]
  /** Whether the source is enabled for install/update. */
  readonly enabled: boolean
  /** Optional homepage/license note shown in the UI. */
  readonly note?: string
}

/** One installed skill as the lock records it. */
export interface LockedSkill {
  /** Source id. */
  readonly source: string
  /** Directory name under `library/<source>/`. */
  readonly dir: string
  /** Frontmatter name (the model-facing identifier). */
  readonly name: string
  /** Frontmatter description. */
  readonly description: string
  /** sha256 over sorted file paths + contents, after normalization. */
  readonly digest: string
  /** Digest of the upstream (un-normalized) bundle, when different. */
  readonly upstreamDigest?: string
  /** Whether the normalization pass changed this bundle. */
  readonly normalized: boolean
  /** Upstream commit the files came from (`local` for local sources). */
  readonly commit: string
  /** ISO time of the install or last update. */
  readonly installedAt: string
  /** File count in the bundle. */
  readonly files: number
  /** Previous versions, newest first, at most five. */
  readonly history?: readonly { commit: string, digest: string, at: string }[]
  /** Set when an update found the skill gone upstream. Files are kept. */
  readonly orphaned?: true
  /** Knowledge insight this local skill was promoted from (phase 4). */
  readonly promotedFrom?: string
}

/** The lock file. */
export interface Lock {
  readonly version: 1
  readonly sources: Record<string, { commit: string, fetchedAt: string }>
  readonly skills: LockedSkill[]
}

/** One skill inside a preset. */
export interface PresetSkillRef {
  /** `<source>/<dir>`. */
  readonly ref: string
  /** Exposed name override, when two sources collide on a name. */
  readonly as?: string
  /** Extra routing guidance appended to the catalog description. */
  readonly whenToUse?: string
}

/** The SDLC stages a preset can belong to. */
export type Stage = 'plan' | 'design' | 'build' | 'test' | 'deploy' | 'maintain' | 'cross'

/** A named set of skills. */
export interface Preset {
  readonly id: string
  readonly title: string
  readonly stage: Stage
  readonly summary: string
  /** CSS colour for the UI chip. */
  readonly color?: string
  readonly skills: readonly PresetSkillRef[]
  readonly createdAt: string
  readonly updatedAt: string
  /** Shipped with the plugin; may still be edited. */
  readonly builtin?: true
}

/** A conditional set of skills layered on top of any preset. */
export interface Overlay {
  readonly id: string
  readonly title: string
  /** Condition evaluated per agent. */
  readonly when: 'tool-visible:team_delegate' | 'git-work-tree' | 'always'
  readonly skills: readonly PresetSkillRef[]
  readonly enabled: boolean
}

/** Practice enforcement mode. */
export type PracticeMode = 'off' | 'advisory' | 'hard'

/** Practice ids the plugin knows how to detect. */
export type PracticeId =
  | 'worktree'
  | 'pull-request'
  | 'conductor'
  | 'artifact-chain'
  | 'plan-before-code'

/** Per-practice configuration. */
export interface PracticeConfig {
  readonly id: PracticeId
  readonly mode: PracticeMode
  readonly params: Record<string, unknown>
}

/** The practices file. */
export interface PracticesDoc {
  readonly version: 1
  readonly strictSkills: boolean
  /** Files recognised as the project's instructions file. Provider-neutral. */
  readonly instructionFiles: readonly string[]
  /** Branches on which editing in the primary checkout is a violation. */
  readonly protectedBranches: readonly string[]
  readonly practices: readonly PracticeConfig[]
}

/** Which preset is active. */
export interface ActiveDoc {
  readonly version: 1
  /** Global active preset id, or null for none. */
  readonly preset: string | null
  readonly since: string
  readonly by: 'ui' | 'tool' | 'default' | 'cli'
}

/** A normalization rule applied to upstream skill text on install. */
export interface NormalizeRule {
  readonly id: string
  /** JavaScript regular expression source; flags are `g` plus `i` when `ignoreCase`. */
  readonly pattern: string
  readonly ignoreCase?: boolean
  readonly replacement: string
  /** Why this rule exists; shown in the diff drawer. */
  readonly why: string
}

/** Traffic-light status of one practice in one session. */
export type PracticeStatus = 'green' | 'amber' | 'red' | 'n/a'

/** One practice's evaluation for a session. */
export interface PracticeResult {
  readonly id: PracticeId
  readonly status: PracticeStatus
  readonly evidence: readonly string[]
  readonly firstViolationAt?: string
}

/** Telemetry event, one JSON line each. */
export type UsageEvent =
  | { t: string, kind: 'offered', preset: string | null, overlays: string[], skills: string[] }
  | { t: string, kind: 'loaded', name: string, turn: number, ok: boolean, unknown?: true, chars: number }
  | { t: string, kind: 'preset-switch', from: string | null, to: string | null, by: ActiveDoc['by'] }
  | { t: string, kind: 'overlay', id: string, active: boolean }
  | { t: string, kind: 'practice', id: PracticeId, status: PracticeStatus, evidence: string[] }
  | { t: string, kind: 'denied', tool: string, reason: string }
  | { t: string, kind: 'rated', preset: string | null, rating: -1 | 0 | 1, note?: string }
  | { t: string, kind: 'provider', provider: string, model: string }
  | { t: string, kind: 'session', cwd?: string, agentPreset?: string }

/** Aggregated statistics across sessions. */
export interface Rollup {
  readonly version: 1
  readonly updatedAt: string
  readonly sessions: number
  readonly skills: Record<string, SkillStats>
  readonly presets: Record<string, PresetStats>
  readonly practices: Record<string, { green: number, amber: number, red: number, na: number }>
  /** Skill names the model asked for that were not in the catalog. */
  readonly unknownRequests: Record<string, number>
  /** Pairs of skills loaded in the same session, `a|b` sorted. */
  readonly coUsage: Record<string, number>
  /** Per provider/model split of skill loads. */
  readonly byModel: Record<string, { sessions: number, loads: number }>
}

export interface SkillStats {
  sessionsOffered: number
  sessionsLoaded: number
  loads: number
  /** Sum of turn index of first load, for a mean. */
  firstLoadTurnSum: number
  chars: number
  lastUsed?: string
}

export interface PresetStats {
  sessions: number
  ratingSum: number
  ratings: number
  /** Distinct skills loaded / offered, summed per session for a mean coverage. */
  coverageSum: number
}
