// Install ONE skill from a GitHub SKILL.md link (docs/sdlc/show-me-skill/spec.md).
//
// Namespace imports on purpose: a symbol that does not exist yet fails the test
// that uses it, not the whole file at load time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as github from '../lib/host/github.js'
import { Library } from '../lib/host/library.js'
import * as libraryModule from '../lib/host/library.js'
import { StorePaths } from '../lib/host/store.js'
import { BUILTIN_NORMALIZE_RULES } from '../lib/host/normalize.js'
import { SkillPresetsService, validateSourcesFile } from '../lib/host/service.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOW_ME = 'https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md'

// ------------------------------------------------------------ B1 parseSkillUrl --

function parse(url) {
  assert.equal(typeof github.parseSkillUrl, 'function', 'github.js must export parseSkillUrl')
  return github.parseSkillUrl(url)
}

function assertRejected(url) {
  let result
  assert.doesNotThrow(() => { result = parse(url) }, `parseSkillUrl must not throw for ${JSON.stringify(url)}`)
  assert.equal(typeof result?.error, 'string', `${JSON.stringify(url)} must be rejected with { error }`)
  assert.ok(result.error.length > 0, 'the error names the problem')
  assert.equal(result.repo, undefined, `${JSON.stringify(url)} must not yield a repo`)
}

test('parseSkillUrl: a blob link to SKILL.md yields repo, ref and the skill directory', () => {
  assert.deepEqual(parse('https://github.com/o/r/blob/main/a/b/SKILL.md'), { repo: 'o/r', ref: 'main', path: 'a/b' })
})

test('parseSkillUrl: a tree link to the skill directory yields the same triple', () => {
  assert.deepEqual(parse('https://github.com/o/r/tree/main/a/b'), { repo: 'o/r', ref: 'main', path: 'a/b' })
})

test('parseSkillUrl: a raw.githubusercontent.com link to SKILL.md yields the same triple', () => {
  assert.deepEqual(parse('https://raw.githubusercontent.com/o/r/main/a/b/SKILL.md'), { repo: 'o/r', ref: 'main', path: 'a/b' })
})

test('parseSkillUrl: a 40-hex commit ref is kept exactly as given', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567'
  assert.deepEqual(parse(`https://github.com/o/r/blob/${sha}/a/b/SKILL.md`), { repo: 'o/r', ref: sha, path: 'a/b' })
})

test('parseSkillUrl: query, fragment and surrounding whitespace are ignored', () => {
  const expected = { repo: 'o/r', ref: 'main', path: 'a/b' }
  assert.deepEqual(parse('https://github.com/o/r/blob/main/a/b/SKILL.md?plain=1'), expected)
  assert.deepEqual(parse('https://github.com/o/r/blob/main/a/b/SKILL.md#L10'), expected)
  assert.deepEqual(parse('  https://github.com/o/r/blob/main/a/b/SKILL.md?plain=1#top \n'), expected)
})

test('parseSkillUrl: a .git suffix on the repo name is stripped', () => {
  assert.deepEqual(parse('https://github.com/o/r.git/blob/main/a/b/SKILL.md'), { repo: 'o/r', ref: 'main', path: 'a/b' })
})

test('parseSkillUrl: a non-GitHub host is rejected', () => {
  assertRejected('https://gitlab.com/o/r/blob/main/a/b/SKILL.md')
  assertRejected('https://example.com/o/r/main/a/b/SKILL.md')
})

test('parseSkillUrl: the http: scheme is rejected', () => {
  assertRejected('http://github.com/o/r/blob/main/a/b/SKILL.md')
})

test('parseSkillUrl: unparsable text is rejected without throwing', () => {
  assertRejected('not a link')
  assertRejected('')
  assertRejected('github.com/o/r/blob/main/a/b/SKILL.md')
})

test('parseSkillUrl: a blob link to a file other than SKILL.md is rejected', () => {
  assertRejected('https://github.com/o/r/blob/main/a/b/README.md')
  assertRejected('https://github.com/o/r/blob/main/a/b/skill.md')
})

test('parseSkillUrl: SKILL.md at the repository root (empty path) is rejected', () => {
  assertRejected('https://github.com/o/r/blob/main/SKILL.md')
  assertRejected('https://raw.githubusercontent.com/o/r/main/SKILL.md')
})

test('parseSkillUrl: a path with a .. segment or an empty segment is rejected, not normalized away', () => {
  // `new URL` collapses `a/../b`; the parser must see the segment and refuse it.
  assertRejected('https://github.com/o/r/blob/main/a/../b/SKILL.md')
  assertRejected('https://github.com/o/r/tree/main/a/..')
  assertRejected('https://github.com/o/r/blob/main/a//b/SKILL.md')
})

// Review round 1 rows (spec B1, second table).

test('parseSkillUrl: a raw link through refs/heads/<branch> yields the branch as ref', () => {
  assert.deepEqual(parse('https://raw.githubusercontent.com/o/r/refs/heads/main/a/b/SKILL.md'), { repo: 'o/r', ref: 'main', path: 'a/b' })
})

test('parseSkillUrl: a raw link through refs/tags/<tag> yields the tag as ref', () => {
  assert.deepEqual(parse('https://raw.githubusercontent.com/o/r/refs/tags/v1/a/b/SKILL.md'), { repo: 'o/r', ref: 'v1', path: 'a/b' })
})

