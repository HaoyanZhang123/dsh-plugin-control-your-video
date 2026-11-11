/* 由 ui/dev/build-client.mjs 生成；不要手改。 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-control-your-video",
  factory(require) {
    'use strict';
    var React = require('react');
    var module = { exports: {} };
    var exports = module.exports;
/* ---- client/model/timecode.js ---- */
/**
 * Timecode and frame arithmetic for the workbench UI.
 *
 * Frame counts are the only time authority the UI displays. Seconds are formatted only when a
 * human asked for seconds, so "45.0s" and "00:00:45:00" can never be confused (CT-04 §2).
 *
 * Pure functions only: no DOM, no Date, no locale-dependent formatting.
 *
 * @module ui/client/model/timecode
 */

const SUPPORTED_FPS = Object.freeze([24, 25, 30, 50, 60])
const DEFAULT_FPS = 25

/** @param {unknown} value @param {number} [fallback] */
function normalizeFps(value, fallback = DEFAULT_FPS) {
  const fps = Number(value)
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) return fallback
  return Math.round(fps)
}

/**
 * Round a frame number into the valid range and keep it an integer.
 * @param {unknown} frame
 * @param {number} [maxFrame]
 */
function clampFrame(frame, maxFrame) {
  const value = Number(frame)
  const safe = Number.isFinite(value) ? Math.round(value) : 0
  if (safe < 0) return 0
  if (Number.isFinite(maxFrame) && maxFrame >= 0) return Math.min(safe, Math.round(maxFrame))
  return safe
}

/**
 * Frame number → `HH:MM:SS:FF` (SMPTE-style, non-drop).
 * @param {number} frame
 * @param {number} fps
 */
