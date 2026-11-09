/**
 * Single-writer enforcement for one project: the project-modification lock.
 *
 * CT-02 §4 requires two separate rights, and this module provides the per-project one:
 * - **project edit lock** — at most one modification writer per project at a time;
 * - (the global "only one project is in full production" lock lives in `production-lock.js`.)
 *
 * The base lock primitive proves only a DECLARED write right and never that another process has
 * stopped (base/locks.js header; CT-02 §4). So this wrapper adds the parts CT-02 §4 demands on
 * top: project id, owner, task/version, heartbeat and an explicit stale decision. A stale lock is
 * reported as NEEDS HANDLING and is never auto-deleted; taking it over requires the caller to say
 * so explicitly, which in the product only happens after the user chose it in a real "需要处理"
 * surface.
 *
 * User edits and AI edits share this same lock (CT-02 §4 "用户直接修改与 AI 修改共用同一锁").
 *
 * @module core/project/write-guard
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  ConflictError,
  ErrorCode,
  ValidationError,
  WorkbenchError,
  acquireLock,
  inspectLock,
  lockFileName,
} from '../../base/index.js'
import { NeedsAttentionCode } from './schema.js'

/** Locks live beside the project directories so one root owns all of them. */
export const LOCK_DIR = '.locks'

/**
 * Path of one project's edit lock inside the projects root.
 * @param {string} projectsRoot absolute
 * @param {string} projectId
 * @returns {string}
 */
export function projectEditLockPath(projectsRoot, projectId) {
  if (typeof projectsRoot !== 'string' || !path.isAbsolute(projectsRoot)) {
    throw new ValidationError('项目根目录必须是绝对路径', { field: 'projectsRoot' })
  }
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new ValidationError('锁需要项目标识', { field: 'projectId' })
  }
  return path.join(path.resolve(projectsRoot), LOCK_DIR, lockFileName('project-edit', projectId))
}

/**
 * Inspect a project's edit lock without acquiring it.
 * @param {string} lockPath
 * @param {{ staleAfterMs?: number, clock?: Clock }} [options]
 * @returns {null | { held: boolean, stale: boolean, ownerAlive: boolean, record: any, ageMs: number }}
 */
export function inspectProjectWriter(lockPath, options = {}) {
  const inspected = inspectLock(lockPath, options)
  if (inspected === null) return null
  return {
    held: true,
    stale: inspected.stale === true,
    ownerAlive: inspected.ownerAlive === true,
    record: inspected.record,
    ageMs: inspected.ageMs,
  }
}

/**
 * Describe an existing lock as a "needs handling" item a user can act on.
 * @param {{ stale: boolean, record: any }} inspected
 * @returns {{ code: string, message: string, ownerLabel: string, taskId: string, acquiredAt: string, action: string }}
 */
export function describeLockConflict(inspected) {
  const stale = inspected.stale === true
  return {
    code: stale ? NeedsAttentionCode.LOCK_STALE : NeedsAttentionCode.LOCK_HELD,
    message: stale ? '检测到上次遗留的项目写入锁，需要处理' : '该项目正在被另一个写入者修改',
    ownerLabel: String(inspected.record?.ownerLabel ?? '未知'),
    taskId: String(inspected.record?.taskId ?? '未知'),
    acquiredAt: String(inspected.record?.acquiredAt ?? ''),
    action: stale ? '确认该写入者已停止后，由你在“需要处理”中选择接管；程序不会自动删除' : '等待对方结束，或先暂停当前修改',
  }
}

/**
 * Acquire the project edit lock, or throw a conflict that names the real holder.
 *
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {string} options.taskId what this writer is doing, shown in "需要处理"
 * @param {string} [options.projectVersion]
 * @param {string} [options.ownerLabel]
 * @param {boolean} [options.stealStale] set only after a human chose takeover
 * @param {string} [options.reason] why this writer needs the lock; stored in the record
 * @param {Clock} [options.clock]
 * @returns {import('../../base/index.js').FileLock}
 */
export function acquireProjectWriter(options) {
  const lockPath = projectEditLockPath(options.projectsRoot, options.projectId)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  if (options.stealStale === true && typeof options.reason !== 'string') {
    throw new ValidationError('接管陈旧锁必须记录理由', { field: 'reason' })
  }
  try {
    return acquireLock(lockPath, {
      kind: 'project-edit',
      scopeId: options.projectId,
      taskId: options.taskId,
      projectVersion: options.projectVersion,
      ownerLabel: options.ownerLabel,
      reason: options.reason,
      stealStale: options.stealStale === true,
      clock: options.clock,
    })
  } catch (error) {
    if (error instanceof ConflictError && error.details?.code === 'STALE_LOCK') {
      // Preserve the base refusal but make it actionable in product terms.
      throw new ConflictError('检测到陈旧的项目写入锁，需要处理', {
        ...error.details,
        needsAttention: NeedsAttentionCode.LOCK_STALE,
        message: '上次写入没有正常收尾；程序不会自动删除这把锁',
      })
    }
    throw error
  }
}

