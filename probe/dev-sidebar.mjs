/**
 * Sidebar reconnaissance for the dev host: which elements carry the session
 * rows, and which buttons appear once a row is hovered. Text only.
 *
 * Usage: node probe/dev-sidebar.mjs <dev-url-with-token>
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE
  ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'playwright-core'))

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  await page.goto(process.argv[2], { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(5_000)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialog = page.locator('[role="dialog"]')
    if (await dialog.count() === 0) break
    await dialog.first().locator('button').last().click().catch(() => page.keyboard.press('Escape'))
    await page.waitForTimeout(1_000)
  }

  console.log('roles:', await page.evaluate(() => {
    const counts = {}
    for (const node of document.querySelectorAll('[role]')) {
      const role = node.getAttribute('role')
      counts[role] = (counts[role] ?? 0) + 1
    }
    return JSON.stringify(counts)
  }))

  const dataSession = await page.locator('[data-session-id]').count()
  console.log('elements with data-session-id:', dataSession)
  const treeItems = await page.locator('[role="treeitem"], [role="option"]').count()
  console.log('treeitem/option count:', treeItems)

  const items = page.locator('[role="tree"] [role="treeitem"]')
  console.log('tree items:', await items.count())
  for (let index = 0; index < await items.count(); index += 1) {
    console.log(`  [${index}] ${JSON.stringify((await items.nth(index).innerText()).replace(/\s+/g, ' ').slice(0, 60))}`)
  }
  if (await items.count() > 0) {
    const row = items.last()
    await row.hover().catch(() => {})
    await page.waitForTimeout(900)
    console.log('row html after hover:', JSON.stringify((await row.evaluate(node => node.outerHTML)).slice(0, 1400)))
    const buttons = row.locator('button')
    console.log('row buttons:', await buttons.count())
    for (let index = 0; index < await buttons.count(); index += 1) {
      const label = await buttons.nth(index).getAttribute('aria-label')
      const visible = await buttons.nth(index).isVisible().catch(() => false)
      console.log(`  button[${index}] visible=${visible} label=${JSON.stringify(label?.slice(0, 60))}`)
    }
  }
} finally {
  await browser.close()
}
