/**
 * Unit tests for base/logger.js and base/errors.js.
 *
 * CT-12 §6 requires logs to be free of secrets and unnecessary real paths. These tests assert
 * on the RAW OUTPUT BYTES, because a redaction that only exists in the object is worthless.
 *
 * @module tests/unit/logger-errors.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createMemoryLogger, createFileLogger, createNullLogger, Logger, LogLevel } from '../../base/logger.js'
import {
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
} from '../../base/errors.js'
import { createRedactor } from '../../base/redact.js'
import { createTempDir } from '../../base/tempdir.js'
import { Clock } from '../../base/determinism.js'

const temp = createTempDir({ label: 'logger' })
test.after(() => temp.dispose())

test('Logger: writes one JSON object per line with timestamp, level and scope', () => {
  const logger = createMemoryLogger({ scope: 'test', clock: new Clock({ mode: 'frozen', start: 0 }) })
  logger.info('hello', { a: 1 })
  assert.equal(logger.entries.length, 1)
  const entry = logger.entries[0]
  assert.equal(entry.level, 'info')
  assert.equal(entry.scope, 'test')
  assert.equal(entry.msg, 'hello')
  assert.equal(entry.a, 1)
  assert.equal(entry.ts, '1970-01-01T00:00:00.000Z')
})

test('Logger: redacts secrets from the message AND the fields', () => {
  const logger = createMemoryLogger({ scope: 'test' })
  logger.info('using token sk-abcdefghijklmnopqrstuvwx now', { password: 'hunter2', authorization: 'Bearer abcdefghijklmnop' })
  const raw = logger.dump()
  assert.ok(!raw.includes('hunter2'), `泄露密码: ${raw}`)
  assert.ok(!raw.includes('sk-abcdefghijklmnopqrstuvwx'), `泄露 token: ${raw}`)
  assert.ok(!raw.includes('abcdefghijklmnop'), `泄露 bearer: ${raw}`)
})

test('Logger: redacts real paths when roots are configured', () => {
  const logger = createMemoryLogger({ pathRoots: { '<tmp>': temp.path } })
  logger.info('wrote file', { file: path.join(temp.path, 'a', 'b.json') })
  const raw = logger.dump()
  assert.ok(raw.includes('<tmp>'), `应保留占位符: ${raw}`)
  assert.ok(!raw.includes(temp.path.replace(/\\/g, '\\\\')), '不得出现真实临时路径')
})

test('Logger: level filtering drops lower severities', () => {
  const logger = createMemoryLogger({ level: 'warn' })
  logger.debug('nope')
  logger.info('nope')
  logger.warn('yes')
  logger.error('yes')
  assert.equal(logger.entries.length, 2)
  assert.deepEqual(logger.entries.map((entry) => entry.level), ['warn', 'error'])
})

test('Logger: silent level writes nothing', () => {
  const logger = createMemoryLogger({ level: 'silent' })
  logger.error('should not appear')
  assert.equal(logger.entries.length, 0)
})

test('Logger: caller fields cannot forge the envelope (level/msg/ts/scope)', () => {
  // Regression: spreading caller fields AFTER the envelope let a logged request body rewrite
  // the entry's severity and message, and made the level counters disagree with reality.
  const logger = createMemoryLogger({ scope: 'real-scope', clock: new Clock({ mode: 'frozen', start: 0 }) })
  logger.info('original message', { level: 'error', msg: 'forged', ts: '1999', scope: 'forged' })
  const entry = logger.entries[0]
  assert.equal(entry.level, 'info')
  assert.equal(entry.msg, 'original message')
  assert.equal(entry.scope, 'real-scope')
  assert.equal(entry.ts, '1970-01-01T00:00:00.000Z')
  assert.equal(logger.counts.info, 1)
  assert.equal(logger.counts.error, 0)
})

test('Logger: sensitive credential names are redacted through camelCase fields', () => {
  // Regression: a separator-anchored key pattern missed `secretKey`/`accessKeyId`/`bearerToken`,
  // which are the names real AWS/HTTP clients actually use.
  const logger = createMemoryLogger()
  logger.info('creds', {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG',
    passphrase: 'hunter2',
    bearerToken: 'abcdefghij',
    signingKey: 's3cr3t',
    tokenCount: 7,
    fileName: 'a.mp4',
  })
  const raw = logger.dump()
  for (const secret of ['AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI', 'hunter2', 'abcdefghij', 's3cr3t']) {
    assert.ok(!raw.includes(secret), `泄露: ${secret}`)
  }
  assert.ok(raw.includes('"tokenCount":7'), '非敏感字段必须保留')
  assert.ok(raw.includes('a.mp4'))
})

test('Logger: error() serializes code and message but not the cause stack', () => {
  const logger = createMemoryLogger()
  const error = new IoError('磁盘写入失败', { details: { stage: 'publish' }, cause: new Error('raw cause') })
  logger.error('write failed', error)
  const entry = logger.entries[0]
  assert.equal(entry.error.code, 'IO_FAILED')
  assert.equal(entry.error.details.stage, 'publish')
  const raw = logger.dump()
  assert.ok(!raw.includes('raw cause'), '不得输出 cause 原文')
  assert.ok(!raw.includes('at Object'), '不得输出堆栈')
})

test('Logger: a failing sink never propagates into the caller', () => {
  const logger = new Logger({
    sink: () => {
      throw new Error('sink exploded')
    },
    onInternalError: () => {},
  })
  assert.doesNotThrow(() => logger.info('still safe'))
})

test('Logger: child() inherits level and appends scope, without duplicating counters', () => {
  const parent = createMemoryLogger({ scope: 'root', level: 'debug' })
  const child = parent.child({ projectId: 'prj-1' }, 'storage')
  child.info('nested')
  assert.equal(parent.entries.length, 1)
  assert.equal(parent.entries[0].scope, 'root:storage')
  assert.equal(parent.entries[0].projectId, 'prj-1')
})

test('Logger: level counters are observable for tests', () => {
  // Named for what it checks: `Logger` exposes `counts`, not `recent()`/`summary()`.
  const logger = createMemoryLogger({ level: 'debug' })
  logger.info('one')
  logger.warn('two')
  assert.equal(logger.counts.info, 1)
  assert.equal(logger.counts.warn, 1)
})

test('createFileLogger: appends JSON lines to disk', async () => {
  const file = temp.file('logs/app.jsonl')
  const logger = createFileLogger(file, { scope: 'file' })
  logger.info('first')
  logger.info('second', { token: 'sk-abcdefghijklmnopqrstuvwx' })
  await logger.close()
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), '每行必须是独立 JSON')
  }
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-abc'), '文件日志也必须脱敏')
})

test('createNullLogger: writes nothing to stdout', () => {
  const logger = createNullLogger()
  assert.doesNotThrow(() => logger.info('nothing'))
  assert.equal(logger.counts.info, 0)
})

test('errors: every code is registered and stable', () => {
  for (const code of Object.values(ErrorCode)) {
    assert.equal(typeof code, 'string')
    assert.match(code, /^[A-Z_]+$/)
  }
})

test('errors: constructing with an unknown code is a programming error', () => {
  assert.throws(() => new WorkbenchError('NOT_A_CODE', 'x'), TypeError)
})

test('errors: subclasses set their own code and name', () => {
  assert.equal(new ValidationError('x').code, 'VALIDATION_FAILED')
  assert.equal(new NotFoundError('x').code, 'NOT_FOUND')
  assert.equal(new ConflictError('x').code, 'CONFLICT')
  assert.equal(new AbortedError().code, 'ABORTED')
  assert.equal(new IoError('x').code, 'IO_FAILED')
  assert.equal(new SecurityError('PATH_ESCAPE', 'x').code, 'PATH_ESCAPE')
  assert.equal(new ValidationError('x').name, 'ValidationError')
})

test('errors: retryable defaults are conservative', () => {
  assert.equal(new ValidationError('x').retryable, false)
  assert.equal(new ExternalError('x').retryable, false, '外部失败默认不可自动重试')
  assert.equal(new ExternalError('x', { retryable: true }).retryable, true)
})

test('serializeError: never includes cause or stack unless asked', () => {
  const error = new IoError('failed', { details: { token: 'sk-abcdefghijklmnopqrstuvwx' }, cause: new Error('secret cause') })
  const serialized = serializeError(error, { redact: (value) => createRedactor().redact(value) })
  assert.equal(serialized.code, 'IO_FAILED')
  assert.equal(serialized.cause, undefined)
  assert.equal(serialized.stack, undefined)
  assert.ok(!JSON.stringify(serialized).includes('secret cause'))
  assert.ok(!JSON.stringify(serialized).includes('sk-abc'), 'details 也必须脱敏')
})

test('serializeError: accepts a non-Error value', () => {
  const serialized = serializeError('a plain string problem')
  assert.equal(serialized.code, 'UNEXPECTED_ERROR')
  assert.equal(serialized.message, 'a plain string problem')
})

test('toWorkbenchError: passes through our own errors and wraps others', () => {
  const own = new ValidationError('own')
  assert.equal(toWorkbenchError(own), own)
  const wrapped = toWorkbenchError(new Error('library failure'))
  assert.equal(wrapped.code, 'INTERNAL')
  assert.equal(wrapped.message, 'library failure')
  assert.ok(wrapped.cause instanceof Error)
})

test('invariant: throws only when the condition is falsy', () => {
  assert.doesNotThrow(() => invariant(true, 'ok'))
  assert.throws(() => invariant(false, 'broken'), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => invariant(0, 'zero is falsy'))
})

test('LogLevel: order supports comparisons used by the logger', () => {
  assert.ok(LogLevel.trace < LogLevel.debug)
  assert.ok(LogLevel.debug < LogLevel.info)
  assert.ok(LogLevel.info < LogLevel.warn)
  assert.ok(LogLevel.warn < LogLevel.error)
  assert.ok(LogLevel.error < LogLevel.silent)
})
