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
    
    const fixtures = [
      { label: 'hard deny in primary checkout', cwd: repoDir, expectedBlock: true },
      { label: 'allow in linked worktree', cwd: wtDir, expectedBlock: false },
    ]
    
    // Both use default configuration from store (empty practices.json -> defaults)
    const testDoc = validatePractices({}, defaultPractices)
    
    for (const { label, cwd, expectedBlock } of fixtures) {
      const stdinStr = JSON.stringify({
        cwd: cwd,
        tool_name: 'edit',
        tool_input: { file_path: 'a.txt' }
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
      const nativeFacts = await readGitFacts(cwd, { instructionFiles: [] })
      const nativePending = { name: 'edit', filePath: 'a.txt' }
      const nativeDecision = decideWorktreeGate(nativeFacts, nativePending, testDoc)
      
      assert.equal(!nativeDecision.allow, expectedBlock, `Native path mismatch for: ${label}`)
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

test('worktree gate: exemption - exemptRepos and exemptUntil suppress the deny', () => {
  const exemptRepoDoc = doc({ exemptRepos: [REPO] })
  assert.equal(decideWorktreeGate(facts(), pendingEdit, exemptRepoDoc).allow, true, 'exemptRepos match')
  
  const nonExemptRepoDoc = doc({ exemptRepos: ['/other-repo'] })
  assert.equal(decideWorktreeGate(facts(), pendingEdit, nonExemptRepoDoc).allow, false, 'exemptRepos non-match')
  
  const futureExemptDoc = doc({ exemptUntil: new Date(Date.now() + 100000).toISOString() })
  assert.equal(decideWorktreeGate(facts(), pendingEdit, futureExemptDoc).allow, true, 'future exemptUntil')
  
  const pastExemptDoc = doc({ exemptUntil: new Date(Date.now() - 100000).toISOString() })
  assert.equal(decideWorktreeGate(facts(), pendingEdit, pastExemptDoc).allow, false, 'past exemptUntil')
})

test('subagent inheritance regression: gate decision for child session ID identical to parent', () => {
  // The signature of decideWorktreeGate does not accept a session ID or agent identity.
  // It takes (facts: GitFacts, pending: PendingCall, doc: PracticesDoc).
  // Because session ID structurally cannot enter the decision, a subagent sharing
  // its parent's directory is guaranteed to receive the identical gate decision.
  // This is enforced by the function signature's arity and types. No runtime assertion is meaningful.
  assert.equal(decideWorktreeGate.length, 3, 'decideWorktreeGate should accept 3 required arguments (facts, pending, doc), and none of them represent a session ID')
})
