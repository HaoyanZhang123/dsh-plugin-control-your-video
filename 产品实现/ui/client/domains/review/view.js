/**
 * Review domain view: a read-only projection of candidates, comparisons, annotations, partial
 * confirmations, direct-edit sessions, AI requests and creative history.
 *
 * This component is PURE on purpose: it takes a projection (or an error) and renders it, so the same
 * code can be mounted by the shell and rendered with real project data in evidence. It reads
 * `editing.projection`, the summary C14 publishes into the project's event stream — it never invents
 * data, never writes anything and never draws an enabled button for a capability that is not wired.
 *
 * The body is built as named sections instead of one deeply nested call, so a missing parenthesis
 * cannot silently turn later sections into discarded comma operands.
 *
 * @module ui/client/domains/review/view
 */

/** Candidate status label and tone. */
const CANDIDATE_STATUS = Object.freeze({
  open: { label: '未决定', tone: 'warn' },
  'needs-recheck': { label: '基础版本已变，需重核', tone: 'danger' },
  accepted: { label: '已接受为当前', tone: 'ok' },
  rejected: { label: '已否定', tone: 'default' },
  superseded: { label: '已取代', tone: 'default' },
})

/** Confirmation state label and tone. */
const CONFIRM_STATE = Object.freeze({
  'partially-confirmed': { label: '部分确认', tone: 'warn' },
  confirmed: { label: '已确认', tone: 'ok' },
  'changed-after-confirmation': { label: '确认后有改动，需重核', tone: 'danger' },
  'ai-allowed': { label: 'AI 自主（未经你审阅）', tone: 'warn' },
})

/** Session status label. */
const SESSION_STATUS = Object.freeze({
  open: '修改中',
  'candidate-formed': '已形成候选',
  accepted: '已接受',
  abandoned: '已放弃',
})

/** Request status label. */
const REQUEST_STATUS = Object.freeze({
  'needs-user': '待用户确认方向',
  planned: '已声明，待派发',
  dispatched: '已交给原制作子 Agent',
  returned: '已返回候选',
  failed: '失败（原版保留）',
  cancelled: '已取消',
})

/** One section frame in the workbench card rhythm. */
function ReviewSection(props) {
  return h('section', { className: 'avw-card', style: { marginBottom: '10px' } },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, props.title),
      props.note ? h('span', { className: 'avw-card__note' }, props.note) : null,
      h('span', { className: 'avw-grow' })),
    h('div', { className: 'avw-card__body', style: { display: 'grid', gap: '6px' } }, props.children))
}

/** Small chip matching the design system. */
function ReviewChip(props) {
  return h('span', { className: `avw-chip${props.tone ? ` avw-chip--${props.tone}` : ''}` }, props.text)
}

/** Two-column key/value row. */
function ReviewKV(props) {
  return h('div', { className: 'avw-kv' },
    h('label', null, props.label),
    h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, props.children))
}

/** A short honest sentence, used instead of an unimplemented control. */
function Hint(props) {
  return h('span', { className: 'avw-hint' }, props.text)
}

/** @param {any} range */
function rangeText(range) {
  if (range === null || range === undefined) return '—'
  return `[${range.startFrame}, ${range.endFrameExclusive})`
}

/** @param {any[]} frames */
function changedFramesText(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return '—'
  return frames
    .map((entry) => `[${entry.startFrame}, ${entry.endFrameExclusive}) ${entry.reason ?? ''}`.trim())
    .join('；')
}

