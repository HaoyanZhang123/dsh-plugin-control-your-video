/**
 * Tool pins: which tool build a project's version was made with, kept as history and never overwritten.
 *
 * ## Why this is its own module (CR-6, user decision 2026-11-08)
 *
 * A pin connects "project X at version V" to "tool build B". Three parties touch it, and the boundaries
 * between them are the whole point:
 *
 * - **C10** owns project version facts and emits the version-change event. It does not know about tool
 *   builds.
 * - **C06** (here) owns saving, validating and the HISTORY of pins. It must not read or rewrite project
 *   facts, and must not advance a project version by itself.
 * - **C13** owns the sync: it listens to C10 and calls this module to associate the old version with the
 *   new one. It does not decide what a pin means.
 *
 * So this module is deliberately dumb in one specific way: it has **no opinion about what a project
 * version is**. A pin stores `projectId` and `projectVersion` as opaque strings — references. It never
 * derives, increments or normalises a project version, because deriving one would mean owning it.
 *
 * ## The rules it enforces
 *
 * 1. **History is append-only.** A pin for (project, version) is never silently replaced. Advancing marks
 *    the old pin `superseded` and keeps every field, so an old project version continues to point at the
 *    build it was actually made with (CR-6 item 4).
 * 2. **Advancing needs an explicit link.** `advance` requires the predecessor pin to EXIST and to match
 *    the version it claims to move from. A missing predecessor is an out-of-order sync, which is refused
 *    rather than repaired by guessing.
 * 3. **A new pin proves nothing about the tool.** Pinning does not touch the verification record or the
 *    current build. "新版本只建立新的关联，不自动证明工具已安装或可用" (CR-6 item 4).
 * 4. **A stale pin is reported, never fixed.** `recheck` answers "is the pin for the version the project
 *    is actually at now?" and does nothing else. That is what makes open/resume safe without events
 *    (CR-6 item 5) while keeping C06 from advancing a project version (CR-6 item 6).
 *
 * @module tools/pins
 */

import { ConflictError, NotFoundError, ValidationError } from '../base/index.js'

/** Lifecycle of one pin record. `superseded` pins are kept, never removed. */
export const PinState = Object.freeze({
  /** The pin currently associated with its project version. */
  ACTIVE: 'active',
  /** A later pin exists for the same project. Kept for history; still the truth for its own version. */
  SUPERSEDED: 'superseded',
})

/** The answer to "does the pin match the project version the project is at now?". */
export const PinCheck = Object.freeze({
  /** A pin exists for exactly this project version. */
  CURRENT: 'current',
  /** Pins exist, but only for other (older) project versions: C13 has not synced this change yet. */
  STALE: 'stale',
  /** No pin exists for this project at all. */
  MISSING: 'missing',
  /** The newest pin is for a LATER project version than the one reported: out-of-order sync. */
  AHEAD: 'ahead',
})

/** Why a pin was superseded, as a stable code so a reader does not parse prose. */
export const SupersedeReason = Object.freeze({
  /** C13 synced a project version change and the pin moved with it. */
  PROJECT_VERSION_CHANGED: 'project-version-changed',
  /** The user re-pinned the same project version to a different build, explicitly. */
  USER_RECHOSE_BUILD: 'user-rechose-build',
})

/**
 * Project id shapes C06 will accept as a *reference*.
 *
 * The canonical shape is C10's: `prj_` followed by 16 uppercase alphanumerics
 * (`prj_WSTYAFER4BEG21TP`). The hyphenated form was C06's original guess and is kept only so
 * existing records stay readable — it was never C10's shape, and requiring it made every real
 * `advanceProjectPin` call fail (CR-13-2).
 *
 * This stays a FORMAT check, not an ownership claim: C06 must reject a malformed reference but
 * must not verify that the project exists, because that would mean reading project facts.
 */
const PROJECT_ID_PATTERNS = Object.freeze([
  /^prj_[A-Za-z0-9]{8,32}$/,
  /^[a-z]+-[A-Za-z0-9]+$/,
])

/**
 * Assert a project id is shaped like a project reference.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function assertProjectId(value, field = 'projectId') {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new ValidationError(`${field} 必须是合法的项目 ID 引用`, { field, value: String(value) })
  }
  return value
}

/**
 * Assert a project version reference is usable.
 *
 * Deliberately opaque: any non-empty string C10 chooses. C06 does not compare, sort or increment these.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function assertProjectVersion(value, field = 'projectVersion') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} 必须是非空的项目版本引用`, { field })
  }
  if (value.length > 200) {
    throw new ValidationError(`${field} 过长`, { field })
  }
  return value
}

/**
 * Validate one pin request's identity fields.
 *
 * @param {object} input
 * @returns {{ projectId: string, projectVersion: string, version: string }}
 */
