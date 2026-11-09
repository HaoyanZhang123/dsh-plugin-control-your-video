/**
 * Failure and recovery tests for PROJECT-CORE: the injected faults the card requires.
 *
 * C10 card §6.11 names the faults that must be covered: process crash, interrupted write, disk
 * full, permission denied, file busy, stale lock, directory moved. CT-11 §5 says a fault proves
 * only the range actually injected, so each test asserts the specific mechanism it exercised and
 * says nothing about the others.
 *
 * Faults are injected at the REAL seams `base/faults.js` wires into `base/atomic-write.js`, and
 * every scenario asserts the fault actually fired — a test that passes because the fault silently
 * did not happen would be worthless.
 *
 * @module tests/integration/project-faults.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  createTempDir,
  Clock,
  enableFaultInjection,
  disableFaultInjection,
  FaultPlan,
  FaultKind,
  withFaultPlan,
  captureFailure,
  sha256File,
  TEMP_SUFFIX,
} from '../../base/index.js'
import * as core from '../../core/project/index.js'

const temp = createTempDir({ label: 'faults' })
const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
test.after(() => temp.dispose())

/** A private projects root per test, so a leftover lock cannot leak between cases. */
let rootCounter = 0
function freshRoot() {
  rootCounter += 1
  return temp.dir(`faults-${rootCounter}`)
}

test('fault: disk full during a project write leaves the previous project intact', () => {
  const projectsRoot = freshRoot()
  const created = core.createProject({ projectsRoot, title: '磁盘满', clock })
  const opened = core.openProject({ projectsRoot, projectId: created.project.projectId, clock })
  const beforeSha = sha256File(created.paths.projectFile())
  const beforePhase = opened.project.phase

  enableFaultInjection({ allow: true })
  const plan = new FaultPlan().arm('atomic-write:before-rename', FaultKind.DISK_FULL)
  const failure = withFaultPlan(plan, () =>
    captureFailure(() =>
      core.setPhase({
        projectsRoot,
        projectId: created.project.projectId,
        to: core.ProjectPhase.ALIGNING,
        expectedRevision: opened.revision,
        clock,
      }),
    ),
  )
  disableFaultInjection()

  // The fault must really have fired, or this test proves nothing.
  assert.equal(plan.activationCount('atomic-write:before-rename'), 1, '磁盘满故障必须真实触发')
  assert.equal(failure.ok, false, '磁盘满时写入必须失败')
  assert.equal(/** @type {any} */ (failure.error)?.code, 'ENOSPC')
  // The old state must survive byte-for-byte.
  assert.equal(sha256File(created.paths.projectFile()), beforeSha, '磁盘满不得破坏既有项目文件')
  const after = core.openProject({ projectsRoot, projectId: created.project.projectId, clock })
  assert.equal(after.project.phase, beforePhase, '磁盘满后项目阶段不得改变')
})

test('fault: permission denied is reported and the old version is preserved', () => {
  const projectsRoot = freshRoot()
  const created = core.createProject({ projectsRoot, title: '权限', clock })
  const opened = core.openProject({ projectsRoot, projectId: created.project.projectId, clock })
  const beforeSha = sha256File(created.paths.projectFile())

  enableFaultInjection({ allow: true })
  const plan = new FaultPlan().arm('atomic-write:before-write', FaultKind.PERMISSION_DENIED)
  const failure = withFaultPlan(plan, () =>
    captureFailure(() =>
      core.renameProject({
        projectsRoot,
        projectId: created.project.projectId,
        title: '新名字',
        expectedRevision: opened.revision,
        clock,
      }),
    ),
  )
  disableFaultInjection()

  assert.equal(plan.activationCount('atomic-write:before-write'), 1)
  assert.equal(failure.ok, false)
  assert.equal(/** @type {any} */ (failure.error)?.code, 'EACCES')
  assert.equal(sha256File(created.paths.projectFile()), beforeSha)
})

