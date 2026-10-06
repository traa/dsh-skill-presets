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

// ------------------------------------------------------------ B4 addSkillFromUrl --

/** A service whose GitHub client fails the test if it is ever called. */
async function serviceSetup(sources) {
  const root = await mkdtemp(join(tmpdir(), 'skp-add-'))
  const paths = new StorePaths(root)
  const network = []
  const client = new github.GithubClient({ fetch: async (url) => { network.push(url); throw new Error(`network touched: ${url}`) }, apiBase: 'https://api', rawBase: 'https://raw', timeoutMs: 1000 })
  const library = new Library({ paths: () => paths, github: client, rules: async () => BUILTIN_NORMALIZE_RULES, now: () => new Date('2026-01-02T00:00:00Z') })
  const svc = new SkillPresetsService({ root: () => root, library, now: () => new Date('2026-01-02T00:00:00Z') })
  await svc.saveSources(sources)
  const raw = async () => await readFile(svc.paths().sources, 'utf8')
  return { svc, raw, network }
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
  const { svc, network } = await serviceSetup([SUPERPOWERS])
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
  assert.deepEqual(network, [], 'adding never fetches; installing is the caller\'s step')
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
  const { svc, raw } = await serviceSetup([SUPERPOWERS])
  await add(svc, SHOW_ME)
  const before = await raw()
  const out = await add(svc, `${SHOW_ME}?plain=1`)
  assert.equal(out.created, false)
  assert.equal(out.dir, 'show-me')
  assert.deepEqual(out.source.skills, [{ path: 'plugins/show-me/skills/show-me' }])
  assert.equal(await raw(), before, 'sources.json is unchanged')
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
