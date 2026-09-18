// Proves the stage itself before any redesign leans on it: the REAL bundle
// loads through the loader handoff, registers into the same slots the page
// offers, renders from the fixture RPC, and Playwright can see and click it.
import { test, expect } from '@playwright/test'
import { openStage, rpcCalls, visibleFraction } from './_helpers.mjs'

test.describe('stage: the real client bundle in a fake shell', () => {
  test('applies without error and registers the surfaces the bundle declares', async ({ page }) => {
    await openStage(page, 'green')
    const info = await page.evaluate(() => ({
      module: window.__STAGE__.module,
      slots: [...window.__STAGE__.occupants.entries()].map(([name, regs]) => [name, regs.length]),
      tabs: window.__STAGE__.tabTypes.map(t => t.id),
    }))
    expect(info.module.name).toBe('client-ui-skill-presets')
    expect(info.module.inject).toEqual(['slots'])
    const slotNames = Object.fromEntries(info.slots)
    // Every surface the bundle registers must land in a region the stage
    // provides — a slot name the shell has no region for renders nowhere, which
    // is exactly the silent failure this stage exists to catch.
    const regions = await page.evaluate(() => Object.keys(window.__STAGE__.regions))
    for (const name of Object.keys(slotNames)) {
      if (name === 'settings.plugin.item') continue // the Plugins page card; the stage has no Plugins page
      expect(regions, `slot ${name} has no region in stage/shell.html`).toContain(name)
    }
    expect(info.tabs).toContain('dsh-skill-presets')
  })

  test('renders the session scorecard in the right pane from the fixture', async ({ page }) => {
    await openStage(page, 'green')
    const pane = page.locator('[data-slot="sidebar.right.pane.tab"]')
    await expect(pane).toContainText(/Build/u)
    const calls = await rpcCalls(page)
    expect(calls.map(c => c.method)).toContain('scorecard')
  })

  test('renders the settings page', async ({ page }) => {
    await openStage(page, 'green')
    await page.click('[data-stage-nav="settings"]')
    const body = page.locator('[data-slot="settings.section"]')
    await expect(body).toContainText(/Stages|presets/iu)
    const calls = await rpcCalls(page)
    expect(calls.map(c => c.method)).toContain('status')
  })
})

// ---------------------------------------------------------------------------
// BEFORE: the header chip's popover is a child of a 40 px `overflow: hidden`
// header. `boundingBox()` says it is 300 px tall; what the user can SEE is a
// sliver. This is the bug the user reported as "the dropdown isn't working".
// The assertion is deliberately inverted (`toBeLessThan`) so the test documents
// the defect and FAILS the day the chip is removed or fixed — at which point it
// is deleted along with the chip (Task 4).
test.describe('BEFORE: header chip popover is clipped by the header', () => {
  test('most of the popover is cut off', async ({ page }, testInfo) => {
    await openStage(page, 'green')
    const chip = page.locator('[data-slot="conversation.session.header.utilities"] .skp-hchip')
    await expect(chip).toBeVisible()
    await chip.click()
    const pop = page.locator('.skp-pop')
    await expect(pop).toHaveCount(1)
    const fraction = await visibleFraction(pop)
    await page.screenshot({ path: testInfo.outputPath('before-chip-clipped.png') })
    expect(fraction, `visible fraction of the popover: ${fraction.toFixed(2)}`).toBeLessThan(0.25)
  })
})
