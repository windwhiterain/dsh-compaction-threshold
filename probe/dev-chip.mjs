/**
 * Read the chip of several stored sessions in the dev GUI, and confirm which
 * client bundle the host serves. Used to tell a stale bundle apart from a
 * missing projection field.
 *
 * Usage: node probe/dev-chip.mjs <dev-url-with-token> [rows]
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE
  ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'playwright-core'))

const rowsToRead = Number(process.argv[3] ?? 4)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const chip = () => page.locator('button[aria-haspopup="menu"]', { hasText: /压缩|Compact/ }).first()

try {
  await page.goto(process.argv[2], { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(5_000)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialog = page.locator('[role="dialog"]')
    if (await dialog.count() === 0) break
    await dialog.first().locator('button').last().click().catch(() => page.keyboard.press('Escape'))
    await page.waitForTimeout(1_000)
  }

  const served = await page.evaluate(async () => {
    const response = await fetch('/plugins/??dsh-compaction-threshold/client.js')
    const text = await response.text()
    return {
      status: response.status,
      bytes: text.length,
      note: text.includes('note.inherited'),
      field: text.includes('facts.inherited'),
    }
  })
  console.log('served bundle:', JSON.stringify(served))

  const rows = page.locator('[role="tree"] [role="treeitem"]')
  const count = await rows.count()
  console.log('rows:', count)
  let read = 0
  for (let index = 0; index < count && read < rowsToRead; index += 1) {
    const text = (await rows.nth(index).innerText()).replace(/\s+/g, ' ').trim()
    if (text === '' || text.includes('默认工作区') || text === '新会话') continue
    read += 1
    await rows.nth(index).click()
    await page.waitForTimeout(3_000)
    if (await chip().count() === 0) {
      console.log(`row[${index}] ${JSON.stringify(text.slice(0, 30))}: no chip`)
      continue
    }
    const label = (await chip().innerText()).replace(/\s+/g, ' ')
    const title = await chip().getAttribute('title')
    const aria = await chip().getAttribute('aria-label')
    await chip().click()
    await page.waitForTimeout(700)
    const menu = (await page.locator('[role="menu"]').innerText()).replace(/\s+/g, ' ').slice(0, 140)
    await page.keyboard.press('Escape')
    console.log(`row[${index}] ${JSON.stringify(text.slice(0, 30))}: chip=${JSON.stringify(label)} title=${JSON.stringify(title)} aria=${JSON.stringify(aria)}`)
    console.log(`        menu=${JSON.stringify(menu)}`)
  }
} finally {
  await browser.close()
}
