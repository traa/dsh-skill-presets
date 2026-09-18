// The stage control: one button in the composer tool row, a popover that
// renders through `shell.overlay` so no ancestor can clip it. Everything the
// header chip could not prove with a fake React is proven here.
import { test, expect } from '@playwright/test'
import { openStage, rpcCalls, expectInViewport, visibleFraction } from './_helpers.mjs'

const CONTROL = '[data-slot="conversation.input.right"] .skp-ctl'
const POP = '[data-slot="shell.overlay"] .skp-stage-pop'

test.describe('stage control', () => {
  test('lives in the composer row and reads the flow and stage', async ({ page }) => {
    await openStage(page, 'green')
    const control = page.locator(CONTROL)
    await expect(control).toBeVisible()
    await expect(control).toContainText('Build')
    // No dot, no pulse, no count when everything is green.
    await expect(control.locator('.skp-dot')).toHaveCount(0)
    await expect(control).not.toHaveClass(/pulse/u)
    await expect(control.locator('.skp-ctl-count')).toHaveCount(0)
    // The header chip is gone.
    await expect(page.locator('[data-slot="conversation.session.header.utilities"] .skp-hchip')).toHaveCount(0)
  })

  test('the popover escapes every container: fully visible and inside the viewport', async ({ page }, testInfo) => {
    await openStage(page, 'green')
    await page.click(CONTROL)
    const pop = page.locator(POP)
    await expect(pop).toBeVisible()
    expect(await visibleFraction(pop)).toBeGreaterThan(0.99)
    await expectInViewport(pop, page)
    // Anchored to the control: the popover's bottom sits just above the control's top.
    const c = await page.locator(CONTROL).boundingBox()
    const p = await pop.boundingBox()
    expect(p.y + p.height).toBeLessThanOrEqual(c.y)
    expect(c.y - (p.y + p.height)).toBeLessThan(16)
    await page.screenshot({ path: testInfo.outputPath('control-open.png') })
  })

  test('shows the flow\'s stages with the current one marked, and moves on click', async ({ page }) => {
    await openStage(page, 'green')
    await page.click(CONTROL)
    const steps = page.locator(`${POP} .skp-step`)
    await expect(steps).toHaveCount(5)
    await expect(steps.nth(2)).toHaveAttribute('aria-current', 'step')
    await expect(steps.nth(2)).toContainText('Build')
    await steps.nth(3).click()
    const calls = await rpcCalls(page)
    const move = calls.find(c => c.method === 'session/move')
    expect(move, 'clicking a stage calls session/move').toBeTruthy()
    expect(move.body).toMatchObject({ sessionId: 'stage-session', stage: 'test' })
  })

  test('closes on outside click and on Escape; the control itself toggles', async ({ page }) => {
    await openStage(page, 'green')
    await page.click(CONTROL)
    await expect(page.locator(POP)).toBeVisible()
    await page.mouse.click(400, 300)
    await expect(page.locator(POP)).toHaveCount(0)
    await page.click(CONTROL)
    await expect(page.locator(POP)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator(POP)).toHaveCount(0)
    await page.click(CONTROL)
    await expect(page.locator(POP)).toBeVisible()
    await page.click(CONTROL)
    await expect(page.locator(POP)).toHaveCount(0)
  })

  test('keyboard: the control is focusable; arrows move between stages; Enter moves', async ({ page }) => {
    await openStage(page, 'green')
    await page.locator(CONTROL).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator(POP)).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator(`${POP} .skp-step`).nth(3)).toBeFocused()
    await page.keyboard.press('Enter')
    const calls = await rpcCalls(page)
    expect(calls.find(c => c.method === 'session/move')?.body).toMatchObject({ stage: 'test' })
  })

  test('flow picker: switching to Explore calls session/move with the flow', async ({ page }) => {
    await openStage(page, 'green')
    await page.click(CONTROL)
    await page.locator(`${POP} select.skp-flow-select`).selectOption('explore')
    const calls = await rpcCalls(page)
    expect(calls.find(c => c.method === 'session/move')?.body).toMatchObject({ flow: 'explore' })
  })

  test('Explore: the control says so; no stages, no report', async ({ page }) => {
    await openStage(page, 'explore')
    await expect(page.locator(CONTROL)).toContainText('Explore')
    await page.click(CONTROL)
    await expect(page.locator(`${POP} .skp-step`)).toHaveCount(0)
    await expect(page.locator(`${POP} .skp-report-line`)).toHaveCount(0)
    await expect(page.locator(POP)).toContainText(/guardrails/iu)
  })

  test('start suggestion: one line, Yes/Not now, in the popover and under the composer', async ({ page }) => {
    await openStage(page, 'start-suggestion')
    const notice = page.locator('[data-slot="conversation.composer.dock"] .skp-start-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText(/plan\.md.*Build/u)
    await notice.getByRole('button', { name: /not now/iu }).click()
    const calls = await rpcCalls(page)
    expect(calls.map(c => c.method)).toContain('suggestion/dismiss')
  })
})
