/**
 * End-to-end browser verification for the composer chip against the isolated
 * dev host.
 *
 * Uses the machine's installed Edge through the `playwright-core` that the
 * primary profile already carries, so no browser download is needed. Screenshots
 * land in `.dev-artifacts/`.
 *
 * Usage: node probe/dev-ui.mjs <dev-url-with-token> [prompt]
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
const prompt = process.argv[3]
  ?? '读取 C:\\resource\\deepseek-harness\\packages\\compaction\\compaction-basic\\src\\region.ts 的第 1 到 600 行，然后用一句话总结它的用途。'
if (url === undefined) throw new Error('usage: node probe/dev-ui.mjs <dev-url-with-token> [prompt]')

const artifacts = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev-artifacts')
mkdirSync(artifacts, { recursive: true })

const log = (...parts) => console.log(...parts)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', error => log('[pageerror]', error.message))

const chip = () => page.locator('button[aria-haspopup="menu"]', { hasText: /压缩|Compact/ }).first()

async function chipState(label) {
  if (await chip().count() === 0) return log(`${label}: no chip`)
  log(`${label}: text=${JSON.stringify((await chip().innerText()).replace(/\s+/g, ' '))} title=${JSON.stringify(await chip().getAttribute('title'))}`)
}

async function chooseRatio(percent) {
  await chip().click()
  await page.waitForTimeout(700)
  await page.locator('[role="menuitem"]', { hasText: `${percent}%` }).first().click()
  await page.waitForTimeout(2_000)
}

async function sendTurn(text, waitTicks = 40) {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.click()
  await composer.type(text)
  await page.keyboard.press('Enter')
  for (let tick = 0; tick < waitTicks; tick += 1) {
    await page.waitForTimeout(3_000)
    const disabled = await page.locator('button[aria-label="发送消息"]').first().isDisabled().catch(() => true)
    if (!disabled) break
  }
  await page.waitForTimeout(2_500)
}

async function dismissDialogs() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dialog = page.locator('[role="dialog"]')
    if (await dialog.count() === 0) return
    const text = (await dialog.first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 60)
    log(`dismissing dialog: ${JSON.stringify(text)}`)
    await dialog.first().locator('button').last().click().catch(() => page.keyboard.press('Escape'))
    await page.waitForTimeout(1_200)
  }
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(4_500)
  await dismissDialogs()
  // Start from a blank session so the turn runs under the current default model.
  if (await page.locator('button[aria-label="新建会话"]').count() > 0) {
    await page.locator('button[aria-label="新建会话"]').first().click()
    await page.waitForTimeout(3_000)
    await dismissDialogs()
  }
  await page.screenshot({ path: join(artifacts, '01-composer.png') })
  await chipState('before')

  // 1. change the session's ratio through the menu
  await chip().click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(artifacts, '02-menu.png') })
  log('menu:', JSON.stringify((await page.locator('[role="menu"]').innerText()).replace(/\s+/g, ' ').slice(0, 300)))
  await page.locator('[role="menuitem"]', { hasText: '60%' }).first().click()
  await page.waitForTimeout(2_500)
  await chipState('after choosing 60%')
  await page.screenshot({ path: join(artifacts, '03-changed.png') })

  // 2. run one turn so the engine measures the session: 60 % of a 16k window is
  //    above the heuristic estimate, so this turn must NOT compact
  await sendTurn(prompt)
  await page.screenshot({ path: join(artifacts, '04-turn-60.png') })
  await chipState('after a turn at 60%')

  // 3. drop the override back to the preset default (10 % of the dev window),
  //    which the same conversation now exceeds, so the engine must summarize
  await chip().click()
  await page.waitForTimeout(700)
  await page.locator('[role="menuitem"]', { hasText: /^默认|^Default/ }).first().click()
  await page.waitForTimeout(2_000)
  await chipState('after clearing back to the preset default')
  await sendTurn('再用一句话说明这个文件里最深的一个不变量。')
  await page.screenshot({ path: join(artifacts, '05-turn-default.png') })
  await chipState('after a turn at the preset default')

  const transcript = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  for (const needle of ['上下文已压缩', '压缩', 'summary', 'Error', '错误']) {
    const at = transcript.indexOf(needle)
    if (at >= 0) log(`transcript contains ${JSON.stringify(needle)}: …${transcript.slice(Math.max(0, at - 100), at + 160)}…`)
  }

  // 4. a new session must start from the preset default, not the changed one
  await page.locator('button[aria-label="新建会话"]').first().click()
  await page.waitForTimeout(3_500)
  await dismissDialogs()
  await page.screenshot({ path: join(artifacts, '06-new-session.png') })
  await chipState('new session')
} finally {
  await browser.close()
}