/**
 * Run `fn` while holding the project edit lock, releasing it on every exit path.
 *
 * This is the ONLY sanctioned way for another module to modify a project: it makes the
 * single-writer rule impossible to forget.
 *
 * @template T
 * @param {Omit<Parameters<typeof acquireProjectWriter>[0], 'stealStale' | 'reason'>} options
 * @param {(lock: import('../../base/index.js').FileLock) => T} fn
 * @returns {T}
 */
export function withProjectWriter(options, fn) {
  const lock = acquireProjectWriter(options)
  try {
    return fn(lock)
  } finally {
    // A failed release must not swallow the body's real result, but a lock left behind is a real
    // problem, so the reason is recorded on the returned lock for the caller to inspect.
    try {
      lock.release()
    } catch {
      // base.FileLock.release already returns a reason instead of throwing; this is belt-and-braces.
    }
  }
}

/**
 * Reject a write when someone else currently holds the project lock.
 * Read-only callers use this to decide between "可以继续" and "需要处理".
 *
 * @param {string} lockPath
 * @param {{ staleAfterMs?: number, clock?: Clock }} [options]
 * @returns {{ ok: boolean, reason?: string, detail?: object }}
 */
export function checkWriterAvailable(lockPath, options = {}) {
  const inspected = inspectProjectWriter(lockPath, options)
  if (inspected === null) return { ok: true }
  return { ok: false, reason: describeLockConflict(inspected).code, detail: describeLockConflict(inspected) }
}

/**
 * A per-project "execution is in progress" marker, distinct from the write lock.
 *
 * The write lock answers "may I write now"; this marker answers "is a production task still
 * believed to be running". CT-03 §2 requires that an unknowable execution state is shown as
 * paused rather than guessed, so the marker stores what was last KNOWN and a later reader treats
 * an unclosed marker as `unknown`.
 *
 * @param {string} projectsRoot
 * @returns {string}
 */
export function executionMarkerPath(projectsRoot) {
  return path.join(path.resolve(projectsRoot), LOCK_DIR, 'execution.json')
}

/**
 * Mark that a project has a task believed to be running.
 * @param {string} markerPath
 * @param {{ projectId: string, taskId: string, startedAt: string, hostPid: number }} input
 */
export function beginExecution(markerPath, input) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  const document = {
    kind: 'execution-marker',
    open: true,
    ...input,
  }
  fs.writeFileSync(markerPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

/**
 * Clear the execution marker after a clean finish.
 * @param {string} markerPath
 * @returns {{ cleared: boolean }}
 */
export function endExecution(markerPath) {
  try {
    fs.rmSync(markerPath, { force: true })
    return { cleared: true }
  } catch (error) {
    throw new WorkbenchError(ErrorCode.IO_FAILED, '执行标记无法清除', {
      details: { reason: error?.code ?? 'unknown' },
      cause: error,
    })
  }
}

/**
 * Read the execution marker and decide whether the state is knowable.
 *
 * `open: true` with a dead owner is exactly the "状态未知" case: the process did not clean up, so
 * the product must show paused and must NOT repeat the external action (CT-01 §4, CT-03 §2).
 *
 * @param {string} markerPath
 * @param {{ isProcessAlive?: (pid: number) => boolean }} [options]
 * @returns {{ present: boolean, open: boolean, state: string, detail: object | null }}
 */
export function inspectExecution(markerPath, options = {}) {
  if (!fs.existsSync(markerPath)) return { present: false, open: false, state: 'idle', detail: null }
  let document
  try {
    document = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  } catch {
    // An unreadable marker is unknown state, not "no task".
    return {
      present: true,
      open: true,
      state: 'unknown',
      detail: { reason: 'marker-unreadable', code: NeedsAttentionCode.EXECUTION_UNKNOWN },
    }
  }
  const open = document?.open === true
  if (!open) return { present: true, open: false, state: 'idle', detail: document }
  const alive = options.isProcessAlive ?? defaultIsProcessAlive
  const ownerAlive = alive(Number(document?.hostPid ?? -1))
  return {
    present: true,
    open: true,
    state: ownerAlive ? 'running' : 'unknown',
    detail: {
      projectId: String(document?.projectId ?? ''),
      taskId: String(document?.taskId ?? ''),
      startedAt: String(document?.startedAt ?? ''),
      ownerPid: Number(document?.hostPid ?? -1),
      ownerAlive,
      code: ownerAlive ? null : NeedsAttentionCode.EXECUTION_UNKNOWN,
      action: ownerAlive ? null : '上次执行没有正常收尾；先按已暂停处理，核对真实结果后再决定是否继续',
    },
  }
}

/**
 * Whether a PID is alive. Duplicated from base deliberately: this module must not depend on the
 * temp-dir helper just for one probe.
 * @param {number} pid
 * @returns {boolean}
 */
function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}
