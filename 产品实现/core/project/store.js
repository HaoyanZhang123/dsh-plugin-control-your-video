/**
 * Durable versioned documents: the only way PROJECT-CORE reads or writes a JSON state file.
 *
 * Responsibilities, each traceable to a contract clause:
 * - **Atomic + durable write.** Delegates to `base.writeFileAtomic`, which writes a sibling temp
 *   file, fsyncs the CONTENT, verifies the read-back hash and publishes by atomic rename
 *   (CT-02 §3.1-3.5). Directory-entry durability is a measured Windows limit and is recorded in
 *   `DURABILITY_LIMITS`, not claimed (CT-02 §3; C04 §5).
 * - **Schema version + migration.** Every document carries `schemaVersion` and
 *   `schemaGeneration`. A document from an older generation is migrated through an explicit
 *   chain and written as a NEW generation, source untouched (CT-02 §6).
 * - **Optimistic concurrency.** Every document carries `revision`. A write states the revision
 *   it was based on; a mismatch fails with `VERSION_CONFLICT` instead of overwriting another
 *   writer's newer result (CT-02 §3; 03 §3.8).
 * - **Read-back verification.** The bytes just written are re-read and compared, so a
 *   half-published file is reported instead of trusted (CT-02 §3.5).
 * - **Corruption is an error, never an empty document.** A truncated or malformed file becomes
 *   `CORRUPT_DATA` with the real byte count, because silently starting from `{}` would destroy
 *   the user's project (CT-11 §5 "不用同样错误结果冒充").
 *
 * @module core/project/store
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  ConflictError,
  ErrorCode,
  IoError,
  ValidationError,
  WorkbenchError,
  readJson,
  sha256,
  stableStringify,
  writeFileAtomic,
  DURABILITY_LIMITS,
  hitFault,
} from '../../base/index.js'
import { SCHEMA_VERSION, CURRENT_SCHEMA_GENERATION } from './schema.js'
import { migrationChain, applyMigrationChain } from './migrations.js'

/**
 * A parsed document plus its on-disk facts.
 * @typedef {object} StoredDocument
 * @property {any} value the document body (already migrated to the current generation)
 * @property {string} revision revision that was read
 * @property {number} schemaVersion
 * @property {number} schemaGeneration
 * @property {string} sha256 hash of the bytes as read
 * @property {number} bytes
 * @property {boolean} migrated whether this read performed a migration
 */

/**
 * Read a document, migrating it when its generation is older.
 *
 * @param {string} filePath absolute path
 * @param {object} options
 * @param {string} options.kind human label used in errors, e.g. `project`
 * @param {number} options.expectedGeneration generation this caller can operate on
 * @returns {StoredDocument}
 */
export function readDocument(filePath, options) {
  const kind = options.kind ?? 'document'
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new IoError(`${kind} 文件不存在`, {
        details: { kind, stage: 'read', reason: 'ENOENT' },
        cause: error,
      })
    }
    throw new IoError(`${kind} 文件无法读取`, {
      details: { kind, stage: 'read', reason: error?.code ?? 'unknown' },
      cause: error,
    })
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // Keep the byte count so a truncated file is diagnosable without dumping its content.
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, `${kind} 文件内容损坏，无法解析`, {
      details: { kind, stage: 'parse', bytes: Buffer.byteLength(text, 'utf8') },
      cause: error,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, `${kind} 文件不是对象`, {
      details: { kind, stage: 'shape', valueType: Array.isArray(parsed) ? 'array' : typeof parsed },
    })
  }

  const schemaGeneration = normalizeGeneration(parsed.schemaGeneration)
  if (schemaGeneration > CURRENT_SCHEMA_GENERATION) {
    // A NEWER writer opened this project. Refusing is the only safe answer: migrating downwards
    // would silently drop fields this build does not know about.
    throw new WorkbenchError(ErrorCode.UNSUPPORTED, `${kind} 由更新版本写入，当前版本不能安全读取`, {
      details: {
        kind,
        stage: 'generation',
        found: schemaGeneration,
        supported: CURRENT_SCHEMA_GENERATION,
        action: '请用写入该项目的更新版本打开，或另行处理；不得降级覆盖',
      },
    })
  }

  let value = parsed
  let migrated = false
  if (schemaGeneration < CURRENT_SCHEMA_GENERATION) {
    const chain = migrationChain(kind, schemaGeneration, CURRENT_SCHEMA_GENERATION)
    if (chain.length === 0) {
      throw new WorkbenchError(ErrorCode.CORRUPT_DATA, `${kind} 缺少可用的迁移链`, {
        details: { kind, from: schemaGeneration, to: CURRENT_SCHEMA_GENERATION },
      })
    }
    value = applyMigrationChain(parsed, chain)
    migrated = true
  }

  return {
    value,
    revision: typeof value.revision === 'string' ? value.revision : '',
    schemaVersion: normalizeVersion(value.schemaVersion, kind),
    schemaGeneration,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    migrated,
  }
}

