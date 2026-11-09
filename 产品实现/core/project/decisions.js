/**
 * Confirmations, decisions and authorizations: who decided what, on which object, aspect, scope
 * and version.
 *
 * Rules this module enforces in code, not only in documentation (CT-03 §4, C10 §4.2):
 * - **Only the user can confirm.** `recordConfirmation` refuses every actor other than `user`,
 *   so no AI caller can write a "用户已确认" record.
 * - **An AI suggestion is a proposal.** It is stored under `proposals` with a distinct kind and
 *   `isConfirmation: false`, and no confirmation query can return it.
 * - **Silence is not consent.** With no record the state reads `undecided`, and `ai-allowed` is
 *   kept out of `HUMAN_CONFIRMED_STATES`, so it never reads as "已确认".
 * - **History is never deleted.** Superseding keeps the old record and marks the earlier basis
 *   `changed-after-confirmation`.
 * - **An authorization is narrow.** It must name a concrete action and scope, and a
 *   `validFor: 'once'` authorization refuses a second use, recording the refused attempt.
 *
 * Every write goes through `core/project/store.js` on `PROJECT_LAYOUT.decisionsIndex`, so it
 * carries `schemaVersion`, `schemaGeneration` and `revision` and passes the revision conflict
 * check. Facts are recorded against object + aspect + scope + version so chat is never the only
 * source of truth (CT-03 §1).
 *
 * @module core/project/decisions
 */

import {
  Clock,
  ConflictError,
  ErrorCode,
  NotFoundError,
  ValidationError,
  WorkbenchError,
} from '../../base/index.js'
import { assertId, newId } from './ids.js'
import { PROJECT_LAYOUT } from './paths.js'
import { appendEvents, buildEvent, ProjectEventKind } from './events.js'
import {
  Actor,
  ConfirmAspect,
  ConfirmScope,
  ConfirmationState,
  HUMAN_CONFIRMED_STATES,
  PlanItemState,
  assertEnum,
} from './schema.js'
import { tryReadDocument, writeDocument } from './store.js'

/** Document kind and schema key `store.js` uses for the decisions index. */
export const DECISIONS_DOCUMENT = Object.freeze({ kind: 'decisions', schemaKey: 'decisions' })

/**
 * Kind marker of an AI/system suggestion.
 *
 * A proposal id is deliberately NOT a registered id prefix, so `isId(value, 'confirmation')` and
 * `isId(value, 'authorization')` both fail for it: a proposal cannot be passed where a recorded
 * fact is required.
 */
export const ProposalKind = Object.freeze({
  CONFIRMATION: 'confirmation-proposal',
  DECISION: 'decision-proposal',
  AUTHORIZATION: 'authorization-proposal',
})

/** Lifecycle marker of an authorization record. */
export const AuthorizationStatus = Object.freeze({
  GRANTED: 'granted',
  USED: 'used',
})

/** `validFor` value that permits exactly one use. */
export const VALID_FOR_ONCE = 'once'

/**
 * Text that cannot name a concrete action or scope.
 *
 * Refusing these is what makes "全自动不扩大授权" testable: an authorization for "任何操作" or
 * "所有操作" would authorize nothing and everything at once, so it is not a valid authorization.
 *
 * The English words are matched with a letter boundary, so a real action such as
 * `allocate-shader-cache` is not mistaken for `all`. CJK has no word boundary, so a broad prefix
 * there (`所有…`, `全部…`) is treated as the broad claim it is.
 */
const VAGUE_PATTERN = /^(?:\*+|any|all|everything|whatever|任何|所有|全部|一切|随便|任意)(?![a-z])/u

/**
 * @typedef {object} ConfirmationRecord
 * @property {string} confirmationId
 * @property {string} projectId
 * @property {string} objectId
 * @property {string} aspect one of `ConfirmAspect`
 * @property {string} scope one of `ConfirmScope`
 * @property {string} versionId the version the answer is about
 * @property {string} state one of `ConfirmationState`
 * @property {string} humanResponse the user's own words or a faithful summary
 * @property {string} respondedAt ISO timestamp
 * @property {string[]} evidenceRefs references to evidence, never inlined bytes
 * @property {string} recordedAt ISO timestamp
 * @property {string} [supersedes] the confirmation this one replaces
 * @property {string} [supersededBy] the confirmation that replaced this one (history is kept)
 * @property {string} [supersededAt]
 */

/**
 * @typedef {object} DecisionRecord
 * @property {string} decisionId
 * @property {string} projectId
 * @property {string} objectId
 * @property {string} aspect
 * @property {string} scope
 * @property {string} versionId
 * @property {string} actor always `user` for a recorded decision
 * @property {string} at ISO timestamp
 * @property {string} reason why the decision was made
 * @property {string} state one of `PlanItemState`
 */

/**
 * @typedef {object} AuthorizationRecord
 * @property {string} authorizationId
 * @property {string} projectId
 * @property {string} action the concrete action that was authorized
 * @property {string} target what it acts on
 * @property {string} scope how far it reaches
 * @property {string} projectVersion the version it was granted against
 * @property {string|null} dataDestination where data goes, when any leaves the machine
 * @property {{ amount: number, currency: string, description: string|null }|null} fees
 * @property {string|null} environmentImpact what changes in the environment
 * @property {string} grantedBy the user's own answer
 * @property {string} validFor `once` or an explicit scope description
 * @property {string} grantedAt ISO timestamp
 * @property {string} actor always `user`
 * @property {string} status one of `AuthorizationStatus`
 * @property {string|null} consumedAt ISO timestamp of the first use
 * @property {string|null} actualAction what was actually done
 * @property {unknown} result
 * @property {unknown} failure
 * @property {unknown} rollback
 * @property {Array<object>} uses every use (an explicit-scope authorization may be reused)
 * @property {Array<object>} refusedAttempts refused uses, kept as evidence
 */

