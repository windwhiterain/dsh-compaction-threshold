/**
 * Verify the two inherited-value rules in the dev GUI:
 *   1. clearing a child returns it to the preset default and does NOT re-inherit;
 *   2. a session keeps its own value across a turn.
 *
 * Usage: node probe/dev-inherit-rules.mjs <dev-url-with-token> <child-row-index>
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE
  ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'playwright-core'))

const rowIndex = Number(process.argv[3] ?? 2)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const chip = () => page.locator('button[aria-haspopup="menu"]', { hasText: /压缩|Compact/ }).first()
const log = (...parts) => console.log(...parts)

async function state(label) {
  if (await chip().count() === 0) return log(`${label}: NO CHIP`)
  log(`${label}: text=${JSON.stringify((await chip().innerText()).replace(/\s+/g, ' '))} title=${JSON.stringify(await chip().getAttribute('title'))}`)
}

try {
  await page.goto(process.argv[2], { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(5_000)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialog = page.locator('[role="dialog"]')
    if (await dialog.count() === 0) break
    await dialog.first().locator('button').last().click().catch(() => page.keyboard.press('Escape'))
    await page.waitForTimeout(1_000)
  }

  const rows = page.locator('[role="tree"] [role="treeitem"]')
  await rows.nth(rowIndex).click()
  await page.waitForTimeout(3_500)
  log('row:', JSON.stringify((await rows.nth(rowIndex).innerText()).replace(/\s+/g, ' ').slice(0, 40)))
  await state('inherited child')

  await chip().click()
  await page.waitForTimeout(700)
  await page.locator('[role="menuitem"]', { hasText: /跟随预设|Preset default/ }).first().click()
  await page.waitForTimeout(2_500)
  await state('after clearing to the preset default')

  const composer = page.locator('[contenteditable="true"]').first()
  await composer.click()
  await composer.type('回答一个字：好。')
  await page.keyboard.press('Enter')
  for (let tick = 0; tick < 30; tick += 1) {
    await page.waitForTimeout(3_000)
    if (!await page.locator('button[aria-label="发送消息"]').first().isDisabled().catch(() => true)) break
  }
  await page.waitForTimeout(2_500)
  await state('after a turn (must NOT re-inherit)')
} finally {
  await browser.close()
}