/**
 * Write a document atomically, enforcing schema version, generation and revision.
 *
 * @param {string} filePath absolute path
 * @param {object} body the document WITHOUT the envelope fields this function owns
 * @param {object} options
 * @param {string} options.kind label used in errors
 * @param {string} [options.expectedRevision] revision the caller based its change on; omit only
 *   when creating a document that must not exist yet
 * @param {boolean} [options.createOnly] fail when the file already exists
 * @param {Clock} [options.clock]
 * @returns {{ revision: string, sha256: string, bytes: number, durationMs: number }}
 */
export function writeDocument(filePath, body, options) {
  const kind = options.kind ?? 'document'
  const clock = options.clock ?? new Clock()
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError(`${kind} 必须是对象`, { kind })
  }

  const existing = fs.existsSync(filePath)
  if (options.createOnly === true && existing) {
    throw new ConflictError(`${kind} 已存在，拒绝覆盖`, { kind, stage: 'create-only' })
  }
  if (existing && options.expectedRevision !== undefined) {
    const current = readDocument(filePath, { kind, expectedGeneration: CURRENT_SCHEMA_GENERATION })
    if (current.revision !== options.expectedRevision) {
      // The exact conflict the contract names: read the latest, report it, do not overwrite.
      throw new ConflictError(`${kind} 已被其他写入者更新`, {
        kind,
        stage: 'revision',
        expectedRevision: options.expectedRevision,
        actualRevision: current.revision,
        action: '读取最新内容后基于当前版本重做，不覆盖他人新结果',
      })
    }
  }
  if (!existing && options.expectedRevision !== undefined && options.expectedRevision !== null) {
    throw new ConflictError(`${kind} 不存在，无法按既有修订写入`, {
      kind,
      stage: 'revision',
      expectedRevision: options.expectedRevision,
    })
  }

  const revision = nextRevision(options.expectedRevision ?? null, clock)
  const document = {
    ...body,
    schemaVersion: SCHEMA_VERSION[/** @type {keyof typeof SCHEMA_VERSION} */ (options.schemaKey ?? kind)] ?? 1,
    schemaGeneration: CURRENT_SCHEMA_GENERATION,
    revision,
    // Wall clock is legitimate metadata here; the Clock is injected so tests are deterministic.
    updatedAt: clock.iso(),
  }

  hitFault('project-store:before-write', `kind=${kind}`)
  const written = writeFileAtomic(filePath, `${stableStringify(document)}\n`)
  const verified = verifyReadBack(filePath, written.sha256, kind)
  return { revision, sha256: verified.sha256, bytes: verified.bytes, durationMs: written.durationMs }
}

/**
 * Re-read the published file and compare its hash.
 *
 * `writeFileAtomic` already verifies before and after publishing; this second check catches the
 * case where something else changed the file between the publish and this read.
 *
 * @param {string} filePath
 * @param {string} expectedSha256
 * @param {string} kind
 * @returns {{ sha256: string, bytes: number }}
 */
