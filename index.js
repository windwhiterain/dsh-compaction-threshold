/**
 * Host-plane companion: the per-session threshold store, its Session
 * projection, and the command that writes it.
 *
 * This row owns everything that exists once per deployment rather than once per
 * agent: the durable store keyed by Session id, the value the Web composer
 * reads, and the write path both the composer and a typed slash command use.
 * The engine that acts on the value is a separate row inside an agent preset
 * (`dsh-compaction-threshold/engine`), because a compaction backend is mounted
 * in the same isolated realm as the `compaction` service it provides.
 *
 * The store is a storage domain, not a Session event: a Session event type
 * declared outside this harness is refused by the Session persistence reader
 * (`packages/session/session-persistence/src/storage-contract.ts`), because the
 * known-type catalog is generated at build time. Durable per-session state for
 * an out-of-tree plugin therefore lives beside the Session log, exactly like
 * any other non-session application data.
 *
 * @module dsh-compaction-threshold
 */

import { Service } from '@deepseek-ai/cordis'
import { formatPercent, isUsableRatio, parseThresholdInput } from './lib/policy.js'

/** Storage domain name; a storage unit name must match `/^[a-z][a-z0-9_]*$/`. */
const DOMAIN_NAME = 'compaction_threshold'

/** Table holding one record per Session that carries an override. */
const DOMAIN_TABLE = 'sessions'

/** Session projection key the Web composer reads the current value from. */
const PROJECTION_KEY = 'compactionThreshold'

/** Slash command both the composer menu and a typed line use. */
const COMMAND_NAME = 'compaction-threshold'

/**
 * The domain facility calls only `valueSchema.parse` on stored records, so
 * record validation belongs to this plugin; see {@link CompactionThresholdService.setRatio}.
 */
const PASSTHROUGH_SCHEMA = { parse: value => value }

/** Facts one session's override and last resolution produce for the client. */
const EMPTY_FACTS = {
  ratio: null,
  configuredRatio: null,
  source: 'unknown',
  thresholdTokens: null,
  contextWindow: null,
  retainTokens: null,
}

/** Whether two fact records are equal field for field (the projection change gate). */
function sameFacts(left, right) {
  return left.ratio === right.ratio
    && left.configuredRatio === right.configuredRatio
    && left.source === right.source
    && left.thresholdTokens === right.thresholdTokens
    && left.contextWindow === right.contextWindow
    && left.retainTokens === right.retainTokens
}

/** One session's automatic compaction threshold, writable while it runs. */
export default class CompactionThresholdService extends Service {
  constructor(ctx) {
    super(ctx, 'compactionThreshold')
    /** Session id -> ratio override, the synchronous read path of the engine. */
    this.overrides = new Map()
    /** Session id -> facts of the last pressure resolution performed for it. */
    this.resolved = new Map()
    /** Identity-stable client views, keyed by Session id. */
    this.views = new Map()
    /** The preset's own ratio and retention, reported by the engine row. */
    this.configured = { ratio: null, retainRatio: null }
    this.domain = null

    ctx.inject(['storageDomain'], (child) => {
      child.effect(() => {
        let disposed = false
        const opening = child.storageDomain.open({
          name: DOMAIN_NAME,
          version: 1,
          global: { schema: PASSTHROUGH_SCHEMA, initial: { schema: 1 } },
          tables: { [DOMAIN_TABLE]: { valueSchema: PASSTHROUGH_SCHEMA } },
        }).then((domain) => {
          if (disposed) {
            void domain.close()
            return () => {}
          }
          this.domain = domain
          for (const [sessionId, record] of domain.table(DOMAIN_TABLE).entries()) {
            if (isUsableRatio(record?.ratio)) this.overrides.set(sessionId, record.ratio)
          }
          child.logger.info(
            `compaction-threshold: ${this.overrides.size} session override(s) restored`,
          )
          return () => domain.close()
        }).catch((error) => {
          child.logger.warn(
            `compaction-threshold: overrides cannot be persisted (${error instanceof Error ? error.message : String(error)}); they stay in memory for this process`,
          )
          return () => {}
        })
        return async () => {
          disposed = true
          const close = await opening
          await close()
        }
      })
    })

    ctx.inject(['sessionProjections'], (child) => {
      child.effect(() => child.sessionProjections.register({
        key: PROJECTION_KEY,
        stateVersion: 1,
        stateSchema: PASSTHROUGH_SCHEMA,
        init: header => this.recompute({ sessionId: header.id, ...EMPTY_FACTS }),
        apply: state => this.recompute(state),
        wire: {
          viewSchema: PASSTHROUGH_SCHEMA,
          view: state => this.viewOf(state),
        },
      }))
    })

    ctx.inject(['commands'], (child) => {
      child.effect(() => child.commands.register({
        name: COMMAND_NAME,
        description: 'Set this session\'s automatic compaction threshold',
        input: { hint: '<percent|default>' },
        handler: ({ agent, rawInput }) => this.applyCommand(agent, rawInput ?? ''),
      }))
    })
  }