test('parseSkillUrl: a tree link ending in SKILL.md has the trailing SKILL.md stripped', () => {
  assert.deepEqual(parse('https://github.com/o/r/tree/main/a/b/SKILL.md'), { repo: 'o/r', ref: 'main', path: 'a/b' })
})

test('parseSkillUrl: a path segment with a control character, raw or percent-encoded, is rejected', () => {
  assertRejected('https://github.com/o/r/blob/main/a/b%00c/SKILL.md')
  assertRejected('https://github.com/o/r/blob/main/a/b%1Fc/SKILL.md')
  assertRejected('https://github.com/o/r/blob/main/a/b%7Fc/SKILL.md')
  assertRejected('https://github.com/o/r/tree/main/a/b%0Ac')
  assertRejected('https://raw.githubusercontent.com/o/r/main/a/b\u0001c/SKILL.md')
  assertRejected('https://github.com/o/r/blob/main/a/b\tc/SKILL.md')
})

// ------------------------------------------------------------ B2 pickSkills --

const PICK_TREE = [
  { path: 'README.md', sha: 'r' },
  { path: 'plugins/show-me/skills/show-me/SKILL.md', sha: '1' },
  { path: 'plugins/show-me/skills/show-me/scripts/run.sh', sha: '2' },
  { path: 'plugins/show-me/skills/show-me-extra/SKILL.md', sha: '3' },
  { path: 'plugins/show-me/skills/other/SKILL.md', sha: '4' },
  { path: 'skills/foo/SKILL.md', sha: '5' },
  { path: 'plugins/empty/skills/nothing/README.md', sha: '6' },
  { path: 'plugins/deep/skills/x/nested/SKILL.md', sha: '7' },
]

function pick(entries, picks) {
  assert.equal(typeof github.pickSkills, 'function', 'github.js must export pickSkills')
  return github.pickSkills(entries, picks)
}

test('pickSkills returns only the picked directory, named by its last segment, with every file under it', () => {
  const found = pick(PICK_TREE, [{ path: 'plugins/show-me/skills/show-me' }])
  assert.equal(found.length, 1)
  assert.equal(found[0].dir, 'show-me')
  assert.equal(found[0].path, 'plugins/show-me/skills/show-me')
  assert.deepEqual(found[0].files.map(f => f.path).sort(), [
    'plugins/show-me/skills/show-me/SKILL.md',
    'plugins/show-me/skills/show-me/scripts/run.sh',
  ])
})

test('pickSkills ignores sibling skills in the same tree, including a sibling sharing the name prefix', () => {
  const found = pick(PICK_TREE, [{ path: 'plugins/show-me/skills/show-me' }])
  const files = found.flatMap(s => s.files.map(f => f.path))
  assert.ok(!files.some(p => p.includes('show-me-extra')), 'show-me-extra is a different directory')
  assert.ok(!files.some(p => p.includes('/other/') || p.startsWith('skills/')), 'siblings never leak in')
})

test('pickSkills drops a pick whose directory has no SKILL.md directly in it', () => {
  assert.deepEqual(pick(PICK_TREE, [{ path: 'plugins/empty/skills/nothing' }]), [])
  assert.deepEqual(pick(PICK_TREE, [{ path: 'plugins/deep/skills/x' }]), [], 'a SKILL.md deeper down does not count')
  assert.deepEqual(pick(PICK_TREE, [{ path: 'plugins/missing/skills/gone' }]), [])
})

test('pickSkills returns several picks sorted by path', () => {
  const found = pick(PICK_TREE, [{ path: 'skills/foo' }, { path: 'plugins/show-me/skills/other' }])
  assert.deepEqual(found.map(s => s.path), ['plugins/show-me/skills/other', 'skills/foo'])
  assert.deepEqual(found.map(s => s.dir), ['other', 'foo'])
})

// ------------------------------------------------------------ B3 Library --

/** A fake GitHub serving one repo whose tree changes per commit. Never the network. */
function fakeGithub(state) {
  const calls = []
  const fetch = async (url) => {
    calls.push(url)
    const ok = body => ({ ok: true, status: 200, text: async () => typeof body === 'string' ? body : JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) })
    const missing = { ok: false, status: 404, text: async () => 'nope', arrayBuffer: async () => new ArrayBuffer(0) }
    const c = url.match(/^https:\/\/api\/repos\/[^/]+\/[^/]+\/commits\/([^?]+)$/)
    if (c) return ok({ sha: state.history[decodeURIComponent(c[1])] !== undefined ? decodeURIComponent(c[1]) : state.commit })
    const t = url.match(/^https:\/\/api\/repos\/[^/]+\/[^/]+\/git\/trees\/([^?]+)/)
    if (t) {
      const files = state.history[t[1]] ?? state.files
      return ok({ tree: Object.keys(files).map(path => ({ path, type: 'blob', sha: `${path}:${files[path]}` })) })
    }
    if (/^https:\/\/api\/repos\/[^/]+\/[^/]+$/.test(url)) return ok({ default_branch: 'main' })
    const m = url.match(/^https:\/\/raw\/[^/]+\/[^/]+\/([^/]+)\/(.+)$/)
    if (m) {
      const body = state.history[m[1]]?.[decodeURIComponent(m[2])]
      return body === undefined ? missing : ok(body)
    }
    return missing
  }
  return { calls, client: new github.GithubClient({ fetch, apiBase: 'https://api', rawBase: 'https://raw', timeoutMs: 1000 }) }
}

