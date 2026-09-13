import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeBridge, skillNameFor, renderSkill } from '../lib/host/knowledge.js'
import { parseSkill } from '../lib/host/frontmatter.js'
import { StorePaths } from '../lib/host/store.js'

const node = (id, over = {}) => ({ id, domain: 'workflow', title: `Rule ${id}`, body: `Always do ${id}. Because reasons.`, kind: 'workflow', confidence: 2, hits: 5, ...over })

async function wb(globalNodes, projectNodes = []) {
  const root = await mkdtemp(join(tmpdir(), 'skp-kn-'))
  await mkdir(join(root, 'knowledge'), { recursive: true })
  await writeFile(join(root, 'knowledge', 'global.json'), JSON.stringify({ version: 1, nodes: globalNodes, totalHits: 0 }))
  if (projectNodes.length > 0) {
    await mkdir(join(root, 'projects', 'p-1'), { recursive: true })
    await writeFile(join(root, 'projects', 'p-1', 'knowledge.json'), JSON.stringify({ version: 1, nodes: projectNodes }))
  }
  return { root, paths: new StorePaths(root) }
}

test('skillNameFor drops stop-words, caps length, stays kebab-case', () => {
  assert.equal(skillNameFor('Never git reset --hard in a repo with someone else\'s uncommitted work'), 'git-reset-hard-repo-someone-else-s-uncommitted')
  assert.match(skillNameFor('The DSH session log can recover uncommitted work'), /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(skillNameFor('x'.repeat(200)).length <= 48)
  assert.equal(skillNameFor('!!!'), 'insight')
})

test('renderSkill yields a SKILL.md the plugin parser accepts, with the insight as body and a back-link', () => {
  const text = renderSkill(node('a1', { title: 'Loader patch entries use id + config', domain: 'dsh-config', hits: 12 }), 'loader-patch-entries')
  const parsed = parseSkill(text)
  assert.ok(!('error' in parsed), JSON.stringify(parsed))
  assert.equal(parsed.name, 'loader-patch-entries')
  assert.match(parsed.description, /Loader patch entries use id \+ config/)
  assert.ok(parsed.whenToUse.includes('dsh-config'))
  assert.match(parsed.body, /Promoted from a dsh-knowledge workflow \(id `a1`/)
  assert.match(parsed.body, /Always do a1/)
})

test('candidates filter by kind, confidence-or-hits, retirement; promotion is recorded and refuses to clobber', async () => {
  const { paths } = await wb([
    node('keep'),
    node('lowconf-manyhits', { confidence: 1, hits: 100 }),
    node('lowconf-fewhits', { confidence: 1, hits: 3 }),
    node('gotcha', { kind: 'gotcha', confidence: 3 }),
    node('retired', { retiredAt: 'x' }),
    node('superseded', { supersededBy: 'keep' }),
  ], [node('proj', { kind: 'convention' })])
  const bridge = new KnowledgeBridge(() => paths, () => new Date('2026-05-05T00:00:00Z'))
  const cands = await bridge.candidates()
  assert.deepEqual(cands.map(c => c.id).sort(), ['keep', 'lowconf-manyhits', 'proj'])
  assert.equal(cands.find(c => c.id === 'proj').scope, 'project')

  const out = await bridge.promote('keep')
  assert.equal(out.name, 'rule-keep')
  const text = await readFile(join(out.dir, 'SKILL.md'), 'utf8')
  assert.match(text, /name: rule-keep/)
  assert.equal((await bridge.candidates()).find(c => c.id === 'keep').promotedTo, 'rule-keep')
  await assert.rejects(bridge.promote('lowconf-manyhits', { name: 'rule-keep' }), /already exists/)
  await bridge.promote('lowconf-manyhits', { name: 'rule-keep', force: true })
  assert.equal((await bridge.promotions()).promotions.length, 2)
  await assert.rejects(bridge.promote('nope'), /not found/)
  await assert.rejects(bridge.promote('gotcha', { name: 'Bad Name' }), /not a valid skill name/)
})
