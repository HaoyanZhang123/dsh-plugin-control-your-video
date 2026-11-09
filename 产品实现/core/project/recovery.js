/**
 * The single save/continue flow: 自动保存 → 读取保存位置 → 检查文件与工具 → 可以继续／需要处理.
 *
 * CT-02 §9 and C10 card §1 allow exactly ONE recovery path, and this module is it. There is no
 * second recovery system here and no promise of finding work that was deleted or cleaned: a
 * cleaned-up history has no recovery entry (CT-02 §9 "已删除历史不显示恢复入口"). What this
 * module does is state, honestly and from disk, whether the saved position can still be restored
 * and, when it cannot, which concrete difference the user has to deal with.
 *
 * What is written, and why:
 * - `work/position.json` — the work position (version, object, playhead, surface, panels, open
 *   document) written through `store.writeDocument`, so it is atomic, revision-checked and
 *   read back and verified (CT-02 §3).
 * - `recovery.json` — the last autosave summary plus a clean-shutdown marker. The marker is what
 *   makes the next open say "可以继续" instead of "状态未知": only a proper dispose
 *   (`markCleanPause`) may set it clean, so a crash always leaves it unclean (CT-01 §4).
 *
 * What is NOT claimed:
 * - A lock or a marker proves only a declared right or a last known state; it never proves an
 *   external process stopped (CT-02 §4). `unknownExecutionResult` therefore turns an interrupted
 *   external action into "状态未知，不自动重复" rather than a retry.
 * - Checks that need knowledge this module must not own are INJECTED (`materialCheck`,
 *   `toolCheck`) instead of importing `materials.js` or probing tools itself. A check that was not
 *   injected is listed in `notRun`; it is never reported as passed. A caller that needs a full
 *   "可以继续" must inject the checkers, and a UI must show `notRun` instead of claiming certainty.
 * - Inspection is READ-ONLY: no file is deleted or repaired, so a diagnostic still works on a
 *   project that may be corrupt. A leftover `*.tmp-write` file is reported and kept as evidence;
 *   cleanup is a separate, attributable action (base/atomic-write.js only removes dead-owner
 *   temps, and removing evidence is not this card's job).
 *
 * Attention codes come from `schema.js` and never from this file. Three of them are used for a
 * situation the frozen vocabulary has no exact word for, and the message always states the real
 * difference so the code is never read as a different claim:
 * - an absent work position or an unclean previous run → `EXECUTION_UNKNOWN` (the state is
 *   unknowable, which is exactly "先按已暂停处理");
 * - a leftover `*.tmp-write`, i.e. the last write did not publish → `FILE_BUSY` (a file operation
 *   did not complete), because `DISK_FULL`/`PERMISSION_DENIED` would be a false claim;
 * - a saved `versionId` that is no longer in the version index, or an unreadable index →
 *   `CANDIDATE_NEEDS_RECHECK` (the saved position must be re-checked against the versions that
 *   still exist).
 *
 * @module core/project/recovery
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  IoError,
  NotFoundError,
  PROCESS_INSTANCE,
  ValidationError,
  inspectLock,
  isProcessAlive,
  TEMP_SUFFIX,
} from '../../base/index.js'
import { assertId, isId } from './ids.js'
import { CURRENT_SCHEMA_GENERATION, NeedsAttentionCode } from './schema.js'
import { PROJECT_LAYOUT, pathExists } from './paths.js'
import { readDocument, tryReadDocument, writeDocument } from './store.js'
import { appendEvents, buildEvent, ProjectEventKind } from './events.js'
import { executionMarkerPath, inspectExecution, projectEditLockPath } from './write-guard.js'

/** The two verdicts a surface may render. Nothing else may be invented by a caller. */
export const RECOVERY_VERDICTS = Object.freeze({
  CAN_CONTINUE: 'can-continue',
  NEEDS_HANDLING: 'needs-handling',
})

/** Fields of a saved work position, in the order a UI restores them. */
export const WORK_POSITION_FIELDS = Object.freeze([
  'versionId',
  'playheadFrame',
  'selectedObjectId',
  'workSurface',
  'panelState',
  'openDocument',
  'autosavedAt',
])

/** Directories inside a project that this module or its siblings write state files into. */
const STATE_DIRS = Object.freeze(['', 'work', 'versions', 'materials'])

/** Longest accepted surface label; a longer one is refused instead of silently truncated. */
const MAX_SURFACE_LENGTH = 100

/**
 * Save the current work position, then write the recovery marker and append an autosave event.
 *
 * Two call forms are accepted, so the frozen facade and a direct caller can both use it:
 * - `saveWorkPosition(projectDir, position, options)` — the form documented below;
 * - `saveWorkPosition({ projectDir, ...position, clock })` — one options object, which is what
 *   `core/project/index.js` callers use. `projectDir` is taken out of the object and the rest is
 *   the position, so a field can never be mistaken for the directory.
 *
 * Both documents are written atomically through `store.js`; each write states the revision it was
 * based on when the file already exists, so a second writer gets a `VERSION_CONFLICT` instead of
 * silently replacing this position (CT-02 §3).
 *
 * The written `recovery.json` has `cleanShutdown.clean === false`: work is in progress, so this
 * run has NOT ended normally and a crash from here must open as "状态未知" (CT-01 §4).
 *
 * `canContinue` on the RETURNED value reports the SAVE result only: the position was written and
 * re-read from disk, so it can be restored. It is NOT the recovery verdict — that needs the file
 * and tool checks and is what `inspectRecovery` returns. A surface must not read this field as
 * "下次打开可以继续", because an in-progress save deliberately leaves the marker unclean.
 *
 * @param {string} projectDir absolute path of an existing project directory
 * @param {object} position
 * @param {string} position.projectId
 * @param {string} [position.versionId] empty when the project has no version yet
 * @param {number} [position.playheadFrame] integer, >= 0
 * @param {string} [position.selectedObjectId]
 * @param {string} [position.workSurface]
 * @param {any} [position.panelState] JSON-serializable
 * @param {any} [position.openDocument] JSON-serializable
 * @param {string} [position.autosavedAt] ISO timestamp; defaults to the injected clock
 * @param {{ clock?: Clock }} [options]
 * @returns {{
 *   projectId: string,
 *   position: object,
 *   positionRevision: string,
 *   recoveryRevision: string,
 *   appended: number,
 *   savedAt: string,
 *   canContinue: true,
 * }}
 */
