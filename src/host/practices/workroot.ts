/**
 * Where is the model actually working?
 *
 * A session's `cwd` is fixed at creation, but the model can `cd` into a
 * worktree or edit absolute paths elsewhere. Judging the worktree/PR/artifact
 * practices against the session cwd then produces false reds ("on master in
 * the primary checkout") while every edit lands in a feature worktree. This
 * derives the WORK ROOT from the most recent mutating call instead: the
 * directory of an absolute file path, or the target of a leading `cd`.
 * @module dsh-skill-presets/host/practices/workroot
 */

import { dirname, isAbsolute } from 'node:path'
import { commandCwd, type ObservedCall } from './detectors.ts'

// `commandCwd` moved into `detectors.ts` — the detectors need it to decide
// whether a bash mutation landed inside the checkout being judged, and they
// may not import THIS module (the dependency runs the other way). Re-exported
// so its existing callers keep their import site.
export { commandCwd } from './detectors.ts'

const WRITE_TOOLS = new Set(['write', 'edit', 'Write', 'Edit', 'multi_edit', 'MultiEdit', 'notebook_edit'])
const BASH_TOOLS = new Set(['bash', 'Bash', 'shell', 'terminal'])

/** Extract a leading `cd <dir>` from a shell command, if present. */
export function leadingCd(command: string): string | undefined {
  const m = command.trim().match(/^(?:set\s+-e\s*;\s*)?cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u)
  if (m === null) return undefined
  return (m[1] ?? m[2] ?? m[3]).replace(/^~(?=\/|$)/u, process.env.HOME ?? '~')
}

/**
 * The directory the call worked in, when it can be told from the call alone.
 * @param call - observed call.
 * @param cwd - the session cwd, for resolving relative `cd`.
 */
export function workRootOf(call: ObservedCall, cwd: string | undefined): string | undefined {
  if (call.target === undefined) return undefined
  if (WRITE_TOOLS.has(call.name)) {
    return isAbsolute(call.target) ? dirname(call.target) : undefined
  }
  if (BASH_TOOLS.has(call.name)) return commandCwd(call.target, cwd)
  return undefined
}

/**
 * The work root some call actually NAMED, or undefined when none did.
 *
 * Split out of `currentWorkRoot` because the cwd fallback is a GUESS and a
 * practice that names a repository in its verdict has to tell the guess apart
 * from evidence. In a live session the cwd was a different repository from the
 * one being worked in, and the artifact-chain practice reported a confident
 * red about a project nobody had touched.
 *
 * Deliberately NOT restricted to mutating calls: `cd /wt && git status` or
 * `git -C /wt log` says where the agent is working just as plainly as a write
 * does, and requiring a mutation first meant the session kept being judged
 * against the primary checkout until one happened to land.
 */
export function attributedWorkRoot(calls: readonly ObservedCall[], cwd: string | undefined): string | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const root = workRootOf(calls[i], cwd)
    if (root !== undefined) return root
  }
  return undefined
}

/**
 * The best current work root: the newest call that names one, else the session
 * cwd.
 *
 * The fallback keeps git facts readable from the very first step, before any
 * call has named a path. A caller that goes on to ASSERT something about that
 * directory must consult `attributedWorkRoot` to learn the root was only
 * assumed — see `SessionView.workRootAssumed`.
 */
export function currentWorkRoot(calls: readonly ObservedCall[], cwd: string | undefined): string | undefined {
  return attributedWorkRoot(calls, cwd) ?? cwd
}
