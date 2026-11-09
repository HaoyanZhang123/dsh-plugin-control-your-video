/**
 * Effects page: the pure visual/sound effect library.
 *
 * The library itself belongs to C15 (project packages, effects, delivery). Until it lands there is
 * no effect store to read, so this page states that plainly instead of listing sample effects.
 *
 * @module ui/client/views/effects
 */

export function EffectsView() {
  const state = useStoreState()
  const effects = state.effects
  React.useEffect(() => { if (effects === null) Actions.loadEffects() }, [])
  const list = effects?.effects ?? []
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h('div', { className: 'avw-scroll' },
      h('div', { className: 'avw-page' },
        h('h2', null, '效果'),
        h('p', null, '只收录视觉与声音效果本身，不把方法、案例或提示词当作独立资产。'),
        list.length === 0
          ? h('div', { className: 'avw-card' },
            h('div', { className: 'avw-card__body' },
              h(Empty, {
                icon: 'effects',
                title: '还没有已收录的效果',
                message: '正式收录需要从空项目复现并检查结果一致；效果库、复现门禁与结项由 C15 接入。',
              })))
          : h('div', { className: 'avw-tools' }, list.map((effect) => h('div', { key: effect.id ?? effect.name, className: 'avw-tool' },
            h('b', null, effect.name ?? '未命名效果'),
            h('p', null, effect.summary ?? ''),
            h('span', { className: 'side' }, h(Chip, null, effect.version ?? '未标版本'))))),
        h('div', { style: { marginTop: '12px' } },
          h(GapCard, { gap: INTEGRATION_GAPS.delivery })),
        h('p', { className: 'avw-hint' }, '正式效果文件、源码、必要输入和版本锁定会随效果包一起保留；源码本身不等于任何环境都能复现。')),
      h(Toast, { toast: state.toast })))
}