export function saveWorkPosition(projectDir, position, options = {}) {
  const args = normalizeSaveArguments(projectDir, position, options)
  const dir = requireProjectDir(args.projectDir)
  const clock = args.options.clock ?? new Clock()
  const projectId = assertId(args.position?.projectId, 'project', 'projectId')
  const savedAt = clock.iso()
  const body = buildWorkPositionBody(projectId, args.position, savedAt)

  const positionPath = path.join(dir, PROJECT_LAYOUT.workPositionFile)
  ensureParentDir(positionPath)
  const previousPosition = tryReadSuperseded(positionPath, 'work-position')
  const positionWrite = writeDocument(positionPath, body, {
    kind: 'work-position',
    expectedRevision: previousPosition === null ? undefined : previousPosition.revision,
    clock,
  })

  const recoveryPath = path.join(dir, PROJECT_LAYOUT.recoveryFile)
  const previousRecovery = tryReadSuperseded(recoveryPath, 'recovery')
  const recoveryWrite = writeDocument(
    recoveryPath,
    {
      projectId,
      cleanShutdown: { clean: false, at: savedAt, reason: 'work-in-progress' },
      lastAutosave: {
        at: savedAt,
        autosavedAt: body.autosavedAt,
        versionId: body.versionId,
        playheadFrame: body.playheadFrame,
        selectedObjectId: body.selectedObjectId,
        workSurface: body.workSurface,
        positionRevision: positionWrite.revision,
      },
    },
    { kind: 'recovery', schemaKey: 'recovery', expectedRevision: previousRecovery?.revision, clock },
  )

  const appended = appendEvents(
    dir,
    [
      buildEvent({
        kind: ProjectEventKind.AUTOSAVE_COMPLETED,
        projectId,
        actor: 'system',
        detail: {
          versionId: body.versionId,
          playheadFrame: body.playheadFrame,
          selectedObjectId: body.selectedObjectId,
          workSurface: body.workSurface,
          autosavedAt: body.autosavedAt,
          positionRevision: positionWrite.revision,
        },
      }),
    ],
    { clock },
  )

  return {
    projectId,
    position: pickPosition(body),
    positionRevision: positionWrite.revision,
    recoveryRevision: recoveryWrite.revision,
    appended: appended.appended,
    savedAt,
    // The position is durable and verified on disk, so it can be restored. This is NOT the
    // recovery verdict; see `inspectRecovery` and the note in this function's JSDoc.
    canContinue: true,
  }
}

/**
 * Accept both documented call forms of {@link saveWorkPosition}.
 *
 * The single-object form is what the frozen facade exposes (`core/project/index.js`), and the
 * positional form is what a direct internal caller uses. Doing the normalization here keeps one
 * implementation instead of two drifting ones.
 *
 * @param {string | object} projectDir
 * @param {object} [position]
 * @param {{ clock?: Clock }} [options]
 * @returns {{ projectDir: string, position: object, options: { clock?: Clock } }}
 */
function normalizeSaveArguments(projectDir, position, options = {}) {
  if (typeof projectDir === 'string') {
    return { projectDir, position: position ?? {}, options: options ?? {} }
  }
  if (projectDir !== null && typeof projectDir === 'object') {
    const { projectDir: dir, clock, ...rest } = projectDir
    return {
      projectDir: String(dir ?? ''),
      position: rest,
      options: { ...(options ?? {}), ...(clock === undefined ? {} : { clock }) },
    }
  }
  throw new ValidationError('需要项目目录', { field: 'projectDir' })
}

/**
 * Read the saved work position from disk.
 *
 * Returns `null` when no position was ever saved, and throws when one exists but cannot be read,
 * because "no position" and "unreadable position" are different answers for the user.
 *
 * @param {string} projectDir
 * @returns {null | { position: object, revision: string, bytes: number }}
 */
export function readWorkPosition(projectDir) {
  const dir = requireProjectDir(projectDir, { mustExist: false })
  const stored = tryReadDocument(path.join(dir, PROJECT_LAYOUT.workPositionFile), { kind: 'work-position' })
  if (stored === null) return null
  return { position: pickPosition(stored.value), revision: stored.revision, bytes: stored.bytes }
}

/**
 * Record that this run ended normally, so the next open can say "可以继续".
 *
 * Two call forms are accepted, matching {@link saveWorkPosition}:
 * - `markCleanPause(projectDir, { reason, projectId }, options)`;
 * - `markCleanPause({ projectDir, reason, projectId, clock })`.
 *
 * Called from the dispose path (CT-01 §4: only `ctx.effect` disposers, ~5 s budget), so it is
 * idempotent and keeps the previous autosave summary that {@link saveWorkPosition} wrote: a
 * dispose must not destroy the very position the next open restores.
 *
 * @param {string} projectDir
 * @param {object} [input]
 * @param {string} [input.reason] why the run paused, e.g. `host-dispose`
 * @param {string} [input.projectId] defaults to `project.json`'s id, then to the directory name
 * @param {{ clock?: Clock }} [options]
 * @returns {{ projectId: string, cleanShutdown: object, recoveryRevision: string,
 *   eventRecorded: boolean, eventSkipped: string }}
 */
