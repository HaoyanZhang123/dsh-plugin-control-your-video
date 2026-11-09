/**
 * Integration tests for single-writer enforcement in core/project/write-guard.js.
 *
 * CT-02 §4 requires the per-project lock to carry project id, owner, task, version, heartbeat and
 * an explicit stale decision, and forbids auto-deleting a stale lock. These tests create REAL lock
 * files (including a stale one from a dead PID) and assert the refusal behaviour, because a lock
 * that can be silently stolen is worse than no lock at all.
 *
 * @module tests/integration/project-write-guard.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  createTempDir,
  Clock,
  writeJsonAtomic,
  PROCESS_INSTANCE,
  LOCK_FORMAT_VERSION,
} from '../../base/index.js'
import {
  acquireProjectWriter,
  withProjectWriter,
  inspectProjectWriter,
  describeLockConflict,
  checkWriterAvailable,
  projectEditLockPath,
  executionMarkerPath,
  beginExecution,
  endExecution,
  inspectExecution,
  NeedsAttentionCode,
} from '../../core/project/index.js'

const temp = createTempDir({ label: 'write-guard' })
const projectsRoot = temp.dir('projects')
const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
test.after(() => temp.dispose())

/** A PID that is not running; well beyond typical Windows PID limits. */
const DEAD_PID = 999_991

test('write-guard: a writer can be acquired and released, leaving no lock file', () => {
  const projectId = 'prj_AAAAAAAAAAAAAAAA'
  const lock = acquireProjectWriter({ projectsRoot, projectId, taskId: 'C10-test', clock })
  const lockPath = projectEditLockPath(projectsRoot, projectId)
  try {
    assert.ok(fs.existsSync(lockPath), '锁文件必须真实存在')
    const inspected = inspectProjectWriter(lockPath, { clock })
    assert.equal(inspected.held, true)
    assert.equal(inspected.stale, false)
    assert.equal(inspected.record.taskId, 'C10-test')
    assert.equal(inspected.record.scopeId, projectId)
  } finally {
    lock.release()
  }
  assert.equal(fs.existsSync(lockPath), false, '正常释放后锁文件必须消失')
})

test('write-guard: a second writer on the same project is refused and names the holder', () => {
  const projectId = 'prj_BBBBBBBBBBBBBBBB'
  const first = acquireProjectWriter({ projectsRoot, projectId, taskId: 'writer-a', clock })
  try {
    assert.throws(
      () => acquireProjectWriter({ projectsRoot, projectId, taskId: 'writer-b', clock }),
      (error) => {
        assert.equal(error.code, 'CONFLICT')
        // The refusal must identify who holds it, or the user cannot resolve it.
        assert.equal(error.details.taskId, 'writer-a')
        return true
      },
    )
  } finally {
    first.release()
  }
  // Different projects must not block each other: the per-project lock is per project.
  const other = acquireProjectWriter({ projectsRoot, projectId: 'prj_CCCCCCCCCCCCCCCC', taskId: 'writer-c', clock })
  other.release()
})

test('write-guard: a stale lock is reported as needing handling and is NEVER auto-deleted', () => {
  const projectId = 'prj_DDDDDDDDDDDDDDDD'
  const lockPath = projectEditLockPath(projectsRoot, projectId)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  writeJsonAtomic(lockPath, {
    formatVersion: LOCK_FORMAT_VERSION,
    lockKind: 'project-edit',
    scopeId: projectId,
    ownerPid: DEAD_PID,
    ownerInstanceId: 'dead-instance',
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: '上次崩溃的会话',
    taskId: 'C13-production',
    projectVersion: 'r000000000007-00ff00ff',
    acquiredAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  })

  const inspected = inspectProjectWriter(lockPath, { clock })
  assert.equal(inspected.held, true)
  assert.equal(inspected.stale, true)
  assert.equal(inspected.ownerAlive, false)
  const described = describeLockConflict(inspected)
  assert.equal(described.code, NeedsAttentionCode.LOCK_STALE)
  assert.match(described.action, /不会自动删除/)

  assert.throws(
    () => acquireProjectWriter({ projectsRoot, projectId, taskId: 'retry', clock }),
    (error) => {
      assert.equal(error.details.code, 'STALE_LOCK')
      assert.equal(error.details.needsAttention, NeedsAttentionCode.LOCK_STALE)
      assert.match(String(error.details.message), /不会自动删除/)
      return true
    },
  )
  // The decisive assertion: the stale lock file is still there for the user to decide on.
  assert.equal(fs.existsSync(lockPath), true)
  fs.rmSync(lockPath, { force: true })
})

