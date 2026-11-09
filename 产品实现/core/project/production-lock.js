/**
 * The global production lock: at most ONE project in the whole plugin is in full production.
 *
 * CT-02 §4 splits the write rights into two, and this module owns the second one:
 * - **project edit lock** — at most one modification writer per project (`write-guard.js`);
 * - **global production lock** — at most one project doing full production in the plugin.
 *
 * What a lock proves, and what it does not: a lock file records a DECLARED write right. It never
 * proves that another process has stopped, that an external tool is idle, or that a previous run
 * finished (base/locks.js header; CT-02 §4 "锁只证明声明的写入权，不证明外部进程已停止"). Before
 * acting after a crash the caller must still check the real task state, which `recovery.js` does.
 * This module calls no external tool and deletes no file, so it cannot repeat an interrupted
 * action (CT-01 §4 "状态不明不自动重试外部动作").
 *
 * Decisions encoded here, each with its reason:
 * - The lock file lives in `<projectsRoot>/.locks/` beside the project edit locks, so one root
 *   owns exactly one lock directory. The name comes from `base.lockFileName('global-production',
 *   '*')`, so two kinds of lock can never collide (CT-02 §4).
 * - The record stores `holderProjectId`. The base record only has `scopeId === '*'`, and a
 *   "需要处理" surface must be able to name the project that holds the global right.
 * - **Re-entrant acquisition is REFUSED, not silently granted.** While this project already holds
 *   the global lock, another `acquireProduction` call for the same project throws a
 *   `ConflictError` with `details.code === 'PRODUCTION_ALREADY_HELD'`, naming the holder. Two
 *   handles for one right is how one handle gets released while the other still believes it holds
 *   the lock. A caller that needs a nested section takes the handle once and passes it down; the
 *   alternative (returning the existing handle) would make `releaseProduction` idempotent-looking
 *   while silently releasing a lock the outer section still needs.
 * - A STALE lock is reported as "需要处理" and is NEVER auto-deleted. Takeover requires BOTH
 *   `{ stealStale: true }` AND a non-empty `reason`, and it appends a `lock.taken-over` event, so
 *   a takeover is always attributable to a real user decision (CT-02 §4).
 *
 * @module core/project/production-lock
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  ConflictError,
  IoError,
  ValidationError,
  acquireLock,
  inspectLock,
  lockFileName,
} from '../../base/index.js'
import { assertId } from './ids.js'
import { NeedsAttentionCode } from './schema.js'
import { LOCK_DIR } from './write-guard.js'
import { appendEvents, buildEvent, ProjectEventKind } from './events.js'

/** Lock kind recorded in the lock file, matching base/locks.js vocabulary. */
export const PRODUCTION_LOCK_KIND = 'global-production'

/** The global lock covers every project, so its scope id is `*` (base/locks.js). */
export const PRODUCTION_LOCK_SCOPE = '*'

/** Action text shown for a stale global lock; the program never deletes it. */
export const STALE_PRODUCTION_ACTION =
  '确认上一个写入者已经停止后，由你在“需要处理”中选择接管；程序不会自动删除这把锁'

/**
 * Absolute path of the plugin-wide production lock.
 * @param {string} projectsRoot absolute path of the projects container
 * @returns {string}
 */
export function globalProductionLockPath(projectsRoot) {
  const root = requireProjectsRoot(projectsRoot)
  return path.join(root, LOCK_DIR, lockFileName(PRODUCTION_LOCK_KIND, PRODUCTION_LOCK_SCOPE))
}

/**
 * Read the lock and say whether a project may enter full production.
 *
 * @param {string} projectsRoot
 * @param {{ clock?: Clock, staleAfterMs?: number }} [options]
 * @returns {{
 *   lockPath: string,
 *   present: boolean,
 *   verdict: 'absent' | 'live' | 'stale',
 *   held: boolean,
 *   needsHandling: boolean,
 *   ownerAlive: boolean,
 *   holder: null | {
 *     projectId: string, projectVersion: string, ownerLabel: string, ownerPid: number,
 *     taskId: string, acquiredAt: string, heartbeatAt: string,
 *   },
 *   ageMs: number,
 *   action: string,
 * }}
 */
export function inspectProduction(projectsRoot, options = {}) {
  const lockPath = globalProductionLockPath(projectsRoot)
  const clock = options.clock ?? new Clock()
  const inspected = inspectLock(lockPath, { clock, staleAfterMs: options.staleAfterMs })
  if (inspected === null) {
    return {
      lockPath,
      present: false,
      verdict: 'absent',
      held: false,
      needsHandling: false,
      ownerAlive: false,
      holder: null,
      ageMs: 0,
      action: '',
    }
  }
  const stale = inspected.stale === true
  return {
    lockPath,
    present: true,
    verdict: stale ? 'stale' : 'live',
    held: !stale,
    needsHandling: stale,
    ownerAlive: inspected.ownerAlive === true,
    holder: describeHolder(inspected.record),
    ageMs: inspected.ageMs,
    action: stale ? STALE_PRODUCTION_ACTION : '',
  }
}

