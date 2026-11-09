/**
 * Contract tests for the shared base facade.
 *
 * Later cards import ONLY `base/index.js`. These tests pin the exported surface so an internal
 * refactor cannot silently break a consumer, and pin the guarantees each export carries.
 *
 * @module tests/contract/base-api-contract.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as base from '../../base/index.js'

test('facade: exports the documented surface, and nothing undocumented', () => {
  const documented = new Set([
    // errors
    'ErrorCode', 'WorkbenchError', 'ValidationError', 'NotFoundError', 'ConflictError',
    'AbortedError', 'SecurityError', 'IoError', 'ExternalError', 'serializeError',
    'toWorkbenchError', 'invariant',
    // redact
    'REDACTED', 'DEFAULT_MAX_STRING', 'TRUNCATION_MARKER', 'SENSITIVE_KEY_SAMPLE',
    'isSensitiveKey', 'redactString', 'redactValue', 'createRedactor',
    'createPathRedactor', 'findSecrets',
    // paths
    'PathGuard', 'assertSafeRelativePath', 'assertNotLink', 'resolveRealPath', 'isInside',
    'ensureDir', 'MAX_SEGMENT_LENGTH',
    // atomic write
    'writeFileAtomic', 'writeJsonAtomic', 'readJson', 'sha256', 'sha256File',
    'deleteIfHashMatches', 'cleanStaleTempFiles', 'DURABILITY_LIMITS', 'TEMP_SUFFIX',
    // temp dir
    'TempDir', 'createTempDir', 'resolveTempRoot', 'findStaleTempDirs', 'isProcessAlive',
    'TEMP_PREFIX', 'MARKER_FILE',
    // determinism
    'Clock', 'startTimer', 'createSeededRandom', 'stableStringify', 'contentHash',
    'buildCacheKey', 'roundDeterministic', 'Rational', 'totalDurationFrames',
    // faults
    'FaultKind', 'WIRED_FAULT_KINDS', 'UNWIRED_FAULT_KINDS', 'FaultPlan', 'InjectedFault',
    'enableFaultInjection', 'disableFaultInjection', 'isFaultInjectionEnabled', 'faults',
    'hitFault', 'withFaultPlan', 'captureFailure',
    // logger
    'Logger', 'LogLevel', 'createFileLogger', 'createMemoryLogger', 'createNullLogger',
    // locks
    'LOCK_FORMAT_VERSION', 'DEFAULT_HEARTBEAT_MS', 'DEFAULT_STALE_AFTER_MS',
    'PROCESS_INSTANCE', 'FileLock', 'acquireLock', 'withLock', 'inspectLock',
    'requireLock', 'lockFileName', 'encodeScopeId', 'decodeScopeId',
  ])
  const actual = new Set(Object.keys(base))
  const missing = [...documented].filter((name) => !actual.has(name))
  const extra = [...actual].filter((name) => !documented.has(name) && name !== 'default')
  assert.deepEqual(missing, [], `缺少文档承诺的导出: ${missing.join(', ')}`)
  assert.deepEqual(extra, [], `出现未登记的导出: ${extra.join(', ')}`)
})

test('facade: every export is defined', () => {
  for (const [name, value] of Object.entries(base)) {
    if (name === 'default') continue
    assert.notEqual(value, undefined, `导出 ${name} 为 undefined`)
  }
})

test('ErrorCode: codes are unique, uppercase and stable strings', () => {
  const values = Object.values(base.ErrorCode)
  assert.equal(new Set(values).size, values.length, '错误码不得重复')
  for (const value of values) assert.match(value, /^[A-Z][A-Z_]*$/)
})

test('FaultKind: covers the faults CT-11 requires', () => {
  const required = ['DISK_FULL', 'PERMISSION_DENIED', 'FILE_BUSY', 'IO_ERROR', 'CRASH_MID_WRITE', 'STALE_LOCK']
  for (const name of required) {
    assert.ok(base.FaultKind[name], `缺少故障类型: ${name}`)
  }
})

test('LogLevel: severities are ordered', () => {
  assert.ok(base.LogLevel.trace < base.LogLevel.info)
  assert.ok(base.LogLevel.info < base.LogLevel.error)
})

test('DURABILITY_LIMITS: documents the real platform limitation', () => {
  assert.equal(typeof base.DURABILITY_LIMITS.directoryEntry, 'string')
  assert.match(base.DURABILITY_LIMITS.directoryEntry, /EPERM|not guaranteed/)
})

test('PathGuard: the constructor refuses a relative root, forcing explicit confinement', () => {
  assert.throws(() => new base.PathGuard('relative/root'), (error) => error.code === 'VALIDATION_FAILED')
})

test('writeFileAtomic: refuses a relative target so no implicit cwd write can happen', () => {
  assert.throws(() => base.writeFileAtomic('relative.txt', 'x'), (error) => error.code === 'IO_FAILED')
})

test('faults: injection is disabled by default in a normal process', () => {
  assert.equal(base.isFaultInjectionEnabled(), false)
  assert.equal(base.hitFault('anything'), undefined)
})

test('serializeError: a redacted serialization never carries a cause', () => {
  const error = new base.ExternalError('外部失败', { details: { stage: 'probe' }, cause: new Error('raw') })
  const serialized = base.serializeError(error)
  assert.equal(serialized.code, 'EXTERNAL_FAILED')
  assert.equal(serialized.cause, undefined)
  assert.equal(serialized.retryable, false)
})

test('Rational and totalDurationFrames: match the CT-04 examples', () => {
  assert.equal(base.totalDurationFrames([150, 150], [30]).frames, 270)
  assert.equal(new base.Rational(9, 1).toFrames(30, 1), 270)
})

test('createRedactor: the default redactor is usable without configured roots', () => {
  const redactor = base.createRedactor()
  const output = redactor.redactString('token=abcdef123456')
  assert.ok(output.includes(base.REDACTED))
})
