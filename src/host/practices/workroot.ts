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

import { dirname, isAbsolute, resolve } from 'node:path'
import { isMutatingCall, type ObservedCall } from './detectors.ts'

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
  if (BASH_TOOLS.has(call.name)) {
    const cd = leadingCd(call.target)
    if (cd === undefined) return undefined
    if (isAbsolute(cd)) return cd
    return cwd !== undefined ? resolve(cwd, cd) : undefined
  }
  return undefined
}

/**
 * The best current work root: the newest mutating call that names one, else
 * the session cwd.
 */
export function currentWorkRoot(calls: readonly ObservedCall[], cwd: string | undefined): string | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]
    if (!isMutatingCall(call)) continue
    const root = workRootOf(call, cwd)
    if (root !== undefined) return root
  }
  return cwd
}
