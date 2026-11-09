/**
 * Preferences: exactly five groups, read from C10's resolved values.
 *
 * The page writes global defaults through C10. There is no blanket-authorization switch because
 * C10 refuses one; a "not available" note is shown where the schema is locked. Project overrides
 * belong to the project view and are marked as such when a project is open.
 *
 * @module ui/client/views/preferences
 */

const PREF_GROUPS = Object.freeze([
  { id: 'creation', label: '创作方式', hint: '画幅、帧率与默认风格；只影响新建内容，不改已有项目。' },
  { id: 'notification', label: '通知', hint: '重要选择、完成、失败与恢复差异；“需要处理”不可关闭。' },
  { id: 'data-authorization', label: '数据与授权', hint: '联网、外部服务与材料提交；默认每次询问，没有“永远允许一切”。' },
  { id: 'storage', label: '存储', hint: '项目根目录、缓存保留与占用；缓存可清理，项目不可。' },
  { id: 'workspace', label: '工作区', hint: '面板与危险动作确认；助手默认关闭。' },
])

function preferenceControl(item, spec) {
  if (spec?.locked === true) {
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
      h(Chip, { tone: 'warn' }, '固定开启'),
      h('span', { className: 'avw-hint', style: { margin: 0 } }, '安全要求，不能关闭'))
  }
  const value = item.value
  if (spec?.kind === 'boolean') {
    return h('label', { className: 'avw-switch' },
      h('input', {
        type: 'checkbox',
        checked: value === true,
        onChange: (event) => Actions.setPreference(item.key, event.target.checked),
      }),
      value === true ? '开启' : '关闭')
  }
  if (spec?.kind === 'enum') {
    return h('select', {
      value: String(value ?? ''),
      onChange: (event) => {
        const raw = event.target.value
        const next = (spec.values ?? []).find((candidate) => String(candidate) === raw)
        Actions.setPreference(item.key, next === undefined ? raw : next)
      },
    }, (spec.values ?? []).map((option) => h('option', { key: String(option), value: String(option) }, String(option))))
  }
  if (spec?.kind === 'integer') {
    return h('input', {
      type: 'number',
      min: spec.min,
      max: spec.max,
      defaultValue: value ?? '',
      onBlur: (event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next)) Actions.setPreference(item.key, next)
      },
    })
  }
  return h('input', {
    type: 'text',
    defaultValue: value ?? '',
    maxLength: spec?.maxLength ?? 300,
    placeholder: spec?.kind === 'absolute-path' ? '留空表示使用默认位置' : '',
    onBlur: (event) => {
      const next = String(event.target.value ?? '')
      Actions.setPreference(item.key, next.length === 0 && spec?.kind === 'absolute-path' ? null : next)
    },
  })
}

export function PreferencesView() {
  const state = useStoreState()
  const preferences = state.preferences
  React.useEffect(() => { if (preferences === null) Actions.loadPreferences() }, [])
  const spec = preferences?.spec ?? {}
  const items = preferences?.items ?? []
  const projectName = state.project?.project?.title ?? null
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h('div', { className: 'avw-scroll' },
      h('div', { className: 'avw-page' },
        h('h2', null, '偏好'),
        h('p', null, '五组设置；全局值是默认值，项目覆盖只在项目里生效。'),
        preferences === null
          ? h(Empty, { icon: 'prefs', title: '正在读取偏好…' })
          : preferences.corrupt === true
            ? h(GapCard, { gap: { owner: 'C10', title: '偏好文件损坏', message: '读取失败，文件保持原样；不会静默重置你的设置。' } })
            : h('div', null,
              projectName
                ? h('div', { style: { marginBottom: '10px' } },
                  h(Chip, { tone: 'accent' }, `当前项目：${projectName}`),
                  h('span', { className: 'avw-hint', style: { marginLeft: '8px' } }, '本页只写全局默认；项目覆盖由项目内设置提供（当前版本未接入界面）。'))
                : null,
              PREF_GROUPS.map((group) => {
                const rows = items.filter((item) => item.group === group.id)
                return h('section', { key: group.id, className: 'avw-pref-group' },
                  h('h3', null, group.label),
                  h('div', { style: { padding: '7px 11px', borderBottom: '1px solid var(--avw-line)' } },
                    h('span', { className: 'avw-hint', style: { margin: 0 } }, group.hint)),
                  rows.map((item) => h('div', { key: item.key, className: 'avw-pref-row' },
                    h('div', null,
                      h('b', null, PREFERENCE_LABELS[item.key] ?? item.key),
                      h('small', null, `${item.key} · ${item.label ?? ''}`)),
                    h('div', null, preferenceControl(item, spec[item.key] ?? {})))))
              }),
              h('div', { style: { marginTop: '4px' } },
                h('p', { className: 'avw-hint' },
                  '存储位置：',
                  h('span', { className: 'avw-mono' }, state.bootstrap?.roots?.projectsRoot ?? '—')),
                h('p', { className: 'avw-hint' },
                  '缓存（可重建）：',
                  h('span', { className: 'avw-mono' }, state.bootstrap?.roots?.cacheRoot ?? '—')),
                h('p', { className: 'avw-hint' },
                  '外部工具（用户独立安装）：',
                  h('span', { className: 'avw-mono' }, state.bootstrap?.roots?.toolsRoot ?? '—')))))),
      h(Toast, { toast: state.toast }))
}
