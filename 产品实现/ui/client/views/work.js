/**
 * Work surface: structure, canvas, properties and timeline.
 *
 * C12 owns composition objects and real pictures. Until it lands, this surface shows the real
 * project and real materials, an explicit "no composition plan" state, and a dark neutral stage —
 * it does not draw sample clips, fake frames, or an enabled transport over nothing.
 *
 * @module ui/client/views/work
 */

function WorkLeftContent() {
  const state = useStoreState()
  const materials = state.project?.materials?.materials ?? []
  return h('div', { className: 'avw-tree' },
    h('div', { className: 'avw-pane-head' }, '项目结构'),
    h('button', { type: 'button', className: 'avw-tree-item', onClick: () => Actions.notify('整片时间结构与镜头由 C12 接入；当前没有真实合成计划。') },
      h(Icon, { name: 'film' }), '整片',
      h('span', { className: 'meta' }, '无计划')),
    h('button', { type: 'button', className: 'avw-tree-item avw-tree-depth1', onClick: () => Actions.notify('段落与镜头由 C12 接入。') },
      h(Icon, { name: 'layers' }), '段落 / 镜头',
      h('span', { className: 'meta' }, 'C12')),
    h('button', { type: 'button', className: 'avw-tree-item avw-tree-depth1', onClick: () => Actions.notify('字幕、图形与转场需要真实时间对象（C12）。') },
      h(Icon, { name: 'text' }), '图形文字 / 转场',
      h('span', { className: 'meta' }, 'C12')),
    h('div', { className: 'avw-tree-group' },
      h('div', { className: 'avw-pane-head' }, `素材与音频 · ${materials.length}`),
      materials.length === 0
        ? h('div', { className: 'avw-tree-item', style: { color: 'var(--avw-text-3)', cursor: 'default' } }, '还没有材料')
        : materials.map((material) => h('button', {
          key: material.materialId,
          type: 'button',
          className: 'avw-tree-item',
          'aria-selected': String(state.selection?.objectId === material.materialId),
          onClick: () => Actions.select({
            type: 'material',
            objectId: material.materialId,
            label: material.originalFilename,
            versionId: material.contentSha256,
          }),
        },
        h(Icon, { name: material.kind === 'image' ? 'image' : material.kind === 'video' ? 'film' : material.kind === 'audio' ? 'audio' : 'layers' }),
        material.originalFilename,
        h('span', { className: 'meta' }, MATERIAL_KIND_LABELS[material.kind] ?? material.kind)))),
    h('div', { className: 'avw-tree-group' },
      h('div', { className: 'avw-pane-head' }, '共享组件'),
      h('div', { className: 'avw-tree-item', style: { color: 'var(--avw-text-3)', cursor: 'default' } },
        h(Icon, { name: 'layers' }), '共享组件与实例由 C12 接入')),
    h('div', { style: { padding: '8px' } },
      h('p', { className: 'avw-hint' }, '这里只列真实存在的对象；空轨道与空面板不显示。')))
}

function WorkLeft() {
  return h('aside', { className: 'avw-col avw-col--left' },
    h('div', { className: 'avw-pane-head' }, h('b', null, '项目结构'), h('span', { className: 'avw-grow' })),
    h('div', { className: 'avw-pane-body' }, h(WorkLeftContent)))
}