/** @param {any} props */
function CurrentSection(props) {
  const current = props.current
  const production = props.production
  const summary = props.summary
  return h(ReviewSection, { title: '当前状态', note: `候选 ${summary.liveCandidates ?? 0} 个未结束` },
    h(ReviewKV, { label: '当前版本' },
      h('span', null, current === null ? '还没有当前版本' : `${current.label} · ${current.versionId}`),
      current === null || current.planVersion === null
        ? null
        : h('span', { className: 'avw-mono' }, `计划 ${current.planVersion}`)),
    h(ReviewKV, { label: '制作状态' },
      h(ReviewChip, {
        text: production.editable === true ? '可进行实际修改' : '先暂停／先核对',
        tone: production.editable === true ? 'ok' : 'warn',
      }),
      h(Hint, { text: production.reason ?? (production.execution ? `执行 ${production.execution}` : '') })),
    h(Hint, { text: '直接修改与 AI 修改共用同一写入锁、候选与恢复机制；修改形成候选，不覆盖当前版。' }))
}

/** @param {any} props */
function CandidatesSection(props) {
  const candidates = props.candidates
  const rows = candidates.length === 0
    ? h(Hint, { text: '还没有候选。直接修改会形成候选；AI 复杂修改由原制作子 Agent 返回真实候选。' })
    : candidates.map((candidate) => {
      const status = CANDIDATE_STATUS[candidate.status] ?? { label: candidate.status, tone: 'default' }
      return h(ReviewKV, { key: candidate.candidateId, label: `候选 ${candidate.createdBy}` },
        h('span', null, candidate.target ?? '—'),
        h(ReviewChip, { text: status.label, tone: status.tone }),
        h('span', { className: 'avw-hint' },
          `基础 ${candidate.baseVersionId} · 范围 ${candidate.scope ?? '—'} · 保留 ${candidate.preservedItems?.length ?? 0} 项`),
        candidate.previewAvailable === false
          ? h(ReviewChip, { text: '缺真实预览', tone: 'warn' })
          : h(ReviewChip, { text: '有真实预览', tone: 'ok' }),
        candidate.recheckRequired === true
          ? h('span', { className: 'avw-hint' }, `需要重核：${candidate.recheckReason ?? '基础版本已变化'}`)
          : null)
    })
  return h(ReviewSection, { title: '候选与新修改', note: `${candidates.length} 个` },
    rows,
    h(Hint, { text: '接受候选 ≠ 整片验收 ≠ 效果沉淀；部分采用会形成新候选并重新检查依赖。' }))
}

/** @param {any} props */
function ComparisonsSection(props) {
  const comparisons = props.comparisons
  const rows = comparisons.length === 0
    ? h(Hint, { text: '还没有对照记录。' })
    : comparisons.map((comparison) => h(ReviewKV, { key: comparison.comparisonId, label: '对照' },
      h(ReviewChip, {
        text: comparison.realComparison ? '真实媒体对照' : '只有计划差异',
        tone: comparison.realComparison ? 'ok' : 'warn',
      }),
      h('span', { className: 'avw-hint' },
        `方式 ${Array.isArray(comparison.modes) ? comparison.modes.join(' / ') : '—'} · 变化对象 ${comparison.changedObjectIds?.length ?? 0} 个`),
      h(Hint, { text: changedFramesText(comparison.changedFrames) }),
      comparison.changedFieldsByObject
        ? h(Hint, {
          text: Object.entries(comparison.changedFieldsByObject)
            .map(([objectId, fields]) => `${objectId}: ${fields.join('、')}`)
            .join('；'),
        })
        : null,
      comparison.missingPreviewReason ? h(Hint, { text: comparison.missingPreviewReason }) : null,
      comparison.wholeFilmRequired === true
        ? h(ReviewChip, { text: '需要看整片影响', tone: 'warn' })
        : null))
  return h(ReviewSection, { title: '新旧对照', note: `${comparisons.length} 条` }, rows)
}