export function markCleanPause(projectDir, input = {}, options = {}) {
  const args = normalizePauseArguments(projectDir, input, options)
  const dir = requireProjectDir(args.projectDir)
  const clock = args.options.clock ?? new Clock()
  const at = clock.iso()
  const projectId = resolveProjectId(dir, args.input.projectId)

  const recoveryPath = path.join(dir, PROJECT_LAYOUT.recoveryFile)
  const previous = tryReadSuperseded(recoveryPath, 'recovery', { swallowCorruption: true })
  const cleanShutdown = {
    clean: true,
    at,
    reason: typeof args.input.reason === 'string' && args.input.reason.length > 0
      ? args.input.reason
      : 'clean-pause',
  }
  const written = writeDocument(
    recoveryPath,
    {
      projectId,
      cleanShutdown,
      lastAutosave: previous?.value?.lastAutosave ?? null,
    },
    { kind: 'recovery', schemaKey: 'recovery', expectedRevision: previous?.revision, clock },
  )

  const recorded = recordEvent(dir, projectId, {
    kind: ProjectEventKind.SAVE_PAUSED,
    actor: 'system',
    detail: { reason: cleanShutdown.reason, at },
  }, clock)

  return {
    projectId,
    cleanShutdown,
    recoveryRevision: written.revision,
    eventRecorded: recorded.eventRecorded,
    eventSkipped: recorded.eventSkipped,
  }
}

/**
 * Accept both documented call forms of {@link markCleanPause}.
 * @param {string | object} projectDir
 * @param {object} [input]
 * @param {{ clock?: Clock }} [options]
 * @returns {{ projectDir: string, input: object, options: { clock?: Clock } }}
 */
function normalizePauseArguments(projectDir, input, options = {}) {
  if (typeof projectDir === 'string') {
    return { projectDir, input: input ?? {}, options: options ?? {} }
  }
  if (projectDir !== null && typeof projectDir === 'object') {
    const { projectDir: dir, clock, ...rest } = projectDir
    return {
      projectDir: String(dir ?? ''),
      input: rest,
      options: { ...(options ?? {}), ...(clock === undefined ? {} : { clock }) },
    }
  }
  throw new ValidationError('需要项目目录', { field: 'projectDir' })
}

/**
 * Inspect a project for "可以继续／需要处理", really reading the disk.
 *
 * Every check reports a real difference with a real next action; nothing is auto-repaired and no
 * external action is ever repeated. The order below is the CT-02 §9 order: the saved position
 * first, then the files and tools it depends on.
 *
 * @param {object} options
 * @param {string} options.projectDir absolute project directory
 * @param {string} [options.projectsRoot] needed for the execution marker and the project lock
 * @param {string} [options.projectId] needed for the project lock and the marker match
 * @param {(materials: object[]) => Array<{id: string, available: boolean, code?: string}>}
 *   [options.materialCheck] injected availability check; this module never imports materials.js
 * @param {() => Array<{name: string, available: boolean}>} [options.toolCheck] injected tool probe
 * @param {Array<{name: string, available: boolean}>} [options.requiredTools] static tool facts,
 *   used only when no `toolCheck` was injected
 * @param {string} [options.markerPath] overrides the execution marker path
 * @param {Clock} [options.clock]
 * @returns {{
 *   projectId: string,
 *   canContinue: boolean,
 *   verdict: 'can-continue' | 'needs-handling',
 *   position: object | null,
 *   detected: object,
 *   needsHandling: Array<{ code: string, message: string, action: string, [key: string]: any }>,
 *   notRun: string[],
 *   degraded: boolean,
 *   doNotRepeatExternalActions: boolean,
 *   headline: string,
 * }}
 */
