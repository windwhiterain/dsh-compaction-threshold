/**
 * Verify that a delegated (subagent) child inherits the parent's value too.
 *
 * Opens a fresh session in the dev GUI, sets a distinctive ratio, asks the model
 * to delegate one trivial task, and leaves the result to be read from the
 * storage domain (the child's record carries `inheritedFrom`).
 *
 * Usage: node probe/dev-subagent.mjs <dev-url-with-token> [percent]
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE
  ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'playwright-core'))

const percent = process.argv[3] ?? '80'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const chip = () => page.locator('button[aria-haspopup="menu"]', { hasText: /压缩|Compact/ }).first()
const log = (...parts) => console.log(...parts)

try {
  await page.goto(process.argv[2], { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(5_000)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialog = page.locator('[role="dialog"]')
    if (await dialog.count() === 0) break
    await dialog.first().locator('button').last().click().catch(() => page.keyboard.press('Escape'))
    await page.waitForTimeout(1_000)
  }

  await page.locator('button[aria-label="新建会话"]').first().click()
  await page.waitForTimeout(3_000)
  await chip().click()
  await page.waitForTimeout(700)
  await page.locator('[role="menuitem"]', { hasText: `${percent}%` }).first().click()
  await page.waitForTimeout(2_000)
  log('parent chip:', JSON.stringify((await chip().innerText()).replace(/\s+/g, ' ')))

  const composer = page.locator('[contenteditable="true"]').first()
  await composer.click()
  await composer.type('用 subagent 工具派一个子 agent，任务只有一句：回答 1+1 等于几。然后复述它的回答，结束。')
  await page.keyboard.press('Enter')
  for (let tick = 0; tick < 60; tick += 1) {
    await page.waitForTimeout(3_000)
    if (!await page.locator('button[aria-label="发送消息"]').first().isDisabled().catch(() => true)) break
  }
  await page.waitForTimeout(3_000)
  const transcript = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const at = transcript.indexOf('subagent')
  log('transcript near subagent:', JSON.stringify(at === -1 ? '(no mention)' : transcript.slice(Math.max(0, at - 60), at + 200)))
} finally {
  await browser.close()
}
