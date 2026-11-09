/**
 * Workbench service: the Host-side surface the plugin's four entries talk to.
 *
 * This module owns NO project semantics of its own. Every project fact comes through the frozen
 * C10 facade (`core/project/index.js`), every tool fact through the C06 facade (`tools/index.js`).
 * What it adds is only the REST-shaped glue a browser half can call:
 *
 * - where the workbench's data lives (CT-00 §4: plugin data, user projects, settings, cache,
 *   external tools are separate trees);
 * - honest summaries built from real registry / position / recovery / preference / tool state;
 * - one plugin-local state file per project for UI-only facts (assistant open, selected object,
 *   drafts). Those are NOT project facts and never overwrite a C10 document.
 *
 * @module ui/host/service
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Clock, ValidationError, WorkbenchError, ErrorCode, writeJsonAtomic, readJson } from '../../base/index.js'
import {
  assertId,
  createRootPaths,
  ProjectPaths,
  listProjects,
  createProject,
  openProject,
  describeState,
  readMaterialsCatalog,
  addMaterial,
  recordUse,
  resolveAllPreferences,
  PREFERENCE_SPEC,
  setGlobalPreference,
  globalPreferencesPath,
  saveWorkPosition,
  readWorkPosition,
  inspectRecovery,
  readRecentEvents,
  PHASE_LABELS,
  EXECUTION_LABELS,
  MaterialKind,
  MaterialObservation,
  RightsStatus,
  PROJECT_CORE_INTERFACE_VERSION,
} from '../../core/project/index.js'
import { createToolKernel, TOOL_MANAGEMENT_INTERFACE_VERSION } from '../../tools/index.js'

/** The same 64 MiB ceiling C10 enforces for one material; kept here so the UI can warn first. */
const MATERIAL_LIMIT_BYTES = 64 * 1024 * 1024
/** Base64 inflates by ~4/3; this is the JSON body ceiling the router accepts. */
const MAX_BODY_BYTES = 96 * 1024 * 1024
/** How many projects get a live recovery read during bootstrap (each read touches a project dir). */
const RECOVERY_SAMPLE = 3

const MATERIAL_KIND_BY_EXTENSION = Object.freeze({
  '.png': MaterialKind.IMAGE, '.jpg': MaterialKind.IMAGE, '.jpeg': MaterialKind.IMAGE,
  '.webp': MaterialKind.IMAGE, '.gif': MaterialKind.IMAGE, '.avif': MaterialKind.IMAGE,
  '.mp4': MaterialKind.VIDEO, '.mov': MaterialKind.VIDEO, '.webm': MaterialKind.VIDEO,
  '.mkv': MaterialKind.VIDEO, '.m4v': MaterialKind.VIDEO,
  '.wav': MaterialKind.AUDIO, '.mp3': MaterialKind.AUDIO, '.flac': MaterialKind.AUDIO,
  '.aac': MaterialKind.AUDIO, '.m4a': MaterialKind.AUDIO, '.ogg': MaterialKind.AUDIO,
  '.txt': MaterialKind.TEXT, '.md': MaterialKind.TEXT, '.srt': MaterialKind.TEXT,
  '.json': MaterialKind.TEXT, '.csv': MaterialKind.TEXT,
  '.ttf': MaterialKind.FONT, '.otf': MaterialKind.FONT, '.woff': MaterialKind.FONT, '.woff2': MaterialKind.FONT,
  '.pdf': MaterialKind.DOCUMENT, '.docx': MaterialKind.DOCUMENT, '.doc': MaterialKind.DOCUMENT,
  '.pptx': MaterialKind.DOCUMENT, '.xlsx': MaterialKind.DOCUMENT,
})

/** Resolve the DSH home the same way the Host does, with an explicit override for tests. */
export function resolveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return path.resolve(explicit)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    return path.resolve(process.env.DSH_HOME)
  }
  return path.join(os.homedir(), '.dsh')
}

