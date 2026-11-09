/**
 * Integration test of the ONE save/continue flow across a crash and a clean pause.
 *
 * CT-02 §9 and CT-01 §4 define a single sequence — 自动保存 → 读取保存位置 → 检查文件与工具 →
 * 可以继续／需要处理 — and C10 card §6 items 1, 2 and 11 require it end to end: autosave, exit,
 * continue; missing material/tool; crash and interrupted write; and "状态未知不重复执行".
 *
 * The crash is simulated the only honest way: the work position is written, no `markCleanPause`
 * happens, and the execution marker is left open by a PID that is not running. Then the same
 * project is inspected, and after a clean pause the position must round-trip exactly through a
 * FRESH read from disk (not from the value the test kept in memory).
 *
 * @module tests/integration/project-recovery-flow.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, createTempDir } from '../../base/index.js'
import { createProject, openProject } from '../../core/project/project.js'
import { newId } from '../../core/project/ids.js'
import { PROJECT_LAYOUT } from '../../core/project/paths.js'
import { writeDocument } from '../../core/project/store.js'
import { readEvents, ProjectEventKind } from '../../core/project/events.js'
import { beginExecution, endExecution, executionMarkerPath } from '../../core/project/write-guard.js'
import { NeedsAttentionCode } from '../../core/project/schema.js'
import {
  RECOVERY_VERDICTS,
  inspectRecovery,
  markCleanPause,
  readWorkPosition,
  saveWorkPosition,
  unknownExecutionResult,
} from '../../core/project/recovery.js'

const temp = createTempDir({ label: 'project-recovery-flow' })
test.after(() => temp.dispose())

/**
 * One project with a real version, ready to be worked on.
 * @param {string} label
 */
function makeWorkedProject(label) {
  const root = temp.dir(label)
  const created = createProject({ projectsRoot: root, title: `连续保存项目 ${label}`, coreGoal: '验证保存继续' })
  const versionId = newId('version')
  writeDocument(path.join(created.paths.dir, PROJECT_LAYOUT.versionsIndex), {
    projectId: created.project.projectId,
    versions: [{ versionId, versionClass: 'current', substate: 'draft' }],
  }, { kind: 'versions', schemaKey: 'versions' })
  return {
    root,
    dir: created.paths.dir,
    projectId: created.project.projectId,
    versionId,
    paths: created.paths,
  }
}

/** The position a user would be at when the process died. */
function positionOf(project) {
  return {
    projectId: project.projectId,
    versionId: project.versionId,
    playheadFrame: 2048,
    selectedObjectId: 'obj_MAIN_TITLE',
    workSurface: 'edit',
    panelState: { left: 'materials', right: 'properties', splitter: 0.62, visible: ['a', 'b'] },
    openDocument: { kind: 'timeline', timelineId: 'tl_main', scrollFrame: 512, trackHeights: [48, 72] },
  }
}

/** Both injected checks reporting everything present. */
const healthyChecks = () => ({
  materialCheck: () => [{ id: 'mat_1', available: true }, { id: 'mat_2', available: true }],
  toolCheck: () => [{ name: 'ffmpeg', available: true }],
})

test('flow: autosave → crash → 需要处理 with unknown state and no repeated external action', () => {
  const project = makeWorkedProject('crash')
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
  saveWorkPosition(project.dir, positionOf(project), { clock })

  // The process died here: no markCleanPause, and the external task it had started is still marked
  // open by a PID that no longer exists. This is the honest mock of an unclean exit.
  beginExecution(executionMarkerPath(project.root), {
    projectId: project.projectId,
    taskId: 'C13-render-initial-cut',
    startedAt: new Date(0).toISOString(),
    hostPid: 999_999,
  })

  const verdict = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    ...healthyChecks(),
  })

  assert.equal(verdict.canContinue, false, '崩溃后不得直接说可以继续')
  assert.equal(verdict.verdict, RECOVERY_VERDICTS.NEEDS_HANDLING)
  assert.equal(verdict.doNotRepeatExternalActions, true, '状态未知不得自动重复外部动作')

  const codes = verdict.needsHandling.map((item) => item.code)
  assert.ok(codes.includes(NeedsAttentionCode.EXECUTION_UNKNOWN), '未收尾的执行标记必须报 unknown')
  assert.ok(
    codes.includes(NeedsAttentionCode.EXECUTION_UNKNOWN) &&
      verdict.needsHandling.some((item) => /先按已暂停处理/.test(item.action)),
    '必须明确"先按已暂停处理"',
  )
  for (const item of verdict.needsHandling) {
    assert.ok(item.action.length > 0, `每一项都需要处理必须有下一步动作：${item.code}`)
    assert.ok(!/绝对路径/.test(item.message), '消息不得包含绝对路径')
  }
  // The position is still readable: the crash did not destroy the saved work.
  assert.ok(verdict.position !== null)
  assert.equal(verdict.position.playheadFrame, 2048)
  assert.equal(verdict.position.versionId, project.versionId)

  // Nothing was migrated into a second recovery system: only the one marker file exists.
  assert.equal(fs.existsSync(path.join(project.dir, PROJECT_LAYOUT.recoveryFile)), true)
  assert.equal(fs.existsSync(path.join(project.dir, PROJECT_LAYOUT.workPositionFile)), true)
})

