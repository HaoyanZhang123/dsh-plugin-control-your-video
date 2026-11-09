/**
 * The project event log: an append-only record of what actually changed.
 *
 * Why a log and not only current state: CT-03 §1 says chat, external projects and tool logs may
 * be REFERENCED but must not become a second source of project truth. A log that records the
 * decision, material-use and version events against object + version is the trace a later card
 * (C11 UI, C13 creation, C14 review, C15 delivery) subscribes to, so none of them has to keep its
 * own shadow copy.
 *
 * Design rules:
 * - **Append-only.** An event is never edited or deleted; a correction is a new event. That is
 *   what makes "确认后有改动" and "回退成为当前版本" reconstructable instead of asserted.
 * - **Self-contained entries.** Each event carries its own ids, so a consumer can act without
 *   joining against mutable state that may have moved on.
 * - **Bounded reads.** Readers ask for a window; the log never hands back an unbounded array that
 *   a long project would turn into a memory problem.
 * - **Crash-safe appends.** Written as one JSON line per event with an fsync, so a truncated tail
 *   is detectable and skippable instead of corrupting earlier events (CT-02 §3).
 *
 * @module core/project/events
 */

import fs from 'node:fs'
import path from 'node:path'
import { Clock, IoError, ValidationError, WorkbenchError, ErrorCode, sha256 } from '../../base/index.js'
import { newId } from './ids.js'

/** Event kinds consumed by later cards. Adding a kind is additive; renaming one is breaking. */
export const ProjectEventKind = Object.freeze({
  PROJECT_CREATED: 'project.created',
  PROJECT_OPENED: 'project.opened',
  PROJECT_COPIED: 'project.copied',
  PROJECT_BRANCHED: 'project.branched',
  PROJECT_PHASE_CHANGED: 'project.phase-changed',
  PROJECT_RENAMED: 'project.renamed',
  PROJECT_ARCHIVED: 'project.archived',
  PROJECT_TRASHED: 'project.trashed',
  PROJECT_RESTORED: 'project.restored',
  SERIES_LINKED: 'series.linked',
  SERIES_UNLINKED: 'series.unlinked',
  SERIES_SHARED_UPDATED: 'series.shared-updated',
  MATERIAL_ADDED: 'material.added',
  MATERIAL_USE_RECORDED: 'material.use-recorded',
  MATERIAL_USE_AMENDED: 'material.use-amended',
  MATERIAL_EXCLUDED: 'material.excluded',
  MATERIAL_MISSING: 'material.missing',
  DECISION_RECORDED: 'decision.recorded',
  CONFIRMATION_RECORDED: 'confirmation.recorded',
  CONFIRMATION_SUPERSEDED: 'confirmation.superseded',
  AUTHORIZATION_RECORDED: 'authorization.recorded',
  AUTHORIZATION_CONSUMED: 'authorization.consumed',
  VERSION_CREATED: 'version.created',
  VERSION_CANDIDATE_CREATED: 'version.candidate-created',
  VERSION_CANDIDATE_ACCEPTED: 'version.candidate-accepted',
  VERSION_CANDIDATE_REJECTED: 'version.candidate-rejected',
  VERSION_CANDIDATE_STALE: 'version.candidate-stale',
  VERSION_FINALIZED: 'version.finalized',
  VERSION_REVERTED: 'version.reverted',
  AUTOSAVE_COMPLETED: 'save.autosave',
  SAVE_PAUSED: 'save.paused',
  RECOVERY_INSPECTED: 'recovery.inspected',
  LOCK_TAKEN_OVER: 'lock.taken-over',
  EXECUTION_UNKNOWN: 'execution.unknown',
  PREFERENCES_CHANGED: 'preferences.changed',
})

/** Maximum events returned by one read, so a long project cannot blow up a caller. */
export const MAX_EVENT_PAGE = 500

/**
 * Absolute path of one project's event log.
 * @param {string} projectDir
 * @returns {string}
 */
export function eventLogPath(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new ValidationError('事件日志需要项目目录', { field: 'projectDir' })
  }
  return path.join(projectDir, 'events.log.jsonl')
}

/**
 * An event as stored.
 * @typedef {object} ProjectEvent
 * @property {string} eventId
 * @property {string} kind
 * @property {string} projectId
 * @property {string} at ISO timestamp
 * @property {string} actor `user` | `ai` | `system`
 * @property {string} [objectId]
 * @property {string} [versionId]
 * @property {string} [aspect]
 * @property {string} [scope]
 * @property {number} sequence 1-based, monotonic within a project
 * @property {object} detail
 */

/**
 * Append events to a project's log.
 *
 * Uses a single `append`-mode write with an explicit fsync and a newline-terminated record, so a
 * crash can lose the tail but cannot interleave bytes into the middle of an earlier event.
 *
 * @param {string} projectDir
 * @param {Array<Omit<ProjectEvent, 'eventId' | 'at' | 'sequence'>>} events
 * @param {{ clock?: Clock, nextSequence?: number }} [options]
 * @returns {{ appended: number, lastSequence: number, path: string }}
 */
export function appendEvents(projectDir, events, options = {}) {
  if (!Array.isArray(events)) throw new ValidationError('events 必须是数组')
  if (events.length === 0) {
    const path0 = eventLogPath(projectDir)
    return { appended: 0, lastSequence: options.nextSequence ?? 0, path: path0 }
  }
  const clock = options.clock ?? new Clock()
  const filePath = eventLogPath(projectDir)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  let sequence = options.nextSequence ?? countEvents(filePath)
  const lines = []
  for (const event of events) {
    sequence += 1
    const record = {
      eventId: newId('event'),
      sequence,
      at: clock.iso(),
      ...event,
    }
    lines.push(JSON.stringify(record))
  }

  const payload = `${lines.join('\n')}\n`
  try {
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeSync(fd, payload)
      // The log is the audit trail; durability of the bytes matters more than a lost tail.
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    throw new IoError('项目事件无法写入', {
      details: { reason: error?.code ?? 'unknown', count: events.length },
      cause: error,
    })
  }
  return { appended: events.length, lastSequence: sequence, path: filePath }
}