test('write-guard: a takeover needs an explicit reason and is refused without one', () => {
  const projectId = 'prj_EEEEEEEEEEEEEEEE'
  const lockPath = projectEditLockPath(projectsRoot, projectId)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  writeJsonAtomic(lockPath, {
    formatVersion: LOCK_FORMAT_VERSION,
    lockKind: 'project-edit',
    scopeId: projectId,
    ownerPid: DEAD_PID,
    ownerInstanceId: 'dead',
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: 'dead',
    taskId: 'old',
    projectVersion: 'v1',
    acquiredAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  })

  assert.throws(
    () => acquireProjectWriter({ projectsRoot, projectId, taskId: 'new', stealStale: true, clock }),
    (error) => error.code === 'VALIDATION_FAILED',
  )

  const lock = acquireProjectWriter({
    projectsRoot,
    projectId,
    taskId: 'new',
    stealStale: true,
    reason: '用户确认上次写入已停止',
    clock,
  })
  try {
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).taskId, 'new')
  } finally {
    lock.release()
  }
})

test('write-guard: withProjectWriter releases the lock even when the body throws', () => {
  const projectId = 'prj_FFFFFFFFFFFFFFFF'
  assert.throws(() =>
    withProjectWriter({ projectsRoot, projectId, taskId: 'failing', clock }, () => {
      throw new Error('body failed')
    }),
  )
  assert.equal(fs.existsSync(projectEditLockPath(projectsRoot, projectId)), false, '异常路径也必须释放')
})

test('write-guard: withProjectWriter returns the body value', () => {
  const projectId = 'prj_GGGGGGGGGGGGGGGG'
  const value = withProjectWriter({ projectsRoot, projectId, taskId: 'value', clock }, () => 42)
  assert.equal(value, 42)
})

test('write-guard: checkWriterAvailable distinguishes free from held', () => {
  const projectId = 'prj_HHHHHHHHHHHHHHHH'
  const lockPath = projectEditLockPath(projectsRoot, projectId)
  assert.deepEqual(checkWriterAvailable(lockPath, { clock }), { ok: true })

  const lock = acquireProjectWriter({ projectsRoot, projectId, taskId: 'held', clock })
  try {
    const busy = checkWriterAvailable(lockPath, { clock })
    assert.equal(busy.ok, false)
    assert.equal(busy.reason, NeedsAttentionCode.LOCK_HELD)
  } finally {
    lock.release()
  }
})

test('write-guard: the lock path encodes distinct projects distinctly', () => {
  const pathA = projectEditLockPath(projectsRoot, 'prj_IIIIIIIIIIIIIIII')
  const pathB = projectEditLockPath(projectsRoot, 'prj_JJJJJJJJJJJJJJJJ')
  assert.notEqual(pathA, pathB)
})

test('write-guard: an execution marker that was never closed reads as unknown', () => {
  const markerPath = executionMarkerPath(projectsRoot)
  beginExecution(markerPath, {
    projectId: 'prj_KKKKKKKKKKKKKKKK',
    taskId: 'render-1',
    startedAt: clock.iso(),
    hostPid: DEAD_PID,
  })
  const inspected = inspectExecution(markerPath)
  assert.equal(inspected.present, true)
  assert.equal(inspected.open, true)
  // A dead owner is exactly "状态未知": the process did not clean up, so nothing may claim it
  // finished, and nothing may retry the action automatically.
  assert.equal(inspected.state, 'unknown')
  assert.equal(inspected.detail.code, NeedsAttentionCode.EXECUTION_UNKNOWN)
  assert.match(String(inspected.detail.action), /先按已暂停处理/)
  endExecution(markerPath)
})

test('write-guard: an execution marker from a live owner reads as running', () => {
  const markerPath = executionMarkerPath(projectsRoot)
  beginExecution(markerPath, {
    projectId: 'prj_LLLLLLLLLLLLLLLL',
    taskId: 'render-2',
    startedAt: clock.iso(),
    hostPid: process.pid,
  })
  try {
    const inspected = inspectExecution(markerPath)
    assert.equal(inspected.state, 'running')
    assert.equal(inspected.detail.ownerAlive, true)
  } finally {
    endExecution(markerPath)
  }
})

test('write-guard: a closed execution marker reads as idle', () => {
  const markerPath = executionMarkerPath(projectsRoot)
  assert.deepEqual(inspectExecution(markerPath), { present: false, open: false, state: 'idle', detail: null })
  beginExecution(markerPath, {
    projectId: 'prj_MMMMMMMMMMMMMMMN',
    taskId: 't',
    startedAt: clock.iso(),
    hostPid: process.pid,
  })
  const cleared = endExecution(markerPath)
  assert.equal(cleared.cleared, true)
  assert.equal(inspectExecution(markerPath).state, 'idle')
})

test('write-guard: an unreadable execution marker is unknown, not idle', () => {
  const markerPath = executionMarkerPath(projectsRoot)
  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  fs.writeFileSync(markerPath, '{ broken json')
  try {
    const inspected = inspectExecution(markerPath)
    assert.equal(inspected.state, 'unknown')
    assert.equal(inspected.detail.code, NeedsAttentionCode.EXECUTION_UNKNOWN)
  } finally {
    fs.rmSync(markerPath, { force: true })
  }
})
