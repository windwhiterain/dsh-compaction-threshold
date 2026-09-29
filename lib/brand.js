/**
 * Capability brand shared by the plugin's two halves.
 *
 * The host-plane service has to decide whether one session's own agent
 * composition mounts an engine that honors a per-session ratio, because the
 * compaction backend is preset-owned: an agent preset supplies its own
 * `compaction` service inside an isolated realm, and a session running a preset
 * without this engine would accept, store, and display a ratio that nothing
 * reads.
 *
 * The brand is a `Symbol.for` key rather than an `instanceof` test against
 * `engine.js` for two reasons. The host row must stay loadable on its own, so
 * it cannot import the agent-plane engine module and its `dsh-compaction-basic`
 * dependency. And source hot reload replaces the engine's module generation
 * while an unchanged host row keeps the class it imported earlier, which would
 * make `instanceof` report every engine as a stranger after an engine edit. A
 * registry-global symbol key is module-generation independent, so both the mark
 * and the test survive a reload of either half.
 *
 * @module dsh-compaction-threshold/brand
 */

/** Property whose presence marks a compaction service as honoring a per-session ratio. */
export const THRESHOLD_ENGINE = Symbol.for('dsh-compaction-threshold/engine')
