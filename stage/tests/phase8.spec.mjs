import { test, expect } from '@playwright/test'
import { openStage, expectInViewport } from './_helpers.mjs'
import { readFile } from 'fs/promises'
import { join } from 'path'

async function getFixture(name) {
  const data = await readFile(join('stage', 'fixtures', `${name}.json`), 'utf-8')
  return JSON.parse(data)
}

test('1. Native pill: no swatch, correct label/caret and styling', async ({ page }, testInfo) => {
  await openStage(page, 'green')
  const ctl = page.locator('.skp-ctl')
  await expect(ctl).toBeVisible()
  
  await expect(ctl.locator('.skp-swatch')).toHaveCount(0)
  await expect(ctl.locator('.skp-ctl-label')).toHaveText('Build')
  await expect(ctl.locator('.skp-ctl-caret')).toBeVisible()
  
  const text = await ctl.innerText()
  expect(text.replace(/\s+/g, '')).toBe('Build⌄')
  
  // Computed style checks
  const style = await ctl.evaluate(el => {
    const cs = window.getComputedStyle(el)
    return {
      borderStyle: cs.borderStyle,
      borderWidth: cs.borderWidth,
      borderRadius: parseFloat(cs.borderRadius),
      backgroundColor: cs.backgroundColor,
      height: parseFloat(cs.height)
    }
  })
  
  expect(['none', '0px']).toContain(style.borderStyle === 'none' ? 'none' : style.borderWidth)
  expect(style.borderRadius).toBeGreaterThanOrEqual(20)
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(style.backgroundColor)
  expect(style.height).toBe(28)
  
  // Screenshot pill
  await ctl.screenshot({ path: testInfo.outputPath('phase8-pill.png') })
})

test('2. Long label never wraps', async ({ page }) => {
  await page.request.get('/__stage/reset')
  await page.goto(`/?fixture=red-worktree&session=stage-session&stage-width=560`)
  await page.waitForSelector('html[data-stage-ready="1"]')
  
  const ctl = page.locator('.skp-ctl')
  await expect(ctl).toBeVisible()
  
  const box = await ctl.boundingBox()
  expect(box.height).toBeLessThanOrEqual(30)
  
  const label = ctl.locator('.skp-ctl-label')
  const ellipsis = await label.evaluate(el => window.getComputedStyle(el).textOverflow)
  expect(ellipsis).toBe('ellipsis')
})

