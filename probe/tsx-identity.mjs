/**
 * Resolve the harness packages the way the host process does, and report whether
 * a plugin outside the checkout shares the host's module instances.
 *
 * Run from the checkout with the host's launch mode:
 *   node --import tsx/esm probe/tsx-identity.mjs
 *
 * A source-launched host (`node --import tsx/esm apps/cli/src/bin.ts web`) maps
 * `@deepseek-ai/dsh-*` to `packages/.../src/index.ts` through the repository
 * tsconfig paths. If a plugin's own bare import resolves to the built
 * `lib/index.js` instead, the plugin would subclass a DIFFERENT copy of the
 * compaction engine and `Service` than the host uses.
 */

const base = '@deepseek-ai/dsh-compaction-basic'
const cordis = '@deepseek-ai/cordis'

const mine = await import(base)
const myCordis = await import(cordis)

console.log('plugin-style resolve:', import.meta.resolve(base))
console.log('plugin-style cordis :', import.meta.resolve(cordis))

const fromSource = await import('file:///C:/resource/deepseek-harness/packages/compaction/compaction-basic/src/index.ts')
const cordisFromSource = await import('file:///C:/resource/deepseek-harness/vendor/cordis/src/index.ts')

console.log('same base class object   :', mine.default === fromSource.default)
console.log('same cordis Service class:', myCordis.Service === cordisFromSource.Service)