export function inspectRecovery(options) {
  const clock = options?.clock ?? new Clock()
  const dir = requireProjectDir(String(options?.projectDir ?? ''), { mustExist: false })
  const projectsRoot = optionalAbsoluteRoot(options?.projectsRoot)
  const requestedId = typeof options?.projectId === 'string' ? options.projectId : ''
  /** @type {Array<{code: string, message: string, action: string}>} */
  const needsHandling = []
  /** @type {string[]} */
  const notRun = []
  /** @type {any} */
  const detected = {
    projectDirPresent: false,
    projectFileReadable: false,
    schemaGeneration: null,
    projectPhase: '',
    executionState: '',
    workPositionPresent: false,
    positionRevision: '',
    versions: null,
    interruptedWrites: [],
    materialsDegraded: null,
    tools: null,
    execution: null,
    projectLock: null,
    cleanShutdown: null,
    recoveryReadable: true,
  }
  let position = null
  let projectId = requestedId

  // 1. the project directory itself
  const dirState = statDirectory(dir)
  detected.projectDirPresent = dirState.present
  if (!dirState.present) {
    needsHandling.push(needsItem(
      dirState.code,
      `项目目录不可用：${dirState.reason}`,
      '检查该目录是否被移动、改名或删除；重新指向真实目录后再继续，不要按同名新建覆盖',
    ))
    notRun.push('project-file', 'work-position', 'versions', 'interrupted-writes', 'execution-marker', 'project-lock')
    return buildVerdict({ projectId, position, detected, needsHandling, notRun, clock })
  }

  // 2. project.json and the schema generation this build can read
  const projectPath = path.join(dir, PROJECT_LAYOUT.projectFile)
  const projectState = readProjectDocument(projectPath)
  detected.projectFileReadable = projectState.ok
  if (!projectState.ok) {
    needsHandling.push(needsItem(projectState.code, projectState.message, projectState.action))
    notRun.push('work-position', 'versions', 'execution-marker', 'project-lock')
    scanInterruptedWrites(dir, detected)
    return buildVerdict({ projectId, position, detected, needsHandling, notRun, clock })
  }
  detected.schemaGeneration = projectState.generation
  detected.projectPhase = String(projectState.value?.phase ?? '')
  detected.executionState = String(projectState.value?.execution ?? '')
  projectId = projectId.length > 0 ? projectId : String(projectState.value?.projectId ?? '')

  // 3. leftover temp files: the last write never published, so the saved state may be older
  scanInterruptedWrites(dir, detected)
  for (const leftover of detected.interruptedWrites) {
    needsHandling.push(needsItem(
      NeedsAttentionCode.FILE_BUSY,
      `上次写入没有完成发布（残留 ${leftover.relativePath}）`,
      '核对上次修改是否还在；该临时文件保留作证据，清理是另一件事，程序不会自动删除或重写',
      { relativePath: leftover.relativePath, ownerAlive: leftover.ownerAlive },
    ))
  }

  // 4. the saved work position
  const positionPath = path.join(dir, PROJECT_LAYOUT.workPositionFile)
  const storedPosition = tryReadDocument(positionPath, { kind: 'work-position' })
  detected.workPositionPresent = storedPosition !== null
  if (storedPosition === null) {
    needsHandling.push(needsItem(
      NeedsAttentionCode.EXECUTION_UNKNOWN,
      '没有找到保存的工作位置，上次停在哪里未知',
      '先按已暂停处理：从项目当前状态重新开始，不要自动重试上次的外部动作',
    ))
  } else {
    position = pickPosition(storedPosition.value)
    detected.positionRevision = storedPosition.revision
  }

  // 5. the version the position points at must still exist
  detected.versions = inspectVersions(dir, position, needsHandling, notRun)

  // 6. materials, through the injected checker only
  inspectMaterials(options, needsHandling, notRun, detected)

  // 7. external tools, through the injected probe only
  inspectTools(options, needsHandling, notRun, detected)

  // 8. the recovery marker: was the previous run finished properly?
  const recoveryState = readRecoveryMarker(dir)
  detected.cleanShutdown = recoveryState.cleanShutdown
  detected.recoveryReadable = recoveryState.readable
  if (!recoveryState.readable) {
    needsHandling.push(needsItem(
      NeedsAttentionCode.PROJECT_FILE_CORRUPT,
      '上次的保存继续记录（recovery.json）无法解析',
      '该文件保留作证据；不要据此猜测上次位置，按当前项目状态重新确认后再继续',
    ))
  } else if (position !== null && recoveryState.cleanShutdown?.clean !== true) {
    needsHandling.push(needsItem(
      NeedsAttentionCode.EXECUTION_UNKNOWN,
      '上次没有正常收尾（没有记录安全暂停），当时的执行状态未知',
      '先按已暂停处理：核对真实结果后再决定是否继续，不会自动重复外部动作',
    ))
  }

  // 9. the execution marker: an open marker from a dead process means unknown state
  const marker = inspectMarker(options, projectsRoot, projectId, notRun)
  detected.execution = marker
  const unknownExecution = unknownExecutionResult(marker)
  if (unknownExecution.doNotRepeat) {
    needsHandling.push(needsItem(unknownExecution.code, unknownExecution.message, unknownExecution.action, {
      ownerPid: marker?.detail?.ownerPid ?? -1,
    }))
  }

  // 10. a leftover project edit lock is reported and never stolen
  inspectProjectLock(projectsRoot, projectId, needsHandling, notRun, detected)

  return buildVerdict({ projectId, position, detected, needsHandling, notRun, clock })
}

/**
 * Classify an interrupted external action: 状态未知先暂停，不自动重复外部动作.
 *
 * CT-01 §4 and CT-03 §2: the machine's state after a crash is unknowable, so the product shows
 * paused and never repeats the external action. `doNotRepeat` is the field a caller must check
 * before scheduling anything again.
 *
 * @param {ReturnType<typeof inspectExecution> | null | undefined} markerInspected
 * @returns {{
 *   state: 'unknown' | 'running' | 'idle',
 *   code: string | null,
 *   doNotRepeat: boolean,
 *   message: string,
 *   action: string,
 *   detail: object | null,
 * }}
 */
export function unknownExecutionResult(markerInspected) {
  const inspected = markerInspected ?? null
  const present = inspected?.present === true
  const open = inspected?.open === true
  const state = present ? String(inspected?.state ?? 'unknown') : 'idle'
  const detail = inspected?.detail ?? null
  if (open && state === 'unknown') {
    return {
      state: 'unknown',
      code: NeedsAttentionCode.EXECUTION_UNKNOWN,
      doNotRepeat: true,
      message: '有一个外部动作没有正常收尾，真实结果未知',
      action: '先按已暂停处理，核对真实结果后再决定是否继续；不要自动重复该外部动作',
      detail,
    }
  }
  if (open && state === 'running') {
    return {
      state: 'running',
      code: null,
      doNotRepeat: false,
      message: '记录显示仍有任务在运行',
      action: '确认它确实仍在运行；不要同时再发起同一个外部动作',
      detail,
    }
  }
  return { state: 'idle', code: null, doNotRepeat: false, message: '', action: '', detail }
}

// ---- position document ---------------------------------------------------------------------

/**
 * Validate and freeze the fields a work position may contain.
 * @param {string} projectId @param {any} position @param {string} savedAt
 * @returns {object}
 */
function buildWorkPositionBody(projectId, position, savedAt) {
  const versionId = optionalText(position.versionId, 'versionId')
  if (versionId.length > 0) assertId(versionId, 'version', 'versionId')
  const playhead = position.playheadFrame
  if (playhead !== undefined && playhead !== null) {
    if (!Number.isInteger(playhead) || playhead < 0) {
      throw new ValidationError('播放头必须是大于等于 0 的整数帧', { field: 'playheadFrame' })
    }
  }
  const surface = optionalText(position.workSurface, 'workSurface')
  if (surface.length > MAX_SURFACE_LENGTH) {
    throw new ValidationError('工作面名称过长', { field: 'workSurface', length: surface.length })
  }
  let autosavedAt = optionalText(position.autosavedAt, 'autosavedAt')
  if (autosavedAt.length === 0) autosavedAt = savedAt
  if (Number.isNaN(Date.parse(autosavedAt))) {
    throw new ValidationError('自动保存时间必须是 ISO 时间', { field: 'autosavedAt' })
  }
  return {
    projectId,
    versionId,
    playheadFrame: playhead === undefined || playhead === null ? 0 : playhead,
    selectedObjectId: optionalText(position.selectedObjectId, 'selectedObjectId'),
    workSurface: surface,
    panelState: serializableOrNull(position.panelState, 'panelState'),
    openDocument: serializableOrNull(position.openDocument, 'openDocument'),
    autosavedAt,
  }
}

