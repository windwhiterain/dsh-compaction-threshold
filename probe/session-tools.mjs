/**
 * Read-only diagnostic: what preset and which tools a stored Session actually
 * carries.
 *
 * Decodes the zstd-framed session logs under `<DSH_HOME>/sessions` and reports,
 * per session, the selected agent preset, the tool names of its most recent
 * `request/header`, and the time of its last event. Written to investigate a
 * report that resumed sessions lost a tool after a host restart.
 *
 * Usage: node probe/session-tools.mjs [sessions-root] [limit]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
const limit = Number(process.argv[3] ?? 12)
const headersRequested = process.argv.includes('--headers')

/** Split one concatenated zstd stream into frames and decompress each. */
function decompressFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let at = buffer.indexOf(magic)
  while (at !== -1) {
    starts.push(at)
    at = buffer.indexOf(magic, at + 4)
  }
  const chunks = []
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // A trailing partial frame (a write in flight) is simply not read.
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Every stored session log, newest first. */
function sessionLogs() {
  const found = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(projectDir, session.name)
      for (const file of readdirSync(dir)) {
        if (!file.startsWith('session.v4.jsonl')) continue
        const path = join(dir, file)
        found.push({ project: project.name, session: session.name, path, time: statSync(path).mtimeMs })
      }
    }
  }
  return found.sort((left, right) => right.time - left.time)
}

const rows = []
for (const entry of sessionLogs().slice(0, limit)) {
  let text
  try {
    text = entry.path.endsWith('.zstd')
      ? decompressFrames(readFileSync(entry.path))
      : readFileSync(entry.path, 'utf8')
  } catch (error) {
    rows.push({ ...entry, error: String(error) })
    continue
  }
  let preset = null
  let tools = null
  const headers = []
  let lastTime = 0
  let delegationDepth = null
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
    if (typeof type !== 'string') continue
    lastTime = Math.max(lastTime, record.time ?? record.event?.time ?? 0)
    if (type === 'session') {
      preset = record.agentPreset ?? null
      delegationDepth = record.delegationDepth ?? null
    }
    if (type === 'agent-preset/selected') preset = data?.preset ?? data?.id ?? JSON.stringify(data)
    if (type === 'request/header') {
      const names = (data?.header?.tools ?? []).map(tool => tool?.name ?? tool?.function?.name)
        .filter(name => typeof name === 'string')
      if (names.length > 0) {
        tools = names
        headers.push({ time: record.time ?? 0, names })
      }
    }
  }
  rows.push({ ...entry, preset, tools, headers, delegationDepth, lastTime })
}

for (const row of rows) {
  const names = row.tools ?? []
  const flags = ['pwsh', 'git_bash', 'bash', 'wsl_bash'].map(name => `${name}:${names.includes(name) ? 'yes' : 'no'}`).join(' ')
  console.log([
    row.project,
    row.session.slice(0, 20),
    `preset=${row.preset ?? '?'}`,
    `depth=${row.delegationDepth ?? '?'}`,
    `tools=${names.length}`,
    flags,
    `last=${row.lastTime === undefined || row.lastTime === 0 ? '?' : new Date(row.lastTime).toISOString()}`,
    row.error === undefined ? '' : `error=${row.error}`,
  ].join('  '))
  if (!headersRequested) continue
  for (const header of row.headers) {
    console.log(`    header ${new Date(header.time).toISOString()}  tools=${header.names.length}  pwsh=${header.names.includes('pwsh') ? 'yes' : 'no'}  [${header.names.join(' ')}]`)
  }
}
