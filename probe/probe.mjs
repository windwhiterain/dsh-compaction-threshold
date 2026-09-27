/**
 * Offline probe for the pure policy module.
 *
 * Runs without a Harness, a host, or any dependency: `node probe/probe.mjs`.
 * It covers the threshold arithmetic, the range selection, and the command
 * grammar — the parts of this plugin that a live run only exercises indirectly.
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_HEADROOM_TOKENS,
  ThresholdConfigError,
  formatPercent,
  isUsableRatio,
  parseThresholdInput,
  resolveInheritedOverride,
  resolvePolicy,
  resolveSpec,
  selectCompactableRange,
} from '../lib/policy.js'

let checks = 0
const test = (name, run) => {
  run()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

const policy = (overrides = {}) => ({
  target: { provider: 'p', model: 'm' },
  thresholdRatio: 0.8,
  headroomTokens: DEFAULT_HEADROOM_TOKENS,
  retainRatio: 0.16,
  maxTokens: DEFAULT_HEADROOM_TOKENS,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  ...overrides,
})

test('threshold is the window fraction when it binds below the capacity cap', () => {
  const spec = resolveSpec(policy({ thresholdRatio: 0.4 }), 1_000_000)
  assert.equal(spec.thresholdTokens, 400_000)
  assert.equal(spec.retainTokens, 160_000)
})

test('the percentage is a plain fraction of the window, with no capacity cap', () => {
  const spec = resolveSpec(policy({ thresholdRatio: 0.99 }), 1_000_000)
  assert.equal(spec.thresholdTokens, 990_000)
  const full = resolveSpec(policy({ thresholdRatio: 1 }), 262_144)
  assert.equal(full.thresholdTokens, 262_144)
})

test('a reserved completion budget no longer shrinks the threshold', () => {
  // The route reserves half the window for output; the ratio still means the
  // share of the window, which is what the composer showed the user.
  const spec = resolveSpec(policy(), 262_144)
  assert.equal(spec.thresholdTokens, Math.floor(262_144 * 0.8))
  assert.equal(spec.retainTokens, Math.floor(262_144 * 0.16))
})

test('an absolute retention budget is used verbatim', () => {
  const spec = resolveSpec(policy({ retainRatio: undefined, retainTokens: 5_000 }), 1_000_000)
  assert.equal(spec.retainTokens, 5_000)
})

test('retention reaching the threshold is a configuration failure', () => {
  assert.throws(
    () => resolveSpec(policy({ thresholdRatio: 0.1 }), 1_000_000),
    error => error instanceof ThresholdConfigError && /retainTokens \(160000\) must be less than/.test(error.message),
  )
})

test('a window that cannot carry a request is a configuration failure', () => {
  assert.throws(
    () => resolveSpec(policy(), 0),
    error => error instanceof ThresholdConfigError && /must be a positive integer/.test(error.message),
  )
})

test('an exact per-model override wins over the defaults', () => {
  const config = {
    thresholdRatio: 0.8,
    headroomTokens: 65_536,
    retainRatio: 0.16,
    maxTokens: 65_536,
    compactionRetries: 1,
    maxOverflowRetries: 1,
    modelPolicies: [{ provider: 'p', model: 'other', thresholdRatio: 0.3 }, { provider: 'p', model: 'm', thresholdRatio: 0.5, retainTokens: 1_000 }],
  }
  assert.equal(resolvePolicy(config, { provider: 'p', model: 'm' }).thresholdRatio, 0.5)
  assert.equal(resolvePolicy(config, { provider: 'p', model: 'm' }).retainTokens, 1_000)
  assert.equal(resolvePolicy(config, { provider: 'p', model: 'unlisted' }).thresholdRatio, 0.8)
})

test('missing configuration fields fall back to the documented defaults', () => {
  const resolved = resolvePolicy({}, { provider: 'p', model: 'm' })
  assert.equal(resolved.thresholdRatio, 0.8)
  assert.equal(resolved.headroomTokens, 65_536)
  assert.equal(resolved.retainRatio, 0.16)
  assert.equal(resolved.compactionRetries, 1)
})

test('range selection keeps a priced tail and never shadows a system head', () => {
  const nodes = [10, 11, 12, 13, 14, 15]
  const priced = nodes.map(seq => ({ seq, tokens: 10 }))
  const balanced = seq => seq !== 12
  assert.deepEqual(
    selectCompactableRange(nodes, priced, 30, balanced, false),
    { start: 10, end: 12 },
  )
  assert.deepEqual(
    selectCompactableRange(nodes, priced, 30, balanced, true),
    { start: 11, end: 12 },
  )
})

test('range selection walks back to a balanced boundary', () => {
  const nodes = [10, 11, 12, 13, 14, 15]
  const priced = nodes.map(seq => ({ seq, tokens: 10 }))
  assert.deepEqual(
    selectCompactableRange(nodes, priced, 30, seq => seq === 11 || seq === 12, false),
    { start: 10, end: 11 },
  )
})

test('range selection refuses a span that would empty the surface', () => {
  const nodes = [10, 11]
  const priced = nodes.map(seq => ({ seq, tokens: 10 }))
  assert.equal(selectCompactableRange(nodes, priced, 1_000, () => true, false), null)
  assert.equal(selectCompactableRange(nodes, priced, 30, () => true, true), null)
  assert.equal(selectCompactableRange(nodes, [], 30, () => true, false), null)
})

test('range selection rejects a surface the meter does not agree with', () => {
  assert.throws(
    () => selectCompactableRange([10, 11], [{ seq: 10, tokens: 1 }], 0, () => true, false),
    /does not match the current session surface/,
  )
})

test('the command grammar reads percentages, ratios, and the reset word', () => {
  assert.deepEqual(parseThresholdInput(''), { kind: 'report' })
  assert.deepEqual(parseThresholdInput('40'), { kind: 'set', ratio: 0.4 })
  assert.deepEqual(parseThresholdInput('40%'), { kind: 'set', ratio: 0.4 })
  assert.deepEqual(parseThresholdInput(' 0.4 '), { kind: 'set', ratio: 0.4 })
  assert.deepEqual(parseThresholdInput('100'), { kind: 'set', ratio: 1 })
  assert.deepEqual(parseThresholdInput('default'), { kind: 'clear' })
  assert.deepEqual(parseThresholdInput('auto'), { kind: 'clear' })
  assert.equal(parseThresholdInput('0').kind, 'invalid')
  assert.equal(parseThresholdInput('150').kind, 'invalid')
  assert.equal(parseThresholdInput('abc').kind, 'invalid')
  assert.equal(parseThresholdInput('-5').kind, 'invalid')
})

test('percentages render without trailing zeros', () => {
  assert.equal(formatPercent(0.4), '40%')
  assert.equal(formatPercent(0.555), '55.5%')
  assert.equal(formatPercent(1), '100%')
  assert.equal(formatPercent(null), '—')
  assert.equal(isUsableRatio(0.4), true)
  assert.equal(isUsableRatio(1), true)
  assert.equal(isUsableRatio(0), false)
  assert.equal(isUsableRatio(1.2), false)
  assert.equal(isUsableRatio('0.4'), false)
})

/** Lineage stubs: `parents` maps a session id to its own parent. */
const lineage = (parents, ratios) => ({
  parentOf: id => parents[id] ?? null,
  overrideOf: id => ratios[id] ?? null,
})

