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
 * A forked session and a subagent child both record their direct parent in
 * `SessionHeader.parentSession` (`packages/core/session/src/types.ts`), so a
 * child inherits the nearest ancestor's ratio as a snapshot: the first time the
 * child is observed, the value is resolved up the lineage and persisted as the
 * child's own, after which the two sessions evolve independently. The record
 * that carries a snapshot is also the marker that the inheritance is spent, so
 * clearing the value in a child returns it to the preset default instead of
 * re-inheriting.
 *
 * @module dsh-compaction-threshold
 */

import { Service } from '@deepseek-ai/cordis'
import { formatPercent, isUsableRatio, parseThresholdInput, resolveInheritedOverride } from './lib/policy.js'
import { THRESHOLD_ENGINE } from './lib/brand.js'

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
  inherited: false,
  thresholdTokens: null,
  contextWindow: null,
  retainTokens: null,
}

/** Whether two fact records are equal field for field (the projection change gate). */
function sameFacts(left, right) {
  return left.ratio === right.ratio
    && left.configuredRatio === right.configuredRatio
    && left.source === right.source
    && left.inherited === right.inherited
    && left.thresholdTokens === right.thresholdTokens
    && left.contextWindow === right.contextWindow
    && left.retainTokens === right.retainTokens
}

/**
 * Accept one stored record, keeping only the fields this plugin owns and
 * dropping anything unusable, so a hand-edited or older unit cannot inject a
 * value the engine would refuse.
 *
 * @param record - value read from the storage domain.
 * @returns the normalized record, or null when it carries nothing usable.
 */
function normalizeRecord(record) {
  if (record === null || typeof record !== 'object') return null
  const ratio = isUsableRatio(record.ratio) ? record.ratio : null
  const inheritedFrom = typeof record.inheritedFrom === 'string' ? record.inheritedFrom : undefined
  const inheritedRatio = isUsableRatio(record.inheritedRatio) ? record.inheritedRatio : undefined
  if (ratio === null && inheritedFrom === undefined) return null
  return {
    ratio,
    ...inheritedFrom === undefined ? {} : { inheritedFrom },
    ...inheritedRatio === undefined ? {} : { inheritedRatio },
  }
}

