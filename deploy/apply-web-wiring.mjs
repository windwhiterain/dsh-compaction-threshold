/**
 * Apply this plugin's rows to a DSH Web profile patch.
 *
 * Structural, not line-number based: it locates agent-preset items by their
 * `- id: preset-<name>` line and edits inside that item, so it survives unrelated
 * edits elsewhere in the patch. Without `--write` it only prints the plan.
 *
 * What it does:
 *   1. replaces the `compaction-basic` row inside the `compaction` group of the
 *      named presets with `dsh-compaction-threshold/engine`;
 *   2. removes a whole preset item (and its now-empty `- insert:` list) when
 *      `--remove-preset` names it;
 *   3. appends one `- insert:` list carrying the host-plane row that owns the
 *      per-session store, the Session projection, and the command.
 *
 * Usage:
 *   node deploy/apply-web-wiring.mjs <profile-patch.yml> [--write]
 *        [--presets personal,personal-browser] [--remove-preset minimal-git-bash-persistent]
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [patchPath, ...flags] = process.argv.slice(2)
if (patchPath === undefined) throw new Error('usage: node deploy/apply-web-wiring.mjs <profile-patch.yml> [--write]')
const write = flags.includes('--write')
const option = name => {
  const index = flags.indexOf(name)
  return index === -1 ? undefined : flags[index + 1]
}
const presets = (option('--presets') ?? 'personal,personal-browser').split(',').map(name => name.trim())
const removePreset = option('--remove-preset')

const HOST_ROW = 'compaction-threshold'
const ENGINE_ROW = 'compaction-threshold-engine'
const ENGINE_SPECIFIER = 'dsh-compaction-threshold/engine'
const REPLACED_ROW = 'compaction-basic'

/** Indent width of one line. */
const indentOf = line => line.length - line.trimStart().length

/** First line after `start` that closes the block opened at `start`. */
function blockEnd(lines, start) {
  const indent = indentOf(lines[start])
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue
    if (indentOf(lines[index]) <= indent) return index
  }
  return lines.length
}

/** Line index of every `- id: <value>` list item. */
function items(lines) {
  const found = new Map()
  lines.forEach((line, index) => {
    const match = /^\s*- id: (\S+)\s*$/.exec(line)
    if (match !== null && !found.has(match[1])) found.set(match[1], index)
  })
  return found
}

const original = readFileSync(patchPath, 'utf8')
let lines = original.split('\n')
const changes = []

// 1. swap the backend inside the named presets
for (const name of presets) {
  const start = items(lines).get(`preset-${name}`)
  if (start === undefined) throw new Error(`preset-${name} is not declared in ${patchPath}`)
  const end = blockEnd(lines, start)
  const row = lines.findIndex((line, index) => index > start && index < end
    && new RegExp(`^\\s*- id: ${REPLACED_ROW}\\s*$`).test(line))
  if (row === -1) {
    const already = lines.slice(start, end).some(line => new RegExp(`^\\s*- id: ${ENGINE_ROW}\\s*$`).test(line))
    changes.push(`preset-${name}: ${already ? 'already wired' : 'NO compaction row found'}`)
    continue
  }
  const rowEnd = blockEnd(lines, row)
  const indent = ' '.repeat(indentOf(lines[row]))
  const replacement = [
    `${indent}- id: ${ENGINE_ROW}`,
    `${indent}  name: '${ENGINE_SPECIFIER}'`,
    `${indent}  config:`,
    ...lines.slice(row + 3, rowEnd).filter(line => line.trim() !== ''),
  ]
  changes.push(`preset-${name}: ${REPLACED_ROW} -> ${ENGINE_ROW} (lines ${row + 1}-${rowEnd})`)
  lines = [...lines.slice(0, row), ...replacement, ...lines.slice(rowEnd)]
}

// 2. remove a preset item, together with an `- insert:` list left empty
if (removePreset !== undefined) {
  const start = items(lines).get(`preset-${removePreset}`)
  if (start === undefined) {
    changes.push(`preset-${removePreset}: already absent`)
  } else {
    const end = blockEnd(lines, start)
    const itemIndent = indentOf(lines[start])
    // The list header is the nearest shallower `- insert:`; drop it too when this
    // was the only item, so the patch never carries an empty insert list.
    let insertLine = -1
    for (let index = start - 1; index >= 0; index -= 1) {
      if (lines[index].trim() === '') continue
      if (indentOf(lines[index]) < itemIndent) {
        if (lines[index].trim() === '- insert:') insertLine = index
        break
      }
    }
    const listEnd = insertLine === -1 ? end : blockEnd(lines, insertLine)
    const siblings = insertLine === -1
      ? 0
      : lines.slice(insertLine + 1, listEnd)
        .filter(line => line.trim() !== '' && indentOf(line) === itemIndent && line.trim().startsWith('- ')).length
    const from = siblings <= 1 && insertLine !== -1 ? insertLine : start
    changes.push(`preset-${removePreset}: removed lines ${from + 1}-${end}`
      + `${siblings <= 1 && insertLine !== -1 ? ' (with its now-empty insert list)' : ''}`)
    lines = [...lines.slice(0, from), ...lines.slice(end)]
  }
}

// 3. append the host-plane row
if (items(lines).get(HOST_ROW) !== undefined) {
  changes.push(`host row ${HOST_ROW}: already present`)
} else {
  const block = [
    '',
    '# Per-session automatic compaction threshold: host-plane half. It owns the',
    '# durable per-session override, the `compactionThreshold` Session projection the',
    '# composer chip reads, and the `/compaction-threshold` command both write through.',
    '- insert:',
    `    - id: ${HOST_ROW}`,
    `      name: 'dsh-compaction-threshold'`,
    '',
  ]
  lines = [...lines, ...block]
  changes.push(`host row ${HOST_ROW}: appended`)
}

const next = lines.join('\n')
for (const change of changes) console.log(`- ${change}`)
if (!write) {
  console.log('\n(dry run; pass --write to apply)')
} else if (next === original) {
  console.log('\nno change')
} else {
  writeFileSync(patchPath, next, 'utf8')
  console.log(`\nwrote ${patchPath}`)
}
