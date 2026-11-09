/**
 * Integration tests for the GLOBAL production lock (core/project/production-lock.js).
 *
 * CT-02 §4 says the whole plugin may have exactly ONE project in full production, and C10 card §6
 * item 6 requires that a second project is actually refused. These tests use a real projects root,
 * real lock files and a real stale lock from a dead PID — the refusal, the holder identity, the
 * "never auto-deleted" rule and the explicit-only takeover are all asserted against the disk.
 *
 * @module tests/integration/project-production-lock.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, PROCESS_INSTANCE, createTempDir, writeJsonAtomic } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { PROJECT_LAYOUT } from '../../core/project/paths.js'
import { readEvents, ProjectEventKind } from '../../core/project/events.js'
import { NeedsAttentionCode } from '../../core/project/schema.js'
import {
  PRODUCTION_LOCK_KIND,
  PRODUCTION_LOCK_SCOPE,
  acquireProduction,
  describeProductionBlocker,
  globalProductionLockPath,
  inspectProduction,
  releaseProduction,
  withProduction,
} from '../../core/project/production-lock.js'

const temp = createTempDir({ label: 'project-production-lock' })
test.after(() => temp.dispose())

let rootCounter = 0

/** A real projects root with two real projects, so "another project" is a real other project. */
function makeRoot() {
  rootCounter += 1
  const root = temp.dir(`root-${rootCounter}`)
  const first = createProject({ projectsRoot: root, title: '项目甲：完整制作' })
  const second = createProject({ projectsRoot: root, title: '项目乙：另一个项目' })
  return { root, projectA: first.project.projectId, projectB: second.project.projectId }
}

test('acquireProduction: the lock file records WHICH project holds the global right', () => {
  const { root, projectA } = makeRoot()
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })

  const handle = acquireProduction({
    projectsRoot: root,
    projectId: projectA,
    taskId: 'C13-full-production',
    projectVersion: 'v1',
    ownerLabel: '测试写入者',
    clock,
  })
  try {
    const lockPath = globalProductionLockPath(root)
    assert.equal(lockPath, path.join(root, '.locks', 'lock.global-production.json'))
    assert.equal(fs.existsSync(lockPath), true, '完整制作锁文件必须真实存在')

    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    assert.equal(record.lockKind, PRODUCTION_LOCK_KIND)
    assert.equal(record.scopeId, PRODUCTION_LOCK_SCOPE)
    assert.equal(record.holderProjectId, projectA, '锁必须记录持有它的项目')
    assert.equal(record.taskId, 'C13-full-production')
    assert.equal(record.ownerPid, process.pid)
    assert.equal(handle.acquiredAt, record.acquiredAt)
    assert.equal(handle.takeover, null)

    const inspected = inspectProduction(root, { clock })
    assert.equal(inspected.verdict, 'live')
    assert.equal(inspected.present, true)
    assert.equal(inspected.needsHandling, false)
    assert.equal(inspected.holder.projectId, projectA)
    assert.equal(inspected.holder.ownerLabel, '测试写入者')
    assert.equal(inspected.holder.taskId, 'C13-full-production')
    assert.equal(inspected.holder.acquiredAt, record.acquiredAt)
    assert.equal(inspected.holder.heartbeatAt, record.heartbeatAt)
  } finally {
    releaseProduction(handle)
  }
  assert.equal(fs.existsSync(globalProductionLockPath(root)), false, '释放后锁文件必须消失')
})

test('acquireProduction: a second DIFFERENT project is refused while one holds it', () => {
  const { root, projectA, projectB } = makeRoot()
  const handle = acquireProduction({ projectsRoot: root, projectId: projectA, taskId: 'C13-produce' })
  try {
    assert.throws(
      () => acquireProduction({ projectsRoot: root, projectId: projectB, taskId: 'C13-produce' }),
      (error) => {
        assert.equal(error.code, 'CONFLICT')
        assert.equal(error.details.code, 'PRODUCTION_LOCK_HELD')
        assert.equal(error.details.holderProjectId, projectA, '拒绝时必须点名持有项目')
        assert.match(error.message, new RegExp(projectA))
        assert.equal(error.details.needsAttention, NeedsAttentionCode.LOCK_HELD)
        assert.match(String(error.details.action), /不会强行抢占/)
        return true
      },
    )
    // The refusal must not have touched the holder's lock.
    const inspected = inspectProduction(root)
    assert.equal(inspected.holder.projectId, projectA)
    assert.equal(inspected.verdict, 'live')
  } finally {
    releaseProduction(handle)
  }
})