function normalizeIdentity(input) {
  if (input === null || typeof input !== 'object') {
    throw new ValidationError('pin 需要对象参数', { field: 'pin' })
  }
  const projectId = assertProjectId(input.projectId)
  const projectVersion = assertProjectVersion(input.projectVersion)
  if (typeof input.version !== 'string' || input.version.length === 0) {
    throw new ValidationError('pin 需要一个工具版本', { field: 'version' })
  }
  if (input.version.length > 200) {
    throw new ValidationError('工具版本过长', { field: 'version' })
  }
  return { projectId, projectVersion, version: input.version }
}

/**
 * The pins belonging to one project, newest first.
 *
 * @param {object[]} pins all pins on a tool
 * @param {string} projectId
 * @returns {object[]}
 */
export function pinsForProject(pins, projectId) {
  assertProjectId(projectId)
  return (Array.isArray(pins) ? pins : [])
    .filter((pin) => pin.projectId === projectId)
    .sort((left, right) => String(right.at).localeCompare(String(left.at)))
}

/**
 * The pin for one exact (project, version) pair, or null.
 *
 * @param {object[]} pins
 * @param {string} projectId
 * @param {string} projectVersion
 * @returns {object|null}
 */
export function findPin(pins, projectId, projectVersion) {
  assertProjectId(projectId)
  assertProjectVersion(projectVersion)
  const matches = (Array.isArray(pins) ? pins : []).filter(
    (pin) => pin.projectId === projectId && pin.projectVersion === projectVersion,
  )
  if (matches.length === 0) return null
  // Prefer an active record when both exist; a superseded duplicate is history, not the answer.
  const active = matches.filter((pin) => pin.state === PinState.ACTIVE)
  return (active.at(-1) ?? matches.at(-1)) ?? null
}

/**
 * Create the FIRST pin for a project version.
 *
 * Refused when a pin already exists for that exact project version: reusing the operation to change which
 * build a version used would be a silent overwrite of a recorded fact. Changing it is
 * {@link rechooseBuild}; moving to a new project version is {@link advancePin}.
 *
 * @param {object[]} pins existing pins (not mutated)
 * @param {{ projectId: string, projectVersion: string, version: string, at: string, note?: string }} input
 * @returns {{ pins: object[], pin: object, idempotent: boolean }}
 */
export function bindPin(pins, input) {
  const { projectId, projectVersion, version } = normalizeIdentity(input)
  const at = requireTimestamp(input?.at)
  const existing = findPin(pins, projectId, projectVersion)
  if (existing !== null) {
    if (existing.version === version) {
      // Same association, already recorded: idempotent, so a retried sync cannot corrupt anything.
      return { pins: [...pins], pin: existing, idempotent: true }
    }
    throw new ConflictError('该项目版本已经关联了另一个工具版本，不能静默改写', {
      projectId,
      projectVersion,
      existingVersion: existing.version,
      requestedVersion: version,
      action: '如需改写已记录的事实，请使用 rechooseBuild 并说明理由；这不是自动可做的操作',
    })
  }
  const pin = {
    pinId: makePinId(at, pins.length),
    projectId,
    projectVersion,
    version,
    at,
    state: PinState.ACTIVE,
    supersedes: null,
    supersededBy: null,
    supersededAt: null,
    supersedeReason: null,
    note: typeof input?.note === 'string' ? input.note : null,
  }
  return { pins: [...pins, pin], pin, idempotent: false }
}

/**
 * Move a pin forward when the project's version changes. This is the operation C13 calls.
 *
 * Requirements, each of which exists to keep an old project version's answer intact:
 * - the predecessor pin must EXIST for `fromProjectVersion` — a missing one is an out-of-order sync and
 *   is refused instead of being silently treated as "no history";
 * - `fromProjectVersion` must not equal `toProjectVersion` — that is a re-choice of build, not a move;
 * - the target project version must not already hold a DIFFERENT build.
 *
 * The old pin is kept and marked `superseded`, with `supersededBy` pointing at the new one, so "which
 * build was project version V made with" remains answerable forever.
 *
 * @param {object[]} pins existing pins (not mutated)
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.fromProjectVersion the version being left
 * @param {string} input.toProjectVersion the version being entered
 * @param {string} input.version the tool build the new version uses
 * @param {string} input.at ISO timestamp
 * @param {string} [input.reason] one of {@link SupersedeReason}
 * @param {string} [input.note]
 * @returns {{ pins: object[], pin: object, superseded: object|null, idempotent: boolean }}
 */
