/**
 * The three user-visible version classes and their lifecycle: current, candidate and final.
 *
 * Exactly three classes exist (CT-03 §5, 01 §7): draft, initial cut, baseline and delivery are
 * SUBSTATES (`VersionSubstate`) of a class and never a fourth class. This module only ever writes
 * `VersionClass.CURRENT`, `VersionClass.CANDIDATE` or `VersionClass.FINAL`.
 *
 * Rules enforced here in code, not only in documentation:
 * - **The current version is auto-saved.** `ensureCurrent` creates one on first use and later calls
 *   return the SAME id, so a project can never end up with two "current" versions.
 * - **A candidate records its base version.** When the base moves on, the candidate becomes
 *   `needs-recheck` and `acceptCandidate` refuses it until `recheckCandidate` ran, so a stale
 *   candidate can never be applied silently.
 * - **Accepting a candidate makes it CURRENT, never FINAL.**
 * - **Only a user can finalize, and the final version is immutable.** Any later mutation of that
 *   record throws, and a second finalize is refused.
 * - **History is read-only and revertible.** `listHistory` hands out deep copies, and
 *   `revertToVersion` makes a chosen historical version current again while the old current is
 *   retained as history.
 * - **A partial revert is a candidate, not a success.** A sub-scope revert flags that dependent
 *   content still needs re-checking instead of claiming the project was rolled back.
 *
 * State is persisted through `core/project/store.js` on `PROJECT_LAYOUT.versionsIndex`, so every
 * document carries schema version/generation and a `revision`; a concurrent overwrite becomes a
 * `VERSION_CONFLICT` instead of a lost update. Version CONTENT is stored as bounded references
 * (id/hash), never as inlined bytes, and no path outside the project directory is ever built here.
 *
 * @module core/project/versions
 */

import { Clock, ConflictError, ErrorCode, NotFoundError, ValidationError, WorkbenchError } from '../../base/index.js'
import { assertId, newId } from './ids.js'
import { PROJECT_LAYOUT } from './paths.js'
import { appendEvents, buildEvent, ProjectEventKind } from './events.js'
import {
  Actor,
  CandidateStatus,
  ConfirmScope,
  NeedsAttentionCode,
  VersionClass,
  VersionSubstate,
  assertEnum,
} from './schema.js'
import { tryReadDocument, writeDocument } from './store.js'

/** Document kind and schema key `store.js` uses for the versions index. */
export const VERSIONS_DOCUMENT = Object.freeze({ kind: 'versions', schemaKey: 'versions' })

/** Longest accepted reference; a longer value would mean inlined content instead of a reference. */
export const MAX_REFERENCE_LENGTH = 200

/** Longest accepted list of object ids in one version or candidate scope. */
export const MAX_SCOPE_ITEMS = 5000

/** Candidate statuses that still describe an unfinished comparison. */
export const LIVE_CANDIDATE_STATUSES = Object.freeze([CandidateStatus.OPEN, CandidateStatus.NEEDS_RECHECK])

/**
 * A version record as stored.
 * @typedef {object} VersionRecord
 * @property {string} versionId
 * @property {string} class one of `VersionClass`
 * @property {string|null} substate one of `VersionSubstate`, or null
 * @property {string} label
 * @property {string} createdAt
 * @property {string} createdBy `user` | `ai` | `system`
 * @property {string} updatedAt
 * @property {boolean} immutable true for a final version; every later mutation throws
 * @property {{ type: string, [key: string]: unknown }} origin how this version came to exist
 * @property {Record<string, unknown>} content references only (ids/hashes), never bytes
 * @property {string|null} [confirmationRef] the user acceptance a final version was built on
 */

/**
 * A candidate record as stored.
 * @typedef {object} CandidateRecord
 * @property {string} candidateId
 * @property {string} class always `candidate`
 * @property {string} baseVersionId the version this candidate was built from
 * @property {string} target what it changes
 * @property {string} scope one of `ConfirmScope`
 * @property {string[]} preservedItems what it must not change
 * @property {string|null} diffRef reference to the real difference
 * @property {string|null} previewRef reference to the real preview
 * @property {string[]} checkScope what was actually checked
 * @property {string} status one of `CandidateStatus`
 * @property {string} createdAt
 * @property {string} createdBy
 * @property {boolean} recheckRequired
 * @property {string|null} recheckReason
 * @property {string|null} staleBecauseVersionId
 * @property {string|null} staleAt
 * @property {string|null} recheckedAt
 * @property {string|null} recheckBaseVersionId the version the last re-check was against
 * @property {string|null} decidedAt
 * @property {string|null} decisionReason
 * @property {string|null} acceptedVersionId the current version this candidate became
 */

/**
 * Assert a non-empty text field.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maxLength]
 * @returns {string}
 */
function assertText(value, field, maxLength = 500) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} 必须是文字`, { field, received: typeof value })
  }
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} 不能为空`, { field })
  }
  if (value.length > maxLength) {
    throw new ValidationError(`${field} 过长（最多 ${maxLength} 个字符）`, { field, length: value.length })
  }
  return value
}

/**
 * Assert an optional text field; `undefined` and `null` both become `null`.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maxLength]
 * @returns {string|null}
 */
function assertOptionalText(value, field, maxLength = 500) {
  if (value === undefined || value === null) return null
  return assertText(value, field, maxLength)
}

/**
 * Assert one reference: a bounded id or hash, never inlined content.
 * @param {unknown} value
 * @param {string} field
 * @returns {string|null}
 */
