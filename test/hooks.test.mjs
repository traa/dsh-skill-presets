import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildHookFile, renderHookFile, parseHookStdin, HOOK_PLAN } from '../lib/host/hooks.js'

const exec = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('both dialects render a hooks map with one group per plan entry and command hooks only', () => {
  for (const dialect of ['claude-code', 'codex']) {
    const file = buildHookFile(dialect)
    const groups = Object.values(file.hooks).flat()
    assert.equal(groups.length, HOOK_PLAN.length)
    for (const g of groups) for (const h of g.hooks) { assert.equal(h.type, 'command'); assert.match(h.command, /^dsh-skill-presets check [a-z-]+ --hook/) }
    assert.ok(file.hooks.PreToolUse.every(g => typeof g.matcher === 'string'))
    assert.ok(file.hooks.Stop.every(g => g.matcher === undefined))
    const text = renderHookFile(dialect)
    assert.doesNotThrow(() => JSON.parse(text))
  }
  assert.equal(buildHookFile('codex').hooks.PreToolUse[0].matcher, '^(?:write|edit|bash)$')
  assert.equal(buildHookFile('claude-code').hooks.PreToolUse[0].matcher, 'write|edit|bash')
})

test('generated files satisfy what both bridge parsers check: {hooks} map, command type, string command, valid matcher regex, no matcher on Stop', () => {
  // Mirrors packages/hooks/hooks-{claude-code,codex}/src/config.ts: accept `{ hooks: … }`
  // or a bare event map; keep only `type: 'command'` hooks with a string `command`;
  // a matcher on a PreToolUse group must compile as a RegExp (codex: always regex;
  // claude-code: `a|b` literal alternatives, which is also a valid regex).
  for (const dialect of ['claude-code', 'codex']) {
    const raw = JSON.parse(renderHookFile(dialect))
    assert.ok(raw.hooks && typeof raw.hooks === 'object')
    for (const [event, groups] of Object.entries(raw.hooks)) {
      assert.ok(['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart'].includes(event), event)
      for (const group of groups) {
        if (event === 'Stop') assert.equal(group.matcher, undefined)
        if (group.matcher !== undefined) { assert.doesNotThrow(() => new RegExp(group.matcher)); assert.ok(new RegExp(group.matcher).test('edit')) }
        for (const hook of group.hooks) {
          assert.equal(hook.type, 'command')
          assert.equal(typeof hook.command, 'string')
          assert.equal(typeof hook.timeout, 'number')
        }
      }
    }
  }
})

test('parseHookStdin reads both payload shapes and tolerates junk', () => {
  assert.deepEqual(parseHookStdin('{"tool_name":"Edit","tool_input":{"file_path":"/r/a.ts"},"cwd":"/r","session_id":"s"}'), { toolName: 'Edit', filePath: '/r/a.ts', cwd: '/r', sessionId: 's' })
  assert.deepEqual(parseHookStdin('{"tool_name":"bash","tool_input":{"command":"rm x"}}'), { toolName: 'bash', command: 'rm x' })
  assert.deepEqual(parseHookStdin('not json'), {})
})

test('`check` exits 0 in advisory mode and 2 only when red AND hard, with the reason on stderr', async () => {
  const wb = await mkdtemp(join(tmpdir(), 'skp-hook-wb-'))
  const repo = await mkdtemp(join(tmpdir(), 'skp-hook-repo-'))
  const g = (...a) => exec('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  await g('init', '-q', '-b', 'main'); await writeFile(join(repo, 'a'), 'a'); await g('add', '-A'); await g('commit', '-q', '-m', 'i')
  const env = { ...process.env, DSH_SKILL_PRESETS_ROOT: wb }
  const cli = join(ROOT, 'lib/bin/cli.js')
  const run = (args, input) => new Promise((resolve) => {
    const child = execFile('node', [cli, ...args], { env }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
    if (input !== undefined) child.stdin.end(input); else child.stdin.end()
  })
  const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'a') }, cwd: repo })
  // Advisory (default): red but exit 0.
  const advisory = await run(['check', 'worktree', '--hook', 'claude-code', '--json'], payload)
  assert.equal(advisory.code, 0, advisory.stderr)
  const parsed = JSON.parse(advisory.stdout.trim().split('\n').pop())
  assert.equal(parsed.status, 'red'); assert.equal(parsed.block, false)
  // Hard: exit 2 with the reason.
  await run(['status']) // bootstrap the store
  const practicesPath = join(wb, 'skills', 'practices.json')
  const doc = JSON.parse(await (await import('node:fs/promises')).readFile(practicesPath, 'utf8'))
  doc.practices = doc.practices.map(p => p.id === 'worktree' ? { ...p, mode: 'hard' } : p)
  await writeFile(practicesPath, JSON.stringify(doc))
  const hard = await run(['check', 'worktree', '--hook', 'claude-code'], payload)
  assert.equal(hard.code, 2)
  assert.match(hard.stderr, /Work in a worktree.*enforced/)
  assert.match(hard.stderr, /worktree-first/)
  // A read-only tool never blocks.
  const readOnly = await run(['check', 'worktree', '--hook', 'claude-code'], JSON.stringify({ tool_name: 'Read', tool_input: {}, cwd: repo }))
  assert.equal(readOnly.code, 0)
})