/** @param {any} props */
function AnnotationsSection(props) {
  const annotations = props.annotations
  const rows = annotations.length === 0
    ? h(Hint, { text: '还没有批注。批注会绑定对象、方面、范围与版本；旧引用保留当时对象快照。' })
    : annotations.map((annotation) => h(ReviewKV, { key: annotation.annotationId, label: annotation.aspect },
      h('span', null, annotation.body ?? ''),
      h(ReviewChip, {
        text: annotation.objectId === 'movie' ? '整片' : annotation.objectId,
        tone: 'accent',
      }),
      annotation.range === null ? null : h('span', { className: 'avw-mono' }, rangeText(annotation.range)),
      h('span', { className: 'avw-hint' }, `版本 ${annotation.versionId} · ${annotation.status}`),
      annotation.planVerified === false ? h(ReviewChip, { text: '版本计划未核', tone: 'warn' }) : null,
      annotation.flattened === true ? h(ReviewChip, { text: '压平视频：只到片段／区域', tone: 'warn' }) : null))
  return h(ReviewSection, { title: '对象批注', note: `${annotations.length} 条` }, rows)
}

/** @param {any} props */
function ConfirmationsSection(props) {
  const confirmations = props.confirmations
  const rows = confirmations.length === 0
    ? h(Hint, { text: '还没有局部确认记录。' })
    : confirmations.map((confirmation) => {
      const state = CONFIRM_STATE[confirmation.state] ?? { label: confirmation.state, tone: 'default' }
      return h(ReviewKV, { key: confirmation.confirmationId, label: confirmation.objectId },
        h('span', null, confirmation.aspect),
        h(ReviewChip, { text: state.label, tone: state.tone }),
        h('span', { className: 'avw-hint' }, `范围 ${confirmation.scope} · 版本 ${confirmation.versionId}`),
        confirmation.humanResponse ? h(Hint, { text: `你的话：${confirmation.humanResponse}` }) : null,
        confirmation.wholeFilm === true ? h(ReviewChip, { text: '整片范围', tone: 'danger' }) : null)
    })
  return h(ReviewSection, { title: '局部确认', note: '不等于整片验收' }, rows)
}

/** @param {any} props */
function SessionsSection(props) {
  const sessions = props.sessions
  const requests = props.requests
  const sessionRows = sessions.map((session) => h(ReviewKV, { key: session.sessionId, label: '直接修改' },
    h('span', null, session.target ?? '—'),
    h(ReviewChip, {
      text: SESSION_STATUS[session.status] ?? session.status,
      tone: session.status === 'candidate-formed' ? 'ok' : session.status === 'open' ? 'warn' : 'default',
    }),
    h('span', { className: 'avw-hint' },
      `基础 ${session.baseVersionId} · 步骤 ${session.steps}${session.steps > 1 ? ` · 可撤销 ${session.canUndo}｜可重做 ${session.canRedo}` : ''}`),
    h('span', { className: 'avw-hint' },
      `预览：${session.previewState === 'fresh' ? '当前' : session.previewState === 'missing' ? '尚无真实预览' : '已过期，需重渲'}`)))
  const requestRows = requests.map((request) => h(ReviewKV, { key: request.requestId, label: 'AI 修改' },
    h('span', null, request.target ?? '—'),
    h(ReviewChip, {
      text: REQUEST_STATUS[request.status] ?? request.status,
      tone: request.status === 'returned'
        ? 'ok'
        : request.status === 'needs-user'
          ? 'warn'
          : request.status === 'failed'
            ? 'danger'
            : 'default',
    }),
    h('span', { className: 'avw-hint' },
      `基础 ${request.baseVersionId}${request.producerSessionId ? ` · 原制作子 Agent ${request.producerSessionId}` : ''}`),
    request.pausedProduction?.changed === true
      ? h(Hint, { text: '派发前已暂停制作' })
      : null,
    request.result?.knownIssues?.length > 0
      ? h(Hint, { text: `已知问题：${request.result.knownIssues.join('；')}` })
      : null,
    request.failure ? h(Hint, { text: `失败：${request.failure.reason} · 原版保留` }) : null))
  const body = sessions.length === 0 && requests.length === 0
    ? h(Hint, { text: '还没有修改会话。' })
    : h(React.Fragment, null, sessionRows, requestRows)
  return h(ReviewSection, { title: '修改过程', note: `${sessions.length} 个直接会话 · ${requests.length} 个 AI 请求` }, body)
}