function assertOptionalRef(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} 必须是引用（id 或哈希），不能内联内容`, { field, received: typeof value })
  }
  if (value.length === 0 || value.length > MAX_REFERENCE_LENGTH) {
    throw new ValidationError(`${field} 长度不合法（1..${MAX_REFERENCE_LENGTH}）`, { field, length: value.length })
  }
  return value
}

/**
 * Assert a list of references.
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
function assertRefList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} 必须是数组`, { field, received: typeof value })
  }
  if (value.length > MAX_SCOPE_ITEMS) {
    throw new ValidationError(`${field} 条目过多（最多 ${MAX_SCOPE_ITEMS}）`, { field, length: value.length })
  }
  const out = []
  for (let index = 0; index < value.length; index += 1) {
    const ref = value[index]
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_REFERENCE_LENGTH) {
      throw new ValidationError(`${field} 含有非法引用`, { field, index })
    }
    out.push(ref)
  }
  return out
}

/**
 * Normalize one value inside a version content bag.
 * @param {unknown} value
 * @param {string} field
 * @returns {unknown}
 */
function normalizeContentValue(value, field) {
  if (value === null) return null
  const type = typeof value
  if (type === 'number' || type === 'boolean') return value
  if (type === 'string') {
    if (value.length === 0 || value.length > MAX_REFERENCE_LENGTH) {
      throw new ValidationError(`${field} 必须是引用（id 或哈希），不能内联内容`, { field, length: value.length })
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SCOPE_ITEMS) {
      throw new ValidationError(`${field} 条目过多（最多 ${MAX_SCOPE_ITEMS}）`, { field, length: value.length })
    }
    return value.map((item, index) => {
      if (typeof item !== 'string' || item.length === 0 || item.length > MAX_REFERENCE_LENGTH) {
        throw new ValidationError(`${field} 只允许引用列表`, { field, index })
      }
      return item
    })
  }
  throw new ValidationError(`${field} 不能是嵌套对象；版本内容只保存引用，不保存内容本身`, { field })
}

/**
 * Normalize a version content bag: keys to references only.
 * @param {unknown} value
 * @param {string} [field]
 * @returns {Record<string, unknown>}
 */
