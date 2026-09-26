/**
 * Compaction backend with a per-session threshold.
 *
 * This is `@deepseek-ai/dsh-compaction-basic` with one difference: the pressure
 * ratio for the routed model may be overridden per session. Everything else —
 * the summarizer call, pruning, the compaction transaction, retention, retries,
 * and context-overflow recovery — is the upstream implementation, inherited
 * unchanged.
 *
 * The override is read from the host-plane `compactionThreshold` service when
 * one is mounted, and falls back to this row's configured `thresholdRatio`
 * otherwise, so a missing service degrades to upstream behaviour instead of
 * disabling compaction.
 *
 * @module dsh-compaction-threshold/engine
 */

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import {
  resolvePolicy,
  resolveSpec,
  selectCompactableRange,
  ThresholdConfigError,
} from './lib/policy.js'

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session) {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/** Output tokens the routed request reserves, which share the window with the prompt. */
function reservedCompletionTokens(session, defaultMaxTokens) {
  return session.requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0
}

/** Whether surface node 0 is the session's system prompt, which a span never shadows. */
function hasSystemHead(session, headSeq) {
  return session.eventAt(headSeq)?.type === 'system/message'
}

export default class CompactionThresholdEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  constructor(ctx, config = {}) {
    super(ctx, config)
    this.thresholds = ctx.get('compactionThreshold')
    this.warnedTargets = new Set()
    this.registerConfigured()
  }

  /**
   * Publish this row's configured ratio to the host store, which reports it as
   * the value a session without its own follows. Re-published on every
   * resolution because a host-plane reload recreates that store while this row,
   * mounted in an agent preset, keeps running.
   */
  registerConfigured() {
    this.thresholds?.registerConfigured(
      this.config.thresholdRatio,
      this.config.retainRatio ?? null,
    )
  }

  /**
   * Compact for replayed step-boundary pressure under the session's own ratio,
   * or delegate one provider-confirmed context overflow to the upstream path,
   * which bypasses thresholds and retention by design.
   *
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or null when no summary ran.
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (trigger === 'context-overflow') {
      return super.compactIfNeeded(agent, trigger, signal)
    }

    const session = agent.session
    const target = routedTarget(session)
    if (target === undefined) return null
    const targetKey = `${target.provider}/${target.model}`
    const override = this.thresholds?.ratioFor(session) ?? null
    const base = resolvePolicy(this.config, target)
    const policy = override === null ? base : { ...base, thresholdRatio: override.ratio }

    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(session)
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    if (info.context === undefined) {
      throw new ThresholdConfigError(
        targetKey,
        `compaction-threshold: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }

    let spec
    try {
      spec = resolveSpec(
        policy,
        info.context.contextWindow,
        reservedCompletionTokens(session, info.defaultMaxTokens),
      )
    } catch (error) {
      // A misconfiguration is reported once per route, then skipped: the base
      // listener logs this throw, and repeating it every step would bury the
      // first report. Provider-confirmed overflow recovery stays available.
      if (error instanceof ThresholdConfigError && !this.warnedTargets.has(targetKey)) {
        this.warnedTargets.add(targetKey)
        throw error
      }
      return null
    }

    this.thresholds?.recordResolved(session.id, {
      ratio: spec.thresholdRatio,
      source: override?.source ?? 'configured',
      thresholdTokens: spec.thresholdTokens,
      contextWindow: spec.contextWindow,
      retainTokens: spec.retainTokens,
    })
    this.registerConfigured()

    if (measurement.totalTokens < spec.thresholdTokens) return null

    // Pruning is optional, so this backend stays independently composable; it
    // lands before choosing a summary range and can remove the need for one.
    const prune = this.ctx.get('toolResultPruner')
    if (prune !== undefined) {
      prune.pruneSession(session)
      measurement = meter.measure(session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const nodes = session.surface.nodes
      const range = selectCompactableRange(
        nodes,
        measurement.nodes,
        spec.retainTokens,
        seq => toolPairingBalancedBefore(session, seq),
        nodes.length > 0 && hasSystemHead(session, nodes[0]),
      )
      if (range === null) return result
      result = await this.compactRegion(range.start, range.end, agent, signal)
      measurement = meter.measure(session)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction-threshold: still above threshold after ${spec.compactionRetries + 1} compaction `
      + `attempts (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }
}