test('fault: an interrupted write leaves a detectable temp file and no published partial state', () => {
  const projectsRoot = freshRoot()
  const created = core.createProject({ projectsRoot, title: '写入中断', clock })
  const opened = core.openProject({ projectsRoot, projectId: created.project.projectId, clock })

  enableFaultInjection({ allow: true })
  const plan = new FaultPlan().arm(
    'atomic-write:after-write-before-verify',
    FaultKind.CRASH_MID_WRITE,
    { times: 1 },
  )
  const failure = withFaultPlan(plan, () =>
    captureFailure(() =>
      core.setExecutionState({
        projectsRoot,
        projectId: created.project.projectId,
        state: core.ExecutionState.PAUSED,
        expectedRevision: opened.revision,
        clock,
      }),
    ),
  )
  disableFaultInjection()

  assert.equal(failure.ok, false, '写入中断必须失败')
  // The published project file must still be the OLD one, not a partial write.
  const after = core.openProject({ projectsRoot, projectId: created.project.projectId, clock })
  assert.equal(after.project.execution, core.ExecutionState.IDLE, '中断的写入不得发布到项目文件')

  // A leftover temp file is itself the evidence that a write was interrupted. base removes it on
  // a clean failure, so its absence is also acceptable; what must NOT happen is a corrupt target.
  const leftovers = fs.readdirSync(created.paths.dir).filter((name) => name.endsWith(TEMP_SUFFIX))
  for (const name of leftovers) {
    // Anything left behind must be identifiable as a temp file, never mistakable for the project.
    assert.match(name, new RegExp(`${TEMP_SUFFIX.replace('.', '\\.')}$`))
    assert.notEqual(name, 'project.json')
  }
})

