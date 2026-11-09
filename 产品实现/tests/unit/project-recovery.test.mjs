/**
 * Unit tests for core/project/recovery.js: the single 保存继续 flow.
 *
 * Every assertion reads a REAL file on disk. The recovery verdict is the one place a user is told
 * "可以继续", so these tests refuse to accept a returned object as evidence: the saved position,
 * the leftover temp file, the execution marker and the corrupt project file are all created by
 * the test and then re-read from the filesystem.
 *
 * Covers C10 card §6 items 2 (missing material / tool / directory) and 7, 11 (unknown state is
 * never repeated, interrupted write and corrupt data keep the original files).
 *
 * @module tests/unit/project-recovery.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, PROCESS_INSTANCE, createTempDir, writeJsonAtomic } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { newId } from '../../core/project/ids.js'
import { PROJECT_LAYOUT } from '../../core/project/paths.js'
import { writeDocument } from '../../core/project/store.js'
import { readEvents, ProjectEventKind } from '../../core/project/events.js'
import { beginExecution, executionMarkerPath } from '../../core/project/write-guard.js'
import { NeedsAttentionCode } from '../../core/project/schema.js'
import {
  RECOVERY_VERDICTS,
  WORK_POSITION_FIELDS,
  inspectRecovery,
  markCleanPause,
  readWorkPosition,
  saveWorkPosition,
  unknownExecutionResult,
} from '../../core/project/recovery.js'

const temp = createTempDir({ label: 'project-recovery' })
test.after(() => temp.dispose())

let projectCounter = 0

/** A real project directory created through the frozen spine. */
function makeProject() {
  projectCounter += 1
  const root = temp.dir(`root-${projectCounter}`)
  const created = createProject({
    projectsRoot: root,
    title: `恢复测试项目 ${projectCounter}`,
    coreGoal: '验证保存继续流程',
  })
  return { root, dir: created.paths.dir, projectId: created.project.projectId }
}

/**
 * Write a versions index that really contains one version, so a saved versionId is verifiable.
 * @param {string} dir
 * @param {string} projectId
 * @param {string} versionId
 */
function writeVersionsIndex(dir, projectId, versionId) {
  writeDocument(path.join(dir, PROJECT_LAYOUT.versionsIndex), {
    projectId,
    versions: [{ versionId, versionClass: 'current', substate: 'draft' }],
  }, { kind: 'versions', schemaKey: 'versions' })
}

/** A saved position with every documented field set to a distinct value. */
function fullPosition(projectId, versionId) {
  return {
    projectId,
    versionId,
    playheadFrame: 137,
    selectedObjectId: 'obj_MAIN_TITLE',
    workSurface: 'edit',
    panelState: { left: 'materials', right: 'properties', zoom: 0.75 },
    openDocument: { kind: 'timeline', timelineId: 'tl_1', scrollFrame: 42 },
  }
}

/** Both injected checkers reporting everything available. */
function healthyChecks() {
  return {
    materialCheck: () => [
      { id: 'mat_a', available: true },
      { id: 'mat_b', available: true },
    ],
    toolCheck: () => [{ name: 'ffmpeg', available: true }],
  }
}

test('saveWorkPosition: writes real position and recovery files and records the autosave', () => {
  const { dir, projectId } = makeProject()
  const versionId = newId('version')
  writeVersionsIndex(dir, projectId, versionId)
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })

  const saved = saveWorkPosition(dir, fullPosition(projectId, versionId), { clock })

  const positionPath = path.join(dir, PROJECT_LAYOUT.workPositionFile)
  const recoveryPath = path.join(dir, PROJECT_LAYOUT.recoveryFile)
  assert.equal(fs.existsSync(positionPath), true, 'work/position.json 必须真实存在')
  assert.equal(fs.existsSync(recoveryPath), true, 'recovery.json 必须真实存在')

  const onDisk = JSON.parse(fs.readFileSync(positionPath, 'utf8'))
  assert.equal(onDisk.playheadFrame, 137)
  assert.equal(onDisk.versionId, versionId)
  assert.deepEqual(onDisk.panelState, { left: 'materials', right: 'properties', zoom: 0.75 })
  assert.equal(saved.positionRevision, onDisk.revision)

  const marker = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'))
  assert.equal(marker.schemaKey, undefined, 'recovery.json 不写别名，只写 schemaVersion')
  assert.equal(marker.schemaVersion, 1)
  assert.equal(marker.cleanShutdown.clean, false, '工作未结束前不得标记为干净收尾')
  assert.equal(marker.lastAutosave.versionId, versionId)
  assert.equal(marker.lastAutosave.playheadFrame, 137)

  const { events } = readEvents(dir, { kinds: [ProjectEventKind.AUTOSAVE_COMPLETED] })
  assert.equal(events.length, 1, '自动保存必须留下一条可追溯事件')
  assert.equal(events[0].detail.positionRevision, saved.positionRevision)
})

