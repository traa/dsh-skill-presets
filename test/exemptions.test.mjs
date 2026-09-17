import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePractices } from '../lib/host/store.js'
import { defaultPractices } from '../lib/host/curated.js'
import { SkillPresetsService } from '../lib/host/service.js'

test('store: validatePractices migrates legacy exemptRepos/exemptUntil to exemptions array', () => {
  const now = Date.now();
  const futureIso = new Date(now + 100000).toISOString();
  
  const legacyDoc = {
    version: 1,
    exemptRepos: ['/my/repo'],
    exemptUntil: futureIso
  };

  const migrated = validatePractices(legacyDoc, defaultPractices);
  
  assert.equal(migrated.exemptRepos, undefined, 'legacy exemptRepos should not be written back');
  assert.equal(migrated.exemptUntil, undefined, 'legacy exemptUntil should not be written back');
  assert.equal(Array.isArray(migrated.exemptions), true, 'should create exemptions array');
  assert.equal(migrated.exemptions.length, 1);
  assert.equal(migrated.exemptions[0].repo, '/my/repo');
  assert.equal(migrated.exemptions[0].until, futureIso);
  assert.equal(migrated.exemptions[0].reason, '(migrated from legacy exemption)');
})

test('store: validatePractices does not migrate already-expired legacy grants', () => {
  const now = Date.now();
  const pastIso = new Date(now - 100000).toISOString();
  
  const legacyDoc = {
    version: 1,
    exemptRepos: ['/my/repo'],
    exemptUntil: pastIso
  };

  // Wait, wait... the brief says:
  // "a legacy doc whose expiry already passed does not produce a LIVE grant"
  // Does validatePractices take `now` as an argument? Let me check validatePractices signature.
  // Oh, `validatePractices(raw, fallback)`. It doesn't take `now`.
  // Wait, Date.parse() against Date.now() inside validatePractices? That is impure!
  // If it's impure, I can just use Date.now() + offset.
  // Let's assert it produces NO grant or an expired grant. The brief says "does not produce a LIVE grant". If it drops it, `exemptions` should be undefined or empty.

  const migrated = validatePractices(legacyDoc, defaultPractices);
  const hasLiveGrant = migrated.exemptions?.some(e => Date.parse(e.until) > Date.now());
  assert.equal(hasLiveGrant, false, 'should not produce a live grant from an expired legacy exemption');
})

test('store: validatePractices round-trips new exemptions without losing them', () => {
  const futureIso = new Date(Date.now() + 100000).toISOString();
  const doc = {
    version: 1,
    exemptions: [{ repo: '/my/repo', until: futureIso, reason: 'test roundtrip' }]
  };

  const output = validatePractices(doc, defaultPractices);
  assert.equal(Array.isArray(output.exemptions), true);
  assert.equal(output.exemptions.length, 1);
  assert.equal(output.exemptions[0].repo, '/my/repo');
  assert.equal(output.exemptions[0].until, futureIso);
  assert.equal(output.exemptions[0].reason, 'test roundtrip');
})

test('service: exemptWorktree appends, drops same repos prior grant, and drops expired ones', async () => {
  // We need to mock deps to SkillPresetsService
  let savedDoc = null;
  const nowMs = Date.now();
  const pastIso = new Date(nowMs - 100000).toISOString();
  const futureIso = new Date(nowMs + 100000).toISOString();

  let currentDoc = defaultPractices();
  currentDoc.exemptions = [
    { repo: '/other/repo', until: futureIso, reason: 'live other' },
    { repo: '/expired/repo', until: pastIso, reason: 'expired other' },
    { repo: '/my/repo', until: futureIso, reason: 'live my old' }
  ];

  const deps = {
    root: () => '/tmp',
    now: () => new Date(nowMs),
    log: () => {}
  };

  const service = new SkillPresetsService(deps);
  
  // Override practices() to return our controlled state
  service.practices = async () => currentDoc;
  // Override savePractices() to capture the output without hitting disk
  service.savePractices = async (doc) => {
    savedDoc = doc;
    return doc;
  };

  await service.exemptWorktree('/my/repo', 4, 'new reason');

  assert.notEqual(savedDoc, null, 'should have called savePractices');
  assert.equal(Array.isArray(savedDoc.exemptions), true, 'should save exemptions array');
  
  const exemptions = savedDoc.exemptions;
  assert.equal(exemptions.length, 2, 'should have exactly two live grants: /other/repo and the new /my/repo');
  
  const otherGrant = exemptions.find(e => e.repo === '/other/repo');
  assert.notEqual(otherGrant, undefined, 'live grant for other repo should survive');
  
  const expiredGrant = exemptions.find(e => e.repo === '/expired/repo');
  assert.equal(expiredGrant, undefined, 'expired grant should be garbage collected');

  const myGrant = exemptions.find(e => e.repo === '/my/repo');
  assert.notEqual(myGrant, undefined, 'new grant should exist');
  assert.equal(myGrant.reason, 'new reason', 'should have the new reason, replacing the old one');
  
  const expectedUntil = new Date(nowMs + 4 * 3600000).toISOString();
  assert.equal(myGrant.until, expectedUntil, 'should calculate until correctly from hours');
})

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
const execAsync = promisify(exec)

test('cli: exempt list and exempt revoke', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-test-'))
  const repoDir = path.join(tmpBase, 'repo')
  const storeDir = path.join(tmpBase, 'store')
  
  try {
    await fs.mkdir(repoDir)
    await fs.mkdir(storeDir)
    await fs.mkdir(path.join(storeDir, 'skills'))
    
    // Create practices.json with an exemption
    const futureIso = new Date(Date.now() + 100000).toISOString()
    const pastIso = new Date(Date.now() - 100000).toISOString()
    
    const practices = {
      version: 1,
      exemptions: [
        { repo: repoDir, until: futureIso, reason: 'test live' },
        { repo: '/expired', until: pastIso, reason: 'test expired' }
      ]
    }
    await fs.writeFile(path.join(storeDir, 'skills', 'practices.json'), JSON.stringify(practices))
    
    await execAsync('git init', { cwd: repoDir })
    
    const cliPath = path.resolve('./lib/bin/cli.js')
    const env = { ...process.env, DSH_SKILL_PRESETS_ROOT: storeDir }

    // 1. exempt list
    const listResult = await execAsync(`node ${cliPath} exempt list`, { env })
    assert.equal(listResult.stdout.includes(`live    ${repoDir}`), true, 'should list live exemption')
    assert.equal(listResult.stdout.includes(`expired /expired`), true, 'should list expired exemption')
    
    // 2. exempt revoke
    const revokeResult = await execAsync(`node ${cliPath} exempt revoke --repo ${repoDir}`, { env })
    assert.equal(revokeResult.stdout.includes(`revoked 1 worktree exemption(s) for ${repoDir}`), true)
    
    const updatedPractices = JSON.parse(await fs.readFile(path.join(storeDir, 'skills', 'practices.json'), 'utf8'))
    assert.equal(updatedPractices.exemptions.length, 1)
    assert.equal(updatedPractices.exemptions[0].repo, '/expired')

    // 3. exempt list again
    const list2Result = await execAsync(`node ${cliPath} exempt list`, { env })
    assert.equal(list2Result.stdout.includes(repoDir), false, 'revoked exemption should not appear')
    
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true })
  }
})
