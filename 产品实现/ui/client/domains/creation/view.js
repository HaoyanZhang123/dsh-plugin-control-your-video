/**
 * Creation domain view: a read-only projection of brief, directions, baseline, early units, preview
 * freshness and what the making agent actually saw and heard.
 *
 * This component is PURE on purpose: it takes a projection (or an error) and renders it, so the
 * same code can be mounted in the workbench shell and rendered in an evidence harness without a
 * second implementation. It reads `creation.projection`, the summary C13 publishes into the
 * project's event stream — it never invents data and never writes anything.
 *
 * @module ui/client/domains/creation/view
 */

/** Chip tone per brief bucket, matching the design system's existing tones. */
const BUCKET_TONE = Object.freeze({ user: 'accent', source: 'warn', ai: 'ok', unknown: 'danger' })

/** Human label per brief bucket. */
const BUCKET_LABEL = Object.freeze({ user: '用户要求', source: '来源主张', ai: 'AI 推断', unknown: '未知' })

/** Plan item state label. */
const ITEM_STATE_LABEL = Object.freeze({ undecided: '未定', decided: '已定', 'ai-allowed': 'AI 可自主' })

/**
 * One section frame that keeps the card rhythm of the rest of the workbench.
 * @param {{title: string, note?: string, children?: any}} props
 */
function DomainSection(props) {
  return h('section', { className: 'avw-card', style: { marginBottom: '10px' } },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, props.title),
      props.note ? h('span', { className: 'avw-card__note' }, props.note) : null,
      h('span', { className: 'avw-grow' })),
    h('div', { className: 'avw-card__body', style: { display: 'grid', gap: '6px' } }, props.children))
}

/** @param {{text: string, tone?: string}} props */
function DomainChip(props) {
  return h('span', { className: `avw-chip${props.tone ? ` avw-chip--${props.tone}` : ''}` }, props.text)
}

/**
 * One key/value row in the design system's own two-column form (`.avw-kv`), so a long list reads
 * like the rest of the panel instead of a stack of floating boxes.
 * @param {{label: string, tone?: string, children?: any}} props
 */
function DomainKV(props) {
  return h('div', { className: 'avw-kv' },
    h('label', null,
      props.tone ? h(DomainChip, { text: props.label, tone: props.tone }) : props.label),
    h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, props.children))
}

/** @param {{entries: any[]}} props */
function BriefBucket(props) {
  const entry = props.entries ?? []
  return h('div', { className: 'avw-brief' },
    h('div', { className: 'avw-brief-label' },
      h('b', null, entry.label),
      h(DomainChip, { text: String(entry.count ?? 0), tone: BUCKET_TONE[entry.key] })),
    entry.items.length === 0
      ? h('span', { className: 'avw-hint' }, '还没有这一类的条目')
      : entry.items.map((item, index) => h('span', { key: `${entry.key}-${index}`, className: 'avw-hint' }, `· ${item.text}`)))
}

/**
 * The whole domain view.
 *
 * @param {object} props
 * @param {any} [props.projection] the newest `creation.projection` payload
 * @param {string} [props.error] why the projection could not be read
 * @param {boolean} [props.loading]
 * @param {string} [props.notice] a standing note, e.g. "只读投影：数据来自项目事件流"
 */
