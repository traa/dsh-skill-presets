import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requiresApproval, TeamReader } from '../lib/host/teams.js'
import { detectConductor } from '../lib/host/practices/detectors.js'

test('requiresApproval reads the shipped default and obvious phrasings; waivers win; silence is unknown', () => {
  const DEFAULT = 'WORKFLOW:\n1. Before delegating for the first time in a request, tell the user which agents you plan to use and what each will do, then wait for approval.'
  assert.equal(requiresApproval(DEFAULT), true)
  assert.equal(requiresApproval('Propose the split to the user, then wait.'), true)
  assert.equal(requiresApproval('Fan out immediately; no approval needed.'), false)
  assert.equal(requiresApproval('Delegate immediately to the owning teammates.'), false)
  assert.equal(requiresApproval('Keep briefs self-contained.'), undefined)
  assert.equal(requiresApproval(undefined), undefined)
})

test('the conductor detector skips the approval-turn rule when the team waives it', () => {
  const view = { calls: [{ t: 't', turn: 1, name: 'team_delegate', isError: false }], teamAttached: true, userTurns: [1], protectedBranches: [], ended: false }
  assert.equal(detectConductor(view).status, 'red', 'default: approval required')
  assert.equal(detectConductor({ ...view, approvalRequired: true }).status, 'red')
  assert.equal(detectConductor({ ...view, approvalRequired: false }).status, 'green')
})

test('TeamReader prefers the service, caches briefly, falls back to tool visibility', async () => {
  let teamFor = async () => ({ id: 't', name: 'Build team', members: [], conductorInstructions: 'delegate immediately' })
  let service = { teamFor: (id) => teamFor(id), attachment: async () => undefined, onAttachmentChange: () => () => {} }
  const reader = new TeamReader(() => service, () => true, 50)
  const v1 = await reader.view('s', {})
  assert.deepEqual(v1, { attached: true, teamName: 'Build team', source: 'service', approvalRequired: false })
  teamFor = async () => undefined
  assert.equal((await reader.view('s', {})).attached, true, 'cached')
  reader.invalidate('s')
  assert.equal((await reader.view('s', {})).attached, false)
  service = undefined
  reader.invalidate('s')
  assert.deepEqual(await reader.view('s', {}), { attached: true, source: 'tool-visibility' })
  assert.equal(reader.peek('s', {}), true)
  const throwing = new TeamReader(() => ({ teamFor: async () => { throw new Error('x') }, attachment: async () => undefined, onAttachmentChange: () => () => {} }), () => false)
  assert.equal((await throwing.view('z', {})).source, 'tool-visibility')
})