/**
 * Keep only the documented position fields, so a stored extra never leaks into a restored UI.
 * @param {any} document
 * @returns {object}
 */
function pickPosition(document) {
  /** @type {any} */
  const picked = {}
  for (const field of WORK_POSITION_FIELDS) picked[field] = document?.[field] ?? null
  if (typeof picked.playheadFrame !== 'number') picked.playheadFrame = 0
  return picked
}

/** @param {unknown} value @param {string} field @returns {string} */
function optionalText(value, field) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new ValidationError(`${field} 必须是文本`, { field })
  return value.trim()
}

/**
 * Prove a value survives a JSON round-trip before storing it.
 *
 * `JSON.stringify` accepts values that silently change meaning: a `Map` or `Set` becomes `{}`, a
 * function or `undefined` inside an array becomes `null`, and a class instance keeps only its
 * enumerable data. Storing any of those would restore a position the user never saved, so they are
 * refused with the field name instead of being written and forgotten.
 *
 * @param {unknown} value @param {string} field
 * @returns {any}
 */
function serializableOrNull(value, field) {
  if (value === undefined || value === null) return null
  const problem = findUnserializable(value, 'value', 0)
  if (problem !== null) {
    throw new ValidationError(`${field} 含无法保存的内容`, { field, reason: problem })
  }
  let text
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new ValidationError(`${field} 含无法保存的内容`, { field, reason: error?.name ?? 'unknown' })
  }
  if (text === undefined) return null
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    throw new ValidationError(`${field} 过大，无法保存为工作位置`, { field })
  }
  return JSON.parse(text)
}

/**
 * Find the first part of a value that a JSON round-trip would silently change.
 * @param {any} value @param {string} where @param {number} depth
 * @returns {string | null}
 */
function findUnserializable(value, where, depth) {
  if (depth > 20) return `${where}:too-deep`
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') {
    if (type === 'number' && !Number.isFinite(value)) return `${where}:not-finite`
    return null
  }
  if (type === 'undefined') return `${where}:undefined`
  if (type === 'function' || type === 'symbol' || type === 'bigint') return `${where}:${type}`
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnserializable(value[index], `${where}[${index}]`, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    // A Date/Map/Set/class instance: `JSON.stringify` either changes it or drops its contents.
    const name = value?.constructor?.name
    return `${where}:${typeof name === 'string' ? name : 'non-plain-object'}`
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue
    const found = findUnserializable(child, `${where}.${key}`, depth + 1)
    if (found !== null) return found
  }
  return null
}

// ---- project document and differences -------------------------------------------------------

/**
 * Read `project.json` and report the real difference when it cannot be used.
 * @param {string} projectPath
 * @returns {{ ok: true, value: any, generation: number } |
 *   { ok: false, code: string, message: string, action: string }}
 */
function readProjectDocument(projectPath) {
  if (!pathExists(projectPath)) {
    return {
      ok: false,
      code: NeedsAttentionCode.PROJECT_DIR_MOVED,
      message: '项目目录存在但缺少 project.json，该目录可能不是这个项目',
      action: '确认项目是否被移动或替换成同名目录；不要在这里新建项目覆盖',
    }
  }
  try {
    const stored = readDocument(projectPath, { kind: 'project', expectedGeneration: CURRENT_SCHEMA_GENERATION })
    return { ok: true, value: stored.value, generation: stored.schemaGeneration }
  } catch (error) {
    const code = error?.code === 'UNSUPPORTED'
      ? NeedsAttentionCode.SCHEMA_TOO_NEW
      : error?.code === 'IO_FAILED' && error?.details?.reason === 'EACCES'
        ? NeedsAttentionCode.PERMISSION_DENIED
        : NeedsAttentionCode.PROJECT_FILE_CORRUPT
    const stage = String(error?.details?.stage ?? 'unknown')
    return {
      ok: false,
      code,
      message: code === NeedsAttentionCode.SCHEMA_TOO_NEW
        ? '项目文件由更新版本写入，当前版本不能安全读取'
        : code === NeedsAttentionCode.PERMISSION_DENIED
          ? '项目文件无法读取（权限不足）'
          : `项目文件无法使用（${stage}）`,
      action: code === NeedsAttentionCode.SCHEMA_TOO_NEW
        ? '用写入该项目的更新版本打开；不得降级覆盖该项目文件'
        : code === NeedsAttentionCode.PERMISSION_DENIED
          ? '修复该目录的访问权限后重新检查；不要让程序改用别的目录'
          : '保留原文件作证据并从其他备份核对；不要用空项目覆盖',
    }
  }
}

/**
 * Check whether the saved position still points at an existing version.
 *
 * Three outcomes, deliberately distinguished so the product never claims more than it knows:
 * - `savedVersionPresent === true` — the id is in the index;
 * - `savedVersionPresent === false` — the index EXISTS and does not contain it: a real difference;
 * - `savedVersionPresent === null` — the project has no version history to check against (no index
 *   file), which is the normal state of a project that has not produced a version yet. That is
 *   recorded in `notRun` rather than reported as a fault: a brand-new project must be able to
 *   continue, and inventing a "version missing" defect there would block every first session.
 *
 * @param {string} dir
 * @param {object | null} position
 * @param {Array<object>} needsHandling
 * @param {string[]} notRun
 * @returns {{ indexPresent: boolean, count: number, savedVersionPresent: boolean | null }}
 */
