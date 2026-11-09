/**
 * Project shell: top bar, two work surfaces, the shared right panel and the project dialogs.
 *
 * The assistant is one panel shared by 创作 and 作品, closed by default, opened by the top bar or by
 * "引用到对话", and it never becomes a second sidebar (C11 card §4.5).
 *
 * @module ui/client/views/project
 */

/** Auto-dismiss a toast after it has been shown long enough to read. */
function useToastTimer(toast) {
  React.useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => Actions.dismissToast(), 5200)
    return () => clearTimeout(timer)
  }, [toast?.at])
}

function MaterialProperties(props) {
  const material = props?.material ?? null
  const project = props?.project ?? null
  const uses = (project?.materials?.uses ?? []).filter((use) => use.materialId === material.materialId)
  const [useText, setUseText] = React.useState('')
  if (!material) {
    return h('div', { className: 'avw-prop' },
      h(GapCard, {
        gap: {
          owner: 'C12',
          title: '对象属性',
          message: '原生对象、图层、字幕、转场和音频属性需要真实合成计划；当前项目还没有可编辑对象。',
        },
      }))
  }
  return h('div', null,
    h('div', { className: 'avw-prop' },
      h('h4', null, '材料本体'),
      h(KV, { label: '类型', value: MATERIAL_KIND_LABELS[material.kind] ?? material.kind }),
      h(KV, { label: '文件名', value: material.originalFilename, title: material.originalFilename }),
      h(KV, { label: '大小', value: formatBytes(material.byteSize) }),
      h(KV, { label: '观察', value: MATERIAL_OBSERVATION_LABELS[material.observation] ?? material.observation }),
      h(KV, { label: '权利', value: material.rightsStatus }),
      h(KV, { label: 'SHA-256', value: `${String(material.contentSha256).slice(0, 12)}…`, title: material.contentSha256 }),
      h('p', { className: 'avw-hint' }, '本体与使用实例分开：这里记录的是素材本体；改它会影响所有使用。')),
    h('div', { className: 'avw-prop' },
      h('h4', null, '用途（自然语言）'),
      uses.length === 0
        ? h('p', { className: 'avw-hint' }, '还没有用途说明。直接写你希望它怎么用，例如「只用于开头 3 秒，不要裁切」。')
        : uses.map((use) => h('div', { key: use.useId, style: { marginBottom: '7px' } },
          h('p', { className: 'avw-hint', style: { color: 'var(--avw-text-2)' } }, use.userText),
          h('p', { className: 'avw-hint' }, `记录于 ${formatDateTime(use.recordedAt)} · 权限 ${use.permission?.scope ?? 'project-goals'}`))),
      h('textarea', {
        value: useText,
        placeholder: '用一句话说明用途或限制',
        'aria-label': '材料用途说明',
        onChange: (event) => setUseText(event.target.value),
        style: { width: '100%', minHeight: '58px', marginTop: '6px' },
      }),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '6px' } },
        h(Btn, {
          size: 'sm',
          variant: 'primary',
          disabled: useText.trim().length === 0,
          onClick: () => { Actions.recordUse(material.materialId, useText.trim()); setUseText('') },
        }, '记录用途'))),
    h('div', { className: 'avw-prop' },
      h('h4', null, '来源与关联'),
      h('p', { className: 'avw-hint' }, '材料由 C10 保存与校验；预览画面、时间对象和渲染由 C12 接入。')))
}

/**
 * Mount whatever the review domain registered, in the project page's notes tab.
 *
 * The domain view is a self-contained component (its own store read + event fetch), so mounting it
 * here adds no panel, no slot and no effect — the shell's four entries stay four. When nothing is
 * registered the mount says so instead of drawing an empty review that looks operational.
 */
function ReviewDomainMount() {
  const registry = typeof REVIEW_DOMAIN_REGISTRY === 'object' && REVIEW_DOMAIN_REGISTRY !== null
    ? REVIEW_DOMAIN_REGISTRY
    : { component: null }
  if (typeof registry.component !== 'function') {
    return h('div', { className: 'avw-card', id: 'avw-review-domain', style: { marginTop: '8px' } },
      h('div', { className: 'avw-card__head' }, h('span', { className: 'avw-card__title' }, '审阅、修改与回退')),
      h('div', { className: 'avw-card__body' },
        h('p', { className: 'avw-hint', style: { margin: 0 } }, '审阅领域视图没有注册：这里不显示任何数据，也不画假按钮。')))
  }
  const Registered = registry.component
  return h('div', { id: 'avw-review-domain', style: { marginTop: '8px' } }, h(Registered))
}

