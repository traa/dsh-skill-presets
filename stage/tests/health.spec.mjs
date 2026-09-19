// Health is a gate report, not a dashboard. Nothing renders while all is well;
// a practice surfaces only when it is RED and the current stage cares, as one
// line with the evidence and one action. "Unknown" (a fact we could not read)
// is never a warning. Dismissing hides the line.
import { test, expect } from '@playwright/test'
import { openStage, rpcCalls } from './_helpers.mjs'

const CONTROL = '[data-slot="conversation.input.right"] .skp-ctl'
const POP = '[data-slot="shell.overlay"] .skp-stage-pop'
const PANE = '[data-slot="sidebar.right.pane.tab"]'

test.describe('gate report', () => {
  test('green: no count on the control, no report lines, no amber anywhere in the popover', async ({ page }, testInfo) => {
    await openStage(page, 'green')
    await expect(page.locator(`${CONTROL} .skp-ctl-count`)).toHaveCount(0)
    await page.click(CONTROL)
    await expect(page.locator(`${POP} .skp-check[data-status="red"]`)).toHaveCount(0)
    await expect(page.locator(POP)).not.toContainText(/amber|at risk|unknown/iu)
    await page.screenshot({ path: testInfo.outputPath('health-green.png') })
  })

  test('red worktree in Build: the control counts 1; the popover shows exactly one line with the evidence and one fix', async ({ page }, testInfo) => {
    await openStage(page, 'red-worktree')
    await expect(page.locator(`${CONTROL} .skp-ctl-count`)).toHaveText(/1/u)
    await page.click(CONTROL)
    const lines = page.locator(`${POP} .skp-check[data-status="red"]`)
    await expect(lines).toHaveCount(1)
    await expect(lines.first()).toContainText(/Worktree/u)
    await expect(lines.first()).toContainText(/protected branch main/u)
    // Exactly one fix affordance (the skill name or a button) plus the dismiss.
    await expect(lines.first().locator('.skp-report-actions > *')).toHaveCount(2)
    // The amber "git facts unavailable" hygiene line shows up with status amber.
    const amber = page.locator(`${POP} .skp-check[data-status="amber"]`)
    await expect(amber).toContainText(/not judged/u)
    await page.screenshot({ path: testInfo.outputPath('health-red-worktree.png') })
  })

  test('dismiss hides the line for the session and tells the host', async ({ page }) => {
    await openStage(page, 'red-worktree')
    await page.click(CONTROL)
    await page.locator(`${POP} .skp-check[data-status="red"]`).first().getByRole('button', { name: /dismiss/iu }).click()
    await expect(page.locator(`${POP} .skp-check[data-status="red"]`)).toHaveCount(0)
    await expect(page.locator(`${CONTROL} .skp-ctl-count`)).toHaveCount(0)
    const calls = await rpcCalls(page)
    expect(calls.find(c => c.method === 'practice/dismiss')?.body).toMatchObject({ sessionId: 'stage-session', id: 'worktree' })
  })

  test('the sidebar Skills tab: the same report at the top; unknowns muted under "Not judged"; no amber badges', async ({ page }, testInfo) => {
    await openStage(page, 'red-worktree')
    const pane = page.locator(PANE)
    const report = pane.locator('.skp-check[data-status="red"]')
    await expect(report).toHaveCount(1)
    const amber = pane.locator('.skp-check[data-status="amber"]')
    await expect(amber).toContainText(/not judged/u)
    await expect(amber).toContainText(/Clean up worktrees/u)
    await expect(pane.locator('.skp-badge.amber')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('health-sidebar.png') })
  })

  test('the sidebar in green shows no report block at all', async ({ page }) => {
    await openStage(page, 'green')
    await expect(page.locator(`${PANE} .skp-report-line`)).toHaveCount(0)
    await expect(page.locator(`${PANE} .skp-report`)).toHaveCount(0)
  })
})
