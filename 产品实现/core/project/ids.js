/**
 * Stable identifiers for every PROJECT-CORE entity.
 *
 * Identity rules (CT-03 §1, CT-02 §2): a project, series, material, use, decision,
 * confirmation, authorization and version each get an id that never changes when a file is
 * renamed, a project is copied or a series gains an episode. Ids are opaque and PREFIXED, so a
 * wrongly-passed id fails loudly instead of aliasing a different entity.
 *
 * Randomness comes from `node:crypto`, never `Math.random`; `Math.random` is banned in product
 * code (S3) and a guessable id would let an untrusted project collide with a real one.
 *
 * @module core/project/ids
 */

import crypto from 'node:crypto'
import { ValidationError } from '../../base/index.js'

/** Crockford base32 alphabet: no I, L, O or U, so an id read aloud cannot be mistyped. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Prefix per entity type, so an id states what it names. */
export const ID_PREFIX = Object.freeze({
  project: 'prj',
  series: 'ser',
  material: 'mat',
  materialUse: 'use',
  decision: 'dec',
  confirmation: 'cnf',
  authorization: 'aut',
  version: 'ver',
  event: 'evt',
  candidate: 'cnd',
  annotation: 'ann',
  delivery: 'dlv',
})

/** Length of the random body; 16 base32 symbols carry 80 bits. */
export const ID_BODY_LENGTH = 16

/**
 * Generate one id.
 * @param {keyof typeof ID_PREFIX} entity
 * @returns {string}
 */
export function newId(entity) {
  const prefix = ID_PREFIX[entity]
  if (prefix === undefined) throw new ValidationError(`未知实体类型: ${String(entity)}`)
  const bytes = crypto.randomBytes(ID_BODY_LENGTH)
  let body = ''
  for (const byte of bytes) body += ALPHABET[byte % ALPHABET.length]
  return `${prefix}_${body}`
}

/**
 * Whether a value looks like an id of the expected entity type.
 * @param {unknown} value
 * @param {keyof typeof ID_PREFIX} [entity] when omitted, any known prefix is accepted
 * @returns {boolean}
 */
export function isId(value, entity) {
  if (typeof value !== 'string') return false
  const match = value.match(/^([a-z]{3})_([0-9A-HJKMNP-TV-Z]{16})$/)
  if (!match) return false
  if (entity === undefined) return Object.values(ID_PREFIX).includes(match[1])
  const prefix = ID_PREFIX[entity]
  return prefix !== undefined && match[1] === prefix
}

/**
 * Assert an id, naming the expected entity in the failure.
 * @param {unknown} value
 * @param {keyof typeof ID_PREFIX} entity
 * @param {string} field
 * @returns {string} the accepted id
 */
export function assertId(value, entity, field) {
  if (!isId(value, entity)) {
    throw new ValidationError(`${field} 不是合法的 ${entity} 标识`, {
      field,
      expectedPrefix: ID_PREFIX[entity],
    })
  }
  return /** @type {string} */ (value)
}

/**
 * A stable id for a material USE INSTANCE.
 *
 * A use instance is deliberately NOT the material: CT-04 §2 requires the asset body and each
 * use of it to keep separate identities, so editing one instance never rewrites the asset.
 * @returns {string}
 */
export function newUseInstanceId() {
  return newId('materialUse').replace(/^use_/, 'usi_')
}

/**
 * A stable id derived from a caller-supplied natural key, for records that must be idempotent
 * (for example a recovery marker re-written on every autosave).
 *
 * @param {string} namespace
 * @param {string} key
 * @returns {string} `namespace_` plus 32 lowercase hex characters
 */
export function derivedId(namespace, key) {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new ValidationError('derivedId 需要 namespace')
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new ValidationError('derivedId 需要 key')
  }
  const digest = crypto.createHash('sha256').update(`${namespace}\u0000${key}`).digest('hex')
  return `${namespace}_${digest.slice(0, 32)}`
}
