/**
 * Creation surface: brief, materials, directions/plan/units.
 *
 * What is real here: the editable brief (three explicitly separated sources), the material catalog
 * with its real observation state and recorded uses, and object selection that references a real
 * material id + content hash. What is not: directions, plan items and early units belong to C13, so
 * they are rendered as named gaps with the owning card — never as sample cards or dead controls.
 *
 * @module ui/client/views/creation
 */

function briefOf(state) {
  const raw = state.project?.uiState?.brief
  if (typeof raw === 'string') return { user: raw, source: '', ai: '' }
  return { user: '', source: '', ai: '', ...(raw ?? {}) }
}

function CreationLeftSection(props) {
  return h('div', { className: 'avw-tree-group' },
    h('div', { className: 'avw-pane-head' }, props.title),
    props.children)
}

function CreationLeftContent() {
  const state = useStoreState()
  const project = state.project
  const materials = project?.materials?.materials ?? []
  const uses = project?.materials?.uses ?? []
  const brief = briefOf(state)
  return h('div', { className: 'avw-tree' },
    h(CreationLeftSection, { title: '可编辑简报' },
      h('button', { type: 'button', className: 'avw-tree-item', onClick: () => scrollToSection('avw-brief') },
        h(Icon, { name: 'text' }), '目标与限制',
        h('span', { className: 'meta' }, brief.user || brief.source || brief.ai ? '已写' : '未写')),
      h('button', { type: 'button', className: 'avw-tree-item avw-tree-depth1', onClick: () => scrollToSection('avw-brief') },
        h(Icon, { name: 'check' }), '用户要求', h('span', { className: 'meta' }, brief.user ? '有' : '空')),
      h('button', { type: 'button', className: 'avw-tree-item avw-tree-depth1', onClick: () => scrollToSection('avw-brief') },
        h(Icon, { name: 'info' }), '来源主张', h('span', { className: 'meta' }, brief.source ? '有' : '空')),
      h('button', { type: 'button', className: 'avw-tree-item avw-tree-depth1', onClick: () => scrollToSection('avw-brief') },
        h(Icon, { name: 'assistant' }), 'AI 推断', h('span', { className: 'meta' }, brief.ai ? '有' : '空'))),
    h(CreationLeftSection, { title: `材料与来源 · ${materials.length}` },
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
        h('span', { className: 'meta' }, `${MATERIAL_OBSERVATION_LABELS[material.observation] ?? material.observation} · ${uses.filter((use) => use.materialId === material.materialId).length} 用`)))),
    h(CreationLeftSection, { title: '方向与方案' },
      h('div', { className: 'avw-tree-item', style: { color: 'var(--avw-text-3)', cursor: 'default' } },
        h(Icon, { name: 'layers' }), '方向、方案、单元由 C13 接入')),
    h('div', { style: { padding: '6px 8px' } },
      h('p', { className: 'avw-hint' }, '这里显示真实对象；没有的就不画。')))
}

function CreationLeft() {
  return h('aside', { className: 'avw-col avw-col--left' },
    h('div', { className: 'avw-pane-head' }, h('b', null, '创作'), h('span', { className: 'avw-grow' })),
    h('div', { className: 'avw-pane-body' }, h(CreationLeftContent)))
}

function MaterialCard(props) {
  const state = useStoreState()
  const material = props.material
  const selected = state.selection?.objectId === material.materialId
  const preview = Actions._previews[material.materialId]
  const uses = (state.project?.materials?.uses ?? []).filter((use) => use.materialId === material.materialId)
  return h('button', {
    type: 'button',
    className: 'avw-material',
    'aria-selected': String(selected),
    onClick: () => Actions.select({
      type: 'material',
      objectId: material.materialId,
      label: material.originalFilename,
      versionId: material.contentSha256,
    }),
    title: material.originalFilename,
  },
  h('div', { className: 'avw-material-plate' },
    preview
      ? h('img', { src: preview, alt: material.originalFilename })
      : h(Icon, { name: material.kind === 'image' ? 'image' : material.kind === 'video' ? 'film' : material.kind === 'audio' ? 'audio' : 'layers', size: 22 })),
  h('div', { className: 'avw-material-meta' },
    h('b', null, middleTruncate(material.originalFilename, 26)),
    h('small', null, `${MATERIAL_KIND_LABELS[material.kind] ?? material.kind} · ${formatBytes(material.byteSize)} · ${MATERIAL_OBSERVATION_LABELS[material.observation] ?? material.observation}`),
    h('small', { style: { color: uses.length > 0 ? 'var(--avw-ok)' : 'var(--avw-text-3)' } }, uses.length > 0 ? `${uses.length} 条用途说明` : '还没有用途说明')))
}

