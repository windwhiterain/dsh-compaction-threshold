/**
 * DOM inspection helper for the dev host: what covers the composer, and which
 * buttons are reachable. Text only — the calling model may not accept images.
 *
 * Usage: node probe/dev-inspect.mjs <dev-url-with-token>
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.PLAYWRIGHT_CORE
  ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'playwright-core')
const { chromium } = require(playwrightPath)

const url = process.argv[2]
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', error => console.log('[pageerror]', error.message))

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(5_000)

  const overlays = page.locator('[role="presentation"], [role="dialog"]')
  console.log('overlays/dialogs:', await overlays.count())
  for (let index = 0; index < await overlays.count(); index += 1) {
    const html = await overlays.nth(index).evaluate(node => node.outerHTML)
    console.log(`--- overlay[${index}] (${html.length} chars) ---`)
    console.log(html.slice(0, 2000).replace(/\s+/g, ' '))
  }

  const buttons = page.locator('button')
  console.log('buttons:', await buttons.count())
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index)
    const text = (await button.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 40)
    const label = await button.getAttribute('aria-label')
    const disabled = await button.isDisabled().catch(() => false)
    console.log(`  [${index}]${disabled ? ' (disabled)' : ''} text=${JSON.stringify(text)} label=${JSON.stringify(label?.slice(0, 60))}`)
  }
} finally {
  await browser.close()
}