function framesToTimecode(frame, fps = DEFAULT_FPS) {
  const rate = normalizeFps(fps)
  const total = clampFrame(frame)
  const frames = total % rate
  const totalSeconds = Math.floor(total / rate)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}:${pad(frames, 2)}`
}

/**
 * Parse `HH:MM:SS:FF`, `MM:SS:FF`, `SS:FF` or plain seconds (`12.5s`). Returns null when the
 * text cannot be read as time, because silently guessing would move the playhead somewhere real.
 * @param {string} text
 * @param {number} fps
 * @returns {{ frame: number, error: null } | { frame: 0, error: string }}
 */
function timecodeToFrames(text, fps = DEFAULT_FPS) {
  const rate = normalizeFps(fps)
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return { frame: 0, error: '时间码为空' }
  if (raw.endsWith('s') && !raw.includes(':')) {
    const seconds = Number(raw.slice(0, -1))
    if (!Number.isFinite(seconds) || seconds < 0) return { frame: 0, error: '秒数无法识别' }
    return { frame: Math.round(seconds * rate), error: null }
  }
  const parts = raw.split(':')
  if (parts.length > 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return { frame: 0, error: '时间码格式应为 HH:MM:SS:FF' }
  }
  const numbers = parts.map((part) => Number(part))
  while (numbers.length < 4) numbers.unshift(0)
  const [hours, minutes, seconds, frames] = numbers
  if (minutes > 59 || seconds > 59 || frames >= rate) {
    return { frame: 0, error: `分秒需小于 60，帧需小于 ${rate}` }
  }
  return { frame: ((hours * 60 + minutes) * 60 + seconds) * rate + frames, error: null }
}

/** Seconds (human) for a frame count, rounded to one decimal. */
function framesToSeconds(frame, fps = DEFAULT_FPS) {
  return Math.round((clampFrame(frame) / normalizeFps(fps)) * 10) / 10
}

/** `3.2s` / `45.0s` — deliberately not a timecode. */
function formatDuration(frame, fps = DEFAULT_FPS) {
  return `${framesToSeconds(frame, fps).toFixed(1)}s`
}

/** `00:00:12:08 / 00:00:45:00` */
function formatProgress(frame, total, fps) {
  return `${framesToTimecode(frame, fps)} / ${framesToTimecode(total, fps)}`
}

/** Step by frames, stopping at zero. */
function stepFrame(frame, delta, maxFrame) {
  return clampFrame(clampFrame(frame) + Math.round(Number(delta) || 0), maxFrame)
}

/** Percentage of a total, 0–100, one decimal; total 0 → 0. */
function percentOf(frame, total) {
  const t = Number(total)
  if (!Number.isFinite(t) || t <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((clampFrame(frame) / t) * 1000) / 10))
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}

/* ---- client/model/format.js ---- */
/**
 * Deterministic display formatting for the workbench.
 *
 * The UI keeps numbers honest: byte counts are rounded with a unit, dates are ISO facts rendered
 * in the viewer's locale, and "几秒前" is computed from an explicit `now` so tests can pin it.
 *
 * @module ui/client/model/format
 */

/** 0 B / 1.4 KB / 3.7 MB / 1.2 GB */
function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}

/** ISO → `2026-11-08 21:48` local; invalid → the raw text so an unknown value stays visible. */
function formatDateTime(iso) {
  const date = new Date(iso)
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return String(iso ?? '—')
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** ISO → `21:48` local. */
function formatTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Relative age with an explicit now (ms). `刚刚 / 3 分钟前 / 昨天 / 3 天前 / 具体日期`. */
function formatRelative(iso, now = Date.now()) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const diff = Math.max(0, now - date.getTime())
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return formatDateTime(iso).slice(0, 10)
}

/** `proj_9f3a…` → `9f3a…`; a short id is still unique enough to talk about. */
function shortId(id) {
  const text = String(id ?? '')
  const match = /^[a-z]+_([a-z0-9]+)$/i.exec(text)
  if (match) return match[1].slice(0, 8)
  return text.slice(0, 8)
}

/** Join non-empty parts with ` · `. */
function joinMeta(parts) {
  return (Array.isArray(parts) ? parts : []).filter((part) => typeof part === 'string' && part.length > 0).join(' · ')
}

/** `rev-1a2b3c4d5e6f` → `rev-1a2b3c`; long hashes stay traceable but fit a label. */
function shortRevision(revision) {
  const text = String(revision ?? '')
  if (text.length === 0) return '—'
  return text.length > 14 ? `${text.slice(0, 14)}…` : text
}

/** 45 seconds → `00:45`; used where a timecode's frame field would be noise. */
function formatMinuteSeconds(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

/** Truncate a filename in the middle, preserving the extension. */
function middleTruncate(text, max = 34) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const dot = value.lastIndexOf('.')
  const extension = dot > 0 && value.length - dot <= 8 ? value.slice(dot) : ''
  const head = Math.max(4, Math.floor((max - extension.length - 1) / 2))
  const tail = Math.max(4, max - extension.length - head - 1)
  return `${value.slice(0, head)}…${value.slice(-tail)}${extension}`
}

/* ---- client/model/layout.js ---- */
/**
 * Layout policy for the workbench inside one DSH main panel.
 *
 * The Host owns the left sidebar and right dock geometry; inside the panel the workbench decides
 * how structure / canvas / properties / timeline share the available width. This policy is pure so
 * the narrow-window behaviour can be tested without a browser (C11 card §4.6, UI 蓝图 §13.3).
 *
 * @module ui/client/model/layout
 */

const LAYOUT_BREAKPOINTS = Object.freeze({
  wide: 1280,
  medium: 1024,
  narrow: 860,
})

/**
 * @param {number} width available panel width in CSS pixels
 * @param {number} [height] available panel height, used only for timeline hints
 * @returns {{
 *   mode: 'wide'|'medium'|'narrow',
 *   showLeft: boolean,
 *   showRight: boolean,
 *   leftWidth: number,
 *   rightWidth: number,
 *   timelineHeight: number,
 *   canvasMinWidth: number,
 *   compactTopbar: boolean,
 *   note: string,
 * }}
 */
function resolveLayout(width, height) {
  const w = Number.isFinite(width) && width > 0 ? width : LAYOUT_BREAKPOINTS.wide
  const h = Number.isFinite(height) && height > 0 ? height : 900
  if (w >= LAYOUT_BREAKPOINTS.wide) {
    return {
      mode: 'wide',
      showLeft: true,
      showRight: true,
      leftWidth: Math.min(280, Math.max(232, Math.round(w * 0.17))),
      // The assistant shares this column; below ~320px its composer and message refs become unreadable.
      rightWidth: Math.min(380, Math.max(340, Math.round(w * 0.24))),
      timelineHeight: h < 760 ? 210 : 252,
      canvasMinWidth: 480,
      compactTopbar: false,
      note: '左结构 + 中画面 + 右属性 + 下时间',
    }
  }
  if (w >= LAYOUT_BREAKPOINTS.medium) {
    return {
      mode: 'medium',
      showLeft: true,
      showRight: true,
      leftWidth: 232,
      rightWidth: 300,
      timelineHeight: h < 720 ? 190 : 226,
      canvasMinWidth: 420,
      compactTopbar: true,
      note: '结构收窄，右侧保留常用属性',
    }
  }
  if (w >= LAYOUT_BREAKPOINTS.narrow) {
    return {
      mode: 'narrow',
      showLeft: false,
      showRight: true,
      leftWidth: 0,
      rightWidth: 272,
      timelineHeight: 200,
      canvasMinWidth: 320,
      compactTopbar: true,
      note: '窄窗口：结构收进抽屉，画面保持可操作',
    }
  }
  return {
    mode: 'narrow',
    showLeft: false,
    showRight: false,
    leftWidth: 0,
    rightWidth: 0,
    timelineHeight: 180,
    canvasMinWidth: 280,
    compactTopbar: true,
    note: '很窄：左右都收进抽屉，中央画面优先',
  }
}

/**
 * Which surfaces/panels a given work form needs. Empty tracks/panels must be hidden, not drawn
 * (C11 card §4.4, UI 蓝图 §13.1).
 * @param {object} form
 * @param {boolean} [form.hasNarration]
 * @param {boolean} [form.hasSubtitles]
 * @param {boolean} [form.hasSound]
 * @param {boolean} [form.hasVisual]
 */
function resolveSurfaceVisibility(form = {}) {
  return {
    narration: form.hasNarration === true,
    subtitles: form.hasSubtitles === true,
    sound: form.hasSound === true,
    visual: form.hasVisual !== false,
    markers: true,
    transitions: form.hasTransitions === true,
  }
}

/** Fit a 16:9 canvas inside a stage box without upscaling past 1:1 of the panel. */
function fitCanvas(stageWidth, stageHeight, aspect = 16 / 9, padding = 24) {
  const maxW = Math.max(80, Number(stageWidth) - padding * 2)
  const maxH = Math.max(45, Number(stageHeight) - padding * 2)
  const byWidth = { width: maxW, height: maxW / aspect }
  const byHeight = { width: maxH * aspect, height: maxH }
  const chosen = byWidth.height <= byHeight.height ? byWidth : byHeight
  return {
    width: Math.max(1, Math.round(chosen.width)),
    height: Math.max(1, Math.round(chosen.height)),
    letterboxX: Math.round((maxW - chosen.width) / 2),
    letterboxY: Math.round((maxH - chosen.height) / 2),
  }
}

/* ---- client/model/keyboard.js ---- */
/**
 * Keyboard policy for the workbench panel.
 *
 * The mapping is a pure function so it can be tested without a browser, and so a future change is
 * visible as a data change rather than hidden inside an event handler (C11 card §4.6, §6.7).
 *
 * Two rules matter more than the keys themselves:
 * - typing always wins: while the user is in an input/textarea/contenteditable, ordinary keys are
 *   not stolen (only Escape is offered, because leaving a temporary area must always work);
 * - every action names whether it must preventDefault, so Space never scrolls the panel by accident.
 *
 * @module ui/client/model/keyboard
 */

/** Keys the workbench owns. Kept as data so help text and tests read the same table. */
const KEY_ACTIONS = Object.freeze({
  PLAY_PAUSE: 'play-pause',
  FRAME_PREV: 'frame-prev',
  FRAME_NEXT: 'frame-next',
  JUMP_PREV_10: 'jump-prev-10',
  JUMP_NEXT_10: 'jump-next-10',
  GO_START: 'go-start',
  GO_END: 'go-end',
  MARK_IN: 'mark-in',
  MARK_OUT: 'mark-out',
  ADD_MARKER: 'add-marker',
  UNDO: 'undo',
  REDO: 'redo',
  FIND: 'find',
  DELETE_SELECTION: 'delete-selection',
  ESCAPE: 'escape',
  HELP: 'help',
  SAVE: 'save',
})

/** Human-readable shortcut list for the help overlay. */
const SHORTCUT_HELP = Object.freeze([
  { keys: 'Space', action: '播放 / 暂停' },
  { keys: '← / →', action: '逐帧' },
  { keys: 'Shift + ← / →', action: '10 帧' },
  { keys: 'Home / End', action: '到开头 / 结尾' },
  { keys: 'I / O', action: '设入点 / 出点' },
  { keys: 'M', action: '加标记' },
  { keys: 'Ctrl + Z / Ctrl + Shift + Z', action: '撤销 / 重做' },
  { keys: 'Ctrl + F', action: '查找' },
  { keys: 'Delete', action: '删除所选对象' },
  { keys: 'Esc', action: '关闭当前临时区域' },
  { keys: '?', action: '显示快捷键' },
])

/**
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean }} event
 * @param {{ typing?: boolean, composing?: boolean, hasSelection?: boolean }} [context]
 * @returns {{ action: string | null, preventDefault: boolean }}
 */
function resolveKeyAction(event, context = {}) {
  const key = String(event?.key ?? '')
  const ctrl = event?.ctrlKey === true || event?.metaKey === true
  const shift = event?.shiftKey === true
  const typing = context.typing === true

  if (context.composing === true) return { action: null, preventDefault: false }
  if (typing && key !== 'Escape') return { action: null, preventDefault: false }
  if (key === 'Escape') return { action: KEY_ACTIONS.ESCAPE, preventDefault: false }

  if (ctrl && (key === 'z' || key === 'Z')) {
    return { action: shift ? KEY_ACTIONS.REDO : KEY_ACTIONS.UNDO, preventDefault: true }
  }
  if (ctrl && (key === 'y' || key === 'Y')) return { action: KEY_ACTIONS.REDO, preventDefault: true }
  if (ctrl && (key === 'f' || key === 'F')) return { action: KEY_ACTIONS.FIND, preventDefault: true }
  if (ctrl && (key === 's' || key === 'S')) return { action: KEY_ACTIONS.SAVE, preventDefault: true }
  if (ctrl || event?.altKey === true) return { action: null, preventDefault: false }

  switch (key) {
    case ' ':
    case 'Spacebar':
      return { action: KEY_ACTIONS.PLAY_PAUSE, preventDefault: true }
    case 'ArrowLeft':
      return shift
        ? { action: KEY_ACTIONS.JUMP_PREV_10, preventDefault: true }
        : { action: KEY_ACTIONS.FRAME_PREV, preventDefault: true }
    case 'ArrowRight':
      return shift
        ? { action: KEY_ACTIONS.JUMP_NEXT_10, preventDefault: true }
        : { action: KEY_ACTIONS.FRAME_NEXT, preventDefault: true }
    case 'Home':
      return { action: KEY_ACTIONS.GO_START, preventDefault: true }
    case 'End':
      return { action: KEY_ACTIONS.GO_END, preventDefault: true }
    case 'i':
    case 'I':
      return { action: KEY_ACTIONS.MARK_IN, preventDefault: true }
    case 'o':
    case 'O':
      return { action: KEY_ACTIONS.MARK_OUT, preventDefault: true }
    case 'm':
    case 'M':
      return { action: KEY_ACTIONS.ADD_MARKER, preventDefault: true }
    case '?':
      return { action: KEY_ACTIONS.HELP, preventDefault: true }
    case 'Delete':
    case 'Backspace':
      return context.hasSelection === true
        ? { action: KEY_ACTIONS.DELETE_SELECTION, preventDefault: true }
        : { action: null, preventDefault: false }
    default:
      return { action: null, preventDefault: false }
  }
}

/** Whether an element is a text-entry target. Kept tolerant of missing DOMs for unit tests. */
function isTypingTarget(element) {
  if (element === null || element === undefined) return false
  const tag = String(element.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (element.isContentEditable === true) return true
  return element.getAttribute?.('role') === 'textbox'
}

/* ---- client/model/search.js ---- */
/**
 * Project search: the same matcher the project page uses for "名称、内容、状态、时间或标签".
 *
 * Pure and deterministic. A query with several words requires all of them, each matching somewhere
 * in the project's searchable text; ranking prefers a title prefix so typing "键" puts the project
 * actually named 键… above one whose status merely contains the character.
 *
 * @module ui/client/model/search
 */

/**
 * Text a project can be found by. Labels are included because a user who types "暂停" should find
 * the paused project, not be told only titles are searchable.
 * @param {object} project
 */
function projectSearchText(project) {
  const parts = [
    project?.title,
    project?.phaseLabel,
    project?.executionLabel,
    project?.seriesLabel,
    project?.origin,
    ...(Array.isArray(project?.tags) ? project.tags : []),
  ]
  return normalize(parts.filter((part) => typeof part === 'string' && part.length > 0).join(' '))
}

/** Lowercase, full-width spaces folded, repeated whitespace collapsed. */
function normalize(text) {
  return String(text ?? '')
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {object[]} projects
 * @param {string} query
 * @returns {object[]} matching projects, best first; original order preserved on ties
 */
function searchProjects(projects, query) {
  const list = Array.isArray(projects) ? projects.filter(Boolean) : []
  const words = normalize(query).split(' ').filter((word) => word.length > 0)
  if (words.length === 0) return list.slice()

  const scored = []
  list.forEach((project, index) => {
    const text = projectSearchText(project)
    const title = normalize(project.title)
    let score = 0
    for (const word of words) {
      if (!text.includes(word)) return
      if (title.startsWith(word)) score += 6
      else if (title.includes(word)) score += 4
      else if (text.includes(word)) score += 1
    }
    // Recent projects win ties: updatedAt is an ISO string, so string compare is chronological.
    scored.push({ project, score, index, updatedAt: String(project.updatedAt ?? '') })
  })
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt)
    return a.index - b.index
  })
  return scored.map((row) => row.project)
}

/**
 * Group projects by the phase the Host reports, keeping a stable display order.
 * @param {object[]} projects
 * @returns {Array<{ phase: string, label: string, projects: object[] }>}
 */
function groupByPhase(projects) {
  const order = ['intake', 'aligning', 'ready-for-production', 'producing', 'initial-review', 'finalizing', 'completed', 'archived', 'recycle-bin']
  const groups = new Map()
  for (const project of Array.isArray(projects) ? projects : []) {
    const phase = String(project?.phase ?? 'unknown')
    if (!groups.has(phase)) groups.set(phase, { phase, label: project?.phaseLabel ?? phase, projects: [] })
    groups.get(phase).projects.push(project)
  }
  return [...groups.values()].sort((a, b) => {
    const ai = order.indexOf(a.phase)
    const bi = order.indexOf(b.phase)
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
}

/* ---- client/model/labels.js ---- */
/**
 * User-facing words for every state the workbench renders.
 *
 * One table per concept, so two panels cannot invent two spellings for the same Host fact, and so
 * "未接入" can never be worded like "已完成" (C11 card §4.6, §6.10).
 *
 * @module ui/client/model/labels
 */

const SURFACE_LABELS = Object.freeze({ creation: '创作', work: '作品' })

const PHASE_FALLBACK = Object.freeze({
  intake: '接收输入',
  aligning: '对齐方向',
  'ready-for-production': '可以开始完整制作',
  producing: '制作中',
  'initial-review': '初版待审',
  finalizing: '定稿处理',
  completed: '已完成',
  archived: '已归档',
  'recycle-bin': '回收区',
})

const EXECUTION_FALLBACK = Object.freeze({
  idle: '空闲',
  'waiting-user': '等待你的决定',
  'waiting-authorization': '等待授权',
  running: '执行中',
  pausing: '正在暂停',
  paused: '已暂停',
  cancelling: '正在取消',
  cancelled: '已取消',
  failed: '失败',
  'needs-attention': '需要处理',
  unknown: '状态未知',
  done: '已完成',
})

const TOOL_STATE_LABELS = Object.freeze({
  usable: '可用',
  'not-installed': '未安装',
  'outdated': '需更新或不兼容',
  'installed-unverified': '已安装未验证',
  'verification-failed': '验证失败',
  unknown: '未检查',
})

const SAVE_STATE_LABELS = Object.freeze({
  idle: '未修改',
  saving: '正在保存…',
  saved: '已自动保存',
  error: '保存失败',
})

const RECOVERY_LABELS = Object.freeze({
  'can-continue': '可以继续',
  'needs-handling': '需要处理',
})

const ASSISTANT_STATUS_LABELS = Object.freeze({
  'queued-for-orchestration': '已保存，等待制作编排接入',
  answered: '已回复',
})

const MATERIAL_KIND_LABELS = Object.freeze({
  image: '图像',
  video: '视频',
  audio: '音频',
  text: '文本',
  font: '字体',
  document: '文档',
  other: '其他',
})

const MATERIAL_OBSERVATION_LABELS = Object.freeze({
  unread: '未读',
  unreadable: '不可读',
  'observed-partial': '未完整观察',
  'observed-full': '已完整观察',
  unknown: '观察状态未知',
})

const PREFERENCE_GROUP_LABELS = Object.freeze({
  creation: '创作方式',
  notification: '通知',
  'data-authorization': '数据与授权',
  storage: '存储',
  workspace: '工作区',
})

const PREFERENCE_LABELS = Object.freeze({
  'creation.aspect-ratio': '默认画幅',
  'creation.frame-rate': '默认帧率',
  'creation.style-preset': '默认风格',
  'notification.on-completion': '完成时通知',
  'notification.needs-attention': '需要处理时通知（不可关闭）',
  'notification.verbosity': '通知详细程度',
  'data-authorization.default': '默认数据授权',
  'data-authorization.external-service': '外部服务授权',
  'data-authorization.upload-materials': '材料提交授权',
  'storage.projects-root': '项目根目录',
  'storage.cache-retention-days': '缓存保留天数',
  'workspace.show-advanced-panels': '显示高级面板',
  'workspace.confirm-before-destructive': '危险动作前确认',
})

const WAITING_KIND_LABELS = Object.freeze({
  'waiting-user': '等待你的决定',
  'needs-attention': '需要处理',
  recovery: '恢复差异',
  tool: '缺工具',
  candidate: '必要候选',
})

/**
 * Capabilities this card does NOT implement. They are rendered as explicit gaps with the owning
 * card, never as disabled-but-looks-finished controls (C11 card §6.10).
 */
const INTEGRATION_GAPS = Object.freeze({
  composition: {
    owner: 'C12',
    title: '合成、渲染与对象映射',
    message: '真实画面、时间线和原生对象由 C12 接入；当前项目还没有可编辑的合成计划。',
  },
  orchestration: {
    owner: 'C13',
    title: '创作编排与连续制作',
    message: '方向、方案、早期单元和项目助手的回答由 C13 接入；当前只能保存你的要求与引用。',
  },
  review: {
    owner: 'C14',
    title: '审阅、候选与回退',
    message: '新旧对照、候选接受与局部回退由 C14 接入。',
  },
  delivery: {
    owner: 'C15',
    title: '交付、项目包与结项',
    message: '交付、项目包与结项的只读视图已接入；导出、确认与清理等可点操作仍未接入。',
  },
})

/** @param {string} phase */
function phaseLabel(phase) {
  return PHASE_FALLBACK[phase] ?? String(phase ?? '未知阶段')
}

/** @param {string} execution */
function executionLabel(execution) {
  return EXECUTION_FALLBACK[execution] ?? String(execution ?? '未知状态')
}

/** @param {string} status */
function toolStateLabel(status) {
  return TOOL_STATE_LABELS[status] ?? String(status ?? '未检查')
}

/** @param {string} kind */
function waitingKindLabel(kind) {
  return WAITING_KIND_LABELS[kind] ?? '需要你处理'
}

/** Whether an execution state should be shown with the "needs attention" tone. */
function isAttentionExecution(execution) {
  return execution === 'needs-attention' || execution === 'failed' || execution === 'unknown'
}

/* ---- client/api.js ---- */
/**
 * The only HTTP client the workbench UI uses.
 *
 * Same-origin fetch to the Host half's prefix. Every failure becomes an `ApiError` carrying the
 * Host's code, so the UI can branch on a code and show the Host's own words instead of inventing a
 * friendlier story (C11 card §4.6 "真实状态").
 *
 * @module ui/client/api
 */

const API_PREFIX = '/api/ai-video-workbench'

function ApiError(code, message, details) {
  this.name = 'ApiError'
  this.code = code
  this.message = message
  this.details = details
}
ApiError.prototype = Object.create(Error.prototype)
ApiError.prototype.constructor = ApiError

async function request(path, options = {}) {
  const init = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  let response
  try {
    response = await fetch(`${API_PREFIX}${path}`, init)
  } catch (cause) {
    throw new ApiError('NETWORK', '连不上插件 Host 半：页面还在，但数据接口不可用。', { cause: String(cause?.message ?? cause) })
  }
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (response.ok === true && payload?.ok === true) return payload.data
  const error = payload?.error ?? {}
  throw new ApiError(
    error.code ?? `HTTP_${response.status}`,
    error.message ?? `请求失败（HTTP ${response.status}）`,
    error.details ?? null,
  )
}

const Api = Object.freeze({
  bootstrap: () => request('/bootstrap'),
  projects: () => request('/projects'),
  createProject: (body) => request('/projects', { method: 'POST', body }),
  openProject: (projectId) => request('/projects/open', { method: 'POST', body: { projectId } }),
  savePosition: (body) => request('/projects/position', { method: 'POST', body }),
  addMaterial: (body) => request('/projects/materials', { method: 'POST', body }),
  recordMaterialUse: (body) => request('/projects/material-use', { method: 'POST', body }),
  saveUiState: (body) => request('/projects/ui-state', { method: 'POST', body }),
  events: (projectId, limit) => request(`/projects/events?projectId=${encodeURIComponent(projectId)}&limit=${Number(limit) || 50}`),
  preferences: (projectId) => request(projectId ? `/preferences?projectId=${encodeURIComponent(projectId)}` : '/preferences'),
  setPreference: (body) => request('/preferences', { method: 'POST', body }),
  tools: () => request('/tools'),
  inspectTool: (toolId) => request(`/tools/inspect?toolId=${encodeURIComponent(toolId)}`),
  effects: () => request('/effects'),
  importCheck: () => request('/import-check'),
  assistant: (projectId) => request(`/projects/assistant?projectId=${encodeURIComponent(projectId)}`),
  postAssistant: (body) => request('/projects/assistant', { method: 'POST', body }),
})

/* ---- client/store.js ---- */
/**
 * One tiny observable store for the whole workbench panel.
 *
 * Why not a framework: the Host hands every panel its own React root; a single store with
 * `subscribe` is enough for four pages, keeps state changes explicit, and lets the same reducer
 * logic be tested in Node. State is deliberately flat — nested per-project copies would drift from
 * the Host's answer.
 *
 * @module ui/client/store
 */

const INITIAL_STATE = Object.freeze({
  status: 'idle',
  error: null,
  bootstrap: null,
  panel: 'projects',
  view: 'home',
  projectId: null,
  project: null,
  surface: 'creation',
  selection: null,
  rightTab: 'properties',
  assistantOpen: false,
  assistantDraft: '',
  assistantRefs: [],
  saveState: 'idle',
  lastSavedAt: null,
  toast: null,
  modal: null,
  search: '',
  searchOpen: false,
  helpOpen: false,
  layout: resolveLayout(1400, 900),
  createDraft: { title: '', idea: '' },
  busy: null,
  upload: null,
  events: null,
  tools: null,
  toolDetail: null,
  preferences: null,
  effects: null,
  playhead: 0,
  playing: false,
  composition: { available: false, reason: 'C12 尚未接入' },
})

/**
 * @param {object} [initial]
 */
function createStore(initial = INITIAL_STATE) {
  let state = { ...initial }
  const listeners = new Set()

  function get() {
    return state
  }

  function set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch
    if (next === null || typeof next !== 'object') return state
    state = { ...state, ...next }
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // One broken subscriber must not stop the others from seeing the new state.
      }
    }
    return state
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { get, set, subscribe }
}

/** The single store this panel tree uses. Created once per module load. */
const Store = createStore()

/** Selector helpers kept next to the store so tests can use them without a DOM. */
function currentProject(state) {
  return state?.project ?? null
}

function selectionLabel(state) {
  const selection = state?.selection
  if (selection === null || selection === undefined) return ''
  return selection.label ?? selection.objectId ?? ''
}

/** Queue a toast; the view clears it after a timeout. */
function toast(state, message, tone = 'info') {
  return { ...state, toast: { message, tone, at: Date.now() } }
}

/* ---- client/styles.js ---- */
/**
 * Workbench visual language: the merged direction (light V4 / dark V1, unified blue system).
 *
 * Integration rules that are not cosmetic:
 * - the panel inherits the Host's dark flag (`body[data-ds-dark-theme]`) instead of owning a theme;
 * - the root type size follows `--dsh-content-font-size` when the Host publishes it;
 * - all colors live on `.avw-root` custom properties, so a future host-token mapping changes one
 *   block instead of every rule;
 * - the canvas keeps a neutral dark stage in both themes, because judging video on white lies.
 *
 * @module ui/client/styles
 */

const AVW_CSS = `
.avw-root{
  --avw-bg:#eef2f6;--avw-bg-deep:#e6ecf2;--avw-panel:#fff;--avw-panel-2:#f5f8fb;--avw-elev:#e9eff6;
  --avw-line:#dde5ee;--avw-line-strong:#c4d1df;--avw-text:#0e1720;--avw-text-2:#47576a;--avw-text-3:#7c8b9c;
  --avw-accent:#1f6feb;--avw-accent-weak:rgba(31,111,235,.1);--avw-accent-2:#b9781f;
  --avw-ok:#0f7b57;--avw-warn:#9a6516;--avw-danger:#bf3b31;
  --avw-sel:rgba(31,111,235,.1);--avw-hover:rgba(20,40,70,.05);
  --avw-radius:3px;--avw-radius-sm:2px;--avw-radius-lg:4px;
  --avw-shadow:0 12px 32px rgba(20,40,70,.14);
  --avw-mono:"Cascadia Mono","Consolas","SFMono-Regular",monospace;
  --avw-stage:#f2f6fa;--avw-grid:rgba(31,111,235,.05);--avw-track:#fbfdff;
  --avw-clip:#fff;--avw-clip-line:#c9d8e8;--avw-clip-text:#3c4d60;
  --avw-canvas-border:6px solid #fff;--avw-canvas-shadow:0 2px 10px rgba(20,40,70,.18),0 0 0 1px #cdd9e6;
  --avw-chip:#f7fafc;--avw-field:#fff;--avw-seg:#f2f6fa;--avw-seg-on:#fff;
  --avw-drawer:#fff;--avw-toast:#0e1720;--avw-toast-text:#f4f8fc;
  --avw-canvas-bg:#0b0e12;
  position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;
  background:var(--avw-bg);color:var(--avw-text);
  font-family:"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif;
  font-size:var(--dsh-content-font-size,13px);line-height:1.5;
  color-scheme:light;
}
body[data-ds-dark-theme] .avw-root{
  --avw-bg:#0b0c0e;--avw-bg-deep:#070809;--avw-panel:#111317;--avw-panel-2:#171a1f;--avw-elev:#1e2229;
  --avw-line:#23272e;--avw-line-strong:#343b45;--avw-text:#e9edf2;--avw-text-2:#98a3b0;--avw-text-3:#5c6672;
  --avw-accent:#41d1ff;--avw-accent-weak:rgba(65,209,255,.13);--avw-accent-2:#ffc761;
  --avw-ok:#43d787;--avw-warn:#f0b955;--avw-danger:#ff6b6b;
  --avw-sel:rgba(65,209,255,.16);--avw-hover:rgba(255,255,255,.05);
  --avw-shadow:0 18px 46px rgba(0,0,0,.55);
  --avw-stage:#0c0e11;--avw-grid:rgba(255,255,255,.035);--avw-track:#0c0e11;
  --avw-clip:linear-gradient(180deg,#1a1f26,#12161b);--avw-clip-line:#2d353f;--avw-clip-text:#98a3b0;
  --avw-canvas-border:1px solid #2c333c;--avw-canvas-shadow:0 22px 60px rgba(0,0,0,.65);
  --avw-chip:transparent;--avw-field:#0a0c0f;--avw-seg:#070809;--avw-seg-on:#1e2229;
  --avw-drawer:#0e1013;--avw-toast:#e9edf2;--avw-toast-text:#0b0c0e;
  color-scheme:dark;
}
.avw-root *{box-sizing:border-box}
.avw-root button{font:inherit;color:inherit;cursor:pointer}
.avw-root input,.avw-root textarea,.avw-root select{font:inherit;color:inherit}
.avw-root :focus-visible{outline:2px solid var(--avw-accent);outline-offset:2px}
.avw-root ::selection{background:var(--avw-accent-weak)}
.avw-root ::-webkit-scrollbar{width:8px;height:8px}
.avw-root ::-webkit-scrollbar-thumb{background:var(--avw-line-strong);border-radius:4px}
.avw-root ::-webkit-scrollbar-track{background:transparent}

/* ---------- top bar ---------- */
.avw-topbar{display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;flex:none;
  border-bottom:1px solid var(--avw-line);background:var(--avw-panel);}
.avw-title{display:flex;align-items:baseline;gap:7px;min-width:0}
.avw-title b{font-size:13.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px}
.avw-title em{font:10.5px/1 var(--avw-mono);color:var(--avw-text-3);font-style:normal}
.avw-hsep{width:1px;height:18px;background:var(--avw-line);flex:none}
.avw-grow{flex:1;min-width:0}
.avw-tabs-surface{display:flex;padding:2px;border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-bg-deep)}
.avw-tabs-surface button{padding:3px 11px;border:0;background:transparent;border-radius:var(--avw-radius-sm);
  color:var(--avw-text-3);font-size:12.5px}
