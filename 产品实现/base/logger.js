/**
 * Structured logging with mandatory redaction.
 *
 * Contract (CT-12 §6): logs must not contain credentials, tokens, unrelated private content
 * or unnecessary real paths. Redaction is not optional here — it is applied by the logger
 * itself, so a caller cannot forget it. Every entry is one JSON object per line, which
 * survives crash-truncation and is diffable in evidence.
 *
 * @module base/logger
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRedactor } from './redact.js'
import { serializeError } from './errors.js'
import { Clock } from './determinism.js'

/**
 * Redact a message through a redactor instance.
 * Kept as a named helper so the envelope builder stays readable.
 * @param {{ redactString: (value: string) => string }} redactor
 * @param {unknown} message
 * @returns {string}
 */
function redactorSafe(redactor, message) {
  return redactor.redactString(String(message ?? ''))
}

/** Ordered severities; filtering keeps entries at or above the configured level. */
export const LogLevel = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
})

/**
 * @typedef {'trace'|'debug'|'info'|'warn'|'error'|'silent'} LogLevelName
 */

/**
 * A logger writing one JSON object per line.
 *
 * The logger never throws from a log call: a logging failure must not break a product
 * operation, but it is surfaced once through `onInternalError`.
 */
export class Logger {
  /**
   * @param {object} [options]
   * @param {LogLevelName} [options.level]
   * @param {string} [options.scope] logical module name written into every entry
   * @param {(line: string) => void} [options.sink] where lines go; defaults to stdout
   * @param {Record<string,string>} [options.pathRoots] placeholder -> absolute root
   * @param {Clock} [options.clock]
   * @param {Record<string, unknown>} [options.base] fields merged into every entry
   * @param {(error: unknown) => void} [options.onInternalError]
   */
  constructor(options = {}) {
    this.level = options.level ?? 'info'
    this.scope = options.scope ?? 'workbench'
    this.clock = options.clock ?? new Clock()
    this.base = options.base ?? {}
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`))
    this.onInternalError = options.onInternalError ?? ((error) => process.stderr.write(`logger failure: ${String(error)}\n`))
    this.redactor = createRedactor({ roots: options.pathRoots ?? {} })
    this.counts = { trace: 0, debug: 0, info: 0, warn: 0, error: 0 }
  }

  /** Create a child logger with extra base fields and an appended scope. */
  child(fields = {}, scopeSuffix) {
    const child = new Logger({
      level: this.level,
      scope: scopeSuffix ? `${this.scope}:${scopeSuffix}` : this.scope,
      sink: this.sink,
      clock: this.clock,
      base: { ...this.base, ...fields },
      onInternalError: this.onInternalError,
    })
    child.redactor = this.redactor
    child.counts = this.counts
    return child
  }

  /**
   * Write one entry.
   *
   * The envelope (`ts`/`level`/`scope`/`msg`) is written LAST so a caller-supplied field can
   * never forge or overwrite it. Without this, logging a request body such as
   * `{ level: 'error', msg: 'forged' }` would rewrite the entry's severity and text, and the
   * level counters shown to tests/evidence would disagree with what was actually logged.
   *
   * @param {LogLevelName} level
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  log(level, message, fields) {
    if (LogLevel[level] < LogLevel[this.level]) return
    try {
      const redactedFields = /** @type {Record<string, unknown>} */ (this.redactor.redact(fields ?? {}))
      const entry = {
        ...redactedFields,
        ...this.redactor.redact({ ...this.base }),
        // Envelope is authoritative: it wins over both base fields and caller fields.
        ts: this.clock.iso(),
        level,
        scope: this.scope,
        msg: String(redactorSafe(this.redactor, message)),
      }
      this.counts[level] += 1
      this.sink(JSON.stringify(entry))
    } catch (error) {
      this.onInternalError(error)
    }
  }

  trace(message, fields) { this.log('trace', message, fields) }
  debug(message, fields) { this.log('debug', message, fields) }
  info(message, fields) { this.log('info', message, fields) }
  warn(message, fields) { this.log('warn', message, fields) }

  /**
   * Log an error. The error is serialized (code/message/details) but `cause` and the raw
   * stack are excluded, because a stack can embed absolute paths and argument values.
   * @param {string} message
   * @param {unknown} [error]
   * @param {Record<string, unknown>} [fields]
   */
  error(message, error, fields) {
    const payload = { ...(fields ?? {}) }
    if (error !== undefined) {
      payload.error = serializeError(error, { redact: (value) => this.redactor.redact(value) })
    }
    this.log('error', message, payload)
  }
}

/**
 * A logger that writes JSON lines to a file, creating parents.
 * @param {string} filePath
 * @param {object} [options]
 */
export function createFileLogger(filePath, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })
  const logger = new Logger({ ...options, sink: (line) => stream.write(`${line}\n`) })
  logger.close = () => new Promise((resolve) => stream.end(resolve))
  return logger
}

/**
 * A logger that collects entries in memory. Used by tests to assert redaction happened.
 * @param {object} [options]
 */
export function createMemoryLogger(options = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const entries = []
  const logger = new Logger({
    ...options,
    sink: (line) => entries.push(JSON.parse(line)),
  })
  logger.entries = entries
  /** Concatenated raw output, so a test can search for a leaked secret in the bytes. */
  logger.dump = () => entries.map((entry) => JSON.stringify(entry)).join('\n')
  return logger
}

/** Create a logger that writes to nowhere; used where logging is optional. */
export function createNullLogger(options = {}) {
  return new Logger({ ...options, level: 'silent', sink: () => {} })
}