const skillMd = name => `---\nname: ${name}\ndescription: ${name} skill\n---\nbody of ${name}`

/** A repo with the pick AND siblings: a pick source falling back to `paths` would install them. */
const HUMANLAYER_TREE = {
  'plugins/show-me/skills/show-me/SKILL.md': skillMd('show-me'),
  'plugins/show-me/skills/show-me/scripts/run.sh': 'echo show',
  'plugins/show-me/skills/other/SKILL.md': skillMd('other'),
  'skills/foo/SKILL.md': skillMd('foo'),
  'skills/bar/SKILL.md': skillMd('bar'),
}

const PICK_SOURCE = {
  id: 'humanlayer-skills', title: 'humanlayer/skills', kind: 'github', repo: 'humanlayer/skills', ref: 'main',
  skills: [{ path: 'plugins/show-me/skills/show-me' }], enabled: true,
}

async function librarySetup(files = HUMANLAYER_TREE) {
  const root = await mkdtemp(join(tmpdir(), 'skp-pick-'))
  const paths = new StorePaths(root)
  const state = { commit: 'c1', files, history: { c1: files } }
  const gh = fakeGithub(state)
  const lib = new Library({ paths: () => paths, github: gh.client, rules: async () => BUILTIN_NORMALIZE_RULES, now: () => new Date('2026-01-02T00:00:00Z') })
  return { paths, state, lib, gh }
}

test('Library.sync of a pick source installs only the picked directory, never its siblings', async () => {
  const { lib, paths } = await librarySetup()
  const report = await lib.sync(PICK_SOURCE)
  assert.deepEqual(report.added, ['show-me'])
  assert.deepEqual(report.failed, [])
  const installed = await readdir(join(paths.library, 'humanlayer-skills'))
  assert.deepEqual(installed.sort(), ['show-me'])
  const lock = await lib.lock()
  assert.deepEqual(lock.skills.filter(s => s.source === 'humanlayer-skills').map(s => s.dir), ['show-me'])
  assert.equal(lock.sources['humanlayer-skills'].commit, 'c1')
})

test('Library.sync of a pick source names bundle files relative to the pick path', async () => {
  const { lib, paths } = await librarySetup()
  await lib.sync(PICK_SOURCE)
  const dir = paths.skillDir('humanlayer-skills', 'show-me')
  assert.match(await readFile(join(dir, 'SKILL.md'), 'utf8'), /name: show-me/)
  assert.equal(await readFile(join(dir, 'scripts', 'run.sh'), 'utf8'), 'echo show')
  await assert.rejects(access(join(dir, 'plugins')), 'no repo-relative prefix inside the bundle')
  const locked = (await lib.lock()).skills.find(s => s.dir === 'show-me')
  assert.equal(locked.files, 2)
})

test('Library.sync ignores `paths` when `skills` is set', async () => {
  const { lib } = await librarySetup()
  const report = await lib.sync({ ...PICK_SOURCE, paths: ['skills'] })
  assert.deepEqual(report.added, ['show-me'])
  assert.deepEqual((await lib.lock()).skills.map(s => s.dir), ['show-me'])
})

test('Library.check of a pick source does not report sibling skills as newUpstream', async () => {
  const { lib, state } = await librarySetup()
  const before = await lib.check(PICK_SOURCE)
  assert.deepEqual(before.newUpstream, ['show-me'], 'only the pick is new before install')
  await lib.sync(PICK_SOURCE)
  const files = { ...HUMANLAYER_TREE, 'plugins/show-me/skills/show-me/SKILL.md': skillMd('show-me') + ' v2', 'skills/baz/SKILL.md': skillMd('baz') }
  state.commit = 'c2'; state.files = files; state.history.c2 = files
  const after = await lib.check(PICK_SOURCE)
  assert.deepEqual(after.newUpstream, [])
  assert.deepEqual(after.removedUpstream, [])
  assert.deepEqual(after.changed, ['show-me'])
})

test('Library.sync reports a pick missing at the ref as a note, and still installs the others', async () => {
  const { lib } = await librarySetup()
  const source = { ...PICK_SOURCE, skills: [{ path: 'plugins/show-me/skills/show-me' }, { path: 'plugins/gone/skills/gone' }] }
  const report = await lib.sync(source)
  assert.deepEqual(report.added, ['show-me'])
  assert.equal(typeof report.note, 'string', 'a missing pick is reported, not silently dropped')
  assert.ok(report.note.includes('skill "plugins/gone/skills/gone" not found at main'), report.note)
})

test('Library.sync with options.dirs reports only the missing picks inside those dirs', async () => {
  const { lib } = await librarySetup()
  const source = { ...PICK_SOURCE, skills: [{ path: 'plugins/show-me/skills/show-me' }, { path: 'plugins/gone/skills/gone' }] }
  const scoped = await lib.sync(source, { dirs: ['show-me'] })
  assert.deepEqual(scoped.added, ['show-me'])
  assert.ok(!(scoped.note ?? '').includes('plugins/gone/skills/gone'), `a pick outside dirs is not reported: ${scoped.note}`)
  const asked = await lib.sync(source, { dirs: ['gone'] })
  assert.ok((asked.note ?? '').includes('skill "plugins/gone/skills/gone" not found at main'), `the asked-for missing pick is reported: ${asked.note}`)
})

