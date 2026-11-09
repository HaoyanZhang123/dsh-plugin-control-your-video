/**
 * Atomic, durable, verified file replacement.
 *
 * Contract (CT-02 §3): write a temporary file on the SAME filesystem, verify it can be read
 * back, flush it, then publish by atomic rename — and keep the previous version if anything
 * fails. `writeFileAtomic` alone is not enough because it does not fsync (C01 fact), so this
 * module performs the fsync itself.
 *
 * Measured platform facts (Windows, Node 24.22.1, C04):
 * - `fs.renameSync` replaces an existing target atomically — used as the publish step;
 * - `fs.renameSync` over a READ-ONLY target fails EPERM — so a read-only target is reported,
 *   never silently deleted;
 * - `fsync` on a FILE handle works; `fsync` on a DIRECTORY handle fails EPERM — therefore
 *   directory-entry durability is NOT claimed on Windows and is recorded as a known limit.
 *
 * @module base/atomic-write
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { IoError } from './errors.js'
import { hitFault } from './faults.js'

/** Suffix for in-flight temporary files; never a published name. */
export const TEMP_SUFFIX = '.tmp-write'

/** How many times a transient rename failure is retried (Windows file-lock contention). */
const RENAME_RETRIES = 5
const RENAME_RETRY_DELAY_MS = 40

/**
 * SHA-256 of a buffer or of a file's bytes.
 * Uses `node:crypto` directly because the Host has no generic hash service (CT-02 §5).
 *
 * @param {Buffer|string|Uint8Array} input
 * @returns {string} lowercase hex digest
 */
export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let read
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * A deterministic temp name: same target + same process => same prefix, unique via counter.
 * Randomness is intentional here (a temp name is not a product artifact), but the published
 * file content is never random.
 *
 * @param {string} target absolute path being written
 * @returns {string}
 */
function tempPathFor(target) {
  const dir = path.dirname(target)
  const base = path.basename(target)
  const nonce = crypto.randomBytes(6).toString('hex')
  return path.join(dir, `.${base}.${process.pid}.${nonce}${TEMP_SUFFIX}`)
}

/** Sleep synchronously without a dependency; only used for tiny retry backoff. */
function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4)
  const view = new Int32Array(shared)
  Atomics.wait(view, 0, 0, ms)
}

/**
 * Rename with a few retries for TRANSIENT Windows sharing violations only.
 *
 * `EBUSY` (and `EPERM` when the target is not read-only) indicate another process briefly holds
 * the file, which can clear on its own. `EACCES` means permission was denied and will NOT clear
 * by waiting, so retrying it only delays the real error and masks a genuine "read-only target"
 * condition — the module's own contract says a read-only target must fail rather than be
 * decided by contention retries.
 *
 * @param {string} from
 * @param {string} to
 */
function renameWithRetry(from, to) {
  let lastError
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      lastError = error
      const code = error?.code
      const transient = code === 'EBUSY' || (code === 'EPERM' && !isReadOnly(to))
      if (!transient) throw error
      sleepSync(RENAME_RETRY_DELAY_MS * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * Whether an existing path is read-only, i.e. `EPERM` will not clear by waiting.
 * A missing target is not read-only: creating it is allowed.
 * @param {string} target
 * @returns {boolean}
 */
function isReadOnly(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK)
    return false
  } catch (error) {
    // ENOENT means "no existing file to replace", so it is not a read-only condition.
    return error?.code === 'EPERM' || error?.code === 'EACCES'
  }
}

/**
 * Write bytes atomically and durably, then read back and verify.
 *
 * @param {string} target absolute path
 * @param {string|Buffer|Uint8Array} data
 * @param {object} [options]
 * @param {string} [options.expectedSha256] verify an exact content hash before publishing
 * @param {boolean} [options.keepTempOnFailure] keep the temp file as evidence (never published)
 * @returns {{ path: string, bytes: number, sha256: string, durationMs: number }}
 */
