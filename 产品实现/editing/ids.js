/**
 * EDITING-REVIEW identifiers, documents and plan-file storage.
 *
 * C14 owns four small project documents (annotations, direct-edit sessions, edit requests,
 * comparisons) plus the plan snapshots a comparison needs. These are NOT a second project fact
 * source: versions, confirmations and locks stay in C10, and every write here goes through C10's
 * atomic document store and through the project write lock.
 *
 * Plan files live under `editing/plans/<owner>/<planVersion>.json`, inside the project directory,
 * so a candidate diff can be re-read after a restart instead of pointing at memory.
 *
 * @module editing/ids
 */

import path from 'node:path'
import {
  Clock,
  ConflictError,
  ErrorCode,
  NotFoundError,
  ValidationError,
  WorkbenchError,
  contentHash,
} from '../base/index.js'
import { derivedId, ensureDirectory, readDocument, tryReadDocument, writeDocument } from '../core/project/index.js'

/** Where EDITING-REVIEW puts its own project documents. */
export const EDITING_LAYOUT = Object.freeze({
  dir: 'editing',
  annotationsFile: 'editing/annotations.json',
  sessionsFile: 'editing/sessions.json',
  requestsFile: 'editing/requests.json',
  comparisonsFile: 'editing/comparisons.json',
  linksFile: 'editing/candidate-links.json',
  plansDir: 'editing/plans',
  previewsDir: 'editing/previews',
})

/** Stable document kinds. The kind is checked on read, so one file cannot masquerade as another. */
export const EDITING_DOCUMENT = Object.freeze({
  annotations: 'editing-annotations',
  sessions: 'editing-sessions',
  requests: 'editing-requests',
  comparisons: 'editing-comparisons',
  plan: 'editing-plan',
})

/** Interface version of this module; a change means C15/C16 must re-check integration. */
export const EDITING_INTERFACE_VERSION = '1.0.0'

/** Longest accepted bounded reference in an editing document. */
export const MAX_EDIT_REF_LENGTH = 200

/** Longest accepted free text, because a note is not a document. */
export const MAX_EDIT_TEXT_LENGTH = 2000

/**
 * A stable id for a record this module owns.
 * @param {string} namespace e.g. `ses`, `edt-req`, `edt-cmp`
 * @param {string} key natural key; must be unique inside its namespace
 * @returns {string}
 */
export function newEditingId(namespace, key) {
  return derivedId(namespace, key)
}

/**
 * Assert non-empty text.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maxLength]
 * @returns {string}
 */
export function assertText(value, field, maxLength = MAX_EDIT_TEXT_LENGTH) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} 必须是文字`, { field, received: typeof value })
  }
  if (value.trim().length === 0) throw new ValidationError(`${field} 不能为空`, { field })
  if (value.length > maxLength) {
    throw new ValidationError(`${field} 过长（最多 ${maxLength} 个字符）`, { field, length: value.length })
  }
  return value
}

/**
 * Assert optional text; `undefined` and `null` become `null`.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maxLength]
 * @returns {string|null}
 */
export function optionalText(value, field, maxLength = MAX_EDIT_TEXT_LENGTH) {
  if (value === undefined || value === null) return null
  return assertText(value, field, maxLength)
}

/**
 * Assert a bounded reference (an id, hash or project-relative path), never inlined content.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function assertRef(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EDIT_REF_LENGTH) {
    throw new ValidationError(`${field} 必须是长度 1..${MAX_EDIT_REF_LENGTH} 的引用`, { field })
  }
  return value
}

/**
 * Assert an optional reference.
 * @param {unknown} value
 * @param {string} field
 * @returns {string|null}
 */
export function optionalRef(value, field) {
  if (value === undefined || value === null) return null
  return assertRef(value, field)
}

/**
 * Assert a list of references.
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
export function assertRefList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ValidationError(`${field} 必须是数组`, { field })
  return value.map((entry, index) => assertRef(entry, `${field}[${index}]`))
}

/**
 * Assert a non-negative integer.
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
export function assertFrame(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} 必须是非负整数帧`, { field, value: String(value) })
  }
  return value
}

/**
 * Assert a positive integer.
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
export function assertPositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} 必须是正整数`, { field, value: String(value) })
  }
  return value
}

/**
 * Deep copy so a caller never holds a live handle into a stored document.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function copy(value) {
  return structuredClone(value)
}

/**
 * Build a corruption error that names the document.
 * @param {string} message
 * @param {object} [details]
 * @returns {WorkbenchError}
 */
