import { test, expect } from '@playwright/test'
import { openStage } from './_helpers.mjs'

test('Open Skills tab: calls openTab exactly once, no openRightbar, closes popover', async ({ page }) => {
  await openStage(page, 'green')
  await page.locator('.skp-ctl').click()
  const popover = page.locator('.skp-stage-pop')
  await popover.locator('.skp-open-tab').click()
  
  const rightbarOpened = await page.evaluate(() => window.__STAGE__.rightbarOpened)
  expect(rightbarOpened).toBe(0)
  
  const tabsOpened = await page.evaluate(() => window.__STAGE__.tabsOpened)
  expect(tabsOpened).toEqual(['skills'])
  
  await expect(popover).not.toBeVisible()
})