function ProjectProperties(props) {
  const project = props?.project ?? null
  if (!project) return null
  const materials = project.materials?.materials ?? []
  const uses = project.materials?.uses ?? []
  return h('div', null,
    h('div', { className: 'avw-prop' },
      h('h4', null, '项目'),
      h(KV, { label: '阶段', value: project.state?.phaseLabel ?? project.project.phase }),
      h(KV, { label: '执行', value: project.state?.executionLabel ?? project.project.execution }),
      h(KV, { label: '修订', value: shortRevision(project.revision), title: project.revision }),
      h(KV, { label: '材料', value: `${materials.length} 个 · ${uses.length} 条用途` }),
      h(KV, { label: '目录', value: project.paths?.projectDir ?? '—', title: project.paths?.projectDir })),
    h('div', { className: 'avw-prop' },
      h('h4', null, '确认与保护'),
      h('p', { className: 'avw-hint' }, '确认绑定对象、方面、范围与版本；候选、对照与回退在“批注”面板的审阅视图里只读查看，接受／回退交互尚未接入。'),
      h('p', { className: 'avw-hint' }, '重要决定可以从“版本”里按时间与对象重新找到。')))
}

function NotesPane(props) {
  const state = useStoreState()
  return h('div', null,
    h('div', { className: 'avw-prop' },
      h('h4', null, '对象批注'),
      state.selection
        ? h('p', { className: 'avw-hint' }, `当前对象：${state.selection.label ?? state.selection.objectId}`)
        : h('p', { className: 'avw-hint' }, '先在结构或材料里选中一个对象。'),
      h('div', { style: { marginTop: '6px' } },
        h(Btn, {
          size: 'sm',
          onClick: () => Actions.setRightTab('assistant'),
        }, '把意见发到助手'))),
    h(ReviewDomainMount),
    h('div', { className: 'avw-prop' },
      h('h4', null, '按对象查看讨论'),
      h('p', { className: 'avw-hint' }, '讨论按对象、版本和事项归档；聊天不是唯一事实源。上方审阅视图显示真实批注、候选与历史（只读）。')))
}

function AssistantPane(props) {
  const state = useStoreState()
  const project = state.project
  const messages = project?.assistant?.messages ?? []
  const refs = state.assistantRefs ?? []
  const busy = state.busy === 'assistant'
  return h('div', { className: 'avw-drawer' },
    h('div', { style: { padding: '8px 10px', borderBottom: '1px solid var(--avw-line)', display: 'flex', alignItems: 'center', gap: '6px' } },
      h('b', { style: { fontSize: '12px' } }, '项目助手'),
      h(Chip, { tone: 'warn' }, '默认关闭 · 与属性共用右侧'),
      h('span', { className: 'avw-grow' }),
      h(Btn, { size: 'sm', variant: 'ghost', icon: 'close', onClick: () => Actions.setRightTab('properties'), ariaLabel: '关闭助手' })),
    h('div', { className: 'avw-chat' },
      messages.length === 0
        ? h(Empty, { icon: 'assistant', title: '助手还没开始', message: '选中对象后“引用到对话”，再写下你的要求；消息和引用会真实保存，制作编排由 C13 接入后继续。' })
        : messages.map((message) => h('div', { key: message.messageId, className: `avw-msg${message.status === 'queued-for-orchestration' ? ' avw-msg--pending' : ''}` },
          h('small', null, `${formatDateTime(message.at)} · ${message.author === 'user' ? '你' : '助手'}`),
          h('p', null, message.text),
          (message.refs ?? []).length > 0
            ? h('div', { className: 'avw-refs' }, message.refs.map((ref, index) => h(Chip, { key: index, tone: 'accent' }, `${ref.objectLabel ?? ref.objectId ?? '对象'}${ref.versionId ? ` · ${shortRevision(ref.versionId)}` : ''}`)))
            : null,
          h('small', { style: { marginTop: '4px', color: 'var(--avw-text-3)' } },
            `${ASSISTANT_STATUS_LABELS[message.status] ?? message.status} · ${message.note ?? ''}`)))),
    h('div', { className: 'avw-compose' },
      refs.length > 0
        ? h('div', { className: 'avw-refs', style: { marginBottom: '6px' } }, refs.map((ref, index) => h('button', {
          key: index,
          type: 'button',
          className: 'avw-chip avw-chip--accent',
          title: '移除引用',
          onClick: () => Actions.removeReference(index),
          style: { border: '1px solid currentColor', background: 'transparent' },
        }, `${ref.objectLabel}${ref.versionId ? ` · ${shortRevision(ref.versionId)}` : ''} ×`)))
        : null,
      h('textarea', {
        value: state.assistantDraft,
        placeholder: '写要求或组合意见。例如：开头用小样 02，结构部分用 01，标题和音乐不要动。',
        'aria-label': '发给项目助手的内容',
        onChange: (event) => Actions.setAssistantDraft(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            Actions.sendAssistant()
          }
        },
      }),
      h('div', { className: 'avw-compose-bar' },
        h(Btn, { size: 'sm', variant: 'ghost', icon: 'marker', onClick: () => Actions.addReference() }, '引用当前对象'),
        h('span', { className: 'avw-compose-hint' }, '消息会真实保存；回答与制作由 C13 接入，不会假装已经完成。'),
        h(Btn, { size: 'sm', variant: 'primary', disabled: busy || state.assistantDraft.trim().length === 0, onClick: () => Actions.sendAssistant() }, busy ? '保存中…' : '保存到项目'))))
}