/**
 * Build one workbench service for a Host plugin instance.
 *
 * @param {object} [input]
 * @param {string} [input.home] DSH home override (tests / isolated verification)
 * @param {string} [input.dataRoot] workbench data root override
 * @param {Clock} [input.clock]
 * @param {object} [input.toolKernel] injected tool kernel (tests)
 */
export function createWorkbenchService(input = {}) {
  const home = resolveDshHome(input.home)
  const dataRoot = path.resolve(input.dataRoot ?? path.join(home, 'data', 'ai-video-workbench'))
  const projectsRoot = path.join(dataRoot, 'projects')
  const settingsDir = path.join(dataRoot, 'settings')
  const uiStateRoot = path.join(dataRoot, 'ui-state')
  const toolsRoot = path.join(home, 'tools', 'ai-video-workbench')
  const toolStateRoot = path.join(dataRoot, 'tools-state')
  const cacheRoot = path.join(home, 'cache', 'ai-video-workbench')
  const clock = input.clock ?? new Clock()

  fs.mkdirSync(projectsRoot, { recursive: true })
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.mkdirSync(uiStateRoot, { recursive: true })

  const globalPrefsPath = globalPreferencesPath(settingsDir)
  const rootPaths = createRootPaths(projectsRoot)

  let kernel = input.toolKernel ?? null
  let kernelError = null
  if (kernel === null) {
    try {
      kernel = createToolKernel({
        toolsRoot,
        stateRoot: toolStateRoot,
        pluginRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
        projectsRoot,
      })
    } catch (error) {
      // A broken tool tree must not take the workbench down: the tools page reports it as
      // unavailable instead of pretending tools are fine. The reason is kept for that report.
      kernel = null
      kernelError = String(error?.message ?? error)
    }
  }

  /** Read one project's plugin-local UI state, or null. */
  function readUiStateRaw(projectId) {
    const file = path.join(uiStateRoot, `${projectId}.json`)
    try {
      if (!fs.existsSync(file)) return null
      return readJson(file)
    } catch {
      return null
    }
  }

  /** Write plugin-local UI state atomically. Single UI writer per project (CT-02 §3). */
  function writeUiStateRaw(projectId, value) {
    const file = path.join(uiStateRoot, `${projectId}.json`)
    writeJsonAtomic(file, value)
    return value
  }

  function projectPathsOf(projectId) {
    return new ProjectPaths(projectsRoot, assertId(projectId, 'project', 'projectId'))
  }

  /** One registry row → what the project page needs, with nothing invented. */
  function summarizeRow(row) {
    const projectId = row.projectId
    let position = null
    try {
      const stored = readWorkPosition(path.join(projectsRoot, projectId))
      position = stored === null ? null : stored.position
    } catch {
      position = null
    }
    const ui = readUiStateRaw(projectId)
    const needsAttention =
      row.execution === 'needs-attention' || row.execution === 'failed' || row.execution === 'unknown'
    return {
      projectId,
      title: row.title,
      phase: row.phase,
      phaseLabel: PHASE_LABELS[row.phase] ?? row.phase,
      execution: row.execution,
      executionLabel: EXECUTION_LABELS[row.execution] ?? row.execution,
      origin: row.origin,
      series: row.series ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      needsAttention,
      lastPosition: position,
      ui: ui === null ? null : { surface: ui.surface ?? null, savedAt: ui.savedAt ?? null },
    }
  }

  /** Real waiting items only: registry execution states, recovery verdicts, missing tools, queued assistant drafts. */
  function collectWaiting(projects) {
    const items = []
    for (const project of projects.slice(0, 12)) {
      if (project.phase === 'archived' || project.phase === 'recycle-bin') continue
      if (project.execution === 'waiting-user') {
        items.push({
          kind: 'waiting-user', projectId: project.projectId, title: project.title,
          message: '项目停在等待你的决定：完成方案或方向选择后才能继续。',
          action: '打开项目',
        })
      } else if (project.needsAttention) {
        items.push({
          kind: 'needs-attention', projectId: project.projectId, title: project.title,
          message: `执行状态为「${project.executionLabel}」，需要先确认上次动作的真实结果。`,
          action: '打开项目检查',
        })
      }
    }
    for (const project of projects.slice(0, RECOVERY_SAMPLE)) {
      if (project.phase === 'archived' || project.phase === 'recycle-bin') continue
      try {
        const recovery = inspectRecovery({
          projectDir: path.join(projectsRoot, project.projectId),
          projectsRoot,
          projectId: project.projectId,
          materialCheck: (materials) => checkMaterials(project.projectId, materials),
          toolCheck: () => checkTools(),
          clock,
        })
        if (recovery.canContinue !== true) {
          items.push({
            kind: 'recovery', projectId: project.projectId, title: project.title,
            message: recovery.headline || '上次没有正常结束，需要检查后再继续。',
            action: '查看恢复差异',
            needsHandling: recovery.needsHandling.slice(0, 4),
          })
        }
      } catch {
        // A project that cannot be inspected is reported by its own entry, not as a fake waiting item.
      }
    }
    const tools = toolSummary()
    const missing = tools.tools.filter((tool) => tool.usable !== true)
    if (missing.length > 0) {
      items.push({
        kind: 'tool', title: '外部工具状态影响部分能力',
        message: `${missing.map((tool) => tool.displayName).slice(0, 3).join('、')} 当前不可用：预览、时长读取或导出会受限。`,
        action: '去工具页',
        toolIds: missing.map((tool) => tool.toolId),
      })
    }
    return items
  }

  function checkMaterials(projectId, materials) {
    const paths = projectPathsOf(projectId)
    return (materials ?? []).map((material) => {
      const available = paths.exists(material.storedRelativePath)
      return { id: material.materialId, available, code: available ? 'ok' : 'missing-file' }
    })
  }

  function checkTools() {
    if (kernel === null) return [{ name: '工具内核', available: false }]
    try {
      return kernel.listTools().map((tool) => ({
        name: tool.displayName,
        available: tool.usable === true,
      }))
    } catch {
      return [{ name: '工具内核', available: false }]
    }
  }

  function toolSummary() {
    if (kernel === null) {
      return {
        available: false, interfaceVersion: TOOL_MANAGEMENT_INTERFACE_VERSION,
        tools: [],
        note: `工具内核没有加载：${kernelError ?? '未提供原因'}。工具页只报告这一事实，不会把工具显示为可用。`,
      }
    }
    try {
      // `listTools()` is the frozen kernel listing; its fields are flattened, so the service maps
      // them into one shape the UI can render without guessing at two different surfaces.
      const tools = kernel.listTools().map((tool) => ({
        toolId: tool.toolId,
        displayName: tool.displayName,
        purpose: tool.purpose,
        supportClass: tool.supportClass,
        packId: tool.packId,
        status: tool.status,
        label: tool.label,
        userState: tool.userState,
        usable: tool.usable === true,
        statusReason: tool.reason ?? null,
        versions: {
          supported: tool.supportedVersions,
          installed: tool.installedVersion,
          detected: tool.detectedVersion,
        },
        license: {
          spdx: tool.license?.spdx ?? null,
          class: tool.license?.class ?? null,
          pluginMit: tool.pluginMit === true,
        },
      }))
      return {
        available: true,
        interfaceVersion: TOOL_MANAGEMENT_INTERFACE_VERSION,
        tools,
        note: null,
      }
    } catch (error) {
      return {
        available: false, interfaceVersion: TOOL_MANAGEMENT_INTERFACE_VERSION, tools: [],
        note: `工具目录读取失败：${error.message}`,
      }
    }
  }

  function preferenceSnapshot(projectId) {
    let projectPaths = null
    if (typeof projectId === 'string' && projectId.length > 0) {
      try {
        projectPaths = projectPathsOf(projectId)
      } catch {
        projectPaths = null
      }
    }
    return resolveAllPreferences({ globalPath: globalPrefsPath, projectPaths })
  }

  /** Preference output for the settings page: resolved values + the frozen spec (kinds, bounds, groups). */
  function preferenceSnapshot(projectId) {
    let projectPaths = null
    if (typeof projectId === 'string' && projectId.length > 0) {
      try {
        projectPaths = projectPathsOf(projectId)
      } catch {
        projectPaths = null
      }
    }
    const resolved = resolveAllPreferences({ globalPath: globalPrefsPath, projectPaths })
    return { ...resolved, spec: PREFERENCE_SPEC, projectScoped: projectPaths !== null }
  }

  function describeProject(projectId) {
    const opened = openProject({ projectsRoot, projectId, clock })
    const paths = opened.paths
    const materials = readMaterialsCatalog(paths, { clock })
    const storedPosition = readWorkPosition(paths.dir)
    const state = describeState({
      projectsRoot,
      projectId,
      confirmations: { confirmed: 0, total: 0 },
      clock,
    })
    const recovery = safeRecovery(projectId, paths)
    return {
      project: opened.project,
      revision: opened.revision,
      migrated: opened.migrated,
      state,
      paths: {
        projectsRoot,
        projectDir: paths.dir,
        projectFile: paths.projectFile(),
        sizeBytes: directorySize(paths.dir),
      },
      materials: {
        materials: materials.materials,
        uses: materials.uses,
        revision: materials.revision,
      },
      position: storedPosition === null ? null : storedPosition.position,
      recovery,
      preferences: preferenceSnapshot(projectId),
      uiState: readUiStateRaw(projectId),
      assistant: readAssistant(projectId),
    }
  }

  function safeRecovery(projectId, paths) {
    try {
      return inspectRecovery({
        projectDir: paths.dir,
        projectsRoot,
        projectId,
        materialCheck: (materials) => checkMaterials(projectId, materials),
        toolCheck: () => checkTools(),
        clock,
      })
    } catch (error) {
      return {
        canContinue: false,
        verdict: 'needs-handling',
        headline: `恢复检查没有完成：${error.message}`,
        needsHandling: [{ code: 'recovery-unavailable', message: error.message, action: '不要自动重试；先确认项目目录与文件是否可读' }],
        notRun: ['all'],
      }
    }
  }

  function directorySize(dir) {
    let total = 0
    const walk = (current) => {
      let entries
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) {
          try {
            total += fs.statSync(full).size
          } catch {
            // Unreadable bytes simply do not count; the number is a hint, not a contract.
          }
        }
      }
    }
    walk(dir)
    return total
  }

  function assistantFile(projectId) {
    return path.join(uiStateRoot, `${assertId(projectId, 'project')}.assistant.json`)
  }

  function readAssistant(projectId) {
    const file = assistantFile(projectId)
    try {
      if (!fs.existsSync(file)) return { messages: [], nextSeq: 1 }
      const stored = readJson(file)
      return {
        messages: Array.isArray(stored?.messages) ? stored.messages : [],
        nextSeq: Number(stored?.nextSeq ?? 1),
      }
    } catch {
      return { messages: [], nextSeq: 1 }
    }
  }

  function appendAssistant(projectId, message) {
    const current = readAssistant(projectId)
    const next = { ...current, messages: [...current.messages, message], nextSeq: current.nextSeq + 1 }
    writeJsonAtomic(assistantFile(projectId), next)
    return next
  }

  const interfaceVersions = Object.freeze({
    projectCore: PROJECT_CORE_INTERFACE_VERSION,
    toolManagement: TOOL_MANAGEMENT_INTERFACE_VERSION,
    workbenchService: '1.0.0',
  })

  return {
    roots: Object.freeze({ home, dataRoot, projectsRoot, settingsDir, uiStateRoot, toolsRoot, cacheRoot, globalPrefsPath }),
    interfaceVersions,
    clock,

    /** Everything the first screen needs, read from real state. */
    bootstrap() {
      const listed = listProjects({ projectsRoot, reconcile: true, includeArchived: true, includeTrashed: false, clock })
      const projects = listed.projects.map(summarizeRow)
      const latest = projects[0] ?? null
      const preferences = preferenceSnapshot(null)
      const tools = toolSummary()
      return {
        projects,
        skipped: listed.skipped,
        waiting: collectWaiting(projects),
        latest,
        preferences,
        tools,
        effects: { effects: [], note: '效果库由 C15（交付、项目包、效果与结项）提供；当前没有正式收录的效果。' },
        limits: {
          materialBytes: MATERIAL_LIMIT_BYTES,
          bodyBytes: MAX_BODY_BYTES,
          recoverySample: RECOVERY_SAMPLE,
        },
        roots: { projectsRoot, cacheRoot, settingsDir, toolsRoot },
        interfaceVersions,
      }
    },

    listProjects() {
      const listed = listProjects({ projectsRoot, reconcile: true, includeArchived: true, clock })
      return { projects: listed.projects.map(summarizeRow), skipped: listed.skipped }
    },

    createProject(body) {
      const title = String(body?.title ?? '').trim()
      const idea = String(body?.idea ?? '').trim()
      if (title.length === 0) throw new ValidationError('项目需要名称', { field: 'title' })
      const created = createProject({
        projectsRoot,
        title,
        coreGoal: idea,
        clock,
      })
      writeUiStateRaw(created.project.projectId, {
        surface: 'creation',
        assistantOpen: false,
        selectedObjectId: null,
        savedAt: clock.iso(),
      })
      return { project: summarizeRow({
        projectId: created.project.projectId,
        title: created.project.title,
        phase: created.project.phase,
        execution: created.project.execution,
        origin: created.project.origin,
        series: created.project.series,
        createdAt: created.project.createdAt,
        updatedAt: created.project.updatedAt,
      }) }
    },

    openProject(projectId) {
      return describeProject(projectId)
    },

    savePosition(body) {
      const projectId = assertId(body?.projectId, 'project')
      const paths = projectPathsOf(projectId)
      const position = body?.position ?? {}
      const saved = saveWorkPosition({
        projectDir: paths.dir,
        projectId,
        workSurface: typeof position.workSurface === 'string' ? position.workSurface : 'creation',
        selectedObjectId: typeof position.selectedObjectId === 'string' ? position.selectedObjectId : null,
        playheadFrame: Number.isFinite(position.playheadFrame) ? Math.max(0, Math.round(position.playheadFrame)) : 0,
        panelState: position.panelState ?? {},
        openDocument: typeof position.openDocument === 'string' ? position.openDocument : null,
        versionId: typeof position.versionId === 'string' ? position.versionId : null,
        clock,
      })
      const currentUi = readUiStateRaw(projectId) ?? {}
      writeUiStateRaw(projectId, {
        ...currentUi,
        surface: typeof position.workSurface === 'string' ? position.workSurface : currentUi.surface ?? 'creation',
        assistantOpen: position.assistantOpen === undefined ? currentUi.assistantOpen ?? false : position.assistantOpen === true,
        selectedObjectId: position.selectedObjectId ?? currentUi.selectedObjectId ?? null,
        savedAt: clock.iso(),
      })
      return { savedAt: saved.savedAt, revision: saved.positionRevision ?? null }
    },

    addMaterial(body) {
      const projectId = assertId(body?.projectId, 'project')
      const paths = projectPathsOf(projectId)
      const base64 = String(body?.dataBase64 ?? '')
      if (base64.length === 0) throw new ValidationError('材料内容为空', { field: 'dataBase64' })
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.length > MATERIAL_LIMIT_BYTES) {
        throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '材料超过 64 MiB，当前不接收', {
          details: { bytes: bytes.length, limit: MATERIAL_LIMIT_BYTES, field: 'file' },
        })
      }
      const originalFilename = String(body?.filename ?? 'material.bin')
      const extension = path.extname(originalFilename).toLowerCase()
      const kind = MATERIAL_KIND_BY_EXTENSION[extension] ?? MaterialKind.OTHER
      const added = addMaterial({
        projectPaths: paths,
        bytes,
        originalFilename,
        kind,
        sourceLabel: typeof body?.sourceLabel === 'string' ? body.sourceLabel : 'user-upload',
        observation: MaterialObservation.UNREAD,
        rightsStatus: RightsStatus.UNKNOWN,
        note: typeof body?.note === 'string' && body.note.length > 0 ? body.note : undefined,
        clock,
      })
      return { material: added.material, revision: added.revision }
    },

    recordMaterialUse(body) {
      const projectId = assertId(body?.projectId, 'project')
      const paths = projectPathsOf(projectId)
      const opened = openProject({ projectsRoot, projectId, clock })
      const userText = String(body?.userText ?? '').trim()
      if (userText.length === 0) throw new ValidationError('用途说明不能为空', { field: 'userText' })
      const recorded = recordUse({
        projectPaths: paths,
        materialId: body?.materialId,
        userText,
        // A real, stable marker of the project document that was read. C10 requires a non-empty
        // version string; using the document revision keeps it traceable instead of inventing "v1".
        projectVersion: `rev-${opened.revision.slice(0, 12)}`,
        clock,
      })
      return { use: recorded.use, revision: recorded.revision }
    },

    preferences(body) {
      return preferenceSnapshot(body?.projectId)
    },

    setPreference(body) {
      const key = String(body?.key ?? '')
      const result = setGlobalPreference({ key, value: body?.value, globalPath: globalPrefsPath, clock })
      return { key: result.key, value: result.value, revision: result.revision, scope: 'global' }
    },

    tools() {
      return toolSummary()
    },

    inspectTool(toolId) {
      if (kernel === null) {
        throw new WorkbenchError(ErrorCode.NOT_FOUND, '工具内核没有加载', { details: { action: '检查插件 Host 半与工具目录' } })
      }
      return kernel.inspectTool(toolId)
    },

    effects() {
      return { effects: [], note: '效果库由 C15 提供；当前没有正式收录的效果。' }
    },

    /** Project-package import is a C15 capability; the UI reports the gap instead of faking a check. */
    importCheck() {
      return {
        supported: false,
        reason: '完整可编辑项目包的检查与导入属 C15（交付、项目包、效果与结项）；本卡不伪造导入结果。',
      }
    },

    saveUiState(body) {
      const projectId = assertId(body?.projectId, 'project')
      const current = readUiStateRaw(projectId) ?? {}
      const next = {
        ...current,
        ...(body?.state ?? {}),
        savedAt: clock.iso(),
      }
      return writeUiStateRaw(projectId, next)
    },

    readUiState(projectId) {
      return readUiStateRaw(assertId(projectId, 'project'))
    },

    assistant(projectId) {
      return readAssistant(assertId(projectId, 'project'))
    },

    postAssistant(body) {
      const projectId = assertId(body?.projectId, 'project')
      const text = String(body?.text ?? '').trim()
      if (text.length === 0) throw new ValidationError('消息为空', { field: 'text' })
      const refs = Array.isArray(body?.refs) ? body.refs.slice(0, 32) : []
      const state = readAssistant(projectId)
      const message = {
        messageId: `msg_${String(state.nextSeq).padStart(4, '0')}`,
        at: clock.iso(),
        author: 'user',
        text,
        refs: refs.map((ref) => ({
          objectId: typeof ref?.objectId === 'string' ? ref.objectId : null,
          objectLabel: typeof ref?.objectLabel === 'string' ? ref.objectLabel : '',
          versionId: typeof ref?.versionId === 'string' ? ref.versionId : null,
          surface: typeof ref?.surface === 'string' ? ref.surface : null,
          range: ref?.range ?? null,
        })),
        status: 'queued-for-orchestration',
        note: '项目助手与连续制作由 C13 接入；这条消息和引用已真实保存，C13 接入后从这里继续，不会假装已经回答。',
      }
      const next = appendAssistant(projectId, message)
      return { message, messages: next.messages }
    },

    /** Real project events for the "重要决定可回到对象与版本" requirement. */
    events(projectId, limit = 50) {
      const opened = openProject({ projectsRoot, projectId, clock })
      return { events: readRecentEvents(opened.paths.dir, Math.max(1, Math.min(200, Number(limit) || 50))) }
    },
  }
}
