/**
 * Pure pressure policy for the per-session compaction threshold.
 *
 * Nothing here imports DeepSeek Harness modules: these functions are the whole
 * decision surface of the engine, so `probe/probe.mjs` drives them without a
 * host. The engine and the host-plane service are the only callers.
 *
 * The threshold is a plain fraction of the declared context window:
 *
 *     thresholdTokens = floor(contextWindow × ratio)
 *
 * That is a deliberate difference from `@deepseek-ai/dsh-compaction-basic`
 * 0.1.7-rc.1, which also caps the threshold at
 * `contextWindow − outputReservation − headroomTokens`. That cap makes a large
 * output reservation shrink every percentage: on a 262 144-token window with
 * `maxTokens: 131072` and the default 65 536 headroom, the cap is 65 536 tokens,
 * so every setting from 25 % to 100 % behaves identically and the knob stops
 * meaning what it says. A percentage here is the share of the window the session
 * may fill before it compacts, and the output reservation cannot silently shrink
 * it. Span selection is still the upstream transcription
 * (`src/region.ts` `selectCompactableRange`): keeping it in one pure module is
 * what makes the plugin's behavioural differences reviewable at a glance.
 *
 * @module dsh-compaction-threshold/policy
 */

/** Request-pressure fraction used when neither the session nor the preset sets one. */
export const DEFAULT_THRESHOLD_RATIO = 0.8

/** Verbatim-tail fraction used when the preset sets neither retention form. */
export const DEFAULT_RETAIN_RATIO = 0.16

/** Default summary budget, which upstream also derives from its headroom field. */
export const DEFAULT_HEADROOM_TOKENS = 65_536

/** Ratios the composer menu offers, as percentages of the window. */
export const MENU_PERCENT_STEPS = [30, 40, 50, 60, 70, 80, 90, 100]

/** A resolved target's pressure configuration is unusable for its model capacity. */
export class ThresholdConfigError extends Error {
  /**
   * @param targetKey - exact `provider/model` route the failure belongs to.
   * @param message - actionable failure detail.
   */
  constructor(targetKey, message) {
    super(message)
    this.name = 'ThresholdConfigError'
    this.targetKey = targetKey
  }
}

/**
 * Merge one routed model's optional override over the resolved defaults.
 *
 * `headroomTokens` is kept because the inherited schema carries it and it still
 * supplies the default summary budget, but it no longer shifts the threshold:
 * see the module documentation.
 *
 * @param config - resolved plugin configuration (upstream fields, defaults applied).
 * @param target - exact provider/model route of the latest durable request.
 * @returns the policy this route compacts under, before capacity scaling.
 */
export function resolvePolicy(config, target) {
  const override = (config.modelPolicies ?? []).find(
    policy => policy.provider === target.provider && policy.model === target.model,
  )
  const inheritedRetention = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio ?? DEFAULT_RETAIN_RATIO }
    : { retainTokens: config.retainTokens }
  return {
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens ?? DEFAULT_HEADROOM_TOKENS,
    ...override?.retainTokens !== undefined
      ? { retainTokens: override.retainTokens }
      : override?.retainRatio !== undefined
        ? { retainRatio: override.retainRatio }
        : inheritedRetention,
    maxTokens: override?.maxTokens ?? config.maxTokens ?? DEFAULT_HEADROOM_TOKENS,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries ?? 1,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries ?? 1,
  }
}

/**
 * Scale one policy into concrete token budgets for its model capacity.
 *
 * The threshold is the window fraction and nothing else, so the same percentage
 * means the same thing on every route regardless of that route's output
 * reservation. The request still has to fit the provider's window — the prompt
 * plus its reserved completion — so a high percentage can reach a provider
 * overflow; the upstream recovery path handles that and bypasses this ratio by
 * design.
 *
 * @param policy - merged policy for the exact routed target.
 * @param contextWindow - positive adapter-reported capacity of that target.
 * @returns the pressure and retention budgets of this route.
 * @throws {ThresholdConfigError} when the window is unusable, or retention reaches the threshold.
 */
