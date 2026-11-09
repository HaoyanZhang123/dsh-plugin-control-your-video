/**
 * Small shared render helpers for the workbench client.
 *
 * There is no component library and no JSX: the client bundle is built by concatenation, so a tiny
 * `h` wrapper over `React.createElement` keeps every view plain JavaScript and easy to scan.
 *
 * @module ui/client/ui
 */

/** React.createElement shorthand. */
export function h(type, props, ...children) {
  return React.createElement(type, props ?? null, ...children.filter((child) => child !== null && child !== undefined && child !== false))
}

const ICONS = Object.freeze({
  project: 'M4 6h16v13H4z M4 6l3-2h10l3 2 M9 3v3 M15 3v3',
  effects: 'M12 3l2.2 5.6L20 10l-4.6 3.1L17 19l-5-3-5 3 1.6-5.9L4 10l5.8-1.4z',
  tools: 'M14 6a4 4 0 1 0-3.6 4M10.4 10L5 15.4V19h3.6L14 13.6M14 6l4 4',
  prefs: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 2.6a7 7 0 0 0-1.7 1L5 5.6 3 9l2 1.6a7 7 0 0 0 0 2L3 14.2l2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.6h5l.3-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6a7 7 0 0 0 .1-1z',
  search: 'M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M16 16l4 4',
  plus: 'M12 5v14 M5 12h14',
  play: 'M8 5l11 7-11 7z',
  pause: 'M8 5v14 M16 5v14',
  prev: 'M6 5v14 M20 5l-9 7 9 7z',
  next: 'M6 5l9 7-9 7 M18 5v14',
  framePrev: 'M15 5l-8 7 8 7z',
  frameNext: 'M9 5l8 7-8 7z',
  upload: 'M12 16V5 M8 9l4-4 4 4 M4 16v3h16v-3',
  download: 'M12 4v11 M8 11l4 4 4-4 M4 19h16',
  check: 'M5 13l4 4L19 7',
  alert: 'M12 4l9 16H3z M12 10v4 M12 17v.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v6 M12 7v.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  film: 'M3 7h18v10H3z M7 7v10 M17 7v10 M3 12h18',
  image: 'M4 5h16v14H4z M4 15l4-4 4 4 3-3 5 5',
  audio: 'M9 18V6l10-2v12 M7 18a2 2 0 1 0 0 .1 M17 16a2 2 0 1 0 0 .1',
  text: 'M5 7V5h14v2 M12 5v14 M9 19h6',
  layers: 'M4 7l8-3 8 3-8 3z M4 12l8 3 8-3 M4 17l8 3 8-3',
  marker: 'M6 4v16 M6 5l10 4-10 4z',
  scissor: 'M6 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M6 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M9 8l11-4 M9 16l11 4 M14 12l6 0',
  assistant: 'M21 12a8 8 0 1 1-2.3-5.7 M21 4v5h-5',
  close: 'M6 6l12 12 M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  arrowRight: 'M5 12h14 M13 6l6 6-6 6',
  restore: 'M4 4v6h6 M5.5 13a7 7 0 1 0 1-5.5L4 10',
  external: 'M14 4h6v6 M20 4l-9 9 M20 14v6H4V4h6',
  badge: 'M12 3l2 4 4 .6-3 2.9.7 4.1-3.7-2-3.7 2 .7-4.1-3-2.9L10 7z',
})

export function Icon(props) {
  const name = props?.name ?? 'info'
  const size = props?.size ?? 16
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: props?.strokeWidth ?? 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, h('path', { d: ICONS[name] ?? ICONS.info }))
}

