import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnose, worstSeverity, legacyRowEnabled, probe } from '../lib/host/doctor.js'

const base = { libMissing: [], nodeModulesPresent: true, storeParse: [{ file: 'lock.json', ok: true }], srcNewest: 1000, libNewest: 2000, profileDir: '/p', profileResolves: true, profileResolvedTo: '/x', probedRoot: '/x', profileBundled: true, serverStartedAt: 3000, serverSource: 'host' }
const by = (f) => Object.fromEntries(f.map(x => [x.id, x.severity]))

test('a healthy install is all ok', () => {
  const f = diagnose({ ...base, restrictSeam: true, agentTeams: true, evals: { total: 3, failed: 0 } })
  assert.equal(worstSeverity(f), 'ok', JSON.stringify(f.filter(x => x.severity !== 'ok')))
})

test('the incidents we actually had are each a fail with a fix', () => {
  // Phase-2 merge: node_modules self-link, build a no-op → lib older than src, modules missing.
  const symlink = diagnose({ ...base, nodeModulesSymlink: '../dsh-skill-presets/node_modules', srcNewest: 5000, libNewest: 2000, libMissing: ['host/stage.ts', 'host/experiments.ts'] })
  assert.equal(by(symlink)['node-modules'], 'fail'); assert.equal(by(symlink).lib, 'fail'); assert.equal(by(symlink)['lib-modules'], 'fail')
  assert.match(symlink.find(x => x.id === 'node-modules').fix, /npm ci/)
  // Restart before rebuild: server older than lib.
  const stale = diagnose({ ...base, serverStartedAt: 1500 })
  assert.equal(by(stale).server, 'fail'); assert.match(stale.find(x => x.id === 'server').fix, /restart/)
  // Plugin linked but not bundled / not resolvable.
  assert.equal(by(diagnose({ ...base, profileBundled: false }))['profile-bundles'], 'fail')
  assert.equal(by(diagnose({ ...base, profileResolves: false })).profile, 'fail')
  // Store corruption.
  assert.equal(by(diagnose({ ...base, storeParse: [{ file: 'lock.json', ok: false, note: 'Unexpected token' }] }))['store:lock.json'], 'fail')
  // Eval regression.
  assert.equal(by(diagnose({ ...base, evals: { total: 3, failed: 1 } })).evals, 'fail')
})

test('degradations are warnings; unknowns are warnings, not failures', () => {
  const f = diagnose({ ...base, restrictSeam: false, agentTeams: false, legacySkillRowEnabled: true })
  assert.equal(by(f)['restrict-seam'], 'warn'); assert.equal(by(f)['agent-teams'], 'warn'); assert.equal(by(f)['legacy-row'], 'warn')
  assert.equal(worstSeverity(f), 'warn')
  assert.equal(by(diagnose({ ...base, serverStartedAt: undefined })).server, 'warn')
  assert.equal(by(diagnose({ ...base, profileDir: undefined })).profile, 'warn')
})

test('server age is not judged when probing a checkout the profile does not serve (a worktree)', () => {
  const f = diagnose({ ...base, probedRoot: '/x-phase-5', profileResolvedTo: '/x', serverStartedAt: 1500 })
  assert.equal(by(f).server, 'ok')
})

test('legacyRowEnabled reads the row body, not just the id line', () => {
  assert.equal(legacyRowEnabled('- id: skill-filesystem\n  disabled: true\n  config:\n    providerName: workbench\n- id: other\n'), false)
  assert.equal(legacyRowEnabled('- id: skill-filesystem\n  disabled: false\n  config: {}\n'), true)
  assert.equal(legacyRowEnabled('- id: skill-filesystem\n  config: {}\n'), true)
  assert.equal(legacyRowEnabled('# comment\n- id: skill-filesystem\n  # note\n\n  disabled: true\n'), false)
  assert.equal(legacyRowEnabled('- id: knowledge\n'), undefined)
})

test('probe on this checkout reports lib present and node_modules real', async () => {
  const r = await probe({ profile: 'no-such-profile-xyz', env: { DSH_HOME: '/nonexistent' } })
  assert.ok(r.libNewest !== undefined)
  assert.equal(r.nodeModulesPresent, true)
  assert.equal(r.nodeModulesSymlink, undefined)
  assert.equal(r.profileDir, undefined)
  assert.deepEqual(r.libMissing, [])
})
