/**
 * The tool-management log: one JSON object per line, redacted at the sink.
 *
 * Two things are being protected here:
 *
 * 1. **The user must not be asked to read this.** C06 §6 says results are shown at product level and
 *    logs stay technical ("不让用户审管理日志"). So this log is a diagnostic artifact for evidence and
 *    for a developer, not a UI surface.
 * 2. **The log must not leak.** Credentials, tokens, unrelated private content and unnecessary real
 *    paths are stripped by `base/redact.js` before a line is written (CT-12 §6). Redaction happens at
 *    the sink, so a caller cannot forget it.
 *
 * The log is append-only JSONL: a crash truncates at most the last line, and the file stays greppable.
 * It is written with a plain append rather than `writeFileAtomic`, because an atomic replace of an
 * append-only log would lose concurrent entries; the cost is that a torn final line is possible, which
 * the reader tolerates by skipping unparseable lines and counting them.
 *
 * @module tools/log
 */

import fs from 'node:fs'
import path from 'node:path'
import { Clock, createRedactor } from '../base/index.js'
import { TOOL_SCHEMA_VERSION } from './schema.js'

/** Bounded fields: a log entry must not become a second copy of the payload. */
const MAX_STRING = 500
const MAX_ARRAY = 50

/**
 * A redacted, append-only management log.
 */
export class ToolLog {
  /**
   * @param {string} filePath absolute path of the JSONL file
   * @param {{ clock?: Clock, pathRoots?: Record<string, string>, maxEntries?: number }} [options]
   */
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new TypeError('ToolLog 需要绝对路径')
    }
    this.filePath = filePath
    this.clock = options.clock ?? new Clock()
    this.redactor = createRedactor({ roots: options.pathRoots ?? {} })
    this.maxEntries = options.maxEntries ?? 0
    this.written = 0
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }

  /**
   * Append one entry.
   *
   * Catches its own I/O failure: a logging problem must never break an install that otherwise
   * succeeded, but the failure is counted so evidence can state that logging was incomplete.
   *
   * @param {object} entry
   * @returns {{ written: boolean, reason?: string }}
   */
  append(entry) {
    try {
      const sanitized = this.sanitize(entry)
      const record = {
        schemaVersion: TOOL_SCHEMA_VERSION.log,
        ts: this.clock.iso(),
        ...sanitized,
      }
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
      this.written += 1
      return { written: true }
    } catch (error) {
      this.ioFailure = error instanceof Error ? error.message : String(error)
      return { written: false, reason: 'log-write-failed' }
    }
  }

  /**
   * Bound and redact one entry so a payload cannot be smuggled into the log.
   * @param {unknown} entry
   * @returns {object}
   */
  sanitize(entry) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { event: 'invalid-entry', detail: String(entry).slice(0, MAX_STRING) }
    }
    const out = {}
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (entry))) {
      if (value === undefined) continue
      if (typeof value === 'string') {
        out[key] = value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING - 1)}…`
      } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        out[key] = value
      } else if (Array.isArray(value)) {
        out[key] = value.slice(0, MAX_ARRAY).map((item) => (typeof item === 'string' ? item.slice(0, MAX_STRING) : item))
      } else {
        // A nested object is stringified and bounded rather than stored: the log records events, not
        // documents, and an unbounded nested payload is how a secret reaches disk.
        out[key] = JSON.stringify(value).slice(0, MAX_STRING)
      }
    }
    return /** @type {object} */ (this.redactor.redact(out))
  }

  /**
   * Read back entries, skipping (and counting) any torn line.
   * @param {{ limit?: number }} [options]
   * @returns {{ entries: object[], skippedLines: number, total: number }}
   */
  read(options = {}) {
    if (!fs.existsSync(this.filePath)) return { entries: [], skippedLines: 0, total: 0 }
    const lines = fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0)
    let skippedLines = 0
    const entries = []
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        // A torn final line after a crash is expected and reported, never silently treated as absent.
        skippedLines += 1
      }
    }
    const limit = Number.isSafeInteger(options.limit) ? options.limit : entries.length
    return { entries: entries.slice(-limit), skippedLines, total: entries.length }
  }

  /** Count entries, without parsing every line. */
  size() {
    if (!fs.existsSync(this.filePath)) return 0
    return fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0).length
  }

  /**
   * Whether anything the log was asked to record failed to reach disk.
   * @returns {boolean}
   */
  hadIoFailure() {
    return typeof this.ioFailure === 'string'
  }
}

/**
 * Summarize a log for evidence, without dumping content.
 * @param {ToolLog} log
 * @returns {{ entries: number, skippedLines: number, ioFailure: boolean }}
 */
export function summarizeLog(log) {
  const read = log.read()
  return { entries: read.total, skippedLines: read.skippedLines, ioFailure: log.hadIoFailure() }
}