/**
 * Turn a lock record into the holder facts a "需要处理" surface shows.
 * @param {any} record
 * @returns {{ projectId: string, projectVersion: string, ownerLabel: string, ownerPid: number,
 *   taskId: string, acquiredAt: string, heartbeatAt: string }}
 */
function describeHolder(record) {
  return {
    projectId: String(record?.holderProjectId ?? ''),
    projectVersion: String(record?.projectVersion ?? ''),
    ownerLabel: String(record?.ownerLabel ?? '未知'),
    ownerPid: Number(record?.ownerPid ?? -1),
    taskId: String(record?.taskId ?? '未知'),
    acquiredAt: String(record?.acquiredAt ?? ''),
    heartbeatAt: String(record?.heartbeatAt ?? ''),
  }
}

/**
 * Chinese user-facing text for a blocked production start, with the required next action.
 *
 * Returns `null` when nothing blocks (no lock file), so a caller can render "可以开始" without
 * inventing wording of its own. The action text always says what the USER has to do, because
 * deciding to take over a lock is a human decision (CT-02 §4).
 *
 * @param {ReturnType<typeof inspectProduction> | null} inspected
 * @param {{ projectId?: string }} [options] the project that wants to start, so "already you" can
 *   be worded differently from "another project"
 * @returns {null | { code: string, holderProjectId: string, message: string, action: string }}
 */
export function describeProductionBlocker(inspected, options = {}) {
  if (inspected === null || inspected === undefined || inspected.present !== true) return null
  const holder = inspected.holder ?? { projectId: '', ownerLabel: '未知', taskId: '未知' }
  const holderName = holder.projectId.length > 0 ? holder.projectId : '未知项目'
  const requested = typeof options.projectId === 'string' ? options.projectId : ''
  if (inspected.verdict === 'stale') {
    return {
      code: NeedsAttentionCode.LOCK_STALE,
      holderProjectId: holder.projectId,
      message: `检测到上次遗留的完整制作锁（持有项目：${holderName}）`,
      action: STALE_PRODUCTION_ACTION,
    }
  }
  if (requested.length > 0 && holder.projectId === requested) {
    return {
      code: NeedsAttentionCode.LOCK_HELD,
      holderProjectId: holder.projectId,
      message: '该项目已经在完整制作中，不会重复获取完整制作锁',
      action: '继续当前完整制作，或先结束它再重新开始',
    }
  }
  return {
    code: NeedsAttentionCode.LOCK_HELD,
    holderProjectId: holder.projectId,
    message: `另一个项目（${holderName}）正在完整制作；全插件同时只允许一个项目完整制作`,
    action: '先让该项目结束完整制作，再开始这里；程序不会强行抢占',
  }
}

/**
 * Acquire the plugin-wide full-production right for one project.
 *
 * @param {object} options
 * @param {string} options.projectsRoot absolute path of the projects container
 * @param {string} options.projectId project that wants to enter full production
 * @param {string} options.taskId what it is about to do, shown in "需要处理"
 * @param {string} [options.projectVersion]
 * @param {string} [options.ownerLabel]
 * @param {boolean} [options.stealStale] only after a human chose takeover in a real surface
 * @param {string} [options.reason] required with `stealStale`, stored in the lock record
 * @param {number} [options.staleAfterMs]
 * @param {Clock} [options.clock]
 * @returns {{
 *   lock: import('../../base/index.js').FileLock,
 *   lockPath: string,
 *   projectId: string,
 *   taskId: string,
 *   acquiredAt: string,
 *   heartbeatAt: string,
 *   takeover: null | { stolen: boolean, previous: object, reason: string,
 *     eventRecorded: boolean, eventSkipped: string },
 * }}
 */