  /**
   * The session's own override, or null when the preset's configured ratio applies.
   * @param session - session whose override is read.
   * @returns the override ratio, or null.
   */
  ratioFor(session) {
    const ratio = this.overrides.get(session.id)
    return ratio === undefined ? null : { ratio }
  }

  /**
   * Report the ratio and retention the engine row was configured with, so the
   * composer can show a truthful default before the first request resolves.
   * @param ratio - the row's configured threshold ratio.
   * @param retainRatio - the row's configured retention ratio, when it uses one.
   */
  registerConfigured(ratio, retainRatio) {
    this.configured = { ratio: ratio ?? null, retainRatio: retainRatio ?? null }
  }

  /**
   * Record the budgets the engine resolved for one session's latest request.
   * @param sessionId - session the resolution belongs to.
   * @param facts - effective ratio, its source, and the resolved token budgets.
   */
  recordResolved(sessionId, facts) {
    this.resolved.set(sessionId, facts)
  }

  /**
   * Durable write path for one session's override; an absent storage domain
   * degrades to a process-local value rather than failing the switch.
   * @param sessionId - session the override belongs to.
   * @param ratio - the new ratio, or null to restore the configured one.
   */
  async setRatio(sessionId, ratio) {
    const domain = this.domain
    if (ratio === null) {
      if (domain !== null) await domain.table(DOMAIN_TABLE).delete(sessionId)
      this.overrides.delete(sessionId)
      return
    }
    if (domain !== null) {
      await domain.table(DOMAIN_TABLE).put(sessionId, { ratio, updatedAt: Date.now() })
    }
    this.overrides.set(sessionId, ratio)
  }

  /** Run one `/compaction-threshold` invocation. */
  async applyCommand(agent, rawInput) {
    const sessionId = agent.session.id
    const parsed = parseThresholdInput(rawInput)
    switch (parsed.kind) {
      case 'report':
        return { kind: 'success', text: this.report(sessionId) }
      case 'clear':
        await this.setRatio(sessionId, null)
        return {
          kind: 'success',
          text: `compaction threshold back to the configured ${this.configuredText()}`,
        }
      case 'set': {
        const retainRatio = this.configured.retainRatio
        if (retainRatio !== null && parsed.ratio <= retainRatio) {
          return {
            kind: 'error',
            text: `${formatPercent(parsed.ratio)} leaves no room above the retained tail `
              + `(${formatPercent(retainRatio)}); pick a higher percentage`,
          }
        }
        await this.setRatio(sessionId, parsed.ratio)
        return { kind: 'success', text: `compaction threshold ${formatPercent(parsed.ratio)}` }
      }
      case 'invalid':
        return { kind: 'error', text: parsed.reason }
      default:
        return { kind: 'error', text: 'compaction-threshold: unsupported request' }
    }
  }

  /** The human-readable current value for one session. */
  report(sessionId) {
    const override = this.overrides.get(sessionId)
    const resolved = this.resolved.get(sessionId)
    const effective = override ?? resolved?.ratio ?? this.configured.ratio
    const origin = override === undefined ? 'configured' : 'this session'
    const trigger = resolved !== undefined && resolved.ratio === effective
      ? `, triggering near ${formatPercent(resolved.thresholdTokens / resolved.contextWindow)} `
        + `of ${resolved.contextWindow} tokens`
      : ''
    return `compaction threshold ${formatPercent(effective)} (${origin})${trigger}`
  }

  /** The configured fallback rendered for user-facing command text. */
  configuredText() {
    return this.configured.ratio === null ? 'default' : formatPercent(this.configured.ratio)
  }

  /**
   * Fold the current override and resolution into one fact record, returning
   * the previous object when nothing observable changed (the registry's change
   * gate compares references).
   */
  recompute(previous) {
    const sessionId = previous.sessionId
    const override = this.overrides.get(sessionId)
    const resolved = this.resolved.get(sessionId)
    const ratio = override ?? resolved?.ratio ?? this.configured.ratio
    const fresh = resolved !== undefined && resolved.ratio === ratio ? resolved : undefined
    const next = {
      sessionId,
      ratio: ratio ?? null,
      configuredRatio: this.configured.ratio ?? null,
      source: ratio === null || ratio === undefined
        ? 'unknown'
        : override === undefined ? 'configured' : 'session',
      thresholdTokens: fresh?.thresholdTokens ?? null,
      contextWindow: fresh?.contextWindow ?? null,
      retainTokens: fresh?.retainTokens ?? null,
    }
    return sameFacts(previous, next) ? previous : next
  }

  /** Identity-stable wire value for one fact record. */
  viewOf(state) {
    const cached = this.views.get(state.sessionId)
    if (cached !== undefined && cached.facts === state) return cached.value
    const value = {
      ratio: state.ratio,
      configuredRatio: state.configuredRatio,
      source: state.source,
      thresholdTokens: state.thresholdTokens,
      contextWindow: state.contextWindow,
      retainTokens: state.retainTokens,
    }
    this.views.set(state.sessionId, { facts: state, value })
    return value
  }
}
