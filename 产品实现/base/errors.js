/**
 * Stable error taxonomy for the AI video workbench.
 *
 * Rules that later cards must keep (see CT-12 / CT-04):
 * - every error carries a STABLE machine code, so UI and tests never match on message text;
 * - messages are written for a human and must never contain secrets or real absolute paths;
 * - `details` is a redacted bag; raw causes are kept on `cause` and are never serialized publicly;
 * - an error states whether it is retryable, because "状态未知不自动重试" is a product rule.
 *
 * @module base/errors
 */

/** Stable error codes. Adding a code is additive; renaming one is a breaking change. */
export const ErrorCode = Object.freeze({
  // input / validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  ABORTED: 'ABORTED',
  UNSUPPORTED: 'UNSUPPORTED',

  // security
  PATH_ESCAPE: 'PATH_ESCAPE',
  PATH_ABSOLUTE: 'PATH_ABSOLUTE',
  PATH_INVALID: 'PATH_INVALID',
  LINK_ESCAPE: 'LINK_ESCAPE',
  SECRET_EXPOSED: 'SECRET_EXPOSED',
  RESOURCE_LIMIT: 'RESOURCE_LIMIT',

  // storage / io
  IO_FAILED: 'IO_FAILED',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  CORRUPT_DATA: 'CORRUPT_DATA',

  // external
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  EXTERNAL_FAILED: 'EXTERNAL_FAILED',
  EXTERNAL_UNKNOWN: 'EXTERNAL_UNKNOWN',

  // internal
  INTERNAL: 'INTERNAL',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
})

const CODE_VALUES = new Set(Object.values(ErrorCode))

/** Base error for every workbench failure. */
export class WorkbenchError extends Error {
  /**
   * @param {string} code stable code from {@link ErrorCode}
   * @param {string} message human-readable, already free of secrets
   * @param {object} [options]
   * @param {object} [options.details] redacted, JSON-serializable context
   * @param {boolean} [options.retryable] whether an automatic retry is ever allowed
   * @param {unknown} [options.cause] original error; never serialized publicly
   */
  constructor(code, message, options = {}) {
    if (!CODE_VALUES.has(code)) {
      throw new TypeError(`unknown error code: ${String(code)}`)
    }
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.code = code
    this.details = options.details ?? {}
    this.retryable = options.retryable === true
    // Marks our own errors so callers can distinguish them from library throws.
    this.isWorkbenchError = true
  }
}

/** Invalid or missing caller input. Never retryable as-is. */
export class ValidationError extends WorkbenchError {
  constructor(message, details) {
    super(ErrorCode.VALIDATION_FAILED, message, { details })
  }
}

/** Requested object does not exist. */
export class NotFoundError extends WorkbenchError {
  constructor(message, details) {
    super(ErrorCode.NOT_FOUND, message, { details })
  }
}

/** State conflict (lock held, stale version, duplicate identity). */
export class ConflictError extends WorkbenchError {
  constructor(message, details) {
    super(ErrorCode.CONFLICT, message, { details })
  }
}

/** Cancelled by the user or by a caller-supplied signal. */
export class AbortedError extends WorkbenchError {
  constructor(message = '操作已取消', details) {
    super(ErrorCode.ABORTED, message, { details })
  }
}

/** A path, archive entry or link tried to leave its allowed root. */
export class SecurityError extends WorkbenchError {
  constructor(code, message, details) {
    super(code, message, { details })
  }
}

/** Filesystem failure that is not a security violation. */
export class IoError extends WorkbenchError {
  constructor(message, options = {}) {
    super(ErrorCode.IO_FAILED, message, options)
  }
}

/** An external tool, service or model failed. State may be unknown. */
export class ExternalError extends WorkbenchError {
  constructor(message, options = {}) {
    super(ErrorCode.EXTERNAL_FAILED, message, {
      details: options.details,
      cause: options.cause,
      // An external failure is only retryable when the caller proved it is safe.
      retryable: options.retryable === true,
    })
  }
}

/**
 * Serialize an error for logs, evidence and receipts.
 *
 * Never includes `cause`, the raw stack, or unredacted details. `redact` is injected
 * to keep this module free of a cycle with `base/redact`.
 *
 * @param {unknown} error
 * @param {object} [options]
 * @param {(value: unknown) => unknown} [options.redact] redaction function
 * @param {boolean} [options.includeStack]
 * @returns {{ name: string, code: string, message: string, retryable: boolean, details: object, stack?: string }}
 */
export function serializeError(error, options = {}) {
  const redact = options.redact ?? ((value) => value)
  const err = error instanceof Error ? error : new Error(String(error))
  const isOwn = err.isWorkbenchError === true
  const out = {
    name: err.name || 'Error',
    code: isOwn ? err.code : 'UNEXPECTED_ERROR',
    message: String(redact(err.message ?? '')),
    retryable: isOwn ? err.retryable === true : false,
    details: isOwn ? redact(err.details ?? {}) : {},
  }
  if (options.includeStack === true && typeof err.stack === 'string') {
    out.stack = String(redact(err.stack))
  }
  return out
}

/** Normalize any thrown value into a {@link WorkbenchError}. */
export function toWorkbenchError(error, fallbackCode = ErrorCode.INTERNAL) {
  if (error instanceof WorkbenchError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new WorkbenchError(fallbackCode, message, { cause: error })
}

/** Throws when `condition` is falsy. Used instead of `assert` for product-facing checks. */
export function invariant(condition, message, details) {
  if (!condition) throw new ValidationError(message, details)
}