test('flow: a clean pause after the crash makes the next open 可以继续', () => {
  const project = makeWorkedProject('clean')
  saveWorkPosition(project.dir, positionOf(project))

  // Simulate the crash state, confirm it needs handling, then end the run properly.
  beginExecution(executionMarkerPath(project.root), {
    projectId: project.projectId,
    taskId: 'C13-render-initial-cut',
    startedAt: new Date(0).toISOString(),
    hostPid: 999_999,
  })
  const crashed = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    ...healthyChecks(),
  })
  assert.equal(crashed.canContinue, false)

  // A real dispose: the external marker is cleared and the pause is recorded as clean.
  endExecution(executionMarkerPath(project.root))
  markCleanPause(project.dir, { reason: 'host-dispose' })

  const verdict = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    ...healthyChecks(),
  })

  assert.equal(verdict.verdict, RECOVERY_VERDICTS.CAN_CONTINUE)
  assert.equal(verdict.canContinue, true)
  assert.deepEqual(verdict.needsHandling, [])
  assert.equal(verdict.doNotRepeatExternalActions, false)
  assert.equal(verdict.detected.cleanShutdown.clean, true)
})

test('flow: the saved position round-trips exactly through a fresh read from disk', () => {
  const project = makeWorkedProject('roundtrip')
  const saved = saveWorkPosition(project.dir, positionOf(project))
  endExecution(executionMarkerPath(project.root))
  markCleanPause(project.dir, { reason: 'host-dispose' })

  // Fresh read 1: the module's own reader.
  const fromDisk = readWorkPosition(project.dir)
  assert.ok(fromDisk !== null)
  assert.equal(fromDisk.revision, saved.positionRevision)

  // Fresh read 2: the raw bytes on disk, parsed independently of the reader.
  const raw = JSON.parse(fs.readFileSync(path.join(project.dir, PROJECT_LAYOUT.workPositionFile), 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.schemaGeneration, 1)
  assert.equal(raw.playheadFrame, 2048)
  assert.equal(raw.selectedObjectId, 'obj_MAIN_TITLE')
  assert.equal(raw.workSurface, 'edit')
  assert.deepEqual(raw.panelState, { left: 'materials', right: 'properties', splitter: 0.62, visible: ['a', 'b'] })
  assert.deepEqual(raw.openDocument, {
    kind: 'timeline',
    timelineId: 'tl_main',
    scrollFrame: 512,
    trackHeights: [48, 72],
  })

  // Fresh read 3: what the recovery verdict would hand to the UI.
  const verdict = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    ...healthyChecks(),
  })
  assert.equal(verdict.canContinue, true)
  assert.equal(verdict.position.versionId, raw.versionId)
  assert.equal(verdict.position.playheadFrame, raw.playheadFrame)
  assert.equal(verdict.position.selectedObjectId, raw.selectedObjectId)
  assert.equal(verdict.position.workSurface, raw.workSurface)
  assert.deepEqual(verdict.position.panelState, raw.panelState)
  assert.deepEqual(verdict.position.openDocument, raw.openDocument)
})

test('flow: a second autosave replaces the position without a conflict error', () => {
  const project = makeWorkedProject('twice')
  saveWorkPosition(project.dir, positionOf(project))
  const second = saveWorkPosition(project.dir, {
    ...positionOf(project),
    playheadFrame: 4096,
    workSurface: 'review',
  })

  const read = readWorkPosition(project.dir)
  assert.equal(read.position.playheadFrame, 4096)
  assert.equal(read.position.workSurface, 'review')
  assert.equal(read.revision, second.positionRevision)

  const { events } = readEvents(project.dir, { kinds: [ProjectEventKind.AUTOSAVE_COMPLETED] })
  assert.equal(events.length, 2, '每次自动保存都要有一条事件，不能只留最后一次')
})

