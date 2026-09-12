import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Library, digestBundle } from '../lib/host/library.js'
import { GithubClient } from '../lib/host/github.js'
import { StorePaths } from '../lib/host/store.js'
import { BUILTIN_NORMALIZE_RULES } from '../lib/host/normalize.js'

function fakeGithub(state) {
  const fetch = async (url) => {
    const ok = body => ({ ok: true, status: 200, text: async () => typeof body === 'string' ? body : JSON.stringify(body) })
    if (url.endsWith('/repos/o/r')) return ok({ default_branch: 'main' })
    const c = url.match(/\/commits\/([^?]+)$/)
    if (c) return ok({ sha: state.history[c[1]] !== undefined ? c[1] : state.commit })
    const t = url.match(/\/git\/trees\/([^?]+)/)
    if (t) {
      const files = state.history[t[1]] ?? state.files
      return ok({ tree: Object.keys(files).map(path => ({ path, type: 'blob', sha: `${path}:${files[path]}` })) })
    }
    const m = url.match(/^https:\/\/raw\/o\/r\/([^/]+)\/(.+)$/)
    if (m) {
      const body = state.history[m[1]]?.[decodeURIComponent(m[2])]
      if (body === undefined) return { ok: false, status: 404, text: async () => 'missing' }
      return ok(body)
    }
    return { ok: false, status: 404, text: async () => 'nope' }
  }
  return new GithubClient({ fetch, apiBase: 'https://api', rawBase: 'https://raw', timeoutMs: 1000 })
}

const SOURCE = { id: 'src', title: 'src', kind: 'github', repo: 'o/r', paths: ['skills'], enabled: true }

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'skp-'))
  const paths = new StorePaths(root)
  const state = { commit: 'c1', files: {}, history: {} }
  const set = (commit, files) => { state.commit = commit; state.files = files; state.history[commit] = files }
  set('c1', {
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: A. See CLAUDE.md.\n---\nbody',
    'skills/alpha/tool.sh': 'echo hi',
    'skills/beta/SKILL.md': '---\nname: beta\ndescription: B\n---\nbody',
  })
  const lib = new Library({ paths: () => paths, github: fakeGithub(state), rules: async () => BUILTIN_NORMALIZE_RULES, now: () => new Date('2026-01-02T00:00:00Z') })
  return { root, paths, state, set, lib }
}

test('install writes bundles, normalizes markdown, records both digests', async () => {
  const { paths, lib } = await setup()
  const report = await lib.sync(SOURCE)
  assert.deepEqual(report.added.sort(), ['alpha', 'beta'])
  const skill = await readFile(join(paths.skillDir('src', 'alpha'), 'SKILL.md'), 'utf8')
  assert.ok(!skill.includes('CLAUDE.md'))
  assert.equal(await readFile(join(paths.skillDir('src', 'alpha'), 'tool.sh'), 'utf8'), 'echo hi')
  const lock = await lib.lock()
  const alpha = lock.skills.find(s => s.dir === 'alpha')
  assert.equal(alpha.normalized, true)
  assert.ok(alpha.upstreamDigest !== undefined && alpha.upstreamDigest !== alpha.digest)
  assert.equal(lock.skills.find(s => s.dir === 'beta').normalized, false)
  assert.equal(lock.sources.src.commit, 'c1')
  // Staging is cleaned.
  await assert.rejects(access(join(paths.staging, 'src--alpha--' + process.pid)))
})

test('update reports unchanged/updated/orphaned and keeps history', async () => {
  const { lib, set, state, paths } = await setup()
  await lib.sync(SOURCE)
  set('c2', {
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: A v2\n---\nbody2',
    'skills/alpha/tool.sh': 'echo hi',
    'skills/gamma/SKILL.md': '---\nname: gamma\ndescription: G\n---\n',
  })
  const report = await lib.sync(SOURCE)
  assert.deepEqual(report.updated, ['alpha'])
  assert.deepEqual(report.added, ['gamma'])
  assert.deepEqual(report.orphaned, ['beta'])
  const lock = await lib.lock()
  const alpha = lock.skills.find(s => s.dir === 'alpha')
  assert.equal(alpha.history.length, 1)
  assert.equal(alpha.history[0].commit, 'c1')
  const beta = lock.skills.find(s => s.dir === 'beta')
  assert.equal(beta.orphaned, true)
  // Files of the orphan are kept.
  await access(join(paths.skillDir('src', 'beta'), 'SKILL.md'))
  state.commit = 'c2'
})

test('a skill with a rejected SKILL.md fails alone; others install', async () => {
  const { lib, set } = await setup()
  set('c1', {
    'skills/good/SKILL.md': '---\nname: good\ndescription: ok\n---\n',
    'skills/bad/SKILL.md': '# no frontmatter',
  })
  const report = await lib.sync(SOURCE)
  assert.deepEqual(report.added, ['good'])
  assert.equal(report.failed.length, 1)
  assert.match(report.failed[0].error, /missing frontmatter/)
})

test('check compares upstream tree against the lock without downloading', async () => {
  const { lib, set } = await setup()
  await lib.sync(SOURCE)
  set('c2', {
    'skills/alpha/SKILL.md': 'changed',
    'skills/alpha/tool.sh': 'echo hi',
    'skills/beta/SKILL.md': '---\nname: beta\ndescription: B\n---\nbody',
    'skills/delta/SKILL.md': 'new',
  })
  const report = await lib.check(SOURCE)
  assert.equal(report.lockedCommit, 'c1')
  assert.equal(report.upstreamCommit, 'c2')
  assert.deepEqual(report.changed, ['alpha'])
  assert.deepEqual(report.newUpstream, ['delta'])
})

test('local source is indexed from disk and remove deletes files + lock entry', async () => {
  const { lib, paths } = await setup()
  const dir = paths.skillDir('local', 'mine')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: mine\ndescription: local one\n---\n')
  const report = await lib.sync({ id: 'local', title: 'Local', kind: 'local', enabled: true })
  assert.deepEqual(report.added, ['mine'])
  await lib.remove('local', 'mine')
  assert.equal((await lib.lock()).skills.length, 0)
  await assert.rejects(access(join(dir, 'SKILL.md')))
})

test('digest is order-independent and content-sensitive', () => {
  const a = digestBundle(new Map([['x', '1'], ['y', '2']]))
  const b = digestBundle(new Map([['y', '2'], ['x', '1']]))
  const c = digestBundle(new Map([['y', '2'], ['x', '1!']]))
  assert.equal(a, b)
  assert.notEqual(a, c)
})
