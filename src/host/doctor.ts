/**
 * `doctor`: the checks a human otherwise does by hand after a merge and a
 * restart — and did, three times, finding stale code twice.
 *
 * `diagnose()` is a pure fold over probe RESULTS so every finding path is
 * testable; `probe()` gathers those results from the filesystem, the process
 * table, and the live host when run inside it. A `fail` means the plugin is
 * not doing what the source says; a `warn` means a feature is degraded.
 * @module dsh-skill-presets/host/doctor
 */

import { execFile } from 'node:child_process'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome, type StorePaths } from './store.ts'

export type Severity = 'ok' | 'warn' | 'fail'

export interface Finding {
  readonly id: string
  readonly severity: Severity
  readonly message: string
  readonly fix?: string
}

/** Everything the fold needs, gathered by {@link probe} or a test. */
export interface ProbeResults {
  /** Newest mtime under src/ and lib/ (ms); undefined when the dir is missing. */
  srcNewest?: number
  libNewest?: number
  /** src modules (relative, .ts) with no lib counterpart (.js). */
  libMissing: string[]
  nodeModulesSymlink?: string
  nodeModulesPresent: boolean
  /** From the profile dir: did `require.resolve('<pkg>/package.json')` work, and where did it land? */
  profileDir?: string
  profileResolves?: boolean
  profileResolvedTo?: string
  /** The profile lists the package in dsh.profile.bundles. */
  profileBundled?: boolean
  /** Old `skill-filesystem` workbench row still enabled in the profile patch. */
  legacySkillRowEnabled?: boolean
  /** Server start (ms) when known; lib mtime older than this = fine. */
  serverStartedAt?: number
  serverSource?: 'host' | 'ps' | 'none'
  restrictSeam?: boolean
  agentTeams?: boolean
  storeParse: { file: string, ok: boolean, note?: string }[]
  evals?: { total: number, failed: number }
  hostVersion?: string
  libVersion?: string
  /** The root that was probed, to compare with what the profile resolves. */
  probedRoot?: string
}

export function diagnose(r: ProbeResults): Finding[] {
  const out: Finding[] = []
  const push = (id: string, severity: Severity, message: string, fix?: string): void => { out.push({ id, severity, message, ...(fix !== undefined ? { fix } : {}) }) }

  if (r.libNewest === undefined) push('lib', 'fail', 'lib/ is missing — nothing is built', 'npm run build')
  else if (r.srcNewest !== undefined && r.srcNewest > r.libNewest + 1000) push('lib', 'fail', 'lib/ is older than src/ — the running code is not the source', 'npm run build (then restart)')
  else push('lib', 'ok', 'lib/ is newer than src/')
  if (r.libMissing.length > 0) push('lib-modules', 'fail', `${r.libMissing.length} source module(s) have no build output: ${r.libMissing.slice(0, 4).join(', ')}${r.libMissing.length > 4 ? '…' : ''}`, 'npm run build; if it finishes in under a second, check node_modules')

  if (!r.nodeModulesPresent) push('node-modules', 'fail', 'node_modules is missing — the build tools cannot run', 'npm ci')
  else if (r.nodeModulesSymlink !== undefined) push('node-modules', 'fail', `node_modules is a symlink → ${r.nodeModulesSymlink}; a self-link makes every build a silent no-op`, 'rm node_modules && npm ci; never link node_modules into a worktree')
  else push('node-modules', 'ok', 'node_modules is a real directory')

  if (r.profileDir === undefined) push('profile', 'warn', 'no DSH profile found to check against', 'pass --profile <name>')
  else {
    if (r.profileResolves === false) push('profile', 'fail', `the profile at ${r.profileDir} cannot resolve dsh-skill-presets/package.json — the client-modules scanner will skip the plugin silently`, `dsh plugin --profile <name> add link:<this dir>; pnpm install in the profile`)
    else if (r.profileResolves === true) push('profile', 'ok', `profile resolves the plugin${r.profileResolvedTo !== undefined ? ` at ${r.profileResolvedTo}` : ''}`)
    if (r.profileBundled === false) push('profile-bundles', 'fail', 'the plugin is not listed in dsh.profile.bundles — the row is never composed', 'add "dsh-skill-presets" to dsh.profile.bundles in the profile package.json')
    if (r.legacySkillRowEnabled === true) push('legacy-row', 'warn', 'the profile still enables the skill-filesystem row over <workbench>/skills — skills are discovered twice', 'set `disabled: true` on that row in the profile cordis.patch.yml')
  }

  const probingTheServedCopy = r.profileResolvedTo === undefined || r.probedRoot === undefined || r.profileResolvedTo === r.probedRoot
  if (!probingTheServedCopy) push('server', 'ok', `this checkout is not the one the profile serves (${r.profileResolvedTo}); server age not judged here`)
  else if (r.serverStartedAt !== undefined && r.libNewest !== undefined && r.libNewest > r.serverStartedAt) {
    push('server', 'fail', `the running server started before lib/ was built (${new Date(r.serverStartedAt).toLocaleTimeString()} < ${new Date(r.libNewest).toLocaleTimeString()}) — it runs the previous version`, 'restart the profile')
  } else if (r.serverStartedAt !== undefined) push('server', 'ok', `server started after the last build (via ${r.serverSource ?? '?'})`)
  else push('server', 'warn', 'could not tell when the server started; if you rebuilt, restart to be sure')
  if (r.hostVersion !== undefined && r.libVersion !== undefined && r.hostVersion !== r.libVersion) {
    push('version', 'fail', `the host runs ${r.hostVersion} but lib/ is ${r.libVersion}`, 'restart the profile')
  }

  if (r.restrictSeam === false) push('restrict-seam', 'warn', 'this harness has no ctx.skills.restrict(); strict mode denies out-of-set loads but the catalog still lists skills from ~/.dsh/skills and project .dsh/skills', 'for an exact catalog use composition: copy your agent preset under <dshHome>/.agent-presets/, delete its skill-filesystem row, map it under Settings → Skills → Defaults per agent preset; the harness itself stays untouched')
  else if (r.restrictSeam === true) push('restrict-seam', 'ok', 'ctx.skills.restrict() present')
  if (r.agentTeams === false) push('agent-teams', 'warn', 'ctx.agentTeams is absent; team attachment is inferred from tool visibility', 'update dsh-agent-teams to a build with the service')
  else if (r.agentTeams === true) push('agent-teams', 'ok', 'ctx.agentTeams present')

  for (const s of r.storeParse) {
    if (!s.ok) push(`store:${s.file}`, 'fail', `${s.file} is unreadable: ${s.note ?? 'parse error'} — defaults are in use`, 'fix or delete the file; the plugin re-seeds defaults')
  }
  if (r.storeParse.every(s => s.ok) && r.storeParse.length > 0) push('store', 'ok', `${r.storeParse.length} store files parse`)

  if (r.evals !== undefined) {
    if (r.evals.failed > 0) push('evals', 'fail', `${r.evals.failed}/${r.evals.total} eval fixture(s) fail — a detector changed behaviour`, 'dsh-skill-presets eval; `--update` only after confirming the change is intended')
    else push('evals', 'ok', `${r.evals.total} eval fixture(s) pass`)
  }
  return out
}

