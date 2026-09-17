import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

import { decideWorktreeGate } from '../lib/host/practices/gate.js'
import { readGitFacts } from '../lib/host/practices/git.js'
import { defaultPractices } from '../lib/host/curated.js'
import { validatePractices } from '../lib/host/store.js'

const REPO = '/repo'
const facts = (over = {}) => ({ inRepo: true, gitAvailable: true, isWorktree: false, branch: 'main', ahead: 0, hasUpstream: true, dirty: false, ghAvailable: true, topLevel: REPO, artifacts: [], instructionFiles: [], readAt: 'r', ...over })

const doc = (over = {}) => ({
  version: 1,
  strictSkills: false,
  instructionFiles: [],
  protectedBranches: ['main', 'master'],
  autoCleanWorktrees: false,
  pruning: { minSessions: 1, maxLoadRate: 1, minUnknown: 1 },
  practices: [{ id: 'worktree', mode: 'hard', params: {} }],
  ...over,
})

const pendingEdit = { name: 'edit', filePath: 'src/x.ts' }

test('worktree gate: deny when mode is hard + mutating + primary checkout + protected branch', () => {
  const result = decideWorktreeGate(facts(), pendingEdit, doc())
  assert.equal(result.allow, false)
  assert.equal(result.practice, 'worktree')
})

test('worktree gate: allow inside a linked worktree', () => {
  const result = decideWorktreeGate(facts({ isWorktree: true }), pendingEdit, doc())
  assert.equal(result.allow, true)
})

test('worktree gate: allow in primary checkout when branch is not protected', () => {
  const result = decideWorktreeGate(facts({ branch: 'feat/x' }), pendingEdit, doc())
  assert.equal(result.allow, true)
})

test('worktree gate: allow when mode is advisory or off', () => {
  const advisoryDoc = doc({ practices: [{ id: 'worktree', mode: 'advisory', params: {} }] })
  assert.equal(decideWorktreeGate(facts(), pendingEdit, advisoryDoc).allow, true)
  
  const offDoc = doc({ practices: [{ id: 'worktree', mode: 'off', params: {} }] })
  assert.equal(decideWorktreeGate(facts(), pendingEdit, offDoc).allow, true)
})

test('worktree gate: degrade to allow on malformed inputs', () => {
  // Empty inputs shouldn't throw, they should return allow
  assert.equal(decideWorktreeGate({}, {}, {}).allow, true)
  assert.equal(decideWorktreeGate(undefined, undefined, undefined).allow, true)
  assert.equal(decideWorktreeGate(null, null, null).allow, true)
  assert.equal(decideWorktreeGate(facts({ branch: undefined }), pendingEdit, doc()).allow, true)
})