function RightPanel() {
  const state = useStoreState()
  const project = state.project
  const material = state.selection?.type === 'material'
    ? (project?.materials?.materials ?? []).find((item) => item.materialId === state.selection.objectId)
    : null
  const tab = state.rightTab
  return h('aside', { className: 'avw-col avw-col--right', 'aria-label': '属性、批注与助手' },
    h('div', { className: 'avw-rtabs', role: 'tablist' },
      ['properties', 'notes', 'assistant'].map((id) => h('button', {
        key: id,
        type: 'button',
        role: 'tab',
        'aria-selected': String(tab === id),
        onClick: () => {
          Actions.setRightTab(id)
          if (id === 'assistant' && Store.get().assistantOpen !== true) {
            Store.set((current) => ({ ...current, assistantOpen: true }))
          }
        },
      }, id === 'properties' ? '属性' : id === 'notes' ? '批注' : '助手'))),
    tab === 'assistant'
      ? h(AssistantPane)
      : h(React.Fragment, null,
        h('div', { className: 'avw-objhead' },
          h('i', null, h(Icon, { name: material ? 'image' : 'project', size: 14 })),
          h('div', { style: { minWidth: 0 } },
            h('b', null, material ? material.originalFilename : state.selection?.label ?? '项目'),
            h('small', null, material
              ? `材料 · ${formatBytes(material.byteSize)} · ${MATERIAL_OBSERVATION_LABELS[material.observation] ?? material.observation}`
              : `${project?.project?.phase ?? ''} · 修订 ${shortRevision(project?.revision)}`))),
        h('div', { className: 'avw-props' },
          tab === 'properties'
            ? (material ? h(MaterialProperties, { material, project }) : h(ProjectProperties, { project }))
            : h(NotesPane)))
  )
}

function VersionDialog(props) {
  const state = useStoreState()
  const events = state.events ?? []
  const project = state.project
  return h(Modal, { open: props.open, title: '版本与记录', onClose: props.onClose },
    h('p', { className: 'avw-hint', style: { marginTop: 0 } },
      `当前修订 ${shortRevision(project?.revision)}。创作期有当前／候选／定稿三类版本；候选、对照与回退在“批注”面板的审阅视图里只读查看。`),
    h('div', { style: { maxHeight: '320px', overflow: 'auto', border: '1px solid var(--avw-line)', borderRadius: '3px' } },
      events.length === 0
        ? h('div', { style: { padding: '16px', color: 'var(--avw-text-3)', fontSize: '11.5px' } }, '这个项目还没有可显示的事件。')
        : events.map((event, index) => h('div', {
          key: `${event.eventId ?? index}`,
          style: { display: 'grid', gap: '2px', padding: '8px 10px', borderBottom: '1px solid var(--avw-line)' },
        },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
          h('b', { style: { fontSize: '12px' } }, event.kind ?? '事件'),
          h('span', { className: 'avw-mono', style: { fontSize: '10px', color: 'var(--avw-text-3)' } }, event.at ? formatDateTime(event.at) : '')),
        h('span', { className: 'avw-hint' }, event.objectId ? `对象 ${event.objectId}` : '')))),
    h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h(Chip, { tone: 'ok', dot: true }, '自动保存由 C10 负责'),
      h(Chip, { tone: 'ok' }, '审阅视图：已接入（只读）'),
      h(Chip, { tone: 'warn' }, '接受／回退按钮：未接入')))
}

