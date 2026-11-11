/**
 * Identity, vocabulary and limits for the DELIVERY-EFFECTS range.
 *
 * Every name here is used by more than one module of this range, so it lives once. The closed
 * enums are product vocabulary, not UI strings: an unknown value is refused instead of being
 * coerced, because "导出失败" and "还没导出" must never share one value.
 *
 * Delivery ids use C10's `newId('delivery')` (`dlv_…`), which PROJECT-CORE already reserved. Effect,
 * package and closure ids are derived ids (`efx_…`, `pkg_…`, `clo_…`) because they must be
 * reproducible from their natural key: an effect re-indexed from the same name and source project
 * gets the same id, so two indexes cannot invent two different effects with one package on disk.
 *
 * @module delivery/ids
 */

import { ValidationError } from '../base/index.js'
import { derivedId, isId, newId } from '../core/project/index.js'

/** Interface version of this range; a change means a dependent card must re-check its calls. */
export const DELIVERY_INTERFACE_VERSION = '1.0.0'

/**
 * Document envelopes written by this range.
 *
 * `schemaKey` is deliberately not one of PROJECT-CORE's keys: these are C15 documents, and
 * `writeDocument` falls back to schemaVersion 1 for an unknown key instead of pretending they are
 * C10's. The envelope (generation + revision + read-back hash) is the part that must be shared.
 */
export const DELIVERY_DOCUMENT = Object.freeze({ kind: 'delivery', schemaKey: 'delivery' })
export const PACKAGE_DOCUMENT = Object.freeze({ kind: 'delivery-packages', schemaKey: 'delivery-packages' })
export const CLOSURE_DOCUMENT = Object.freeze({ kind: 'delivery-closure', schemaKey: 'delivery-closure' })
export const EFFECTS_DOCUMENT = Object.freeze({ kind: 'effects-library', schemaKey: 'effects-library' })

/**
 * Paths this range owns inside a project directory and under the user's data root.
 *
 * Everything is project-relative and resolved through C10's `ProjectPaths`, so a package can never
 * write outside the project it was imported into.
 */
export const DELIVERY_LAYOUT = Object.freeze({
  dir: 'delivery',
  index: 'delivery/index.json',
  packagesIndex: 'delivery/packages.json',
  closureIndex: 'delivery/closure.json',
  outputsDir: 'delivery/outputs',
  workDir: 'delivery/work',
  effectsRootDir: 'effects',
})

/** Package format version written by this range; a newer version is refused on import. */
export const PACKAGE_FORMAT_VERSION = 1

/** Lifecycle of one delivery set (one run of "导出这些规格"). */
export const DeliveryState = Object.freeze({
  PLANNED: 'planned',
  RUNNING: 'running',
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  FAILED: 'failed',
})

/** Lifecycle of one exported item (`video`, `cover`, `subtitles`, an agreed material). */
export const ItemState = Object.freeze({
  PLANNED: 'planned',
  EXPORTED: 'exported',
  FAILED: 'failed',
  NOT_IMPLEMENTED: 'not-implemented',
  SKIPPED: 'skipped',
})

/** What one item actually is. Only kinds this range can really produce are listed. */
export const ItemKind = Object.freeze({
  VIDEO: 'video',
  COVER: 'cover',
  SUBTITLES: 'subtitles',
  AUDIO: 'audio',
})

/** How an item's picture is derived: the final plan, or a real AdaptOperation. */
export const SpecBinding = Object.freeze({
  FINAL_PLAN: 'final-plan',
  ADAPT_OPERATION: 'adapt-operation',
})

/** What went wrong, in a form a test can assert and a user can act on. */
export const DeliveryFailure = Object.freeze({
  NOT_FINALIZED: 'NOT_FINALIZED',
  NO_FINAL_PLAN: 'NO_FINAL_PLAN',
  SPEC_INVALID: 'SPEC_INVALID',
  NAME_CONFLICT: 'NAME_CONFLICT',
  DISK_SPACE: 'DISK_SPACE',
  ADAPTER_UNAVAILABLE: 'ADAPTER_UNAVAILABLE',
  RENDER_FAILED: 'RENDER_FAILED',
  CHECK_FAILED: 'CHECK_FAILED',
  ADAPT_FAILED: 'ADAPT_FAILED',
  UNSAFE_PATH: 'UNSAFE_PATH',
})

/** Lifecycle of one effect candidate in the pure effect library. */
export const EffectState = Object.freeze({
  CANDIDATE: 'candidate',
  REPRODUCING: 'reproducing',
  REPRODUCED: 'reproduced',
  ADOPTED: 'adopted',
  REPRODUCE_FAILED: 'reproduce-failed',
  WITHDRAWN: 'withdrawn',
})

/** A formal effect is either a real visual effect or a real sound effect; nothing else is one. */
export const EffectKind = Object.freeze({
  VISUAL: 'visual',
  SOUND: 'sound',
})

/** The seven closure steps, in the only order the card allows. */
export const ClosureStep = Object.freeze({
  FINALIZED: 'finalized',
  DELIVERED: 'delivered',
  EFFECTS_DECIDED: 'effects-decided',
  FINAL_PROJECT: 'final-project',
  SCOPE_SHOWN: 'scope-shown',
  SCOPE_CONFIRMED: 'scope-confirmed',
  CLEANED: 'cleaned',
})

/** Order of the closure steps; never derived from object key order. */
export const CLOSURE_ORDER = Object.freeze([
  ClosureStep.FINALIZED,
  ClosureStep.DELIVERED,
  ClosureStep.EFFECTS_DECIDED,
  ClosureStep.FINAL_PROJECT,
  ClosureStep.SCOPE_SHOWN,
  ClosureStep.SCOPE_CONFIRMED,
  ClosureStep.CLEANED,
])