test('worktree gate: anti-divergence - CLI path and native path produce the same decision', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-test-'))
  const repoDir = path.join(tmpBase, 'repo')
  const wtDir = path.join(tmpBase, 'wt')
  const storeDir = path.join(tmpBase, 'store')
  
  try {
    await fs.mkdir(repoDir)
    await fs.mkdir(storeDir)
    
    // Create an empty practices.json to use the default curated practices (which defaults to 'hard' mode for worktree)
    await fs.writeFile(path.join(storeDir, 'practices.json'), JSON.stringify({ version: 1, practices: [{id: 'worktree', mode: 'hard', params: {}}] }))
    
    await execAsync('git init', { cwd: repoDir })
    await fs.writeFile(path.join(repoDir, 'a.txt'), 'hello')
    await execAsync('git add .', { cwd: repoDir })
    await execAsync('git commit -m init', { cwd: repoDir })
    await execAsync('git branch -m main', { cwd: repoDir }) 
    await execAsync('git worktree add ../wt -b feat/x', { cwd: repoDir })

    const cliPath = path.resolve('./lib/bin/cli.js')
    
    const spellings = [
      { name: 'edit', tool_input: { file_path: 'a.txt' }, isWrite: true },
      { name: 'Edit', tool_input: { file_path: 'a.txt' }, isWrite: true },
      { name: 'write', tool_input: { file_path: 'a.txt' }, isWrite: true },
      { name: 'Write', tool_input: { file_path: 'a.txt' }, isWrite: true },
      { name: 'multi_edit', tool_input: { file_path: 'a.txt' }, isWrite: true },
      { name: 'MultiEdit', tool_input: { file_path: 'a.txt' }, isWrite: true },
      { name: 'multiedit', tool_input: { file_path: 'a.txt' }, isWrite: true },
      { name: 'notebook_edit', tool_input: { file_path: 'a.txt' }, isWrite: true },
      { name: 'bash', tool_input: { command: 'rm -rf x' }, isWrite: true },
      { name: 'bash', tool_input: { command: 'ls' }, isWrite: false },
    ]

    const fixtures = [
      { label: 'primary checkout', cwd: repoDir, deniesWrite: true },
      { label: 'linked worktree', cwd: wtDir, deniesWrite: false },
    ]
    
    // Both use default configuration from store (empty practices.json -> defaults)
    const testDoc = validatePractices({}, defaultPractices)
    
    for (const fixture of fixtures) {
      for (const spell of spellings) {
        const expectedBlock = fixture.deniesWrite && spell.isWrite
        const label = `${fixture.label} - ${spell.name} (${spell.isWrite ? 'mutating' : 'readonly'})`

        const stdinStr = JSON.stringify({
          cwd: fixture.cwd,
          tool_name: spell.name,
          tool_input: spell.tool_input
        })

        let stdout = ''
        try {
          const result = await execAsync(`echo '${stdinStr}' | node ${cliPath} check worktree --hook claude-code --json`, {
            cwd: tmpBase,
            env: { ...process.env, DSH_SKILL_PRESETS_ROOT: storeDir } 
          })
          stdout = result.stdout
        } catch (err) {
          stdout = err.stdout
        }
        
        const cliResult = JSON.parse(stdout.trim())
        assert.equal(cliResult.block, expectedBlock, `CLI path mismatch for: ${label}`)
        
        // Native path
        const nativeFacts = await readGitFacts(fixture.cwd, { instructionFiles: [] })
        const nativePending = { name: spell.name, filePath: spell.tool_input.file_path, command: spell.tool_input.command }
        const nativeDecision = decideWorktreeGate(nativeFacts, nativePending, testDoc)
        
        assert.equal(!nativeDecision.allow, expectedBlock, `Native path mismatch for: ${label}`)
      }
    }
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true })
  }
})

test('worktree gate: migration - retains advisory mode if configured, defaults to hard if absent', () => {
  // (a) defaultPractices() returns worktree practice with mode 'hard'
  const def = defaultPractices()
  const defWorktree = def.practices.find(p => p.id === 'worktree')
  assert.equal(defWorktree.mode, 'hard', 'shipped default must be hard')

  // (b) the store normalisation preserves an existing advisory mode
  const rawAdvisory = { version: 1, practices: [{ id: 'worktree', mode: 'advisory', params: {} }] }
  const normalisedAdvisory = validatePractices(rawAdvisory, defaultPractices)
  assert.equal(normalisedAdvisory.practices.find(p => p.id === 'worktree').mode, 'advisory', 'existing advisory must be retained')

  // (c) the gate treats an empty practices list as ALLOW, consistent with degrade-to-allow
  const emptyDoc = doc({ practices: [] })
  assert.equal(decideWorktreeGate(facts(), pendingEdit, emptyDoc).allow, true, 'missing entry in practices list degrades to allow')
})