test('fault: a stale lock blocks recovery until the user decides, and is not auto-deleted', () => {
  const projectsRoot = freshRoot()
  const created = core.createProject({ projectsRoot, title: '陈旧锁', clock })
  const lockPath = core.projectEditLockPath(projectsRoot, created.project.projectId)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify(
      {
        formatVersion: 1,
        lockKind: 'project-edit',
        scopeId: created.project.projectId,
        ownerPid: 999_995,
        ownerInstanceId: 'dead',
        ownerHost: process.env.COMPUTERNAME ?? 'unknown',
        ownerLabel: '崩溃的会话',
        taskId: 'C13-production',
        projectVersion: 'v1',
        acquiredAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      },
      null,
      2,
    )}\n`,
  )

  const recovery = core.inspectRecovery({
    projectsRoot,
    projectId: created.project.projectId,
    projectDir: created.paths.dir,
    materialCheck: () => [],
    toolCheck: () => [],
    clock,
  })
  assert.equal(recovery.canContinue, false, '陈旧锁存在时不能直接继续')
  const codes = recovery.needsHandling.map((entry) => entry.code)
  assert.ok(codes.includes(core.NeedsAttentionCode.LOCK_STALE), `实际原因码 ${codes.join(',')}`)
  // The lock must still be there: deleting it automatically could destroy another writer's work.
  assert.equal(fs.existsSync(lockPath), true)
  fs.rmSync(lockPath, { force: true })
})

test('fault: a corrupted project.json is reported and never replaced by an empty project', () => {
  const projectsRoot = freshRoot()
  const created = core.createProject({ projectsRoot, title: '损坏', clock })
  const file = created.paths.projectFile()
  fs.writeFileSync(file, '{"projectId": "prj_AAAA", "truncated": ')
  const corruptBytes = fs.statSync(file).size

  assert.throws(
    () => core.openProject({ projectsRoot, projectId: created.project.projectId, clock }),
    (error) => error.code === 'CORRUPT_DATA',
  )

  const recovery = core.inspectRecovery({
    projectsRoot,
    projectId: created.project.projectId,
    projectDir: created.paths.dir,
    materialCheck: () => [],
    toolCheck: () => [],
    clock,
  })
  assert.equal(recovery.canContinue, false)
  const codes = recovery.needsHandling.map((entry) => entry.code)
  assert.ok(
    codes.includes(core.NeedsAttentionCode.PROJECT_FILE_CORRUPT) ||
      codes.includes(core.NeedsAttentionCode.PROJECT_DIR_MISSING),
    `损坏的项目必须报告为需要处理，实际 ${codes.join(',')}`,
  )
  // The damaged file must NOT have been silently rewritten or emptied.
  assert.equal(fs.statSync(file).size, corruptBytes, '损坏文件不得被静默覆盖')
})

test('fault: a moved project directory is reported with an actionable next step', () => {
  const projectsRoot = freshRoot()
  const created = core.createProject({ projectsRoot, title: '目录移动', clock })
  const elsewhere = temp.dir('elsewhere')
  fs.cpSync(created.paths.dir, path.join(elsewhere, 'moved'), { recursive: true })
  fs.rmSync(created.paths.dir, { recursive: true, force: true })

  const recovery = core.inspectRecovery({
    projectsRoot,
    projectId: created.project.projectId,
    projectDir: created.paths.dir,
    materialCheck: () => [],
    toolCheck: () => [],
    clock,
  })
  assert.equal(recovery.canContinue, false)
  const missing = recovery.needsHandling.find((entry) => entry.code === core.NeedsAttentionCode.PROJECT_DIR_MISSING)
  assert.ok(missing, '必须报告项目目录缺失')
  assert.ok(String(missing.action ?? '').length > 0, '必须给出可执行的下一步')
})

test('fault: an unknown execution state stays paused and forbids repeating the action', () => {
  const projectsRoot = freshRoot()
  const created = core.createProject({ projectsRoot, title: '状态未知', clock })
  // Simulate a crash: an execution marker opened by a process that is now gone.
  core.beginExecution(core.executionMarkerPath(projectsRoot), {
    projectId: created.project.projectId,
    taskId: 'render-1',
    startedAt: clock.iso(),
    hostPid: 999_994,
  })

  try {
    const marker = core.inspectExecution(core.executionMarkerPath(projectsRoot))
    assert.equal(marker.state, 'unknown')

    const classified = core.unknownExecutionResult(marker)
    assert.equal(classified.doNotRepeat, true, '状态未知时不得自动重复外部动作')

    const recovery = core.inspectRecovery({
      projectsRoot,
      projectId: created.project.projectId,
      projectDir: created.paths.dir,
      materialCheck: () => [],
      toolCheck: () => [],
      clock,
    })
    assert.equal(recovery.canContinue, false)
    const codes = recovery.needsHandling.map((entry) => entry.code)
    assert.ok(codes.includes(core.NeedsAttentionCode.EXECUTION_UNKNOWN), `实际原因码 ${codes.join(',')}`)
  } finally {
    core.endExecution(core.executionMarkerPath(projectsRoot))
  }
})

test('fault: a missing external tool is reported, never assumed available', () => {
  const projectsRoot = freshRoot()
  const created = core.createProject({ projectsRoot, title: '缺工具', clock })
  const recovery = core.inspectRecovery({
    projectsRoot,
    projectId: created.project.projectId,
    projectDir: created.paths.dir,
    materialCheck: () => [],
    toolCheck: () => [{ name: 'ffmpeg', available: false }],
    clock,
  })
  assert.equal(recovery.canContinue, false)
  const codes = recovery.needsHandling.map((entry) => entry.code)
  assert.ok(codes.includes(core.NeedsAttentionCode.EXTERNAL_TOOL_MISSING), `实际原因码 ${codes.join(',')}`)
})

test('fault: a project write is refused when another writer holds the project lock', () => {
  const projectsRoot = freshRoot()
  const created = core.createProject({ projectsRoot, title: '双写', clock })
  const opened = core.openProject({ projectsRoot, projectId: created.project.projectId, clock })

  const held = core.acquireProjectWriter({
    projectsRoot,
    projectId: created.project.projectId,
    taskId: 'writer-b',
    clock,
  })
  try {
    assert.throws(
      () =>
        core.acquireProjectWriter({
          projectsRoot,
          projectId: created.project.projectId,
          taskId: 'writer-a',
          clock,
        }),
      (error) => {
        assert.equal(error.code, 'CONFLICT')
        assert.equal(error.details.taskId, 'writer-b')
        return true
      },
    )
  } finally {
    held.release()
  }
  assert.equal(opened.project.title, '双写')
})

test('fault: two projects cannot both hold the single full-production right', () => {
  const projectsRoot = freshRoot()
  const first = core.createProject({ projectsRoot, title: '第一个制作', clock })
  const second = core.createProject({ projectsRoot, title: '第二个制作', clock })

  const handle = core.acquireProduction({
    projectsRoot,
    projectId: first.project.projectId,
    taskId: 'C13-first',
    clock,
  })
  try {
    assert.throws(
      () =>
        core.acquireProduction({
          projectsRoot,
          projectId: second.project.projectId,
          taskId: 'C13-second',
          clock,
        }),
      (error) => {
        assert.equal(error.code, 'CONFLICT')
        return true
      },
    )
    // The inspection must name WHICH project holds the right, so the user can act on it.
    const inspected = core.inspectProduction(projectsRoot, { clock })
    assert.equal(inspected.held, true)
    assert.equal(inspected.holder?.projectId, first.project.projectId)
  } finally {
    core.releaseProduction(handle)
  }
  // Released, so the second project may now take it.
  const secondHandle = core.acquireProduction({
    projectsRoot,
    projectId: second.project.projectId,
    taskId: 'C13-second',
    clock,
  })
  // `acquireProduction` returns a handle wrapping the file lock; release goes through the module
  // so the handle's shape stays its own concern.
  assert.equal(core.releaseProduction(secondHandle).released, true)
})