function CreateDialog(props) {
  const state = useStoreState()
  return h(Modal, { open: props.open, title: '新建项目', onClose: () => Actions.closeModal() },
    h('div', { style: { display: 'grid', gap: '9px' } },
      h(Field, {
        value: state.createDraft.title,
        placeholder: '项目名称（必填）',
        ariaLabel: '项目名称',
        onInput: (value) => Actions.decide('title', value),
      }),
      h('textarea', {
        value: state.createDraft.idea,
        placeholder: '想做的东西、限制或已有材料，一句话也可以。',
        'aria-label': '创作想法',
        onChange: (event) => Actions.decide('idea', event.target.value),
        style: { minHeight: '96px', width: '100%', padding: '8px 9px', border: '1px solid var(--avw-line)', borderRadius: '3px', background: 'var(--avw-field)', outline: 0 },
      }),
      h('p', { className: 'avw-hint' }, '建立后会立刻进入项目；材料可在创作面添加。')),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' } },
      h(Btn, { onClick: () => Actions.closeModal() }, '取消'),
      h(Btn, { variant: 'primary', disabled: state.busy === 'create', onClick: () => Actions.createProject() }, state.busy === 'create' ? '正在建立…' : '建立项目')))
}

function ImportDialog() {
  const state = useStoreState()
  const modal = state.modal
  if (!modal || modal.kind !== 'import') return null
  const result = modal.result ?? {}
  return h(Modal, { open: true, title: '导入项目', onClose: () => Actions.closeModal() },
    h(GapCard, { gap: { owner: 'C15', title: '完整可编辑项目包', message: result.reason ?? '项目包导入尚未接入。' } }),
    h('p', { className: 'avw-hint', style: { marginTop: '10px' } },
      '添加参考材料与导入整个项目是不同动作：前者在创作面完成，后者需要检查完整性、环境差异与同名冲突，且不覆盖现有项目。'),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '12px' } },
      h(Btn, { onClick: () => Actions.closeModal() }, '知道了')))
}

function DeliveryDialog(props) {
  return h(Modal, { open: props.open, title: '交付与结项', onClose: props.onClose },
    h(GapCard, { gap: INTEGRATION_GAPS.delivery }),
    h('p', { className: 'avw-hint', style: { marginTop: '10px' } },
      '交付会绑定明确的定稿版本与规格；导出成功只表示文件生成，不表示发布。'),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '12px' } },
      h(Btn, { onClick: props.onClose }, '关闭')))
}

function HelpDialog(props) {
  return h(Modal, { open: props.open, title: '键盘与焦点', onClose: props.onClose },
    h('div', { style: { display: 'grid', gap: '5px' } },
      SHORTCUT_HELP.map((row) => h('div', { key: row.keys, style: { display: 'grid', gridTemplateColumns: '220px 1fr', gap: '8px', fontSize: '12px' } },
        h('span', { className: 'avw-mono', style: { color: 'var(--avw-text-2)' } }, row.keys),
        h('span', { style: { color: 'var(--avw-text-3)' } }, row.action)))),
    h('p', { className: 'avw-hint', style: { marginTop: '10px' } }, '在输入框里打字时不会拦截这些键；Esc 始终可离开当前临时区域。'))
}

