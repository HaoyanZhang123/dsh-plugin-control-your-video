/**
 * Public entry surface of the shared engineering base.
 *
 * This file is the ONLY supported import path for later cards (C10, C06, C11, C12, C13,
 * C14, C15). Importing `base/*.js` internals directly is allowed for tests but not for
 * product code, so an internal refactor never breaks a module that only used the facade.
 *
 * @module base/index
 */

export {
  ErrorCode,
  WorkbenchError,
  ValidationError,
  NotFoundError,
  ConflictError,
  AbortedError,
  SecurityError,
  IoError,
  ExternalError,
  serializeError,
  toWorkbenchError,
  invariant,
} from './errors.js'

export {
  REDACTED,
  DEFAULT_MAX_STRING,
  TRUNCATION_MARKER,
  isSensitiveKey,
  redactString,
  redactValue,
  createRedactor,
  createPathRedactor,
  findSecrets,
  SENSITIVE_KEY_SAMPLE,
} from './redact.js'

export {
  PathGuard,
  assertSafeRelativePath,
  assertNotLink,
  resolveRealPath,
  isInside,
  ensureDir,
  MAX_SEGMENT_LENGTH,
} from './paths.js'

export {
  writeFileAtomic,
  writeJsonAtomic,
  readJson,
  sha256,
  sha256File,
  deleteIfHashMatches,
  cleanStaleTempFiles,
  DURABILITY_LIMITS,
  TEMP_SUFFIX,
} from './atomic-write.js'

export {
  TempDir,
  createTempDir,
  resolveTempRoot,
  findStaleTempDirs,
  isProcessAlive,
  TEMP_PREFIX,
  MARKER_FILE,
} from './tempdir.js'

export {
  Clock,
  startTimer,
  createSeededRandom,
  stableStringify,
  contentHash,
  buildCacheKey,
  roundDeterministic,
  Rational,
  totalDurationFrames,
} from './determinism.js'

export {
  FaultKind,
  WIRED_FAULT_KINDS,
  UNWIRED_FAULT_KINDS,
  FaultPlan,
  InjectedFault,
  enableFaultInjection,
  disableFaultInjection,
  isFaultInjectionEnabled,
  faults,
  hitFault,
  withFaultPlan,
  captureFailure,
} from './faults.js'

export { Logger, LogLevel, createFileLogger, createMemoryLogger, createNullLogger } from './logger.js'

export {
  LOCK_FORMAT_VERSION,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STALE_AFTER_MS,
  PROCESS_INSTANCE,
  FileLock,
  acquireLock,
  withLock,
  inspectLock,
  requireLock,
  lockFileName,
  encodeScopeId,
  decodeScopeId,
} from './locks.js'