function WorkCanvas() {
  const state = useStoreState()
  const selection = state.selection
  const material = selection?.type === 'material'
    ? (state.project?.materials?.materials ?? []).find((item) => item.materialId === selection.objectId)
    : null
  const preview = material ? Actions._previews[material.materialId] : null
  const canPreview = material?.kind === 'image' && preview
  return h('div', { className: 'avw-canvas', tabIndex: 0, 'aria-label': '画面区域' },
    canPreview
      ? h('img', { src: preview, alt: material.originalFilename, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' } })
      : h('div', { className: 'avw-canvas-empty' },
        h(Icon, { name: 'film', size: 30 }),
        h('b', null, '尚无合成画面'),
        h('p', null, 'C12 会在这里给出真实预览、对象命中和单看／并排对照。现在没有可显示的成片或代理预览。'),
        h(Chip, { tone: 'warn' }, '不是静态图冒充产品')),
    canPreview
      ? h('div', {
        style: {
          position: 'absolute', left: '8px', top: '8px', zIndex: 2, padding: '2px 7px',
          background: 'rgba(6,10,16,.66)', border: '1px solid rgba(255,255,255,.18)',
          borderRadius: '2px', color: '#cbd6e2', fontSize: '10px',
        },
      }, '材料查看 · 非成片画面')
      : null,
    h('div', { className: 'avw-safe' }))
}

function WorkCenter() {
  const state = useStoreState()
  const selection = state.selection
  const reason = 'C12 尚未接入合成计划与真实预览'
  return h('section', { className: 'avw-col avw-col--center' },
    h('div', { className: 'avw-stage' },
      h('div', { className: 'avw-stage-bar' },
        h(Seg, {
          label: '对照方式',
          value: 'single',
          items: [{ id: 'single', label: '单看' }, { id: 'side', label: '并排' }, { id: 'sync', label: '同步' }],
          onChange: () => Actions.notify(reason),
        }),
        h('span', { className: 'sep' }),
        h(Btn, { size: 'sm', variant: 'ghost', onClick: () => Actions.notify(reason) }, '原比例'),
        h(Chip, null, '适应窗口'),
        h('span', { className: 'sep' }),
        h(Chip, { tone: 'warn' }, '预览质量 · 代理'),
        h('span', { className: 'grow' }),
        h(Chip, { tone: 'default' }, selection ? `已选：${selection.label ?? selection.objectId}` : '未选对象')),
      h('div', { className: 'avw-canvas-wrap' }, h(WorkCanvas)),
      h('div', { className: 'avw-transport' },
        h(Btn, { variant: 'ghost', icon: 'prev', ariaLabel: '上一镜头', disabled: true, title: reason }),
        h(Btn, { icon: 'play', ariaLabel: '播放', disabled: true, title: reason }),
        h(Btn, { variant: 'ghost', icon: 'next', ariaLabel: '下一帧', disabled: true, title: reason }),
        h('span', { className: 'avw-timecode' }, `${framesToTimecode(state.playhead ?? 0, 25)} `, h('small', null, '/ —')),
        h(Btn, { size: 'sm', variant: 'ghost', onClick: () => Actions.notify(reason) }, '设入点 I'),
        h(Btn, { size: 'sm', variant: 'ghost', onClick: () => Actions.notify(reason) }, '设出点 O'),
        h('span', { className: 'grow' }),
        h(Chip, { tone: 'warn', dot: true }, '无合成计划'),
        h('span', { className: 'avw-disabled-reason' }, reason)))
  )
}

function WorkBottom() {
  return h('div', { className: 'avw-timeline' },
    h('div', { className: 'avw-timeline-head' },
      h('b', null, '时间结构'),
      h('span', null, '25 fps'),
      h('span', null, '·'),
      h('span', null, '无真实合成计划'),
      h('span', { className: 'grow' }),
      h(Chip, { tone: 'warn' }, '空轨道不显示')),
    h('div', { className: 'avw-timeline-empty' },
      h(Icon, { name: 'film', size: 24 }),
      h('b', null, '还没有可编辑的时间线'),
      h('p', null, '镜头、图形文字、转场、人声与音乐音效轨道会在 C12 提供真实合成计划后出现；无旁白或无声音的作品不会显示对应空轨道。')))
}

function WorkStatusBar() {
  const state = useStoreState()
  const values = state.preferences?.values ?? {}
  return h('div', { className: 'avw-statusbar' },
    h('span', null, `输出规格 ${values['creation.aspect-ratio'] ?? '16:9'} · ${values['creation.frame-rate'] ?? 30} fps`),
    h('span', null, '总时长 —'),
    h('span', null, '当前预览 无'),
    h('span', { className: 'grow' }),
    h('span', null, '播放头不自动切换选中对象'),
    h('span', null, state.saveState === 'saved' ? '已保存' : state.saveState === 'saving' ? '正在保存…' : '未修改'))
}

export const WorkSurface = { Left: WorkLeft, LeftContent: WorkLeftContent, Center: WorkCenter, Bottom: WorkBottom, StatusBar: WorkStatusBar }
