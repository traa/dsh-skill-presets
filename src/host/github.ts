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
    const commitText = (await this.get(`${this.apiBase}/repos/${repo}/commits/${encodeURIComponent(target)}`, signal)).text
    const commit = (JSON.parse(commitText) as { sha?: string }).sha
    if (commit === undefined) throw new Error(`could not resolve ${repo}@${target} to a commit`)
    const treeText = (await this.get(`${this.apiBase}/repos/${repo}/git/trees/${commit}?recursive=1`, signal)).text
    const tree = JSON.parse(treeText) as { tree?: { path: string, type: string, sha: string, size?: number }[], truncated?: boolean }
    const entries = (tree.tree ?? [])
      .filter(entry => entry.type === 'blob')
      .map(entry => ({ path: entry.path, sha: entry.sha, ...(entry.size !== undefined ? { size: entry.size } : {}) }))
    return { commit, entries, truncated: tree.truncated === true }
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
    const root = rawRoot.replace(/^\/+|\/+$/gu, '')
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