export function CreationDomainView(props) {
  const projection = props.projection ?? null
  const header = h('div', { className: 'avw-card__head' },
    h('span', { className: 'avw-card__title' }, '创建领域视图'),
    h(DomainChip, { text: '只读', tone: 'accent' }),
    h('span', { className: 'avw-grow' }),
    h('span', { className: 'avw-card__note' }, projection === null ? '等待投影' : `来源：项目事件 · ${projection.generatedAt}`))

  if (props.loading === true) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' }, h('span', { className: 'avw-hint' }, '正在读取项目事件…')))
  }
  if (typeof props.error === 'string' && props.error.length > 0) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h('span', { className: 'avw-chip avw-chip--warn' }, '需要处理'),
        h('span', { className: 'avw-hint' }, props.error)))
  }
  if (projection === null) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h('span', { className: 'avw-hint' }, '这个项目还没有编排投影。投影由创作编排在事实变化后发布，宿主不会凭空造一份。'),
        props.notice ? h('span', { className: 'avw-hint' }, props.notice) : null))
  }

  const brief = projection.brief ?? { counts: {} }
  const buckets = ['user', 'source', 'ai', 'unknown'].map((key) => ({
    key,
    label: BUCKET_LABEL[key],
    count: brief.counts?.[key] ?? 0,
    items: brief[key] ?? [],
  }))
  const baseline = projection.baseline ?? { items: [], blockers: [] }
  const units = projection.units ?? { list: [], complete: 0, incomplete: 0 }
  const preview = projection.preview ?? null
  const vista = projection.vista ?? { executed: 0, total: 0 }
  const ai = projection.ai ?? { saw: false, heard: 'not-available' }

  return h('div', { className: 'avw-creation-domain' },
    h(DomainSection, { title: '可编辑简报（只读投影）', note: `${brief.counts?.user ?? 0} 条用户要求` },
      buckets.map((bucket) => h(BriefBucket, { key: bucket.key, entries: bucket }))),

    h(DomainSection, { title: '方向', note: `${(projection.directions ?? []).length} 个候选` },
      (projection.directions ?? []).length === 0
        ? h('span', { className: 'avw-hint' }, '还没有实质方向')
        : projection.directions.map((direction, index) => h(DomainKV, { key: `dir-${index}`, label: direction.state, tone: 'accent' },
          h('span', null, direction.title),
          direction.combination === null ? null : h(DomainChip, { text: `组合 ${direction.combination} 项新元素`, tone: 'accent' })))),

    h(DomainSection, { title: '方案基线', note: `第 ${baseline.version ?? 0} 版` },
      h(DomainKV, { label: '生产门', tone: baseline.ok ? 'ok' : 'warn' },
        h('span', null, baseline.ok ? '可以开始制作' : '关键项未定，不能开始完整制作'),
        h('span', { className: 'avw-hint' }, `${baseline.blockers?.length ?? 0} 个阻塞理由`)),
      (baseline.items ?? []).map((item, index) => h(DomainKV, { key: `item-${index}`, label: item.kind },
        h('span', null, item.title),
        h(DomainChip, {
          text: ITEM_STATE_LABEL[item.state] ?? item.state,
          tone: item.state === 'decided' ? 'ok' : 'warn',
        }))),
      (baseline.blockers ?? []).map((blocker, index) => h('span', { key: `blocker-${index}`, className: 'avw-hint' }, `· ${blocker.kind ?? '项目'}：${blocker.reason}`))),

    h(DomainSection, { title: '早期单元', note: `完成 ${units.complete ?? 0} · 未完成 ${units.incomplete ?? 0}` },
      (units.list ?? []).length === 0
        ? h('span', { className: 'avw-hint' }, '还没有早期生产单元')
        : units.list.map((unit) => h(DomainKV, { key: unit.unitId, label: unit.unitId },
          h(DomainChip, {
            text: unit.status === 'complete' ? '完整' : '未完成',
            tone: unit.status === 'complete' ? 'ok' : 'danger',
          }),
          unit.unobserved?.length > 0 ? h(DomainChip, { text: `未看 ${unit.unobserved.length} 项`, tone: 'warn' }) : null,
          unit.knownIssues?.length > 0 ? h('span', { className: 'avw-hint' }, `已知问题：${unit.knownIssues.join('；')}`) : null))),

    h(DomainSection, { title: '预览与画面来源', note: preview === null ? '还没有渲染记录' : preview.file },
      preview === null
        ? h('span', { className: 'avw-hint' }, '还没有渲染过预览，界面不会显示“已生效”')
        : h('div', null,
          h(DomainKV, { label: '画面', tone: preview.showing === 'current-plan' ? 'ok' : 'warn' },
            h('span', null, preview.showing === 'current-plan' ? '当前计划' : '上一版计划'),
            h('span', { className: 'avw-mono' }, `预览计划 ${preview.planVersion}`)),
          h('span', { className: 'avw-hint' },
            preview.showing === 'current-plan'
              ? '画面与当前计划一致'
              : '画面是上一版计划；改过的范围在渲染前只能是待更新，不能冒充已生效'))),

    h(DomainSection, { title: 'AI 实际看／听' },
      h(DomainKV, { label: '画面', tone: ai.saw ? 'ok' : 'warn' },
        h('span', null, ai.saw ? '看过' : '未看'),
        h('span', { className: 'avw-hint' }, ai.saw ? '有真实图像输入被观察，范围见证据' : '没有真实图像输入，界面不冒充已看')),
      h(DomainKV, { label: '声音', tone: 'warn' },
        h('span', null, ai.heard === 'not-available' ? '未听' : ai.heard),
        h('span', { className: 'avw-hint' }, ai.note ?? '宿主没有听辨通道')),
      h('span', { className: 'avw-hint' }, `VISTA 机制执行 ${vista.executed}/${vista.total}；机制执行不等于增益已证实`)),

    props.notice ? h('span', { className: 'avw-hint' }, props.notice) : null)
}
