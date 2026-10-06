/**
 * GitHub access for skill sources: tree listing, blob fetching, skill-dir
 * discovery.
 *
 * Unauthenticated calls suffice for three sources at the default 60 req/h;
 * `GITHUB_TOKEN` is honoured when present. `fetch` is injected so tests never
 * touch the network. Every call has a timeout and retries once on a network
 * error — never on a 4xx, which will not improve by repetition.
 * @module dsh-skill-presets/host/github
 */

import { hasControlChar } from './sources.ts'

/** The slice of `fetch` this module uses. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>, signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}>

/** One blob in a repository tree. */
export interface TreeEntry {
  readonly path: string
  readonly sha: string
  readonly size?: number
}

/** A resolved tree. */
export interface RepoTree {
  /** Commit sha the tree was read at. */
  readonly commit: string
  /** The ref that was resolved: the one asked for, or the default branch. */
  readonly ref: string
  readonly entries: readonly TreeEntry[]
  /** Set when GitHub truncated the listing. */
  readonly truncated: boolean
}

export interface GithubOptions {
  fetch?: FetchLike
  token?: string
  timeoutMs?: number
  /** API base, overridable for tests. */
  apiBase?: string
  rawBase?: string
}

const DEFAULT_TIMEOUT = 20_000

/**
 * The ref lookup (`/commits/<ref>`) answered 404 or 422: GitHub does not know
 * that ref (or, for a 404, the repository). Thrown only by that step of
 * `GithubClient.tree`, so a caller can tell "no such ref" apart from a tree
 * fetch failure, a rate limit or a network error. The message is GitHub's.
 */
export class RefNotFoundError extends Error {
  readonly status: number
  constructor(readonly repo: string, readonly ref: string, status: number, message: string) {
    super(message)
    this.name = 'RefNotFoundError'
    this.status = status
  }
}

/** Validate `owner/name`. */
export function isRepoSlug(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)
}

export class GithubClient {
  private readonly fetchImpl: FetchLike
  private readonly token: string | undefined
  private readonly timeoutMs: number
  private readonly apiBase: string
  private readonly rawBase: string

  constructor(options: GithubOptions = {}) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
    this.token = options.token ?? process.env.GITHUB_TOKEN
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
    this.apiBase = options.apiBase ?? 'https://api.github.com'
    this.rawBase = options.rawBase ?? 'https://raw.githubusercontent.com'
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'accept': 'application/vnd.github+json',
      'user-agent': 'dsh-skill-presets',
    }
    if (this.token !== undefined && this.token.length > 0) headers.authorization = `Bearer ${this.token}`
    return headers
  }

  /** GET with timeout and one retry on a network failure. */
  private async get(url: string, signal?: AbortSignal): Promise<{ status: number, text: string, bytes?: ArrayBuffer }> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
      const onAbort = (): void => controller.abort(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await this.fetchImpl(url, { headers: this.headers(), signal: controller.signal })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          const error = new Error(`GitHub ${response.status} for ${url}${text.length > 0 ? `: ${text.slice(0, 200)}` : ''}`)
          ;(error as Error & { status?: number }).status = response.status
          throw error
        }
        return { status: response.status, text: await response.text() }
      } catch (error) {
        lastError = error
        if (signal?.aborted === true) throw error
        const status = (error as { status?: number }).status
        if (status !== undefined) throw error
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * Resolve a ref to a commit sha and list every blob.
   * @param repo - `owner/name`.
   * @param ref - branch, tag, or sha; undefined for the default branch.
   */
  async tree(repo: string, ref?: string, signal?: AbortSignal): Promise<RepoTree> {
    if (!isRepoSlug(repo)) throw new Error(`invalid repository "${repo}"`)
    let target = ref
    if (target === undefined) {
      const meta = JSON.parse((await this.get(`${this.apiBase}/repos/${repo}`, signal)).text) as { default_branch?: string }
      target = meta.default_branch ?? 'main'
    }
    let commitText: string
    try {
      commitText = (await this.get(`${this.apiBase}/repos/${repo}/commits/${encodeURIComponent(target)}`, signal)).text
    } catch (error) {
      // Only THIS step can say "no such ref"; a 404 from the tree fetch below is not one.
      const status = (error as { status?: number }).status
      if (status === 404 || status === 422) throw new RefNotFoundError(repo, target, status, error instanceof Error ? error.message : String(error))
      throw error
    }
    const commit = (JSON.parse(commitText) as { sha?: string }).sha
    if (commit === undefined) throw new Error(`could not resolve ${repo}@${target} to a commit`)
    const treeText = (await this.get(`${this.apiBase}/repos/${repo}/git/trees/${commit}?recursive=1`, signal)).text
    const tree = JSON.parse(treeText) as { tree?: { path: string, type: string, sha: string, size?: number }[], truncated?: boolean }
    const entries = (tree.tree ?? [])
      .filter(entry => entry.type === 'blob')
      .map(entry => ({ path: entry.path, sha: entry.sha, ...(entry.size !== undefined ? { size: entry.size } : {}) }))
    return { commit, ref: target, entries, truncated: tree.truncated === true }
  }

  /** Fetch one file's raw content at a commit. */
  async raw(repo: string, commit: string, path: string, signal?: AbortSignal): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    return (await this.get(`${this.rawBase}/${repo}/${commit}/${encoded}`, signal)).text
  }
}