test('saveWorkPosition: accepts the single-object form the public facade exposes', () => {
  const { dir, projectId } = makeProject()
  const visible = newId('version')
  writeVersionsIndex(dir, projectId, visible)
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })

  const saved = saveWorkPosition({
    projectDir: dir,
    projectId,
    versionId: visible,
    playheadFrame: 42,
    selectedObjectId: 'obj_opening',
    workSurface: 'creation',
    panelState: { right: 'properties' },
    clock,
  })

  assert.equal(saved.canContinue, true, '一次成功的保存把位置写进磁盘，可以据此恢复')
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, PROJECT_LAYOUT.workPositionFile), 'utf8'))
  assert.equal(onDisk.playheadFrame, 42)
  assert.equal(onDisk.projectId, projectId, 'projectDir 不得被当作位置字段写进磁盘')
  assert.equal(onDisk.projectDir, undefined)

  const paused = markCleanPause({ projectDir: dir, reason: '用户退出', clock })
  assert.equal(paused.cleanShutdown.clean, true)
})

test('saveWorkPosition: refuses a non-integer playhead instead of storing a bad position', () => {
  const { dir, projectId } = makeProject()
  const position = { projectId, playheadFrame: 12.5 }
  assert.throws(() => saveWorkPosition(dir, position), (error) => error.code === 'VALIDATION_FAILED')
  assert.equal(fs.existsSync(path.join(dir, PROJECT_LAYOUT.workPositionFile)), false)
})

test('saveWorkPosition: refuses a value that cannot survive a JSON round-trip', () => {
  const { dir, projectId } = makeProject()
  const position = { projectId, panelState: { map: new Map([['a', 1]]) } }
  assert.throws(() => saveWorkPosition(dir, position), (error) => error.code === 'VALIDATION_FAILED')
})

test('inspectRecovery: a clean state says 可以继续 and returns the exact saved position', () => {
  const { root, dir, projectId } = makeProject()
  const versionId = newId('version')
  writeVersionsIndex(dir, projectId, versionId)
  const expected = fullPosition(projectId, versionId)
  saveWorkPosition(dir, expected)
  markCleanPause(dir, { reason: 'host-dispose' })

  const verdict = inspectRecovery({ projectDir: dir, projectsRoot: root, projectId, ...healthyChecks() })

  assert.equal(verdict.canContinue, true)
  assert.equal(verdict.verdict, RECOVERY_VERDICTS.CAN_CONTINUE)
  assert.deepEqual(verdict.needsHandling, [])
  assert.deepEqual(verdict.notRun, [], '两个检查器都注入了，不得有未执行的检查')
  assert.equal(verdict.degraded, false)
  assert.equal(verdict.doNotRepeatExternalActions, false)

  // The position must round-trip field by field: a UI restores project/version/object/playhead/
  // surface/panels from exactly these values, so an extra or missing field is a real defect.
  assert.deepEqual(Object.keys(verdict.position).sort(), [...WORK_POSITION_FIELDS].sort())
  for (const field of WORK_POSITION_FIELDS) {
    if (field === 'autosavedAt') {
      assert.equal(typeof verdict.position[field], 'string')
      continue
    }
    assert.deepEqual(verdict.position[field], expected[field], `字段 ${field} 必须一致`)
  }
  assert.equal(verdict.detected.projectDirPresent, true)
  assert.equal(verdict.detected.projectFileReadable, true)
  assert.equal(verdict.detected.schemaGeneration, 1)
  assert.equal(verdict.detected.cleanShutdown.clean, true)
})

test('inspectRecovery: without injected checkers the skipped checks are listed, not passed', () => {
  const { dir, projectId } = makeProject()
  saveWorkPosition(dir, fullPosition(projectId, ''))
  markCleanPause(dir, { reason: 'host-dispose' })

  const verdict = inspectRecovery({ projectDir: dir })

  assert.equal(verdict.canContinue, true, '没有差异时可以继续')
  assert.equal(verdict.degraded, true, '未执行的检查必须可见')
  assert.ok(verdict.notRun.includes('material-check'))
  assert.ok(verdict.notRun.includes('tool-check'))
})

