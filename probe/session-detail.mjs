/**
 * Per-session facts behind a "compaction did not trigger" report: which preset
 * was selected and when, which routes the session actually used, the token
 * counts those routes reported, and every compaction event.
 *
 * Read-only. Decodes the zstd-framed session logs under `<DSH_HOME>/sessions`.
 *
 * Usage: node probe/session-detail.mjs <session-id-substring> [sessions-root]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const needle = process.argv[2] ?? ''
const root = process.argv[3] ?? join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')

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
    if (!session.isDirectory()) continue
    const dir = join(projectDir, session.name)
    for (const file of readdirSync(dir)) {
      if (!file.startsWith('session.v4.jsonl')) continue
      const path = join(dir, file)
      logs.push({ project: project.name, dir: session.name, path, time: statSync(path).mtimeMs })
    }
  }
}
logs.sort((left, right) => right.time - left.time)

const seen = new Set()
for (const log of logs) {
  if (!log.dir.includes(needle) || seen.has(log.dir)) continue
  seen.add(log.dir)
  let text
  try {
    text = decode(log.path)
  } catch (error) {
    console.log(`!! ${log.dir}: ${String(error)}`)
    continue
  }
  let header = null
  const selected = []
  const routes = new Map()
  const headerTimes = []
  const usages = []
  const capacities = []
  const compactions = []
  const counts = new Map()
  let logBytes = 0
  const tokenPeaks = new Map()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const type = record.type ?? record.event?.type
    const data = record.data ?? record.event?.data
    const time = record.time ?? record.event?.time ?? 0
    if (typeof type !== 'string') continue
    logBytes += line.length
    counts.set(type, (counts.get(type) ?? 0) + 1)
    for (const value of [data, record.usage, record.event?.usage]) {
      if (value === undefined || value === null || typeof value !== 'object') continue
      const total = value.totalTokens ?? value.total ?? value.inputTokens ?? value.promptTokens
      if (typeof total === 'number' && Number.isFinite(total)) {
        const key = `${type}`
        tokenPeaks.set(key, Math.max(tokenPeaks.get(key) ?? 0, total))
        break
      }
    }
    if (type === 'session') header = record.event ?? record
    if (type === 'agent-preset/selected') {
      selected.push({ time, preset: data?.agentPreset })
    }
    if (type === 'request/header') {
      const config = data?.header?.config ?? data?.config
      const key = `${config?.provider}/${config?.model}`
      routes.set(key, (routes.get(key) ?? 0) + 1)
      headerTimes.push({ time, key, reason: data?.reason ?? data?.header?.reason ?? '?' })
    }
    if (type === 'request/usage' || type === 'usage' || /usage/i.test(type)) {
      usages.push({ time, type, data })
    }
    if (type === 'request/context') capacities.push({ time, data })
    if (type.startsWith('compaction')) compactions.push({ time, type, data })
  }

  console.log(`\n=== ${log.dir}  (${log.project})`)
  if (header !== null) {
    console.log(`    header: id=${header.id} preset=${JSON.stringify(header.agentPreset)} `
      + `parent=${header.parentSession ?? 'none'} depth=${header.delegationDepth ?? '?'}`)
  }
  console.log(`    preset selected events: ${selected.length === 0 ? 'none (header only)'
    : selected.map(event => `${new Date(event.time).toISOString()} ${event.preset}`).join(' | ')}`)
  console.log(`    routes: ${[...routes].map(([key, count]) => `${key}×${count}`).join(' | ') || 'none'}`)
  console.log(`    request headers: ${headerTimes.map(one => `${new Date(one.time).toISOString()} `
    + `${one.key} (${one.reason})`).join('\n                   ')}`)
  console.log(`    usage events: ${usages.length}  (types: ${[...new Set(usages.map(one => one.type))].join(',') || 'none'})`)
  for (const usage of usages.slice(-6)) {
    console.log(`      ${new Date(usage.time).toISOString()}  ${JSON.stringify(usage.data).slice(0, 260)}`)
  }
  console.log(`    capacity records: ${capacities.length === 0 ? 'none'
    : capacities.map(one => `${new Date(one.time).toISOString().slice(0, 16)} `
      + `${one.data?.provider}/${one.data?.model} window=${one.data?.contextWindow ?? '?'}`).join('\n                     ')}`)
  console.log(`    compaction events: ${compactions.length === 0 ? 'NONE'
    : compactions.map(one => `${new Date(one.time).toISOString()} ${one.type}`).join(' | ')}`)
  console.log(`    log bytes: ${logBytes}  (~${Math.round(logBytes / 3.5)} tokens if the whole log were surface)`)
  console.log(`    peak token fields: ${[...tokenPeaks].map(([type, total]) => `${type}=${total}`).join(' ') || 'none in the log'}`)
  console.log(`    event types: ${[...counts].map(([type, count]) => `${type}×${count}`).join(' ')}`)
}