test('3. Gate first and 4. Full checks list', async ({ page }, testInfo) => {
  // Green
  await openStage(page, 'green')
  await page.locator('.skp-ctl').click()
  const popover = page.locator('.skp-stage-pop')
  await expect(popover).toBeVisible()
  
  const gate = popover.locator('> *:first-child')
  await expect(gate).toHaveClass(/skp-gate/)
  await expect(gate).toContainText('plan.md is committed')
  await expect(gate.locator('.skp-gate-state.ok')).toBeVisible()
  
  const fixGreen = await getFixture('green')
  const posGreen = fixGreen.rpc['session/position']
  const relevantGreen = posGreen.practices.filter(p => p.relevant).length
  const nonRelevantGreen = posGreen.practices.filter(p => !p.relevant && p.status !== 'n/a').length
  
  const expectedStatuses = posGreen.practices.filter(p => p.relevant).map(p => p.status)
  const checks = popover.locator('.skp-checks .skp-check')
  await expect(checks).toHaveCount(relevantGreen)
  for (let i = 0; i < relevantGreen; i++) {
    await expect(checks.nth(i)).toHaveAttribute('data-status', expectedStatuses[i])
  }
  await expect(checks.locator('.skp-report-actions')).toHaveCount(0)
  
  if (nonRelevantGreen > 0) {
    await expect(popover.locator('.skp-na')).toContainText(`+${nonRelevantGreen} not judged in this stage`)
  } else {
    await expect(popover.locator('.skp-na')).toHaveCount(0)
  }
  await popover.screenshot({ path: testInfo.outputPath('phase8-popover-green.png') })
  
  // Start-suggestion
  await openStage(page, 'start-suggestion')
  await page.locator('.skp-ctl').click()
  const pop2 = page.locator('.skp-stage-pop')
  const gate2 = pop2.locator('> *:first-child')
  await expect(gate2).toHaveClass(/skp-gate/)
  await expect(gate2).toContainText('intent.md is committed')
  await expect(gate2.locator('.skp-gate-state.ok')).toBeVisible()
  
  // Explore
  await openStage(page, 'explore')
  await page.locator('.skp-ctl').click()
  const pop3 = page.locator('.skp-stage-pop')
  const gate3 = pop3.locator('> *:first-child')
  await expect(gate3).toContainText('guardrails off')
  
  // Red-worktree
  await openStage(page, 'red-worktree')
  await page.locator('.skp-ctl').click()
  const pop4 = page.locator('.skp-stage-pop')
  
  const fixRed = await getFixture('red-worktree')
  const posRed = fixRed.rpc['session/position']
  const expectedRedStatuses = posRed.practices.filter(p => p.relevant).map(p => p.status)
  const redAllChecks = pop4.locator('.skp-checks .skp-check')
  await expect(redAllChecks).toHaveCount(expectedRedStatuses.length)
  for (let i = 0; i < expectedRedStatuses.length; i++) {
    await expect(redAllChecks.nth(i)).toHaveAttribute('data-status', expectedRedStatuses[i])
  }
  
  const redChecks = pop4.locator('.skp-check[data-status="red"]')
  await expect(redChecks).toHaveCount(1)
  await expect(redChecks.locator('.skp-report-actions > *')).toHaveCount(2)
  await expect(redChecks.locator('.skp-report-actions button[aria-label^="Dismiss"]')).toBeVisible()
  
  const amberChecks = pop4.locator('.skp-check[data-status="amber"]')
  await expect(amberChecks).toHaveCount(1)
  await expect(amberChecks).toContainText(/not judged/i)
  
  const checkTitles = pop4.locator('.skp-check-title')
  const titles = await checkTitles.allTextContents()
  for (const t of titles) {
    expect(t).not.toBe('pull-request')
  }
  
  await pop4.screenshot({ path: testInfo.outputPath('phase8-popover-red.png') })
})

test('5. Skills in play', async ({ page }) => {
  await openStage(page, 'green')
  await page.locator('.skp-ctl').click()
  const popover = page.locator('.skp-stage-pop')
  
  const fixGreen = await getFixture('green')
  const skillsCount = fixGreen.rpc['session/position'].skills.length
  
  const skillsHeader = popover.locator('.skp-skills-header, .skp-skills-head, h3, .skp-skills > div:first-child') // Will refine selector if needed, let's try .skp-skills
  await expect(popover.locator('.skp-skills')).toContainText(new RegExp(`Skills in play · ${skillsCount}`))
  
  const chips = popover.locator('.skp-skill')
  await expect(chips).toHaveCount(skillsCount)
})

test('6. Open Skills tab', async ({ page }) => {
  await openStage(page, 'green')
  await page.locator('.skp-ctl').click()
  const popover = page.locator('.skp-stage-pop')
  await popover.locator('.skp-open-tab').click()
  
  const rightbarOpened = await page.evaluate(() => window.__STAGE__.rightbarOpened)
  expect(rightbarOpened).toBe(1)
  await expect(popover).not.toBeVisible()
})

test('7. Inject contract, live', async ({ page }) => {
  await openStage(page, 'green')
  const deniedGets = await page.evaluate(() => window.__STAGE__.deniedGets)
  expect(deniedGets).toEqual([])
  
  const tabTypes = await page.evaluate(() => window.__STAGE__.tabTypes.map(t => t.id))
  expect(tabTypes).toContain('dsh-skill-presets')
})
