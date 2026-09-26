/**
 * Browser verification for session-fork inheritance against the isolated dev
 * host: set a distinctive ratio in a parent session, fork it, and read the
 * child's chip.
 *
 * Usage: node probe/dev-fork.mjs <dev-url-with-token> [percent]
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.PLAYWRIGHT_CORE
  ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'playwright-core')
const { chromium } = require(playwrightPath)

const url = process.argv[2]
const percent = process.argv[3] ?? '70'
if (url === undefined) throw new Error('usage: node probe/dev-fork.mjs <dev-url-with-token> [percent]')

const artifacts = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev-artifacts')
mkdirSync(artifacts, { recursive: true })
const log = (...parts) => console.log(...parts)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', error => log('[pageerror]', error.message))

const chip = () => page.locator('button[aria-haspopup="menu"]', { hasText: /压缩|Compact/ }).first()

async function chipState(label) {
  if (await chip().count() === 0) return log(`${label}: NO CHIP`)
  log(`${label}: text=${JSON.stringify((await chip().innerText()).replace(/\s+/g, ' '))} title=${JSON.stringify(await chip().getAttribute('title'))}`)
}

async function dismissDialogs() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dialog = page.locator('[role="dialog"]')
    if (await dialog.count() === 0) return
    await dialog.first().locator('button').last().click().catch(() => page.keyboard.press('Escape'))
    await page.waitForTimeout(1_200)
  }
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(4_500)
  await dismissDialogs()

  // A parent session with a distinctive value and one completed turn.
  await page.locator('button[aria-label="新建会话"]').first().click()
  await page.waitForTimeout(3_000)
  await dismissDialogs()
  await chip().click()
  await page.waitForTimeout(700)
  await page.locator('[role="menuitem"]', { hasText: `${percent}%` }).first().click()
  await page.waitForTimeout(2_000)
  await chipState(`parent after setting ${percent}%`)

  const composer = page.locator('[contenteditable="true"]').first()
  await composer.click()
  await composer.type('回答一个字：好。')
  await page.keyboard.press('Enter')
  for (let tick = 0; tick < 30; tick += 1) {
    await page.waitForTimeout(3_000)
    if (!await page.locator('button[aria-label="发送消息"]').first().isDisabled().catch(() => true)) break
  }
  await page.waitForTimeout(2_000)
  await page.screenshot({ path: join(artifacts, 'fork-1-parent.png') })

  // Fork through the session row's own menu, exactly as a user would. The
  // newest non-blank row is the session that just ran the turn.
  const rows = page.locator('[role="tree"] [role="treeitem"]')
  let target = null
  for (let index = 0; index < await rows.count(); index += 1) {
    const text = (await rows.nth(index).innerText()).replace(/\s+/g, ' ').trim()
    if (text === '' || text.includes('默认工作区') || text === '新会话') continue
    target = rows.nth(index)
    log('fork source row:', JSON.stringify(text.slice(0, 40)))
    break
  }
  if (target === null) {
    log('no session row to fork')
  } else {
    await target.hover()
    await page.waitForTimeout(500)
    await target.locator('button[aria-label^="会话"]').first().click()
    await page.waitForTimeout(1_200)
    await page.screenshot({ path: join(artifacts, 'fork-2-menu.png') })
    const forkItem = page.locator('[role="menuitem"]', { hasText: /分叉会话|Fork session/ }).first()
    log('fork item found:', await forkItem.count())
    if (await forkItem.count() === 0) {
      const visible = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => [])
      log('menu items:', JSON.stringify(visible.map(text => text.replace(/\s+/g, ' ').slice(0, 30))))
    } else {
      await forkItem.click()
      await page.waitForTimeout(6_000)
      await dismissDialogs()
      await page.screenshot({ path: join(artifacts, 'fork-3-child.png') })
      await chipState('child after fork')

      await chip().click()
      await page.waitForTimeout(800)
      log('child menu:', JSON.stringify((await page.locator('[role="menu"]').innerText()).replace(/\s+/g, ' ').slice(0, 200)))
      await page.keyboard.press('Escape')
    }
  }
} finally {
  await browser.close()
}
