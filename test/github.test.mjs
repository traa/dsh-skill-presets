import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GithubClient, discoverSkills, isRepoSlug } from '../lib/host/github.js'

const TREE = [
  { path: 'README.md', sha: 'r' },
  { path: 'skills/a/SKILL.md', sha: '1' },
  { path: 'skills/a/helper.sh', sha: '2' },
  { path: 'skills/b/SKILL.md', sha: '3' },
  { path: 'skills/notaskill/README.md', sha: '4' },
  { path: 'skills/engineering/tdd/SKILL.md', sha: '5' },
  { path: 'skills/engineering/tdd/notes.md', sha: '6' },
  { path: 'skills/productivity/grill-me/SKILL.md', sha: '7' },
  { path: 'skills/in-progress/wip/SKILL.md', sha: '8' },
]

test('discovers one-level bundles under each root and includes sibling files', () => {
  const flat = discoverSkills(TREE, ['skills'])
  assert.deepEqual(flat.map(s => s.dir), ['a', 'b'])
  assert.deepEqual(flat[0].files.map(f => f.path), ['skills/a/SKILL.md', 'skills/a/helper.sh'])
})

test('nested category roots (mattpocock layout) are listed per configured path only', () => {
  const nested = discoverSkills(TREE, ['skills/engineering', 'skills/productivity'])
  assert.deepEqual(nested.map(s => s.dir).sort(), ['grill-me', 'tdd'])
  assert.ok(!nested.some(s => s.dir === 'wip'))
})

test('repo slug validation', () => {
  assert.ok(isRepoSlug('obra/superpowers'))
  assert.ok(!isRepoSlug('obra'))
  assert.ok(!isRepoSlug('a/b/c'))
})

function fakeFetch(routes) {
  const calls = []
  return {
    calls,
    fetch: async (url) => {
      calls.push(url)
      for (const [pattern, body] of routes) {
        if (url.includes(pattern)) {
          return { ok: true, status: 200, text: async () => typeof body === 'string' ? body : JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) }
        }
      }
      return { ok: false, status: 404, text: async () => 'nope', arrayBuffer: async () => new ArrayBuffer(0) }
    },
  }
}

test('tree resolves default branch → commit → recursive tree; raw fetches by commit', async () => {
  const f = fakeFetch([
    ['/repos/o/r/commits/main', { sha: 'abc123' }],
    ['/repos/o/r/git/trees/abc123', { tree: [{ path: 'skills/x/SKILL.md', type: 'blob', sha: 's' }, { path: 'skills', type: 'tree', sha: 't' }] }],
    ['/repos/o/r', { default_branch: 'main' }],
    ['/o/r/abc123/skills/x/SKILL.md', '---\nname: x\ndescription: d\n---\n'],
  ])
  const client = new GithubClient({ fetch: f.fetch, token: 'tkn', apiBase: 'https://api', rawBase: 'https://raw' })
  const tree = await client.tree('o/r')
  assert.equal(tree.commit, 'abc123')
  assert.deepEqual(tree.entries.map(e => e.path), ['skills/x/SKILL.md'])
  const raw = await client.raw('o/r', tree.commit, 'skills/x/SKILL.md')
  assert.match(raw, /name: x/)
})

test('a 4xx is not retried and carries the status', async () => {
  const f = fakeFetch([])
  const client = new GithubClient({ fetch: f.fetch, apiBase: 'https://api', rawBase: 'https://raw' })
  await assert.rejects(client.tree('o/missing', 'main'), /GitHub 404/)
  assert.equal(f.calls.length, 1)
})

test('a network failure is retried once', async () => {
  let n = 0
  const client = new GithubClient({
    apiBase: 'https://api', rawBase: 'https://raw',
    fetch: async () => { n += 1; throw new Error('ECONNRESET') },
  })
  await assert.rejects(client.raw('o/r', 'c', 'p'), /ECONNRESET/)
  assert.equal(n, 2)
})