export function corrupt(message, details) {
  return new WorkbenchError(ErrorCode.CORRUPT_DATA, message, { details })
}

/**
 * Read one editing document; an absent file yields the caller's empty document.
 *
 * The projectId inside the file is checked against the project being opened: a copied or
 * mis-pointed document must fail loudly instead of being applied to another project.
 *
 * @param {any} paths C10 `ProjectPaths`
 * @param {string} relative project-relative file path
 * @param {string} kind expected `kind`
 * @param {() => any} empty factory for a fresh document
 * @returns {{ value: any, revision: string|null }}
 */
export function readEditingDocument(paths, relative, kind, empty) {
  const stored = tryReadDocument(paths.resolve(relative), { kind })
  if (stored === null) return { value: empty(), revision: null }
  const value = stored.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw corrupt(`${kind} 不是对象`, { kind, file: relative })
  }
  if (value.kind !== kind) throw corrupt(`${kind} 文件的 kind 不符`, { expected: kind, actual: flatKind(value.kind) })
  if (value.projectId !== paths.projectId) {
    throw corrupt(`${kind} 属于另一个项目，拒绝串用`, {
      expectedProjectId: paths.projectId,
      actualProjectId: flatKind(value.projectId),
    })
  }
  return { value, revision: stored.revision }
}

/**
 * Write one editing document atomically, with the revision that was read.
 * @param {any} paths C10 `ProjectPaths`
 * @param {string} relative project-relative file path
 * @param {any} body document body without envelope fields
 * @param {string|null} revision revision read before this change, or null for a new file
 * @param {Clock} clock
 * @param {string} [kind] label used in conflict errors
 * @returns {{ revision: string, sha256: string }}
 */
export function writeEditingDocument(paths, relative, body, revision, clock, kind = '编辑记录') {
  const schemaKey = `editing.${body?.kind ?? 'document'}`
  return writeDocument(paths.resolve(relative), body, {
    kind,
    schemaKey,
    expectedRevision: revision ?? undefined,
    clock,
  })
}

/**
 * Keep a kind readable in an error without echoing huge or hostile values.
 * @param {unknown} value
 * @returns {string}
 */
function flatKind(value) {
  if (typeof value === 'string') return value.slice(0, 80)
  return String(value).slice(0, 80)
}

/**
 * Sanitize one path segment. Ids and plan versions are partly caller-supplied, so they are
 * reduced to characters that cannot form `..` or escape the plan directory.
 * @param {string} value
 * @returns {string}
 */
function segment(value) {
  const cleaned = String(value).replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  if (cleaned.length === 0 || cleaned.length > 80) {
    throw new ValidationError('路径片段不合法', { value: String(value).slice(0, 80) })
  }
  return cleaned
}

/**
 * Project-relative path of one plan snapshot.
 * @param {string} ownerId session or request id
 * @param {string} planVersion
 * @returns {string}
 */
export function planRelativePath(ownerId, planVersion) {
  return `${EDITING_LAYOUT.plansDir}/${segment(ownerId)}/${segment(planVersion)}.json`
}

/**
 * Assert a reference names one of this module's plan snapshots.
 * @param {unknown} relative
 * @returns {string}
 */
export function assertPlanRef(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || relative.length > MAX_EDIT_REF_LENGTH) {
    throw new ValidationError('计划引用不合法', { field: 'planRef' })
  }
  if (!relative.startsWith(`${EDITING_LAYOUT.plansDir}/`) || relative.includes('\\') || relative.includes('..')) {
    throw new ValidationError('计划引用必须位于 editing/plans/ 下', { field: 'planRef', value: relative })
  }
  return relative
}

/**
 * Write a normalized plan snapshot for a direct-edit session or an AI edit request.
 *
 * A plan version is written once: rewriting a version with different content would make every
 * earlier diff and candidate ambiguous, so an existing file with a different fingerprint is
 * refused instead of overwritten.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {string} input.ownerId session or request id
 * @param {any} input.plan normalized CompositionPlan
 * @param {Clock} [input.clock]
 * @returns {{ planRef: string, planVersion: string, fingerprint: string, sha256: string, written: boolean }}
 */