function ProjectTopBar(props) {
  const state = useStoreState()
  const project = state.project
  const saveState = state.saveState
  return h('div', { className: 'avw-topbar' },
    h(Btn, { variant: 'ghost', icon: 'chevron', ariaLabel: '返回项目列表', onClick: () => Actions.backHome() }),
    h('div', { className: 'avw-title' },
      h('b', { title: project?.project?.title }, project?.project?.title ?? '项目'),
      h('em', null, project?.state?.phaseLabel ?? '项目')),
    h('span', { className: 'avw-hsep' }),
    h(Seg, {
      label: '项目工作面',
      value: state.surface,
      items: [{ id: 'creation', label: '创作' }, { id: 'work', label: '作品' }],
      onChange: (value) => Actions.setSurface(value),
    }),
    h('span', { className: 'avw-grow' }),
    h(Chip, { tone: project?.state?.needsAttention ? 'warn' : 'default', dot: project?.state?.needsAttention === true }, project?.state?.executionLabel ?? ''),
    h(SaveChip, { state: saveState, title: state.lastSavedAt ? `上次保存 ${formatDateTime(state.lastSavedAt)}` : '尚未保存位置' }),
    h(Btn, { size: 'sm', icon: 'assistant', variant: state.rightTab === 'assistant' ? 'primary' : 'default', onClick: () => Actions.toggleAssistant() }, '助手'),
    h(Btn, { size: 'sm', onClick: () => props.onVersions() }, '版本'),
    h(Btn, { size: 'sm', onClick: () => props.onDelivery() }, '交付'),
    state.layout?.mode === 'narrow'
      ? h(React.Fragment, null,
        h(Btn, { size: 'sm', icon: 'layers', onClick: () => props.onToggleLeft() }, '结构'),
        h(Btn, { size: 'sm', icon: 'tools', onClick: () => props.onToggleRight() }, '属性'))
      : null)
}

export function ProjectView() {
  const state = useStoreState()
  const [versionsOpen, setVersionsOpen] = React.useState(false)
  const [deliveryOpen, setDeliveryOpen] = React.useState(false)
  const [leftOpen, setLeftOpen] = React.useState(false)
  const [rightOpen, setRightOpen] = React.useState(false)
  useToastTimer(state.toast)

  const sharedDialogs = h(React.Fragment, null,
    h(CreateDialog, { open: state.modal === 'create' }),
    h(ImportDialog),
    h(HelpDialog, { open: state.helpOpen === true, onClose: () => Store.set((current) => ({ ...current, helpOpen: false })) }),
    h(Toast, { toast: state.toast }))

  if (state.view !== 'project' || !state.project) {
    return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' } },
      h(HomeView),
      sharedDialogs)
  }

  const mode = state.layout?.mode ?? 'wide'
  const showLeft = mode === 'wide' || mode === 'medium'
  const showRight = mode === 'wide' || mode === 'medium' || rightOpen
  const Surface = state.surface === 'work' ? WorkSurface : CreationSurface
  const colsClass = showLeft && showRight ? 'avw-cols' : 'avw-cols avw-cols--narrow'
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h(ProjectTopBar, {
      onVersions: () => setVersionsOpen(true),
      onDelivery: () => setDeliveryOpen(true),
      onToggleLeft: () => setLeftOpen(true),
      onToggleRight: () => setRightOpen(true),
    }),
    h('div', { className: 'avw-ws' },
      h('div', { className: colsClass, style: { position: 'relative' } },
        showLeft ? h(Surface.Left) : null,
        h(Surface.Center),
        showRight ? h(RightPanel) : null,
        mode !== 'wide' && mode !== 'medium' && leftOpen
          ? h('div', { className: 'avw-drawer-left' },
            h('div', { className: 'avw-pane-head' }, h('b', null, '结构'), h('span', { className: 'avw-grow' }), h(Btn, { size: 'sm', variant: 'ghost', icon: 'close', onClick: () => setLeftOpen(false), ariaLabel: '关闭结构' })),
            h(Surface.LeftContent))
          : null,
        mode !== 'wide' && mode !== 'medium' && rightOpen
          ? h('div', { className: 'avw-drawer-right' },
            h('div', { className: 'avw-pane-head' }, h('b', null, '属性'), h('span', { className: 'avw-grow' }), h(Btn, { size: 'sm', variant: 'ghost', icon: 'close', onClick: () => setRightOpen(false), ariaLabel: '关闭属性' })),
            h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, h(RightPanel)))
          : null),
      h(Surface.Bottom),
      h(Surface.StatusBar)),
    h(VersionDialog, { open: versionsOpen, onClose: () => setVersionsOpen(false) }),
    h(DeliveryDialog, { open: deliveryOpen, onClose: () => setDeliveryOpen(false) }),
    sharedDialogs)
}