test('worktree gate: exemption - exemptions array composite state', () => {
  const now = Date.now();
  const futureIso = new Date(now + 100000).toISOString();
  const pastIso = new Date(now - 100000).toISOString();
  
  const combinations = [
    { desc: 'active + repo listed', exemptions: [{ repo: REPO, until: futureIso, reason: 'test' }], expectAllow: true },
    { desc: 'active + repo not listed', exemptions: [{ repo: '/other', until: futureIso, reason: 'test' }], expectAllow: false },
    { desc: 'active + array empty', exemptions: [], expectAllow: false },
    { desc: 'active + array absent', exemptions: undefined, expectAllow: false },
    
    { desc: 'expired + repo listed', exemptions: [{ repo: REPO, until: pastIso, reason: 'test' }], expectAllow: false },
    { desc: 'expired + repo not listed', exemptions: [{ repo: '/other', until: pastIso, reason: 'test' }], expectAllow: false },
    
    { desc: 'absent + repo listed (missing until)', exemptions: [{ repo: REPO, reason: 'test' }], expectAllow: false },

    // TWO repos exempt AT ONCE with DIFFERENT expiries
    { desc: 'A live + B live -> both allow (testing A)', exemptions: [{ repo: REPO, until: futureIso, reason: 'test' }, { repo: '/other', until: futureIso, reason: 'test' }], facts: facts(), expectAllow: true },
    { desc: 'A live + B live -> both allow (testing B)', exemptions: [{ repo: REPO, until: futureIso, reason: 'test' }, { repo: '/other', until: futureIso, reason: 'test' }], facts: facts({ topLevel: '/other' }), expectAllow: true },
    
    { desc: 'A live + B expired -> A allows', exemptions: [{ repo: REPO, until: futureIso, reason: 'test' }, { repo: '/other', until: pastIso, reason: 'test' }], facts: facts(), expectAllow: true },
    { desc: 'A live + B expired -> B denies', exemptions: [{ repo: REPO, until: futureIso, reason: 'test' }, { repo: '/other', until: pastIso, reason: 'test' }], facts: facts({ topLevel: '/other' }), expectAllow: false },

    // fail-closed cases
    { desc: 'until absent/empty', exemptions: [{ repo: REPO, until: '', reason: 'test' }], expectAllow: false },
    { desc: 'until unparseable', exemptions: [{ repo: REPO, until: 'not-a-date', reason: 'test' }], expectAllow: false },
    { desc: 'repo absent/empty', exemptions: [{ repo: '', until: futureIso, reason: 'test' }], expectAllow: false },

    // topLevelAlias coverage
    { desc: 'repo matches topLevelAlias', exemptions: [{ repo: '/private/tmp/repo', until: futureIso, reason: 'test' }], facts: facts({ topLevel: '/tmp/repo', topLevelAlias: '/private/tmp/repo' }), expectAllow: true },
    { desc: 'repo matches topLevel (alias exists)', exemptions: [{ repo: '/tmp/repo', until: futureIso, reason: 'test' }], facts: facts({ topLevel: '/tmp/repo', topLevelAlias: '/private/tmp/repo' }), expectAllow: true },
  ];
  
  for (const c of combinations) {
    const testDoc = doc({
      ...(c.exemptions !== undefined ? { exemptions: c.exemptions } : {})
    });
    
    const f = c.facts || facts();
    const result = decideWorktreeGate(f, pendingEdit, testDoc, now);
    assert.equal(result.allow, c.expectAllow, `exemption composite: ${c.desc}`);
  }

  const malformedDoc = doc({ exemptions: [{ repo: REPO, until: 'not-a-date', reason: 'test' }] });
  assert.equal(decideWorktreeGate(facts(), pendingEdit, malformedDoc, now).allow, false, 'exemption composite: malformed exemptUntil should DENY');
})


test('subagent inheritance regression: gate decision for child session ID identical to parent', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-test-'))
  const repoDir = path.join(tmpBase, 'repo')
  const wtDir = path.join(tmpBase, 'wt')
  const storeDir = path.join(tmpBase, 'store')
  
  try {
    await fs.mkdir(repoDir)
    await fs.mkdir(storeDir)
    
    // Create an empty practices.json to use the default curated practices (which defaults to 'hard' mode for worktree)
    await fs.writeFile(path.join(storeDir, 'practices.json'), JSON.stringify({ version: 1, practices: [{id: 'worktree', mode: 'hard', params: {}}] }))
    
    await execAsync('git init', { cwd: repoDir })
    await fs.writeFile(path.join(repoDir, 'a.txt'), 'hello')
    await execAsync('git add .', { cwd: repoDir })
    await execAsync('git commit -m init', { cwd: repoDir })
    await execAsync('git branch -m main', { cwd: repoDir }) 
    await execAsync('git worktree add ../wt -b feat/x', { cwd: repoDir })

    const cliPath = path.resolve('./lib/bin/cli.js')
    
    const runCheck = async (cwd, sessionId) => {
      const stdinStr = JSON.stringify({
        cwd,
        tool_name: 'edit',
        tool_input: { file_path: 'a.txt' },
        session_id: sessionId
      })

      let stdout = ''
      try {
        const result = await execAsync(`echo '${stdinStr}' | node ${cliPath} check worktree --hook claude-code --json`, {
          cwd: tmpBase,
          env: { ...process.env, DSH_SKILL_PRESETS_ROOT: storeDir } 
        })
        stdout = result.stdout
      } catch (err) {
        stdout = err.stdout
      }
      
      return JSON.parse(stdout.trim()).block
    }

    const sessionA = 'session-1111'
    const sessionB = 'session-2222'

    const blockRepoA = await runCheck(repoDir, sessionA)
    const blockRepoB = await runCheck(repoDir, sessionB)
    
    const blockWtA = await runCheck(wtDir, sessionA)

    assert.equal(blockRepoA, true, 'primary checkout should block write')
    assert.equal(blockRepoA, blockRepoB, 'two different session IDs in the same repo should get the exact same decision')
    assert.notEqual(blockRepoA, blockWtA, 'the same session in a linked worktree should get a DIFFERENT decision')

  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true })
  }
})