test('inspectRecovery: a missing material file is 需要处理 with a real next action', () => {
  const { root, dir, projectId } = makeProject()
  saveWorkPosition(dir, fullPosition(projectId, ''))
  markCleanPause(dir, { reason: 'host-dispose' })

  const verdict = inspectRecovery({
    projectDir: dir,
    projectsRoot: root,
    projectId,
    materialCheck: () => [
      { id: 'mat_present', available: true },
      { id: 'mat_gone', available: false },
      { id: 'mat_changed', available: false, code: NeedsAttentionCode.MATERIAL_HASH_MISMATCH },
    ],
    toolCheck: () => [{ name: 'ffmpeg', available: true }],
  })

  assert.equal(verdict.canContinue, false)
  assert.equal(verdict.verdict, RECOVERY_VERDICTS.NEEDS_HANDLING)
  const missing = verdict.needsHandling.find((item) => item.code === NeedsAttentionCode.MATERIAL_MISSING)
  assert.ok(missing, '缺失素材必须报 MATERIAL_MISSING')
  assert.match(missing.message, /mat_gone/)
  assert.ok(missing.action.length > 0, '需要处理必须有下一步动作')
  assert.match(missing.action, /补回|重新指向/)
  const mismatch = verdict.needsHandling.find(
    (item) => item.code === NeedsAttentionCode.MATERIAL_HASH_MISMATCH,
  )
  assert.ok(mismatch, '内容不一致必须与缺失区分')
  assert.match(mismatch.message, /mat_changed/)
})

test('inspectRecovery: a missing required tool reports EXTERNAL_TOOL_MISSING', () => {
  const { root, dir, projectId } = makeProject()
  saveWorkPosition(dir, fullPosition(projectId, ''))
  markCleanPause(dir, { reason: 'host-dispose' })

  const verdict = inspectRecovery({
    projectDir: dir,
    projectsRoot: root,
    projectId,
    materialCheck: () => [],
    toolCheck: () => [
      { name: 'ffmpeg', available: true },
      { name: 'ffprobe', available: false },
    ],
  })

  const missingTool = verdict.needsHandling.find(
    (item) => item.code === NeedsAttentionCode.EXTERNAL_TOOL_MISSING,
  )
  assert.ok(missingTool)
  assert.match(missingTool.message, /ffprobe/)
  assert.match(missingTool.action, /安装|指向/)
  assert.deepEqual(verdict.detected.tools, [
    { name: 'ffmpeg', available: true },
    { name: 'ffprobe', available: false },
  ])
})

test('inspectRecovery: an open execution marker with a dead owner is unknown, never retried', () => {
  const { root, dir, projectId } = makeProject()
  saveWorkPosition(dir, fullPosition(projectId, ''))
  markCleanPause(dir, { reason: 'host-dispose' })
  // A PID far beyond any real Windows process: the process that wrote the marker is gone.
  beginExecution(executionMarkerPath(root), {
    projectId,
    taskId: 'C13-render',
    startedAt: new Date(0).toISOString(),
    hostPid: 999_999,
  })

  const verdict = inspectRecovery({
    projectDir: dir,
    projectsRoot: root,
    projectId,
    ...healthyChecks(),
  })

  const unknown = verdict.needsHandling.find((item) => item.code === NeedsAttentionCode.EXECUTION_UNKNOWN)
  assert.ok(unknown, '未收尾的执行标记必须报 EXECUTION_UNKNOWN')
  assert.match(unknown.message, /未知/)
  assert.match(unknown.action, /先按已暂停处理/)
  assert.match(unknown.action, /不要自动重复/)
  assert.equal(verdict.canContinue, false)
  assert.equal(verdict.doNotRepeatExternalActions, true, '状态未知不得自动重复外部动作')
})

test('unknownExecutionResult: classifies an interrupted external action as unknown', () => {
  const dead = { present: true, open: true, state: 'unknown', detail: { ownerPid: 999_999 } }
  const result = unknownExecutionResult(dead)
  assert.equal(result.state, 'unknown')
  assert.equal(result.code, NeedsAttentionCode.EXECUTION_UNKNOWN)
  assert.equal(result.doNotRepeat, true)
  assert.match(result.action, /不要自动重复/)

  const idle = unknownExecutionResult({ present: false, open: false, state: 'idle', detail: null })
  assert.equal(idle.doNotRepeat, false)
  assert.equal(idle.code, null)

  const running = unknownExecutionResult({ present: true, open: true, state: 'running', detail: {} })
  assert.equal(running.doNotRepeat, false, '确认仍在运行时也不得再发起同一动作，但不是"未知"')
  assert.equal(running.state, 'running')
})

