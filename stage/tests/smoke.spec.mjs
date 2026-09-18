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

// The BEFORE test that lived here — "the header chip's popover is clipped by
// the header" — is retired with the chip (Task 4). Its screenshot is kept as
// PR evidence in stage/shots/before-chip-clipped.png; the AFTER is
// control.spec.mjs "the popover escapes every container".
