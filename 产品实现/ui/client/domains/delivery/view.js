/**
 * Delivery domain view: the read-only projection of delivery, project packages, effects and closure.
 *
 * This component is PURE on purpose: it takes a `delivery.projection` payload (or an error) and
 * renders it, so the same code can be mounted by the shell and rendered with real project data in
 * evidence. It never invents a record, never writes anything, and never draws an enabled button for
 * a capability that is not wired — export, scope confirmation and cleanup are shown as what they
 * are (facts and gaps), not as clickable promises.
 *
 * @module ui/client/domains/delivery/view
 */

/** Delivery state label and tone. */
const DELIVERY_STATE = Object.freeze({
  planned: { label: '已计划，尚未导出', tone: 'warn' },
  running: { label: '正在导出', tone: 'warn' },
  complete: { label: '全部可用规格已导出并检查', tone: 'ok' },
  partial: { label: '部分成功', tone: 'danger' },
  failed: { label: '没有成功的规格', tone: 'danger' },
})

/** Item state label and tone. */
const ITEM_STATE = Object.freeze({
  planned: { label: '未导出', tone: 'default' },
  exported: { label: '已导出并检查', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  'not-implemented': { label: '本卡不可用', tone: 'warn' },
  skipped: { label: '跳过', tone: 'default' },
})

/** Closure step label. */
const CLOSURE_STEP_LABEL = Object.freeze({
  finalized: '1 用户验收定稿',
  delivered: '2 成片与物料导出并检查',
  'effects-decided': '3 效果处理',
  'final-project': '4 最终可编辑工程检查',
  'scope-shown': '5 展示清理范围',
  'scope-confirmed': '6 用户确认范围',
  cleaned: '7 执行清理',
})

/** Closure step status label and tone. */
const STEP_TONE = Object.freeze({
  passed: { label: '已通过', tone: 'ok' },
  blocked: { label: '受阻', tone: 'danger' },
  'waiting-user': { label: '等待你决定', tone: 'warn' },
  pending: { label: '未开始', tone: 'default' },
})

/** Effect state label and tone. */
const EFFECT_STATE = Object.freeze({
  candidate: { label: '候选（未复现）', tone: 'warn' },
  reproducing: { label: '正在空项目复现', tone: 'warn' },
  reproduced: { label: '已复现', tone: 'ok' },
  adopted: { label: '正式收录', tone: 'ok' },
  'reproduce-failed': { label: '复现未通过', tone: 'danger' },
  withdrawn: { label: '已下架', tone: 'default' },
})

/** One card section in the workbench rhythm. */
function Section(props) {
  return h('section', { className: 'avw-card', style: { marginBottom: '10px' } },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, props.title),
      props.note ? h('span', { className: 'avw-card__note' }, props.note) : null,
      h('span', { className: 'avw-grow' })),
    h('div', { className: 'avw-card__body', style: { display: 'grid', gap: '6px' } }, props.children))
}

/** A chip matching the design system. */
function DomainChip(props) {
  return h('span', { className: `avw-chip${props.tone ? ` avw-chip--${props.tone}` : ''}` }, props.text)
}

/** A key/value row. */
function DomainKV(props) {
  return h('div', { className: 'avw-kv' },
    h('label', null, props.label),
    h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, props.children))
}

/** A short honest sentence, used instead of an unimplemented control. */
function Hint(props) {
  return h('span', { className: 'avw-hint' }, props.text)
}

