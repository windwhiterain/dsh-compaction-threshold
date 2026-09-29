/**
 * Surface-token total of stored sessions, priced with the harness's own
 * estimator, so a "why did compaction not trigger" report can compare the
 * session against a threshold instead of guessing from the log size.
 *
 * Read-only. Folds surface events in log order exactly like
 * `foldSurfaceProjection`, minus the replacement cases (no compaction events
 * means none exist).
 *
 * Usage: node probe/surface-tokens.mjs <session-id-substring> [sessions-root]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const needle = process.argv[2] ?? ''
const root = process.argv[3] ?? join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
const profileModules = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'node_modules', '@deepseek-ai')

const { isSurfaceEvent, deriveEventMessage } = await import(
  pathToFileURL(join(profileModules, 'dsh-session', 'lib', 'index.js')).href
)
const { estimateMessage, estimateToolsTokens } = await import(
  pathToFileURL(join(profileModules, 'dsh-token-meter', 'src', 'estimate.ts')).href
)

/** Split one concatenated zstd stream into frames and decompress each. */
function decode(path) {
  const buffer = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let at = buffer.indexOf(magic)
  while (at !== -1) {
    starts.push(at)
    at = buffer.indexOf(magic, at + 4)
  }
  const parts = []
  for (const [index, start] of starts.entries()) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, starts[index + 1] ?? buffer.length)))
    } catch {
      // A trailing partial frame (a write in flight) is simply not read.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

const logs = []
for (const project of readdirSync(root, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  const projectDir = join(root, project.name)
  for (const session of readdirSync(projectDir, { withFileTypes: true })) {
    if (!session.isDirectory() || !session.name.includes(needle)) continue
    const dir = join(projectDir, session.name)
    for (const file of readdirSync(dir)) {
      if (file.startsWith('session.v4.jsonl')) logs.push({ dir: session.name, path: join(dir, file) })
    }
  }
}

for (const log of logs) {
  let text
  try {
    text = decode(log.path)
  } catch (error) {
    console.log(`!! ${log.dir}: ${String(error)}`)
    continue
  }
  let surfaceTokens = 0
  let surfaceNodes = 0
  let toolTokens = 0
  const byType = new Map()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const event = record.event ?? record
    if (record.type === 'request/header' || event.type === 'request/header') {
      toolTokens = estimateToolsTokens(record.data?.header ?? event.data?.header)
    }
    if (!isSurfaceEvent(event)) continue
    const message = deriveEventMessage(event)
    const tokens = message === null ? 0 : estimateMessage(message)
    surfaceTokens += tokens
    surfaceNodes += 1
    byType.set(event.type, (byType.get(event.type) ?? 0) + tokens)
  }
  console.log(`\n=== ${log.dir}`)
  console.log(`    surface: ${surfaceNodes} nodes, ${surfaceTokens} tokens `
    + `(+${toolTokens} tool schemas) = ${surfaceTokens + toolTokens} total`)
  console.log(`    by type: ${[...byType].sort((a, b) => b[1] - a[1])
    .map(([type, tokens]) => `${type} ${tokens}`).join(' | ')}`)
  console.log(`    vs 50% of 1048576 = 524288 → ${surfaceTokens + toolTokens >= 524288 ? 'ABOVE' : 'BELOW'}`)
  console.log(`    vs 50% of 1000000 = 500000 → ${surfaceTokens + toolTokens >= 500000 ? 'ABOVE' : 'BELOW'}`)
}