// A run of slashes inside a pick path made the trim regex backtrack
// quadratically (measured ~4 s for pickSkills, ~8 s for discoverSourceSkills at
// 50 000 slashes). The bound is generous; linear work takes well under 50 ms.
const SLASH_RUN = `a${'/'.repeat(50000)}x`

test('pickSkills handles a pick path with a long run of slashes in linear time', () => {
  const started = performance.now()
  pick([{ path: 'x/SKILL.md', sha: '1' }], [{ path: SLASH_RUN }])
  const ms = performance.now() - started
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`)
})

test('discoverSourceSkills handles a pick path with a long run of slashes in linear time', () => {
  assert.equal(typeof libraryModule.discoverSourceSkills, 'function', 'library.js exports discoverSourceSkills')
  const started = performance.now()
  libraryModule.discoverSourceSkills({ ...PICK_SOURCE, skills: [{ path: SLASH_RUN }] }, { entries: [{ path: 'x/SKILL.md', sha: '1' }] })
  const ms = performance.now() - started
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`)
})

// ------------------------------------------------------------ data model --

test('validateSourcesFile round-trips `skills` on a github source', () => {
  const input = [{ ...PICK_SOURCE, skills: [{ path: 'plugins/show-me/skills/show-me' }, { path: 'skills/foo' }] }]
  const out = validateSourcesFile(input)
  const source = out.find(s => s.id === 'humanlayer-skills')
  assert.deepEqual(source.skills, [{ path: 'plugins/show-me/skills/show-me' }, { path: 'skills/foo' }])
  assert.deepEqual(validateSourcesFile(JSON.parse(JSON.stringify(out))), out, 'stable through a JSON write and re-read')
  // Regression guard: a source without `skills` is unchanged.
  const whole = { id: 'obra-superpowers', title: 'obra/superpowers', kind: 'github', repo: 'obra/superpowers', paths: ['skills'], enabled: true }
  assert.deepEqual(validateSourcesFile([whole]).find(s => s.id === 'obra-superpowers'), whole)
})

test('validateSourcesFile drops unsafe pick paths and duplicate dirs (first wins)', () => {
  const out = validateSourcesFile([{
    ...PICK_SOURCE,
    skills: [
      { path: 'plugins/show-me/skills/show-me' },
      { path: '' },
      { path: '/etc/skills/abs' },
      { path: 'a/../b' },
      { path: '..' },
      { path: 'a//b' },
      { path: 'a\\b' },
      { path: 'other/place/show-me' },
      { path: 'skills/foo' },
    ],
  }])
  assert.deepEqual(out.find(s => s.id === 'humanlayer-skills').skills, [{ path: 'plugins/show-me/skills/show-me' }, { path: 'skills/foo' }])
})

test('validateSourcesFile drops pick paths containing a control character', () => {
  const out = validateSourcesFile([{
    ...PICK_SOURCE,
    skills: [
      { path: 'plugins/show-me/skills/show-me' },
      { path: 'a/b\u0000c' },
      { path: 'a/b\u001fd' },
      { path: 'a/b\u007fe' },
      { path: 'a/b\tf' },
      { path: 'skills/foo' },
    ],
  }])
  assert.deepEqual(out.find(s => s.id === 'humanlayer-skills').skills, [{ path: 'plugins/show-me/skills/show-me' }, { path: 'skills/foo' }])
})

test('validateSourcesFile drops a source whose `skills` is not an array of { path: string }, without throwing', () => {
  const keep = { id: 'obra-superpowers', title: 'obra/superpowers', kind: 'github', repo: 'obra/superpowers', paths: ['skills'], enabled: true }
  for (const malformed of ['abc', [1], [{}], { path: 'x' }, 42]) {
    let out
    assert.doesNotThrow(() => { out = validateSourcesFile([keep, { ...PICK_SOURCE, skills: malformed }]) }, JSON.stringify(malformed))
    assert.equal(out.find(s => s.id === 'humanlayer-skills'), undefined, `skills ${JSON.stringify(malformed)} drops the source (it must not become a whole-repo install)`)
    assert.deepEqual(out.find(s => s.id === 'obra-superpowers'), keep)
  }
})

// Review round 2 (spec B4 2b): `skills: null` reads as absent; a malformed pick
// ENTRY is dropped like an unsafe one, and the source survives while a safe pick remains.

test('validateSourcesFile keeps a stored source with `skills: null` as a whole-repo source', () => {
  const out = validateSourcesFile([{ id: 'o-r', title: 'o/r', kind: 'github', repo: 'o/r', paths: ['a'], skills: null, enabled: true }])
  assert.deepEqual(out.find(s => s.id === 'o-r'), { id: 'o-r', title: 'o/r', kind: 'github', repo: 'o/r', paths: ['a'], enabled: true })
})

test('validateSourcesFile drops a malformed pick entry but keeps the source while a safe pick remains', () => {
  for (const bad of [{}, 1, null, { path: 7 }]) {
    const out = validateSourcesFile([{ ...PICK_SOURCE, skills: [{ path: 'a/ok' }, bad] }])
    assert.deepEqual(out.find(s => s.id === 'humanlayer-skills')?.skills, [{ path: 'a/ok' }], `entry ${JSON.stringify(bad)} is dropped, the source kept`)
  }
})

// ------------------------------------------------------------ B4 addSkillFromUrl --

/**
 * Repos the add tests link into, as `owner/name` (lowercase) -> ref -> blob paths.
 * Spec B4 step 2b: adding resolves the link's ref and requires the pick in the tree.
 */
