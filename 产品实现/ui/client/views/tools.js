/**
 * Tools page: real C06 status, manual guidance and licence boundaries.
 *
 * This page never installs, downloads or updates anything — that decision belongs to C06's user
 * kernel. It shows the honest state, what still works without a tool, and where the user may put
 * their own install.
 *
 * @module ui/client/views/tools
 */

function guidanceLines(guidance) {
  if (guidance === null || guidance === undefined) return []
  if (Array.isArray(guidance)) return guidance.map((line) => String(line))
  if (typeof guidance === 'string') return [guidance]
  const lines = []
  if (typeof guidance.summary === 'string') lines.push(guidance.summary)
  if (Array.isArray(guidance.steps)) {
    lines.push(...guidance.steps.map((step) => (typeof step === 'string' ? step : JSON.stringify(step))))
  }
  if (typeof guidance.command === 'string') lines.push(`命令：${guidance.command}`)
  if (typeof guidance.location === 'string') lines.push(`位置：${guidance.location}`)
  if (lines.length > 0) return lines
  try {
    return [JSON.stringify(guidance, null, 2)]
  } catch {
    return []
  }
}

function ToolDetail(props) {
  const tool = props.tool
  const lines = guidanceLines(tool.manualGuidance)
  return h(Modal, { open: true, title: `${tool.displayName} · 工具详情`, onClose: () => Actions.closeToolDetail() },
    h('div', { style: { display: 'grid', gap: '7px' } },
      h(KV, { label: '状态', value: `${toolStateLabel(tool.status)}（${tool.userState ?? ''}）` }),
      h(KV, { label: '用途', value: Array.isArray(tool.purpose) ? tool.purpose.join('；') : tool.purpose ?? '—' }),
      h(KV, {
        label: '版本',
        value: `支持 ${tool.versions?.supported ?? '—'} · 已安装 ${tool.versions?.installed ?? '未检测到'} · 上次检测 ${tool.versions?.detected ?? '—'}`,
      }),
      h(KV, {
        label: '许可',
        value: `${tool.license?.spdx ?? '未知'} · ${tool.license?.pluginMit === true ? '插件内部（随包 MIT 路线）' : '外部组件，不适用插件 MIT 门槛'}`,
      }),
      h(KV, { label: '网络', value: tool.effects?.network ? '需要' : '不需要' }),
      h(KV, { label: '数据', value: tool.effects?.dataSubmission ? `会提交到 ${tool.effects?.dataDestination ?? '外部'}` : '不提交' }),
      h(KV, { label: '费用', value: tool.effects?.fee ? '可能有' : '无' }),
      h(KV, { label: '来源', value: tool.source?.description ?? '—' })),
    h('div', { style: { marginTop: '10px' } },
      h('h4', { style: { margin: '0 0 5px', fontSize: '11px', color: 'var(--avw-text-3)' } }, '手动指引'),
      lines.length === 0
        ? h('p', { className: 'avw-hint' }, '没有安装指引；这一项由 C06 按工具类型给出。')
        : h('div', { className: 'avw-guidance' }, lines.map((line, index) => h('div', { key: index, className: 'avw-guidance-line' }, line)))),
    tool.statusReason ? h('p', { className: 'avw-hint' }, `状态原因：${tool.statusReason}`) : null,
    h('p', { className: 'avw-hint' }, '本页只读：插件不下载、不安装、不更新工具。检测、采纳与验证由 C06 内核在用户明确动作后执行。'),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '12px' } },
      h(Btn, { onClick: () => Actions.closeToolDetail() }, '关闭')))
}

function ToolRow(props) {
  const tool = props.tool
  return h('button', {
    type: 'button',
    className: 'avw-tool',
    onClick: () => Actions.inspectTool(tool.toolId),
  },
  h('b', null,
    tool.displayName,
    h(Chip, { tone: tool.usable === true ? 'ok' : 'warn', dot: true }, toolStateLabel(tool.status))),
  h('div', { className: 'avw-tool-meta' },
    h(Chip, null, tool.supportClass === 'plugin-internal' ? '插件内部' : '外部组件'),
    h(Chip, null, tool.packId ?? '—')),
  h('p', null, Array.isArray(tool.purpose) ? tool.purpose.join('；') : tool.purpose ?? ''),
  h('span', { className: 'side' }, h(Chip, { tone: 'default' }, '详情')))
}

export function ToolsView() {
  const state = useStoreState()
  const tools = state.tools
  React.useEffect(() => {
    if (Store.get().tools === null) Actions.loadTools()
  }, [])
  const list = tools?.tools ?? []
  const usable = list.filter((tool) => tool.usable === true).length

  let body
  if (tools === null) {
    body = h(Empty, { icon: 'tools', title: '正在读取工具状态…', message: '状态来自 C06 内核，不是页面自己编的。' })
  } else if (tools.available === false) {
    body = h(GapCard, { gap: { owner: 'C06', title: '工具目录', message: tools.note ?? '工具内核没有加载，无法列出工具。' } })
  } else {
    body = h('div', { className: 'avw-tools' }, list.map((tool) => h(ToolRow, { key: tool.toolId, tool })))
  }

  return h(React.Fragment, null,
    h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
      h('div', { className: 'avw-scroll' },
        h('div', { className: 'avw-page' },
          h('h2', null, '工具'),
          h('p', null, '检查外部能力、查看手动指引与许可边界。插件不下载、不安装、不更新工具。'),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } },
            h(Chip, { tone: usable > 0 ? 'ok' : 'warn', dot: true }, `可用 ${usable}/${list.length}`),
            h(Chip, null, `接口 ${tools?.interfaceVersion ?? '—'}`),
            tools?.available === false ? h(Chip, { tone: 'danger' }, '工具内核不可用') : null),
          body)),
      h(Toast, { toast: state.toast })),
    state.toolDetail ? h(ToolDetail, { tool: state.toolDetail }) : null)
}