export function Btn(props) {
  const variant = props?.variant ?? 'default'
  const hasText = props?.children !== undefined && props?.children !== null && props?.children !== false
    && !(Array.isArray(props.children) && props.children.length === 0)
  // Icon-only sizing must NOT shrink an icon+label button into a 28px square.
  const className = ['avw-btn', variant === 'primary' ? 'avw-btn--primary' : '', variant === 'ghost' ? 'avw-btn--ghost' : '', props?.size === 'sm' ? 'avw-btn--sm' : '', props?.icon && !hasText ? 'avw-btn--icon' : '', props?.className ?? '']
    .filter(Boolean).join(' ')
  return h('button', {
    type: 'button',
    className,
    title: props?.title,
    disabled: props?.disabled === true,
    'aria-label': props?.ariaLabel,
    'aria-pressed': props?.['aria-pressed'],
    onClick: props?.onClick,
  }, props?.icon ? h(Icon, { name: props.icon, size: 14 }) : null, props?.children)
}

export function Chip(props) {
  const tone = props?.tone ?? 'default'
  return h('span', { className: `avw-chip${tone === 'default' ? '' : ` avw-chip--${tone}`}`, title: props?.title },
    props?.dot ? h('i', null) : null, props?.children)
}

export function Field(props) {
  return h('label', { className: 'avw-field' },
    props?.icon ? h(Icon, { name: props.icon, size: 14 }) : null,
    h('input', {
      type: props?.type ?? 'text',
      value: props?.value ?? '',
      placeholder: props?.placeholder ?? '',
      'aria-label': props?.ariaLabel ?? props?.placeholder,
      onChange: (event) => props?.onInput?.(event.target.value),
      onKeyDown: props?.onKeyDown,
    }))
}

export function Seg(props) {
  return h('div', { className: 'avw-tabs-surface', role: 'tablist', 'aria-label': props?.label },
    (props?.items ?? []).map((item) => h('button', {
      key: item.id,
      type: 'button',
      role: 'tab',
      'aria-selected': String(item.id === props?.value),
      onClick: () => props?.onChange?.(item.id),
    }, item.label)))
}

export function Modal(props) {
  if (props?.open !== true) return null
  return h('div', { className: 'avw-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': props?.title, onClick: (event) => { if (event.target === event.currentTarget) props?.onClose?.() } },
    h('div', { className: 'avw-modal' },
      h('div', { className: 'avw-modal-head' },
        h('b', null, props?.title ?? ''),
        h('span', { className: 'avw-grow' }),
        h(Btn, { variant: 'ghost', icon: 'close', onClick: props?.onClose, ariaLabel: '关闭' })),
      h('div', { className: 'avw-modal-body' }, props?.children),
      props?.footer ? h('div', { className: 'avw-modal-foot' }, props.footer) : null))
}

export function Toast(props) {
  if (!props?.toast) return null
  return h('div', { className: `avw-toast${props.toast.tone === 'error' ? ' avw-toast--error' : ''}`, role: 'status' },
    props.toast.message)
}

export function Empty(props) {
  return h('div', { className: 'avw-empty' },
    h(Icon, { name: props?.icon ?? 'info', size: 28 }),
    h('b', null, props?.title ?? ''),
    props?.message ? h('p', null, props.message) : null,
    props?.children)
}

export function GapCard(props) {
  const gap = props?.gap ?? {}
  return h('div', { className: 'avw-gap' },
    h('b', null, `${gap.owner ?? ''} 尚未接入：${gap.title ?? ''}`),
    h('div', null, gap.message ?? ''),
    props?.action ? h('div', { style: { marginTop: '6px' } }, props.action) : null)
}

export function KV(props) {
  return h('div', { className: 'avw-kv' },
    h('label', null, props?.label ?? ''),
    props?.children ?? h('div', { className: 'v', title: props?.title }, props?.value ?? '—'))
}

export function SaveChip(props) {
  const state = props?.state ?? 'idle'
  const tone = state === 'error' ? 'danger' : state === 'saved' ? 'ok' : state === 'saving' ? 'warn' : 'default'
  const label = { idle: '未修改', saving: '正在保存…', saved: '已自动保存', error: '保存失败' }[state] ?? state
  return h(Chip, { tone, dot: state !== 'idle', title: props?.title }, label)
}
