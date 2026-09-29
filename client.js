/**
 * Web composer half: a chip beside the permission and model chips showing the
 * session's automatic compaction threshold, with a menu that changes it.
 *
 * The value is read from the `compactionThreshold` Session projection (the host
 * pushes it on every Session event, so a change made in another tab or by the
 * slash command lands here) and written by submitting
 * `/compaction-threshold <percent|default>`, so the composer and a typed line
 * share exactly one write path.
 *
 * Loaded as a dynamic client module; the factory id must equal the package name
 * so the bundle route and the module-table identity agree.
 */

// A combo batch concatenates every plugin bundle into one classic script, so
// top-level declarations share one global lexical scope across plugins. The
// IIFE keeps this bundle's names (for example `DEFAULT_OPTION`) out of it and
// leaves only the `load` call below at the top level.
;(function () {
/** Menu percentages offered as one-tap values. */
const STEP_PERCENTS = [30, 40, 50, 60, 70, 80, 90, 100]

/** Option id that clears the override and restores the preset's ratio. */
const DEFAULT_OPTION = 'default'

/** Option id of the non-selectable failure row. */
const ERROR_OPTION = 'error'

/** Dictionary namespace owned by this plugin. */
const NS = 'compactionThreshold'

/** Chinese copy. */
const zh = {
  'chip': '压缩 {percent}',
  'chip.unknown': '压缩 默认',
  'menu.trigger': '约在 {window} tokens 的 {percent} 触发',
  'menu.unmeasured': '本次会话还没有可测量的请求',
  'option.percent': '{percent}',
  'option.default': '默认（{percent}）',
  'option.defaultUnknown': '默认',
  'mode': '自动压缩阈值：{name}',
  'note.inherited': '继承自父会话',
  'number.thousand': '{value}K',
  'number.million': '{value}M',
  'error.command': '阈值修改失败：{message}',
  'error.unavailable': '宿主没有提供 /compaction-threshold 命令',
}

/** English copy. */
const en = {
  'chip': 'Compact {percent}',
  'chip.unknown': 'Compact default',
  'menu.trigger': 'Triggers near {percent} of {window} tokens',
  'menu.unmeasured': 'No measured request in this session yet',
  'option.percent': '{percent}',
  'option.default': 'Default ({percent})',
  'option.defaultUnknown': 'Default',
  'mode': 'Auto-compaction threshold: {name}',
  'note.inherited': 'inherited from the parent session',
  'number.thousand': '{value}K',
  'number.million': '{value}M',
  'error.command': 'The threshold was not changed: {message}',
  'error.unavailable': 'This host offers no /compaction-threshold command',
}

window.__ModuleLoader__.load({
  id: 'dsh-compaction-threshold',
  factory(require) {
    const React = require('react')
    // `ui-primitives` is a baseline platform module: the shell seeds it into the
    // frozen module table, so a dynamic bundle requires it without declaring an
    // external. Its Menu keeps this chip's popup identical to its siblings.
    const { IconChevronDownOutlineRegular, Menu } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState } = React

    /** Render a window size for the trigger sentence. */
    function formatTokens(value, t) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value < 1000) return String(value)
      if (value < 1000000) return t('number.thousand', { value: Math.round(value / 1000) })
      return t('number.million', { value: Math.round(value / 100000) / 10 })
    }

    /** Render one ratio as a percentage; the host's own precision is whole or one decimal. */
    function formatPercent(ratio) {
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—'
      const percent = ratio * 100
      return `${Number.isInteger(percent) ? percent : Math.round(percent * 10) / 10}%`
    }

    /** Stable option id for one menu percentage. */
    function optionId(percent) {
      return `${percent}%`
    }

    /** The chip's inline chrome, matching the sibling composer chips. */
    const triggerStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      minWidth: 0,
      maxWidth: '220px',
      height: '28px',
      padding: '0 4px 0 8px',
      border: 'none',
      borderRadius: '24px',
      outline: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '13px',
      lineHeight: '20px',
      fontWeight: 500,
      cursor: 'pointer',
    }

    const chevronStyle = {
      display: 'inline-flex',
      flex: '0 0 auto',
      color: 'var(--dsw-alias-label-caption)',
      transition: 'transform 120ms ease',
    }

    const labelStyle = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    const rowStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      minWidth: 0,
    }

    const detailStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '11px',
      lineHeight: '14px',
    }

    /**
     * One row of the threshold menu.
     * @param props - row text, optional detail line, and the row's selectable state.
     */
    function Row({ label, detail }) {
      if (detail === undefined) return h('span', { style: labelStyle }, label)
      return h('span', { style: rowStyle }, h('span', { style: labelStyle }, label), h('span', { style: detailStyle }, detail))
    }

    /**
     * The composer chip: current threshold, and a menu that changes it.
     * @param props - Session standard seats plus this slot's injected writer.
     */
    function CompactionThresholdChip({ useProjection, setRatio, t }) {
      const facts = useProjection('compactionThreshold')
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [hover, setHover] = useState(false)

      // A preset without the engine row publishes no value for this session: the
      // chip is absent rather than offering a switch that no backend honors.
      if (facts == null) return null

      const ratio = facts.ratio
      const configured = facts.configuredRatio
      const currentId = ratio === null ? DEFAULT_OPTION : optionId(Math.round(ratio * 100))
      const label = ratio === null ? t('chip.unknown') : t('chip', { percent: formatPercent(ratio) })
      const trigger = facts.thresholdTokens === null || facts.contextWindow === null
        ? t('menu.unmeasured')
        : t('menu.trigger', {
          percent: formatPercent(facts.thresholdTokens / facts.contextWindow),
          window: formatTokens(facts.contextWindow, t),
        })
      // A value inherited from the parent session is still this session's own
      // value; the note only keeps its origin visible.
      const inheritedNote = facts.inherited === true ? t('note.inherited') : null
      const title = inheritedNote === null ? trigger : `${trigger} · ${inheritedNote}`

      const items = [{ type: 'label', id: 'heading', text: trigger }]
      if (inheritedNote !== null) items.push({ type: 'label', id: 'inherited', text: inheritedNote })
      if (error !== null) {
        items.push({ id: ERROR_OPTION, label: error, disabled: true, danger: true })
      }
      items.push({
        id: DEFAULT_OPTION,
        label: h(Row, {
          label: configured === null
            ? t('option.defaultUnknown')
            : t('option.default', { percent: formatPercent(configured) }),
        }),
      })
      for (const percent of STEP_PERCENTS) {
        const id = optionId(percent)
        items.push({
          id,
          label: h(Row, {
            label: t('option.percent', { percent: id }),
            detail: id === currentId && facts.source !== 'configured' ? trigger : undefined,
          }),
        })
      }

      const choose = (id) => {
        if (id === ERROR_OPTION) return
        setOpen(false)
        if (id === currentId) return
        setBusy(true)
        setError(null)
        Promise.resolve(setRatio(id === DEFAULT_OPTION ? DEFAULT_OPTION : id))
          .catch((failure) => {
            setError(t('error.command', {
              message: failure instanceof Error ? failure.message : String(failure),
            }))
            setOpen(true)
          })
          .finally(() => { setBusy(false) })
      }

      return h(Menu, {
        open,
        items,
        selectedId: currentId,
        onSelect: choose,
        onClose: () => { setOpen(false) },
        side: 'top',
        portal: true,
        anchor: h('button', {
          type: 'button',
          style: {
            ...triggerStyle,
            ...hover && !busy ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {},
            ...busy ? { color: 'var(--dsw-alias-label-dimmed)', cursor: 'default' } : {},
          },
          title,
          'aria-label': t('mode', { name: label }),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: busy,
          onClick: () => { setOpen(!open) },
          onMouseEnter: () => { setHover(true) },
          onMouseLeave: () => { setHover(false) },
        },
        h('span', { style: labelStyle }, label),
        h('span', { style: { ...chevronStyle, ...open ? { transform: 'rotate(180deg)' } : {} }, 'aria-hidden': true },
          h(IconChevronDownOutlineRegular)),
        ),
      })
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'compaction-threshold: dictionaries')
        const t = ctx.locale.bind(NS)
        const sessions = ctx.sessions
        const submit = async (sessionId, argument) => {
          const live = sessions.binding(sessionId)?.session
          if (live === undefined) throw new Error('this session is not materialized yet')
          const result = await live.command(`/compaction-threshold ${argument}`)
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          if (!result.value.matched) throw new Error(t('error.unavailable'))
          return true
        }
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'compaction-threshold',
          order: 30,
          locale: NS,
          inject: sessionId => ({ setRatio: argument => submit(sessionId, argument) }),
        }, CompactionThresholdChip))
      },
    }
  },
})
})()
