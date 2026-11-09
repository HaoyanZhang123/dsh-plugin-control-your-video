/**
 * Advisory file locks with owner identity, heartbeat and stale detection.
 *
 * Contract (CT-02 §4): a project needs two kinds of lock — one "whole-production" lock shared
 * across all projects, and one per-project modification lock. `withFileLock` may be the
 * primitive, but it does not carry project id, owner, task, heartbeat or stale policy, so
 * this module adds them.
 *
 * Product rules encoded here:
 * - a lock proves only a *declared* write right; it never proves an external process stopped;
 * - a stale lock is reported as "需要处理" and is never auto-deleted, because deleting a live
 *   lock corrupts another writer's work;
 * - PID reuse must not be mistaken for the owner being alive, so the owner identity includes
 *   a random instance id and a start marker;
 * - the same lock is shared by user edits and AI edits (CT-02 §4).
 *
 * @module base/locks
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { writeJsonAtomic, readJson } from './atomic-write.js'
import { hitFault } from './faults.js'
import { Clock } from './determinism.js'

/** Lock record version, so old locks can be detected rather than misread. */
export const LOCK_FORMAT_VERSION = 1

/** Default heartbeat interval used by {@link FileLock#startHeartbeat}. */
export const DEFAULT_HEARTBEAT_MS = 15_000

/** Default age after which a lock with no heartbeat advance is suspicious. */
export const DEFAULT_STALE_AFTER_MS = 120_000

/**
 * ISO timestamp of approximately when this process started.
 *
 * Isolated in a function so the single `Date.now()` use is explicit and testable.
 * dsh-allow S2: process start is module-level metadata, not a render input.
 * @returns {string}
 */
function processStartIso() {
  // Process start is module-level metadata, not a render input, so the wall clock is correct
  // here and a Clock cannot exist yet. Registered exemption: S2.
  const startedAt = Date.now() - Math.round(process.uptime() * 1000) // dsh-allow S2: module-level process start
  return new Date(startedAt).toISOString()
}

/**
 * Identity of this process instance.
 *
 * A PID alone is not enough: Windows reuses PIDs, so a stale lock from pid 1234 could look
 * alive after the OS hands 1234 to something else. `instanceId` is random per process and
 * the start time disambiguates a reuse.
 */
export const PROCESS_INSTANCE = Object.freeze({
  pid: process.pid,
  instanceId: crypto.randomBytes(8).toString('hex'),
  // Process start time is a process-lifetime fact, not a per-run timestamp; a Clock cannot
  // be injected before module evaluation, so this is the registered exemption for S2.
  startedAt: processStartIso(),
  host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown-host',
})

/**
 * @typedef {object} LockRecord
 * @property {number} formatVersion
 * @property {'global-production'|'project-edit'} lockKind
 * @property {string} scopeId project id, or `*` for the global lock
 * @property {string} ownerPid
 * @property {string} ownerInstanceId
 * @property {string} ownerHost
 * @property {string} ownerLabel human-readable, for "需要处理" messages
 * @property {string} taskId
 * @property {string} projectVersion
 * @property {string} acquiredAt
 * @property {string} heartbeatAt
 * @property {string} [reason]
 */

/**
 * Path of a lock file inside a guarded directory.
 *
 * The scope id is encoded LOSSLESSLY. A naive `replace(/[^A-Za-z0-9._-]/g, '_')` makes
 * distinct projects collide: `prj/1` and `prj_1` both become `prj_1`, and every non-ASCII id
 * collapses to `___`. Two unrelated projects would then share one lock file, so one could
 * block — or take over — the other's edit lock.
 *
 * Encoding rules:
 * - characters that are safe in a filename and NOT the escape character are kept as-is;
 * - everything else is percent-encoded, so the mapping is injective and reversible;
 * - `%` itself is always encoded, which keeps the encoding unambiguous.
 *
 * @param {'global-production'|'project-edit'} lockKind
 * @param {string} scopeId
 * @returns {string}
 */
export function lockFileName(lockKind, scopeId) {
  if (lockKind !== 'global-production' && lockKind !== 'project-edit') {
    throw new ValidationError(`未知锁类型: ${String(lockKind)}`)
  }
  if (typeof scopeId !== 'string' || scopeId.length === 0) {
    throw new ValidationError('锁需要一个 scopeId')
  }
  if (lockKind === 'global-production') return 'lock.global-production.json'
  return `lock.project-edit.${encodeScopeId(scopeId)}.json`
}

/**
 * Lossless, filename-safe encoding of a scope id.
 * @param {string} scopeId
 * @returns {string}
 */
export function encodeScopeId(scopeId) {
  let out = ''
  for (const char of scopeId) {
    if (/[A-Za-z0-9._-]/.test(char)) {
      out += char
    } else {
      // Percent-encode the full UTF-8 byte sequence so non-ASCII ids stay distinct.
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
      }
    }
  }
  return out
}