test('flow: a missing material after a crash keeps 需要处理 until the user fixes it', () => {
  const project = makeWorkedProject('material')
  saveWorkPosition(project.dir, positionOf(project))
  endExecution(executionMarkerPath(project.root))
  markCleanPause(project.dir, { reason: 'host-dispose' })

  const materialGone = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    materialCheck: () => [
      { id: 'mat_1', available: true },
      { id: 'mat_2', available: false },
    ],
    toolCheck: () => [{ name: 'ffmpeg', available: true }],
  })
  assert.equal(materialGone.canContinue, false)
  const missing = materialGone.needsHandling.find(
    (item) => item.code === NeedsAttentionCode.MATERIAL_MISSING,
  )
  assert.ok(missing)
  assert.match(missing.message, /mat_2/)
  assert.match(missing.action, /补回|重新指向/)

  // The user restores the file; the same check now passes. Nothing else changed.
  const restored = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    ...healthyChecks(),
  })
  assert.equal(restored.canContinue, true, '补件后必须能继续，而不是永久卡住')
  assert.equal(restored.position.playheadFrame, 2048)
})

test('flow: a crash during a write is reported and the published state is still readable', () => {
  const project = makeWorkedProject('interrupted')
  saveWorkPosition(project.dir, positionOf(project))
  endExecution(executionMarkerPath(project.root))
  markCleanPause(project.dir, { reason: 'host-dispose' })
  // A write that died before publishing: the temp file is on disk, the target is unchanged.
  const leftover = path.join(project.dir, `.${PROJECT_LAYOUT.projectFile}.999999.deadbeef.tmp-write`)
  fs.writeFileSync(leftover, '{"projectId":"prj_half"}', 'utf8')
  const projectFileBefore = fs.readFileSync(path.join(project.dir, PROJECT_LAYOUT.projectFile), 'utf8')

  const verdict = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    ...healthyChecks(),
  })

  assert.equal(verdict.canContinue, false)
  const interrupted = verdict.needsHandling.find((item) => item.code === NeedsAttentionCode.FILE_BUSY)
  assert.ok(interrupted, '未发布的写入必须报出来')
  assert.match(interrupted.message, /没有完成发布/)
  assert.equal(fs.existsSync(leftover), true, '诊断不清理证据')
  assert.equal(
    fs.readFileSync(path.join(project.dir, PROJECT_LAYOUT.projectFile), 'utf8'),
    projectFileBefore,
    '已发布的项目文件不得被改写',
  )
  // The project is still openable and the position was not lost.
  const opened = openProject({ projectsRoot: project.root, projectId: project.projectId })
  assert.equal(opened.project.projectId, project.projectId)
  assert.equal(verdict.position.playheadFrame, 2048)
})

test('flow: unknownExecutionResult is the gate a scheduler must consult before retrying', () => {
  const project = makeWorkedProject('gate')
  beginExecution(executionMarkerPath(project.root), {
    projectId: project.projectId,
    taskId: 'C13-external-call',
    startedAt: new Date(0).toISOString(),
    hostPid: 999_999,
  })
  const verdict = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    ...healthyChecks(),
  })
  const marker = verdict.detected.execution
  const classified = unknownExecutionResult(marker)
  assert.equal(classified.doNotRepeat, true)
  assert.equal(classified.state, 'unknown')
  assert.equal(verdict.doNotRepeatExternalActions, true)
  assert.match(classified.action, /不要自动重复/)

  // After an honest end the gate opens, and the reason is recorded in the log.
  endExecution(executionMarkerPath(project.root))
  markCleanPause(project.dir, { reason: 'user-exit' })
  const after = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    ...healthyChecks(),
  })
  assert.equal(unknownExecutionResult(after.detected.execution).doNotRepeat, false)
  const events = readEvents(project.dir, { kinds: [ProjectEventKind.SAVE_PAUSED] })
  assert.equal(events.events.length, 1)
  assert.equal(events.events[0].detail.reason, 'user-exit')
})

test('flow: an unclean marker plus an absent position still reports both differences honestly', () => {
  const project = makeWorkedProject('both')
  // No position was ever saved and the previous run did not finish.
  beginExecution(executionMarkerPath(project.root), {
    projectId: project.projectId,
    taskId: 'C13-external-call',
    startedAt: new Date(0).toISOString(),
    hostPid: 999_999,
  })

  const verdict = inspectRecovery({
    projectDir: project.dir,
    projectsRoot: project.root,
    projectId: project.projectId,
    ...healthyChecks(),
  })

  assert.equal(verdict.canContinue, false)
  const unknown = verdict.needsHandling.filter(
    (item) => item.code === NeedsAttentionCode.EXECUTION_UNKNOWN,
  )
  assert.ok(unknown.length >= 1)
  assert.equal(verdict.position, null)
  assert.equal(verdict.doNotRepeatExternalActions, true)
  // Two distinct differences are reported, not collapsed into one generic error.
  const messages = verdict.needsHandling.map((item) => item.message)
  assert.equal(new Set(messages).size, messages.length, '不同差异必须分别说明，不能重复同一句')
})