const SERVED = {
  'humanlayer/skills': {
    main: ['plugins/show-me/skills/show-me/SKILL.md', 'plugins/other/skills/second/SKILL.md', 'elsewhere/show-me/SKILL.md', 'a/b/SKILL.md'],
    stable: ['plugins/show-me/skills/show-me/SKILL.md'],
    v2: ['plugins/x/skills/y/SKILL.md'],
  },
  'some.org/my_repo': { 'v1.2': ['skills/thing/SKILL.md'] },
  'obra/superpowers': { main: ['skills/brainstorming/SKILL.md'] },
}

/**
 * A fake GitHub serving `served` (never the network). `mode.down` makes every
 * call fail like a dropped connection; `mode.status` answers every call with
 * that HTTP error (e.g. a 403 rate limit); `mode.truncated` marks every tree
 * listing as truncated. Records every URL so a test can tell a tree lookup
 * from a bundle download.
 */
function servingGithub(served, mode = {}) {
  const calls = []
  const ok = body => ({ ok: true, status: 200, text: async () => JSON.stringify(mode.truncated === true && body.tree !== undefined ? { ...body, truncated: true } : body), arrayBuffer: async () => new ArrayBuffer(0) })
  const missing = { ok: false, status: 404, text: async () => 'Not Found', arrayBuffer: async () => new ArrayBuffer(0) }
  const fetch = async (url) => {
    calls.push(url)
    if (mode.down === true) throw new Error('ECONNRESET')
    if (mode.status !== undefined) return { ok: false, status: mode.status, text: async () => 'API rate limit exceeded', arrayBuffer: async () => new ArrayBuffer(0) }
    const c = url.match(/^https:\/\/api\/repos\/([^/]+)\/([^/]+)\/commits\/([^?]+)$/)
    if (c) {
      const repo = `${c[1]}/${c[2]}`.toLowerCase()
      const ref = decodeURIComponent(c[3])
      return served[repo]?.[ref] !== undefined ? ok({ sha: `${repo}@${ref}` }) : missing
    }
    const t = url.match(/^https:\/\/api\/repos\/[^/]+\/[^/]+\/git\/trees\/([^?]+)/)
    if (t) {
      const [repo, ref] = decodeURIComponent(t[1]).split('@')
      const files = served[repo]?.[ref]
      return files === undefined ? missing : ok({ tree: files.map(path => ({ path, type: 'blob', sha: `${path}@${ref}` })) })
    }
    const meta = url.match(/^https:\/\/api\/repos\/([^/]+)\/([^/]+)$/)
    if (meta) return served[`${meta[1]}/${meta[2]}`.toLowerCase()] !== undefined ? ok({ default_branch: 'main' }) : missing
    return missing
  }
  return { calls, client: new github.GithubClient({ fetch, apiBase: 'https://api', rawBase: 'https://raw', timeoutMs: 1000 }) }
}

/** A service over a temp workbench whose GitHub is `servingGithub(served, mode)`. */
async function serviceSetup(sources, served = SERVED, mode = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skp-add-'))
  const paths = new StorePaths(root)
  const gh = servingGithub(served, mode)
  const library = new Library({ paths: () => paths, github: gh.client, rules: async () => BUILTIN_NORMALIZE_RULES, now: () => new Date('2026-01-02T00:00:00Z') })
  const svc = new SkillPresetsService({ root: () => root, library, now: () => new Date('2026-01-02T00:00:00Z') })
  await svc.saveSources(sources)
  const raw = async () => await readFile(svc.paths().sources, 'utf8')
  const rawFetches = () => gh.calls.filter(url => url.startsWith('https://raw/'))
  return { svc, raw, calls: gh.calls, rawFetches, mode }
}

const SUPERPOWERS = { id: 'obra-superpowers', title: 'obra/superpowers', kind: 'github', repo: 'obra/superpowers', paths: ['skills'], enabled: true }

async function add(svc, url) {
  assert.equal(typeof svc.addSkillFromUrl, 'function', 'SkillPresetsService must have addSkillFromUrl')
  return await svc.addSkillFromUrl(url)
}

async function rejectsWith(svc, url, pattern) {
  assert.equal(typeof svc.addSkillFromUrl, 'function', 'SkillPresetsService must have addSkillFromUrl')
  await assert.rejects(svc.addSkillFromUrl(url), pattern)
}