export function worstSeverity(findings: readonly Finding[]): Severity {
  if (findings.some(f => f.severity === 'fail')) return 'fail'
  if (findings.some(f => f.severity === 'warn')) return 'warn'
  return 'ok'
}

// ------------------------------------------------------------------ probes --

/** The plugin's own root (two levels above lib/host or src/host). */
export function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

async function newestMtime(dir: string, ext: string): Promise<{ newest?: number, files: string[] }> {
  const files: string[] = []
  let newest: number | undefined
  const walk = async (current: string, rel: string): Promise<void> => {
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(current, e.name)
      const r = rel.length > 0 ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (e.name !== 'node_modules') await walk(full, r) }
      else if (e.name.endsWith(ext)) {
        files.push(r)
        const m = (await stat(full)).mtimeMs
        if (newest === undefined || m > newest) newest = m
      }
    }
  }
  await walk(dir, '')
  return { ...(newest !== undefined ? { newest } : {}), files }
}

export interface ProbeOptions {
  root?: string
  profile?: string
  paths?: StorePaths
  /** Live-host facts, when run inside the host. */
  host?: { startedAt: number, restrictSeam?: boolean, agentTeams?: boolean, version?: string }
  runEvals?: () => Promise<{ total: number, failed: number }>
  env?: Record<string, string | undefined>
}