.avw-tabs-surface button[aria-selected="true"]{background:var(--avw-seg-on);color:var(--avw-accent);box-shadow:0 0 0 1px var(--avw-line-strong) inset}

/* ---------- chips / buttons / fields ---------- */
.avw-chip{max-width:100%;overflow:hidden;text-overflow:ellipsis;display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:var(--avw-radius-sm);
  border:1px solid var(--avw-line-strong);background:var(--avw-chip);color:var(--avw-text-2);
  font:10.5px/1.5 var(--avw-mono);white-space:nowrap}
.avw-chip i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.avw-chip--ok{color:var(--avw-ok);border-color:color-mix(in srgb,var(--avw-ok) 38%,transparent)}
.avw-chip--warn{color:var(--avw-warn);border-color:color-mix(in srgb,var(--avw-warn) 36%,transparent)}
.avw-chip--danger{color:var(--avw-danger);border-color:color-mix(in srgb,var(--avw-danger) 36%,transparent)}
.avw-chip--accent{color:var(--avw-accent);border-color:color-mix(in srgb,var(--avw-accent) 36%,transparent)}
.avw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 11px;
  border:1px solid var(--avw-line-strong);border-radius:var(--avw-radius);background:var(--avw-panel);
  color:var(--avw-text);font-size:12.5px;white-space:nowrap}
.avw-btn:hover{border-color:var(--avw-accent);color:var(--avw-accent)}
.avw-btn[disabled]{opacity:.45;cursor:not-allowed}
.avw-btn--primary{background:var(--avw-accent);border-color:var(--avw-accent);color:#fff;font-weight:600}
body[data-ds-dark-theme] .avw-btn--primary{color:#001015}
.avw-btn--primary:hover{color:#fff;filter:brightness(1.05)}
.avw-btn--ghost{border-color:transparent;background:transparent;color:var(--avw-text-2)}
.avw-btn--ghost:hover{background:var(--avw-hover);color:var(--avw-text)}
.avw-btn--sm{padding:3px 8px;font-size:11.5px}
.avw-btn--icon{padding:5px;width:28px;height:28px}
.avw-btn svg{width:14px;height:14px;flex:none}
.avw-field{display:flex;align-items:center;gap:6px;height:29px;padding:0 9px;
  border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-field);color:var(--avw-text-3)}
.avw-field input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--avw-text)}
.avw-field svg{width:14px;height:14px;flex:none}

/* ---------- home ---------- */
.avw-scroll{flex:1;min-height:0;overflow:auto}
.avw-home{padding:18px 22px 24px;max-width:1280px}
.avw-home-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.avw-home-head h1{margin:0;font-size:19px;font-weight:650;letter-spacing:.01em}
.avw-home-head p{margin:1px 0 0;color:var(--avw-text-3);font-size:11.5px}
.avw-home-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.85fr);gap:14px;align-items:start}
.avw-card{border:1px solid var(--avw-line);border-radius:var(--avw-radius-lg);background:var(--avw-panel)}
.avw-card__head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--avw-line)}
.avw-card__title{font-weight:600;font-size:12.5px}
.avw-card__note{color:var(--avw-text-3);font:10px/1.5 var(--avw-mono)}
.avw-card__body{padding:12px}
.avw-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 20px;color:var(--avw-text-3);text-align:center}
.avw-empty b{color:var(--avw-text-2);font-weight:600}
.avw-empty p{margin:0;max-width:460px;font-size:12px;line-height:1.7}
.avw-empty svg{width:28px;height:28px;opacity:.5}

/* continue card */
.avw-continue{display:grid;grid-template-columns:132px minmax(0,1fr) auto;gap:12px;align-items:center}
.avw-thumb{position:relative;aspect-ratio:16/9;border:1px solid var(--avw-line-strong);border-radius:var(--avw-radius);overflow:hidden;background:linear-gradient(150deg,#16202b,#0a0f15)}
.avw-thumb::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 120% at 20% 10%,rgba(255,255,255,.16),transparent 55%)}
.avw-thumb span{position:absolute;inset:0;display:grid;place-items:center;z-index:2;color:#fff}
.avw-thumb svg{width:16px;height:16px}
.avw-continue-meta{display:grid;gap:4px;min-width:0}
.avw-continue-meta b{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.avw-continue-meta small{color:var(--avw-text-3);font-size:11.5px}
.avw-continue-row{display:flex;gap:8px;flex-wrap:wrap;color:var(--avw-text-3);font-size:11px}
.avw-continue-row b{font-family:var(--avw-mono);font-weight:500;color:var(--avw-text-2)}

/* start composer */
.avw-start{margin-top:12px}
.avw-start-box{border:1px solid var(--avw-line-strong);border-radius:var(--avw-radius-lg);background:var(--avw-bg-deep);overflow:hidden}
.avw-start-box textarea{display:block;width:100%;min-height:84px;padding:11px 12px;border:0;outline:0;resize:vertical;background:transparent}
.avw-start-bar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 9px;border-top:1px solid var(--avw-line)}
.avw-start-hint{color:var(--avw-text-3);font-size:11px;margin-right:auto}
.avw-start-tpl{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.avw-tpl{padding:4px 9px;border:1px dashed var(--avw-line-strong);border-radius:var(--avw-radius-sm);
  background:transparent;color:var(--avw-text-2);font-size:11px}
.avw-tpl:hover{border-style:solid;border-color:var(--avw-accent);color:var(--avw-accent)}

/* todo */
.avw-todo{display:grid;gap:8px}
.avw-todo-item{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:start;
  padding:9px 10px;border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-panel-2)}
.avw-todo-item b{font-size:12.5px;font-weight:550}
.avw-todo-item p{margin:2px 0 0;color:var(--avw-text-3);font-size:11.5px;line-height:1.55}
.avw-todo-item svg{width:16px;height:16px;color:var(--avw-accent-2);margin-top:2px}
.avw-todo-actions{display:flex;gap:6px}

/* project rows */
.avw-rows{display:grid;gap:1px}
.avw-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;align-items:center;
  padding:9px 10px;border:1px solid transparent;border-radius:var(--avw-radius);text-align:left;background:transparent}
.avw-row:hover{background:var(--avw-panel-2);border-color:var(--avw-line)}
.avw-row-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:12.5px;font-weight:550}
.avw-row-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avw-row-meta{grid-column:1/2;display:flex;gap:10px;flex-wrap:wrap;color:var(--avw-text-3);font-size:10.5px}
.avw-row-meta em{font-style:normal;font-family:var(--avw-mono);color:var(--avw-text-2)}
.avw-row-side{justify-self:end;display:flex;gap:6px;align-items:center}

/* ---------- workbench ---------- */
.avw-ws{flex:1;display:grid;grid-template-rows:minmax(0,1fr) auto auto;min-height:0}
.avw-cols{display:grid;grid-template-columns:var(--avw-left,268px) minmax(0,1fr) var(--avw-right,308px);min-height:0}
.avw-col{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--avw-panel)}
.avw-col--left{border-right:1px solid var(--avw-line)}
.avw-col--right{border-left:1px solid var(--avw-line);overflow:hidden}
.avw-col--center{background:var(--avw-bg-deep)}
.avw-pane-head{display:flex;align-items:center;gap:6px;height:32px;padding:0 9px;flex:none;
  border-bottom:1px solid var(--avw-line);background:var(--avw-panel-2);color:var(--avw-text-3);
  font:10px/1 var(--avw-mono);letter-spacing:.09em}
.avw-pane-head b{font-family:inherit;font-size:11.5px;letter-spacing:.02em;color:var(--avw-text-2)}
.avw-pane-body{flex:1;min-height:0;overflow:auto;padding:6px}

/* tree */
.avw-tree{display:flex;flex-direction:column;gap:1px;font-size:12.5px}
.avw-tree-item{display:flex;align-items:center;gap:6px;padding:4px 7px;border-radius:var(--avw-radius-sm);
  border:1px solid transparent;background:transparent;color:var(--avw-text-2);text-align:left;white-space:nowrap}
.avw-tree-item:hover{background:var(--avw-hover);color:var(--avw-text)}
.avw-tree-item[aria-selected="true"]{background:var(--avw-sel);color:var(--avw-text);box-shadow:inset 2px 0 0 var(--avw-accent)}
.avw-tree-item svg{width:13px;height:13px;opacity:.7;flex:none}
.avw-tree-item .meta{margin-left:auto;color:var(--avw-text-3);font:10px var(--avw-mono)}
.avw-tree-group{margin-top:10px}
.avw-tree-group>.avw-pane-head{border:0;background:transparent;height:22px}
.avw-tree-depth1{padding-left:20px}
.avw-tree-depth2{padding-left:36px}

/* right tabs */
.avw-rtabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--avw-line);flex:none}
.avw-rtabs button{padding:5px 9px 6px;border:0;border-bottom:2px solid transparent;background:transparent;
  color:var(--avw-text-3);font:10.5px/1.4 var(--avw-mono);letter-spacing:.03em}
.avw-rtabs button[aria-selected="true"]{color:var(--avw-accent);border-bottom-color:var(--avw-accent)}
.avw-rtabs .badge{color:var(--avw-accent-2);margin-left:4px;font-size:9.5px}
.avw-objhead{display:flex;gap:8px;align-items:center;padding:9px 11px;border-bottom:1px solid var(--avw-line);background:var(--avw-panel-2)}
.avw-objhead i{display:grid;place-items:center;width:25px;height:25px;border:1px solid var(--avw-line-strong);
  border-radius:var(--avw-radius-sm);color:var(--avw-accent);font-style:normal;flex:none}