test('addSkillFromUrl creates a pick source for a new repo and persists it', async () => {
  const { svc, calls, rawFetches } = await serviceSetup([SUPERPOWERS])
  const out = await add(svc, SHOW_ME)
  const expected = {
    id: 'humanlayer-skills', title: 'humanlayer/skills', kind: 'github', repo: 'humanlayer/skills', ref: 'main',
    skills: [{ path: 'plugins/show-me/skills/show-me' }], enabled: true,
  }
  assert.equal(out.created, true)
  assert.equal(out.dir, 'show-me')
  assert.deepEqual(out.source, expected)
  assert.deepEqual((await svc.sources()).find(s => s.id === 'humanlayer-skills'), expected)
  assert.ok((await svc.sources()).some(s => s.id === 'obra-superpowers'), 'other sources are kept')
  // Spec B4 2b: the pick is verified against the link's tree, but no bundle file is downloaded.
  assert.ok(calls.some(url => /\/repos\/humanlayer\/skills\/git\/trees\//.test(url)), `the tree at the link's ref is read (calls: ${calls.join(', ')})`)
  assert.deepEqual(rawFetches(), [], 'adding downloads no skill files; installing is the caller\'s step')
})

test('addSkillFromUrl takes the ref from the link and derives a sanitized lowercase id', async () => {
  const { svc } = await serviceSetup([SUPERPOWERS])
  const out = await add(svc, 'https://github.com/Some.Org/My_Repo/tree/v1.2/skills/thing')
  assert.equal(out.source.id, 'some.org-my_repo')
  assert.equal(out.source.title, 'Some.Org/My_Repo')
  assert.equal(out.source.ref, 'v1.2')
  assert.deepEqual(out.source.skills, [{ path: 'skills/thing' }])
  assert.equal(out.dir, 'thing')
})

test('addSkillFromUrl appends a second pick to the same repo and ref', async () => {
  const { svc } = await serviceSetup([SUPERPOWERS])
  await add(svc, SHOW_ME)
  const out = await add(svc, 'https://github.com/HumanLayer/Skills/blob/main/plugins/other/skills/second/SKILL.md')
  assert.equal(out.created, false)
  assert.equal(out.dir, 'second')
  assert.deepEqual(out.source.skills, [{ path: 'plugins/show-me/skills/show-me' }, { path: 'plugins/other/skills/second' }])
  const stored = (await svc.sources()).filter(s => s.repo?.toLowerCase() === 'humanlayer/skills')
  assert.equal(stored.length, 1, 'one source per repo, matched case-insensitively')
  assert.deepEqual(stored[0].skills, out.source.skills)
})

test('addSkillFromUrl is idempotent for a repeated identical pick', async () => {
  const { svc, raw, rawFetches } = await serviceSetup([SUPERPOWERS])
  await add(svc, SHOW_ME)
  const before = await raw()
  const out = await add(svc, `${SHOW_ME}?plain=1`)
  assert.equal(out.created, false)
  assert.equal(out.dir, 'show-me')
  assert.deepEqual(out.source.skills, [{ path: 'plugins/show-me/skills/show-me' }])
  assert.equal(await raw(), before, 'sources.json is unchanged')
  // Whether the repeat re-reads the tree is left open; it never downloads files.
  assert.deepEqual(rawFetches(), [])
})

test('addSkillFromUrl rejects a pick whose dir clashes with another pick in the source', async () => {
  const { svc, raw } = await serviceSetup([SUPERPOWERS])
  await add(svc, SHOW_ME)
  const before = await raw()
  await rejectsWith(svc, 'https://github.com/humanlayer/skills/blob/main/elsewhere/show-me/SKILL.md', /show-me/)
  assert.equal(await raw(), before)
})

test('addSkillFromUrl rejects a repo already installed as a whole-repo source', async () => {
  const { svc, raw } = await serviceSetup([SUPERPOWERS])
  const before = await raw()
  await rejectsWith(svc, 'https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md', /"obra-superpowers" already installs the whole repository/)
  assert.equal(await raw(), before)
})

test('addSkillFromUrl rejects a different ref for an existing pick source, naming the existing ref', async () => {
  const { svc, raw } = await serviceSetup([SUPERPOWERS])
  await add(svc, 'https://github.com/humanlayer/skills/blob/stable/plugins/show-me/skills/show-me/SKILL.md')
  const before = await raw()
  await rejectsWith(svc, 'https://github.com/humanlayer/skills/blob/v2/plugins/x/skills/y/SKILL.md', /stable/)
  assert.equal(await raw(), before)
})

test('addSkillFromUrl rejects when the derived id is taken by a different repo', async () => {
  const squatter = { id: 'humanlayer-skills', title: 'not it', kind: 'github', repo: 'someone/else', paths: ['skills'], enabled: true }
  const { svc, raw } = await serviceSetup([squatter])
  const before = await raw()
  await rejectsWith(svc, SHOW_ME, /humanlayer-skills/)
  assert.equal(await raw(), before)
})

test('addSkillFromUrl rejects an invalid link with the parser\'s message', async () => {
  const { svc, raw } = await serviceSetup([SUPERPOWERS])
  const before = await raw()
  const bad = 'https://gitlab.com/o/r/blob/main/a/b/SKILL.md'
  const { error } = parse(bad)
  assert.equal(typeof error, 'string')
  await rejectsWith(svc, bad, (thrown) => thrown instanceof Error && thrown.message.includes(error))
  assert.equal(await raw(), before)
})

// ------------------------------------------- B4 2b: verify the pick before saving --

test('addSkillFromUrl rejects a pick absent at the link\'s ref, naming path and ref and suggesting a commit', async () => {
  const { svc, raw, rawFetches } = await serviceSetup([SUPERPOWERS])
  const before = await raw()
  await rejectsWith(svc, 'https://github.com/humanlayer/skills/blob/main/plugins/nope/skills/nope/SKILL.md', (thrown) => {
    assert.ok(thrown instanceof Error)
    assert.match(thrown.message, /plugins\/nope\/skills\/nope/, 'names the path')
    assert.match(thrown.message, /main/, 'names the ref')
    assert.match(thrown.message, /commit/, 'says a commit can be linked instead')
    return true
  })
  assert.equal(await raw(), before, 'sources.json is byte-identical')
  assert.deepEqual(rawFetches(), [])
})

test('addSkillFromUrl rejects a link on a branch whose name contains "/" (ref resolves elsewhere or not at all)', async () => {
  const link = 'https://github.com/humanlayer/skills/blob/feature/x/skills/a/SKILL.md'
  // The parser sees ref "feature" and path "x/skills/a". First: no "feature" ref upstream (404).
  const gone = await serviceSetup([SUPERPOWERS])
  const goneBefore = await gone.raw()
  await rejectsWith(gone.svc, link, /./)
  assert.equal(await gone.raw(), goneBefore, 'sources.json is byte-identical after a 404')
  // Second: a "feature" branch exists but has no x/skills/a.
  const served = { ...SERVED, 'humanlayer/skills': { ...SERVED['humanlayer/skills'], feature: ['other/SKILL.md'] } }
  const other = await serviceSetup([SUPERPOWERS], served)
  const otherBefore = await other.raw()
  await rejectsWith(other.svc, link, /x\/skills\/a[\s\S]*commit|commit[\s\S]*x\/skills\/a/)
  assert.equal(await other.raw(), otherBefore, 'sources.json is byte-identical when the pick is absent')
})

test('addSkillFromUrl rejects when the tree cannot be fetched, leaving sources.json untouched', async () => {
  const { svc, raw, mode } = await serviceSetup([SUPERPOWERS])
  const before = await raw()
  mode.down = true
  await rejectsWith(svc, SHOW_ME, /./)
  assert.equal(await raw(), before, 'a network failure saves nothing')
  mode.down = false
  const unknown = await serviceSetup([SUPERPOWERS])
  const unknownBefore = await unknown.raw()
  await rejectsWith(unknown.svc, 'https://github.com/ghost/repo/blob/main/skills/a/SKILL.md', /./)
  assert.equal(await unknown.raw(), unknownBefore, 'a 404 saves nothing')
})

test('addSkillFromUrl saves a raw refs/heads/main link under ref "main", so a later blob link on main appends', async () => {
  const { svc } = await serviceSetup([SUPERPOWERS])
  const first = await add(svc, 'https://raw.githubusercontent.com/humanlayer/skills/refs/heads/main/a/b/SKILL.md')
  assert.equal(first.source.ref, 'main')
  assert.deepEqual(first.source.skills, [{ path: 'a/b' }])
  const second = await add(svc, SHOW_ME)
  assert.equal(second.created, false)
  assert.deepEqual(second.source.skills, [{ path: 'a/b' }, { path: 'plugins/show-me/skills/show-me' }])
})

test('a rejected add leaves no source behind, so the corrected link then creates the source', async () => {
  const { svc } = await serviceSetup([SUPERPOWERS])
  await rejectsWith(svc, 'https://github.com/humanlayer/skills/blob/main/plugins/typo/skills/show-me/SKILL.md', /./)
  assert.equal((await svc.sources()).find(s => s.repo?.toLowerCase() === 'humanlayer/skills'), undefined, 'nothing saved for the bad link')
  const out = await add(svc, SHOW_ME)
  assert.equal(out.created, true)
  assert.deepEqual(out.source.skills, [{ path: 'plugins/show-me/skills/show-me' }])
})

test('addSkillFromUrl rejects adding into a disabled source', async () => {
  const disabled = { ...PICK_SOURCE, skills: [{ path: 'plugins/other/skills/second' }], enabled: false }
  const { svc, raw } = await serviceSetup([SUPERPOWERS, disabled])
  const before = await raw()
  await rejectsWith(svc, SHOW_ME, /disabled/)
  assert.equal(await raw(), before)
})

test('addSkillFromUrl, for a pick source without a ref, tells the user to set `ref` in sources.json', async () => {
  const { ref: _ref, ...noRef } = { ...PICK_SOURCE, skills: [{ path: 'plugins/other/skills/second' }] }
  const { svc, raw } = await serviceSetup([SUPERPOWERS, noRef])
  const before = await raw()
  await rejectsWith(svc, SHOW_ME, (thrown) => {
    assert.ok(thrown instanceof Error)
    assert.match(thrown.message, /sources\.json/)
    assert.match(thrown.message, /\bref\b/)
    return true
  })
  assert.equal(await raw(), before)
})

// ------------------------------------------- B4 3: sources.json write safety --

/** Run `body` with Date.now frozen, so writes in "the same millisecond" are certain, not lucky. */
async function withFrozenClock(body) {
  const real = Date.now
  const frozen = real()
  Date.now = () => frozen
  try { return await body() } finally { Date.now = real }
}

test('concurrent saveSources calls in the same millisecond all succeed and leave one complete sources.json', async () => {
  const { svc, raw } = await serviceSetup([SUPERPOWERS])
  const variants = Array.from({ length: 20 }, (_, i) => [SUPERPOWERS, { id: `extra-${i}`, title: `e${i}`, kind: 'github', repo: `o/e${i}`, enabled: true }])
  const results = await withFrozenClock(async () => await Promise.allSettled(variants.map(v => svc.saveSources(v))))
  assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason?.message), [], 'no write collides')
  const stored = JSON.stringify(JSON.parse(await raw()))
  assert.ok(variants.some(v => JSON.stringify(validateSourcesFile(v)) === stored), `the file is exactly one of the written lists: ${stored}`)
})