test('inspectRecovery: a leftover tmp-write is reported as an interrupted write and kept', () => {
  const { root, dir, projectId } = makeProject()
  saveWorkPosition(dir, fullPosition(projectId, ''))
  markCleanPause(dir, { reason: 'host-dispose' })
  // The name shape is the one base/atomic-write.js produces; pid 999999 is dead on purpose.
  const leftover = path.join(dir, `.${PROJECT_LAYOUT.projectFile}.999999.ab12cd${'.tmp-write'}`)
  fs.writeFileSync(leftover, '{"partial":true}', 'utf8')

  const verdict = inspectRecovery({ projectDir: dir, projectsRoot: root, projectId, ...healthyChecks() })

  const interrupted = verdict.needsHandling.find((item) => item.code === NeedsAttentionCode.FILE_BUSY)
  assert.ok(interrupted, '上次写入未发布必须报出来')
  assert.match(interrupted.message, /残留/)
  assert.equal(interrupted.ownerAlive, false)
  assert.equal(verdict.detected.interruptedWrites.length, 1)
  assert.equal(verdict.detected.interruptedWrites[0].relativePath.startsWith('.'), true)
  // This module diagnoses; deleting evidence is a separate, attributable action.
  assert.equal(fs.existsSync(leftover), true, '诊断不得删除残留临时文件')
})

test('inspectRecovery: corrupt project.json reports PROJECT_FILE_CORRUPT and keeps the bytes', () => {
  const { root, dir, projectId } = makeProject()
  const projectPath = path.join(dir, PROJECT_LAYOUT.projectFile)
  fs.writeFileSync(projectPath, '{ "projectId": "prj_truncated"', 'utf8')

  const verdict = inspectRecovery({ projectDir: dir, projectsRoot: root, projectId, ...healthyChecks() })

  assert.equal(verdict.canContinue, false)
  const corrupt = verdict.needsHandling.find((item) => item.code === NeedsAttentionCode.PROJECT_FILE_CORRUPT)
  assert.ok(corrupt, '损坏的项目文件必须单独报出')
  assert.match(corrupt.action, /保留原文件|不要用空项目覆盖/)
  assert.equal(verdict.position, null)
  assert.equal(verdict.detected.projectFileReadable, false)
  assert.match(fs.readFileSync(projectPath, 'utf8'), /prj_truncated/, '损坏的原文件不得被覆盖或删除')
})

test('inspectRecovery: an absent work position is 需要处理, not a crash', () => {
  const { root, dir, projectId } = makeProject()

  const verdict = inspectRecovery({ projectDir: dir, projectsRoot: root, projectId, ...healthyChecks() })

  assert.equal(verdict.canContinue, false)
  assert.equal(verdict.verdict, RECOVERY_VERDICTS.NEEDS_HANDLING)
  assert.equal(verdict.position, null)
  assert.equal(verdict.detected.workPositionPresent, false)
  const unknown = verdict.needsHandling.find((item) => item.code === NeedsAttentionCode.EXECUTION_UNKNOWN)
  assert.ok(unknown, '没有保存位置时状态未知，不能当作可以继续')
  assert.match(unknown.action, /不要自动重试/)
  assert.equal(verdict.doNotRepeatExternalActions, true)
})

test('inspectRecovery: a missing project directory reports PROJECT_DIR_MISSING', () => {
  const missingDir = path.join(temp.dir('missing-root'), 'prj_0000000000000000')
  const verdict = inspectRecovery({ projectDir: missingDir })
  assert.equal(verdict.verdict, RECOVERY_VERDICTS.NEEDS_HANDLING)
  assert.equal(verdict.needsHandling[0].code, NeedsAttentionCode.PROJECT_DIR_MISSING)
  assert.equal(verdict.canContinue, false)
})