/** Result of one closure step. `waiting-user` is not a failure; it is not yet allowed. */
export const StepStatus = Object.freeze({
  PENDING: 'pending',
  PASSED: 'passed',
  BLOCKED: 'blocked',
  WAITING_USER: 'waiting-user',
})

/** What a cleanup may touch. Everything else is kept by construction. */
export const CleanupKind = Object.freeze({
  REBUILDABLE_CACHE: 'rebuildable-cache',
  REJECTED_CANDIDATE: 'rejected-candidate',
  SUPERSEDED_VERSION: 'superseded-version',
  UNUSED_SAMPLE: 'unused-sample',
  EXPORT_WORK: 'export-work',
})

/** Where a project lives when it is no longer active. The directory is never moved by a phase. */
export const ArchiveState = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  RECYCLE_BIN: 'recycle-bin',
  DELETED: 'deleted',
})

/**
 * Resource ceilings. Every one of them is enforced before bytes are read or written, so an
 * untrusted package cannot turn into a memory or disk problem.
 */
export const DELIVERY_LIMITS = Object.freeze({
  /** specs in one delivery plan */
  maxSpecs: 12,
  /** items in one delivery plan */
  maxItems: 40,
  /** effect candidates held in one library index */
  maxEffects: 500,
  /** files declared by one project package */
  maxPackageFiles: 20000,
  /** total bytes declared by one project package (8 GiB) */
  maxPackageBytes: 8 * 1024 * 1024 * 1024,
  /** single file inside a package (2 GiB) */
  maxPackageFileBytes: 2 * 1024 * 1024 * 1024,
  /** path depth inside a package */
  maxPackageDepth: 16,
  /** delivery records kept in one project */
  maxDeliveries: 40,
  /** cleanup entries shown in one scope */
  maxCleanupEntries: 5000,
  /** characters in a user response recorded as a confirmation */
  maxResponseLength: 4000,
})

/**
 * Assert a non-empty string.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maxLength]
 * @returns {string}
 */
export function assertText(value, field, maxLength = 500) {
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
 * Assert an optional string; `undefined` and `null` both become `null`.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maxLength]
 * @returns {string|null}
 */
export function assertOptionalText(value, field, maxLength = 500) {
  if (value === undefined || value === null) return null
  return assertText(value, field, maxLength)
}

/**
 * Assert membership in a closed enum.
 * @param {unknown} value
 * @param {Record<string, string>} enumObject
 * @param {string} field
 * @returns {string}
 */
export function assertEnumValue(value, enumObject, field) {
  const allowed = new Set(Object.values(enumObject))
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new ValidationError(`${field} 不在允许取值内`, { field, value: String(value), allowed: [...allowed] })
  }
  return value
}

/**
 * Assert a strict boolean; a truthy string is not a decision.
 * @param {unknown} value
 * @param {string} field
 * @returns {boolean}
 */
export function assertBool(value, field) {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} 必须是布尔值`, { field, received: typeof value })
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
    throw new ValidationError(`${field} 必须是正整数`, { field, received: String(value) })
  }
  return value
}

/**
 * Assert a delivery id (`dlv_…`) that PROJECT-CORE minted.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function assertDeliveryId(value, field) {
  if (!isId(value, 'delivery')) {
    throw new ValidationError(`${field} 不是合法的交付标识`, { field, expectedPrefix: 'dlv' })
  }
  return /** @type {string} */ (value)
}

/**
 * A delivery id.
 * @returns {string}
 */
export function newDeliveryId() {
  return newId('delivery')
}

/**
 * A stable effect id from the effect's natural key.
 *
 * Natural key = source project id + slug + creation time. Re-indexing the same package therefore
 * yields the same id, while a different effect never aliases it.
 * @param {{ projectId: string, slug: string, createdAt: string }} key
 * @returns {string}
 */
export function effectIdFor(key) {
  return derivedId('efx', `${key.projectId}|${key.slug}|${key.createdAt}`)
}

/**
 * A stable effect version id from effect id + version label.
 * @param {string} effectId
 * @param {string} version
 * @returns {string}
 */
export function effectVersionIdFor(effectId, version) {
  return derivedId('efv', `${effectId}|${version}`)
}

/**
 * A stable project-package id from project id + export time.
 * @param {{ projectId: string, exportedAt: string }} key
 * @returns {string}
 */
export function packageIdFor(key) {
  return derivedId('pkg', `${key.projectId}|${key.exportedAt}`)
}

/**
 * A stable closure record id from project id + start time.
 * @param {{ projectId: string, startedAt: string }} key
 * @returns {string}
 */
export function closureIdFor(key) {
  return derivedId('clo', `${key.projectId}|${key.startedAt}`)
}

/**
 * Trim one user-visible line so a projection or report cannot grow into a transcript.
 * @param {unknown} value
 * @param {number} [length]
 * @returns {string|null}
 */
export function clip(value, length = 160) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length <= length ? text : `${text.slice(0, length)}…`
}

/**
 * Deep copy via structured clone: stored records are handed out as copies, never as live objects.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function copy(value) {
  return structuredClone(value)
}

/**
 * Slug of a display name, used for file names and effect ids.
 *
 * Non-ASCII is transliterated away rather than kept: a file name the user cannot type is worse than
 * a readable one, and Windows reserved names must not appear. A slug that ends up empty becomes
 * `effect`, so a blank name cannot produce `''`-named paths.
 * @param {unknown} value
 * @returns {string}
 */
export function slugOf(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const ascii = text
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii.length === 0 ? 'effect' : ascii.slice(0, 48)
}

/**
 * Sort helper that never relies on locale: stable for tests and for evidence.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function byText(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}
