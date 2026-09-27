/**
 * Compaction history of stored sessions: which preset, which routed model, which
 * per-session value, and every compaction event in order.
 *
 * Read-only. Decodes the zstd-framed session logs and reads the storage domain
 * dump passed as the second argument (or `<DSH_HOME>/storages/compaction_threshold.json`).
 *
 * Usage: node probe/session-compaction.mjs [sessions-root] [filter]
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
const filter = process.argv[3] ?? ''
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const domainPath = join(home, 'storages', 'compaction_threshold.json')

let records = {}
if (existsSync(domainPath)) {
  try {
    records = JSON.parse(readFileSync(domainPath, 'utf8')).tables?.sessions ?? {}
  } catch (error) {
    console.error(`cannot read ${domainPath}: ${String(error)}`)
  }
}

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
      logs.push({ project: project.name, path: join(dir, file), time: statSync(join(dir, file)).mtimeMs })
    }
  }
}
logs.sort((left, right) => right.time - left.time)

for (const log of logs) {
  let text
  try {
    text = decode(log.path)
  } catch {
    continue
  }
  let header = null
  let title = null
  let model = null
  const events = []
  const types = new Map()
  let firstTime = 0
  let lastTime = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type === 'session') header = record
    if (record.type === 'session/title' && typeof record.data?.title === 'string') title = record.data.title
    if (record.type === 'request/header') {
      const config = record.data?.header?.config
      if (config?.model) model = `${config.provider}/${config.model}`
    }
    types.set(record.type, (types.get(record.type) ?? 0) + 1)
    if (record.type.startsWith('compaction')) {
      events.push({ time: record.time, type: record.type, data: record.data })
    }
    if (record.time !== undefined) {
      firstTime = firstTime === 0 ? record.time : Math.min(firstTime, record.time)
      lastTime = Math.max(lastTime, record.time)
    }
  }
  if (header === null) continue
  const haystack = `${header.id} ${title ?? ''} ${model ?? ''}`
  if (filter !== '' && !haystack.toLowerCase().includes(filter.toLowerCase())) continue

  const override = records[header.id]
  const counts = {}
  for (const [type, count] of types) if (type.startsWith('compaction')) counts[type] = count
  console.log(`\n=== ${header.id}`)
  console.log(`    title=${JSON.stringify(title)}  preset=${header.agentPreset ?? '?'}  model=${model ?? '?'}`)
  console.log(`    session value=${override ? JSON.stringify(override) : 'none'}`)
  console.log(`    window=${firstTime === 0 ? '?' : new Date(firstTime).toISOString()} .. ${new Date(lastTime).toISOString()}`)
  console.log(`    compaction events: ${Object.entries(counts).map(([type, count]) => `${type}×${count}`).join(' ') || 'none'}`)
  for (const event of events.slice(-12)) {
    const data = event.data ?? {}
    const detail = [data.compactionId?.slice(0, 8), data.turn === undefined ? undefined : `turn=${data.turn}`,
      data.error === undefined ? undefined : `error=${String(data.error).slice(0, 90)}`,
      data.shadowedTokenCount === undefined ? undefined : `shadowed=${data.shadowedTokenCount}`,
      data.trigger === undefined ? undefined : `trigger=${data.trigger}`].filter(Boolean).join(' ')
    console.log(`      ${new Date(event.time).toISOString()}  ${event.type}  ${detail}`)
  }
}
