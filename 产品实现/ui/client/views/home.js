/**
 * Project home: continue, start, waiting items and recent projects.
 *
 * Every list here is the Host's real answer. An empty registry renders a real empty state, a
 * missing tool is reported as missing, and "新建" writes a real project through C10 before the user
 * lands in it (C11 card §4.2).
 *
 * @module ui/client/views/home
 */

let pendingStartFiles = []

function HomeHeader() {
  const state = useStoreState()
  return h('div', { className: 'avw-home-head' },
    h('div', { style: { minWidth: '180px' } },
      h('h1', null, '项目'),
      h('p', null, '新建、继续、导入、审阅和恢复项目')),
    h(Field, {
      icon: 'search',
      value: state.search,
      placeholder: '搜索名称、内容、状态或标签',
      ariaLabel: '搜索项目',
      onInput: (value) => Actions.setSearch(value),
    }),
    h('span', { className: 'avw-grow' }),
    h(Btn, { variant: 'primary', icon: 'plus', onClick: () => Actions.openModal('create') }, '新建项目'),
    h(Btn, { icon: 'upload', onClick: () => Actions.importCheck() }, '导入项目'))
}

function ContinueCard() {
  const state = useStoreState()
  const latest = state.bootstrap?.latest ?? null
  if (!latest) {
    return h('div', { className: 'avw-card' },
      h('div', { className: 'avw-card__body' },
        h(Empty, {
          icon: 'film',
          title: '还没有项目',
          message: '在下面的开始区写一句想法，或先放材料；也可以打开已有项目。',
        })))
  }
  const position = latest.lastPosition ?? null
  const lastObject = position?.selectedObjectId ?? null
  const saveState = latest.needsAttention ? '需要处理' : '已自动保存'
  return h('div', { className: 'avw-card' },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, '回到上次位置'),
      h(Chip, { tone: latest.needsAttention ? 'warn' : 'ok', dot: true }, saveState),
      h('span', { className: 'avw-grow' }),
      h('span', { className: 'avw-card__note' }, latest.updatedAt ? formatDateTime(latest.updatedAt) : '')),
    h('div', { className: 'avw-card__body' },
      h('div', { className: 'avw-continue' },
        h('div', { className: 'avw-thumb' }, h('span', null, h(Icon, { name: 'play', size: 16 }))),
        h('div', { className: 'avw-continue-meta' },
          h('b', { title: latest.title }, latest.title),
          h('small', null, lastObject ? `上次对象：${lastObject}` : '还没有选中对象'),
          h('div', { className: 'avw-continue-row' },
            h('span', null, latest.phaseLabel),
            h('span', null, '·'),
            h('span', null, latest.executionLabel),
            position?.playheadFrame ? h('span', null, `· 播放头 ${framesToTimecode(position.playheadFrame, 25)}`) : null,
            h('span', null, '· 位置由 C10 真实保存'))),
        h(Btn, { variant: 'primary', icon: 'arrowRight', onClick: () => Actions.openProject(latest.projectId) }, '回到上次位置'))))
}

function StartCard() {
  const state = useStoreState()
  const draft = state.createDraft
  const fileRef = React.useRef(null)
  const busy = state.busy === 'create'
  const start = async () => {
    await Actions.createProject()
    const files = pendingStartFiles
    pendingStartFiles = []
    if (files.length > 0 && Store.get().projectId) {
      await Actions.uploadFiles(files)
    }
  }
  return h('div', { className: 'avw-card', style: { marginTop: '14px' } },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, '开始新的创作'),
      h('span', { className: 'avw-grow' }),
      h('span', { className: 'avw-card__note' }, '想法或材料，先给一句就够')),
    h('div', { className: 'avw-card__body' },
      h('div', { className: 'avw-start' },
        h('div', { className: 'avw-start-box' },
          h('div', { style: { padding: '9px 12px 0' } },
            h('input', {
              type: 'text',
              value: draft.title,
              placeholder: '项目名称（必填）',
              'aria-label': '项目名称',
              className: 'avw-start-title',
              onChange: (event) => Actions.decide('title', event.target.value),
              style: { width: '100%', border: 0, outline: 0, background: 'transparent', fontSize: '14px', fontWeight: 600, padding: '2px 0 6px' },
            })),
          h('textarea', {
            value: draft.idea,
            placeholder: '例：做一个 45 秒的机械键盘结构讲解片，冷静、克制，讲清定位板、轴体和消音结构；已有键盘实拍和分轨音频。',
            'aria-label': '创作想法',
            onChange: (event) => Actions.decide('idea', event.target.value),
          }),
          h('div', { className: 'avw-start-bar' },
            h('input', {
              ref: fileRef,
              type: 'file',
              multiple: true,
              style: { display: 'none' },
              onChange: (event) => {
                pendingStartFiles = Array.from(event.target.files ?? [])
                Actions.notify(`已选择 ${pendingStartFiles.length} 个材料，建立项目后写入`)
              },
            }),
            h(Btn, { size: 'sm', variant: 'ghost', icon: 'upload', onClick: () => fileRef.current?.click() }, '添加材料'),
            h('span', { className: 'avw-start-hint' }, '材料用途可直接用一句话说明，不需要前置审批表单'),
            h(Btn, { variant: 'primary', size: 'sm', disabled: busy, onClick: start }, busy ? '正在建立…' : '开始创作')))),
      h('div', { className: 'avw-start-tpl' },
        h('span', { style: { color: 'var(--avw-text-3)', fontSize: '11px', alignSelf: 'center' } }, '可选起点'),
        ['空白项目', '讲解片结构', '已有项目副本', '轻量产品短片'].map((label) => h('button', {
          key: label,
          type: 'button',
          className: 'avw-tpl',
          onClick: () => Actions.notify('模板与已有项目副本由 C13 接入；现在以空白项目开始，不会假装已套用模板。'),
        }, label)))))
}