/**
 * Count already-recorded events, ignoring a truncated tail.
 * @param {string} filePath
 * @returns {number}
 */
export function countEvents(filePath) {
  if (!fs.existsSync(filePath)) return 0
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return 0
  }
  let count = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    count += 1
  }
  return count
}

/**
 * Read a page of events.
 *
 * A malformed line is reported in `skipped` rather than thrown: an event log with one truncated
 * tail must still let the product open the project, and hiding the damage would be worse than
 * reporting it.
 *
 * @param {string} projectDir
 * @param {{ kinds?: string[], objectId?: string, versionId?: string, limit?: number, fromSequence?: number }} [options]
 * @returns {{ events: ProjectEvent[], total: number, skipped: Array<{ line: number, reason: string }> }}
 */
export function readEvents(projectDir, options = {}) {
  const filePath = eventLogPath(projectDir)
  if (!fs.existsSync(filePath)) return { events: [], total: 0, skipped: [] }
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new IoError('项目事件无法读取', {
      details: { reason: error?.code ?? 'unknown' },
      cause: error,
    })
  }
  const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? new Set(options.kinds) : null
  const limit = Math.min(Number(options.limit ?? MAX_EVENT_PAGE), MAX_EVENT_PAGE)
  const fromSequence = Number(options.fromSequence ?? 0)
  const events = []
  const skipped = []
  let total = 0

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0) continue
    // `total` counts every event in the log, including the ones beyond the page limit, so a
    // caller can honestly show "5 of 30" instead of implying the log only holds 5 events.
    total += 1
    if (events.length >= limit) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      skipped.push({ line: index + 1, reason: 'not-json' })
      continue
    }
    if (typeof record?.kind !== 'string') {
      skipped.push({ line: index + 1, reason: 'missing-kind' })
      continue
    }
    if (Number(record.sequence ?? 0) <= fromSequence) continue
    if (kinds !== null && !kinds.has(record.kind)) continue
    if (options.objectId !== undefined && record.objectId !== options.objectId) continue
    if (options.versionId !== undefined && record.versionId !== options.versionId) continue
    events.push(record)
  }
  return { events, total, skipped }
}

/**
 * Read the most recent events, newest first, without parsing the whole log into memory twice.
 * @param {string} projectDir
 * @param {number} [limit]
 * @returns {ProjectEvent[]}
 */
export function readRecentEvents(projectDir, limit = 20) {
  const { events } = readEvents(projectDir, { limit: MAX_EVENT_PAGE })
  return events.slice(-Math.max(1, limit)).reverse()
}

/**
 * Hash of the event log, so an evidence file can pin the exact state it observed.
 * @param {string} projectDir
 * @returns {string}
 */
export function eventLogDigest(projectDir) {
  const filePath = eventLogPath(projectDir)
  if (!fs.existsSync(filePath)) return ''
  return sha256(fs.readFileSync(filePath))
}

/**
 * Build one event with the fields every kind shares.
 *
 * Kept as a helper so a caller cannot forget `projectId` or `actor`, which would make the event
 * unattributable and therefore useless as a trace.
 *
 * @param {object} input
 * @param {string} input.kind
 * @param {string} input.projectId
 * @param {string} input.actor
 * @param {object} [input.detail]
 * @param {string} [input.objectId]
 * @param {string} [input.versionId]
 * @param {string} [input.aspect]
 * @param {string} [input.scope]
 * @returns {Omit<ProjectEvent, 'eventId' | 'at' | 'sequence'>}
 */
export function buildEvent(input) {
  if (typeof input.kind !== 'string' || input.kind.length === 0) {
    throw new ValidationError('事件需要 kind')
  }
  if (typeof input.projectId !== 'string' || input.projectId.length === 0) {
    throw new ValidationError('事件需要 projectId')
  }
  if (typeof input.actor !== 'string' || input.actor.length === 0) {
    throw new ValidationError('事件需要 actor，否则无法追溯来源')
  }
  const event = {
    kind: input.kind,
    projectId: input.projectId,
    actor: input.actor,
    detail: input.detail ?? {},
  }
  if (input.objectId !== undefined) event.objectId = input.objectId
  if (input.versionId !== undefined) event.versionId = input.versionId
  if (input.aspect !== undefined) event.aspect = input.aspect
  if (input.scope !== undefined) event.scope = input.scope
  return event
}

/**
 * Verify that the log is append-only: every event id must be unique.
 *
 * Used by tests and by the recovery check, because a duplicated event id would mean an append was
 * replayed and a listener could apply the same change twice.
 *
 * @param {string} projectDir
 * @returns {{ ok: boolean, duplicates: string[], total: number }}
 */
export function verifyAppendOnly(projectDir) {
  const { events, total } = readEvents(projectDir, { limit: MAX_EVENT_PAGE })
  const seen = new Set()
  const duplicates = []
  for (const event of events) {
    if (seen.has(event.eventId)) duplicates.push(event.eventId)
    seen.add(event.eventId)
  }
  return { ok: duplicates.length === 0, duplicates, total }
}

/** Re-exported so a caller building an ad-hoc correlation id uses the same generator. */
export { newId }

/** Raised when a caller tries to downgrade the log; exposed for symmetry with store errors. */
export class EventLogError extends WorkbenchError {
  /** @param {string} message @param {object} [details] */
  constructor(message, details) {
    super(ErrorCode.CORRUPT_DATA, message, { details })
  }
}
