import { expect } from '@playwright/test'

/** Open the stage on a fixture and wait for the plugin to have applied. */
export async function openStage(page, fixture, { session = 'stage-session' } = {}) {
  await page.request.get('/__stage/reset')
  await page.goto(`/?fixture=${fixture}&session=${session}`)
  await page.waitForSelector('html[data-stage-ready="1"], html[data-stage-error="1"]')
  const error = await page.evaluate(() => window.__STAGE__.error)
  expect(error, 'plugin apply() threw').toBeUndefined()
  return page
}

/** The RPC calls the plugin made, oldest first. */
export async function rpcCalls(page) {
  return await (await page.request.get('/__stage/calls')).json()
}

/** A locator's box lies wholly inside the viewport. */
export async function expectInViewport(locator, page) {
  const box = await locator.boundingBox()
  expect(box, 'element has no box (not rendered or display:none)').not.toBeNull()
  const vp = page.viewportSize()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
  return box
}

/**
 * How much of the element is actually visible once ancestors' `overflow`
 * clipping is applied — `boundingBox()` ignores clipping, so a popover cut by
 * the header still reports its full geometry. This intersects the element's
 * rect with every scrolling/clipping ancestor's rect.
 */
export async function visibleFraction(locator) {
  return await locator.evaluate((el) => {
    let rect = el.getBoundingClientRect()
    const area = r => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top)
    const full = area(rect)
    if (full === 0) return 0
    let clip = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const cs = getComputedStyle(node)
      const clips = ['hidden', 'clip', 'auto', 'scroll'].includes(cs.overflow) || ['hidden', 'clip', 'auto', 'scroll'].includes(cs.overflowY) || ['hidden', 'clip', 'auto', 'scroll'].includes(cs.overflowX)
      if (!clips) continue
      // A `position: fixed` element escapes every ancestor clip (its containing block is the viewport).
      if (getComputedStyle(el).position === 'fixed') break
      const r = node.getBoundingClientRect()
      clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) }
    }
    const vw = window.innerWidth, vh = window.innerHeight
    clip = { left: Math.max(clip.left, 0), top: Math.max(clip.top, 0), right: Math.min(clip.right, vw), bottom: Math.min(clip.bottom, vh) }
    return area(clip) / full
  })
}