test('addSkillFromUrl racing saveSources in the same millisecond neither throws nor corrupts sources.json', async () => {
  const { svc, raw } = await serviceSetup([SUPERPOWERS])
  const other = [SUPERPOWERS, { id: 'other', title: 'o', kind: 'github', repo: 'o/o', enabled: true }]
  const results = await withFrozenClock(async () => await Promise.allSettled([svc.addSkillFromUrl(SHOW_ME), svc.saveSources(other)]))
  assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason?.message), [])
  const ids = JSON.parse(await raw()).map(s => s.id).sort()
  const outcomes = [['humanlayer-skills', 'local', 'obra-superpowers'], ['local', 'obra-superpowers', 'other'], ['humanlayer-skills', 'local', 'obra-superpowers', 'other']]
  assert.ok(outcomes.some(o => JSON.stringify(o) === JSON.stringify(ids)), `a complete outcome, got ${ids.join(', ')}`)
})

// ------------------------------------------- review round 2 (spec B4 2b) --

test('a second pick into an existing source is verified too: a typo is rejected, then the right pick is added', async () => {
  const { svc, raw } = await serviceSetup([SUPERPOWERS])
  assert.equal((await add(svc, SHOW_ME)).created, true)
  const afterFirst = await raw()
  await rejectsWith(svc, 'https://github.com/humanlayer/skills/blob/main/plugins/typo/skills/second/SKILL.md', (thrown) => {
    assert.ok(thrown instanceof Error)
    assert.match(thrown.message, /plugins\/typo\/skills\/second/, 'names the path')
    assert.match(thrown.message, /main/, 'names the ref')
    assert.match(thrown.message, /commit/)
    return true
  })
  assert.equal(await raw(), afterFirst, 'sources.json is byte-identical to its state after the first add')
  const out = await add(svc, 'https://github.com/humanlayer/skills/blob/main/plugins/other/skills/second/SKILL.md')
  assert.equal(out.created, false)
  assert.deepEqual((await svc.sources()).find(s => s.id === 'humanlayer-skills').skills, [{ path: 'plugins/show-me/skills/show-me' }, { path: 'plugins/other/skills/second' }])
})