export async function probe(options: ProbeOptions = {}): Promise<ProbeResults> {
  const root = options.root ?? pluginRoot()
  const env = options.env ?? process.env
  const src = await newestMtime(join(root, 'src'), '.ts')
  const lib = await newestMtime(join(root, 'lib'), '.js')
  const libSet = new Set(lib.files)
  const libMissing = src.files
    .filter(f => !f.endsWith('.d.ts'))
    .filter(f => f.startsWith('host/') || f.startsWith('bin/'))
    .filter(f => !libSet.has(f.replace(/\.ts$/u, '.js')))

  let nodeModulesSymlink: string | undefined
  let nodeModulesPresent = false
  try {
    const st = await lstat(join(root, 'node_modules'))
    nodeModulesPresent = true
    if (st.isSymbolicLink()) nodeModulesSymlink = await (await import('node:fs/promises')).readlink(join(root, 'node_modules'))
  } catch { /* absent */ }

  const profileName = options.profile ?? 'web'
  const profileDir = join(resolveDshHome(env), 'profiles', profileName)
  let profileResolves: boolean | undefined
  let profileResolvedTo: string | undefined
  let profileBundled: boolean | undefined
  let legacySkillRowEnabled: boolean | undefined
  try {
    await stat(profileDir)
    try {
      const req = createRequire(join(profileDir, 'package.json'))
      profileResolvedTo = dirname(req.resolve('dsh-skill-presets/package.json'))
      profileResolves = true
    } catch { profileResolves = false }
    try {
      const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
      profileBundled = pkg.dsh?.profile?.bundles?.includes('dsh-skill-presets') === true
    } catch { /* leave undefined */ }
    try {
      const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
      legacySkillRowEnabled = legacyRowEnabled(patch)
    } catch { /* no patch */ }
  } catch { /* no profile dir → probes stay undefined */ }

  let serverStartedAt: number | undefined
  let serverSource: ProbeResults['serverSource'] = 'none'
  if (options.host !== undefined) { serverStartedAt = options.host.startedAt; serverSource = 'host' }
  else {
    const ps = await psStart()
    if (ps !== undefined) { serverStartedAt = ps; serverSource = 'ps' }
  }

  const storeParse: ProbeResults['storeParse'] = []
  if (options.paths !== undefined) {
    for (const file of ['sources.json', 'presets.json', 'overlays.json', 'practices.json', 'active.json', 'lock.json', 'normalize-rules.json']) {
      try { JSON.parse(await readFile(join(options.paths.skills, file), 'utf8')); storeParse.push({ file, ok: true }) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue // absent is fine; defaults apply
        storeParse.push({ file, ok: false, note: (error as Error).message })
      }
    }
  }

  let libVersion: string | undefined
  try { libVersion = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: string }).version } catch { /* ignore */ }

  return {
    probedRoot: root,
    ...(src.newest !== undefined ? { srcNewest: src.newest } : {}),
    ...(lib.newest !== undefined ? { libNewest: lib.newest } : {}),
    libMissing,
    ...(nodeModulesSymlink !== undefined ? { nodeModulesSymlink } : {}),
    nodeModulesPresent,
    ...(profileResolves !== undefined ? { profileDir } : {}),
    ...(profileResolves !== undefined ? { profileResolves } : {}),
    ...(profileResolvedTo !== undefined ? { profileResolvedTo } : {}),
    ...(profileBundled !== undefined ? { profileBundled } : {}),
    ...(legacySkillRowEnabled !== undefined ? { legacySkillRowEnabled } : {}),
    ...(serverStartedAt !== undefined ? { serverStartedAt } : {}),
    serverSource,
    ...(options.host?.restrictSeam !== undefined ? { restrictSeam: options.host.restrictSeam } : {}),
    ...(options.host?.agentTeams !== undefined ? { agentTeams: options.host.agentTeams } : {}),
    storeParse,
    ...(options.runEvals !== undefined ? { evals: await options.runEvals() } : {}),
    ...(options.host?.version !== undefined ? { hostVersion: options.host.version } : {}),
    ...(libVersion !== undefined ? { libVersion } : {}),
  }
}

/**
 * Whether a `- id: skill-filesystem` row in a patch file is enabled. The row
 * body is every following line indented deeper than the `- `; `disabled: true`
 * inside it turns the row off. Pure, exported for the test.
 */
export function legacyRowEnabled(patch: string): boolean | undefined {
  const lines = patch.split('\n')
  const start = lines.findIndex(l => /^-\s+id:\s*skill-filesystem\s*$/u.test(l))
  if (start === -1) return undefined
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]
    if (l.trim().length === 0 || l.trimStart().startsWith('#')) continue
    if (/^\S/u.test(l) || /^-\s/u.test(l)) break
    body.push(l)
  }
  return !body.some(l => /^\s+disabled:\s*true\s*$/u.test(l))
}

/** Start time of the `dsh web` server from the process table (macOS/Linux `ps`). */
async function psStart(): Promise<number | undefined> {
  return await new Promise((resolve) => {
    execFile('ps', ['-eo', 'lstart=,command='], { timeout: 3000 }, (error, stdout) => {
      if (error !== null) { resolve(undefined); return }
      const line = String(stdout).split('\n').find(l => /\bdsh\b.*\bweb\b/u.test(l) && !/\bgrep\b/u.test(l))
      if (line === undefined) { resolve(undefined); return }
      // lstart is 24 chars: "Sun Sep 13 14:17:35 2026"
      const t = Date.parse(line.trim().slice(0, 24))
      resolve(Number.isNaN(t) ? undefined : t)
    })
  })
}