export function writePlanSnapshot(input) {
  const paths = input.paths
  const plan = input.plan
  if (plan === null || typeof plan !== 'object' || typeof plan.planVersion !== 'string') {
    throw new ValidationError('计划快照需要规范化计划与 planVersion', { field: 'plan' })
  }
  const clock = input.clock ?? new Clock()
  const relative = planRelativePath(input.ownerId, plan.planVersion)
  const fingerprint = contentHash(plan)
  const absolute = paths.resolve(relative)
  if (tryReadDocument(absolute, { kind: EDITING_DOCUMENT.plan }) !== null) {
    const stored = readDocument(absolute, { kind: EDITING_DOCUMENT.plan })
    if (stored.value?.fingerprint !== fingerprint) {
      throw new ConflictError('同一 planVersion 已存在不同内容的计划快照，拒绝覆盖', {
        planRef: relative,
        action: '先递增 planVersion，再写新的计划快照',
      })
    }
    return {
      planRef: relative,
      planVersion: plan.planVersion,
      fingerprint,
      sha256: stored.sha256,
      written: false,
    }
  }
  ensureDirectory(path.dirname(absolute))
  const written = writeDocument(absolute, {
    kind: EDITING_DOCUMENT.plan,
    projectId: paths.projectId,
    ownerId: input.ownerId,
    planVersion: plan.planVersion,
    fingerprint,
    plan,
    writtenAt: clock.iso(),
  }, { kind: EDITING_DOCUMENT.plan, schemaKey: 'editing.plan', createOnly: true, clock })
  return {
    planRef: relative,
    planVersion: plan.planVersion,
    fingerprint,
    sha256: written.sha256,
    written: true,
  }
}

/**
 * Read a plan snapshot written by {@link writePlanSnapshot} and verify its fingerprint.
 * @param {any} paths
 * @param {string} relative
 * @returns {{ plan: any, planRef: string, planVersion: string, fingerprint: string, ownerId: string,
 *   revision: string }}
 */
export function readPlanSnapshot(paths, relative) {
  const planRef = assertPlanRef(relative)
  const stored = tryReadDocument(paths.resolve(planRef), { kind: EDITING_DOCUMENT.plan })
  if (stored === null) throw new NotFoundError('计划快照不存在', { planRef })
  const value = stored.value
  if (value.kind !== EDITING_DOCUMENT.plan) throw corrupt('计划快照 kind 不符', { planRef })
  if (value.projectId !== paths.projectId) throw corrupt('计划快照属于另一个项目', { planRef })
  const fingerprint = contentHash(value.plan)
  if (value.fingerprint !== fingerprint) {
    throw corrupt('计划快照内容与登记指纹不一致', {
      planRef,
      expected: value.fingerprint,
      actual: fingerprint,
    })
  }
  return {
    plan: value.plan,
    planRef,
    planVersion: value.planVersion,
    fingerprint,
    ownerId: value.ownerId,
    revision: stored.revision,
  }
}

/**
 * Read the plan snapshot referenced by a C10 version's content, or `null` when the version has no
 * plan reference (for example a version created before C14 existed).
 * @param {any} paths
 * @param {any} version
 * @returns {{ plan: any, planRef: string, planVersion: string, fingerprint: string } | null}
 */
export function planOfVersion(paths, version) {
  const ref = version?.content?.planRef
  if (typeof ref !== 'string' || ref.length === 0) return null
  const stored = readPlanSnapshot(paths, ref)
  return {
    plan: stored.plan,
    planRef: stored.planRef,
    planVersion: stored.planVersion,
    fingerprint: stored.fingerprint,
  }
}

/**
 * Sum frame counts of a set of frame ranges.
 * @param {Array<{ startFrame: number, endFrameExclusive: number }>} ranges
 * @returns {number}
 */
export function framesInRanges(ranges) {
  return (ranges ?? []).reduce((sum, range) => sum + (range.endFrameExclusive - range.startFrame), 0)
}

/**
 * A bounded plan summary for evidence and projections; never the whole plan.
 * @param {any} plan
 * @returns {object}
 */
export function describePlan(plan) {
  return {
    planId: plan?.planId ?? null,
    planVersion: plan?.planVersion ?? null,
    totalFrames: plan?.timebase?.totalFrames ?? null,
    fps: `${plan?.timebase?.fpsNumerator ?? '?'}/${plan?.timebase?.fpsDenominator ?? '?'}`,
    output: plan?.outputSpec === undefined
      ? null
      : `${plan.outputSpec.width}x${plan.outputSpec.height} ${plan.outputSpec.pixelFormat}`,
    objects: Array.isArray(plan?.objects) ? plan.objects.length : 0,
    scenes: Array.isArray(plan?.scenes) ? plan.scenes.length : 0,
    transitions: Array.isArray(plan?.transitions) ? plan.transitions.length : 0,
  }
}
