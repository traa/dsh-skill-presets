// Settings → Stages & presets → Flows: list, create, edit, delete.
import { test, expect } from '@playwright/test'
import { openStage, rpcCalls } from './_helpers.mjs'

test.describe('settings: flows', () => {
  test('lists the built-ins, creates a custom flow, refuses to delete a built-in', async ({ page }, testInfo) => {
    await openStage(page, 'green')
    await page.click('[data-stage-nav="settings"]')
    const card = page.locator('.skp-flows')
    await expect(card).toBeVisible()
    const rows = card.locator('.skp-flow-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Full')
    await expect(rows.nth(0)).toContainText('Plan → Design → Build → Test & Review → Deploy')
    await expect(rows.nth(1)).toContainText('Explore')
    await expect(rows.nth(1)).toContainText('guardrails off')
    // Built-ins have Edit but no Delete.
    await expect(rows.nth(0).getByRole('button', { name: 'Delete' })).toHaveCount(0)

    await card.getByRole('button', { name: '+ New flow' }).click()
    const editor = card.locator('.skp-flow-editor')
    await editor.getByLabel('Flow title').fill('Fix')
    // Default draft is Build → Review; add nothing, save.
    await expect(editor).toContainText('→ Build → Test & Review')
    await page.screenshot({ path: testInfo.outputPath('settings-flows.png') })
    await editor.getByRole('button', { name: 'Create flow' }).click()
    const calls = await rpcCalls(page)
    const save = calls.find(c => c.method === 'flows/save')
    expect(save?.body.flow).toMatchObject({ id: 'fix', title: 'Fix', stages: ['build', 'test'], guardrails: 'on' })
  })
})
