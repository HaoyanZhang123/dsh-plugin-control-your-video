/**
 * Integration tests for base/locks.js.
 *
 * CT-02 §4 requires: project id, owner, task, heartbeat, stale handling, and "a stale lock
 * shows 需要处理 and is never auto-deleted". These tests create REAL lock files and a REAL
 * stale lock from a dead PID, and assert the refusal behaviour.
 *
 * @module tests/integration/locks.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  acquireLock,
  withLock,
  inspectLock,
  requireLock,
  lockFileName,
  encodeScopeId,
  decodeScopeId,
  LOCK_FORMAT_VERSION,
  PROCESS_INSTANCE,
} from '../../base/locks.js'
import { createTempDir } from '../../base/tempdir.js'
import { PathGuard } from '../../base/paths.js'
import { Clock } from '../../base/determinism.js'
import { writeJsonAtomic } from '../../base/atomic-write.js'

const temp = createTempDir({ label: 'locks' })
const guard = new PathGuard(temp.dir('locks'), { label: 'locks' })
test.after(() => temp.dispose())

test('lockFileName: distinguishes the two lock kinds', () => {
  assert.equal(lockFileName('global-production', '*'), 'lock.global-production.json')
  assert.match(lockFileName('project-edit', 'prj-1'), /^lock\.project-edit\.prj-1\.json$/)
  assert.throws(() => lockFileName('other', 'x'))
  assert.throws(() => lockFileName('project-edit', ''))
})

test('lockFileName: encodes scope ids losslessly so distinct projects never share a lock', () => {
  // Regression: a naive `replace(/[^A-Za-z0-9._-]/g, '_')` mapped `prj/1` and `prj_1` to the
  // same file, and collapsed every non-ASCII id to `___`; unrelated projects could then block
  // or take over each other's edit lock.
  const ids = ['prj/1', 'prj_1', '项目一', '项目二', 'a?b', 'a*b', 'prj 1', 'prj%1']
  const names = ids.map((id) => lockFileName('project-edit', id))
  assert.equal(new Set(names).size, ids.length, `锁文件名必须唯一: ${names.join(', ')}`)
  for (const id of ids) {
    assert.equal(decodeScopeId(encodeScopeId(id)), id, `编码必须可逆: ${id}`)
  }
})

test('acquireLock: writes a lock record with owner, task and heartbeat', () => {
  const lockPath = guard.resolve('basic.json')
  const lock = acquireLock(lockPath, {
    kind: 'project-edit',
    scopeId: 'prj-1',
    taskId: 'C10-save',
    projectVersion: 'v3',
  })
  try {
    const record = requireLock(lockPath)
    assert.equal(record.formatVersion, LOCK_FORMAT_VERSION)
    assert.equal(record.lockKind, 'project-edit')
    assert.equal(record.scopeId, 'prj-1')
    assert.equal(record.taskId, 'C10-save')
    assert.equal(record.projectVersion, 'v3')
    assert.equal(record.ownerPid, process.pid)
    assert.equal(record.ownerInstanceId, PROCESS_INSTANCE.instanceId)
    assert.ok(record.acquiredAt && record.heartbeatAt)
  } finally {
    lock.release()
  }
  assert.equal(fs.existsSync(lockPath), false, '释放后锁文件必须消失')
})

test('acquireLock: a second writer on the same scope is refused with a clear holder', () => {
  const lockPath = guard.resolve('contend.json')
  const first = acquireLock(lockPath, { kind: 'project-edit', scopeId: 'prj-2', taskId: 'task-a' })
  try {
    assert.throws(
      () => acquireLock(lockPath, { kind: 'project-edit', scopeId: 'prj-2', taskId: 'task-b' }),
      (error) => {
        assert.equal(error.code, 'CONFLICT')
        assert.equal(error.details.code, 'LOCK_HELD')
        assert.equal(error.details.taskId, 'task-a')
        return true
      },
    )
  } finally {
    first.release()
  }
})

test('acquireLock: the global production lock is a separate file from project locks', () => {
  const globalPath = guard.resolve(lockFileName('global-production', '*'))
  const projectPath = guard.resolve(lockFileName('project-edit', 'prj-3'))
  const globalLock = acquireLock(globalPath, { kind: 'global-production', scopeId: '*', taskId: 'C13' })
  const projectLock = acquireLock(projectPath, { kind: 'project-edit', scopeId: 'prj-3', taskId: 'C10' })
  try {
    assert.notEqual(globalPath, projectPath)
    assert.equal(inspectLock(globalPath).verdict, 'live')
    assert.equal(inspectLock(projectPath).verdict, 'live')
  } finally {
    projectLock.release()
    globalLock.release()
  }
})

test('release: is idempotent and reports why a second call did nothing', () => {
  const lockPath = guard.resolve('idempotent.json')
  const lock = acquireLock(lockPath, { kind: 'project-edit', scopeId: 'p', taskId: 't' })
  assert.equal(lock.release().released, true)
  assert.equal(lock.release().reason, 'already-released')
})

test('release: never deletes a lock that another writer now owns', () => {
  const lockPath = guard.resolve('stolen.json')
  const lock = acquireLock(lockPath, { kind: 'project-edit', scopeId: 'p', taskId: 'ours' })
  // Simulate another writer taking over the file after we acquired it.
  writeJsonAtomic(lockPath, {
    ...requireLock(lockPath),
    ownerPid: process.pid + 1,
    ownerInstanceId: 'someone-else',
    taskId: 'theirs',
  })
  const result = lock.release()
  assert.equal(result.released, false)
  assert.equal(result.reason, 'ownership-changed')
  assert.equal(fs.existsSync(lockPath), true, '不属于自己的锁不得删除')
  fs.rmSync(lockPath, { force: true })
})

test('inspectLock: a lock from a dead process is reported stale, never deleted', () => {
  const lockPath = guard.resolve('stale.json')
  // A PID that is not running: use a value well beyond typical Windows PID limits.
  const deadPid = 999_999
  writeJsonAtomic(lockPath, {
    formatVersion: LOCK_FORMAT_VERSION,
    lockKind: 'project-edit',
    scopeId: 'prj-stale',
    ownerPid: deadPid,
    ownerInstanceId: 'dead-instance',
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: 'crashed session',
    taskId: 'C13-production',
    projectVersion: 'v1',
    acquiredAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  })

  const inspected = inspectLock(lockPath)
  assert.equal(inspected.verdict, 'stale')
  assert.equal(inspected.ownerAlive, false)
  assert.equal(inspected.record.taskId, 'C13-production')

  // Acquiring must refuse and describe the situation, not silently steal the lock.
  assert.throws(
    () => acquireLock(lockPath, { kind: 'project-edit', scopeId: 'prj-stale', taskId: 'retry' }),
    (error) => {
      assert.equal(error.details.code, 'STALE_LOCK')
      assert.equal(error.details.ownerLabel, 'crashed session')
      assert.match(String(error.message), /需要处理/)
      return true
    },
  )
  assert.equal(fs.existsSync(lockPath), true, '陈旧锁必须保留，等待用户决定')
})

test('inspectLock: an explicit takeover is possible only when the caller asks', () => {
  const lockPath = guard.resolve('takeover.json')
  writeJsonAtomic(lockPath, {
    formatVersion: LOCK_FORMAT_VERSION,
    lockKind: 'project-edit',
    scopeId: 'prj-t',
    ownerPid: 999_998,
    ownerInstanceId: 'dead',
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: 'dead',
    taskId: 'old',
    projectVersion: 'v1',
    acquiredAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  })
  const lock = acquireLock(lockPath, {
    kind: 'project-edit',
    scopeId: 'prj-t',
    taskId: 'new',
    stealStale: true,
    reason: '用户在“需要处理”中选择接管',
  })
  try {
    assert.equal(requireLock(lockPath).taskId, 'new')
  } finally {
    lock.release()
  }
})

test('inspectLock: a lock with an unreadable body is treated as stale, not as absent', () => {
  const lockPath = guard.resolve('corrupt-lock.json')
  fs.writeFileSync(lockPath, '{ broken')
  const inspected = inspectLock(lockPath)
  assert.equal(inspected.verdict, 'stale')
  assert.equal(inspected.record.formatVersion, -1)
})

test('inspectLock: a fresh heartbeat from a live owner is live', () => {
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
  const lockPath = guard.resolve('live.json')
  const lock = acquireLock(lockPath, { kind: 'project-edit', scopeId: 'prj-live', taskId: 't', clock })
  try {
    const inspected = inspectLock(lockPath, { clock })
    assert.equal(inspected.verdict, 'live')
    assert.equal(inspected.ownerAlive, true)
    assert.equal(inspected.ageMs, 0)
  } finally {
    lock.release()
  }
})

test('inspectLock: an old heartbeat is stale even for a live PID', () => {
  const now = 1_700_000_000_000
  const clock = new Clock({ mode: 'frozen', start: now })
  const lockPath = guard.resolve('old-heartbeat.json')
  writeJsonAtomic(lockPath, {
    formatVersion: LOCK_FORMAT_VERSION,
    lockKind: 'project-edit',
    scopeId: 'prj-old',
    ownerPid: process.pid,
    ownerInstanceId: 'other-instance-same-pid',
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: 'same pid, different instance',
    taskId: 'whatever',
    projectVersion: 'v1',
    acquiredAt: new Date(now - 600_000).toISOString(),
    heartbeatAt: new Date(now - 600_000).toISOString(),
  })
  const inspected = inspectLock(lockPath, { clock, staleAfterMs: 120_000 })
  assert.equal(inspected.verdict, 'stale', 'PID 复用不得被当作存活')
  assert.ok(inspected.ageMs >= 600_000)
})

test('heartbeat: refreshing extends the lock lifetime', () => {
  const clock = new Clock({ mode: 'manual', start: 1_000_000 })
  const lockPath = guard.resolve('beat.json')
  const lock = acquireLock(lockPath, { kind: 'project-edit', scopeId: 'prj-b', taskId: 't', clock })
  try {
    const before = requireLock(lockPath).heartbeatAt
    clock.advance(5_000)
    lock.beat()
    const after = requireLock(lockPath).heartbeatAt
    assert.notEqual(before, after)
    assert.equal(lock.heartbeats, 1)
  } finally {
    lock.release()
  }
})

test('withLock: releases even when the body throws', () => {
  const lockPath = guard.resolve('finally.json')
  assert.throws(() =>
    withLock(lockPath, { kind: 'project-edit', scopeId: 'prj-f', taskId: 't' }, () => {
      throw new Error('body failed')
    }),
  )
  assert.equal(fs.existsSync(lockPath), false, '异常路径也必须释放锁')
})

test('withLock: returns the body value', () => {
  const lockPath = guard.resolve('value.json')
  const value = withLock(lockPath, { kind: 'project-edit', scopeId: 'prj-v', taskId: 't' }, () => 42)
  assert.equal(value, 42)
})

test('requireLock: a missing lock is a stable NotFound error', () => {
  assert.throws(() => requireLock(guard.resolve('absent.json')), (error) => error.code === 'NOT_FOUND')
})