function normalizeContent(value, field = 'content') {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} 必须是对象（只含引用）`, { field })
  }
  const out = {}
  for (const key of Object.keys(value)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 60) {
      throw new ValidationError(`${field} 的键不合法`, { field, key: String(key) })
    }
    out[key] = normalizeContentValue(/** @type {any} */ (value)[key], `${field}.${key}`)
  }
  return out
}

/**
 * Require an explicit actor. Version decisions change what the user sees, so who did it must be
 * stated by the caller instead of defaulting to a comfortable "user".
 * @param {unknown} value
 * @returns {string}
 */
function requireActor(value) {
  if (value === undefined || value === null) {
    throw new ValidationError('需要写明操作者（user / ai / system），不能省略', { field: 'actor' })
  }
  return assertEnum(value, Actor, 'actor')
}

/**
 * Deep copy, so a caller never receives a live handle into a stored document.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function copy(value) {
  return structuredClone(value)
}

/**
 * A corruption error for a document that is not a usable versions document.
 * @param {string} message
 * @param {object} [details]
 * @returns {WorkbenchError}
 */
function corruptDocument(message, details) {
  return new WorkbenchError(ErrorCode.CORRUPT_DATA, message, { details })
}

/**
 * Assert a value read from disk is an array.
 * @param {unknown} value
 * @param {string} field
 * @returns {any[]}
 */
function asArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw corruptDocument(`版本文件中的 ${field} 不是数组`, { field })
  return value
}

/**
 * A fresh, empty versions document.
 * @param {string} projectId
 * @returns {any}
 */
function emptyDocument(projectId) {
  return {
    kind: VERSIONS_DOCUMENT.kind,
    projectId,
    currentVersionId: null,
    finalVersionId: null,
    versions: [],
    candidates: [],
    transitions: [],
  }
}

/**
 * Validate and normalize a versions document read from disk.
 * @param {any} value
 * @param {string} projectId
 * @returns {any}
 */
function normalizeDocument(value, projectId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw corruptDocument('版本文件不是对象', { stage: 'shape' })
  }
  if (typeof value.projectId === 'string' && value.projectId.length > 0 && value.projectId !== projectId) {
    throw corruptDocument('版本文件属于另一个项目，拒绝串用', { stage: 'identity', expectedProjectId: projectId })
  }
  const currentVersionId = typeof value.currentVersionId === 'string' ? value.currentVersionId : null
  const finalVersionId = typeof value.finalVersionId === 'string' ? value.finalVersionId : null
  return {
    kind: VERSIONS_DOCUMENT.kind,
    projectId,
    currentVersionId,
    finalVersionId,
    versions: asArray(value.versions, 'versions'),
    candidates: asArray(value.candidates, 'candidates'),
    transitions: asArray(value.transitions, 'transitions'),
  }
}

/**
 * Open the version store of one project.
 *
 * Nothing is cached: each call reads the document and writes with the revision it read, so a
 * second writer's newer result is reported as `VERSION_CONFLICT` instead of being overwritten.
 *
 * @param {object} options
 * @param {import('./paths.js').ProjectPaths} options.paths paths of the project this store belongs to
 * @param {Clock} [options.clock] injected clock; `core/` never reads the wall clock directly
 * @returns {{
 *   projectId: string,
 *   ensureCurrent: (input?: object) => VersionRecord,
 *   getCurrent: () => VersionRecord|null,
 *   getFinal: () => VersionRecord|null,
 *   getVersion: (versionId: string) => VersionRecord|null,
 *   updateCurrentContent: (patch: object, options?: object) => VersionRecord,
 *   updateVersionContent: (versionId: string, patch: object) => VersionRecord,
 *   createCandidate: (input: object) => CandidateRecord,
 *   getCandidate: (candidateId: string) => CandidateRecord|null,
 *   listCandidates: (filter?: object) => CandidateRecord[],
 *   markBaseAdvanced: (newCurrentVersionId: string) => object,
 *   recheckCandidate: (candidateId: string, options: object) => CandidateRecord,
 *   acceptCandidate: (candidateId: string, options: object) => object,
 *   rejectCandidate: (candidateId: string, options: object) => CandidateRecord,
 *   abandonCandidate: (candidateId: string, options: object) => CandidateRecord,
 *   finalize: (input: object) => VersionRecord,
 *   listHistory: (filter?: object) => object[],
 *   revertToVersion: (versionId: string, options: object) => object,
 *   revertPartial: (input: object) => object,
 *   describe: () => object,
 * }}
 */
export function createVersionStore(options) {
  const paths = options?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('版本存储需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const projectId = assertText(paths.projectId, 'projectId', 120)
  const clock = options.clock ?? new Clock()
  const documentFile = paths.resolve(PROJECT_LAYOUT.versionsIndex)

  /**
   * Read the document and the revision it was read at.
   * @returns {{ doc: any, revision: string|null }}
   */
  function read() {
    const stored = tryReadDocument(documentFile, { kind: VERSIONS_DOCUMENT.kind })
    if (stored === null) return { doc: emptyDocument(projectId), revision: null }
    return { doc: normalizeDocument(stored.value, projectId), revision: stored.revision }
  }

  /**
   * Persist with the revision this call read.
   * @param {any} doc
   * @param {string|null} revision
   * @returns {{ revision: string, sha256: string }}
   */
  function save(doc, revision) {
    return writeDocument(documentFile, doc, {
      kind: VERSIONS_DOCUMENT.kind,
      schemaKey: VERSIONS_DOCUMENT.schemaKey,
      expectedRevision: revision,
      clock,
    })
  }

  /**
   * Append project events AFTER the document is durable, so the log never claims an unwritten
   * change.
   * @param {object[]} events
   */
  function emit(events) {
    if (events.length === 0) return
    appendEvents(paths.dir, events, { clock })
  }

  /**
   * Find one version record.
   * @param {any} doc
   * @param {string|null} versionId
   * @returns {any|null}
   */
  function findVersion(doc, versionId) {
    if (versionId === null || versionId === undefined) return null
    const record = doc.versions.find((item) => item?.versionId === versionId)
    if (record === undefined) return null
    assertEnum(record.class, VersionClass, 'version.class')
    if (record.versionId === doc.finalVersionId && record.class !== VersionClass.FINAL) {
      throw corruptDocument('定稿版本记录的类别不是 final', { versionId: record.versionId })
    }
    return record
  }

  /**
   * Find one candidate record.
   * @param {any} doc
   * @param {string} candidateId
   * @returns {any|null}
   */
  function findCandidate(doc, candidateId) {
    const record = doc.candidates.find((item) => item?.candidateId === candidateId)
    if (record === undefined) return null
    assertEnum(record.status, CandidateStatus, 'candidate.status')
    return record
  }

  /**
   * Mark every live candidate whose effective base is not `newCurrentVersionId` as needs-recheck.
   * @param {any} doc
   * @param {string} newCurrentVersionId
   * @param {string} at
   * @returns {string[]} candidate ids that were flagged
   */
  function markStale(doc, newCurrentVersionId, at) {
    const flagged = []
    for (const candidate of doc.candidates) {
      if (candidate?.status !== CandidateStatus.OPEN) continue
      const effectiveBase = candidate.recheckBaseVersionId ?? candidate.baseVersionId
      if (effectiveBase === newCurrentVersionId) continue
      candidate.status = CandidateStatus.NEEDS_RECHECK
      candidate.recheckRequired = true
      candidate.recheckReason = '基础版本已变化，必须重新核对后才能接受'
      candidate.staleBecauseVersionId = newCurrentVersionId
      candidate.staleAt = at
      flagged.push(String(candidate.candidateId))
    }
    return flagged
  }

  /**
   * Build one needs-recheck event per candidate.
   * @param {string[]} candidateIds
   * @param {string} newCurrentVersionId
   * @param {string} actor
   * @returns {object[]}
   */
  function staleEvents(candidateIds, newCurrentVersionId, actor) {
    return candidateIds.map((candidateId) =>
      buildEvent({
        kind: ProjectEventKind.VERSION_CANDIDATE_STALE,
        projectId,
        actor,
        detail: { candidateId, newCurrentVersionId, reason: 'base-version-advanced' },
      }),
    )
  }

  /**
   * Get the current version, creating the first one when the project has none yet.
   *
   * The created id is stable: a later call returns the same version instead of minting another,
   * which is what "当前版本自动保存" needs from this module.
   *
   * @param {object} [input]
   * @param {string} [input.actor] `user` | `ai` | `system`; defaults to `system`
   * @param {string} [input.substate] one of `VersionSubstate`; defaults to `draft`
   * @param {string} [input.label]
   * @param {object} [input.content] references only
   * @returns {VersionRecord}
   */
  function ensureCurrent(input = {}) {
    const { doc, revision } = read()
    const existing = findVersion(doc, doc.currentVersionId)
    if (existing !== null) return copy(existing)
    if (doc.currentVersionId !== null) {
      throw corruptDocument('当前版本记录缺失，无法安全继续', { currentVersionId: doc.currentVersionId })
    }
    const at = clock.iso()
    const actor = input.actor === undefined ? Actor.SYSTEM : assertEnum(input.actor, Actor, 'actor')
    const substate =
      input.substate === undefined ? VersionSubstate.DRAFT : assertEnum(input.substate, VersionSubstate, 'substate')
    /** @type {VersionRecord} */
    const version = {
      versionId: newId('version'),
      class: VersionClass.CURRENT,
      substate,
      label: input.label === undefined ? '当前版本' : assertText(input.label, 'label', 200),
      createdAt: at,
      createdBy: actor,
      updatedAt: at,
      immutable: false,
      origin: { type: 'created' },
      content: normalizeContent(input.content),
    }
    doc.versions.push(version)
    doc.currentVersionId = version.versionId
    doc.transitions.push({
      at,
      kind: 'set-current',
      versionId: version.versionId,
      previousVersionId: null,
      detail: { reason: 'ensure-current' },
    })
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.VERSION_CREATED,
        projectId,
        actor,
        versionId: version.versionId,
        detail: { class: VersionClass.CURRENT, substate },
      }),
    ])
    return copy(version)
  }

  /**
   * The current version, or `null` when the project has none yet.
   * @returns {VersionRecord|null}
   */
  function getCurrent() {
    const { doc } = read()
    const version = findVersion(doc, doc.currentVersionId)
    return version === null ? null : copy(version)
  }

  /**
   * The final version, or `null` while the project is not finalized.
   * @returns {VersionRecord|null}
   */
  function getFinal() {
    const { doc } = read()
    const version = findVersion(doc, doc.finalVersionId)
    return version === null ? null : copy(version)
  }

  /**
   * One version by id, or `null`.
   * @param {string} versionId
   * @returns {VersionRecord|null}
   */
  function getVersion(versionId) {
    const id = assertId(versionId, 'version', 'versionId')
    const { doc } = read()
    const version = findVersion(doc, id)
    return version === null ? null : copy(version)
  }

  /**
   * Update the current version's references (the auto-saved editing state).
   *
   * Only a mutable, active version can be edited: a final version and a historical version both
   * throw. The final version was copied at finalize time, so editing the current version later
   * never rewrites the delivered state.
   *
   * @param {object} patch
   * @param {object} [patch.content] merged into the existing content references
   * @param {string} [patch.label]
   * @param {string} [patch.substate]
   * @param {object} [options]
   * @param {string} [options.actor]
   * @returns {VersionRecord}
   */
  function updateCurrentContent(patch = {}, options = {}) {
    const { doc } = read()
    if (doc.currentVersionId === null) {
      throw new NotFoundError('还没有当前版本，无法自动保存', { action: '先调用 ensureCurrent 建立当前版本' })
    }
    return updateVersionContent(doc.currentVersionId, patch, options)
  }

  /**
   * Update one version's references.
   *
   * Refuses a final version (the delivered state is immutable) and refuses a historical version
   * (history is read-only). Both refusals are the product rule, not a convenience check.
   *
   * @param {string} versionId
   * @param {object} patch
   * @param {object} [options]
   * @param {string} [options.actor]
   * @returns {VersionRecord}
   */
  function updateVersionContent(versionId, patch = {}, options = {}) {
    const id = assertId(versionId, 'version', 'versionId')
    const { doc, revision } = read()
    const version = findVersion(doc, id)
    if (version === null) throw new NotFoundError('版本不存在', { versionId: id })
    if (version.immutable === true || version.versionId === doc.finalVersionId) {
      throw new ConflictError('定稿版本不可修改；定稿内容只能通过新的候选版本改变', {
        versionId: id,
        action: '从定稿版本形成新候选，不要改写定稿记录',
      })
    }
    if (version.versionId !== doc.currentVersionId) {
      throw new ConflictError('只有当前版本可以修改；历史版本只读', { versionId: id })
    }
    const actor = options.actor === undefined ? Actor.SYSTEM : assertEnum(options.actor, Actor, 'actor')
    const content =
      patch.content === undefined
        ? version.content
        : { ...version.content, ...normalizeContent(patch.content) }
    if (patch.label !== undefined) version.label = assertText(patch.label, 'label', 200)
    if (patch.substate !== undefined) version.substate = assertEnum(patch.substate, VersionSubstate, 'substate')
    version.content = content
    version.updatedAt = clock.iso()
    version.lastEditedBy = actor
    save(doc, revision)
    return copy(version)
  }

  /**
   * Create a candidate recording its base version, target, scope, preserved items, real difference
   * and preview references, and what was actually checked.
   *
   * @param {object} input
   * @param {string} input.baseVersionId the version this candidate was built from
   * @param {string} input.target what it changes
   * @param {string} input.scope one of `ConfirmScope`
   * @param {string[]} [input.preservedItems] what it must not change
   * @param {string} [input.diffRef] reference to the real difference
   * @param {string} [input.previewRef] reference to the real preview
   * @param {string[]} [input.checkScope] what was actually checked
   * @param {string} [input.actor] `user` | `ai` | `system`; defaults to `ai`
   * @returns {CandidateRecord}
   */
  function createCandidate(input = {}) {
    const baseVersionId = assertId(input.baseVersionId, 'version', 'baseVersionId')
    const target = assertText(input.target, 'target')
    const scope = assertEnum(input.scope, ConfirmScope, 'scope')
    const preservedItems = assertRefList(input.preservedItems, 'preservedItems')
    const checkScope = assertRefList(input.checkScope, 'checkScope')
    const diffRef = assertOptionalRef(input.diffRef, 'diffRef')
    const previewRef = assertOptionalRef(input.previewRef, 'previewRef')
    const actor = input.actor === undefined ? Actor.AI : assertEnum(input.actor, Actor, 'actor')
    const { doc, revision } = read()
    if (findVersion(doc, baseVersionId) === null) {
      throw new NotFoundError('候选版本的基础版本不存在', { baseVersionId })
    }
    const at = clock.iso()
    /** @type {CandidateRecord} */
    const candidate = {
      candidateId: newId('candidate'),
      class: VersionClass.CANDIDATE,
      baseVersionId,
      target,
      scope,
      preservedItems,
      diffRef,
      previewRef,
      checkScope,
      status: CandidateStatus.OPEN,
      createdAt: at,
      createdBy: actor,
      recheckRequired: false,
      recheckReason: null,
      staleBecauseVersionId: null,
      staleAt: null,
      recheckedAt: null,
      recheckBaseVersionId: null,
      decidedAt: null,
      decisionReason: null,
      acceptedVersionId: null,
    }
    doc.candidates.push(candidate)
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.VERSION_CANDIDATE_CREATED,
        projectId,
        actor,
        versionId: baseVersionId,
        detail: { candidateId: candidate.candidateId, baseVersionId, target, scope },
      }),
    ])
    return copy(candidate)
  }

  /**
   * One candidate by id, or `null`.
   * @param {string} candidateId
   * @returns {CandidateRecord|null}
   */
  function getCandidate(candidateId) {
    const id = assertId(candidateId, 'candidate', 'candidateId')
    const { doc } = read()
    const candidate = findCandidate(doc, id)
    return candidate === null ? null : copy(candidate)
  }

  /**
   * Candidates oldest first. Closed candidates are kept: they are history, not deletions.
   * @param {{ status?: string, live?: boolean }} [filter]
   * @returns {CandidateRecord[]}
   */
  function listCandidates(filter = {}) {
    const { doc } = read()
    return doc.candidates
      .filter((candidate) => (filter.status === undefined ? true : candidate.status === filter.status))
      .filter((candidate) => (filter.live === undefined ? true : LIVE_CANDIDATE_STATUSES.includes(candidate.status)))
      .map((candidate) => copy(candidate))
  }

  /**
   * Declare that the base version advanced, and flag every live candidate that is now stale.
   *
   * Called internally by `acceptCandidate` and `revertToVersion`; exposed so a caller that moved
   * the current version by another sanctioned path can apply the same rule instead of leaving a
   * stale candidate looking acceptable.
   *
   * @param {string} newCurrentVersionId
   * @param {{ actor?: string }} [options]
   * @returns {{ newCurrentVersionId: string, staleCandidateIds: string[], changed: boolean }}
   */
  function markBaseAdvanced(newCurrentVersionId, options = {}) {
    const id = assertId(newCurrentVersionId, 'version', 'newCurrentVersionId')
    const { doc, revision } = read()
    if (findVersion(doc, id) === null) {
      throw new NotFoundError('新基础版本不存在', { newCurrentVersionId: id })
    }
    const actor = options.actor === undefined ? Actor.SYSTEM : assertEnum(options.actor, Actor, 'actor')
    const at = clock.iso()
    const flagged = markStale(doc, id, at)
    if (flagged.length > 0) {
      save(doc, revision)
      emit(staleEvents(flagged, id, actor))
    }
    return { newCurrentVersionId: id, staleCandidateIds: flagged, changed: flagged.length > 0 }
  }

  /**
   * Re-check a stale candidate against the version named now (or the current version).
   *
   * A re-check does not rewrite the candidate's origin: `baseVersionId` stays what it was built
   * from, and `recheckBaseVersionId` records what it has now been verified against.
   *
   * @param {string} candidateId
   * @param {object} [options]
   * @param {string} options.actor required
   * @param {string} [options.againstVersionId]
   * @param {string} [options.note]
   * @returns {CandidateRecord}
   */
  function recheckCandidate(candidateId, options = {}) {
    const id = assertId(candidateId, 'candidate', 'candidateId')
    const actor = requireActor(options.actor)
    const note = assertOptionalText(options.note, 'note', 1000)
    const { doc, revision } = read()
    const candidate = findCandidate(doc, id)
    if (candidate === null) throw new NotFoundError('候选版本不存在', { candidateId: id })
    if (!LIVE_CANDIDATE_STATUSES.includes(candidate.status)) {
      throw new ConflictError('候选已经结束，不能再重新核对', { candidateId: id, status: candidate.status })
    }
    const against =
      options.againstVersionId === undefined
        ? doc.currentVersionId
        : assertId(options.againstVersionId, 'version', 'againstVersionId')
    if (against === null) throw new ValidationError('还没有当前版本，无法重新核对候选', {})
    if (findVersion(doc, against) === null) throw new NotFoundError('用于重新核对的版本不存在', { versionId: against })
    candidate.status = CandidateStatus.OPEN
    candidate.recheckRequired = false
    candidate.recheckReason = null
    candidate.recheckedAt = clock.iso()
    candidate.recheckBaseVersionId = against
    if (note !== null) candidate.recheckNote = note
    candidate.recheckedBy = actor
    save(doc, revision)
    return copy(candidate)
  }

  /**
   * Accept a candidate, making it the CURRENT version (never final).
   *
   * Refuses a `needs-recheck` candidate and, defensively, a candidate whose base is no longer the
   * current version: the stale candidate is flagged first and the refusal names what to do. So a
   * stale candidate can never be applied silently, even if `markBaseAdvanced` was never called.
   *
   * @param {string} candidateId
   * @param {object} options
   * @param {string} options.actor required
   * @param {string} [options.substate]
   * @param {string} [options.label]
   * @returns {{ candidate: CandidateRecord, version: VersionRecord, staleCandidateIds: string[] }}
   */
  function acceptCandidate(candidateId, options = {}) {
    const id = assertId(candidateId, 'candidate', 'candidateId')
    const actor = requireActor(options.actor)
    const { doc, revision } = read()
    const candidate = findCandidate(doc, id)
    if (candidate === null) throw new NotFoundError('候选版本不存在', { candidateId: id })
    if (doc.currentVersionId === null) {
      throw new ValidationError('还没有当前版本，不能接受候选', { action: '先调用 ensureCurrent 建立当前版本' })
    }
    if (candidate.status === CandidateStatus.NEEDS_RECHECK) {
      throw new ConflictError('候选的基础版本已变化，必须重新核对后才能接受', {
        candidateId: id,
        baseVersionId: candidate.baseVersionId,
        currentVersionId: doc.currentVersionId,
        code: NeedsAttentionCode.CANDIDATE_NEEDS_RECHECK,
        needsRecheck: true,
        action: '先调用 recheckCandidate 重新核对；程序不会静默套用旧候选',
      })
    }
    if (candidate.status !== CandidateStatus.OPEN) {
      throw new ConflictError('候选已经结束，不能再接受', { candidateId: id, status: candidate.status })
    }
    const effectiveBase = candidate.recheckBaseVersionId ?? candidate.baseVersionId
    if (effectiveBase !== doc.currentVersionId) {
      // Defensive: the base moved on without markBaseAdvanced. Flag it and refuse, never apply.
      const flaggedAt = clock.iso()
      candidate.status = CandidateStatus.NEEDS_RECHECK
      candidate.recheckRequired = true
      candidate.recheckReason = '基础版本已变化，必须重新核对后才能接受'
      candidate.staleBecauseVersionId = doc.currentVersionId
      candidate.staleAt = flaggedAt
      save(doc, revision)
      emit(staleEvents([id], doc.currentVersionId, actor))
      throw new ConflictError('候选的基础版本已变化，必须重新核对后才能接受', {
        candidateId: id,
        baseVersionId: candidate.baseVersionId,
        currentVersionId: doc.currentVersionId,
        code: NeedsAttentionCode.CANDIDATE_NEEDS_RECHECK,
        needsRecheck: true,
        action: '先调用 recheckCandidate 重新核对；程序不会静默套用旧候选',
      })
    }

    const base = findVersion(doc, candidate.baseVersionId)
    const baseContent = base === null ? {} : base.content
    const at = clock.iso()
    const substate =
      options.substate === undefined ? null : assertEnum(options.substate, VersionSubstate, 'substate')
    const content = { ...baseContent }
    if (candidate.diffRef !== null) content.diffRef = candidate.diffRef
    if (candidate.previewRef !== null) content.previewRef = candidate.previewRef
    /** @type {VersionRecord} */
    const version = {
      versionId: newId('version'),
      class: VersionClass.CURRENT,
      substate,
      label: options.label === undefined ? '当前版本（已接受候选）' : assertText(options.label, 'label', 200),
      createdAt: at,
      createdBy: actor,
      updatedAt: at,
      immutable: false,
      origin: {
        type: 'candidate-accepted',
        candidateId: id,
        baseVersionId: candidate.baseVersionId,
        target: candidate.target,
        scope: candidate.scope,
      },
      content,
    }
    doc.versions.push(version)
    doc.currentVersionId = version.versionId
    doc.transitions.push({
      at,
      kind: 'candidate-accepted',
      versionId: version.versionId,
      previousVersionId: candidate.recheckBaseVersionId ?? candidate.baseVersionId,
      detail: { candidateId: id },
    })
    candidate.status = CandidateStatus.ACCEPTED
    candidate.decidedAt = at
    candidate.decisionReason = 'accepted-as-current'
    candidate.acceptedVersionId = version.versionId
    const flagged = markStale(doc, version.versionId, at)
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.VERSION_CANDIDATE_ACCEPTED,
        projectId,
        actor,
        versionId: version.versionId,
        detail: { candidateId: id, baseVersionId: candidate.baseVersionId },
      }),
      ...staleEvents(flagged, version.versionId, actor),
    ])
    return { candidate: copy(candidate), version: copy(version), staleCandidateIds: flagged }
  }

  /**
   * Reject a candidate. The record is kept as history.
   * @param {string} candidateId
   * @param {object} options
   * @param {string} options.actor required
   * @param {string} [options.reason]
   * @returns {CandidateRecord}
   */
  function rejectCandidate(candidateId, options = {}) {
    const id = assertId(candidateId, 'candidate', 'candidateId')
    const actor = requireActor(options.actor)
    const reason = assertOptionalText(options.reason, 'reason', 1000)
    const { doc, revision } = read()
    const candidate = findCandidate(doc, id)
    if (candidate === null) throw new NotFoundError('候选版本不存在', { candidateId: id })
    if (!LIVE_CANDIDATE_STATUSES.includes(candidate.status)) {
      throw new ConflictError('候选已经结束，不能再次处理', { candidateId: id, status: candidate.status })
    }
    candidate.status = CandidateStatus.REJECTED
    candidate.decidedAt = clock.iso()
    candidate.decisionReason = reason
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.VERSION_CANDIDATE_REJECTED,
        projectId,
        actor,
        versionId: candidate.baseVersionId,
        detail: { candidateId: id, status: CandidateStatus.REJECTED, reason },
      }),
    ])
    return copy(candidate)
  }

  /**
   * Abandon a candidate: the user dropped it without judging its content.
   *
   * Recorded as `superseded` because `CandidateStatus` has no separate "abandoned" value and
   * inventing one would add a state the rest of the product does not know.
   * @param {string} candidateId
   * @param {object} options
   * @param {string} options.actor required
   * @param {string} [options.reason]
   * @returns {CandidateRecord}
   */
  function abandonCandidate(candidateId, options = {}) {
    const id = assertId(candidateId, 'candidate', 'candidateId')
    const actor = requireActor(options.actor)
    const reason = assertOptionalText(options.reason, 'reason', 1000)
    const { doc, revision } = read()
    const candidate = findCandidate(doc, id)
    if (candidate === null) throw new NotFoundError('候选版本不存在', { candidateId: id })
    if (!LIVE_CANDIDATE_STATUSES.includes(candidate.status)) {
      throw new ConflictError('候选已经结束，不能再次处理', { candidateId: id, status: candidate.status })
    }
    candidate.status = CandidateStatus.SUPERSEDED
    candidate.decidedAt = clock.iso()
    candidate.decisionReason = reason ?? 'abandoned'
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.VERSION_CANDIDATE_REJECTED,
        projectId,
        actor,
        versionId: candidate.baseVersionId,
        detail: { candidateId: id, status: CandidateStatus.SUPERSEDED, abandoned: true, reason },
      }),
    ])
    return copy(candidate)
  }

  /**
   * Create the final version from the current one.
   *
   * Refused for any actor other than `user` (an AI finalize means the user never accepted the
   * result), refused without a user-acceptance reference, refused when no current version exists,
   * and refused a second time. The created record is immutable: every later mutation throws.
   *
   * @param {object} input
   * @param {string} input.actor must be `user`
   * @param {string} input.confirmationRef reference to the user's acceptance
   * @param {string} [input.substate] one of `VersionSubstate`
   * @param {string} [input.label]
   * @returns {VersionRecord}
   */
  function finalize(input = {}) {
    if (input.actor !== Actor.USER) {
      throw new ValidationError('只有用户明确验收才能产生定稿版本；AI 不能定稿', {
        field: 'actor',
        actor: String(input.actor ?? ''),
        action: 'AI 只能形成候选并请用户验收',
      })
    }
    const confirmationRef = assertText(input.confirmationRef, 'confirmationRef', MAX_REFERENCE_LENGTH)
    const { doc, revision } = read()
    if (doc.finalVersionId !== null) {
      throw new ConflictError('项目已经定稿；定稿版本不可变，继续修改请从定稿版本形成新候选', {
        finalVersionId: doc.finalVersionId,
      })
    }
    if (doc.currentVersionId === null) {
      throw new ValidationError('还没有当前版本，不能定稿', { action: '先建立并完成当前版本' })
    }
    const current = findVersion(doc, doc.currentVersionId)
    if (current === null) {
      throw corruptDocument('当前版本记录缺失，不能定稿', { currentVersionId: doc.currentVersionId })
    }
    if (current.immutable === true) {
      throw corruptDocument('当前版本被标记为不可变，拒绝定稿', { currentVersionId: doc.currentVersionId })
    }
    const at = clock.iso()
    const substate =
      input.substate === undefined ? null : assertEnum(input.substate, VersionSubstate, 'substate')
    /** @type {VersionRecord} */
    const finalVersion = {
      versionId: newId('version'),
      class: VersionClass.FINAL,
      substate,
      label: input.label === undefined ? '定稿版本' : assertText(input.label, 'label', 200),
      createdAt: at,
      createdBy: Actor.USER,
      updatedAt: at,
      immutable: true,
      confirmationRef,
      origin: { type: 'finalized-from-current', sourceVersionId: current.versionId },
      content: copy(current.content),
    }
    doc.versions.push(finalVersion)
    doc.finalVersionId = finalVersion.versionId
    doc.transitions.push({
      at,
      kind: 'set-final',
      versionId: finalVersion.versionId,
      previousVersionId: null,
      detail: { sourceVersionId: current.versionId, confirmationRef },
    })
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.VERSION_FINALIZED,
        projectId,
        actor: Actor.USER,
        versionId: finalVersion.versionId,
        detail: { sourceVersionId: current.versionId, confirmationRef },
      }),
    ])
    return copy(finalVersion)
  }

  /**
   * Read-only, meaningful history of the creative period.
   *
   * Entries are deep copies, so a caller cannot mutate stored state through them. Version records
   * keep the class they were created with (exactly one of the three classes), and `active` says
   * whether that version is the current or final one right now; a superseded current version is
   * history without becoming a fourth class.
   *
   * @param {{ class?: string, active?: boolean }} [filter]
   * @returns {object[]}
   */
  function listHistory(filter = {}) {
    const { doc } = read()
    const retired = new Map()
    for (const transition of doc.transitions) {
      if (typeof transition?.previousVersionId !== 'string') continue
      if (transition.previousVersionId.length === 0) continue
      retired.set(transition.previousVersionId, transition)
    }
    const entries = []
    let sequence = 0
    for (const version of doc.versions) {
      sequence += 1
      const classValue = assertEnum(version?.class, VersionClass, 'version.class')
      const retirement = retired.get(version.versionId) ?? null
      entries.push({
        sequence,
        kind: 'version',
        versionId: version.versionId,
        class: classValue,
        substate: version.substate ?? null,
        label: version.label ?? '',
        active: version.versionId === doc.currentVersionId || version.versionId === doc.finalVersionId,
        immutable: version.immutable === true,
        createdAt: version.createdAt ?? '',
        createdBy: version.createdBy ?? '',
        retiredAt: retirement === null ? null : (retirement.at ?? null),
        retiredByVersionId: retirement === null ? null : (retirement.versionId ?? null),
        origin: version.origin ?? null,
        content: version.content ?? {},
        confirmationRef: version.confirmationRef ?? null,
      })
    }
    for (const candidate of doc.candidates) {
      sequence += 1
      assertEnum(candidate?.status, CandidateStatus, 'candidate.status')
      entries.push({
        sequence,
        kind: 'candidate',
        versionId: candidate.candidateId,
        candidateId: candidate.candidateId,
        class: VersionClass.CANDIDATE,
        status: candidate.status,
        baseVersionId: candidate.baseVersionId,
        target: candidate.target,
        scope: candidate.scope,
        preservedItems: candidate.preservedItems ?? [],
        checkScope: candidate.checkScope ?? [],
        diffRef: candidate.diffRef ?? null,
        previewRef: candidate.previewRef ?? null,
        createdAt: candidate.createdAt ?? '',
        createdBy: candidate.createdBy ?? '',
        active: LIVE_CANDIDATE_STATUSES.includes(candidate.status),
        immutable: false,
        retiredAt: candidate.decidedAt ?? null,
        retiredByVersionId: candidate.acceptedVersionId ?? null,
        partial: candidate.partial === true,
        requiresRecheck: candidate.requiresRecheck ?? [],
      })
    }
    entries.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
      return left.sequence - right.sequence
    })
    return entries
      .filter((entry) => (filter.class === undefined ? true : entry.class === filter.class))
      .filter((entry) => (filter.active === undefined ? true : entry.active === filter.active))
      .map((entry) => copy(entry))
  }

  /**
   * Make a chosen historical version the CURRENT one again.
   *
   * The old current version is retained as history (its record is never edited or deleted), every
   * live candidate is flagged needs-recheck because its base is no longer current, and the final
   * version cannot be a revert target: making the immutable delivered record current would make it
   * editable.
   *
   * @param {string} versionId
   * @param {object} options
   * @param {string} options.actor required
   * @param {string} [options.reason]
   * @returns {{ version: VersionRecord, previousCurrentVersionId: string|null,
   *   retainedHistoryVersionId: string|null, staleCandidateIds: string[] }}
   */
  function revertToVersion(versionId, options = {}) {
    const id = assertId(versionId, 'version', 'versionId')
    const actor = requireActor(options.actor)
    const reason = assertOptionalText(options.reason, 'reason', 1000)
    const { doc, revision } = read()
    if (doc.finalVersionId === id) {
      throw new ValidationError('定稿版本不可变，不能作为回退目标', { versionId: id })
    }
    const target = findVersion(doc, id)
    if (target === null) throw new NotFoundError('要回退到的版本不存在', { versionId: id })
    if (doc.currentVersionId === id) {
      throw new ConflictError('目标版本已经是当前版本', { versionId: id })
    }
    const previousCurrentVersionId = doc.currentVersionId
    const at = clock.iso()
    doc.currentVersionId = id
    doc.transitions.push({
      at,
      kind: 'revert',
      versionId: id,
      previousVersionId: previousCurrentVersionId,
      detail: { reason, previousRetainedAsHistory: true },
    })
    const flagged = markStale(doc, id, at)
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.VERSION_REVERTED,
        projectId,
        actor,
        versionId: id,
        detail: {
          fromVersionId: previousCurrentVersionId,
          toVersionId: id,
          reason,
          previousRetainedAsHistory: true,
        },
      }),
      ...staleEvents(flagged, id, actor),
    ])
    return {
      version: copy(target),
      previousCurrentVersionId,
      retainedHistoryVersionId: previousCurrentVersionId,
      staleCandidateIds: flagged,
    }
  }

  /**
   * Partial revert of a sub-scope: form a candidate that reverts only the named objects.
   *
   * Deliberately does NOT change the current version and does NOT claim success. Copying objects
   * back from an older version leaves everything that depended on them in its newer state, so the
   * result says `applied: false` and `dependenciesRequireRecheck: true` and carries the object list
   * that a real re-check must cover.
   *
   * @param {object} input
   * @param {string} input.versionId the version the objects are taken from
   * @param {string[]} input.objectIds the sub-scope to revert
   * @param {string} input.actor required
   * @param {string} [input.reason]
   * @returns {{ applied: boolean, partial: boolean, candidate: CandidateRecord,
   *   revertedObjectIds: string[], dependenciesRequireRecheck: boolean,
   *   requiresRecheck: string[], note: string }}
   */
  function revertPartial(input = {}) {
    const sourceVersionId = assertId(input.versionId, 'version', 'versionId')
    const actor = requireActor(input.actor)
    const objectIds = assertRefList(input.objectIds, 'objectIds')
    if (objectIds.length === 0) {
      throw new ValidationError('局部回退必须指明至少一个对象', { field: 'objectIds' })
    }
    const reason = assertOptionalText(input.reason, 'reason', 1000)
    const { doc, revision } = read()
    if (findVersion(doc, sourceVersionId) === null) {
      throw new NotFoundError('局部回退的来源版本不存在', { versionId: sourceVersionId })
    }
    if (doc.currentVersionId === null) {
      throw new ValidationError('还没有当前版本，无法形成局部回退候选', {})
    }
    const at = clock.iso()
    /** @type {CandidateRecord} */
    const candidate = {
      candidateId: newId('candidate'),
      class: VersionClass.CANDIDATE,
      baseVersionId: doc.currentVersionId,
      target: `局部回退 ${objectIds.length} 个对象到版本 ${sourceVersionId}`,
      scope: ConfirmScope.PART,
      preservedItems: [],
      diffRef: `revert-${sourceVersionId}`,
      previewRef: null,
      checkScope: objectIds,
      status: CandidateStatus.OPEN,
      createdAt: at,
      createdBy: actor,
      recheckRequired: false,
      recheckReason: null,
      staleBecauseVersionId: null,
      staleAt: null,
      recheckedAt: null,
      recheckBaseVersionId: null,
      decidedAt: null,
      decisionReason: null,
      acceptedVersionId: null,
      partial: true,
      revertSourceVersionId: sourceVersionId,
      dependenciesRequireRecheck: true,
      requiresRecheck: [...objectIds],
    }
    doc.candidates.push(candidate)
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.VERSION_CANDIDATE_CREATED,
        projectId,
        actor,
        versionId: doc.currentVersionId,
        detail: {
          candidateId: candidate.candidateId,
          partial: true,
          revertSourceVersionId: sourceVersionId,
          objectIds,
          reason,
        },
      }),
    ])
    return {
      applied: false,
      partial: true,
      candidate: copy(candidate),
      revertedObjectIds: [...objectIds],
      dependenciesRequireRecheck: true,
      requiresRecheck: [...objectIds],
      note: '局部回退只形成候选，没有直接改动当前版本；依赖这些对象的其它内容必须重新检查后才能接受',
    }
  }

  /**
   * Counts for evidence and for a receipt.
   * @returns {{ projectId: string, currentVersionId: string|null, finalVersionId: string|null,
   *   versions: number, candidates: number, liveCandidates: number, staleCandidates: number }}
   */
  function describe() {
    const { doc } = read()
    const staleCandidates = doc.candidates.filter(
      (candidate) => candidate?.status === CandidateStatus.NEEDS_RECHECK,
    ).length
    const liveCandidates = doc.candidates.filter((candidate) =>
      LIVE_CANDIDATE_STATUSES.includes(candidate?.status),
    ).length
    return {
      projectId,
      currentVersionId: doc.currentVersionId,
      finalVersionId: doc.finalVersionId,
      versions: doc.versions.length,
      candidates: doc.candidates.length,
      liveCandidates,
      staleCandidates,
    }
  }

  return {
    projectId,
    ensureCurrent,
    getCurrent,
    getFinal,
    getVersion,
    updateCurrentContent,
    updateVersionContent,
    createCandidate,
    getCandidate,
    listCandidates,
    markBaseAdvanced,
    recheckCandidate,
    acceptCandidate,
    rejectCandidate,
    abandonCandidate,
    finalize,
    listHistory,
    revertToVersion,
    revertPartial,
    describe,
  }
}