test('acquireProduction: the SAME project cannot take the global lock twice', () => {
  const { root, projectA } = makeRoot()
  const handle = acquireProduction({ projectsRoot: root, projectId: projectA, taskId: 'outer' })
  try {
    assert.throws(
      () => acquireProduction({ projectsRoot: root, projectId: projectA, taskId: 'inner' }),
      (error) => {
        assert.equal(error.details.code, 'PRODUCTION_ALREADY_HELD')
        assert.equal(error.details.holderProjectId, projectA)
        assert.equal(error.details.taskId, 'outer', '必须点名真正的持有任务')
        assert.match(error.message, /不重复获取/)
        return true
      },
    )
    // The original handle is still the owner; the refused call must not have replaced it.
    assert.equal(JSON.parse(fs.readFileSync(globalProductionLockPath(root), 'utf8')).taskId, 'outer')
    assert.equal(handle.lock.released, false)
  } finally {
    releaseProduction(handle)
  }
})

test('releaseProduction: another project may take the lock afterwards', () => {
  const { root, projectA, projectB } = makeRoot()
  const first = acquireProduction({ projectsRoot: root, projectId: projectA, taskId: 'first' })
  releaseProduction(first)
  assert.equal(inspectProduction(root).verdict, 'absent')

  const second = acquireProduction({ projectsRoot: root, projectId: projectB, taskId: 'second' })
  try {
    assert.equal(inspectProduction(root).holder.projectId, projectB)
  } finally {
    releaseProduction(second)
  }
  assert.equal(fs.existsSync(globalProductionLockPath(root)), false)
})

test('releaseProduction: is idempotent and reports why a second call did nothing', () => {
  const { root, projectA } = makeRoot()
  const handle = acquireProduction({ projectsRoot: root, projectId: projectA, taskId: 't' })
  assert.equal(releaseProduction(handle).released, true)
  assert.equal(releaseProduction(handle).reason, 'already-released')
})

test('releaseProduction: also accepts the bare lock object', () => {
  const { root, projectA } = makeRoot()
  const handle = acquireProduction({ projectsRoot: root, projectId: projectA, taskId: 't' })
  assert.equal(releaseProduction(handle.lock).released, true)
})

test('inspectProduction: a stale global lock (dead pid) is stale, never deleted', () => {
  const { root, projectA } = makeRoot()
  const lockPath = globalProductionLockPath(root)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  writeJsonAtomic(lockPath, {
    formatVersion: 1,
    lockKind: PRODUCTION_LOCK_KIND,
    scopeId: PRODUCTION_LOCK_SCOPE,
    holderProjectId: projectA,
    ownerPid: 999_999,
    ownerInstanceId: 'dead-instance',
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: '崩溃的完整制作会话',
    taskId: 'C13-crashed-production',
    projectVersion: 'v7',
    acquiredAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  })

  const inspected = inspectProduction(root)
  assert.equal(inspected.verdict, 'stale')
  assert.equal(inspected.held, false, '陈旧锁不等于被占用')
  assert.equal(inspected.needsHandling, true, '陈旧锁必须显示需要处理')
  assert.equal(inspected.ownerAlive, false)
  assert.equal(inspected.holder.projectId, projectA)
  assert.equal(inspected.holder.taskId, 'C13-crashed-production')
  assert.match(inspected.action, /不会自动删除|选择接管/)

  // Acquiring without an explicit takeover must refuse and describe the situation.
  assert.throws(
    () => acquireProduction({ projectsRoot: root, projectId: projectA, taskId: 'retry' }),
    (error) => {
      assert.equal(error.details.code, 'STALE_LOCK')
      assert.equal(error.details.needsAttention, NeedsAttentionCode.LOCK_STALE)
      assert.equal(error.details.holderProjectId, projectA)
      assert.match(String(error.details.action), /不会自动删除/)
      return true
    },
  )
  assert.equal(fs.existsSync(lockPath), true, '陈旧锁文件必须留着，等待用户决定')
})

test('acquireProduction: takeover needs BOTH stealStale and a reason', () => {
  const { root, projectA, projectB } = makeRoot()
  const lockPath = globalProductionLockPath(root)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  writeJsonAtomic(lockPath, {
    formatVersion: 1,
    lockKind: PRODUCTION_LOCK_KIND,
    scopeId: PRODUCTION_LOCK_SCOPE,
    holderProjectId: projectA,
    ownerPid: 999_998,
    ownerInstanceId: 'dead',
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: 'dead session',
    taskId: 'old-task',
    projectVersion: 'v1',
    acquiredAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  })

  // stealStale without a reason is refused before any file is touched.
  assert.throws(
    () => acquireProduction({ projectsRoot: root, projectId: projectB, taskId: 'new', stealStale: true }),
    (error) => error.code === 'VALIDATION_FAILED' && error.details.field === 'reason',
  )
  assert.equal(fs.existsSync(lockPath), true)

  const handle = acquireProduction({
    projectsRoot: root,
    projectId: projectB,
    taskId: 'new-task',
    stealStale: true,
    reason: '用户在“需要处理”中选择接管',
  })
  try {
    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    assert.equal(record.holderProjectId, projectB, '接管后持有者必须是新项目')
    assert.equal(record.taskId, 'new-task')
    assert.equal(record.reason, '用户在“需要处理”中选择接管')
    assert.equal(handle.takeover.stolen, true)
    assert.equal(handle.takeover.previous.projectId, projectA)

    // A takeover is a real user decision, so it must be attributable in the event log.
    assert.equal(handle.takeover.eventRecorded, true)
    const { events } = readEvents(path.join(root, projectB), {
      kinds: [ProjectEventKind.LOCK_TAKEN_OVER],
    })
    assert.equal(events.length, 1)
    assert.equal(events[0].projectId, projectB)
    assert.equal(events[0].detail.reason, '用户在“需要处理”中选择接管')
    assert.equal(events[0].detail.previousProjectId, projectA)
  } finally {
    releaseProduction(handle)
  }
})