function inspectVersions(dir, position, needsHandling, notRun) {
  const wanted = typeof position?.versionId === 'string' ? position.versionId : ''
  const indexPath = path.join(dir, PROJECT_LAYOUT.versionsIndex)
  let stored
  try {
    stored = tryReadDocument(indexPath, { kind: 'versions' })
  } catch (error) {
    if (wanted.length === 0) {
      notRun.push('versions')
      return { indexPresent: true, count: 0, savedVersionPresent: null }
    }
    needsHandling.push(needsItem(
      NeedsAttentionCode.CANDIDATE_NEEDS_RECHECK,
      '版本索引无法读取，无法确认保存位置对应的版本',
      '核对版本目录里实际存在的版本；不要按猜测的版本继续，也不要重建索引覆盖现有记录',
      { reason: error?.code ?? 'unreadable', versionId: wanted },
    ))
    return { indexPresent: true, count: 0, savedVersionPresent: null }
  }
  if (stored === null) {
    // No version history exists yet, so the saved version id cannot be verified either way.
    notRun.push('versions')
    return { indexPresent: false, count: 0, savedVersionPresent: null }
  }
  const ids = collectVersionIds(stored.value)
  const present = wanted.length === 0 ? null : ids.includes(wanted)
  if (present === false) {
    needsHandling.push(needsItem(
      NeedsAttentionCode.CANDIDATE_NEEDS_RECHECK,
      `保存位置指向的版本已不在版本索引中（版本 ${wanted}）`,
      '核对版本目录和最近一次版本变化，重新确认要恢复的版本；程序不会猜一个替代版本',
      { versionId: wanted, knownVersions: ids.length },
    ))
  }
  return { indexPresent: true, count: ids.length, savedVersionPresent: present }
}

/**
 * Pull version ids out of a stored index without assuming a single internal shape.
 *
 * `versions.js` is owned by another part of this card and this module must not import it, so the
 * check collects every value that IS a version id wherever it appears. That keeps the check real
 * while staying compatible with a shape that is still being finalised, and it cannot invent a
 * version id: only the prefixed id format is accepted.
 *
 * @param {any} value
 * @returns {string[]}
 */
function collectVersionIds(value) {
  /** @type {Set<string>} */
  const ids = new Set()
  /** @param {any} node @param {number} depth */
  const walk = (node, depth) => {
    if (depth > 8 || node === null || node === undefined) return
    if (typeof node === 'string') {
      if (isId(node, 'version')) ids.add(node)
      return
    }
    if (typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1)
      return
    }
    for (const child of Object.values(node)) walk(child, depth + 1)
  }
  walk(value, 0)
  return [...ids].sort()
}

/**
 * Report leftover temp files: evidence that the last write did not publish.
 * @param {string} dir @param {any} detected
 */
function scanInterruptedWrites(dir, detected) {
  const leftovers = []
  for (const relative of STATE_DIRS) {
    const scanDir = relative.length === 0 ? dir : path.join(dir, relative)
    let entries
    try {
      entries = fs.readdirSync(scanDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(TEMP_SUFFIX)) continue
      const ownerPid = pidFromTempName(entry.name)
      leftovers.push({
        relativePath: relative.length === 0 ? entry.name : `${relative}/${entry.name}`,
        ownerPid,
        ownerAlive: ownerPid === null ? false : isProcessAlive(ownerPid),
      })
    }
  }
  leftovers.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  detected.interruptedWrites = leftovers
}

/**
 * Owning PID encoded in a temp file name, or `null` when it cannot be parsed.
 * @param {string} name e.g. `.project.json.12345.ab12cd.tmp-write`
 * @returns {number | null}
 */