/** @param {any} props */
function HistorySection(props) {
  const history = props.history
  const entries = history.entries ?? []
  const rows = entries.length === 0
    ? h(Hint, { text: '没有可显示的创作期历史。' })
    : entries.map((entry) => h(ReviewKV, { key: `${entry.kind}-${entry.versionId}`, label: entry.kind },
      h('span', null, entry.label ?? entry.status ?? ''),
      h(ReviewChip, { text: entry.class, tone: entry.active ? 'ok' : 'default' }),
      h('span', { className: 'avw-hint' }, `${entry.createdBy ?? ''} · ${entry.createdAt ?? ''}`),
      entry.revertEligible === true
        ? h(ReviewChip, { text: '可回退（成为当前版本）', tone: 'accent' })
        : h('span', { className: 'avw-hint' }, entry.revertReason ?? '只读查看')))
  return h(ReviewSection, { title: '创作期历史与回退', note: '只读' },
    rows,
    h(Hint, { text: '历史只读；回退成为当前版本，旧当前版保留。局部回退只形成候选。' }))
}

/** @param {any} props */
function HonestGap(props) {
  return h('div', { className: 'avw-gap' },
    h('b', null, '仍未接入：可点操作与真实交互'),
    h('div', null, '领域视图已画入项目页“批注”面板（只读）。接受、退回、重新渲染等可点操作尚未接通交互，这里不画假按钮。'),
    h(Hint, { text: props.honest.note ?? '' }),
    h(Hint, { text: 'AI 看／听：未看、未听；程序检查不等于用户验收。' }))
}

/**
 * The whole review domain view.
 *
 * @param {object} props
 * @param {any} [props.projection] the newest `editing.projection` payload
 * @param {string} [props.error] why the projection could not be read
 * @param {boolean} [props.loading]
 * @param {string} [props.notice]
 */
export function ReviewDomainView(props) {
  const projection = props.projection ?? null
  const header = h('div', { className: 'avw-card__head' },
    h('span', { className: 'avw-card__title' }, '审阅、修改与回退（只读投影）'),
    h(ReviewChip, { text: '只读', tone: 'accent' }),
    h('span', { className: 'avw-grow' }),
    h('span', { className: 'avw-card__note' },
      projection === null ? '等待投影' : `来源：项目事件 · ${projection.generatedAt}`))

  if (props.loading === true) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' }, h(Hint, { text: '正在读取项目事件…' })))
  }
  if (typeof props.error === 'string' && props.error.length > 0) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h('span', { className: 'avw-chip avw-chip--warn' }, '需要处理'),
        h(Hint, { text: props.error })))
  }
  if (projection === null) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h(Hint, { text: '这个项目还没有审阅投影。投影由编辑模块在事实变化后发布，界面不会凭空造一份。' }),
        props.notice ? h(Hint, { text: props.notice }) : null))
  }

  return h('div', { className: 'avw-review-domain', id: 'avw-review-domain' },
    header,
    h(CurrentSection, {
      current: projection.current ?? null,
      production: projection.production ?? {},
      summary: projection.summary ?? {},
    }),
    h(CandidatesSection, { candidates: projection.candidates ?? [] }),
    h(ComparisonsSection, { comparisons: projection.comparisons ?? [] }),
    h(AnnotationsSection, { annotations: projection.annotations ?? [] }),
    h(ConfirmationsSection, { confirmations: projection.confirmations ?? [] }),
    h(SessionsSection, {
      sessions: projection.sessions ?? [],
      requests: projection.requests ?? [],
    }),
    h(HistorySection, { history: projection.history ?? { entries: [] } }),
    h(HonestGap, { honest: projection.honest ?? {} }))
}