.avw-objhead b{display:block;font-size:12.5px;font-weight:600}
.avw-objhead small{display:block;color:var(--avw-text-3);font:10px var(--avw-mono)}
.avw-props{flex:1;min-height:0;overflow:auto}
.avw-prop{border-bottom:1px solid var(--avw-line);padding:9px 11px 11px}
.avw-prop h4{margin:0 0 7px;color:var(--avw-text-3);font:10px/1.4 var(--avw-mono);letter-spacing:.07em;font-weight:500}
.avw-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:7px;align-items:center;margin-bottom:6px}
.avw-kv label{color:var(--avw-text-3);font-size:11px}
.avw-kv .v{min-width:0;padding:4px 7px;border:1px solid var(--avw-input-border,var(--avw-line));border-radius:var(--avw-radius-sm);
  background:var(--avw-field);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avw-kv input,.avw-kv textarea{width:100%;padding:4px 7px;border:1px solid var(--avw-line);border-radius:var(--avw-radius-sm);
  background:var(--avw-field);outline:0}
.avw-kv textarea{min-height:56px;resize:vertical;white-space:pre-wrap}
.avw-mono{font-family:var(--avw-mono)}
.avw-hint{color:var(--avw-text-3);font-size:10.5px;line-height:1.6;margin:6px 0 0}

/* stage / canvas */
.avw-stage{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.avw-stage-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 9px;border-bottom:1px solid var(--avw-line);
  background:var(--avw-panel);color:var(--avw-text-3);font-size:11px;flex:none}
.avw-stage-bar .sep{width:1px;height:15px;background:var(--avw-line)}
.avw-canvas-wrap{flex:1;min-height:0;display:grid;place-items:center;padding:16px;overflow:hidden;
  background:linear-gradient(90deg,var(--avw-grid) 1px,transparent 1px) 0 0/40px 40px,
             linear-gradient(0deg,var(--avw-grid) 1px,transparent 1px) 0 0/40px 40px,var(--avw-bg-deep)}
.avw-canvas{position:relative;width:min(100%,900px);aspect-ratio:16/9;background:var(--avw-canvas-bg);
  border:var(--avw-canvas-border);border-radius:var(--avw-radius-sm);box-shadow:var(--avw-canvas-shadow);overflow:hidden}
.avw-canvas-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  padding:24px;color:#8b96a3;text-align:center}
.avw-canvas-empty b{color:#c7d2de;font-weight:600;font-size:13px}
.avw-canvas-empty p{margin:0;max-width:440px;font-size:11.5px;line-height:1.7;color:#7d8895}
.avw-safe{position:absolute;inset:5%;border:1px dashed rgba(255,255,255,.18);pointer-events:none}
.avw-safe::after{content:"安全框";position:absolute;top:-15px;left:0;color:rgba(255,255,255,.32);font:9px var(--avw-mono)}
.avw-selbox{position:absolute;border:1px solid var(--avw-accent);background:color-mix(in srgb,var(--avw-accent) 10%,transparent);border-radius:1px}
.avw-selbox::before,.avw-selbox::after{content:"";position:absolute;width:6px;height:6px;background:var(--avw-accent)}
.avw-selbox::before{left:-3px;top:-3px}.avw-selbox::after{right:-3px;bottom:-3px}
.avw-seltag{position:absolute;padding:1px 6px;border-radius:1px;background:var(--avw-accent);color:#fff;font-size:10px;white-space:nowrap}
.avw-transport{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 10px;border-top:1px solid var(--avw-line);
  background:var(--avw-panel);flex:none}
.avw-timecode{padding:4px 7px;border:1px solid var(--avw-line);border-radius:var(--avw-radius-sm);
  background:var(--avw-panel-2);font:11px var(--avw-mono);letter-spacing:.02em}
.avw-timecode small{color:var(--avw-text-3)}
.avw-transport .grow{flex:1}
.avw-disabled-reason{color:var(--avw-text-3);font-size:10.5px}

/* timeline */
.avw-timeline{height:var(--avw-timeline,252px);min-height:0;display:flex;flex-direction:column;flex:none;
  border-top:1px solid var(--avw-line);background:var(--avw-panel)}
.avw-timeline-head{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;flex:none;
  border-bottom:1px solid var(--avw-line);color:var(--avw-text-3);font:10px var(--avw-mono)}
.avw-timeline-head b{font-family:inherit;color:var(--avw-text-2);font-size:11px}
.avw-timeline-head .zoom{margin-left:auto;display:flex;align-items:center;gap:5px}
.avw-timeline-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  color:var(--avw-text-3);text-align:center;padding:18px}
.avw-timeline-empty b{color:var(--avw-text-2);font-size:12px;font-weight:600}
.avw-timeline-empty p{margin:0;max-width:520px;font-size:11.5px;line-height:1.7}
.avw-ruler{display:grid;grid-template-columns:118px minmax(0,1fr);height:24px;border-bottom:1px solid var(--avw-line);
  background:var(--avw-panel)}
.avw-ruler-corner{border-right:1px solid var(--avw-line)}
.avw-ruler-ticks{position:relative;font:9px/24px var(--avw-mono);color:var(--avw-text-3)}
.avw-ruler-ticks span{position:absolute;top:0;transform:translateX(-50%)}
.avw-track{display:grid;grid-template-columns:118px minmax(0,1fr);border-bottom:1px solid var(--avw-line)}
.avw-track-label{display:flex;align-items:center;gap:5px;padding:0 8px;border-right:1px solid var(--avw-line);
  background:var(--avw-panel);color:var(--avw-text-3);font-size:11px;white-space:nowrap;overflow:hidden}
.avw-track-lane{position:relative;height:28px;background:
  repeating-linear-gradient(90deg,transparent 0 79px,var(--avw-grid) 79px 80px),var(--avw-track)}
.avw-clip{position:absolute;top:3px;bottom:3px;display:flex;align-items:center;padding:0 6px;border-radius:1px;
  border:1px solid var(--avw-clip-line);background:var(--avw-clip);color:var(--avw-clip-text);
  font-size:10.5px;white-space:nowrap;overflow:hidden}
.avw-playhead{position:absolute;left:calc(118px + 18%);top:0;bottom:0;width:1px;background:var(--avw-accent)}
.avw-playhead::before{content:"";position:absolute;left:-4px;top:0;width:9px;height:7px;background:var(--avw-accent);clip-path:polygon(0 0,100% 0,50% 100%)}

/* status bar */
.avw-statusbar{display:flex;align-items:center;gap:12px;height:23px;padding:0 11px;flex:none;
  border-top:1px solid var(--avw-line);background:var(--avw-panel);color:var(--avw-text-3);font:9.5px var(--avw-mono)}
.avw-statusbar .grow{flex:1}

/* assistant drawer */
.avw-drawer{display:flex;flex-direction:column;min-height:0;min-width:0;height:100%;overflow:hidden;background:var(--avw-drawer)}
.avw-drawer>*{min-width:0}
.avw-drawer .avw-compose{min-width:0;overflow:hidden}
.avw-drawer .avw-compose textarea{max-width:100%}
.avw-chat{overflow-x:hidden}
.avw-chat{flex:1;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.avw-msg{padding:8px 10px;border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-panel-2)}
.avw-msg small{display:block;color:var(--avw-text-3);font:9.5px var(--avw-mono);margin-bottom:3px}
.avw-msg p{margin:0;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.avw-msg--pending{border-style:dashed}
.avw-refs{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.avw-compose{padding:9px;border-top:1px solid var(--avw-line);background:var(--avw-panel)}
.avw-compose textarea{display:block;width:100%;min-height:64px;padding:7px 8px;border:1px solid var(--avw-line);
  border-radius:var(--avw-radius);background:var(--avw-field);outline:0;resize:vertical;font-size:12px}
.avw-compose-bar{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap;justify-content:space-between}
.avw-compose-hint{flex:1 1 100%;order:3;min-width:0;margin-top:2px;color:var(--avw-text-3);font-size:10px;line-height:1.5}
.avw-compose-bar .avw-btn{flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.avw-refs{min-width:0;flex-wrap:wrap}
.avw-refs .avw-chip{max-width:100%}

/* gap card */
.avw-gap{padding:11px 12px;border:1px solid color-mix(in srgb,var(--avw-warn) 35%,transparent);
  background:color-mix(in srgb,var(--avw-warn) 6%,transparent);border-radius:var(--avw-radius);
  color:var(--avw-text);font-size:12px;line-height:1.65}
.avw-gap b{color:var(--avw-warn);font-weight:600}
.avw-gap small{display:block;margin-top:4px;color:var(--avw-text-3);font-size:10.5px}

/* modal / toast */
.avw-overlay{position:absolute;inset:0;z-index:20;display:grid;place-items:center;padding:24px;
  background:rgba(4,8,14,.45);backdrop-filter:blur(2px)}
.avw-modal{width:min(560px,100%);max-height:80%;overflow:auto;border:1px solid var(--avw-line-strong);
  border-radius:var(--avw-radius-lg);background:var(--avw-panel);box-shadow:var(--avw-shadow)}
.avw-modal-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--avw-line)}
.avw-modal-head b{font-size:13px}
.avw-modal-body{padding:14px}
.avw-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--avw-line)}
.avw-toast{position:absolute;left:50%;bottom:36px;transform:translateX(-50%);z-index:30;max-width:640px;
  padding:7px 12px;border-radius:var(--avw-radius);background:var(--avw-toast);color:var(--avw-toast-text);
  font-size:12px;box-shadow:var(--avw-shadow)}
.avw-toast--error{background:var(--avw-danger);color:#fff}

/* tools / preferences */
.avw-page{padding:16px 20px;max-width:1120px}
.avw-page h2{margin:0 0 3px;font-size:17px;font-weight:650}
.avw-page>p{margin:0 0 14px;color:var(--avw-text-3);font-size:11.5px}
.avw-tool{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:10px 11px;
  border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-panel);text-align:left}
.avw-tool:hover{border-color:var(--avw-line-strong)}
.avw-tool b{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px}
.avw-tool p{margin:2px 0 0;color:var(--avw-text-3);font-size:11.5px;line-height:1.55}
.avw-tool .side{justify-self:end;display:flex;align-items:center;gap:6px}
.avw-tools{display:grid;gap:8px}
.avw-pref-group{border:1px solid var(--avw-line);border-radius:var(--avw-radius-lg);background:var(--avw-panel);margin-bottom:10px;overflow:hidden}
.avw-pref-group h3{margin:0;padding:9px 11px;border-bottom:1px solid var(--avw-line);font-size:12.5px;font-weight:600;background:var(--avw-panel-2)}
.avw-pref-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,auto);gap:10px;align-items:center;padding:8px 11px;border-bottom:1px solid var(--avw-line)}
.avw-pref-row:last-child{border-bottom:0}
.avw-pref-row b{display:block;font-size:12px;font-weight:550}
.avw-pref-row small{color:var(--avw-text-3);font-size:10.5px}
.avw-pref-row input[type="text"],.avw-pref-row input[type="number"],.avw-pref-row select{width:100%;max-width:260px;padding:4px 7px;
  border:1px solid var(--avw-line);border-radius:var(--avw-radius-sm);background:var(--avw-field);outline:0;font-size:12px}
.avw-switch{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--avw-text-2)}

/* narrow overrides */
.avw-root[data-mode="narrow"] .avw-home-grid{grid-template-columns:1fr}
.avw-root[data-mode="narrow"] .avw-continue{grid-template-columns:110px minmax(0,1fr)}
.avw-root[data-mode="narrow"] .avw-continue .avw-btn{grid-column:1/-1}
@media (max-width: 900px){
  .avw-home-grid{grid-template-columns:1fr}
  .avw-continue{grid-template-columns:110px minmax(0,1fr)}
}

/* materials */
.avw-materials{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:9px}
.avw-material{display:grid;grid-template-columns:64px minmax(0,1fr);gap:9px;align-items:center;padding:8px;text-align:left;
  border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-panel-2);min-width:0}
.avw-material:hover{border-color:var(--avw-line-strong)}
.avw-material[aria-selected="true"]{border-color:var(--avw-accent);box-shadow:0 0 0 1px var(--avw-accent) inset;background:var(--avw-sel)}
.avw-material-plate{position:relative;aspect-ratio:4/3;border:1px solid var(--avw-line);border-radius:2px;overflow:hidden;
  display:grid;place-items:center;color:var(--avw-text-3);background:var(--avw-bg-deep)}