function pidFromTempName(name) {
  const match = name.match(/\.(\d+)\.[0-9a-f]+\.tmp-write$/)
  if (match === null) return null
  const pid = Number(match[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

// ---- injected checks ------------------------------------------------------------------------

/**
 * Run the injected material check. This module never imports `materials.js`: material
 * availability belongs to that module, so it is passed in and its real answer is used as-is.
 * @param {any} options @param {Array<object>} needsHandling @param {string[]} notRun @param {any} detected
 */
function inspectMaterials(options, needsHandling, notRun, detected) {
  const check = options?.materialCheck
  if (typeof check !== 'function') {
    notRun.push('material-check', 'material-hash-check')
    return
  }
  let results
  try {
    results = check([])
  } catch (error) {
    notRun.push(`material-check:${error?.code ?? 'failed'}`)
    detected.materialsDegraded = { error: String(error?.code ?? 'failed') }
    return
  }
  if (!Array.isArray(results)) {
    notRun.push('material-check:not-an-array')
    return
  }
  detected.materialsDegraded = []
  for (const entry of results) {
    const id = String(entry?.id ?? '')
    const available = entry?.available === true
    const provided = typeof entry?.code === 'string' ? entry.code : ''
    const code = isAttentionCode(provided)
      ? provided
      : available
        ? ''
        : NeedsAttentionCode.MATERIAL_MISSING
    if (code.length === 0) continue
    const hashMismatch = code === NeedsAttentionCode.MATERIAL_HASH_MISMATCH
    needsHandling.push(needsItem(
      code,
      hashMismatch ? `素材内容与记录不一致（素材 ${id}）` : `素材文件缺失或不可用（素材 ${id}）`,
      hashMismatch
        ? '核对素材是否被替换；不要用不匹配的文件冒充原素材，也不要静默更新记录'
        : '把素材补回原位置或重新指向可用的素材；补件后重新检查，不会自动跳过缺失素材',
      { materialId: id },
    ))
    detected.materialsDegraded.push({ id, code })
  }
}

/**
 * Run the injected tool probe (or use static tool facts when none was injected).
 * @param {any} options @param {Array<object>} needsHandling @param {string[]} notRun @param {any} detected
 */
function inspectTools(options, needsHandling, notRun, detected) {
  const check = options?.toolCheck
  let results = null
  if (typeof check === 'function') {
    try {
      results = check()
    } catch (error) {
      notRun.push(`tool-check:${error?.code ?? 'failed'}`)
      return
    }
  } else if (Array.isArray(options?.requiredTools)) {
    results = options.requiredTools
  } else {
    notRun.push('tool-check')
    return
  }
  if (!Array.isArray(results)) {
    notRun.push('tool-check:not-an-array')
    return
  }
  detected.tools = []
  for (const entry of results) {
    const name = String(entry?.name ?? '')
    const available = entry?.available === true
    detected.tools.push({ name, available })
    if (available) continue
    needsHandling.push(needsItem(
      NeedsAttentionCode.EXTERNAL_TOOL_MISSING,
      `缺少需要的外部工具：${name.length > 0 ? name : '未具名工具'}`,
      '安装或指向可用的工具后重新检查；程序不会自动安装，也不会改用其他工具顶替',
      { toolName: name },
    ))
  }
}

// ---- state files ----------------------------------------------------------------------------

/**
 * Read the recovery marker, distinguishing "absent" from "unreadable".
 * @param {string} dir
 * @returns {{ readable: boolean, cleanShutdown: null | { clean: boolean, at: string, reason: string } }}
 */
function readRecoveryMarker(dir) {
  const recoveryPath = path.join(dir, PROJECT_LAYOUT.recoveryFile)
  if (!pathExists(recoveryPath)) return { readable: true, cleanShutdown: null }
  let stored
  try {
    stored = tryReadDocument(recoveryPath, { kind: 'recovery' })
  } catch {
    return { readable: false, cleanShutdown: null }
  }
  if (stored === null) return { readable: true, cleanShutdown: null }
  const marker = stored.value?.cleanShutdown
  if (marker === null || marker === undefined || typeof marker !== 'object') {
    return { readable: true, cleanShutdown: null }
  }
  return {
    readable: true,
    cleanShutdown: {
      clean: marker.clean === true,
      at: String(marker.at ?? ''),
      reason: String(marker.reason ?? ''),
    },
  }
}

/**
 * Inspect the execution marker. A marker belongs to the whole root, so it is only treated as this
 * project's state when it names this project (or names none, in which case it is not ignored).
 * @param {any} options @param {string} projectsRoot @param {string} projectId @param {string[]} notRun
 * @returns {ReturnType<typeof inspectExecution> | null}
 */
function inspectMarker(options, projectsRoot, projectId, notRun) {
  let markerPath = typeof options?.markerPath === 'string' ? options.markerPath : ''
  if (markerPath.length === 0) {
    if (projectsRoot.length === 0) {
      notRun.push('execution-marker')
      return null
    }
    markerPath = executionMarkerPath(projectsRoot)
  }
  const inspected = inspectExecution(markerPath)
  if (!inspected.present) return inspected
  const markerProjectId = String(inspected.detail?.projectId ?? '')
  if (markerProjectId.length > 0 && projectId.length > 0 && markerProjectId !== projectId) {
    // Another project's task is marked open; that is real, but it is not this project's state.
    return {
      ...inspected,
      present: true,
      open: false,
      state: 'idle',
      detail: { ...inspected.detail, otherProject: true },
    }
  }
  return inspected
}

/**
 * Report a project edit lock. A stale lock is reported and NEVER taken over here.
 *
 * @param {string} projectsRoot
 * @param {string} projectId
 * @param {Array<object>} needsHandling
 * @param {string[]} notRun
 * @param {any} detected
 */
function inspectProjectLock(projectsRoot, projectId, needsHandling, notRun, detected) {
  if (projectsRoot.length === 0 || !isId(projectId, 'project')) {
    notRun.push('project-lock')
    return
  }
  const lockPath = projectEditLockPath(projectsRoot, projectId)
  const inspected = inspectLockForRecovery(lockPath)
  detected.projectLock = inspected
  if (inspected === null || inspected.stale !== true || inspected.ownLock) return
  needsHandling.push(needsItem(
    NeedsAttentionCode.LOCK_STALE,
    '检测到上次遗留的项目写入锁，需要处理',
    '确认该写入者已停止后，由你在“需要处理”中选择接管；程序不会自动删除这把锁',
    { ownerLabel: inspected.record.ownerLabel, taskId: inspected.record.taskId },
  ))
}

/**
 * Inspect a lock file without acquiring it, tolerating an unreadable file.
 *
 * An unreadable lock is reported as stale, matching `base.inspectLock`: "cannot read it" is a
 * conflict that needs handling, never "no lock".
 *
 * @param {string} lockPath
 * @returns {null | { held: boolean, stale: boolean, ownerAlive: boolean, ownLock: boolean,
 *   record: { ownerLabel: string, taskId: string }, ageMs: number }}
 */
function inspectLockForRecovery(lockPath) {
  if (!pathExists(lockPath)) return null
  const inspected = inspectLock(lockPath)
  if (inspected === null) return null
  const ownLock =
    inspected.record?.ownerPid === process.pid &&
    inspected.record?.ownerInstanceId === PROCESS_INSTANCE.instanceId
  return {
    held: true,
    stale: inspected.stale === true,
    ownerAlive: inspected.ownerAlive === true,
    ownLock,
    record: {
      ownerLabel: String(inspected.record?.ownerLabel ?? ''),
      taskId: String(inspected.record?.taskId ?? ''),
    },
    ageMs: inspected.ageMs,
  }
}

// ---- verdict assembly ------------------------------------------------------------------------

/**
 * Assemble the structured verdict a surface renders.
 * @param {{ projectId: string, position: object | null, detected: any, needsHandling: object[],
 *   notRun: string[], clock: Clock }} input
 * @returns {object}
 */
function buildVerdict(input) {
  const uniqueNotRun = [...new Set(input.notRun)]
  const needsHandling = dedupeNeedsHandling(input.needsHandling)
  const canContinue = input.position !== null && needsHandling.length === 0
  const headline = canContinue
    ? '可以继续：已读取上次保存位置'
    : `需要处理：${needsHandling.length} 项差异需要确认`
  return {
    projectId: input.projectId,
    canContinue,
    verdict: canContinue ? RECOVERY_VERDICTS.CAN_CONTINUE : RECOVERY_VERDICTS.NEEDS_HANDLING,
    position: input.position,
    detected: input.detected,
    needsHandling,
    notRun: uniqueNotRun,
    // Honesty flag: "可以继续" never means every check ran. A surface shows `notRun` so a
    // skipped material/tool/lock check is visible instead of being read as a pass.
    degraded: uniqueNotRun.length > 0,
    doNotRepeatExternalActions: needsHandling.some(
      (item) => item.code === NeedsAttentionCode.EXECUTION_UNKNOWN,
    ),
    headline,
    inspectedAt: input.clock.iso(),
  }
}

/**
 * Drop a repeated code+message pair so one real difference is not shown twice.
 * @param {Array<{code: string, message: string}>} items
 * @returns {Array<any>}
 */
function dedupeNeedsHandling(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = `${item.code}\u0000${item.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** @param {string} code @param {string} message @param {string} action @param {object} [detail] */
function needsItem(code, message, action, detail) {
  return { code, message, action, ...(detail ?? {}) }
}

/** @param {string} code @returns {boolean} */
function isAttentionCode(code) {
  return typeof code === 'string' && Object.values(NeedsAttentionCode).includes(code)
}

// ---- small fs helpers -----------------------------------------------------------------------

/**
 * Validate a caller-supplied project directory path.
 * @param {string} projectDir
 * @param {{ mustExist?: boolean }} [options]
 * @returns {string} resolved absolute path
 */
function requireProjectDir(projectDir, options = {}) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new ValidationError('需要项目目录', { field: 'projectDir' })
  }
  if (!path.isAbsolute(projectDir)) {
    throw new ValidationError('项目目录必须是绝对路径', { field: 'projectDir' })
  }
  const resolved = path.resolve(projectDir)
  if (options.mustExist !== false && !pathExists(resolved)) {
    throw new NotFoundError('项目目录不存在', {
      action: '检查项目是否被移动或删除；不要按同名新建覆盖',
    })
  }
  return resolved
}

/** @param {unknown} value @returns {string} */
function optionalAbsoluteRoot(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (!path.isAbsolute(value)) {
    throw new ValidationError('项目根目录必须是绝对路径', { field: 'projectsRoot' })
  }
  return path.resolve(value)
}

/**
 * Whether a directory is present and reachable, with the real reason when it is not.
 * @param {string} dir
 * @returns {{ present: boolean, code: string, reason: string }}
 */
function statDirectory(dir) {
  try {
    const stat = fs.statSync(dir)
    if (!stat.isDirectory()) {
      return { present: false, code: NeedsAttentionCode.PROJECT_DIR_MOVED, reason: '该路径不是目录' }
    }
    fs.accessSync(dir, fs.constants.R_OK)
    return { present: true, code: '', reason: '' }
  } catch (error) {
    const code = error?.code
    if (code === 'EACCES' || code === 'EPERM') {
      return { present: false, code: NeedsAttentionCode.PERMISSION_DENIED, reason: '没有读取权限' }
    }
    return { present: false, code: NeedsAttentionCode.PROJECT_DIR_MISSING, reason: code ?? 'not-found' }
  }
}

/** @param {string} filePath */
function ensureParentDir(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  } catch (error) {
    throw new IoError('保存目录无法创建', {
      details: { reason: error?.code ?? 'unknown', stage: 'mkdir' },
      cause: error,
    })
  }
}

/**
 * Read a previous state document, tolerating absence.
 * @param {string} filePath @param {string} kind
 * @param {{ swallowCorruption?: boolean }} [options]
 * @returns {any | null}
 */
function tryReadSuperseded(filePath, kind, options = {}) {
  if (!pathExists(filePath)) return null
  try {
    return readDocument(filePath, { kind, expectedGeneration: CURRENT_SCHEMA_GENERATION })
  } catch (error) {
    if (options.swallowCorruption === true) return null
    throw error
  }
}

/**
 * Resolve the project id for an event, preferring the caller, then `project.json`, then the
 * directory name when it already looks like a project id.
 * @param {string} dir @param {unknown} provided
 * @returns {string}
 */
function resolveProjectId(dir, provided) {
  if (typeof provided === 'string' && provided.length > 0) return assertId(provided, 'project', 'projectId')
  try {
    const stored = readDocument(path.join(dir, PROJECT_LAYOUT.projectFile), {
      kind: 'project',
      expectedGeneration: CURRENT_SCHEMA_GENERATION,
    })
    if (isId(stored.value?.projectId, 'project')) return stored.value.projectId
  } catch {
    // A missing or unreadable project.json is reported by inspectRecovery; a clean pause must
    // still be recorded if it can be, so this falls through to the directory name.
  }
  const baseName = path.basename(dir)
  return isId(baseName, 'project') ? baseName : ''
}

/**
 * Append one event, reporting rather than throwing when the log cannot be written.
 *
 * The dispose path must not fail because a log is unwritable (CT-01 §4 ~5 s budget), and the
 * marker itself is already durable at this point.
 *
 * @param {string} dir @param {string} projectId @param {object} eventInput @param {Clock} clock
 * @returns {{ eventRecorded: boolean, eventSkipped: string }}
 */
function recordEvent(dir, projectId, eventInput, clock) {
  if (projectId.length === 0) return { eventRecorded: false, eventSkipped: 'project-id-unknown' }
  try {
    appendEvents(dir, [buildEvent({ ...eventInput, projectId })], { clock })
    return { eventRecorded: true, eventSkipped: '' }
  } catch (error) {
    return { eventRecorded: false, eventSkipped: error?.code ?? 'event-write-failed' }
  }
}