test('withProduction: returns the body value and releases the lock', () => {
  const { root, projectA } = makeRoot()
  const value = withProduction(
    { projectsRoot: root, projectId: projectA, taskId: 'C13' },
    (handle) => {
      assert.equal(fs.existsSync(handle.lockPath), true)
      return 42
    },
  )
  assert.equal(value, 42)
  assert.equal(fs.existsSync(globalProductionLockPath(root)), false)
})

test('withProduction: releases even when the body throws', () => {
  const { root, projectA, projectB } = makeRoot()
  assert.throws(
    () =>
      withProduction({ projectsRoot: root, projectId: projectA, taskId: 'C13' }, () => {
        throw new Error('body failed')
      }),
    /body failed/,
  )
  assert.equal(fs.existsSync(globalProductionLockPath(root)), false, '异常路径也必须释放锁')
  // The right is genuinely free again for a different project.
  const next = acquireProduction({ projectsRoot: root, projectId: projectB, taskId: 'next' })
  releaseProduction(next)
})

test('describeProductionBlocker: gives Chinese text and the required next action', () => {
  const { root, projectA, projectB } = makeRoot()

  assert.equal(describeProductionBlocker(inspectProduction(root)), null, '没有锁时不得报阻塞')

  const handle = acquireProduction({ projectsRoot: root, projectId: projectA, taskId: 'C13' })
  try {
    const forOther = describeProductionBlocker(inspectProduction(root), { projectId: projectB })
    assert.equal(forOther.code, NeedsAttentionCode.LOCK_HELD)
    assert.equal(forOther.holderProjectId, projectA)
    assert.match(forOther.message, /正在完整制作/)
    assert.match(forOther.action, /先让该项目结束完整制作/)

    const forSelf = describeProductionBlocker(inspectProduction(root), { projectId: projectA })
    assert.equal(forSelf.code, NeedsAttentionCode.LOCK_HELD)
    assert.match(forSelf.message, /已经在完整制作中/)
  } finally {
    releaseProduction(handle)
  }
})

test('describeProductionBlocker: a stale lock asks the user to take over explicitly', () => {
  const { root, projectA } = makeRoot()
  const lockPath = globalProductionLockPath(root)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  writeJsonAtomic(lockPath, {
    formatVersion: 1,
    lockKind: PRODUCTION_LOCK_KIND,
    scopeId: PRODUCTION_LOCK_SCOPE,
    holderProjectId: projectA,
    ownerPid: 999_997,
    ownerInstanceId: 'dead',
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: 'crashed',
    taskId: 'old',
    projectVersion: 'v1',
    acquiredAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  })

  const blocker = describeProductionBlocker(inspectProduction(root))
  assert.equal(blocker.code, NeedsAttentionCode.LOCK_STALE)
  assert.match(blocker.message, /上次遗留的完整制作锁/)
  assert.match(blocker.action, /选择接管/)
  assert.equal(fs.existsSync(lockPath), true)
})

test('inspectProduction: an unreadable lock is suspicious, not absent', () => {
  const { root } = makeRoot()
  const lockPath = globalProductionLockPath(root)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, '{ broken', 'utf8')

  const inspected = inspectProduction(root)
  assert.equal(inspected.present, true)
  assert.equal(inspected.verdict, 'stale', '读不懂的锁不得当作没有锁')
  assert.equal(inspected.needsHandling, true)
  assert.equal(fs.existsSync(lockPath), true)
})

test('inspectProduction: the lock is separate from the project edit locks', () => {
  const { root, projectA } = makeRoot()
  const handle = acquireProduction({ projectsRoot: root, projectId: projectA, taskId: 'C13' })
  try {
    const names = fs.readdirSync(path.join(root, '.locks')).sort()
    assert.deepEqual(names, ['lock.global-production.json'], '全局锁与项目锁必须是不同文件')
    assert.equal(fs.existsSync(path.join(root, projectA, PROJECT_LAYOUT.projectFile)), true)
  } finally {
    releaseProduction(handle)
  }
})

test('acquireProduction: refuses a relative root, an invalid id and an empty task', () => {
  const { root, projectA } = makeRoot()
  assert.throws(
    () => acquireProduction({ projectsRoot: 'relative/root', projectId: projectA, taskId: 'x' }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  assert.throws(
    () => acquireProduction({ projectsRoot: root, projectId: 'not-an-id', taskId: 'x' }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  assert.throws(
    () => acquireProduction({ projectsRoot: root, projectId: projectA, taskId: '   ' }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})