function verifyReadBack(filePath, expectedSha256, kind) {
  let bytes
  try {
    bytes = fs.readFileSync(filePath)
  } catch (error) {
    throw new IoError(`${kind} 写入后无法回读`, {
      details: { kind, stage: 'read-back', reason: error?.code ?? 'unknown' },
      cause: error,
    })
  }
  const actual = sha256(bytes)
  if (actual !== expectedSha256) {
    throw new IoError(`${kind} 写入后回读哈希不一致`, {
      details: { kind, stage: 'read-back', expected: expectedSha256, actual },
    })
  }
  return { sha256: actual, bytes: bytes.length }
}

/**
 * A monotonically increasing revision string.
 *
 * Readable AND ordered: `r<12-digit counter>-<8 hex>`. The counter makes ordering obvious to a
 * human reading evidence; the random suffix prevents two writers in the same millisecond from
 * inventing the same revision (which would defeat the conflict check that compares them).
 *
 * @param {string | null} previousRevision
 * @param {Clock} [clock]
 * @returns {string}
 */
export function nextRevision(previousRevision, clock) {
  const counter = revisionCounter(previousRevision)
  const suffix = Math.floor((clock?.now?.() ?? 0) % 0xffffffff)
    .toString(16)
    .padStart(8, '0')
    .slice(-8)
  return `r${String(counter + 1).padStart(12, '0')}-${suffix}`
}

/**
 * Extract the numeric part of a revision produced by {@link nextRevision}.
 * @param {string | null | undefined} revision
 * @returns {number}
 */
export function revisionCounter(revision) {
  if (typeof revision !== 'string') return 0
  const match = revision.match(/^r(\d{12})-[0-9a-f]{8}$/)
  if (!match) return 0
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : 0
}

/**
 * Fill in envelope defaults for a document read from disk and then re-written.
 * @param {any} document
 * @returns {any}
 */
export function stripEnvelope(document) {
  const clone = { ...document }
  delete clone.schemaVersion
  delete clone.schemaGeneration
  delete clone.revision
  delete clone.updatedAt
  return clone
}

/** @param {unknown} value @param {string} kind */
function normalizeVersion(value, kind) {
  if (value === undefined) return 1
  if (!Number.isInteger(value) || value < 1) {
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, `${kind} 的 schemaVersion 非法`, {
      details: { kind, schemaVersion: String(value) },
    })
  }
  return value
}

/** @param {unknown} value */
function normalizeGeneration(value) {
  if (value === undefined) return CURRENT_SCHEMA_GENERATION
  if (!Number.isInteger(value) || value < 0) return -1
  return value
}

/**
 * Read a document, returning `null` instead of throwing when it is simply absent.
 * Used by "does recovery information exist" style questions where absence is a normal answer.
 *
 * @param {string} filePath
 * @param {{ kind: string, expectedGeneration?: number }} options
 * @returns {StoredDocument | null}
 */
export function tryReadDocument(filePath, options) {
  if (!fs.existsSync(filePath)) return null
  return readDocument(filePath, { expectedGeneration: CURRENT_SCHEMA_GENERATION, ...options })
}

/**
 * The durability facts this module can honestly claim.
 *
 * Re-exported so a receipt or evidence file quotes the real limits instead of implying
 * "atomic" means "power-loss proof".
 */
export { DURABILITY_LIMITS }

/**
 * Hash of a file's content, for material identity.
 * @param {string} filePath
 * @returns {string}
 */
export function fileSha256(filePath) {
  const hash = sha256(fs.readFileSync(filePath))
  return hash
}

/**
 * Size in bytes of a file, or `-1` when it is absent.
 * @param {string} filePath
 * @returns {number}
 */
export function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size
  } catch {
    return -1
  }
}

/**
 * Whether a path is a readable regular file.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isReadableFile(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return false
    fs.accessSync(filePath, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Create a directory, reporting a real failure code instead of swallowing it.
 * @param {string} dirPath
 * @param {{ kind?: string }} [options]
 */
export function ensureDirectory(dirPath, options = {}) {
  try {
    fs.mkdirSync(dirPath, { recursive: true })
  } catch (error) {
    throw new IoError(`目录无法创建`, {
      details: { kind: options.kind ?? 'dir', reason: error?.code ?? 'unknown', base: path.basename(dirPath) },
      cause: error,
    })
  }
}

/** Re-exported so callers do not need to import `base` separately for JSON reads. */
export { readJson }