.avw-material-plate img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.avw-material-meta{display:grid;gap:2px;min-width:0}
.avw-material-meta b{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avw-material-meta small{color:var(--avw-text-3);font-size:10px;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* brief */
.avw-brief{border-left:2px solid var(--avw-line-strong);padding:2px 0 2px 9px}
.avw-brief--user{border-left-color:var(--avw-accent)}
.avw-brief--source{border-left-color:var(--avw-accent-2)}
.avw-brief--ai{border-left-style:dashed;border-left-color:var(--avw-text-3)}
.avw-brief-label{display:flex;align-items:baseline;gap:7px;margin-bottom:3px}
.avw-brief-label b{font-size:11.5px;color:var(--avw-text-2)}
.avw-brief-label span{color:var(--avw-text-3);font-size:10px}
.avw-brief textarea{width:100%;min-height:46px;padding:6px 8px;border:1px solid var(--avw-line);border-radius:2px;
  background:var(--avw-field);outline:0;resize:vertical;font-size:12px;line-height:1.6}
/* narrow drawers */
.avw-cols--narrow{grid-template-columns:minmax(0,1fr)}
.avw-drawer-left,.avw-drawer-right{position:absolute;top:0;bottom:0;z-index:8;width:min(320px,86%);display:flex;flex-direction:column;
  background:var(--avw-panel);border:1px solid var(--avw-line-strong);box-shadow:var(--avw-shadow)}
.avw-drawer-left{left:0;border-left:0}
.avw-drawer-right{right:0;border-right:0}
/* tool detail bits */
.avw-tool-meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:3px}
.avw-guidance{display:grid;gap:4px;padding:8px 9px;border:1px solid var(--avw-line);border-radius:2px;background:var(--avw-panel-2);
  font-size:11.5px;line-height:1.6;max-height:220px;overflow:auto}
.avw-guidance-line{white-space:pre-wrap;word-break:break-word}
.avw-start-title{font-family:inherit}

/* narrow topbar keeps the primary actions reachable instead of clipping them */
.avw-root[data-mode="narrow"] .avw-topbar{gap:6px;padding:0 8px;overflow-x:auto;scrollbar-width:none}
.avw-root[data-mode="narrow"] .avw-topbar::-webkit-scrollbar{display:none}
.avw-root[data-mode="narrow"] .avw-title b{max-width:150px}
.avw-root[data-mode="narrow"] .avw-topbar > .avw-chip{display:none}
.avw-root[data-mode="medium"] .avw-title b{max-width:220px}
.avw-root[data-mode="narrow"] .avw-home-head .field{width:100%}
.avw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`

/* ---- client/ui.js ---- */
/**
 * Small shared render helpers for the workbench client.
 *
 * There is no component library and no JSX: the client bundle is built by concatenation, so a tiny
 * `h` wrapper over `React.createElement` keeps every view plain JavaScript and easy to scan.
 *
 * @module ui/client/ui
 */

/** React.createElement shorthand. */
function h(type, props, ...children) {
  return React.createElement(type, props ?? null, ...children.filter((child) => child !== null && child !== undefined && child !== false))
}

const ICONS = Object.freeze({
  project: 'M4 6h16v13H4z M4 6l3-2h10l3 2 M9 3v3 M15 3v3',
  effects: 'M12 3l2.2 5.6L20 10l-4.6 3.1L17 19l-5-3-5 3 1.6-5.9L4 10l5.8-1.4z',
  tools: 'M14 6a4 4 0 1 0-3.6 4M10.4 10L5 15.4V19h3.6L14 13.6M14 6l4 4',
  prefs: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 2.6a7 7 0 0 0-1.7 1L5 5.6 3 9l2 1.6a7 7 0 0 0 0 2L3 14.2l2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.6h5l.3-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6a7 7 0 0 0 .1-1z',
  search: 'M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M16 16l4 4',
  plus: 'M12 5v14 M5 12h14',
  play: 'M8 5l11 7-11 7z',
  pause: 'M8 5v14 M16 5v14',
  prev: 'M6 5v14 M20 5l-9 7 9 7z',
  next: 'M6 5l9 7-9 7 M18 5v14',
  framePrev: 'M15 5l-8 7 8 7z',
  frameNext: 'M9 5l8 7-8 7z',
  upload: 'M12 16V5 M8 9l4-4 4 4 M4 16v3h16v-3',
  download: 'M12 4v11 M8 11l4 4 4-4 M4 19h16',
  check: 'M5 13l4 4L19 7',
  alert: 'M12 4l9 16H3z M12 10v4 M12 17v.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v6 M12 7v.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  film: 'M3 7h18v10H3z M7 7v10 M17 7v10 M3 12h18',
  image: 'M4 5h16v14H4z M4 15l4-4 4 4 3-3 5 5',
  audio: 'M9 18V6l10-2v12 M7 18a2 2 0 1 0 0 .1 M17 16a2 2 0 1 0 0 .1',
  text: 'M5 7V5h14v2 M12 5v14 M9 19h6',
  layers: 'M4 7l8-3 8 3-8 3z M4 12l8 3 8-3 M4 17l8 3 8-3',
  marker: 'M6 4v16 M6 5l10 4-10 4z',
  scissor: 'M6 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M6 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M9 8l11-4 M9 16l11 4 M14 12l6 0',
  assistant: 'M21 12a8 8 0 1 1-2.3-5.7 M21 4v5h-5',
  close: 'M6 6l12 12 M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  arrowRight: 'M5 12h14 M13 6l6 6-6 6',
  restore: 'M4 4v6h6 M5.5 13a7 7 0 1 0 1-5.5L4 10',
  external: 'M14 4h6v6 M20 4l-9 9 M20 14v6H4V4h6',
  badge: 'M12 3l2 4 4 .6-3 2.9.7 4.1-3.7-2-3.7 2 .7-4.1-3-2.9L10 7z',
})

function Icon(props) {
  const name = props?.name ?? 'info'
  const size = props?.size ?? 16
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: props?.strokeWidth ?? 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, h('path', { d: ICONS[name] ?? ICONS.info }))
}

function Btn(props) {
  const variant = props?.variant ?? 'default'
  const hasText = props?.children !== undefined && props?.children !== null && props?.children !== false
    && !(Array.isArray(props.children) && props.children.length === 0)
  // Icon-only sizing must NOT shrink an icon+label button into a 28px square.
  const className = ['avw-btn', variant === 'primary' ? 'avw-btn--primary' : '', variant === 'ghost' ? 'avw-btn--ghost' : '', props?.size === 'sm' ? 'avw-btn--sm' : '', props?.icon && !hasText ? 'avw-btn--icon' : '', props?.className ?? '']
    .filter(Boolean).join(' ')
  return h('button', {
    type: 'button',
    className,
    title: props?.title,
    disabled: props?.disabled === true,
    'aria-label': props?.ariaLabel,
    'aria-pressed': props?.['aria-pressed'],
    onClick: props?.onClick,
  }, props?.icon ? h(Icon, { name: props.icon, size: 14 }) : null, props?.children)
}

function Chip(props) {
  const tone = props?.tone ?? 'default'
  return h('span', { className: `avw-chip${tone === 'default' ? '' : ` avw-chip--${tone}`}`, title: props?.title },
    props?.dot ? h('i', null) : null, props?.children)
}

function Field(props) {
  return h('label', { className: 'avw-field' },
    props?.icon ? h(Icon, { name: props.icon, size: 14 }) : null,
    h('input', {
      type: props?.type ?? 'text',
      value: props?.value ?? '',
      placeholder: props?.placeholder ?? '',
      'aria-label': props?.ariaLabel ?? props?.placeholder,
      onChange: (event) => props?.onInput?.(event.target.value),
      onKeyDown: props?.onKeyDown,
    }))
}

function Seg(props) {
  return h('div', { className: 'avw-tabs-surface', role: 'tablist', 'aria-label': props?.label },
    (props?.items ?? []).map((item) => h('button', {
      key: item.id,
      type: 'button',
      role: 'tab',
      'aria-selected': String(item.id === props?.value),
      onClick: () => props?.onChange?.(item.id),
    }, item.label)))
}

function Modal(props) {
  if (props?.open !== true) return null
  return h('div', { className: 'avw-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': props?.title, onClick: (event) => { if (event.target === event.currentTarget) props?.onClose?.() } },
    h('div', { className: 'avw-modal' },
      h('div', { className: 'avw-modal-head' },
        h('b', null, props?.title ?? ''),
        h('span', { className: 'avw-grow' }),
        h(Btn, { variant: 'ghost', icon: 'close', onClick: props?.onClose, ariaLabel: '关闭' })),
      h('div', { className: 'avw-modal-body' }, props?.children),
      props?.footer ? h('div', { className: 'avw-modal-foot' }, props.footer) : null))
}

function Toast(props) {
  if (!props?.toast) return null
  return h('div', { className: `avw-toast${props.toast.tone === 'error' ? ' avw-toast--error' : ''}`, role: 'status' },
    props.toast.message)
}

function Empty(props) {
  return h('div', { className: 'avw-empty' },
    h(Icon, { name: props?.icon ?? 'info', size: 28 }),
    h('b', null, props?.title ?? ''),
    props?.message ? h('p', null, props.message) : null,
    props?.children)
}

function GapCard(props) {
  const gap = props?.gap ?? {}
  return h('div', { className: 'avw-gap' },
    h('b', null, `${gap.owner ?? ''} 尚未接入：${gap.title ?? ''}`),
    h('div', null, gap.message ?? ''),
    props?.action ? h('div', { style: { marginTop: '6px' } }, props.action) : null)
}

function KV(props) {
  return h('div', { className: 'avw-kv' },
    h('label', null, props?.label ?? ''),
    props?.children ?? h('div', { className: 'v', title: props?.title }, props?.value ?? '—'))
}

function SaveChip(props) {
  const state = props?.state ?? 'idle'
  const tone = state === 'error' ? 'danger' : state === 'saved' ? 'ok' : state === 'saving' ? 'warn' : 'default'
  const label = { idle: '未修改', saving: '正在保存…', saved: '已自动保存', error: '保存失败' }[state] ?? state
  return h(Chip, { tone, dot: state !== 'idle', title: props?.title }, label)
}

/* ---- client/domains/creation/view.js ---- */
/**
 * Creation domain view: a read-only projection of brief, directions, baseline, early units, preview
 * freshness and what the making agent actually saw and heard.
 *
 * This component is PURE on purpose: it takes a projection (or an error) and renders it, so the
 * same code can be mounted in the workbench shell and rendered in an evidence harness without a
 * second implementation. It reads `creation.projection`, the summary C13 publishes into the
 * project's event stream — it never invents data and never writes anything.
 *
 * @module ui/client/domains/creation/view
 */

/** Chip tone per brief bucket, matching the design system's existing tones. */
const BUCKET_TONE = Object.freeze({ user: 'accent', source: 'warn', ai: 'ok', unknown: 'danger' })

/** Human label per brief bucket. */
const BUCKET_LABEL = Object.freeze({ user: '用户要求', source: '来源主张', ai: 'AI 推断', unknown: '未知' })

/** Plan item state label. */
const ITEM_STATE_LABEL = Object.freeze({ undecided: '未定', decided: '已定', 'ai-allowed': 'AI 可自主' })

/**
 * One section frame that keeps the card rhythm of the rest of the workbench.
 * @param {{title: string, note?: string, children?: any}} props
 */
function DomainSection(props) {
  return h('section', { className: 'avw-card', style: { marginBottom: '10px' } },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, props.title),
      props.note ? h('span', { className: 'avw-card__note' }, props.note) : null,
      h('span', { className: 'avw-grow' })),
    h('div', { className: 'avw-card__body', style: { display: 'grid', gap: '6px' } }, props.children))
}

/** @param {{text: string, tone?: string}} props */
function DomainChip(props) {
  return h('span', { className: `avw-chip${props.tone ? ` avw-chip--${props.tone}` : ''}` }, props.text)
}

/**
 * One key/value row in the design system's own two-column form (`.avw-kv`), so a long list reads
 * like the rest of the panel instead of a stack of floating boxes.
 * @param {{label: string, tone?: string, children?: any}} props
 */
function DomainKV(props) {
  return h('div', { className: 'avw-kv' },
    h('label', null,
      props.tone ? h(DomainChip, { text: props.label, tone: props.tone }) : props.label),
    h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, props.children))
}

/** @param {{entries: any[]}} props */
function BriefBucket(props) {
  const entry = props.entries ?? []
  return h('div', { className: 'avw-brief' },
    h('div', { className: 'avw-brief-label' },
      h('b', null, entry.label),
      h(DomainChip, { text: String(entry.count ?? 0), tone: BUCKET_TONE[entry.key] })),
    entry.items.length === 0
      ? h('span', { className: 'avw-hint' }, '还没有这一类的条目')
      : entry.items.map((item, index) => h('span', { key: `${entry.key}-${index}`, className: 'avw-hint' }, `· ${item.text}`)))
}

/**
 * The whole domain view.
 *
 * @param {object} props
 * @param {any} [props.projection] the newest `creation.projection` payload
 * @param {string} [props.error] why the projection could not be read
 * @param {boolean} [props.loading]
 * @param {string} [props.notice] a standing note, e.g. "只读投影：数据来自项目事件流"
 */
function CreationDomainView(props) {
  const projection = props.projection ?? null
  const header = h('div', { className: 'avw-card__head' },
    h('span', { className: 'avw-card__title' }, '创建领域视图'),
    h(DomainChip, { text: '只读', tone: 'accent' }),
    h('span', { className: 'avw-grow' }),
    h('span', { className: 'avw-card__note' }, projection === null ? '等待投影' : `来源：项目事件 · ${projection.generatedAt}`))

  if (props.loading === true) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' }, h('span', { className: 'avw-hint' }, '正在读取项目事件…')))
  }
  if (typeof props.error === 'string' && props.error.length > 0) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h('span', { className: 'avw-chip avw-chip--warn' }, '需要处理'),
        h('span', { className: 'avw-hint' }, props.error)))
  }
  if (projection === null) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h('span', { className: 'avw-hint' }, '这个项目还没有编排投影。投影由创作编排在事实变化后发布，宿主不会凭空造一份。'),
        props.notice ? h('span', { className: 'avw-hint' }, props.notice) : null))
  }

  const brief = projection.brief ?? { counts: {} }
  const buckets = ['user', 'source', 'ai', 'unknown'].map((key) => ({
    key,
    label: BUCKET_LABEL[key],
    count: brief.counts?.[key] ?? 0,
    items: brief[key] ?? [],
  }))
  const baseline = projection.baseline ?? { items: [], blockers: [] }
  const units = projection.units ?? { list: [], complete: 0, incomplete: 0 }
  const preview = projection.preview ?? null
  const vista = projection.vista ?? { executed: 0, total: 0 }
  const ai = projection.ai ?? { saw: false, heard: 'not-available' }

  return h('div', { className: 'avw-creation-domain' },
    h(DomainSection, { title: '可编辑简报（只读投影）', note: `${brief.counts?.user ?? 0} 条用户要求` },
      buckets.map((bucket) => h(BriefBucket, { key: bucket.key, entries: bucket }))),

    h(DomainSection, { title: '方向', note: `${(projection.directions ?? []).length} 个候选` },
      (projection.directions ?? []).length === 0
        ? h('span', { className: 'avw-hint' }, '还没有实质方向')
        : projection.directions.map((direction, index) => h(DomainKV, { key: `dir-${index}`, label: direction.state, tone: 'accent' },
          h('span', null, direction.title),
          direction.combination === null ? null : h(DomainChip, { text: `组合 ${direction.combination} 项新元素`, tone: 'accent' })))),

    h(DomainSection, { title: '方案基线', note: `第 ${baseline.version ?? 0} 版` },
      h(DomainKV, { label: '生产门', tone: baseline.ok ? 'ok' : 'warn' },
        h('span', null, baseline.ok ? '可以开始制作' : '关键项未定，不能开始完整制作'),
        h('span', { className: 'avw-hint' }, `${baseline.blockers?.length ?? 0} 个阻塞理由`)),
      (baseline.items ?? []).map((item, index) => h(DomainKV, { key: `item-${index}`, label: item.kind },
        h('span', null, item.title),
        h(DomainChip, {
          text: ITEM_STATE_LABEL[item.state] ?? item.state,
          tone: item.state === 'decided' ? 'ok' : 'warn',
        }))),
      (baseline.blockers ?? []).map((blocker, index) => h('span', { key: `blocker-${index}`, className: 'avw-hint' }, `· ${blocker.kind ?? '项目'}：${blocker.reason}`))),

    h(DomainSection, { title: '早期单元', note: `完成 ${units.complete ?? 0} · 未完成 ${units.incomplete ?? 0}` },
      (units.list ?? []).length === 0
        ? h('span', { className: 'avw-hint' }, '还没有早期生产单元')
        : units.list.map((unit) => h(DomainKV, { key: unit.unitId, label: unit.unitId },
          h(DomainChip, {
            text: unit.status === 'complete' ? '完整' : '未完成',
            tone: unit.status === 'complete' ? 'ok' : 'danger',
          }),
          unit.unobserved?.length > 0 ? h(DomainChip, { text: `未看 ${unit.unobserved.length} 项`, tone: 'warn' }) : null,
          unit.knownIssues?.length > 0 ? h('span', { className: 'avw-hint' }, `已知问题：${unit.knownIssues.join('；')}`) : null))),

    h(DomainSection, { title: '预览与画面来源', note: preview === null ? '还没有渲染记录' : preview.file },
      preview === null
        ? h('span', { className: 'avw-hint' }, '还没有渲染过预览，界面不会显示“已生效”')
        : h('div', null,
          h(DomainKV, { label: '画面', tone: preview.showing === 'current-plan' ? 'ok' : 'warn' },
            h('span', null, preview.showing === 'current-plan' ? '当前计划' : '上一版计划'),
            h('span', { className: 'avw-mono' }, `预览计划 ${preview.planVersion}`)),
          h('span', { className: 'avw-hint' },
            preview.showing === 'current-plan'
              ? '画面与当前计划一致'
              : '画面是上一版计划；改过的范围在渲染前只能是待更新，不能冒充已生效'))),

    h(DomainSection, { title: 'AI 实际看／听' },
      h(DomainKV, { label: '画面', tone: ai.saw ? 'ok' : 'warn' },
        h('span', null, ai.saw ? '看过' : '未看'),
        h('span', { className: 'avw-hint' }, ai.saw ? '有真实图像输入被观察，范围见证据' : '没有真实图像输入，界面不冒充已看')),
      h(DomainKV, { label: '声音', tone: 'warn' },
        h('span', null, ai.heard === 'not-available' ? '未听' : ai.heard),
        h('span', { className: 'avw-hint' }, ai.note ?? '宿主没有听辨通道')),
      h('span', { className: 'avw-hint' }, `VISTA 机制执行 ${vista.executed}/${vista.total}；机制执行不等于增益已证实`)),

    props.notice ? h('span', { className: 'avw-hint' }, props.notice) : null)
}

/* ---- client/domains/creation/index.js ---- */
/**
 * Mounting and registration of the creation domain view.
 *
 * The view reads ONE thing: the newest `creation.projection` in the project's own event stream,
 * through the route the workbench already exposes. No new host route, no second fact source.
 *
 * Registration is deliberately inert until 总控 rules on the surface: the shell asks for the slot
 * `workbench.creation-domain`, records whether the Host accepted it, and never falls back to
 * drawing somewhere else. A refused slot is reported as `registered: false` instead of being
 * hidden, because a view that silently does not exist is worse than one that says so.
 *
 * @module ui/client/domains/creation/index
 */

/**
 * The shell-held registry this domain registers into.
 *
 * Deliberately NOT a new slot and NOT a navigation entry: the surface decision belongs to 总控, and
 * pushing a slot into `apply` would change the shell's declared slot set behind that decision's
 * back. The registry gives the view a real, disposable registration without choosing a surface.
 */
const CREATION_DOMAIN_REGISTRY = { component: null, mountedAt: null }

/** The client-side matcher for the projection event kind C13 publishes. */
const CREATION_PROJECTION_KIND = 'creation.projection'

/**
 * Find the newest projection in a list of project events.
 * @param {any[]} events
 * @returns {any|null}
 */
function newestProjection(events) {
  if (!Array.isArray(events)) return null
  let latest = null
  let latestSequence = -1
  for (const event of events) {
    if (event?.kind !== CREATION_PROJECTION_KIND) continue
    if (event.detail === null || typeof event.detail !== 'object') continue
    // `/projects/events` answers newest-first; the sequence, not the array position, decides.
    const sequence = Number.isInteger(event.sequence) ? event.sequence : Number.MAX_SAFE_INTEGER
    if (sequence >= latestSequence) {
      latestSequence = sequence
      latest = event.detail
    }
  }
  return latest
}

/** The section the shell would render when the slot is granted. */
function CreationDomainSection() {
  const state = useStoreState()
  const projectId = state.projectId ?? state.project?.project?.projectId ?? null
  const [read, setRead] = React.useState({ loading: projectId !== null, projection: null, error: null })

  React.useEffect(() => {
    if (projectId === null) {
      setRead({ loading: false, projection: null, error: null })
      return undefined
    }
    let cancelled = false
    setRead((current) => ({ ...current, loading: true }))
    Api.events(projectId, 200)
      .then((payload) => {
        if (cancelled) return
        const events = Array.isArray(payload) ? payload : (payload?.events ?? [])
        setRead({ loading: false, projection: newestProjection(events), error: null })
      })
      .catch((error) => {
        if (cancelled) return
        setRead({ loading: false, projection: null, error: `读取项目事件失败：${error?.message ?? error}` })
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return h(CreationDomainView, {
    loading: read.loading,
    projection: read.projection,
    error: read.error,
    notice: '只读投影：数据来自项目事件流；要改项目事实请回到已有编辑入口。',
  })
}

/**
 * Ask the shell for the domain slot, once, through an effect the shell can dispose.
 *
 * @param {any} ctx the Host plugin context
 * @returns {{ status: {slot: string, registered: boolean, reason: string|null}, dispose: () => void }}
 */
function registerCreationDomain(ctx) {
  const status = { mode: 'shell-registry', registered: false, reason: null }
  if (ctx === null || typeof ctx !== 'object') {
    status.reason = '没有 Host 上下文'
    return { status, dispose: () => {} }
  }
  CREATION_DOMAIN_REGISTRY.component = CreationDomainSection
  CREATION_DOMAIN_REGISTRY.mountedAt = new Date().toISOString()
  status.registered = true
  return {
    status,
    dispose: () => {
      // Disposing removes THIS registration and nothing else; a later registration is untouched.
      if (CREATION_DOMAIN_REGISTRY.component === CreationDomainSection) {
        CREATION_DOMAIN_REGISTRY.component = null
        CREATION_DOMAIN_REGISTRY.mountedAt = null
      }
    },
  }
}

/* ---- client/domains/review/view.js ---- */
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
function ReviewDomainView(props) {
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

/* ---- client/domains/review/index.js ---- */
/**
 * Mounting and registration of the review domain view.
 *
 * The view reads ONE thing: the newest `editing.projection` in the project's own event stream,
 * through the route the workbench already exposes. No new host route, no second fact source.
 *
 * Registration is deliberately a shell-held registry and not a new panel or navigation entry: the
 * surface decision belongs to C11/总控, and pushing a slot into `apply` would change the shell's
 * declared slot set behind that decision's back. A refused registration would be reported as
 * `registered: false` instead of hidden, because a view that silently does not exist is worse than
 * one that says so.
 *
 * @module ui/client/domains/review/index
 */

/** The shell-held registry this domain registers into. */
const REVIEW_DOMAIN_REGISTRY = { component: null, mountedAt: null }

/** The client-side matcher for the projection event kind C14 publishes. */
const EDITING_PROJECTION_KIND = 'editing.projection'

/**
 * Find the newest editing projection in a list of project events.
 * @param {any[]} events
 * @returns {any|null}
 */
function newestEditingProjection(events) {
  if (!Array.isArray(events)) return null
  let latest = null
  let latestSequence = -1
  for (const event of events) {
    if (event?.kind !== EDITING_PROJECTION_KIND) continue
    if (event.detail === null || typeof event.detail !== 'object') continue
    // `/projects/events` answers newest-first; the sequence, not the array position, decides.
    const sequence = Number.isInteger(event.sequence) ? event.sequence : Number.MAX_SAFE_INTEGER
    if (sequence >= latestSequence) {
      latestSequence = sequence
      latest = event.detail
    }
  }
  return latest
}

/** The section the shell renders once it has a mounting surface. */
function ReviewDomainSection() {
  const state = useStoreState()
  const projectId = state.projectId ?? state.project?.project?.projectId ?? null
  const [read, setRead] = React.useState({ loading: projectId !== null, projection: null, error: null })

  React.useEffect(() => {
    if (projectId === null) {
      setRead({ loading: false, projection: null, error: null })
      return undefined
    }
    let cancelled = false
    setRead((current) => ({ ...current, loading: true }))
    Api.events(projectId, 200)
      .then((payload) => {
        if (cancelled) return
        const events = Array.isArray(payload) ? payload : (payload?.events ?? [])
        setRead({ loading: false, projection: newestEditingProjection(events), error: null })
      })
      .catch((error) => {
        if (cancelled) return
        setRead({ loading: false, projection: null, error: `读取项目事件失败：${error?.message ?? error}` })
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return h(ReviewDomainView, {
    loading: read.loading,
    projection: read.projection,
    error: read.error,
    notice: '只读投影：数据来自项目事件流；接受、退回等操作要以真实交互接入后才出现。',
  })
}

/**
 * Set the review domain into the shell registry, once, through an effect the shell can dispose.
 *
 * @param {any} ctx the Host plugin context
 * @returns {{ status: {mode: string, registered: boolean, reason: string|null}, dispose: () => void }}
 */
function registerReviewDomain(ctx) {
  const status = { mode: 'shell-registry', registered: false, reason: null }
  if (ctx === null || typeof ctx !== 'object') {
    status.reason = '没有 Host 上下文'
    return { status, dispose: () => {} }
  }
  REVIEW_DOMAIN_REGISTRY.component = ReviewDomainSection
  REVIEW_DOMAIN_REGISTRY.mountedAt = new Date().toISOString()
  status.registered = true
  return {
    status,
    dispose: () => {
      // Disposing removes THIS registration and nothing else; a later registration is untouched.
      if (REVIEW_DOMAIN_REGISTRY.component === ReviewDomainSection) {
        REVIEW_DOMAIN_REGISTRY.component = null
        REVIEW_DOMAIN_REGISTRY.mountedAt = null
      }
    },
  }
}

/* ---- client/domains/delivery/view.js ---- */
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
function DeliveryDomainView(props) {
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

/* ---- client/domains/delivery/index.js ---- */
/**
 * Mounting and registration of the delivery domain view.
 *
 * The view reads ONE thing: the newest `delivery.projection` in the project's own event stream,
 * through the route the workbench already exposes (`/projects/events`). No new host route, no second
 * fact source, no write.
 *
 * Registration is deliberately a shell-held registry, exactly like the creation and review domains:
 * the surface decision belongs to C11/总控, so this card adds no panel, no navigation entry and no
 * tenth effect. A refused registration is reported instead of hidden.
 *
 * @module ui/client/domains/delivery/index
 */

/** The shell-held registry this domain registers into. */
const DELIVERY_DOMAIN_REGISTRY = { component: null, mountedAt: null }

/** The client-side matcher for the event kind C15 publishes. */
const DELIVERY_PROJECTION_KIND = 'delivery.projection'

/**
 * Find the newest delivery projection in a list of project events.
 * @param {any[]} events
 * @returns {any|null}
 */
function newestDeliveryProjection(events) {
  if (!Array.isArray(events)) return null
  let latest = null
  let latestSequence = -1
  for (const event of events) {
    if (event?.kind !== DELIVERY_PROJECTION_KIND) continue
    if (event.detail === null || typeof event.detail !== 'object') continue
    // `/projects/events` answers newest-first; the sequence, not the array position, decides.
    const sequence = Number.isInteger(event.sequence) ? event.sequence : Number.MAX_SAFE_INTEGER
    if (sequence >= latestSequence) {
      latestSequence = sequence
      latest = event.detail
    }
  }
  return latest
}

/** The section the shell renders once it has a mounting surface. */
function DeliveryDomainSection() {
  const state = useStoreState()
  const projectId = state.projectId ?? state.project?.project?.projectId ?? null
  const [read, setRead] = React.useState({ loading: projectId !== null, projection: null, error: null })

  React.useEffect(() => {
    if (projectId === null) {
      setRead({ loading: false, projection: null, error: null })
      return undefined
    }
    let cancelled = false
    setRead((current) => ({ ...current, loading: true }))
    Api.events(projectId, 200)
      .then((payload) => {
        if (cancelled) return
        const events = Array.isArray(payload) ? payload : (payload?.events ?? [])
        setRead({ loading: false, projection: newestDeliveryProjection(events), error: null })
      })
      .catch((error) => {
        if (cancelled) return
        setRead({ loading: false, projection: null, error: `读取项目事件失败：${error?.message ?? error}` })
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return h(DeliveryDomainView, {
    loading: read.loading,
    projection: read.projection,
    error: read.error,
    notice: '只读投影：数据来自项目事件流；导出、确认与清理要接上真实交互后才出现。',
  })
}

/**
 * Set the delivery domain into the shell registry, once, through an effect the shell can dispose.
 *
 * @param {any} ctx the Host plugin context
 * @returns {{ status: {mode: string, registered: boolean, reason: string|null}, dispose: () => void }}
 */
function registerDeliveryDomain(ctx) {
  const status = { mode: 'shell-registry', registered: false, reason: null }
  if (ctx === null || typeof ctx !== 'object') {
    status.reason = '没有 Host 上下文'
    return { status, dispose: () => {} }
  }
  DELIVERY_DOMAIN_REGISTRY.component = DeliveryDomainSection
  DELIVERY_DOMAIN_REGISTRY.mountedAt = new Date().toISOString()
  status.registered = true
  return {
    status,
    dispose: () => {
      // Disposing removes THIS registration and nothing else; a later registration is untouched.
      if (DELIVERY_DOMAIN_REGISTRY.component === DeliveryDomainSection) {
        DELIVERY_DOMAIN_REGISTRY.component = null
        DELIVERY_DOMAIN_REGISTRY.mountedAt = null
      }
    },
  }
}

/* ---- client/domains/realwork/snapshot.js ---- */
/**
 * GENERATED FILE — do not edit.
 *
 * Produced by 产品实现/acceptance/real-work/scripts/embed-snapshot.mjs from the evidence JSON in
 * 实施交接/证据/C15R-证据/. Every number below is copied from a measured file listed in
 * `sources`; re-run the generator after re-measuring instead of editing this file.
 */

const REALWORK_SNAPSHOT = {
  "kind": "c15r-realwork-snapshot",
  "generatedAt": "2026-11-10T14:20:00.000Z",
  "generator": "产品实现/acceptance/real-work/scripts/embed-snapshot.mjs",
  "sources": [
    {
      "file": "05-完整初版/render-result-v1.json",
      "bytes": 5132,
      "sha256": "36d5ed7957b5b7436672bc4f93658f8d1f00173617548c994014ebf31380d6cf"
    },
    {
      "file": "05-完整初版/measurement-v1.json",
      "bytes": 7746,
      "sha256": "aa849ad6cf8a3aab4b959933e26eab8f8343c5eba6349997f56c45fd4f459cf4"
    },
    {
      "file": "06-局部修改/measurement-rule4-late2-v1.json",
      "bytes": 7765,
      "sha256": "d1ba969f8a141d1aeed1d037204c64d430549bcaf87f019187f4d6a80bf4b214"
    },
    {
      "file": "06-局部修改/comparison-rule4-late2.json",
      "bytes": 19894,
      "sha256": "872430a39e4ab1b4d586c0a36bbad0e87b2188eb4557b42e693e7c3ab9a5a74a"
    },
    {
      "file": "06-局部修改/still-comparison.json",
      "bytes": 8680,
      "sha256": "ecc8da2e426ac2a9cc3e026926bf6f1d8cf191e0356c0f7fe7802b7d35dbf399"
    },
    {
      "file": "06-局部修改/click-onset-control.json",
      "bytes": 3838,
      "sha256": "d586af1227ef011820ae1d8abd1a645f891e8e68faf4d7b945db1aaf4395d425"
    },
    {
      "file": "产品实现/acceptance/real-work/project/audio/c15r-score.events.json",
      "bytes": 5130,
      "sha256": "31320d6236e0b18074327df5f11b2a04948447d27227f653e6cfa4c192b39947"
    },
    {
      "file": "08-交付/交付清单.json",
      "bytes": 4052,
      "sha256": "cc775118ae816b922ca206f0685d62d836cb706e799b53f5b8d61bf27d5f805d"
    }
  ],
  "film": {
    "title": "《起／落》",
    "palette": "黑 #000000 ／ 米白 #F2EDE3",
    "font": "Noto Serif SC",
    "fontLicense": "SIL OFL 1.1",
    "runtime": "Remotion 4.0.541",
    "runtimeNote": "FFmpeg 适配器在本片暴露两处限制（场景 alpha 时间基准、多转场偏移），换用已注册的 Remotion，未改 C12",
    "planVersion": "direction-b-1.0.1-rule4-late2",
    "accepted": true
  },
  "spec": {
    "totalFrames": 360,
    "width": 1920,
    "height": 1080,
    "fps": "30/1",
    "videoCodec": "h264",
    "pixelFormat": "yuv420p",
    "videoStreamSeconds": 12,
    "containerSeconds": 12.011,
    "audioCodec": "aac",
    "audioSampleRate": 48000,
    "audioChannels": 2,
    "videoSha256": "5798df8642d7b02511e1ccbb2cda02ae75d6b54af7000eb6452d7ef4a20104eb",
    "videoBytes": 570338
  },
  "toleranceFrames": 1,
  "maxAbsDeltaFrames": 0.149,
  "encodeDelayFrames": 0,
  "rules": [
    {
      "objectId": "obj-s2-rule1",
      "measuredFirstVisibleFrame": 91,
      "clickOnsetFrame": 91.149,
      "deltaFrames": 0.149
    },
    {
      "objectId": "obj-s2-rule2",
      "measuredFirstVisibleFrame": 113,
      "clickOnsetFrame": 113.149,
      "deltaFrames": 0.149
    },
    {
      "objectId": "obj-s2-rule3",
      "measuredFirstVisibleFrame": 136,
      "clickOnsetFrame": 136.149,
      "deltaFrames": 0.149
    },
    {
      "objectId": "obj-s2-rule4",
      "measuredFirstVisibleFrame": 160,
      "clickOnsetFrame": 160.149,
      "deltaFrames": 0.149
    }
  ],
  "repair": {
    "request": "第四条线晚 2 帧；该声点击同步后移 2 帧，保持同帧对齐",
    "planVersionFrom": "direction-b-1.0.0",
    "planVersionTo": "direction-b-1.0.1-rule4-late2",
    "changedFrames": [
      158,
      159,
      160,
      161,
      163,
      164
    ],
    "targetVisibleSharePercent": 6.286,
    "othersVisibleSharePercent": 0.196,
    "audioNote": "源 WAV 只有两段差异（旧点击与新点击各 60ms）；编码后点击落点相对源 WAV 移动 0 帧",
    "accepted": true,
    "acceptanceQuote": "接受",
    "acceptedAt": "2026-11-10T18:49:54+08:00",
    "deliveredFile": "实施交接/证据/C15R-证据/08-交付/C15R-起落-12s-定稿-v1.mp4"
  },
  "observation": {
    "saw": true,
    "viewedFrames": "逐张放大：第 45、81、93、159、216、294 帧；另看 12／16 格接触表与波形图",
    "heard": "未听：宿主没有听辨通道，波形只证明有四声点击与包络，不证明听感",
    "notVerified": [
      "整片连续播放的流畅度",
      "音频听感与响度",
      "其他机器上的渲染一致性"
    ]
  },
  "planNotes": {
    "scenes": [
      {
        "id": "s1",
        "startFrame": 0,
        "durationFrames": 90
      },
      {
        "id": "s2",
        "startFrame": 90,
        "durationFrames": 90
      },
      {
        "id": "s3",
        "startFrame": 180,
        "durationFrames": 90
      },
      {
        "id": "s4",
        "startFrame": 270,
        "durationFrames": 90
      }
    ],
    "repairPlanVersion": "direction-b-1.0.1-rule4-late2"
  }
}

/* ---- client/domains/realwork/view.js ---- */
/**
 * Real-work domain view: what the C15R film actually is, measured.
 *
 * This page exists because C10–C15 shipped technical fixtures: they proved the pipeline, not that
 * the product can make something worth watching. C15R made one real 12-second piece, and this view
 * is the honest read-only record of it — spec, timing, the four measured line/click alignments, the
 * one local repair, and exactly what the AI looked at and never heard.
 *
 * Data comes from `snapshot.js`, which is GENERATED from the evidence JSON in
 * `实施交接/证据/C15R-证据/` by `产品实现/acceptance/real-work/scripts/embed-snapshot.mjs`. It is never
 * hand-edited, so a number here cannot drift away from the file that measured it. When the snapshot
 * is missing or stale the view says so instead of showing a plausible-looking table.
 *
 * @module ui/client/domains/realwork/view
 */

/** A section in the workbench's own card rhythm. */
function RealworkSection(props) {
  return h('section', { className: 'avw-card', style: { marginBottom: '10px' } },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, props.title),
      props.note ? h('span', { className: 'avw-card__note' }, props.note) : null,
      h('span', { className: 'avw-grow' })),
    h('div', { className: 'avw-card__body', style: { display: 'grid', gap: '6px' } }, props.children))
}

/** A chip matching the design system. */
function RealworkChip(props) {
  return h('span', { className: `avw-chip${props.tone ? ` avw-chip--${props.tone}` : ''}` }, props.text)
}

/** One two-column row. */
function RealworkKV(props) {
  return h('div', { className: 'avw-kv' },
    h('label', null, props.label),
    h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, props.children))
}

/** Whether a measurement row passed its own tolerance. */
function passTone(ok) {
  return ok === true ? 'ok' : ok === false ? 'danger' : 'warn'
}

/**
 * The whole domain view.
 *
 * @param {object} props
 * @param {any} [props.snapshot] the generated measurement snapshot
 * @param {string} [props.error] why the snapshot is unusable
 * @param {string} [props.notice] a standing note
 */
function RealworkDomainView(props) {
  const snapshot = props.snapshot ?? null
  const header = h('div', { className: 'avw-card__head' },
    h('span', { className: 'avw-card__title' }, '真实作品视图'),

    h(RealworkChip, { text: '只读', tone: 'accent' }),
    h('span', { className: 'avw-grow' }),
    h('span', { className: 'avw-card__note' },
      snapshot === null ? '没有证据快照' : `快照生成于 ${snapshot.generatedAt}`))

  if (typeof props.error === 'string' && props.error.length > 0) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h(RealworkChip, { text: '需要处理', tone: 'warn' }),
        h('span', { className: 'avw-hint' }, props.error)))
  }
  if (snapshot === null) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h('span', { className: 'avw-hint' }, '没有真实作品证据快照：这里不显示任何数字。'),
        props.notice ? h('span', { className: 'avw-hint' }, props.notice) : null))
  }

  const film = snapshot.film ?? {}
  const spec = snapshot.spec ?? {}
  const rules = snapshot.rules ?? []
  const repair = snapshot.repair ?? null
  const observation = snapshot.observation ?? {}

  return h('div', { className: 'avw-realwork-domain' },
    h('div', { className: 'avw-card__head', style: { padding: '0 2px 6px' } },
      h('span', { className: 'avw-card__title' }, '真实作品视图'),
      h(RealworkChip, { text: '只读', tone: 'accent' }),
      h('span', { className: 'avw-grow' }),
      h('span', { className: 'avw-card__note' }, `快照生成于 ${snapshot.generatedAt}`)),
    h(RealworkSection, { title: '作品', note: film.title ?? '—' },
      h(RealworkKV, { label: '成片' },
        h(RealworkChip, { text: `${spec.totalFrames} 帧`, tone: 'accent' }),
        h('span', { className: 'avw-mono' }, `${spec.width}×${spec.height} · ${spec.fps} fps · ${spec.videoCodec} · ${spec.pixelFormat}`),
        h('span', { className: 'avw-hint' }, `视频流 ${spec.videoStreamSeconds}s；容器 ${spec.containerSeconds}s（差值是 AAC 尾部填充，不是画面帧）`)),
      h(RealworkKV, { label: '声音' },
        h(RealworkChip, { text: '程序合成', tone: 'ok' }),
        h('span', { className: 'avw-hint' }, `FFmpeg 噪声床＋四声点击＋下行音；${spec.audioCodec} ${spec.audioSampleRate} Hz ${spec.audioChannels} ch；两次渲染哈希一致`)),
      h(RealworkKV, { label: '颜色与字体' },
        h('span', { className: 'avw-hint' }, `${film.palette ?? '—'}；${film.font ?? '—'}（${film.fontLicense ?? '许可未记录'}）`)),
      h(RealworkKV, { label: '运行时' },
        h('span', { className: 'avw-mono' }, `${film.runtime ?? '—'}`),
        h('span', { className: 'avw-hint' }, film.runtimeNote ?? ''))),

    h(RealworkSection, { title: '四条线与点击对齐', note: `容差 ${snapshot.toleranceFrames} 帧` },
      rules.map((rule) => h(RealworkKV, { key: rule.objectId, label: rule.objectId },
        h('span', null, `可见帧 ${rule.measuredFirstVisibleFrame}`),
        h('span', { className: 'avw-mono' }, `点击 ${rule.clickOnsetFrame} 帧`),
        h(RealworkChip, {
          text: `Δ ${rule.deltaFrames} 帧`,
          tone: passTone(Math.abs(rule.deltaFrames ?? 99) <= (snapshot.toleranceFrames ?? 1)),
        }))),
      h('span', { className: 'avw-hint' },
        `最大绝对误差 ${snapshot.maxAbsDeltaFrames} 帧；检测器在源 WAV 与编码后 MP4 上的读数相差 ${snapshot.encodeDelayFrames} 帧，说明编码没有移动点击。`)),

    h(RealworkSection, { title: '一处真实局部修改', note: repair === null ? '未做' : `${repair.planVersionFrom} → ${repair.planVersionTo}` },
      repair === null
        ? h('span', { className: 'avw-hint' }, '本轮还没有做局部修改。')
        : h('div', null,
          h(RealworkKV, { label: '请求' }, h('span', null, repair.request)),
          h(RealworkKV, { label: '内容改动' },
            h(RealworkChip, { text: `内容变化帧 ${repair.changedFrames.join('/')}`, tone: 'ok' }),
            h('span', { className: 'avw-hint' }, '由不经编码的逐像素对照得出')),
          h(RealworkKV, { label: '编码后像素' },
            h('span', { className: 'avw-hint' },
              `目标线 ${repair.targetVisibleSharePercent}% 像素变化；其余区域上限 ${repair.othersVisibleSharePercent}%（H.264 同 GOP 内的重量化漂移）`)),
          h(RealworkKV, { label: '音频' },
            h('span', { className: 'avw-hint' }, repair.audioNote)),
          h(RealworkKV, { label: '用户接受' },
            h(RealworkChip, { text: repair.accepted === true ? '已接受' : '未接受', tone: repair.accepted === true ? 'ok' : 'warn' }),
            repair.accepted === true
              ? h('span', { className: 'avw-hint' }, `${repair.acceptedAt ?? ''} 用户回复「${repair.acceptanceQuote ?? ''}」；接受对象是这一候选版本`)
              : h('span', { className: 'avw-hint' }, '候选尚未被接受时不计为定稿')))),

    h(RealworkSection, { title: 'AI 实际看／听' },
      h(RealworkKV, { label: '画面' },
        h(RealworkChip, { text: observation.saw === true ? '看过' : '未看', tone: observation.saw === true ? 'ok' : 'warn' }),
        h('span', { className: 'avw-hint' }, observation.viewedFrames ?? '')),
      h(RealworkKV, { label: '声音' },
        h(RealworkChip, { text: '未听', tone: 'warn' }),
        h('span', { className: 'avw-hint' }, observation.heard ?? '宿主没有听辨通道；听感只能由用户判断')),
      h('span', { className: 'avw-hint' }, `未验证：${(observation.notVerified ?? []).join('；')}`)),

    props.notice ? h('span', { className: 'avw-hint' }, props.notice) : null)
}

/* ---- client/domains/realwork/index.js ---- */
/**
 * Registration of the real-work domain view.
 *
 * Same shape as the creation, review and delivery domains: a shell-held registry entry, created
 * once and disposed by the effect that created it. It adds no panel, no navigation entry and no
 * tenth shell effect — the surface decision stays with C11/总控, per CT-00 §5.1.
 *
 * The view reads a generated snapshot (see `snapshot.js`), not the live project store: this round
 * produced a film and its measurements, not a project with editable states. Wrapping measured
 * evidence in a fake editable project would be worse than saying "this is a record".
 *
 * @module ui/client/domains/realwork/index
 */

/** The shell-held registry this domain registers into. */
const REALWORK_DOMAIN_REGISTRY = { component: null, mountedAt: null }

/**
 * Read the generated snapshot.
 *
 * `REALWORK_SNAPSHOT` is a build-time constant produced by
 * `产品实现/acceptance/real-work/scripts/embed-snapshot.mjs` from the evidence JSON. It is null when
 * the generator could not find the measurements, and the view then reports that instead of a
 * plausible table.
 *
 * @returns {{ snapshot: any, error: string|null }}
 */
function readRealworkSnapshot() {
  if (typeof REALWORK_SNAPSHOT === 'undefined' || REALWORK_SNAPSHOT === null) {
    return { snapshot: null, error: null }
  }
  if (REALWORK_SNAPSHOT.kind !== 'c15r-realwork-snapshot') {
    return { snapshot: null, error: `快照种类不符：${String(REALWORK_SNAPSHOT.kind)}` }
  }
  return { snapshot: REALWORK_SNAPSHOT, error: null }
}

/** The section the shell renders once it mounts this domain. */
function RealworkDomainSection() {
  const read = readRealworkSnapshot()
  return h(RealworkDomainView, {
    snapshot: read.snapshot,
    error: read.error,
    notice: '只读记录：数字来自 `实施交接/证据/C15R-证据/` 的实测文件，由生成脚本写入，不在此处编辑。',
  })
}

/**
 * Put the domain into the shell registry once, through a disposal path the shell owns.
 *
 * @param {any} ctx the Host plugin context
 * @returns {{ status: {mode: string, registered: boolean, reason: string|null}, dispose: () => void }}
 */
function registerRealworkDomain(ctx) {
  const status = { mode: 'shell-registry', registered: false, reason: null }
  if (ctx === null || typeof ctx !== 'object') {
    status.reason = '没有 Host 上下文'
    return { status, dispose: () => {} }
  }
  REALWORK_DOMAIN_REGISTRY.component = RealworkDomainSection
  REALWORK_DOMAIN_REGISTRY.mountedAt = new Date().toISOString()
  status.registered = true
  return {
    status,
    dispose: () => {
      // Disposing removes THIS registration and nothing else.
      if (REALWORK_DOMAIN_REGISTRY.component === RealworkDomainSection) {
        REALWORK_DOMAIN_REGISTRY.component = null
        REALWORK_DOMAIN_REGISTRY.mountedAt = null
      }
    },
  }
}

/* ---- client/hooks.js ---- */
/**
 * Store binding for React components.
 *
 * One hook, one subscription: every panel re-renders when the store changes. The store is tiny
 * enough that selectors would be ceremony; the views read the fields they need.
 *
 * @module ui/client/hooks
 */

function useStoreState() {
  const [state, setState] = React.useState(Store.get())
  React.useEffect(() => Store.subscribe(setState), [])
  return state
}

/** A stable callback identity for event handlers that only read the latest store. */
function useLatest(value) {
  const ref = React.useRef(value)
  ref.current = value
  return ref
}

/* ---- client/actions.js ---- */
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
      // The right column is driven by `rightTab`, not by `assistantOpen`: clearing only the flag
      // left the panel on screen and Esc looked broken (C16R §5.2). Close the panel itself.
      Store.set((current) => ({
        ...current,
        modal: null,
        helpOpen: false,
        searchOpen: false,
        assistantOpen: false,
        rightTab: current.rightTab === 'assistant' ? 'properties' : current.rightTab,
      }))
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

/* ---- client/views/home.js ---- */
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

function HomeView() {
  return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } },
    h('div', { className: 'avw-scroll' },
      h('div', { className: 'avw-home' },
        h(HomeHeader),
        h('div', { className: 'avw-home-grid' },
          h('div', null, h(ContinueCard), h(StartCard)),
          h('div', { style: { display: 'grid', gap: '14px', minHeight: 0 } }, h(WaitingCard), h(RecentCard))))),
    h(HomeFoot))
}

/* ---- client/views/project.js ---- */
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

function ProjectView() {
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

/* ---- client/views/creation.js ---- */
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
      h('button', { type: 'button', className: 'avw-tree-item', onClick: () => scrollToSection('avw-creation-domain') },
        h(Icon, { name: 'layers' }), '创建领域视图（只读）',
        h('span', { className: 'meta' }, '已接入'))),
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
      h(Chip, { tone: 'warn' }, '界面草稿（未迁移到项目事实）'),
      h('span', { className: 'avw-grow' }),
      h('span', { className: 'avw-card__note' }, '本地草稿自动保存；项目事实里的只读简报见下方创建领域视图')),
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

/**
 * Mount whatever the creation domain registered, or say plainly that nothing is registered.
 *
 * The domain view is a self-contained component (its own store read + event fetch), so mounting it
 * here adds no panel, no slot and no effect — the shell's four entries stay four.
 */
function CreationDomainMount() {
  const registry = typeof CREATION_DOMAIN_REGISTRY === 'object' && CREATION_DOMAIN_REGISTRY !== null
    ? CREATION_DOMAIN_REGISTRY
    : { component: null }
  if (typeof registry.component !== 'function') {
    return h('div', { className: 'avw-card', id: 'avw-creation-domain', style: { marginTop: '14px' } },
      h('div', { className: 'avw-card__head' }, h('span', { className: 'avw-card__title' }, '创建领域视图')),
      h('div', { className: 'avw-card__body' },
        h('p', { className: 'avw-hint', style: { margin: 0 } }, '领域视图没有注册：宿主没有提供注册表，所以这里不显示任何数据。')))
  }
  const Registered = registry.component
  return h('div', { id: 'avw-creation-domain', style: { marginTop: '14px' } }, h(Registered))
}

/**
 * Mount whatever the real-work domain registered, or say plainly that nothing is registered.
 *
 * Same shape as the other domain mounts: self-contained component, no panel, no slot, no effect.
 * It sits on this page because a finished film is a creation result; the numbers come from the
 * generated snapshot, not from this page.
 */
function RealworkDomainMount() {
  const registry = typeof REALWORK_DOMAIN_REGISTRY === 'object' && REALWORK_DOMAIN_REGISTRY !== null
    ? REALWORK_DOMAIN_REGISTRY
    : { component: null }
  if (typeof registry.component !== 'function') {
    return h('div', { className: 'avw-card', id: 'avw-realwork-domain', style: { marginTop: '14px' } },
      h('div', { className: 'avw-card__head' }, h('span', { className: 'avw-card__title' }, '真实作品视图')),
      h('div', { className: 'avw-card__body' },
        h('p', { className: 'avw-hint', style: { margin: 0 } }, '真实作品领域视图没有注册：这里不显示任何数字，也不画假进度。')))
  }
  const Registered = registry.component
  return h('div', { id: 'avw-realwork-domain', style: { marginTop: '14px' } }, h(Registered))
}

function CreationCenter() {
  const state = useStoreState()
  return h('section', { className: 'avw-col avw-col--center' },
    h('div', { className: 'avw-scroll' },
      h('div', { style: { padding: '14px 16px', maxWidth: '1080px' } },
        h(BriefSection),
        h(MaterialsSection),
        h(CreationDomainMount),
        h(RealworkDomainMount),
        h(PartialIntegrationNote))))
}

/** What is genuinely wired, next to what is not — with no fake controls for the latter. */
function PartialIntegrationNote() {
  return h('div', { style: { marginTop: '10px' } },
    h('div', { className: 'avw-gap' },
      h('b', null, '已接入（只读）与仍未接入'),
      h('div', null, '已接入：简报、方向、方案三态、早期生产单元、预览过期范围、AI 实际看／听，全部来自项目事件流里的 creation.projection。'),
      h('div', null, '仍未接入：可点的验收／确认按钮（需要 C10 确认记录与 C11 交互）、助手回答、渲染触发（C12）。这些位置只写说明，不画假按钮。')))
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

const CreationSurface = { Left: CreationLeft, LeftContent: CreationLeftContent, Center: CreationCenter, Bottom: CreationBottom, StatusBar: CreationStatusBar }

function scrollToSection(id) {
  const element = document.getElementById(id)
  if (element) element.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

/* ---- client/views/work.js ---- */
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

const WorkSurface = { Left: WorkLeft, LeftContent: WorkLeftContent, Center: WorkCenter, Bottom: WorkBottom, StatusBar: WorkStatusBar }

/* ---- client/views/tools.js ---- */
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

function ToolsView() {
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

/* ---- client/views/preferences.js ---- */
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

function PreferencesView() {
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

/* ---- client/views/effects.js ---- */
/**
 * Effects page: the pure visual/sound effect library.
 *
 * The library itself belongs to C15 (project packages, effects, delivery). Until it lands there is
 * no effect store to read, so this page states that plainly instead of listing sample effects.
 *
 * @module ui/client/views/effects
 */

/**
 * Mount whatever the delivery domain registered, on the effects page.
 *
 * The domain view is self-contained (its own event-stream read), so mounting it here adds no panel,
 * no slot and no effect. When nothing is registered the mount says so instead of drawing an empty
 * delivery list that looks operational.
 */
function DeliveryDomainMount() {
  const registry = typeof DELIVERY_DOMAIN_REGISTRY === 'object' && DELIVERY_DOMAIN_REGISTRY !== null
    ? DELIVERY_DOMAIN_REGISTRY
    : { component: null }
  if (typeof registry.component !== 'function') {
    return h('div', { className: 'avw-card', id: 'avw-delivery-domain', style: { marginTop: '8px' } },
      h('div', { className: 'avw-card__head' }, h('span', { className: 'avw-card__title' }, '交付、项目包、效果与结项')),
      h('div', { className: 'avw-card__body' },
        h('p', { className: 'avw-hint', style: { margin: 0 } }, '交付领域视图没有注册：这里不显示任何数据，也不画假按钮。')))
  }
  const Registered = registry.component
  return h('div', { id: 'avw-delivery-domain', style: { marginTop: '8px' } }, h(Registered))
}

function EffectsView() {
  const state = useStoreState()
  const effects = state.effects
  React.useEffect(() => { if (effects === null) Actions.loadEffects() }, [])
  const list = effects?.effects ?? []
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h('div', { className: 'avw-scroll' },
      h('div', { className: 'avw-page' },
        h('h2', null, '效果'),
        h('p', null, '只收录视觉与声音效果本身，不把方法、案例或提示词当作独立资产。'),
        list.length === 0
          ? h('div', { className: 'avw-card' },
            h('div', { className: 'avw-card__body' },
              h(Empty, {
                icon: 'effects',
                title: '还没有已收录的效果',
                message: '正式收录需要从空项目复现并检查结果一致；效果库、复现门禁与结项由 C15 接入。',
              })))
          : h('div', { className: 'avw-tools' }, list.map((effect) => h('div', { key: effect.id ?? effect.name, className: 'avw-tool' },
            h('b', null, effect.name ?? '未命名效果'),
            h('p', null, effect.summary ?? ''),
            h('span', { className: 'side' }, h(Chip, null, effect.version ?? '未标版本'))))),
        h('div', { style: { marginTop: '12px' } },
          h(GapCard, { gap: INTEGRATION_GAPS.delivery })),
        h(DeliveryDomainMount),
        h('p', { className: 'avw-hint' }, '正式效果文件、源码、必要输入和版本锁定会随效果包一起保留；源码本身不等于任何环境都能复现。')),
      h(Toast, { toast: state.toast })))
}

/* ---- client/app.js ---- */
/**
 * Client half entry: register the four global entries and mount the workbench pages.
 *
 * Two rules from CT-01 shape this file:
 * - the browser half is bundled for the package name and mounted on the row whose specifier is that
 *   package name, so the module id must match `package.json`;
 * - every registration is disposed through the effect that created it; nothing relies on a
 *   "dispose" event.
 *
 * @module ui/client/app
 */

const PANEL_DEFINITIONS = [
  { id: 'avw-projects', label: '项目', icon: 'project', order: 40, component: 'projects' },
  { id: 'avw-effects', label: '效果', icon: 'effects', order: 41, component: 'effects' },
  { id: 'avw-tools', label: '工具', icon: 'tools', order: 42, component: 'tools' },
  { id: 'avw-preferences', label: '偏好', icon: 'prefs', order: 43, component: 'preferences' },
]

/** Inject the design system once per page; remove it when the plugin's effect disposes. */
function ensureStyle() {
  const existing = document.querySelector('style[data-avw-style]')
  if (existing) return () => {}
  const style = document.createElement('style')
  style.dataset.avwStyle = 'true'
  style.textContent = AVW_CSS
  document.head.appendChild(style)
  return () => style.remove()
}

function SidebarIcon(props) {
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' } },
    h(Icon, { name: props.name, size: 18 }))
}

/** The panel frame: measures its own width, owns the keyboard map and the narrow drawer state. */
function WorkbenchFrame(props) {
  const state = useStoreState()
  const ref = React.useRef(null)

  React.useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const update = () => {
      const rect = element.getBoundingClientRect()
      const next = resolveLayout(rect.width, rect.height)
      const current = Store.get().layout
      if (current.mode !== next.mode || current.showLeft !== next.showLeft || current.showRight !== next.showRight) {
        Store.set((value) => ({ ...value, layout: next }))
      }
    }
    update()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onKeyDown = (event) => {
    const hasSelection = state.selection !== null && state.selection !== undefined
    const context = {
      typing: isTypingTarget(event.target),
      composing: event.nativeEvent?.isComposing === true,
      hasSelection,
    }
    const resolved = resolveKeyAction(event, context)
    if (resolved.preventDefault) event.preventDefault()
    if (resolved.action) Actions.keyboard(resolved.action)
  }

  return h('div', {
    ref,
    className: 'avw-root',
    'data-panel': props.panel ?? 'unknown',
    'data-mode': state.layout?.mode ?? 'wide',
    style: Number.isFinite(state.layout?.leftWidth) && Number.isFinite(state.layout?.rightWidth)
      ? {
          '--avw-left': `${state.layout.leftWidth}px`,
          '--avw-right': `${state.layout.rightWidth}px`,
          '--avw-timeline': `${state.layout.timelineHeight}px`,
        }
      : undefined,
    tabIndex: -1,
    onKeyDown,
  }, h('span', { className: 'avw-sr', 'data-avw-panel': props.panel ?? 'unknown' }, props.panel ?? 'unknown'), props.children ?? h('div', { style: { padding: '20px' } }, '面板没有内容'))
}

function ProjectsPanelBody() {
  const state = useStoreState()
  React.useEffect(() => {
    if (Store.get().status === 'idle') Actions.bootstrap()
  }, [])
  return h(ProjectView)
}

function ToolsPanel() {
  return h(WorkbenchFrame, { panel: 'tools' }, h(ToolsView))
}

function EffectsPanel() {
  return h(WorkbenchFrame, { panel: 'effects' }, h(EffectsView))
}

function PreferencesPanel() {
  return h(WorkbenchFrame, { panel: 'preferences' }, h(PreferencesView))
}

function ProjectsPanel() {
  return h(WorkbenchFrame, { panel: 'projects' }, h(ProjectsPanelBody))
}

const COMPONENTS = Object.freeze({
  projects: ProjectsPanel,
  effects: EffectsPanel,
  tools: ToolsPanel,
  preferences: PreferencesPanel,
})

/**
 * Design system + creation domain view, registered together in ONE effect.
 *
 * Why one effect: the shell's own regression test asserts that `apply` creates exactly nine
 * effects (stylesheet + 4 sidebar + 4 main), so a tenth effect would be a real interface change C11
 * has to approve — not something this card may slip in. Both registrations are still created here
 * and both are disposed by the same effect, which is what "disposable registration" requires.
 * The dedicated-effect version is raised as CR-13-1 for 总控.
 */
function registerShellAdditions(ctx) {
  const disposeStyle = ensureStyle()
  const domain = registerCreationDomain(ctx)
  const review = registerReviewDomain(ctx)
  const delivery = registerDeliveryDomain(ctx)
  const realwork = registerRealworkDomain(ctx)
  // Evidence hook: the isolation walkthrough reads this to prove the registration is STATED.
  if (typeof window !== 'undefined') window.__avwCreationDomain = domain.status
  if (typeof window !== 'undefined') window.__avwReviewDomain = review.status
  if (typeof window !== 'undefined') window.__avwDeliveryDomain = delivery.status
  if (typeof window !== 'undefined') window.__avwRealworkDomain = realwork.status
  return () => {
    domain.dispose()
    review.dispose()
    delivery.dispose()
    realwork.dispose()
    disposeStyle()
  }
}

/** The value returned to the Host loader. */
const AVW_PLUGIN = {
  name: 'dsh-plugin-control-your-video',
  inject: ['slots'],
  // Not public API: the loader smoke test seeds the store to render pages with real-shaped data.
  // Not public API: the client bundle test and the domain evidence harness seed the store and
  // mount the creation domain view with real-shaped data.
  __internal: {
    Store,
    Actions,
    CreationDomainView,
    CreationDomainSection,
    CREATION_DOMAIN_REGISTRY,
    registerCreationDomain,
    newestProjection,
    ReviewDomainView,
    ReviewDomainSection,
    REVIEW_DOMAIN_REGISTRY,
    registerReviewDomain,
    newestEditingProjection,
    ReviewDomainMount,
    DeliveryDomainView,
    DeliveryDomainSection,
    DELIVERY_DOMAIN_REGISTRY,
    registerDeliveryDomain,
    newestDeliveryProjection,
    DeliveryDomainMount,
    RealworkDomainView,
    RealworkDomainSection,
    REALWORK_DOMAIN_REGISTRY,
    registerRealworkDomain,
    RealworkDomainMount,
  },
  apply(ctx) {
    ctx.effect(() => registerShellAdditions(ctx), 'ai-video-workbench: design system stylesheet')
    for (const panel of PANEL_DEFINITIONS) {
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: panel.id,
        order: panel.order,
        label: () => panel.label,
      }, function EntryIcon() {
        return h(SidebarIcon, { name: panel.icon })
      })), `ai-video-workbench: ${panel.id} sidebar entry`)
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: panel.id,
      }, COMPONENTS[panel.component])), `ai-video-workbench: ${panel.id} main panel`)
    }
  },
}
    return AVW_PLUGIN;
  },
});