function BriefSection() {
  const state = useStoreState()
  const brief = briefOf(state)
  const fields = [
    { id: 'user', label: '用户要求', hint: '你明确说过的目标、限制和偏好' },
    { id: 'source', label: '来源主张', hint: '材料或参考里说的内容，仍需核对' },
    { id: 'ai', label: 'AI 推断', hint: '推断不是你的要求，可以改或删' },
  ]
  return h('div', { className: 'avw-card', id: 'avw-brief' },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, '可编辑简报'),
      h(Chip, { tone: 'accent' }, '真实保存到项目'),
      h('span', { className: 'avw-grow' }),
      h('span', { className: 'avw-card__note' }, '自动保存')),
    h('div', { className: 'avw-card__body', style: { display: 'grid', gap: '9px' } },
      fields.map((field) => h('div', { key: field.id, className: `avw-brief avw-brief--${field.id}` },
        h('div', { className: 'avw-brief-label' },
          h('b', null, field.label),
          h('span', null, field.hint)),
        h('textarea', {
          value: brief[field.id] ?? '',
          placeholder: field.id === 'user' ? '例：45 秒左右，冷静克制，讲清结构，不要出现品牌 logo。' : '没有就留空；不要把推断写成用户要求。',
          'aria-label': field.label,
          onChange: (event) => Actions.setBrief(field.id, event.target.value),
        })))))
}

function MaterialsSection() {
  const state = useStoreState()
  const project = state.project
  const materials = project?.materials?.materials ?? []
  const fileRef = React.useRef(null)
  const busy = state.busy === 'upload'
  const upload = state.upload
  return h('div', { className: 'avw-card', style: { marginTop: '14px' } },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, '材料'),
      h(Chip, null, `${materials.length} 个`),
      h('span', { className: 'avw-grow' }),
      h('span', { className: 'avw-card__note' }, '上传后用一句话说明用途')),
    h('div', { className: 'avw-card__body' },
      h('input', {
        ref: fileRef,
        type: 'file',
        multiple: true,
        style: { display: 'none' },
        onChange: (event) => { Actions.uploadFiles(event.target.files); event.target.value = '' },
      }),
      materials.length === 0
        ? h(Empty, {
          icon: 'upload',
          title: '还没有材料',
          message: '可以直接上传图像、视频、音频、文本或字体；材料会写入项目目录并由 C10 记录哈希与大小。',
          children: h(Btn, { size: 'sm', icon: 'upload', disabled: busy, onClick: () => fileRef.current?.click() }, '选择材料'),
        })
        : h('div', { className: 'avw-materials' }, materials.map((material) => h(MaterialCard, { key: material.materialId, material }))),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' } },
        materials.length > 0 ? h(Btn, { size: 'sm', icon: 'upload', disabled: busy, onClick: () => fileRef.current?.click() }, busy ? '正在写入…' : '添加材料') : null,
        busy && upload ? h(Chip, { tone: 'warn' }, `${upload.done}/${upload.total}`) : null,
        h('span', { className: 'avw-hint', style: { margin: 0 } }, '未读、不可读、未观察会分别标出来；预览画面由 C12 接入。'))))
}

function CreationCenter() {
  const state = useStoreState()
  return h('section', { className: 'avw-col avw-col--center' },
    h('div', { className: 'avw-scroll' },
      h('div', { style: { padding: '14px 16px', maxWidth: '1080px' } },
        h(BriefSection),
        h(MaterialsSection),
        h('div', { style: { marginTop: '14px' } },
          h(GapCard, { gap: INTEGRATION_GAPS.orchestration })),
        h('div', { style: { marginTop: '10px' } },
          h('div', { className: 'avw-card' },
            h('div', { className: 'avw-card__body', style: { display: 'grid', gap: '6px' } },
              h('p', { className: 'avw-hint', style: { margin: 0 } },
                'C13 会在这里给出真实方向小样、方案三态（已定／未定／AI 可自主）和早期生产单元。现在不显示示例卡，也不显示可点的“验收”按钮。'),
              h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                h(Chip, { tone: 'warn' }, '关键项未定 → 不开始完整制作'),
                h(Chip, null, '三态由 C13 提供'),
                h(Chip, null, '单元缺项 → 不给有效验收'))))))))
}

function CreationBottom() {
  return h('div', { className: 'avw-timeline', style: { height: '72px' } },
    h('div', { className: 'avw-timeline-head' },
      h('b', null, '时间结构'),
      h('span', null, '尚无合成计划'),
      h('span', { className: 'grow' }),
      h(Chip, { tone: 'warn' }, 'C12 接入后显示真实轨道')),
    h('div', { className: 'avw-timeline-empty', style: { padding: '8px' } },
      h('p', { style: { margin: 0 } }, '动态单元出现时，这里会显示真实镜头与时间；当前项目没有合成计划，所以不画空轨道。')))
}

function CreationStatusBar() {
  const state = useStoreState()
  const values = state.preferences?.values ?? {}
  const aspect = values['creation.aspect-ratio'] ?? '16:9'
  const fps = values['creation.frame-rate'] ?? 30
  return h('div', { className: 'avw-statusbar' },
    h('span', null, `输出规格 ${aspect} · ${fps} fps`),
    h('span', null, '总时长 —'),
    h('span', null, `材料 ${state.project?.materials?.materials?.length ?? 0}`),
    h('span', { className: 'grow' }),
    h('span', null, state.project?.state?.phaseLabel ?? ''),
    h('span', null, state.saveState === 'saved' ? '已自动保存' : state.saveState === 'saving' ? '正在保存…' : '未修改'))
}

export const CreationSurface = { Left: CreationLeft, LeftContent: CreationLeftContent, Center: CreationCenter, Bottom: CreationBottom, StatusBar: CreationStatusBar }

function scrollToSection(id) {
  const element = document.getElementById(id)
  if (element) element.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