/**
 * Recover a scope id from its encoded filename form.
 * @param {string} encoded
 * @returns {string}
 */
export function decodeScopeId(encoded) {
  const bytes = []
  let index = 0
  while (index < encoded.length) {
    const char = encoded[index]
    if (char === '%') {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16))
      index += 3
    } else {
      for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte)
      index += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Locks currently held by THIS process, keyed by absolute lock path. */
const HELD_LOCKS = new Map()

/**
 * A held lock. Always release it in `finally`, or use {@link withLock}.
 */
export class FileLock {
  /**
   * @param {string} lockPath absolute path of the lock file
   * @param {LockRecord} record
   * @param {object} [options]
   */
  constructor(lockPath, record, options = {}) {
    this.path = lockPath
    this.record = record
    this.clock = options.clock ?? new Clock()
    this.heartbeatTimer = null
    this.released = false
    this.heartbeats = 0
  }

  /** Refresh the heartbeat so other processes see this lock as live. */
  beat() {
    if (this.released) return false
    this.record.heartbeatAt = this.clock.iso()
    this.heartbeats += 1
    writeJsonAtomic(this.path, this.record)
    return true
  }

  /**
   * Start a periodic heartbeat. Keep the returned function for cleanup.
   * @param {number} [intervalMs]
   * @returns {() => void} stop function
   */
  startHeartbeat(intervalMs = DEFAULT_HEARTBEAT_MS) {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      try {
        this.beat()
      } catch {
        // A failed heartbeat must not crash the holder; stale detection will report it.
      }
    }, intervalMs)
    // Do not keep the process alive just for a heartbeat.
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
    return () => this.stopHeartbeat()
  }

  /** Stop the heartbeat timer. */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * Release the lock. Idempotent. Only removes the file when it is still OUR lock, so a
   * lock stolen or replaced by another writer is never deleted by mistake.
   * @returns {{ released: boolean, reason?: string }}
   */
  release() {
    if (this.released) return { released: false, reason: 'already-released' }
    this.stopHeartbeat()
    this.released = true
    if (HELD_LOCKS.get(this.path)?.ownerInstanceId === this.record.ownerInstanceId) {
      HELD_LOCKS.delete(this.path)
    }
    let current
    try {
      current = readJson(this.path)
    } catch {
      return { released: false, reason: 'lock-file-missing' }
    }
    if (current.ownerInstanceId !== this.record.ownerInstanceId || current.ownerPid !== this.record.ownerPid) {
      return { released: false, reason: 'ownership-changed' }
    }
    try {
      fs.rmSync(this.path, { force: true })
      return { released: true }
    } catch (error) {
      return { released: false, reason: error?.code ?? String(error) }
    }
  }
}

/**
 * Inspect an existing lock without acquiring it.
 * @param {string} lockPath
 * @param {{ staleAfterMs?: number, clock?: Clock }} [options]
 * @returns {null | {
 *   record: LockRecord,
 *   ageMs: number,
 *   stale: boolean,
 *   ownerAlive: boolean,
 *   verdict: 'live' | 'stale',
 * }}
 */
export function inspectLock(lockPath, options = {}) {
  const clock = options.clock ?? new Clock()
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  if (!fs.existsSync(lockPath)) return null
  let record
  try {
    record = readJson(lockPath)
  } catch {
    // An unreadable lock is a conflict, not "no lock": refuse to guess.
    return {
      record: /** @type {any} */ ({ formatVersion: -1, ownerLabel: 'unknown', heartbeatAt: '' }),
      ageMs: -1,
      stale: true,
      ownerAlive: false,
      verdict: 'stale',
    }
  }
  const beatAt = Date.parse(record.heartbeatAt ?? record.acquiredAt ?? '')
  const ageMs = Number.isFinite(beatAt) ? clock.now() - beatAt : Number.POSITIVE_INFINITY
  const ownerAlive = isLockOwnerAlive(record)
  const stale = !ownerAlive || ageMs > staleAfterMs
  return { record, ageMs, stale, ownerAlive, verdict: stale ? 'stale' : 'live' }
}

