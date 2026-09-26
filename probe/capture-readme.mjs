/**
 * Capture the README screenshots from a dev host: a session with a changed
 * threshold, the open menu, and the same chip on a forked session that inherited
 * the value.
 *
 * Usage: node probe/capture-readme.mjs <dev-url-with-token> [percent]
 */

import { createRequire } from 'node:module'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE
  ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'playwright-core'))

const percent = process.argv[3] ?? '70'
const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs')
mkdirSync(docs, { recursive: true })
const log = (...parts) => console.log(...parts)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'en-US' })
const page = await context.newPage()

const chip = () => page.locator('button[aria-haspopup="menu"]', { hasText: /压缩|Compact/ }).first()
const composer = () => page.locator('[contenteditable="true"]').first()

async function dismissDialogs() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialog = page.locator('[role="dialog"]')
    if (await dialog.count() === 0) return
    await dialog.first().locator('button').last().click().catch(() => page.keyboard.press('Escape'))
    await page.waitForTimeout(1_000)
  }
}

try {
  await page.goto(process.argv[2], { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(5_000)
  await dismissDialogs()

  await page.locator('button[aria-label="新建会话"], button[aria-label="New session"]').first().click()
  await page.waitForTimeout(3_000)
  await dismissDialogs()
  await chip().click()
  await page.waitForTimeout(700)
  await page.locator('[role="menuitem"]', { hasText: `${percent}%` }).first().click()
  await page.waitForTimeout(2_000)
  log('parent chip:', (await chip().innerText()).replace(/\s+/g, ' '))

  // One completed turn makes the session forkable.
  await composer().click()
  await composer().type('Reply with the single word: ok')
  await page.keyboard.press('Enter')
  for (let tick = 0; tick < 30; tick += 1) {
    await page.waitForTimeout(3_000)
    const disabled = await page.locator('button[aria-label="发送消息"], button[aria-label="Send message"]').first().isDisabled().catch(() => true)
    if (!disabled) break
  }
  await page.waitForTimeout(2_000)

  // Fork through the session row's own menu.
  const rows = page.locator('[role="tree"] [role="treeitem"]')
  let target = null
  for (let index = 0; index < await rows.count(); index += 1) {
    const text = (await rows.nth(index).innerText()).replace(/\s+/g, ' ').trim()
    if (text === '' || /默认工作区|Default workspace/.test(text) || /^新会话$|^New session$/.test(text)) continue
    target = rows.nth(index)
    break
  }
  if (target === null) throw new Error('no session row to fork')
  await target.hover()
  await page.waitForTimeout(400)
  await target.locator('button[aria-label^="会话"], button[aria-label^="Session"]').first().click()
  await page.waitForTimeout(1_000)
  await page.locator('[role="menuitem"]', { hasText: /分叉会话|Fork session/ }).first().click()
  await page.waitForTimeout(6_000)
  await dismissDialogs()
  await page.waitForTimeout(1_500)

  // Forking does not necessarily move the pane; select the row whose chip really
  // reports an inherited value before capturing.
  let inheritedRow = null
  for (let index = 0; index < await rows.count(); index += 1) {
    const text = (await rows.nth(index).innerText()).replace(/\s+/g, ' ').trim()
    if (text === '' || /默认工作区|Default workspace/.test(text)) continue
    await rows.nth(index).click()
    await page.waitForTimeout(2_500)
    if (await chip().count() === 0) continue
    const title = await chip().getAttribute('title')
    log(`row[${index}] ${JSON.stringify(text.slice(0, 30))} chip=${JSON.stringify((await chip().innerText()).replace(/\s+/g, ' '))} title=${JSON.stringify(title)}`)
    if (typeof title === 'string' && /inherit|继承/.test(title)) {
      inheritedRow = rows.nth(index)
      break
    }
  }
  if (inheritedRow === null) throw new Error('no session reported an inherited value')

  const chipBox = await chip().boundingBox()
  const shot = await chip().screenshot({ path: join(docs, 'chip.png') })
  log('chip.png bytes:', shot.length, 'box:', JSON.stringify(chipBox))

  await chip().click()
  await page.waitForTimeout(900)
  const menu = page.locator('[role="menu"]').first()
  const menuShot = await menu.screenshot({ path: join(docs, 'menu.png') })
  log('menu.png bytes:', menuShot.length, 'text:', JSON.stringify((await menu.innerText()).replace(/\s+/g, ' ').slice(0, 160)))
  await page.keyboard.press('Escape')

  // The composer around the chip, so the README can show where it sits.
  await composer().click()
  await page.keyboard.type(' ')
  await page.waitForTimeout(300)
  const bar = page.locator('[contenteditable="true"]').first().locator('xpath=ancestor::*[3]')
  await bar.screenshot({ path: join(docs, 'composer.png') }).catch(() => {})
  log('composer.png exists:', statSync(join(docs, 'composer.png'), { throwIfNoEntry: false }) !== undefined)
} finally {
  await browser.close()
}