function WaitingCard() {
  const state = useStoreState()
  const waiting = state.bootstrap?.waiting ?? []
  return h('div', { className: 'avw-card' },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, '需要你处理'),
      waiting.length > 0 ? h(Chip, { tone: 'warn', dot: true }, `${waiting.length} 项`) : null,
      h('span', { className: 'avw-grow' }),
      h('span', { className: 'avw-card__note' }, '来自真实项目状态')),
    h('div', { className: 'avw-card__body' },
      waiting.length === 0
        ? h(Empty, { icon: 'check', title: '没有等待项', message: '当前没有被阻塞的决定、恢复差异或缺失工具。' })
        : h('div', { className: 'avw-todo' }, waiting.map((item, index) => h('div', { className: 'avw-todo-item', key: `${item.kind}-${index}` },
          h(Icon, { name: item.kind === 'tool' ? 'alert' : item.kind === 'recovery' ? 'restore' : 'clock' }),
          h('div', null,
            h('b', null, item.title ?? waitingKindLabel(item.kind)),
            h('p', null, item.message ?? '')),
          h('div', { className: 'avw-todo-actions' },
            item.kind === 'tool'
              ? h(Btn, { size: 'sm', onClick: () => Actions.setPanel('tools') }, '去处理')
              : h(Btn, { size: 'sm', onClick: () => Actions.openProject(item.projectId) }, '打开')))))))
}

function RecentCard() {
  const state = useStoreState()
  const projects = state.bootstrap?.projects ?? []
  const filtered = searchProjects(projects, state.search)
  return h('div', { className: 'avw-card', style: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, '最近项目'),
      h('span', { className: 'avw-grow' }),
      h('span', { className: 'avw-card__note' }, `${projects.length} 个`)),
    h('div', { className: 'avw-card__body', style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '5px' } },
      filtered.length === 0
        ? h(Empty, { icon: 'search', title: state.search ? '没有匹配的项目' : '还没有项目', message: state.search ? '换一个词试试；搜索会匹配名称、状态和时间。' : '用开始区建立第一个项目。' })
        : h('div', { className: 'avw-rows' }, filtered.map((project) => h('button', {
          key: project.projectId,
          type: 'button',
          className: 'avw-row',
          onClick: () => Actions.openProject(project.projectId),
        },
        h('div', { className: 'avw-row-name' },
          h('span', { title: project.title }, project.title),
          h(Chip, { tone: project.needsAttention ? 'warn' : project.phase === 'completed' ? 'ok' : 'default' }, project.phaseLabel)),
        h('div', { className: 'avw-row-side' },
          h(Chip, { tone: project.lastPosition ? 'ok' : 'default' }, project.lastPosition ? '有保存位置' : '无位置')),
        h('div', { className: 'avw-row-meta' },
          h('span', null, project.executionLabel),
          h('span', null, project.lastPosition?.selectedObjectId ? `上次对象 ${project.lastPosition.selectedObjectId}` : '未选对象'),
          h('span', null, formatRelative(project.updatedAt ?? project.createdAt))))))))
}

function HomeFoot() {
  const state = useStoreState()
  const projects = state.bootstrap?.projects ?? []
  const archived = projects.filter((project) => project.phase === 'archived').length
  const trashed = projects.filter((project) => project.phase === 'recycle-bin').length
  const series = projects.filter((project) => project.series?.seriesId).length
  return h('div', {
    style: {
      display: 'flex', gap: '14px', alignItems: 'center', padding: '10px 22px',
      color: 'var(--avw-text-3)', fontSize: '11px', borderTop: '1px solid var(--avw-line)',
    },
  },
  h('span', null, `系列 ${series}`),
  h('span', null, `归档 ${archived}`),
  h('span', null, `回收区 ${trashed}`),
  h('span', { className: 'avw-grow' }),
  h('span', null, '项目助手不在全局导航中 · 它属于具体项目，默认关闭'))
}

export function HomeView() {
  return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } },
    h('div', { className: 'avw-scroll' },
      h('div', { className: 'avw-home' },
        h(HomeHeader),
        h('div', { className: 'avw-home-grid' },
          h('div', null, h(ContinueCard), h(StartCard)),
          h('div', { style: { display: 'grid', gap: '14px', minHeight: 0 } }, h(WaitingCard), h(RecentCard))))),
    h(HomeFoot))
}