export function acquireProduction(options) {
  const projectsRoot = requireProjectsRoot(options?.projectsRoot)
  const projectId = assertId(options.projectId, 'project', 'projectId')
  const taskId = requireNonEmptyText(options.taskId, 'taskId')
  const clock = options.clock ?? new Clock()
  const lockPath = globalProductionLockPath(projectsRoot)
  const stealStale = options.stealStale === true
  const reason = normalizeReason(options.reason)
  if (stealStale && reason.length === 0) {
    throw new ValidationError('接管陈旧锁必须说明理由', { field: 'reason' })
  }

  const before = inspectProduction(projectsRoot, { clock, staleAfterMs: options.staleAfterMs })
  if (before.present) {
    if (before.verdict === 'stale') {
      if (!stealStale) throw staleConflict(before)
    } else if (before.holder.projectId === projectId) {
      throw new ConflictError('该项目已经持有完整制作锁，不重复获取', {
        code: 'PRODUCTION_ALREADY_HELD',
        holderProjectId: before.holder.projectId,
        ownerLabel: before.holder.ownerLabel,
        taskId: before.holder.taskId,
        projectVersion: before.holder.projectVersion,
        acquiredAt: before.holder.acquiredAt,
        heartbeatAt: before.holder.heartbeatAt,
        ageMs: before.ageMs,
        action: '继续当前完整制作，或先结束它再重新开始；不要同时持有两个句柄',
      })
    } else {
      throw heldConflict(before)
    }
  }

  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  let lock
  try {
    lock = acquireLock(lockPath, {
      kind: PRODUCTION_LOCK_KIND,
      scopeId: PRODUCTION_LOCK_SCOPE,
      taskId,
      projectVersion: options.projectVersion,
      ownerLabel: options.ownerLabel ?? `项目 ${projectId}`,
      reason,
      stealStale,
      clock,
    })
  } catch (error) {
    throw translateBaseConflict(error, projectsRoot, projectId, options)
  }

  // Record WHICH project holds the right. The base record cannot carry it, so it is added and
  // persisted through the lock's own atomic heartbeat write (never a hand-rolled write here).
  try {
    lock.record.holderProjectId = projectId
    lock.beat()
  } catch (error) {
    lock.release()
    throw new IoError('完整制作锁的记录无法写入', {
      details: { stage: 'record-holder', lockKind: PRODUCTION_LOCK_KIND },
      cause: error,
    })
  }

  let takeover = null
  if (before.verdict === 'stale') {
    const recorded = recordTakeoverEvent(projectsRoot, projectId, {
      reason,
      previous: before.holder,
      taskId,
    }, clock)
    takeover = { stolen: true, previous: before.holder, reason, ...recorded }
  }

  return {
    lock,
    lockPath,
    projectId,
    taskId,
    acquiredAt: String(lock.record.acquiredAt ?? ''),
    heartbeatAt: String(lock.record.heartbeatAt ?? ''),
    takeover,
  }
}

/**
 * Release a handle returned by {@link acquireProduction}.
 *
 * Idempotent in the sense that a second call reports `already-released` instead of throwing, and it
 * never deletes a lock another writer now owns (base `FileLock.release`).
 *
 * @param {{ lock?: import('../../base/index.js').FileLock } | import('../../base/index.js').FileLock} handle
 * @returns {{ released: boolean, reason?: string }}
 */
export function releaseProduction(handle) {
  if (handle === null || typeof handle !== 'object') {
    throw new ValidationError('需要完整制作锁句柄', { field: 'handle' })
  }
  const lock = typeof (/** @type {any} */ (handle).release) === 'function' ? handle : handle.lock
  if (lock === null || lock === undefined || typeof (/** @type {any} */ (lock).release) !== 'function') {
    throw new ValidationError('完整制作锁句柄缺少锁对象', { field: 'handle' })
  }
  return (/** @type {any} */ (lock)).release()
}

/**
 * Run `fn` while holding the global production lock, releasing it on every exit path.
 *
 * Synchronous by design: with an async body the `finally` would release the lock before the work
 * finished. Long or asynchronous work takes the handle once with {@link acquireProduction} and
 * releases it in its own `finally`.
 *
 * @template T
 * @param {Parameters<typeof acquireProduction>[0]} options
 * @param {(handle: ReturnType<typeof acquireProduction>) => T} fn
 * @returns {T}
 */
export function withProduction(options, fn) {
  const handle = acquireProduction(options)
  try {
    return fn(handle)
  } finally {
    try {
      releaseProduction(handle)
    } catch {
      // base FileLock.release reports a reason instead of throwing; this is belt-and-braces, and a
      // leftover lock is then visible through inspectProduction rather than masking fn's result.
    }
  }
}

/**
 * Append the `lock.taken-over` event to the taking project's log.
 *
 * A missing project directory (the project may not exist yet in the root) or an unwritable log is
 * reported in the returned value instead of throwing: the takeover itself already happened, and
 * throwing here would leave a held lock with no handle in the caller's hands.
 *
 * @param {string} projectsRoot
 * @param {string} projectId
 * @param {{ reason: string, previous: object, taskId: string }} input
 * @param {Clock} clock
 * @returns {{ eventRecorded: boolean, eventSkipped: string }}
 */