export function advancePin(pins, input) {
  const { projectId, version } = normalizeIdentity({ ...input, projectVersion: input?.toProjectVersion })
  const fromProjectVersion = assertProjectVersion(input?.fromProjectVersion, 'fromProjectVersion')
  const toProjectVersion = assertProjectVersion(input?.toProjectVersion, 'toProjectVersion')
  const at = requireTimestamp(input?.at)
  if (fromProjectVersion === toProjectVersion) {
    throw new ValidationError('advance 需要两个不同的项目版本；同一版本内换构建请用 rechooseBuild', {
      field: 'toProjectVersion',
      fromProjectVersion,
      toProjectVersion,
    })
  }
  const predecessor = findPin(pins, projectId, fromProjectVersion)
  if (predecessor === null) {
    throw new NotFoundError('找不到要推进的旧 pin，拒绝按猜测推进', {
      projectId,
      fromProjectVersion,
      action: '请先为该版本建立 pin（bindPin），或核对 C13 的同步顺序',
    })
  }
  const existingTarget = findPin(pins, projectId, toProjectVersion)
  if (existingTarget !== null) {
    if (existingTarget.version === version) {
      return { pins: [...pins], pin: existingTarget, superseded: null, idempotent: true }
    }
    throw new ConflictError('目标项目版本已经关联了另一个工具版本', {
      projectId,
      toProjectVersion,
      existingVersion: existingTarget.version,
      requestedVersion: version,
      action: '请先核对 C13 的同步来源；C06 不会替它选择',
    })
  }

  const reason = input?.reason ?? SupersedeReason.PROJECT_VERSION_CHANGED
  if (!Object.values(SupersedeReason).includes(reason)) {
    throw new ValidationError('推进原因未知', { field: 'reason', value: String(reason) })
  }
  const newPin = {
    pinId: makePinId(at, pins.length),
    projectId,
    projectVersion: toProjectVersion,
    version,
    at,
    state: PinState.ACTIVE,
    supersedes: predecessor.pinId,
    supersededBy: null,
    supersededAt: null,
    supersedeReason: null,
    note: typeof input?.note === 'string' ? input.note : null,
  }
  // The predecessor keeps every field it had; only its state and the forward link change.
  const superseded = {
    ...predecessor,
    state: PinState.SUPERSEDED,
    supersededBy: newPin.pinId,
    supersededAt: at,
    supersedeReason: reason,
  }
  return {
    pins: [...pins.filter((pin) => pin.pinId !== predecessor.pinId), superseded, newPin],
    pin: newPin,
    superseded,
    idempotent: false,
  }
}

/**
 * Explicitly re-pin ONE project version to a different build, keeping the old record.
 *
 * This exists because "改主意了" is a legitimate act, but it must be attributable: it requires a reason
 * and it never deletes the previous association, so the fact that version V was once made with build A
 * stays on record.
 *
 * @param {object[]} pins existing pins (not mutated)
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.projectVersion
 * @param {string} input.version the new build
 * @param {string} input.at ISO timestamp
 * @param {string} input.note required: why this version is being re-chosen
 * @returns {{ pins: object[], pin: object, superseded: object, idempotent: boolean }}
 */
export function rechooseBuild(pins, input) {
  const { projectId, projectVersion, version } = normalizeIdentity(input)
  const at = requireTimestamp(input?.at)
  const note = typeof input?.note === 'string' ? input.note.trim() : ''
  if (note.length === 0) {
    // Without a reason this is indistinguishable from a silent overwrite, which CR-6 forbids.
    throw new ValidationError('改写已记录的 pin 必须说明理由', { field: 'note' })
  }
  const predecessor = findPin(pins, projectId, projectVersion)
  if (predecessor === null) {
    throw new NotFoundError('该项目版本还没有 pin，无法改写；请先 bindPin', {
      projectId,
      projectVersion,
    })
  }
  if (predecessor.version === version) {
    return { pins: [...pins], pin: predecessor, superseded: predecessor, idempotent: true }
  }
  const newPin = {
    pinId: makePinId(at, pins.length),
    projectId,
    projectVersion,
    version,
    at,
    state: PinState.ACTIVE,
    supersedes: predecessor.pinId,
    supersededBy: null,
    supersededAt: null,
    supersedeReason: null,
    note,
  }
  const superseded = {
    ...predecessor,
    state: PinState.SUPERSEDED,
    supersededBy: newPin.pinId,
    supersededAt: at,
    supersedeReason: SupersedeReason.USER_RECHOSE_BUILD,
  }
  return {
    pins: [...pins.filter((pin) => pin.pinId !== predecessor.pinId), superseded, newPin],
    pin: newPin,
    superseded,
    idempotent: false,
  }
}

/**
 * Answer "is the pin aligned with the project version the project is at now?" — and nothing else.
 *
 * Read-only by construction. It returns a verdict and never writes, which is what lets a project open or
 * resume re-check its pin (CR-6 item 5) without C06 advancing anything (CR-6 item 6). A `stale` answer is
 * the honest "C13 has not synced this yet", NOT an instruction to repair it here.
 *
 * @param {object[]} pins
 * @param {{ projectId: string, currentProjectVersion: string }} input
 * @returns {{
 *   check: string,
 *   pin: object|null,
 *   currentProjectVersion: string,
 *   staleVersions: string[],
 *   newestPinnedVersion: string|null,
 *   toolAvailable: boolean|null,
 *   note: string,
 * }}
 */
