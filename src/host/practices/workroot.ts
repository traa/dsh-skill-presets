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
import { shellSegments, type ObservedCall } from './detectors.ts'

const WRITE_TOOLS = new Set(['write', 'edit', 'Write', 'Edit', 'multi_edit', 'MultiEdit', 'notebook_edit'])
const BASH_TOOLS = new Set(['bash', 'Bash', 'shell', 'terminal'])

/** Extract a leading `cd <dir>` from a shell command, if present. */
export function leadingCd(command: string): string | undefined {
  const m = command.trim().match(/^(?:set\s+-e\s*;\s*)?cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u)
  if (m === null) return undefined
  return (m[1] ?? m[2] ?? m[3]).replace(/^~(?=\/|$)/u, process.env.HOME ?? '~')
}

/** Commands whose `-C <dir>` really means "run in this directory". */
const DASH_C_TOOLS = new Set(['git', 'jj', 'make', 'tar'])

const CD_TARGET = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u

/**
 * The directory a shell command actually runs in, from ANY segment.
 *
 * `leadingCd` only saw a `cd` in front of the whole command, so
 * `npm ci && cd /wt && git commit` and `git -C /wt commit` both looked like
 * work in the session cwd — the root cause of "file mutations on protected
 * branch main in the primary checkout" while every write landed in a linked
 * worktree. The LAST directive wins, because that is where the command ended
 * up. Relative targets resolve against `cwd`.
 */
export function commandCwd(command: string, cwd: string | undefined): string | undefined {
  let found: string | undefined
  for (const segment of shellSegments(command)) {
    const cd = segment.match(CD_TARGET)
    if (cd !== null) {
      found = expand(cd[1] ?? cd[2] ?? cd[3])
      continue
    }
    const parts = segment.match(/(?:"[^"]*"|'[^']*'|\S)+/gu) ?? []
    const tool = parts[0]?.replace(/["']/gu, '').split('/').pop()
    if (tool === undefined) continue
    for (let i = 1; i < parts.length; i += 1) {
      const token = parts[i].replace(/["']/gu, '')
      const inline = token.match(/^--(?:cwd|directory)=(.+)$/u)
      if (inline !== null) { found = expand(inline[1]); continue }
      const isFlag = token === '--cwd' || token === '--directory' || (token === '-C' && DASH_C_TOOLS.has(tool))
      if (!isFlag) continue
      const value = parts[i + 1]?.replace(/["']/gu, '')
      if (value !== undefined && !value.startsWith('-')) { found = expand(value); i += 1 }
    }
  }
  if (found === undefined) return undefined
  if (isAbsolute(found)) return found
  return cwd !== undefined ? resolve(cwd, found) : undefined
}

function expand(path: string): string {
  return path.replace(/^~(?=\/|$)/u, process.env.HOME ?? '~')
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