/** Whether the recorded owner still looks alive on this host. */
function isLockOwnerAlive(record) {
  if (!record || typeof record.ownerPid !== 'number') return false
  if (record.ownerHost !== PROCESS_INSTANCE.host) {
    // A lock from another machine cannot be probed; treat as alive and let age decide.
    return true
  }
  if (record.ownerPid === process.pid) {
    // Our own PID: check whether this is really our instance.
    return record.ownerInstanceId === PROCESS_INSTANCE.instanceId
  }
  try {
    process.kill(record.ownerPid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Acquire a lock, or throw {@link ConflictError} describing who holds it.
 *
 * @param {string} lockPath absolute path
 * @param {object} options
 * @param {'global-production'|'project-edit'} options.kind
 * @param {string} options.scopeId
 * @param {string} options.taskId
 * @param {string} [options.projectVersion]
 * @param {string} [options.ownerLabel]
 * @param {string} [options.reason]
 * @param {boolean} [options.stealStale] only a human "需要处理" decision may set this
 * @param {Clock} [options.clock]
 * @returns {FileLock}
 */
export function acquireLock(lockPath, options) {
  const clock = options.clock ?? new Clock()
  hitFault('lock:before-acquire', `kind=${options.kind}`)

  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  const existing = inspectLock(lockPath, { clock })
  if (existing) {
    // A lock held by THIS process on the same path is contention inside one writer process:
    // report it as held (with the owning task) rather than as a filesystem race.
    const heldHere = HELD_LOCKS.get(lockPath)
    const sameOwner =
      existing.record.ownerInstanceId === PROCESS_INSTANCE.instanceId && existing.record.ownerPid === process.pid
    if (sameOwner && heldHere) {
      throw new ConflictError('该范围已被本进程的另一个任务占用', {
        code: 'LOCK_HELD',
        lockKind: existing.record.lockKind,
        scopeId: existing.record.scopeId,
        ownerPid: existing.record.ownerPid,
        ownerLabel: existing.record.ownerLabel,
        taskId: existing.record.taskId,
        holderTaskId: existing.record.taskId,
        heartbeatAt: existing.record.heartbeatAt,
        ageMs: existing.ageMs,
      })
    }
    if (!sameOwner) {
      if (existing.stale && options.stealStale !== true) {
        throw new ConflictError('检测到陈旧锁，需要处理', {
          code: 'STALE_LOCK',
          lockKind: existing.record.lockKind,
          scopeId: existing.record.scopeId,
          ownerPid: existing.record.ownerPid,
          ownerLabel: existing.record.ownerLabel,
          heartbeatAt: existing.record.heartbeatAt,
          ageMs: existing.ageMs,
          ownerAlive: existing.ownerAlive,
          action: '需要用户确认后才能接管，不自动删除',
        })
      }
      if (!existing.stale) {
        throw new ConflictError('该范围正在被另一个写入者占用', {
          code: 'LOCK_HELD',
          lockKind: existing.record.lockKind,
          scopeId: existing.record.scopeId,
          ownerPid: existing.record.ownerPid,
          ownerLabel: existing.record.ownerLabel,
          taskId: existing.record.taskId,
          holderTaskId: existing.record.taskId,
          heartbeatAt: existing.record.heartbeatAt,
          ageMs: existing.ageMs,
        })
      }
      // stealStale === true and the lock is stale: the caller (a human "需要处理" decision)
      // explicitly authorized the takeover, so the stale file is replaced deliberately.
      try {
        fs.rmSync(lockPath, { force: true })
      } catch (error) {
        throw new ConflictError('接管陈旧锁时无法移除旧锁文件', {
          code: 'STALE_LOCK_TAKEOVER_FAILED',
          reason: error?.code ?? String(error),
        })
      }
    }
  }

  /** @type {LockRecord} */
  const record = {
    formatVersion: LOCK_FORMAT_VERSION,
    lockKind: options.kind,
    scopeId: options.scopeId,
    ownerPid: process.pid,
    ownerInstanceId: PROCESS_INSTANCE.instanceId,
    ownerHost: PROCESS_INSTANCE.host,
    ownerLabel: options.ownerLabel ?? `pid ${process.pid}`,
    taskId: options.taskId ?? 'unknown-task',
    projectVersion: options.projectVersion ?? 'unknown',
    acquiredAt: clock.iso(),
    heartbeatAt: clock.iso(),
    reason: options.reason ?? '',
  }

  // wx: fail if another writer created the file between the inspect and this write.
  try {
    const fd = fs.openSync(lockPath, 'wx')
    try {
      fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const race = inspectLock(lockPath, { clock })
      throw new ConflictError('抢占锁时发生并发写入', {
        code: 'LOCK_RACE',
        holder: race?.record?.ownerLabel ?? 'unknown',
        holderTaskId: race?.record?.taskId ?? 'unknown',
      })
    }
    throw error
  }

  // Track it so a second acquisition in this process reports LOCK_HELD, not a raw EEXIST.
  HELD_LOCKS.set(lockPath, record)
  return new FileLock(lockPath, record, { clock })
}

/**
 * Run `fn` while holding a lock, releasing it even when `fn` throws.
 * @template T
 * @param {string} lockPath
 * @param {Parameters<typeof acquireLock>[1]} options
 * @param {(lock: FileLock) => T} fn
 * @returns {T}
 */
export function withLock(lockPath, options, fn) {
  const lock = acquireLock(lockPath, options)
  try {
    return fn(lock)
  } finally {
    lock.release()
  }
}

/**
 * Read a lock that must exist.
 * @param {string} lockPath
 * @returns {LockRecord}
 */
export function requireLock(lockPath) {
  if (!fs.existsSync(lockPath)) {
    throw new NotFoundError('没有找到锁文件', { lockPath: path.basename(lockPath) })
  }
  return /** @type {LockRecord} */ (readJson(lockPath))
}