function recordTakeoverEvent(projectsRoot, projectId, input, clock) {
  const projectDir = path.join(projectsRoot, projectId)
  if (!fs.existsSync(projectDir)) return { eventRecorded: false, eventSkipped: 'project-dir-missing' }
  try {
    appendEvents(
      projectDir,
      [
        buildEvent({
          kind: ProjectEventKind.LOCK_TAKEN_OVER,
          projectId,
          actor: 'user',
          detail: {
            lockKind: PRODUCTION_LOCK_KIND,
            reason: input.reason,
            taskId: input.taskId,
            previousProjectId: String(input.previous?.projectId ?? ''),
            previousOwnerLabel: String(input.previous?.ownerLabel ?? ''),
            previousTaskId: String(input.previous?.taskId ?? ''),
          },
        }),
      ],
      { clock },
    )
    return { eventRecorded: true, eventSkipped: '' }
  } catch (error) {
    return { eventRecorded: false, eventSkipped: error?.code ?? 'event-write-failed' }
  }
}

/**
 * Refuse because another project holds the right, naming it.
 * @param {ReturnType<typeof inspectProduction>} inspected
 */
function heldConflict(inspected) {
  const holder = inspected.holder
  return new ConflictError(`另一个项目（${holder.projectId || '未知'}）正在完整制作`, {
    code: 'PRODUCTION_LOCK_HELD',
    lockKind: PRODUCTION_LOCK_KIND,
    holderProjectId: holder.projectId,
    ownerLabel: holder.ownerLabel,
    taskId: holder.taskId,
    projectVersion: holder.projectVersion,
    acquiredAt: holder.acquiredAt,
    heartbeatAt: holder.heartbeatAt,
    ageMs: inspected.ageMs,
    needsAttention: NeedsAttentionCode.LOCK_HELD,
    action: '先让该项目结束完整制作，再开始这里；程序不会强行抢占',
  })
}

/**
 * Refuse because the leftover lock needs a human decision.
 * @param {ReturnType<typeof inspectProduction>} inspected
 */
function staleConflict(inspected) {
  const holder = inspected.holder
  return new ConflictError('检测到陈旧完整制作锁，需要处理', {
    code: 'STALE_LOCK',
    lockKind: PRODUCTION_LOCK_KIND,
    holderProjectId: holder.projectId,
    ownerLabel: holder.ownerLabel,
    taskId: holder.taskId,
    heartbeatAt: holder.heartbeatAt,
    ageMs: inspected.ageMs,
    ownerAlive: inspected.ownerAlive,
    needsAttention: NeedsAttentionCode.LOCK_STALE,
    action: STALE_PRODUCTION_ACTION,
  })
}

/**
 * Translate a base lock refusal into the production-lock vocabulary.
 *
 * The base refuses LOCK_HELD/STALE_LOCK/LOCK_RACE; those codes are kept but the message names the
 * real holder, because a raw "该范围已被占用" is not actionable for a user.
 *
 * @param {unknown} error
 * @param {string} projectsRoot
 * @param {string} projectId
 * @param {any} options
 * @returns {unknown}
 */
function translateBaseConflict(error, projectsRoot, projectId, options) {
  if (!(error instanceof ConflictError)) return error
  const inspected = inspectProduction(projectsRoot, { clock: options.clock, staleAfterMs: options.staleAfterMs })
  if (error.details?.code === 'STALE_LOCK') {
    if (inspected.present && inspected.verdict === 'stale') return staleConflict(inspected)
    return error
  }
  if (inspected.present && inspected.verdict === 'live') {
    if (inspected.holder.projectId === projectId) {
      return new ConflictError('该项目已经持有完整制作锁，不重复获取', {
        code: 'PRODUCTION_ALREADY_HELD',
        holderProjectId: projectId,
        taskId: inspected.holder.taskId,
        acquiredAt: inspected.holder.acquiredAt,
        action: '继续当前完整制作，或先结束它再重新开始；不要同时持有两个句柄',
      })
    }
    return heldConflict(inspected)
  }
  return error
}

/** @param {unknown} value @param {string} field @returns {string} */
function requireNonEmptyText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`需要${field}`, { field })
  }
  return value.trim()
}

/** @param {string} value @returns {string} */
function requireProjectsRoot(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('需要项目根目录', { field: 'projectsRoot' })
  }
  if (!path.isAbsolute(value)) {
    throw new ValidationError('项目根目录必须是绝对路径', { field: 'projectsRoot' })
  }
  return path.resolve(value)
}

/** @param {unknown} value @returns {string} */
function normalizeReason(value) {
  return typeof value === 'string' ? value.trim() : ''
}