test('a truncated tree cannot prove a pick absent: the add is accepted without verification', async () => {
  const { svc } = await serviceSetup([SUPERPOWERS], SERVED, { truncated: true })
  const out = await add(svc, 'https://github.com/humanlayer/skills/blob/main/plugins/beyond/skills/listing/SKILL.md')
  assert.equal(out.created, true)
  assert.deepEqual((await svc.sources()).find(s => s.id === 'humanlayer-skills').skills, [{ path: 'plugins/beyond/skills/listing' }])
})

test('a truncated tree that does list the pick saves it', async () => {
  const { svc } = await serviceSetup([SUPERPOWERS], SERVED, { truncated: true })
  const out = await add(svc, SHOW_ME)
  assert.equal(out.created, true)
  assert.deepEqual(out.source.skills, [{ path: 'plugins/show-me/skills/show-me' }])
})

test('a tree that cannot be read is reported with repo and ref, without the slash-branch hint', async () => {
  for (const mode of [{ down: true }, { status: 403 }]) {
    const { svc, raw } = await serviceSetup([SUPERPOWERS], SERVED, mode)
    const before = await raw()
    await rejectsWith(svc, SHOW_ME, (thrown) => {
      assert.ok(thrown instanceof Error)
      assert.match(thrown.message, /humanlayer\/skills/i, `names the repo (${JSON.stringify(mode)})`)
      assert.match(thrown.message, /main/, 'names the ref')
      assert.doesNotMatch(thrown.message, /branch name/i, `a ${JSON.stringify(mode)} failure is not a slash-branch problem: ${thrown.message}`)
      return true
    })
    assert.equal(await raw(), before)
  }
})

test('a hand-written source with `skills: null` survives sources() and a later add for another repo', async () => {
  const { svc, raw } = await serviceSetup([SUPERPOWERS])
  const { writeFile } = await import('node:fs/promises')
  const stored = JSON.parse(await raw())
  await writeFile(svc.paths().sources, JSON.stringify([...stored, { id: 'o-r', title: 'o/r', kind: 'github', repo: 'o/r', paths: ['a'], skills: null, enabled: true }]))
  assert.ok((await svc.sources()).some(s => s.id === 'o-r'), 'read back as a whole-repo source')
  await add(svc, SHOW_ME)
  const kept = (await svc.sources()).find(s => s.id === 'o-r')
  assert.deepEqual(kept, { id: 'o-r', title: 'o/r', kind: 'github', repo: 'o/r', paths: ['a'], enabled: true }, 'the next write keeps it')
})

// ------------------------------------------------------------ B5 CLI --

function cli(args, root) {
  return new Promise((resolve) => {
    const child = execFile('node', [join(ROOT, 'lib/bin/cli.js'), ...args], { env: { ...process.env, DSH_SKILL_PRESETS_ROOT: root } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
    child.stdin.end()
  })
}

test('CLI usage lists `add-skill <url>`', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skp-cli-'))
  const out = await cli([], root)
  assert.equal(out.code, 0)
  assert.match(out.stdout, /add-skill <url>/)
})

test('CLI `add-skill` exits 1 with the parser\'s message on a rejected link, before any fetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skp-cli-'))
  const bad = 'https://gitlab.com/o/r/blob/main/a/b/SKILL.md'
  const out = await cli(['add-skill', bad], root)
  assert.equal(out.code, 1, `stdout: ${out.stdout}\nstderr: ${out.stderr}`)
  const { error } = parse(bad)
  assert.ok(`${out.stdout}${out.stderr}`.includes(error), `the parser's message is printed: ${out.stderr}`)
})