test('inspectRecovery: a saved version that no longer exists is a real difference', () => {
  const { root, dir, projectId } = makeProject()
  const versionId = newId('version')
  writeVersionsIndex(dir, projectId, versionId)
  saveWorkPosition(dir, fullPosition(projectId, versionId))
  markCleanPause(dir, { reason: 'host-dispose' })
  // The version disappears after the position was saved (a cleaned-up candidate).
  writeDocument(path.join(dir, PROJECT_LAYOUT.versionsIndex), { projectId, versions: [] }, {
    kind: 'versions',
    schemaKey: 'versions',
    expectedRevision: JSON.parse(fs.readFileSync(path.join(dir, PROJECT_LAYOUT.versionsIndex), 'utf8')).revision,
  })

  const verdict = inspectRecovery({ projectDir: dir, projectsRoot: root, projectId, ...healthyChecks() })

  const recheck = verdict.needsHandling.find((item) => item.code === NeedsAttentionCode.CANDIDATE_NEEDS_RECHECK)
  assert.ok(recheck, '保存位置指向的版本不存在时必须重新核对')
  assert.match(recheck.message, new RegExp(`版本 ${versionId}`))
  assert.equal(verdict.detected.versions.savedVersionPresent, false)
})

test('inspectRecovery: a project with no version history still says 可以继续', () => {
  // A brand-new project has never produced a version, so a saved versionId cannot be verified
  // either way. Reporting it as a missing version would block every first session.
  const { root, dir, projectId } = makeProject()
  saveWorkPosition(dir, fullPosition(projectId, newId('version')))
  markCleanPause(dir, { reason: 'host-dispose' })

  const verdict = inspectRecovery({ projectDir: dir, projectsRoot: root, projectId, ...healthyChecks() })

  assert.equal(verdict.canContinue, true)
  assert.equal(verdict.detected.versions.indexPresent, false)
  assert.equal(verdict.detected.versions.savedVersionPresent, null, '没有版本历史时不可核验，不是缺失')
  assert.ok(verdict.notRun.includes('versions'), '未核验的检查必须列出来')
})

test('inspectRecovery: a stale project edit lock is reported and never stolen', () => {
  const { root, dir, projectId } = makeProject()
  saveWorkPosition(dir, fullPosition(projectId, ''))
  markCleanPause(dir, { reason: 'host-dispose' })
  const lockPath = path.join(root, '.locks', `lock.project-edit.${projectId}.json`)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  writeJsonAtomic(lockPath, {
    formatVersion: 1,
    lockKind: 'project-edit',
    scopeId: projectId,
    ownerPid: 999_999,
    ownerInstanceId: 'dead-instance',
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: '崩溃的写入者',
    taskId: 'C10-save',
    projectVersion: 'v1',
    acquiredAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  })

  const verdict = inspectRecovery({ projectDir: dir, projectsRoot: root, projectId, ...healthyChecks() })

  const staleLock = verdict.needsHandling.find((item) => item.code === NeedsAttentionCode.LOCK_STALE)
  assert.ok(staleLock, '陈旧项目锁必须报 LOCK_STALE')
  assert.match(staleLock.action, /不会自动删除/)
  assert.equal(fs.existsSync(lockPath), true, '陈旧锁必须保留，等待用户决定')
})

test('readWorkPosition: reads the position back from disk and null when never saved', () => {
  const { dir, projectId } = makeProject()
  assert.equal(readWorkPosition(dir), null)

  const versionId = newId('version')
  const expected = fullPosition(projectId, versionId)
  saveWorkPosition(dir, expected)

  const read = readWorkPosition(dir)
  assert.ok(read !== null)
  assert.equal(read.position.versionId, versionId)
  assert.equal(read.position.playheadFrame, expected.playheadFrame)
  assert.deepEqual(read.position.panelState, expected.panelState)
  assert.equal(typeof read.revision, 'string')
})

test('markCleanPause: keeps the autosave summary and records SAVE_PAUSED', () => {
  const { dir, projectId } = makeProject()
  saveWorkPosition(dir, fullPosition(projectId, ''))

  const paused = markCleanPause(dir, { reason: 'host-dispose' })

  assert.equal(paused.cleanShutdown.clean, true)
  assert.equal(paused.cleanShutdown.reason, 'host-dispose')
  assert.equal(paused.projectId, projectId)
  const marker = JSON.parse(fs.readFileSync(path.join(dir, PROJECT_LAYOUT.recoveryFile), 'utf8'))
  assert.equal(marker.cleanShutdown.clean, true)
  assert.ok(marker.lastAutosave !== null, '安全暂停不得丢弃上一个自动保存摘要')
  const { events } = readEvents(dir, { kinds: [ProjectEventKind.SAVE_PAUSED] })
  assert.equal(events.length, 1)
  assert.equal(paused.eventRecorded, true)
})

test('markCleanPause: a missing project directory is refused, not silently ignored', () => {
  const missing = path.join(temp.dir('missing-again'), 'prj_0000000000000000')
  assert.throws(() => markCleanPause(missing, { reason: 'x' }), (error) => error.code === 'NOT_FOUND')
})