/** One session's automatic compaction threshold, writable while it runs. */
export default class CompactionThresholdService extends Service {
  constructor(ctx) {
    super(ctx, 'compactionThreshold')
    /**
     * Session id -> durable record, the synchronous read path of the engine.
     * A `null` ratio means the session follows the preset; the record itself
     * still marks an inherited snapshot as spent.
     */
    this.records = new Map()
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
            const normalized = normalizeRecord(record)
            if (normalized !== null) this.records.set(sessionId, normalized)
          }
          child.logger.info(
            `compaction-threshold: ${this.records.size} session record(s) restored`,
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
        init: (header) => {
          // The chip must show an inherited value before the session's first
          // request resolves one, so inheritance is applied at first observation.
          this.applyInheritance(header.id, header.parentSession ?? null)
          return this.recompute({ sessionId: header.id, ...EMPTY_FACTS })
        },
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
   * The session's own ratio, an inherited snapshot it owns, or null when the
   * preset's configured ratio applies.
   * @param session - session whose value is read.
   * @returns the effective ratio with its origin, or null for the configured ratio.
   */
  ratioFor(session) {
    this.applyInheritance(session.id, session.header?.parentSession ?? null)
    const record = this.records.get(session.id)
    if (record === undefined || record.ratio === null) return null
    return {
      ratio: record.ratio,
      source: record.inheritedFrom !== undefined && record.ratio === record.inheritedRatio
        ? 'inherited'
        : 'session',
    }
  }

  /**
   * Give a forked or delegated session its parent's value once, as a snapshot.
   *
   * The write is memory-first: the value applies to the current step even if the
   * durable put is still in flight or fails, matching the store's general
   * degrade-to-process-local rule. A session that already owns a record has
   * spent its inheritance, which is what keeps `default` from re-inheriting.
   *
   * @param sessionId - the inheriting session.
   * @param parentId - its direct parent, absent for a top-level session.
   */
  applyInheritance(sessionId, parentId) {
    if (parentId === null || parentId === undefined) return
    if (this.records.has(sessionId)) return
    const found = resolveInheritedOverride({
      startId: parentId,
      parentOf: id => this.parentOf(id),
      overrideOf: id => this.records.get(id)?.ratio ?? null,
    })
    if (found === null) return
    const record = { ratio: found.ratio, inheritedFrom: found.fromId, inheritedRatio: found.ratio }
    this.records.set(sessionId, record)
    void this.persist(sessionId, record, true).catch((error) => {
      this.ctx.logger.warn(
        `compaction-threshold: inherited value for ${sessionId} stays in memory `
        + `(${error instanceof Error ? error.message : String(error)})`,
      )
    })
  }

  /**
   * The direct parent recorded by one session's header.
   * @param sessionId - session to read.
   * @returns the parent id, or null when the session has none or is not live.
   */
  parentOf(sessionId) {
    const sessions = this.ctx.get('sessions')
    const session = sessions?.get(sessionId)
    return session?.header?.parentSession ?? null
  }

  /**
   * Write one session's record, durably when the domain is open.
   * @param sessionId - session the record belongs to.
   * @param record - the value to store.
   * @param onlyIfAbsent - skip the write when a record appeared meanwhile.
   * @returns after the durable write settles.
   */
  async persist(sessionId, record, onlyIfAbsent = false) {
    const domain = this.domain
    if (domain === null) return
    if (onlyIfAbsent && this.records.get(sessionId) !== record) return
    await domain.table(DOMAIN_TABLE).put(sessionId, { ...record, updatedAt: Date.now() })
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
   * Durable write path for one session's value; an absent storage domain
   * degrades to a process-local value rather than failing the switch.
   *
   * Clearing keeps the record with a null ratio: the record is also the marker
   * that an inherited snapshot was already spent, so the session returns to the
   * preset default instead of inheriting again. An inherited snapshot's origin
   * is kept, so the composer reports the lineage only while the inherited value
   * is still the session's value.
   *
   * @param sessionId - session the value belongs to.
   * @param ratio - the new ratio, or null to restore the configured one.
   */
  async setRatio(sessionId, ratio) {
    const previous = this.records.get(sessionId)
    const record = {
      ratio: ratio === null ? null : ratio,
      ...previous?.inheritedFrom === undefined ? {} : { inheritedFrom: previous.inheritedFrom },
      ...previous?.inheritedRatio === undefined ? {} : { inheritedRatio: previous.inheritedRatio },
    }
    this.records.set(sessionId, record)
    await this.persist(sessionId, record)
  }

  /** Run one `/compaction-threshold` invocation. */
  async applyCommand(agent, rawInput) {
    const sessionId = agent.session.id
    // A value accepted here would be stored and displayed while the session's
    // own backend ignores it, so a session without this engine is told instead.
    if (!this.hasEngine(sessionId)) {
      return {
        kind: 'error',
        text: 'compaction-threshold: this session\'s agent preset does not mount '
          + 'dsh-compaction-threshold/engine, so it has no per-session threshold',
      }
    }
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
    const record = this.records.get(sessionId)
    const resolved = this.resolved.get(sessionId)
    const effective = record?.ratio ?? resolved?.ratio ?? this.configured.ratio
    const inherited = record?.ratio !== null && record?.ratio !== undefined
      && record.inheritedFrom !== undefined && record.ratio === record.inheritedRatio
    const origin = inherited ? 'inherited from the parent session'
      : record?.ratio == null ? 'configured' : 'this session'
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
   * Fold the current value and resolution into one fact record, returning the
   * previous object when nothing observable changed (the registry's change gate
   * compares references).
   */
  recompute(previous) {
    const sessionId = previous.sessionId
    const record = this.records.get(sessionId)
    const override = record?.ratio ?? null
    const resolved = this.resolved.get(sessionId)
    const ratio = override ?? resolved?.ratio ?? this.configured.ratio
    const fresh = resolved !== undefined && resolved.ratio === ratio ? resolved : undefined
    const inherited = override !== null && record.inheritedFrom !== undefined
      && override === record.inheritedRatio
    const next = {
      sessionId,
      ratio: ratio ?? null,
      configuredRatio: this.configured.ratio ?? null,
      source: ratio === null || ratio === undefined
        ? 'unknown'
        : inherited ? 'inherited' : override === null ? 'configured' : 'session',
      inherited: inherited || (fresh?.source === 'inherited'),
      thresholdTokens: fresh?.thresholdTokens ?? null,
      contextWindow: fresh?.contextWindow ?? null,
      retainTokens: fresh?.retainTokens ?? null,
    }
    return sameFacts(previous, next) ? previous : next
  }

  /**
   * Identity-stable wire value for one fact record, or `null` when the session's
   * composition has no engine to honor a ratio, which the client reads as this
   * control not being offered.
   *
   * Absence is a `null` value rather than an omitted key because the registry
   * assigns this key unconditionally and a `SessionSummary` carries these values
   * through the `api-session/added` Remote event, whose lossless-JSON check
   * rejects an `undefined` member. The key stays present with a JSON-safe value
   * that means "not offered for this session".
   *
   * The gate is applied here rather than in the fold because the engine's
   * presence is not a session fact: a recompose changes it without appending
   * anything, while this function is evaluated on every read.
   */
  viewOf(state) {
    if (!this.hasEngine(state.sessionId)) return null
    const cached = this.views.get(state.sessionId)
    if (cached !== undefined && cached.facts === state) return cached.value
    const value = {
      ratio: state.ratio,
      configuredRatio: state.configuredRatio,
      source: state.source,
      inherited: state.inherited,
      thresholdTokens: state.thresholdTokens,
      contextWindow: state.contextWindow,
      retainTokens: state.retainTokens,
    }
    this.views.set(state.sessionId, { facts: state, value })
    return value
  }

  /**
   * Whether one session's own composition mounts this plugin's engine as its
   * `compaction` service.
   *
   * A preset revision publishes its services behind an `isolate` realm, so the
   * engine is unreadable through `agent.ctx.get('compaction')`; the registry's
   * `serviceFor` resolves the revision that agent joined instead
   * (`@deepseek-ai/dsh-agent-preset-registry` `src/mount.ts`). Asking the registry
   * by agent rather than by preset id keeps the answer tied to the composition
   * the session actually received, which is what a recompose changes.
   *
   * A deployment composing no preset roster falls back to the agent's own realm,
   * which is where a host-plane backend publishes.
   *
   * A session with no registered agent reports true: creation mounts the preset
   * before publishing the agent, so an unregistered agent is one whose
   * composition is not yet known, and withholding the control from a session
   * that is still being created is the worse error.
   *
   * @param sessionId - session whose agent composition is inspected.
   * @returns whether a ratio written for that session would be honored.
   */
  hasEngine(sessionId) {
    const agent = this.ctx.get('agents')?.get(sessionId)
    if (agent === undefined) return true
    const engine = this.ctx.get('agentPresets')?.serviceFor(agent, 'compaction')
      ?? agent.ctx.get('compaction')
    return engine?.[THRESHOLD_ENGINE] === true
  }
}