test('a child inherits its direct parent value', () => {
  const lookups = lineage({ child: 'parent' }, { parent: 0.6 })
  assert.deepEqual(resolveInheritedOverride({ startId: 'parent', ...lookups }), { ratio: 0.6, fromId: 'parent' })
})

test('inheritance skips ancestors without a value', () => {
  const lookups = lineage({ child: 'parent', parent: 'grandparent', grandparent: 'root' }, { grandparent: 0.25 })
  assert.deepEqual(
    resolveInheritedOverride({ startId: 'parent', ...lookups }),
    { ratio: 0.25, fromId: 'grandparent' },
  )
})

test('an unusable ancestor value is not inherited', () => {
  const lookups = lineage({ parent: 'grandparent' }, { parent: 0, grandparent: 1.5 })
  assert.equal(resolveInheritedOverride({ startId: 'parent', ...lookups }), null)
})

test('a lineage with no value resolves to nothing', () => {
  const lookups = lineage({ parent: 'grandparent' }, {})
  assert.equal(resolveInheritedOverride({ startId: 'parent', ...lookups }), null)
  assert.equal(resolveInheritedOverride({ startId: null, ...lookups }), null)
})

test('a damaged cyclic lineage resolves to nothing instead of looping', () => {
  const lookups = lineage({ first: 'second', second: 'first' }, {})
  assert.equal(resolveInheritedOverride({ startId: 'first', ...lookups }), null)
})

test('the walk stops at the depth cap', () => {
  const parents = {}
  const chain = Array.from({ length: 25 }, (_value, index) => `s${index}`)
  chain.forEach((id, index) => { if (index > 0) parents[id] = chain[index - 1] })
  const lookups = lineage(parents, { s0: 0.3 })
  assert.equal(resolveInheritedOverride({ startId: 's24', ...lookups }), null)
  assert.deepEqual(
    resolveInheritedOverride({ startId: 's24', ...lookups, maxDepth: 30 }),
    { ratio: 0.3, fromId: 's0' },
  )
})

console.log(`\n${checks} probes passed`)