/**
 * @typedef {object} ObjectConfirmationState
 * @property {string} objectId
 * @property {string} aspect
 * @property {string} state the state a query must report right now
 * @property {string|null} scope
 * @property {string|null} confirmationId the operative confirmation, if any
 * @property {string|null} versionId
 * @property {string|null} updatedAt
 * @property {object|null} changedAfterConfirmation the earlier basis that no longer covers it
 * @property {Array<object>} history append-only list of earlier states
 */

/**
 * Assert a non-empty text field.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maxLength]
 * @returns {string}
 */
function assertText(value, field, maxLength = 2000) {
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
function assertOptionalText(value, field, maxLength = 2000) {
  if (value === undefined || value === null) return null
  return assertText(value, field, maxLength)
}

/**
 * Assert a reference (id or hash), never inlined content.
 * A reference longer than {@link REF_MAX_LENGTH} characters is refused, which is how this module
 * keeps "content by id/hash, never inlined" honest instead of leaving it to convention.
 * @param {unknown} value
 * @param {string} field
 * @returns {string|null}
 */
function assertOptionalRef(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} 必须是引用（id 或哈希），不能内联内容`, { field, received: typeof value })
  }
  if (value.length === 0 || value.length > REF_MAX_LENGTH) {
    throw new ValidationError(`${field} 长度不合法（1..${REF_MAX_LENGTH}）`, { field, length: value.length })
  }
  return value
}

/** Longest accepted reference; longer text would mean inlined content. */
const REF_MAX_LENGTH = 200

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
  const out = []
  for (let index = 0; index < value.length; index += 1) {
    const ref = value[index]
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > REF_MAX_LENGTH) {
      throw new ValidationError(`${field} 含有非法引用`, { field, index })
    }
    out.push(ref)
  }
  return out
}

/**
 * Assert a text that names something concrete (an action, a scope).
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function assertConcreteText(value, field) {
  const text = assertText(value, field, 500)
  if (VAGUE_PATTERN.test(text.trim().toLowerCase())) {
    throw new ValidationError(`${field} 必须写明具体内容，不能是“${text}”这类笼统说法`, { field })
  }
  return text
}

/**
 * Assert an optional JSON-shaped detail bag.
 * @param {unknown} value
 * @param {string} field
 * @returns {unknown}
 */
function assertOptionalDetail(value, field) {
  if (value === undefined || value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (type === 'object') return value
  throw new ValidationError(`${field} 不能是 ${type}`, { field })
}

/**
 * Validate the `fees` field of an authorization.
 * @param {unknown} value
 * @returns {{ amount: number, currency: string, description: string|null }|null}
 */
function assertFees(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('fees 必须是对象（含 amount 与 currency）或不填', { field: 'fees' })
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const amount = Number(record.amount)
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ValidationError('fees.amount 必须是非负数值', { field: 'fees.amount' })
  }
  const currency = assertText(record.currency, 'fees.currency', 12)
  const description = assertOptionalText(record.description, 'fees.description', 500)
  return { amount, currency, description }
}

/**
 * A proposal id that cannot be mistaken for a recorded fact.
 * @returns {string}
 */
function newProposalId() {
  return newId('confirmation').replace(/^cnf_/, 'prp_')
}

/**
 * Deep copy, so a caller never receives a live handle into a document.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function copy(value) {
  return structuredClone(value)
}

/**
 * A corruption error for a document that parses as JSON but is not a decisions document.
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
  if (!Array.isArray(value)) throw corruptDocument(`决策文件中的 ${field} 不是数组`, { field })
  return value
}

/**
 * Assert a value read from disk is a plain object.
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, any>}
 */
function asRecord(value, field) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw corruptDocument(`决策文件中的 ${field} 不是对象`, { field })
  }
  return /** @type {Record<string, any>} */ (value)
}

/**
 * Filter helper shared by the list queries.
 * @param {any} record
 * @param {{ objectId?: string, aspect?: string, scope?: string, versionId?: string, state?: string }} filter
 * @returns {boolean}
 */
function matchesFilter(record, filter) {
  if (filter.objectId !== undefined && record.objectId !== filter.objectId) return false
  if (filter.aspect !== undefined && record.aspect !== filter.aspect) return false
  if (filter.scope !== undefined && record.scope !== filter.scope) return false
  if (filter.versionId !== undefined && record.versionId !== filter.versionId) return false
  if (filter.state !== undefined && record.state !== filter.state) return false
  return true
}

/**
 * A fresh, empty decisions document.
 * @param {string} projectId
 * @returns {any}
 */
function emptyDocument(projectId) {
  return {
    kind: DECISIONS_DOCUMENT.kind,
    projectId,
    confirmations: [],
    decisions: [],
    proposals: [],
    authorizations: [],
    objectStates: {},
  }
}

/**
 * Validate and normalize a document read from disk.
 * @param {any} value
 * @param {string} projectId
 * @returns {any}
 */
function normalizeDocument(value, projectId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw corruptDocument('决策文件不是对象', { stage: 'shape' })
  }
  const storedProjectId = value.projectId
  if (typeof storedProjectId === 'string' && storedProjectId.length > 0 && storedProjectId !== projectId) {
    throw corruptDocument('决策文件属于另一个项目，拒绝串用', {
      stage: 'identity',
      expectedProjectId: projectId,
    })
  }
  return {
    kind: DECISIONS_DOCUMENT.kind,
    projectId,
    confirmations: asArray(value.confirmations, 'confirmations'),
    decisions: asArray(value.decisions, 'decisions'),
    proposals: asArray(value.proposals, 'proposals'),
    authorizations: asArray(value.authorizations, 'authorizations'),
    objectStates: asRecord(value.objectStates, 'objectStates'),
  }
}

/**
 * Normalize one object/aspect state entry read from disk.
 * @param {any} entry
 * @param {string} objectId
 * @param {string} aspect
 * @returns {ObjectConfirmationState}
 */
function normalizeObjectState(entry, objectId, aspect) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw corruptDocument('对象确认状态不是对象', { objectId, aspect })
  }
  const allowed = new Set(Object.values(ConfirmationState))
  if (typeof entry.state !== 'string' || !allowed.has(entry.state)) {
    throw corruptDocument('对象确认状态不在允许取值内', { objectId, aspect, state: String(entry.state) })
  }
  return {
    objectId,
    aspect,
    state: entry.state,
    scope: typeof entry.scope === 'string' ? entry.scope : null,
    confirmationId: typeof entry.confirmationId === 'string' ? entry.confirmationId : null,
    versionId: typeof entry.versionId === 'string' ? entry.versionId : null,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    changedAfterConfirmation:
      entry.changedAfterConfirmation !== null && typeof entry.changedAfterConfirmation === 'object'
        ? entry.changedAfterConfirmation
        : null,
    history: Array.isArray(entry.history) ? entry.history : [],
  }
}

/**
 * Open the decisions index of one project.
 *
 * The returned object is the only sanctioned way to record a confirmation, a decision or an
 * external-action authorization. Nothing is cached between calls: every call reads the document
 * and writes with the revision it read, so a second writer's newer result is never overwritten.
 *
 * @param {object} options
 * @param {import('./paths.js').ProjectPaths} options.paths paths of the project this log belongs to
 * @param {Clock} [options.clock] injected clock; `core/` never reads the wall clock directly
 * @returns {{
 *   projectId: string,
 *   recordConfirmation: (input: object) => ConfirmationRecord,
 *   proposeConfirmation: (input: object) => object,
 *   listConfirmations: (filter?: object) => ConfirmationRecord[],
 *   listConfirmed: (filter?: object) => ConfirmationRecord[],
 *   isConfirmed: (objectId: string, aspect: string, options?: object) => boolean,
 *   confirmationStateOf: (objectId: string, aspect: string) => string,
 *   getObjectState: (objectId: string, aspect: string) => ObjectConfirmationState,
 *   markChangedAfterConfirmation: (input: object) => ObjectConfirmationState | null,
 *   delegateToAi: (input: object) => ObjectConfirmationState,
 *   recordDecision: (input: object) => DecisionRecord,
 *   proposeDecision: (input: object) => object,
 *   listDecisions: (filter?: object) => DecisionRecord[],
 *   getPlanItemState: (objectId: string, aspect: string) => string,
 *   grantAuthorization: (input: object) => AuthorizationRecord,
 *   proposeAuthorization: (input: object) => object,
 *   getAuthorization: (authorizationId: string) => AuthorizationRecord | null,
 *   listAuthorizations: (filter?: object) => AuthorizationRecord[],
 *   consumeAuthorization: (authorizationId: string, input: object) => object,
 *   listProposals: (filter?: object) => object[],
 *   describe: () => object,
 * }}
 */
export function createDecisionLog(options) {
  const paths = options?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('决策记录需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const projectId = assertText(paths.projectId, 'projectId', 120)
  const clock = options.clock ?? new Clock()
  const documentFile = paths.resolve(PROJECT_LAYOUT.decisionsIndex)

  /**
   * Read the document and the revision it was read at.
   * @returns {{ doc: any, revision: string|null }}
   */
  function read() {
    const stored = tryReadDocument(documentFile, { kind: DECISIONS_DOCUMENT.kind })
    if (stored === null) return { doc: emptyDocument(projectId), revision: null }
    return { doc: normalizeDocument(stored.value, projectId), revision: stored.revision }
  }

  /**
   * Persist with the revision this call read; a concurrent writer yields `VERSION_CONFLICT`.
   * @param {any} doc
   * @param {string|null} revision
   * @returns {{ revision: string, sha256: string }}
   */
  function save(doc, revision) {
    return writeDocument(documentFile, doc, {
      kind: DECISIONS_DOCUMENT.kind,
      schemaKey: DECISIONS_DOCUMENT.schemaKey,
      expectedRevision: revision,
      clock,
    })
  }

  /**
   * Append project events. Called AFTER the document is durable, so the log never claims a change
   * that was not written.
   * @param {Array<object>} events
   */
  function emit(events) {
    if (events.length === 0) return
    appendEvents(paths.dir, events, { clock })
  }

  /**
   * Read one object/aspect state entry, or `null` when nothing was confirmed.
   * @param {any} doc
   * @param {string} objectId
   * @param {string} aspect
   * @returns {ObjectConfirmationState|null}
   */
  function readObjectState(doc, objectId, aspect) {
    const perObject = doc.objectStates[objectId]
    if (perObject === undefined || perObject === null) return null
    if (typeof perObject !== 'object' || Array.isArray(perObject)) {
      throw corruptDocument('对象确认状态分组不是对象', { objectId })
    }
    const entry = perObject[aspect]
    if (entry === undefined) return null
    return normalizeObjectState(entry, objectId, aspect)
  }

  /**
   * Build the next state entry for an object/aspect.
   * @param {ObjectConfirmationState|null} previous
   * @param {object} input
   * @returns {ObjectConfirmationState}
   */
  function nextObjectState(previous, input) {
    const history = previous === null ? [] : [...previous.history]
    if (input.prior !== null) {
      // The earlier answer no longer covers the content it was given for. It is marked, never
      // deleted, so "确认后有改动" stays reconstructable from the document alone.
      history.push({
        confirmationId: input.prior.confirmationId,
        versionId: input.prior.versionId,
        scope: input.prior.scope,
        state: ConfirmationState.CHANGED_AFTER_CONFIRMATION,
        at: input.at,
        reason: 'superseded-by-new-confirmation',
      })
    }
    return {
      objectId: input.objectId,
      aspect: input.aspect,
      state: input.state,
      scope: input.scope,
      confirmationId: input.confirmationId,
      versionId: input.versionId,
      updatedAt: input.at,
      changedAfterConfirmation:
        input.prior === null
          ? null
          : {
              confirmationId: input.prior.confirmationId,
              versionId: input.prior.versionId,
              scope: input.prior.scope,
              at: input.at,
              reason: 'superseded-by-new-confirmation',
            },
      history,
    }
  }

  /**
   * Write one object/aspect state entry into the in-memory document.
   * @param {any} doc
   * @param {ObjectConfirmationState} entry
   */
  function writeObjectState(doc, entry) {
    const group = doc.objectStates[entry.objectId]
    const next = group !== null && typeof group === 'object' && !Array.isArray(group) ? { ...group } : {}
    next[entry.aspect] = entry
    doc.objectStates = { ...doc.objectStates, [entry.objectId]: next }
  }

  /**
   * Record a confirmation given by the USER.
   *
   * Refuses every actor other than `user`: an AI or system caller must use
   * {@link createDecisionLog}'s `proposeConfirmation`, which cannot satisfy any confirmation query.
   * `humanResponse` is required because a confirmation without the user's actual answer is not a
   * confirmation (silence, a tool ack and an AI choice are explicitly not confirmations).
   *
   * @param {object} input
   * @param {string} input.actor must be `user`
   * @param {string} input.objectId
   * @param {string} input.aspect one of `ConfirmAspect`
   * @param {string} input.scope one of `ConfirmScope`
   * @param {string} input.versionId the version the answer is about
   * @param {string} input.state one of `ConfirmationState`
   * @param {string} input.humanResponse the user's own words or a faithful summary
   * @param {string} [input.respondedAt] defaults to the injected clock
   * @param {string[]} [input.evidenceRefs]
   * @param {string} [input.supersedes] an earlier confirmation this one replaces
   * @returns {ConfirmationRecord}
   */
  function recordConfirmation(input = {}) {
    if (input.actor !== Actor.USER) {
      throw new ValidationError('只有用户本人的回答才能生成确认记录；AI 只能提交提议', {
        field: 'actor',
        actor: String(input.actor ?? ''),
        action: 'AI 请改用 proposeConfirmation 提交提议，等待用户回答',
      })
    }
    const objectId = assertText(input.objectId, 'objectId', 200)
    const aspect = assertEnum(input.aspect, ConfirmAspect, 'aspect')
    const scope = assertEnum(input.scope, ConfirmScope, 'scope')
    const state = assertEnum(input.state, ConfirmationState, 'state')
    const versionId = assertId(input.versionId, 'version', 'versionId')
    const humanResponse = assertText(input.humanResponse, 'humanResponse', 4000)
    const evidenceRefs = assertRefList(input.evidenceRefs, 'evidenceRefs')
    const respondedAt =
      input.respondedAt === undefined ? clock.iso() : assertText(input.respondedAt, 'respondedAt', 60)
    const supersedes =
      input.supersedes === undefined || input.supersedes === null
        ? null
        : assertText(input.supersedes, 'supersedes', 120)

    const { doc, revision } = read()
    let prior = null
    if (supersedes !== null) {
      const earlier = doc.confirmations.find((record) => record.confirmationId === supersedes)
      if (earlier === undefined) {
        throw new NotFoundError('要取代的确认记录不存在', { confirmationId: supersedes })
      }
      if (earlier.objectId !== objectId || earlier.aspect !== aspect) {
        throw new ValidationError('取代关系必须指向同一对象与同一方面', {
          field: 'supersedes',
          expectedObjectId: earlier.objectId,
          expectedAspect: earlier.aspect,
        })
      }
      if (typeof earlier.supersededBy === 'string') {
        throw new ConflictError('该确认记录已被取代，不能再次取代', {
          confirmationId: supersedes,
          supersededBy: earlier.supersededBy,
        })
      }
      prior = earlier
    }

    const confirmationId = newId('confirmation')
    const at = clock.iso()
    /** @type {ConfirmationRecord} */
    const record = {
      confirmationId,
      projectId,
      objectId,
      aspect,
      scope,
      versionId,
      state,
      humanResponse,
      respondedAt,
      evidenceRefs,
      recordedAt: at,
    }
    if (supersedes !== null) record.supersedes = supersedes

    if (prior !== null) {
      prior.supersededBy = confirmationId
      prior.supersededAt = at
    }
    doc.confirmations.push(record)

    const previousState = readObjectState(doc, objectId, aspect)
    writeObjectState(
      doc,
      nextObjectState(previousState, {
        objectId,
        aspect,
        scope,
        state,
        confirmationId,
        versionId,
        at,
        prior,
      }),
    )

    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.CONFIRMATION_RECORDED,
        projectId,
        actor: Actor.USER,
        objectId,
        aspect,
        scope,
        versionId,
        detail: { confirmationId, state, supersedes },
      }),
    ])
    if (prior !== null) {
      emit([
        buildEvent({
          kind: ProjectEventKind.CONFIRMATION_SUPERSEDED,
          projectId,
          actor: Actor.USER,
          objectId,
          aspect,
          scope,
          versionId,
          detail: { previousConfirmationId: prior.confirmationId, confirmationId },
        }),
      ])
    }
    return copy(record)
  }

  /**
   * Submit an AI/system PROPOSAL for a confirmation.
   *
   * The result is not a confirmation: it is a `confirmation-proposal` record with
   * `isConfirmation: false`, stored in the separate `proposals` list. It never satisfies
   * `isConfirmed`, `listConfirmed` or `confirmationStateOf`.
   *
   * @param {object} input
   * @param {string} [input.actor] `ai` (default) or `system`; `user` is refused
   * @param {string} input.objectId
   * @param {string} input.aspect
   * @param {string} input.scope
   * @param {string} input.versionId
   * @param {string} input.proposedState the state being proposed
   * @param {string} input.rationale why the AI suggests it
   * @param {string[]} [input.evidenceRefs]
   * @returns {object} the stored proposal
   */
  function proposeConfirmation(input = {}) {
    const actor = input.actor ?? Actor.AI
    assertEnum(actor, Actor, 'actor')
    if (actor === Actor.USER) {
      throw new ValidationError('用户确认请用 recordConfirmation；提议只用于 AI 或系统建议', { field: 'actor' })
    }
    const objectId = assertText(input.objectId, 'objectId', 200)
    const aspect = assertEnum(input.aspect, ConfirmAspect, 'aspect')
    const scope = assertEnum(input.scope, ConfirmScope, 'scope')
    const versionId = assertId(input.versionId, 'version', 'versionId')
    const proposedState = assertEnum(input.proposedState, ConfirmationState, 'proposedState')
    const rationale = assertText(input.rationale, 'rationale', 2000)
    const evidenceRefs = assertRefList(input.evidenceRefs, 'evidenceRefs')
    const proposal = {
      proposalId: newProposalId(),
      kind: ProposalKind.CONFIRMATION,
      isProposal: true,
      isConfirmation: false,
      projectId,
      objectId,
      aspect,
      scope,
      versionId,
      proposedState,
      rationale,
      evidenceRefs,
      proposedBy: actor,
      proposedAt: clock.iso(),
    }
    const { doc, revision } = read()
    doc.proposals.push(proposal)
    save(doc, revision)
    return copy(proposal)
  }

  /**
   * All confirmation records, oldest first, INCLUDING superseded ones.
   *
   * This is the history view: it exists so "确认后有改动" is reconstructable. Use
   * {@link createDecisionLog}'s `listConfirmed` for "what is confirmed right now".
   *
   * @param {{ objectId?: string, aspect?: string, scope?: string, versionId?: string, state?: string }} [filter]
   * @returns {ConfirmationRecord[]}
   */
  function listConfirmations(filter = {}) {
    const { doc } = read()
    return doc.confirmations
      .filter((record) => matchesFilter(record, filter))
      .map((record) => copy(record))
  }

  /**
   * Only the confirmations that still represent the user's answer for the current content.
   *
   * Three things are excluded on purpose: a superseded record (history), a state outside
   * `HUMAN_CONFIRMED_STATES` (`undecided`, `ai-allowed`, `changed-after-confirmation`), and a
   * record that a newer confirmation already replaced for the same object+aspect.
   *
   * @param {{ objectId?: string, aspect?: string, scope?: string, versionId?: string }} [filter]
   * @returns {ConfirmationRecord[]}
   */
  function listConfirmed(filter = {}) {
    const { doc } = read()
    return doc.confirmations
      .filter((record) => HUMAN_CONFIRMED_STATES.includes(record.state))
      .filter((record) => typeof record.supersededBy !== 'string')
      .filter((record) => matchesFilter(record, filter))
      .filter((record) => {
        const entry = readObjectState(doc, record.objectId, record.aspect)
        if (entry === null) return false
        if (entry.confirmationId !== record.confirmationId) return false
        return HUMAN_CONFIRMED_STATES.includes(entry.state)
      })
      .map((record) => copy(record))
  }

  /**
   * Whether the user has genuinely confirmed this object+aspect right now.
   *
   * Returns `false` for `ai-allowed` (the user let the AI choose, which is not the user having
   * reviewed the result), for `undecided`, for `changed-after-confirmation`, and for a record
   * about a different version than the one asked about.
   *
   * @param {string} objectId
   * @param {string} aspect
   * @param {{ versionId?: string, scope?: string }} [options]
   * @returns {boolean}
   */
  function isConfirmed(objectId, aspect, options = {}) {
    const id = assertText(objectId, 'objectId', 200)
    const a = assertEnum(aspect, ConfirmAspect, 'aspect')
    const { doc } = read()
    const entry = readObjectState(doc, id, a)
    if (entry === null) return false
    if (!HUMAN_CONFIRMED_STATES.includes(entry.state)) return false
    if (options.versionId !== undefined && entry.versionId !== options.versionId) return false
    if (options.scope !== undefined && entry.scope !== options.scope) return false
    return true
  }

  /**
   * The confirmation state to display for one object+aspect. Absence reads as `undecided`.
   * @param {string} objectId
   * @param {string} aspect
   * @returns {string}
   */
  function confirmationStateOf(objectId, aspect) {
    const id = assertText(objectId, 'objectId', 200)
    const a = assertEnum(aspect, ConfirmAspect, 'aspect')
    const { doc } = read()
    const entry = readObjectState(doc, id, a)
    return entry === null ? ConfirmationState.UNDECIDED : entry.state
  }

  /**
   * The full state entry for one object+aspect, synthesized as `undecided` when unknown.
   * @param {string} objectId
   * @param {string} aspect
   * @returns {ObjectConfirmationState}
   */
  function getObjectState(objectId, aspect) {
    const id = assertText(objectId, 'objectId', 200)
    const a = assertEnum(aspect, ConfirmAspect, 'aspect')
    const { doc } = read()
    const entry = readObjectState(doc, id, a)
    if (entry !== null) return copy(entry)
    return {
      objectId: id,
      aspect: a,
      state: ConfirmationState.UNDECIDED,
      scope: null,
      confirmationId: null,
      versionId: null,
      updatedAt: null,
      changedAfterConfirmation: null,
      history: [],
    }
  }

  /**
   * Mark that content changed after it was confirmed.
   *
   * The confirmation record is kept untouched; the object state becomes
   * `changed-after-confirmation` so no query can keep claiming the stale answer, and the prior
   * basis is appended to the state history. Returns `null` when there was nothing confirmed.
   *
   * @param {object} input
   * @param {string} input.objectId
   * @param {string} input.aspect
   * @param {string} [input.versionId] the version the change produced
   * @param {string} [input.reason]
   * @param {string} [input.actor] who changed the content; defaults to `system`
   * @returns {ObjectConfirmationState|null}
   */
  function markChangedAfterConfirmation(input = {}) {
    const objectId = assertText(input.objectId, 'objectId', 200)
    const aspect = assertEnum(input.aspect, ConfirmAspect, 'aspect')
    const reason = assertOptionalText(input.reason, 'reason', 1000) ?? '内容在确认后发生变化'
    const actor = input.actor === undefined ? Actor.SYSTEM : assertEnum(input.actor, Actor, 'actor')
    const { doc, revision } = read()
    const previous = readObjectState(doc, objectId, aspect)
    if (previous === null || previous.confirmationId === null) return null
    if (previous.state === ConfirmationState.CHANGED_AFTER_CONFIRMATION) return copy(previous)

    const at = clock.iso()
    const versionId =
      input.versionId === undefined ? previous.versionId : assertId(input.versionId, 'version', 'versionId')
    const entry = {
      objectId,
      aspect,
      state: ConfirmationState.CHANGED_AFTER_CONFIRMATION,
      scope: previous.scope,
      confirmationId: previous.confirmationId,
      versionId,
      updatedAt: at,
      changedAfterConfirmation: {
        confirmationId: previous.confirmationId,
        versionId: previous.versionId,
        scope: previous.scope,
        at,
        reason,
      },
      history: [
        ...previous.history,
        {
          confirmationId: previous.confirmationId,
          versionId: previous.versionId,
          scope: previous.scope,
          state: ConfirmationState.CHANGED_AFTER_CONFIRMATION,
          at,
          reason,
        },
      ],
    }
    writeObjectState(doc, entry)
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.CONFIRMATION_SUPERSEDED,
        projectId,
        actor,
        objectId,
        aspect,
        scope: entry.scope ?? undefined,
        versionId,
        detail: { change: 'content-changed-after-confirmation', reason },
      }),
    ])
    return copy(entry)
  }

  /**
   * Record that the user delegated this aspect to the AI (`ai-allowed`).
   *
   * This is still a USER action and still not a confirmation: the state is outside
   * `HUMAN_CONFIRMED_STATES`, so `isConfirmed` stays `false` ("AI 自主不使用用户确认外观").
   *
   * @param {object} input
   * @param {string} input.objectId
   * @param {string} input.aspect
   * @param {string} input.scope
   * @param {string} input.versionId
   * @param {string} input.humanResponse the user's words delegating the choice
   * @returns {ObjectConfirmationState}
   */
  function delegateToAi(input = {}) {
    const record = recordConfirmation({
      ...input,
      actor: Actor.USER,
      state: ConfirmationState.AI_ALLOWED,
    })
    return getObjectState(record.objectId, record.aspect)
  }

  /**
   * Record a decision the USER made about an object.
   *
   * A decision is keyed to object + aspect + scope + version so the chat log is never the only
   * place the decision exists. An AI decision cannot be recorded here; see `proposeDecision`.
   *
   * @param {object} input
   * @param {string} input.actor must be `user`
   * @param {string} input.objectId
   * @param {string} input.aspect
   * @param {string} input.scope
   * @param {string} input.versionId
   * @param {string} input.reason why the decision was made
   * @param {string} [input.state] one of `PlanItemState`; defaults to `decided`
   * @param {string[]} [input.evidenceRefs]
   * @returns {DecisionRecord}
   */
  function recordDecision(input = {}) {
    if (input.actor !== Actor.USER) {
      throw new ValidationError('只有用户能记录决定；AI 的决定只能作为提议', {
        field: 'actor',
        actor: String(input.actor ?? ''),
        action: 'AI 请改用 proposeDecision 提交提议',
      })
    }
    const objectId = assertText(input.objectId, 'objectId', 200)
    const aspect = assertEnum(input.aspect, ConfirmAspect, 'aspect')
    const scope = assertEnum(input.scope, ConfirmScope, 'scope')
    const versionId = assertId(input.versionId, 'version', 'versionId')
    const reason = assertText(input.reason, 'reason', 2000)
    const state = input.state === undefined ? PlanItemState.DECIDED : assertEnum(input.state, PlanItemState, 'state')
    const evidenceRefs = assertRefList(input.evidenceRefs, 'evidenceRefs')
    const at = clock.iso()
    /** @type {DecisionRecord} */
    const record = {
      decisionId: newId('decision'),
      projectId,
      objectId,
      aspect,
      scope,
      versionId,
      actor: Actor.USER,
      at,
      reason,
      state,
      evidenceRefs,
    }
    const { doc, revision } = read()
    doc.decisions.push(record)
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.DECISION_RECORDED,
        projectId,
        actor: Actor.USER,
        objectId,
        aspect,
        scope,
        versionId,
        detail: { decisionId: record.decisionId, state },
      }),
    ])
    return copy(record)
  }

  /**
   * Submit an AI/system decision PROPOSAL. It is not a decision: no decision query returns it.
   * @param {object} input
   * @param {string} [input.actor] `ai` (default) or `system`
   * @param {string} input.objectId
   * @param {string} input.aspect
   * @param {string} input.scope
   * @param {string} input.versionId
   * @param {string} input.reason
   * @param {string} input.proposedState one of `PlanItemState`
   * @param {string} [input.rationale]
   * @returns {object}
   */
  function proposeDecision(input = {}) {
    const actor = input.actor ?? Actor.AI
    assertEnum(actor, Actor, 'actor')
    if (actor === Actor.USER) {
      throw new ValidationError('用户决定请用 recordDecision；提议只用于 AI 或系统建议', { field: 'actor' })
    }
    const proposal = {
      proposalId: newProposalId(),
      kind: ProposalKind.DECISION,
      isProposal: true,
      isDecision: false,
      projectId,
      objectId: assertText(input.objectId, 'objectId', 200),
      aspect: assertEnum(input.aspect, ConfirmAspect, 'aspect'),
      scope: assertEnum(input.scope, ConfirmScope, 'scope'),
      versionId: assertId(input.versionId, 'version', 'versionId'),
      proposedState: assertEnum(input.proposedState, PlanItemState, 'proposedState'),
      reason: assertText(input.reason, 'reason', 2000),
      rationale: assertOptionalText(input.rationale, 'rationale', 2000),
      proposedBy: actor,
      proposedAt: clock.iso(),
    }
    const { doc, revision } = read()
    doc.proposals.push(proposal)
    save(doc, revision)
    return copy(proposal)
  }

  /**
   * All recorded decisions (never proposals), oldest first.
   * @param {{ objectId?: string, aspect?: string, scope?: string, versionId?: string, state?: string }} [filter]
   * @returns {DecisionRecord[]}
   */
  function listDecisions(filter = {}) {
    const { doc } = read()
    return doc.decisions.filter((record) => matchesFilter(record, filter)).map((record) => copy(record))
  }

  /**
   * The plan-item state used by `assertProductionGate`.
   *
   * A user decision wins over a confirmation state for the same object+aspect. `partially
   * confirmed` and `changed-after-confirmation` deliberately map to `undecided`, so a key plan
   * item in either state blocks full production instead of passing on a technicality.
   *
   * @param {string} objectId
   * @param {string} aspect
   * @returns {string} one of `PlanItemState`
   */
  function getPlanItemState(objectId, aspect) {
    const id = assertText(objectId, 'objectId', 200)
    const a = assertEnum(aspect, ConfirmAspect, 'aspect')
    const { doc } = read()
    const decisions = doc.decisions.filter((record) => record.objectId === id && record.aspect === a)
    const latest = decisions.at(-1)
    if (latest !== undefined) {
      if (latest.state === PlanItemState.AI_ALLOWED) return PlanItemState.AI_ALLOWED
      if (latest.state === PlanItemState.DECIDED) return PlanItemState.DECIDED
      return PlanItemState.UNDECIDED
    }
    const entry = readObjectState(doc, id, a)
    if (entry === null) return PlanItemState.UNDECIDED
    if (entry.state === ConfirmationState.AI_ALLOWED) return PlanItemState.AI_ALLOWED
    if (entry.state === ConfirmationState.CONFIRMED) return PlanItemState.DECIDED
    return PlanItemState.UNDECIDED
  }

  /**
   * Record an authorization the USER granted for a concrete external action.
   *
   * Refused for any actor other than `user`, and refused when `action` or `scope` is empty or a
   * vague word: "全自动不扩大授权" only means something if an authorization has to name exactly
   * what it permits.
   *
   * @param {object} input
   * @param {string} input.actor must be `user`
   * @param {string} input.action the concrete action, e.g. `download-model-weights`
   * @param {string} input.target what it acts on
   * @param {string} input.scope how far it reaches
   * @param {string} input.projectVersion the project version it was granted against
   * @param {string} input.grantedBy the user's explicit answer
   * @param {string} [input.validFor] `once` (default) or an explicit scope description
   * @param {string|null} [input.dataDestination]
   * @param {{ amount: number, currency: string, description?: string }|null} [input.fees]
   * @param {string|null} [input.environmentImpact]
   * @param {string[]} [input.evidenceRefs]
   * @returns {AuthorizationRecord}
   */
  function grantAuthorization(input = {}) {
    if (input.actor !== Actor.USER) {
      throw new ValidationError('只有用户能授予外部动作授权；AI 只能提交授权提议', {
        field: 'actor',
        actor: String(input.actor ?? ''),
        action: 'AI 请改用 proposeAuthorization 提交提议',
      })
    }
    const action = assertConcreteText(input.action, 'action')
    const target = assertConcreteText(input.target, 'target')
    const scope = assertConcreteText(input.scope, 'scope')
    const projectVersion = assertText(input.projectVersion, 'projectVersion', 120)
    const grantedBy = assertText(input.grantedBy, 'grantedBy', 4000)
    const validFor =
      input.validFor === undefined ? VALID_FOR_ONCE : assertConcreteText(input.validFor, 'validFor')
    const dataDestination = assertOptionalText(input.dataDestination, 'dataDestination', 500)
    const fees = assertFees(input.fees)
    const environmentImpact = assertOptionalText(input.environmentImpact, 'environmentImpact', 1000)
    const evidenceRefs = assertRefList(input.evidenceRefs, 'evidenceRefs')
    const at = clock.iso()
    /** @type {AuthorizationRecord} */
    const record = {
      authorizationId: newId('authorization'),
      projectId,
      action,
      target,
      scope,
      projectVersion,
      dataDestination,
      fees,
      environmentImpact,
      grantedBy,
      validFor,
      grantedAt: at,
      actor: Actor.USER,
      status: AuthorizationStatus.GRANTED,
      consumedAt: null,
      actualAction: null,
      result: null,
      failure: null,
      rollback: null,
      evidenceRefs,
      uses: [],
      refusedAttempts: [],
    }
    const { doc, revision } = read()
    doc.authorizations.push(record)
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.AUTHORIZATION_RECORDED,
        projectId,
        actor: Actor.USER,
        scope,
        versionId: undefined,
        detail: { authorizationId: record.authorizationId, action, target, validFor },
      }),
    ])
    return copy(record)
  }

  /**
   * Submit an AI/system authorization PROPOSAL. A proposal authorizes nothing.
   * @param {object} input
   * @param {string} [input.actor] `ai` (default) or `system`
   * @param {string} input.action
   * @param {string} input.target
   * @param {string} input.scope
   * @param {string} input.projectVersion
   * @param {string} input.rationale
   * @returns {object}
   */
  function proposeAuthorization(input = {}) {
    const actor = input.actor ?? Actor.AI
    assertEnum(actor, Actor, 'actor')
    if (actor === Actor.USER) {
      throw new ValidationError('用户授权请用 grantAuthorization；提议只用于 AI 或系统建议', {
        field: 'actor',
      })
    }
    const proposal = {
      proposalId: newProposalId(),
      kind: ProposalKind.AUTHORIZATION,
      isProposal: true,
      isAuthorization: false,
      projectId,
      action: assertConcreteText(input.action, 'action'),
      target: assertConcreteText(input.target, 'target'),
      scope: assertConcreteText(input.scope, 'scope'),
      projectVersion: assertText(input.projectVersion, 'projectVersion', 120),
      rationale: assertText(input.rationale, 'rationale', 2000),
      proposedBy: actor,
      proposedAt: clock.iso(),
    }
    const { doc, revision } = read()
    doc.proposals.push(proposal)
    save(doc, revision)
    return copy(proposal)
  }

  /**
   * One authorization record, or `null`.
   * @param {string} authorizationId
   * @returns {AuthorizationRecord|null}
   */
  function getAuthorization(authorizationId) {
    const id = assertText(authorizationId, 'authorizationId', 120)
    const { doc } = read()
    const record = doc.authorizations.find((item) => item.authorizationId === id)
    return record === undefined ? null : copy(record)
  }

  /**
   * All authorization records, oldest first.
   * @param {{ action?: string, status?: string, target?: string }} [filter]
   * @returns {AuthorizationRecord[]}
   */
  function listAuthorizations(filter = {}) {
    const { doc } = read()
    return doc.authorizations
      .filter((record) => {
        if (filter.action !== undefined && record.action !== filter.action) return false
        if (filter.status !== undefined && record.status !== filter.status) return false
        if (filter.target !== undefined && record.target !== filter.target) return false
        return true
      })
      .map((record) => copy(record))
  }

  /**
   * Use an authorization, recording what was actually done.
   *
   * A `validFor: 'once'` authorization refuses a second use: the refused attempt is written to
   * `refusedAttempts` and the call throws, so the caller cannot treat the refusal as success and
   * cannot silently widen the authorization. An action that does not match the authorized action
   * is refused the same way.
   *
   * @param {string} authorizationId
   * @param {object} input
   * @param {string} input.action the action actually about to be performed
   * @param {string} [input.actor] `user`, `ai` or `system`; defaults to `system`
   * @param {string} [input.target]
   * @param {unknown} [input.result] what actually happened
   * @param {unknown} [input.failure] what failed, if anything
   * @param {unknown} [input.rollback] how to undo it
   * @returns {{ ok: boolean, authorization: AuthorizationRecord, use: object }}
   */
  function consumeAuthorization(authorizationId, input = {}) {
    const id = assertText(authorizationId, 'authorizationId', 120)
    const action = assertText(input.action, 'action', 500)
    const actor = input.actor === undefined ? Actor.SYSTEM : assertEnum(input.actor, Actor, 'actor')
    const { doc, revision } = read()
    const record = doc.authorizations.find((item) => item.authorizationId === id)
    if (record === undefined) {
      throw new NotFoundError('授权记录不存在，不能执行外部动作', { authorizationId: id })
    }
    const at = clock.iso()
    const uses = Array.isArray(record.uses) ? record.uses : []
    const refusedAttempts = Array.isArray(record.refusedAttempts) ? record.refusedAttempts : []

    /**
     * Record a refused use and persist it before throwing.
     * @param {string} reason
     * @returns {never}
     */
    const refuse = (reason) => {
      record.refusedAttempts = [...refusedAttempts, { at, actor, action, reason }]
      save(doc, revision)
      if (reason === 'once-already-used') {
        throw new ConflictError('该授权是一次性授权，已经使用过；需要用户重新授权才能再次执行', {
          authorizationId: id,
          validFor: record.validFor,
          uses: uses.length,
          action: '请用户重新授权，不能重复使用旧授权',
        })
      }
      throw new ValidationError('实际动作与授权动作不一致，已拒绝执行', {
        authorizationId: id,
        authorizedAction: record.action,
        attemptedAction: action,
      })
    }

    if (record.validFor === VALID_FOR_ONCE && uses.length > 0) refuse('once-already-used')
    if (action !== record.action) refuse('action-mismatch')

    const use = {
      at,
      actor,
      action,
      target: assertOptionalText(input.target, 'target', 500) ?? record.target,
      result: assertOptionalDetail(input.result, 'result'),
      failure: assertOptionalDetail(input.failure, 'failure'),
      rollback: assertOptionalDetail(input.rollback, 'rollback'),
    }
    record.uses = [...uses, use]
    record.status = AuthorizationStatus.USED
    record.consumedAt = typeof record.consumedAt === 'string' ? record.consumedAt : at
    record.actualAction = action
    record.result = use.result
    record.failure = use.failure
    record.rollback = use.rollback
    save(doc, revision)
    emit([
      buildEvent({
        kind: ProjectEventKind.AUTHORIZATION_CONSUMED,
        projectId,
        actor,
        scope: record.scope,
        detail: { authorizationId: id, action, target: use.target, uses: record.uses.length },
      }),
    ])
    return { ok: true, authorization: copy(record), use: copy(use) }
  }

  /**
   * All proposals (AI/system suggestions). None of them is a confirmation, decision or
   * authorization, and no other query in this module returns them.
   * @param {{ kind?: string, objectId?: string }} [filter]
   * @returns {object[]}
   */
  function listProposals(filter = {}) {
    const { doc } = read()
    return doc.proposals
      .filter((proposal) => (filter.kind === undefined ? true : proposal.kind === filter.kind))
      .filter((proposal) => (filter.objectId === undefined ? true : proposal.objectId === filter.objectId))
      .map((proposal) => copy(proposal))
  }

  /**
   * Counts for evidence and for the single display string built by `summarizeProjectState`.
   * @returns {{ projectId: string, confirmations: number, confirmed: number, total: number,
   *   decisions: number, proposals: number, authorizations: number, confirmationProgress: object }}
   */
  function describe() {
    const { doc } = read()
    const entries = []
    for (const [objectId, group] of Object.entries(doc.objectStates)) {
      if (group === null || typeof group !== 'object' || Array.isArray(group)) continue
      for (const [aspect, entry] of Object.entries(group)) {
        entries.push(normalizeObjectState(entry, objectId, aspect))
      }
    }
    const confirmed = entries.filter((entry) => HUMAN_CONFIRMED_STATES.includes(entry.state)).length
    return {
      projectId,
      confirmations: doc.confirmations.length,
      confirmed,
      total: entries.length,
      decisions: doc.decisions.length,
      proposals: doc.proposals.length,
      authorizations: doc.authorizations.length,
      confirmationProgress: { confirmed, total: entries.length },
    }
  }

  return {
    projectId,
    recordConfirmation,
    proposeConfirmation,
    listConfirmations,
    listConfirmed,
    isConfirmed,
    confirmationStateOf,
    getObjectState,
    markChangedAfterConfirmation,
    delegateToAi,
    recordDecision,
    proposeDecision,
    listDecisions,
    getPlanItemState,
    grantAuthorization,
    proposeAuthorization,
    getAuthorization,
    listAuthorizations,
    consumeAuthorization,
    listProposals,
    describe,
  }
}
