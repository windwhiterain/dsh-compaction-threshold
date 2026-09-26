/**
 * Resolve the harness packages the way the host process does, and report whether
 * a plugin outside the checkout shares the host's module instances.
 *
 * Run from the harness checkout with the host's launch mode:
 *   node --import tsx/esm <plugin>/probe/tsx-identity.mjs [checkout]
 *
 * A source-launched host (`node --import tsx/esm apps/cli/src/bin.ts web`) maps
 * `@deepseek-ai/dsh-*` to `packages/.../src/index.ts` through the repository
 * tsconfig paths. If a plugin's own bare import resolved to the built
 * `lib/index.js` instead, the plugin would subclass a DIFFERENT copy of the
 * compaction engine and `Service` than the host uses.
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const checkout = process.argv[2] ?? process.env.DSH_CHECKOUT
if (checkout === undefined) throw new Error('usage: node probe/tsx-identity.mjs <harness-checkout>')
const entry = relative => pathToFileURL(join(checkout, relative)).href

const base = '@deepseek-ai/dsh-compaction-basic'
const cordis = '@deepseek-ai/cordis'

const mine = await import(base)
const myCordis = await import(cordis)

console.log('plugin-style resolve:', import.meta.resolve(base))
console.log('plugin-style cordis :', import.meta.resolve(cordis))

const fromSource = await import(entry('packages/compaction/compaction-basic/src/index.ts'))
const cordisFromSource = await import(entry('vendor/cordis/src/index.ts'))

console.log('same base class object   :', mine.default === fromSource.default)
console.log('same cordis Service class:', myCordis.Service === cordisFromSource.Service)
