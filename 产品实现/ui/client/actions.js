/**
 * All user actions the workbench performs, in one place.
 *
 * Views stay presentational: they read the store and call these functions. Every write goes to the
 * Host half (real C10/C06), and every failure is surfaced with the Host's message instead of a
 * friendlier guess. UI-only state (which surface is open, drafts, references) is persisted through
 * the Host's project-scoped plugin state so "回到上次位置" survives a Host restart.
 *
 * @module ui/client/actions
 */

const MAX_REFERENCE_RANGE = 2000

function reportError(prefix, error) {
  const message = error?.message ? `${prefix}：${error.message}` : prefix
  Store.set((state) => ({ ...state, busy: null, toast: { message, tone: 'error' } }))
}

function note(message, tone = 'info') {
  Store.set((state) => ({ ...state, toast: { message, tone } }))
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

function mergeProjectUi(project) {
  const ui = project?.uiState ?? null
  return {
    surface: ui?.surface === 'work' ? 'work' : 'creation',
    assistantOpen: ui?.assistantOpen === true,
    selection: ui?.selectedObjectId
      ? { type: 'material', objectId: ui.selectedObjectId, label: ui.selectedObjectLabel ?? ui.selectedObjectId }
      : null,
    playhead: Number.isFinite(ui?.playhead) ? ui.playhead : 0,
  }
}

const Actions = {
  /** Show a user-facing note without pretending an action succeeded. */
  notify(message, tone = 'info') {
    note(message, tone)
  },

  /** Show a note. */
  dismissToast() {
    Store.set((state) => ({ ...state, toast: null }))
  },

  async bootstrap() {
    Store.set((state) => ({ ...state, status: state.status === 'ready' ? 'ready' : 'loading', error: null }))
    try {
      const data = await Api.bootstrap()
      const patch = {
        status: 'ready',
        bootstrap: data,
        tools: data.tools ?? null,
        preferences: data.preferences ?? null,
        effects: data.effects ?? null,
      }
      if (Store.get().projectId === null && data.latest?.projectId) {
        patch.lastProject = data.latest
      }
      Store.set((state) => ({ ...state, ...patch }))
    } catch (error) {
      Store.set((state) => ({ ...state, status: 'error', error: error.message }))
    }
  },

  setPanel(panel) {
    Store.set((state) => ({ ...state, panel }))
    if (panel === 'tools' && Store.get().tools === null) Actions.loadTools()
    if (panel === 'preferences' && Store.get().preferences === null) Actions.loadPreferences()
    if (panel === 'effects' && Store.get().effects === null) Actions.loadEffects()
  },

  setSearch(text) {
    Store.set((state) => ({ ...state, search: text }))
  },

  decide(field, value) {
    Store.set((state) => ({ ...state, createDraft: { ...state.createDraft, [field]: value } }))
  },

  openModal(modal) {
    Store.set((state) => ({ ...state, modal }))
  },

  closeModal() {
    Store.set((state) => ({ ...state, modal: null }))
  },

  async createProject() {
    const draft = Store.get().createDraft
    const title = String(draft.title ?? '').trim()
    const idea = String(draft.idea ?? '').trim()
    if (title.length === 0) {
      note('先给项目一个名字；想法可以稍后再写。', 'error')
      return
    }
    Store.set((state) => ({ ...state, busy: 'create' }))
    try {
      const created = await Api.createProject({ title, idea })
      Store.set((state) => ({
        ...state,
        busy: null,
        modal: null,
        createDraft: { title: '', idea: '' },
        toast: { message: `已建立项目「${created.project.title}」`, tone: 'info' },
      }))
      await Actions.openProject(created.project.projectId)
      await Actions.bootstrap()
    } catch (error) {
      reportError('新建项目失败', error)
    }
  },

  async openProject(projectId) {
    Store.set((state) => ({ ...state, busy: 'open', error: null }))
    try {
      const project = await Api.openProject(projectId)
      const ui = mergeProjectUi(project)
      Store.set((state) => ({
        ...state,
        busy: null,
        panel: 'projects',
        view: 'project',
        projectId,
        project,
        surface: ui.surface,
        assistantOpen: ui.assistantOpen,
        selection: ui.selection,
        playhead: ui.playhead,
        rightTab: 'properties',
        assistantDraft: '',
        assistantRefs: [],
        lastSavedAt: project.position?.autosavedAt ?? null,
        saveState: 'saved',
        composition: { available: false, reason: 'C12 尚未接入合成对象与画面' },
      }))
      Actions.loadEvents()
    } catch (error) {
      reportError('打开项目失败', error)
      Store.set((state) => ({ ...state, busy: null, view: 'home' }))
    }
  },

  backHome() {
    Actions.saveUiStateSoon()
    Store.set((state) => ({ ...state, view: 'home', projectId: null, project: null, selection: null, events: null }))
    Actions.bootstrap()
  },

  setSurface(surface) {
    if (surface !== 'creation' && surface !== 'work') return
    Store.set((state) => ({ ...state, surface }))
    Actions.savePositionSoon()
  },

  select(selection) {
    Store.set((state) => ({ ...state, selection }))
    Actions.saveUiStateSoon()
  },

  setRightTab(tab) {
    Store.set((state) => ({ ...state, rightTab: tab }))
  },

  toggleAssistant() {
    Store.set((state) => ({ ...state, assistantOpen: !state.assistantOpen, rightTab: state.assistantOpen ? 'properties' : 'assistant' }))
    Actions.saveUiStateSoon()
  },

  setAssistantDraft(text) {
    Store.set((state) => ({ ...state, assistantDraft: text }))
  },

  /** Attach the current selection as a reference, keeping object + version + optional range. */
  addReference(range) {
    const state = Store.get()
    const selection = state.selection
    if (!selection) {
      note('先在结构或材料里选中一个对象，再引用到对话。', 'error')
      return
    }
    const ref = {
      objectId: selection.objectId ?? null,
      objectLabel: selection.label ?? selection.objectId ?? '对象',
      versionId: selection.versionId ?? state.project?.revision ?? null,
      surface: state.surface,
      range: range ?? null,
    }
    const refs = state.assistantRefs.slice(0, 31)
    refs.push(ref)
    Store.set((current) => ({ ...current, assistantRefs: refs, assistantOpen: true, rightTab: 'assistant' }))
  },

  removeReference(index) {
    Store.set((state) => ({ ...state, assistantRefs: state.assistantRefs.filter((_, i) => i !== index) }))
  },

  async sendAssistant() {
    const state = Store.get()
    const text = String(state.assistantDraft ?? '').trim()
    if (text.length === 0) return
    if (!state.projectId) return
    Store.set((current) => ({ ...current, busy: 'assistant' }))
    try {
      const result = await Api.postAssistant({
        projectId: state.projectId,
        text,
        refs: state.assistantRefs,
      })
      Store.set((current) => ({
        ...current,
        busy: null,
        assistantDraft: '',
        assistantRefs: [],
        project: current.project
          ? { ...current.project, assistant: { messages: result.messages, nextSeq: (result.messages?.length ?? 0) + 1 } }
          : current.project,
      }))
    } catch (error) {
      reportError('保存消息失败', error)
    }
  },

  async uploadFiles(fileList) {
    const projectId = Store.get().projectId
    if (!projectId) return
    const files = Array.from(fileList ?? [])
    if (files.length === 0) return
    Store.set((state) => ({ ...state, busy: 'upload', upload: { done: 0, total: files.length, error: null } }))
    try {
      for (const file of files) {
        const dataBase64 = await readFileBase64(file)
        const added = await Api.addMaterial({ projectId, filename: file.name, dataBase64, sourceLabel: 'user-upload' })
        const materialId = added?.material?.materialId
        if (typeof materialId === 'string' && String(file.type ?? '').startsWith('image/')) {
          // Session-only object URL: an honest in-session preview. Persistent thumbnails belong to C12.
          Actions._previews[materialId] = URL.createObjectURL(file)
        }
        Store.set((state) => ({ ...state, upload: { ...(state.upload ?? {}), done: (state.upload?.done ?? 0) + 1 } }))
      }
      Store.set((state) => ({ ...state, busy: null, upload: null }))
      note(files.length === 1 ? `已添加材料「${files[0].name}」` : `已添加 ${files.length} 个材料`)
      await Actions.refreshProject()
    } catch (error) {
      Store.set((state) => ({ ...state, busy: null, upload: null }))
      reportError('添加材料失败', error)
    }
  },

  async recordUse(materialId, userText) {
    const projectId = Store.get().projectId
    if (!projectId) return
    try {
      await Api.recordMaterialUse({ projectId, materialId, userText })
      note('已记录材料用途')
      await Actions.refreshProject()
    } catch (error) {
      reportError('记录用途失败', error)
    }
  },

  async refreshProject() {
    const projectId = Store.get().projectId
    if (!projectId) return
    try {
      const project = await Api.openProject(projectId)
      Store.set((state) => ({ ...state, project }))
    } catch (error) {
      reportError('刷新项目失败', error)
    }
  },

  loadEvents() {
    const projectId = Store.get().projectId
    if (!projectId) return
    Api.events(projectId, 50)
      .then((data) => Store.set((state) => ({ ...state, events: data.events ?? [] })))
      .catch(() => Store.set((state) => ({ ...state, events: [] })))
  },

  /** Save the C10 work position (real "回到上次位置") plus UI-only state. Debounced. */
  savePositionSoon() {
    const state = Store.get()
    if (!state.projectId) return
    Store.set((current) => ({ ...current, saveState: 'saving' }))
    if (Actions._positionTimer) clearTimeout(Actions._positionTimer)
    Actions._positionTimer = setTimeout(() => { Actions.savePositionNow() }, 600)
  },

  async savePositionNow() {
    const state = Store.get()
    if (!state.projectId) return
    if (Actions._positionTimer) {
      clearTimeout(Actions._positionTimer)
      Actions._positionTimer = null
    }
    try {
      const result = await Api.savePosition({
        projectId: state.projectId,
        position: {
          workSurface: state.surface,
          selectedObjectId: state.selection?.objectId ?? null,
          playheadFrame: state.playhead ?? 0,
          panelState: { rightTab: state.rightTab, assistantOpen: state.assistantOpen },
          assistantOpen: state.assistantOpen,
        },
      })
      Store.set((current) => ({ ...current, saveState: 'saved', lastSavedAt: result.savedAt ?? new Date().toISOString() }))
    } catch (error) {
      Store.set((current) => ({ ...current, saveState: 'error', toast: { message: `保存位置失败：${error.message}`, tone: 'error' } }))
    }
  },

  /** Editable creation brief: three explicitly separated sources, stored in the project's UI state. */
  setBrief(field, text) {
    Store.set((state) => {
      if (!state.project) return state
      const current = state.project.uiState?.brief
      const brief = typeof current === 'string'
        ? { user: current, source: '', ai: '' }
        : { user: '', source: '', ai: '', ...(current ?? {}) }
      brief[field] = String(text)
      return { ...state, project: { ...state.project, uiState: { ...(state.project.uiState ?? {}), brief } } }
    })
    Actions.saveUiStateSoon()
  },

  /** UI-only state: selected object label, surface, assistant state. */
  saveUiStateSoon() {
    const state = Store.get()
    if (!state.projectId) return
    if (Actions._uiTimer) clearTimeout(Actions._uiTimer)
    Actions._uiTimer = setTimeout(() => {
      const latest = Store.get()
      Api.saveUiState({
        projectId: latest.projectId,
        state: {
          surface: latest.surface,
          assistantOpen: latest.assistantOpen,
          selectedObjectId: latest.selection?.objectId ?? null,
          selectedObjectLabel: latest.selection?.label ?? null,
          rightTab: latest.rightTab,
          brief: latest.project?.uiState?.brief ?? '',
          playhead: latest.playhead ?? 0,
        },
      }).catch(() => {})
    }, 500)
  },
  async loadTools() {
    try {
      const tools = await Api.tools()
      Store.set((state) => ({ ...state, tools }))
    } catch (error) {
      Store.set((state) => ({ ...state, tools: { available: false, tools: [], note: error.message } }))
    }
  },

  async inspectTool(toolId) {
    try {
      const detail = await Api.inspectTool(toolId)
      Store.set((state) => ({ ...state, toolDetail: detail }))
    } catch (error) {
      reportError('读取工具详情失败', error)
    }
  },

  closeToolDetail() {
    Store.set((state) => ({ ...state, toolDetail: null }))
  },

  async loadPreferences() {
    try {
      const projectId = Store.get().projectId ?? undefined
      const preferences = await Api.preferences(projectId)
      Store.set((state) => ({ ...state, preferences }))
    } catch (error) {
      Store.set((state) => ({ ...state, toast: { message: `读取偏好失败：${error.message}`, tone: 'error' } }))
    }
  },

  async setPreference(key, value) {
    try {
      await Api.setPreference({ key, value })
      note('偏好已保存到全局默认值')
      await Actions.loadPreferences()
    } catch (error) {
      reportError('保存偏好失败', error)
    }
  },

  async loadEffects() {
    try {
      const effects = await Api.effects()
      Store.set((state) => ({ ...state, effects }))
    } catch (error) {
      Store.set((state) => ({ ...state, effects: { effects: [], note: error.message } }))
    }
  },

  async importCheck() {
    try {
      const result = await Api.importCheck()
      Store.set((state) => ({ ...state, modal: { kind: 'import', result } }))
    } catch (error) {
      reportError('读取导入说明失败', error)
    }
  },

  /** Apply a keyboard action from the pure mapping. */
  keyboard(action) {
    const state = Store.get()
    if (!state.projectId) return
    const frameStep = 1
    if (action === KEY_ACTIONS.PLAY_PAUSE) {
      Store.set((current) => ({ ...current, playing: !current.playing }))
      return
    }
    if (action === KEY_ACTIONS.FRAME_PREV || action === KEY_ACTIONS.FRAME_NEXT) {
      const delta = action === KEY_ACTIONS.FRAME_NEXT ? frameStep : -frameStep
      Store.set((current) => ({ ...current, playhead: Math.max(0, (current.playhead ?? 0) + delta) }))
      Actions.savePositionSoon()
      return
    }
    if (action === KEY_ACTIONS.JUMP_PREV_10 || action === KEY_ACTIONS.JUMP_NEXT_10) {
      const delta = action === KEY_ACTIONS.JUMP_NEXT_10 ? 10 : -10
      Store.set((current) => ({ ...current, playhead: Math.max(0, (current.playhead ?? 0) + delta) }))
      Actions.savePositionSoon()
      return
    }
    if (action === KEY_ACTIONS.GO_START) {
      Store.set((current) => ({ ...current, playhead: 0 }))
      Actions.savePositionSoon()
      return
    }
    if (action === KEY_ACTIONS.GO_END) {
      Store.set((current) => ({ ...current, playhead: state.project?.position?.playheadFrame ?? 0 }))
      return
    }
    if (action === KEY_ACTIONS.ESCAPE) {
      Store.set((current) => ({ ...current, modal: null, helpOpen: false, searchOpen: false, assistantOpen: false }))
      return
    }
    if (action === KEY_ACTIONS.MARK_IN || action === KEY_ACTIONS.MARK_OUT || action === KEY_ACTIONS.ADD_MARKER) {
      note('时间线与标记由 C12 接入；现在还没有真实时间对象可标记。', 'info')
      return
    }
    if (action === KEY_ACTIONS.UNDO || action === KEY_ACTIONS.REDO) {
      note('撤销/重做会作用于真实编辑对象；当前还没有可编辑合成对象。', 'info')
      return
    }
    if (action === KEY_ACTIONS.FIND) {
      Store.set((current) => ({ ...current, searchOpen: true }))
      return
    }
    if (action === KEY_ACTIONS.HELP) {
      Store.set((current) => ({ ...current, helpOpen: true }))
    }
  },
}

/** Shared mutable bits kept off the store because they are timers, not state. */
Actions._positionTimer = null
Actions._uiTimer = null
/** materialId → object URL, session only; a reload drops them rather than pretending a proxy exists. */
Actions._previews = {}