export function recheckPin(pins, input) {
  const projectId = assertProjectId(input?.projectId)
  const currentProjectVersion = assertProjectVersion(input?.currentProjectVersion, 'currentProjectVersion')
  const projectPins = pinsForProject(pins, projectId)
  if (projectPins.length === 0) {
    return {
      check: PinCheck.MISSING,
      pin: null,
      currentProjectVersion,
      staleVersions: [],
      newestPinnedVersion: null,
      // A pin is a statement about which build was used, never about whether it still works (CR-6 item 4).
      toolAvailable: null,
      note: '该项目还没有任何工具 pin；工具是否可用由工具页的真实状态决定，pin 不提供这个答案',
    }
  }
  const exact = findPin(pins, projectId, currentProjectVersion)
  if (exact !== null) {
    return {
      check: PinCheck.CURRENT,
      pin: exact,
      currentProjectVersion,
      staleVersions: [],
      newestPinnedVersion: exact.projectVersion,
      toolAvailable: null,
      note: 'pin 与项目当前版本一致；工具能否使用仍由工具页的真实状态决定',
    }
  }
  const staleVersions = [...new Set(projectPins.map((pin) => pin.projectVersion))]
  // Reports AHEAD only when a pin exists for a version the caller did not say the project is at. Detected by
  // comparing the newest pin's version to the current one ONLY when C13 supplied an ordered hint; without
  // one, C06 cannot rank opaque version references and must not pretend to.
  const check = input?.isVersionNewer?.(projectPins.at(0)?.projectVersion, currentProjectVersion)
    ? PinCheck.AHEAD
    : PinCheck.STALE
  return {
    check,
    pin: null,
    currentProjectVersion,
    staleVersions,
    newestPinnedVersion: projectPins.at(0)?.projectVersion ?? null,
    toolAvailable: null,
    note:
      check === PinCheck.AHEAD
        ? 'pin 指向比项目当前版本更新的版本，同步顺序可疑；C06 不自行修正'
        : 'pin 落后于项目当前版本，等待 C13 同步；C06 不自行推进 projectVersion',
  }
}

/**
 * The full pin history for one project, oldest first, so a reader can reconstruct the chain.
 * @param {object[]} pins
 * @param {string} projectId
 * @returns {object[]}
 */
export function pinHistory(pins, projectId) {
  assertProjectId(projectId)
  return (Array.isArray(pins) ? pins : [])
    .filter((pin) => pin.projectId === projectId)
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))
}

/**
 * Normalize a pin record read from disk.
 *
 * A pin without the fields this module relies on is treated as corrupt rather than silently repaired,
 * because a repaired pin would be a pin nobody recorded.
 *
 * @param {unknown} input
 * @param {string} field
 * @returns {object}
 */
export function normalizePin(input, field = 'pin') {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const state = record.state ?? PinState.ACTIVE
  if (!Object.values(PinState).includes(/** @type {string} */ (state))) {
    throw new ValidationError(`${field}.state 未知`, { field, value: String(state) })
  }
  return {
    pinId: typeof record.pinId === 'string' && record.pinId.length > 0 ? record.pinId : makePinId('0', 0),
    projectId: assertProjectId(record.projectId, `${field}.projectId`),
    projectVersion: assertProjectVersion(record.projectVersion, `${field}.projectVersion`),
    version: typeof record.version === 'string' && record.version.length > 0 ? record.version : '',
    at: requireTimestamp(record.at, `${field}.at`),
    state,
    supersedes: typeof record.supersedes === 'string' ? record.supersedes : null,
    supersededBy: typeof record.supersededBy === 'string' ? record.supersededBy : null,
    supersededAt: typeof record.supersededAt === 'string' ? record.supersededAt : null,
    supersedeReason: typeof record.supersedeReason === 'string' ? record.supersedeReason : null,
    note: typeof record.note === 'string' ? record.note : null,
  }
}

/**
 * A pin id that is unique without a random source: the timestamp plus the record count.
 *
 * Two pins recorded in the same millisecond for the same tool still differ, because the count differs.
 * @param {string} at
 * @param {number} index
 * @returns {string}
 */
function makePinId(at, index) {
  const digits = String(at).replace(/\D/g, '').slice(0, 17)
  return `pin-${digits}-${String(index).padStart(3, '0')}`
}

/** @param {unknown} value @param {string} [field] @returns {string} */
function requireTimestamp(value, field = 'at') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} 必须是 ISO 时间字符串`, { field })
  }
  return value
}