/** @param {unknown} bytes @returns {string} */
function formatBytesLocal(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** @param {unknown} size @returns {string} */
function sizeText(item) {
  if (item.width === null || item.width === undefined || item.height === null || item.height === undefined) return '规格未记录'
  const duration = typeof item.durationSeconds === 'number' ? ` · ${item.durationSeconds.toFixed(3)}s` : ''
  return `${item.width}×${item.height}${duration}`
}

/** @param {any} item */
function ItemRow(item) {
  const state = ITEM_STATE[item.state] ?? { label: String(item.state), tone: 'default' }
  return h(DomainKV, { key: `${item.specId}-${item.kind}`, label: `${item.kind}` },
    h('span', null, item.label ?? item.specId),
    h(DomainChip, { text: state.label, tone: state.tone }),
    h('span', { className: 'avw-hint' }, sizeText(item)),
    item.fileName ? h('span', { className: 'avw-mono' }, item.fileName) : null,
    item.bytes ? h('span', { className: 'avw-hint' }, formatBytesLocal(item.bytes)) : null,
    item.external === true ? h(DomainChip, { text: '项目目录之外', tone: 'accent' }) : null,
    item.checksOk === true ? h(DomainChip, { text: '检查通过', tone: 'ok' }) : null,
    item.failure ? h('span', { className: 'avw-hint' }, `${item.failure.code}：${item.failure.message}`) : null,
    item.adaptation
      ? h('span', { className: 'avw-hint' },
        `AdaptOperation ${item.adaptation.from.width}×${item.adaptation.from.height} → ` +
        `${item.adaptation.to.width}×${item.adaptation.to.height} · 重排对象 ${item.adaptation.moves ?? 0} 个 · ` +
        `字号 ${item.adaptation.resizes ?? 0} 个 · 字幕重排 ${item.adaptation.rewraps ?? 0} 个 · ` +
        `${item.adaptation.notAStretch === true ? '对象级重排（非拉伸）' : '未证明非拉伸'}`)
      : null,
    (item.notes ?? []).length > 0 ? h(Hint, { text: item.notes.join('；') }) : null)
}

/** @param {any} props */
function FinalSection(props) {
  const finalVersion = props.finalVersion
  const deliveries = props.deliveries ?? []
  const rows = deliveries.length === 0
    ? h(Hint, { text: '还没有交付记录。定稿之后才允许导出；这一页不会凭空显示文件。' })
    : deliveries.map((delivery) => {
      const state = DELIVERY_STATE[delivery.state] ?? { label: String(delivery.state), tone: 'default' }
      return h('div', { key: delivery.deliveryId, style: { marginBottom: '10px' } },
        h(DomainKV, { label: '交付' },
          h('span', { className: 'avw-mono' }, delivery.deliveryId),
          h(DomainChip, { text: state.label, tone: state.tone }),
          h('span', { className: 'avw-hint' }, `同名处理 ${delivery.policy === 'refuse' ? '拒绝' : '另存新名字'}`),
          delivery.counts ? h('span', { className: 'avw-hint' },
            `共 ${delivery.counts.total ?? 0} 项：成功 ${delivery.counts.exported ?? 0}、失败 ${delivery.counts.failed ?? 0}、` +
            `不可用 ${delivery.counts.notImplemented ?? 0}`) : null),
        (delivery.items ?? []).map((item) => ItemRow(item)))
    })
  return h(Section, {
    title: '定稿与成片交付',
    note: finalVersion === null ? '尚未定稿' : `定稿 ${finalVersion.versionId}`,
  },
  h(DomainKV, { label: '定稿' },
    finalVersion === null
      ? h(Hint, { text: '还没有用户验收的定稿版本：导出与清理都不能开始。' })
      : h('span', null, `${finalVersion.label ?? '定稿'} · ${String(finalVersion.confirmationRef ?? '')}`)),
  h(Hint, { text: '导出成功不等于发布：这里没有上传、发布或账号动作。' }),
  rows)
}

/** @param {any} props */
function PackageSection(props) {
  const packages = props.packages ?? []
  const rows = packages.length === 0
    ? h(Hint, { text: '还没有项目包记录。可编辑项目包与成片分开交付。' })
    : packages.map((record) => h(DomainKV, { key: `${record.packageId}-${record.direction}`, label: record.direction === 'import' ? '导入' : '导出' },
      h('span', { className: 'avw-mono' }, record.packageId),
      h(DomainChip, { text: record.state ?? '未知', tone: record.state === 'imported' || record.state === 'exported' ? 'ok' : 'warn' }),
      h('span', { className: 'avw-hint' }, `格式 v${String(record.formatVersion ?? '—')} · ${String(record.files ?? 0)} 个文件`),
      record.folder ? h('span', { className: 'avw-mono' }, record.folder) : null,
      record.bytes ? h('span', { className: 'avw-hint' }, formatBytesLocal(record.bytes)) : null,
      record.at ? h('span', { className: 'avw-hint' }, record.at) : null))
  return h(Section, { title: '可编辑项目包', note: `${packages.length} 条` },
    rows,
    h(Hint, { text: '导入检查完整性、哈希、同名与环境差异；包内源码从不自动执行，也不覆盖同名项目。' }))
}

/** @param {any} props */
function EffectSection(props) {
  const effects = props.effects
  if (effects === null) {
    return h(Section, { title: '正式效果库', note: '未提供效果库' },
      h(Hint, { text: '这个项目没有接入效果库根目录：不显示任何效果，也不画假的收录按钮。' }))
  }
  const list = effects.effects ?? []
  const rows = list.length === 0
    ? h(Hint, { text: '还没有效果。候选要先在空项目复现通过，才能成为正式收录的效果。' })
    : list.map((effect) => {
      const state = EFFECT_STATE[effect.state] ?? { label: String(effect.state), tone: 'default' }
      return h(DomainKV, { key: effect.effectId, label: effect.kind === 'sound' ? '声音效果' : '视觉效果' },
        h('span', null, effect.name),
        h(DomainChip, { text: state.label, tone: state.tone }),
        h('span', { className: 'avw-hint' }, `版本 ${effect.version} · 被 ${effect.references ?? 0} 个项目引用`),
        effect.reproducedAt ? h('span', { className: 'avw-hint' }, `复现于 ${effect.reproducedAt}`) : null)
    })
  const honest = effects.honest ?? {}
  return h(Section, { title: '正式效果库', note: `${list.length} 个` },
    rows,
    h(Hint, { text: (effects.references ?? []).length > 0
      ? `跨项目引用：${(effects.references ?? []).map((entry) => `${entry.effectId}@${entry.version}`).join('；')}`
      : '这个项目还没有引用正式效果。' }),
    h(Hint, { text: honest.note ?? '效果以声明式源文件复现，不执行任意源码；声音效果需要你实际听。' }))
}

/** @param {any} props */
function ClosureSection(props) {
  const closure = props.closure
  if (closure === null) {
    return h(Section, { title: '结项', note: '未开始' },
      h(Hint, { text: '还没有结项记录。顺序固定：定稿 → 导出检查 → 效果处理 → 最终工程检查 → 展示范围 → 你确认 → 清理。' }))
  }
  const steps = (closure.steps ?? []).map((step) => {
    const status = STEP_TONE[step.status] ?? { label: String(step.status), tone: 'default' }
    return h(DomainKV, { key: step.id, label: CLOSURE_STEP_LABEL[step.id] ?? step.id },
      h(DomainChip, { text: status.label, tone: status.tone }),
      h(Hint, { text: step.detail ?? '' }))
  })
  const scope = closure.scope
  const scopeLines = scope === null
    ? h(Hint, { text: '还没有清理范围。生成范围需要前四步全部通过。' })
    : h(React.Fragment, null,
      h(DomainKV, { label: '清理范围' },
        h('span', null, `${scope.remove} 项、约 ${formatBytesLocal(scope.totalBytes)}`),
        h(DomainChip, { text: scope.digest ? `指纹 ${String(scope.digest).slice(0, 10)}…` : '无指纹', tone: 'accent' })),
      (scope.entries ?? []).length === 0
        ? h(Hint, { text: '这个范围里没有可删除条目。' })
        : (scope.entries ?? []).map((entry, index) => h('span', { key: `${entry.path}-${index}`, className: 'avw-hint' },
          `${entry.kind}：${entry.path}（${formatBytesLocal(entry.bytes)}）`)),
      (scope.sharedReferences ?? []).length > 0
        ? h(Hint, { text: `共享引用保留：${(scope.sharedReferences ?? []).map((entry) => `${entry.effectId}@${entry.version}`).join('；')}` })
        : null)
  return h(Section, { title: '结项与清理', note: closure.status === 'cleaned' ? '已清理' : closure.status === 'confirmed' ? '范围已确认' : '进行中' },
    steps,
    scopeLines,
    closure.confirmation
      ? h(DomainKV, { label: '你的确认' },
        h('span', null, closure.confirmation.humanResponse ?? ''),
        h('span', { className: 'avw-hint' }, closure.confirmation.at ?? ''))
      : h(Hint, { text: '还没有你的确认：未回复就不删除任何历史。' }),
    closure.cleanup
      ? h(DomainKV, { label: '已清理' },
        h('span', null, `删除 ${closure.cleanup.deleted} 项、释放 ${formatBytesLocal(closure.cleanup.bytesFreed)}`),
        closure.cleanup.failures > 0 ? h(DomainChip, { text: `${closure.cleanup.failures} 项失败`, tone: 'danger' }) : null,
        h(Hint, { text: '已删除历史不提供恢复入口，也不承诺找回。' }))
      : null,
    h(Hint, { text: '导出失败或最终工程缺件时不会生成可执行的清理范围；归档、回收区与永久删除是另外的确认步骤。' }))
}

/**
 * The whole delivery domain view.
 *
 * @param {object} props
 * @param {any} [props.projection] the newest `delivery.projection` payload
 * @param {string} [props.error] why the projection could not be read
 * @param {boolean} [props.loading]
 * @param {string} [props.notice]
 */
export function DeliveryDomainView(props) {
  const projection = props.projection ?? null
  const header = h('div', { className: 'avw-card__head' },
    h('span', { className: 'avw-card__title' }, '交付、项目包、效果与结项（只读投影)'),
    h(DomainChip, { text: '只读', tone: 'accent' }),
    h('span', { className: 'avw-grow' }),
    h('span', { className: 'avw-card__note' },
      projection === null ? '等待投影' : `来源：项目事件 · ${projection.generatedAt}`))

  if (props.loading === true) {
    return h('div', { className: 'avw-card', id: 'avw-delivery-domain' }, header,
      h('div', { className: 'avw-card__body' }, h(Hint, { text: '正在读取项目事件…' })))
  }
  if (typeof props.error === 'string' && props.error.length > 0) {
    return h('div', { className: 'avw-card', id: 'avw-delivery-domain' }, header,
      h('div', { className: 'avw-card__body' },
        h('span', { className: 'avw-chip avw-chip--warn' }, '需要处理'),
        h(Hint, { text: props.error })))
  }
  if (projection === null) {
    return h('div', { className: 'avw-card', id: 'avw-delivery-domain' }, header,
      h('div', { className: 'avw-card__body' },
        h(Hint, { text: '这个项目还没有交付投影。投影由交付模块在事实变化后发布；界面不会凭空造一份。' }),
        props.notice ? h(Hint, { text: props.notice }) : null))
  }

  const honest = projection.honest ?? {}
  return h('div', { className: 'avw-card', id: 'avw-delivery-domain' },
    header,
    h('div', { className: 'avw-card__body', style: { display: 'grid', gap: '10px' } },
      h(FinalSection, {
        finalVersion: projection.finalVersion ?? null,
        deliveries: projection.deliveries ?? [],
      }),
      h(PackageSection, { packages: projection.packages ?? [] }),
      h(EffectSection, { effects: projection.effects ?? null }),
      h(ClosureSection, { closure: projection.closure ?? null }),
      h('div', { className: 'avw-gap' },
        h('b', null, '仍未接入：可点操作与真实交互'),
        h('div', null, '这一页是只读投影：导出按钮、范围确认与清理执行都要接上真实交互后才出现；这里不画假按钮。'),
        h(Hint, { text: honest.note ?? '' }),
        h(Hint, { text: 'AI 看／听：未看、未听；程序检查不等于用户验收。' }))))
}