export function resolveSpec(policy, contextWindow) {
  const targetKey = `${policy.target.provider}/${policy.target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new ThresholdConfigError(
      targetKey,
      `compaction-threshold: contextWindow (${contextWindow}) must be a positive integer`,
    )
  }
  const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio)
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(contextWindow * policy.retainRatio)
    : policy.retainTokens
  if (retainTokens >= thresholdTokens) {
    throw new ThresholdConfigError(
      targetKey,
      `compaction-threshold: ${targetKey} retainTokens (${retainTokens}) must be less than threshold `
      + `tokens ${thresholdTokens}; lower retainRatio/retainTokens or raise the threshold ratio`,
    )
  }
  return {
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.thresholdRatio,
    thresholdTokens,
    retainTokens,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
  }
}

/**
 * Choose the inclusive surface span to replace, retaining a priced recent tail.
 *
 * The span starts at the first non-system surface node, so a system prompt at
 * surface node 0 is never shadowed, and never splits an assistant
 * tool-call/result pair.
 *
 * @param surfaceNodes - current surface seqs, in surface order.
 * @param pricedNodes - the token meter's priced nodes for that same surface.
 * @param retainTokens - minimum recent tail budget kept verbatim.
 * @param isBalancedBefore - boundary predicate for one surface seq.
 * @param hasSystemHead - whether surface node 0 is the session's system prompt.
 * @returns the inclusive span, or null when nothing may be compacted.
 */
export function selectCompactableRange(
  surfaceNodes,
  pricedNodes,
  retainTokens,
  isBalancedBefore,
  hasSystemHead,
) {
  if (pricedNodes.length === 0) return null
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction-threshold: token-meter surface does not match the current session surface')
  }
  const firstIdx = hasSystemHead && pricedNodes.length > 0 ? 1 : 0
  if (firstIdx >= pricedNodes.length) return null

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null

  while (keepFromIdx > firstIdx) {
    if (isBalancedBefore(surfaceNodes[keepFromIdx]) === true) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null

  return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }
}

/**
 * Parse one `/compaction-threshold` argument.
 *
 * Bare numbers at or below 1 are ratios (`0.4`), larger ones are percentages
 * (`40`, `40%`).
 *
 * @param raw - the command's raw input, already trimmed by the caller.
 * @returns the requested action, or the reason the input was rejected.
 */
export function parseThresholdInput(raw) {
  const text = raw.trim()
  if (text === '') return { kind: 'report' }
  if (text === 'default' || text === 'auto') return { kind: 'clear' }
  const numeric = /^([0-9]+(?:\.[0-9]+)?)\s*(%?)$/.exec(text)
  if (numeric === null) {
    return { kind: 'invalid', reason: `"${text}" is not a percentage or "default"` }
  }
  const value = Number(numeric[1])
  const ratio = numeric[2] === '%' || value > 1 ? value / 100 : value
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    return { kind: 'invalid', reason: `${text} must be a percentage in (0%, 100%]` }
  }
  return { kind: 'set', ratio }
}

/**
 * Render one ratio as a whole-or-one-decimal percentage.
 *
 * @param ratio - window fraction in (0, 1].
 * @returns the localized-number-free percentage text, e.g. `40%`.
 */
export function formatPercent(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—'
  const percent = ratio * 100
  return `${Number.isInteger(percent) ? percent : Math.round(percent * 10) / 10}%`
}

/**
 * Whether a stored or user-supplied value is usable as a threshold ratio.
 *
 * @param value - candidate value from storage or a command.
 * @returns whether the value is a finite fraction in (0, 1].
 */
export function isUsableRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
}

/**
 * How far up a fork or delegation lineage inheritance looks. A chain deeper than
 * this is treated as having no ancestor value rather than walked indefinitely.
 */
export const INHERIT_MAX_DEPTH = 16

/**
 * Find the nearest ancestor override for a forked or delegated session.
 *
 * A child inherits a snapshot: the caller persists the returned ratio as the
 * child's own value, so later changes to the ancestor leave the child alone.
 * The walk stops at the first ancestor that owns a ratio, and a lineage that
 * revisits an id (damaged storage) resolves to nothing rather than looping.
 *
 * @param options - starting ancestor id and the lineage/override lookups.
 * @param options.startId - direct parent of the inheriting session.
 * @param options.parentOf - id -> that session's own parent id, or null.
 * @param options.overrideOf - id -> that session's own ratio, or null.
 * @param options.maxDepth - maximum ancestors visited.
 * @returns the inherited ratio and the ancestor it came from, or null.
 */
export function resolveInheritedOverride({ startId, parentOf, overrideOf, maxDepth = INHERIT_MAX_DEPTH }) {
  const visited = new Set()
  let current = startId ?? null
  for (let depth = 0; depth < maxDepth && current !== null && current !== undefined; depth += 1) {
    if (visited.has(current)) return null
    visited.add(current)
    const ratio = overrideOf(current)
    if (isUsableRatio(ratio)) return { ratio, fromId: current }
    current = parentOf(current) ?? null
  }
  return null
}