export function writeFileAtomic(target, data, options = {}) {
  const started = performance.now()
  if (!path.isAbsolute(target)) {
    throw new IoError('writeFileAtomic 需要绝对路径', { details: { reason: 'relative-path' } })
  }
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  const expected = options.expectedSha256
  const actualSha = sha256(buffer)
  if (expected !== undefined && expected.toLowerCase() !== actualSha) {
    throw new IoError('写入前的内容哈希与声明不一致', {
      details: { expected, actual: actualSha, stage: 'pre-write' },
    })
  }

  const directory = path.dirname(target)
  fs.mkdirSync(directory, { recursive: true })
  const temp = tempPathFor(target)
  let published = false

  // Real seams for fault injection: a test can make the write fail at the exact point a
  // disk-full or permission error would occur, and then assert the old file survived.
  hitFault('atomic-write:before-write', `target=${path.basename(target)}`)

  try {
    const fd = fs.openSync(temp, 'wx')
    try {
      hitFault('atomic-write:during-write', `target=${path.basename(target)}`)
      let offset = 0
      while (offset < buffer.length) {
        offset += fs.writeSync(fd, buffer, offset, buffer.length - offset, null)
      }
      // Durability of the CONTENT is ours to guarantee; writeFileAtomic does not fsync.
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    // Genuine torn-write seam: bytes ARE on disk in the temp file at this point, but nothing
    // has been published. A crash here must leave the target intact and the temp diagnosable.
    hitFault('atomic-write:after-write-before-verify', `target=${path.basename(target)}`)

    // Read back before publishing: a truncated or unreadable temp must never replace good data.
    const readBack = fs.readFileSync(temp)
    const readBackSha = sha256(readBack)
    if (readBackSha !== actualSha) {
      throw new IoError('临时文件回读哈希不一致', {
        details: { stage: 'read-back', expected: actualSha, actual: readBackSha },
      })
    }

    hitFault('atomic-write:before-rename', `target=${path.basename(target)}`)
    renameWithRetry(temp, target)
    published = true

    // Verify the published path, not just the temp: this is what callers will read.
    const finalSha = sha256File(target)
    if (finalSha !== actualSha) {
      throw new IoError('发布后文件哈希不一致', {
        details: { stage: 'post-publish', expected: actualSha, actual: finalSha },
      })
    }

    return { path: target, bytes: buffer.length, sha256: actualSha, durationMs: performance.now() - started }
  } finally {
    if (!published && options.keepTempOnFailure !== true) {
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // Leaving a stray temp file is not worth masking the original failure.
      }
    }
  }
}

/**
 * Write JSON with a stable, reviewable layout (2-space indent + trailing newline).
 * Determinism matters for evidence files that must be comparable across runs.
 *
 * @param {string} target
 * @param {unknown} value
 * @param {{ sortKeys?: boolean }} [options]
 */
export function writeJsonAtomic(target, value, options = {}) {
  const text = `${JSON.stringify(value, options.sortKeys === false ? undefined : null, 2)}\n`
  return writeFileAtomic(target, text)
}

/**
 * Read and parse JSON, converting a parse failure into a stable error.
 * @param {string} filePath
 * @returns {unknown}
 */
export function readJson(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new IoError('读取文件失败', { details: { stage: 'read' }, cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new IoError('JSON 解析失败', {
      details: { stage: 'parse', size: text.length },
      retryable: false,
      cause: error,
    })
  }
}

/**
 * Delete a file only when it matches an expected hash.
 *
 * Used for "clean only what we can prove is ours", so a mistaken clean cannot remove a
 * file the user still needs.
 *
 * @param {string} filePath
 * @param {string} expectedSha256
 * @returns {boolean} true when deleted
 */
export function deleteIfHashMatches(filePath, expectedSha256) {
  if (!fs.existsSync(filePath)) return false
  const actual = sha256File(filePath)
  if (actual !== expectedSha256) return false
  fs.rmSync(filePath, { force: true })
  return true
}

/**
 * Remove leftover temp files whose owning process is no longer alive.
 *
 * A temp file name encodes the owning PID (`.<name>.<pid>.<nonce>.tmp-write`). Deleting every
 * `*.tmp-write` would let one process destroy another WRITER'S in-flight temp file, which is a
 * data-loss bug disguised as cleanup. So:
 * - a temp file whose PID is alive is LEFT ALONE (it may be mid-write);
 * - a temp file whose PID is dead or unparseable is removable;
 * - `{ includeLive: true }` is required to override this, and exists only for tests.
 *
 * @param {string} directory
 * @param {{ includeLive?: boolean }} [options]
 * @returns {{ removed: number, keptLive: number, removedNames: string[] }}
 */
export function cleanStaleTempFiles(directory, options = {}) {
  /** @type {string[]} */
  const removedNames = []
  let keptLive = 0
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return { removed: 0, keptLive: 0, removedNames }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(TEMP_SUFFIX)) continue
    const ownerPid = pidFromTempName(entry.name)
    const alive = ownerPid !== null && isProcessAlive(ownerPid)
    if (alive && options.includeLive !== true) {
      keptLive += 1
      continue
    }
    try {
      fs.rmSync(path.join(directory, entry.name), { force: true })
      removedNames.push(entry.name)
    } catch {
      // A temp file held open by another process is not our failure to force.
    }
  }
  return { removed: removedNames.length, keptLive, removedNames }
}

/**
 * Extract the owning PID from a temp file name.
 * @param {string} name e.g. `.state.json.12345.ab12cd.tmp-write`
 * @returns {number | null}
 */
function pidFromTempName(name) {
  const match = name.match(/\.(\d+)\.[0-9a-f]+\.tmp-write$/)
  if (!match) return null
  const pid = Number(match[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Whether a PID is currently running.
 * Duplicated deliberately from tempdir.js to keep atomic-write.js free of that dependency.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Known limitation, exported so evidence and receipts can state it honestly. */
export const DURABILITY_LIMITS = Object.freeze({
  fileContent: 'fsync applied to the file handle before publish',
  directoryEntry: 'not guaranteed on Windows: fsync on a directory handle fails EPERM (measured)',
  publish: 'atomic rename within the same directory/filesystem',
  crossDevice: 'a temp file is always created beside the target, so rename never crosses devices',
})