/** One discoverable skill directory in a tree. */
export interface DiscoveredSkill {
  /** Directory name (last path segment). */
  readonly dir: string
  /** Path of the directory in the repo. */
  readonly path: string
  /** Every blob below the directory, repo-relative. */
  readonly files: readonly TreeEntry[]
}

/**
 * Strip leading and trailing `/` in one linear pass. The regex form
 * `/^\/+|\/+$/g` backtracks quadratically on a long interior run of slashes.
 */
export function trimSlashes(path: string): string {
  let start = 0
  let end = path.length
  while (start < end && path.charCodeAt(start) === 0x2f) start += 1
  while (end > start && path.charCodeAt(end - 1) === 0x2f) end -= 1
  return path.slice(start, end)
}

/**
 * Find `<root>/<name>/SKILL.md` bundles under each configured root.
 *
 * Only one level deep by design — that is the layout all three curated sources
 * use, and the harness's own provider does not support nested discovery either.
 * Flat `<root>/<name>.md` files are not skills here: they cannot carry sibling
 * resources, and none of the sources use that form.
 * @param entries - repo blobs.
 * @param roots - directories to scan.
 */
export function discoverSkills(entries: readonly TreeEntry[], roots: readonly string[]): DiscoveredSkill[] {
  const found = new Map<string, DiscoveredSkill>()
  for (const rawRoot of roots) {
    const root = trimSlashes(rawRoot)
    const prefix = root.length > 0 ? `${root}/` : ''
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue
      const rel = entry.path.slice(prefix.length)
      const parts = rel.split('/')
      if (parts.length !== 2 || parts[1] !== 'SKILL.md') continue
      const dir = parts[0]
      const dirPath = `${prefix}${dir}`
      if (found.has(dirPath)) continue
      const files = entries.filter(candidate => candidate.path.startsWith(`${dirPath}/`))
      found.set(dirPath, { dir, path: dirPath, files })
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Find exactly the picked skill directories in a tree.
 *
 * A pick counts only when a `SKILL.md` blob sits directly in its directory; a
 * pick without one is left out (the caller reports it). `dir` is the pick's
 * last path segment.
 * @param entries - repo blobs.
 * @param picks - repo-relative skill directories.
 */
export function pickSkills(entries: readonly TreeEntry[], picks: readonly { readonly path: string }[]): DiscoveredSkill[] {
  const found = new Map<string, DiscoveredSkill>()
  for (const pick of picks) {
    const path = trimSlashes(pick.path)
    if (path.length === 0 || found.has(path)) continue
    if (!entries.some(entry => entry.path === `${path}/SKILL.md`)) continue
    const dir = path.slice(path.lastIndexOf('/') + 1)
    const files = entries.filter(entry => entry.path.startsWith(`${path}/`))
    found.set(path, { dir, path, files })
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** A parsed link to one skill, or why it was refused. */
export type ParsedSkillUrl = { readonly repo: string, readonly ref: string, readonly path: string } | { readonly error: string }

const SKILL_URL_SHAPE = 'expected https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md, '
  + 'https://github.com/<owner>/<repo>/tree/<ref>/<path> or https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>/SKILL.md '
  + '(branch names containing "/" are not supported; link a commit instead)'

/**
 * Parse a GitHub link to one skill (a `SKILL.md` blob, its directory, or the
 * raw file) into `{ repo, ref, path }`. Never throws.
 *
 * The ref is the single segment after `blob`/`tree` (or after the repo, or
 * after `refs/heads/` / `refs/tags/`, on `raw.githubusercontent.com`), so
 * branch names containing `/` cannot be expressed; link a commit instead. A
 * parse cannot tell such a link from a valid one; `addSkillFromUrl` rejects it
 * when the pick is not in the tree. Segments are checked as written, before
 * any URL normalization could collapse a `..`, and a segment with a control
 * character (raw or percent-encoded) is refused.
 * @param url - the link as pasted.
 */
export function parseSkillUrl(url: string): ParsedSkillUrl {
  const text = String(url).trim().replace(/[?#].*$/su, '')
  const match = /^https:\/\/([^/]+)\/(.*)$/iu.exec(text)
  if (match === null) return { error: `not an https GitHub link: ${SKILL_URL_SHAPE}` }
  const host = match[1].toLowerCase()
  const raw = host === 'raw.githubusercontent.com'
  if (!raw && host !== 'github.com' && host !== 'www.github.com') {
    return { error: `"${host}" is not github.com or raw.githubusercontent.com` }
  }
  const segments = match[2].replace(/\/$/u, '').split('/')
  const decoded: string[] = []
  for (const segment of segments) {
    let value: string
    try {
      value = decodeURIComponent(segment)
    } catch {
      return { error: `invalid escape in "${segment}"` }
    }
    if (value.length === 0 || value === '.' || value === '..') {
      return { error: `the link has an empty, "." or ".." path segment: ${SKILL_URL_SHAPE}` }
    }
    if (value.includes('/') || value.includes('\\')) return { error: `invalid path segment "${segment}"` }
    if (hasControlChar(value)) return { error: `the link has a control character in a path segment (${JSON.stringify(value)})` }
    decoded.push(value)
  }
  const [owner, rawRepo, ...rest] = decoded
  const name = (rawRepo ?? '').replace(/\.git$/u, '')
  const repo = `${owner ?? ''}/${name}`
  if (!isRepoSlug(repo)) return { error: `no valid <owner>/<repo> in the link: ${SKILL_URL_SHAPE}` }
  let kind: 'blob' | 'tree'
  if (raw) {
    kind = 'blob'
  } else {
    const mode = rest.shift()
    if (mode !== 'blob' && mode !== 'tree') return { error: `the link does not point into the repository's files: ${SKILL_URL_SHAPE}` }
    kind = mode
  }
  // raw.githubusercontent.com also serves `refs/heads/<branch>` and `refs/tags/<tag>`.
  if (raw && rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags')) rest.splice(0, 2)
  const ref = rest.shift()
  if (ref === undefined) return { error: `the link names no ref: ${SKILL_URL_SHAPE}` }
  if (kind === 'blob') {
    if (rest.pop() !== 'SKILL.md') return { error: `the link must point at a SKILL.md file: ${SKILL_URL_SHAPE}` }
  } else if (rest.at(-1) === 'SKILL.md') {
    // A tree link copied with the file still on it: the directory is meant.
    rest.pop()
  }
  if (rest.length === 0) return { error: 'the link points at the repository root, which is not a skill directory; link the skill\'s own SKILL.md or directory' }
  return { repo, ref, path: rest.join('/') }
}
