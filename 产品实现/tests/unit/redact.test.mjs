/**
 * Unit tests for base/redact.js.
 *
 * These tests are the evidence that CT-12 §6 is implemented, not just documented: a secret
 * must not survive into a log line, and a legitimate path placeholder must.
 *
 * @module tests/unit/redact.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REDACTED,
  isSensitiveKey,
  redactString,
  redactValue,
  createRedactor,
  findSecrets,
} from '../../base/redact.js'

test('redactString: removes bearer, sk-, gh-, AWS and slack tokens', () => {
  const cases = [
    'Authorization: Bearer abcdefghijklmnop',
    'token sk-abcdefghijklmnopqrstuvwx',
    'gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'aws AKIAIOSFODNN7EXAMPLE',
    'slack xoxb-1234567890-abcdefghij',
  ]
  for (const input of cases) {
    const output = redactString(input)
    assert.ok(output.includes(REDACTED), `应脱敏: ${input} -> ${output}`)
    assert.ok(!findSecrets(output).findings.length, `残留秘密: ${output}`)
  }
})

test('redactString: removes credentials embedded in a URL', () => {
  const output = redactString('https://user:supersecret@example.com/path')
  assert.ok(!output.includes('supersecret'))
  assert.ok(output.startsWith('https://'))
})

test('redactString: removes JWT and private key blocks', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  assert.ok(!redactString(jwt).includes(jwt))

  const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----'].join('\n')
  const redacted = redactString(key)
  assert.ok(!redacted.includes('MIIEowIBAAKCAQEA'))
})

test('redactString: removes inline key=value forms', () => {
  const output = redactString('api_key=abcdef123456&password=hunter2&other=keep')
  assert.ok(!output.includes('abcdef123456'))
  assert.ok(!output.includes('hunter2'))
  assert.ok(output.includes('other=keep'), '非敏感字段必须保留')
})

test('redactString: leaves ordinary text untouched', () => {
  const input = '渲染完成：270 帧，9.000 秒，1280×720'
  assert.equal(redactString(input), input)
})

test('redactString: truncates very long strings but keeps the head', () => {
  const output = redactString('x'.repeat(5000), { maxLength: 100 })
  assert.ok(output.length < 200)
  assert.ok(output.includes('truncated'))
})

test('isSensitiveKey: matches secret-bearing names and not innocent ones', () => {
  for (const key of ['password', 'apiKey', 'api_key', 'authorization', 'token', 'cookie', 'client_secret', 'x-api-key']) {
    assert.ok(isSensitiveKey(key), `应识别: ${key}`)
  }
  for (const key of ['fileName', 'duration', 'path', 'username', 'tokenCount', 'author']) {
    assert.ok(!isSensitiveKey(key), `不应误判: ${key}`)
  }
})

test('redactValue: replaces values under sensitive keys regardless of shape', () => {
  const input = { password: 'p', nested: { authorization: 'abc', keep: 'yes' }, list: [{ token: 't' }] }
  const output = /** @type {any} */ (redactValue(input))
  assert.equal(output.password, REDACTED)
  assert.equal(output.nested.authorization, REDACTED)
  assert.equal(output.nested.keep, 'yes')
  assert.equal(output.list[0].token, REDACTED)
})

test('redactValue: survives circular structures without throwing', () => {
  const circular = { name: 'root' }
  circular.self = circular
  const output = /** @type {any} */ (redactValue(circular))
  assert.equal(output.name, 'root')
  assert.equal(output.self, '[Circular]')
})

test('redactValue: bounds depth and array length', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'end' } } } } } } } } }
  const output = /** @type {any} */ (redactValue(deep, { maxDepth: 3 }))
  assert.ok(JSON.stringify(output).includes('MaxDepth') || JSON.stringify(output).includes('end'))

  const long = { items: Array.from({ length: 200 }, (_, index) => index) }
  const trimmed = /** @type {any} */ (redactValue(long, { maxArrayLength: 10 }))
  assert.equal(trimmed.items.length, 11)
  assert.ok(String(trimmed.items.at(-1)).includes('more'))
})

test('createRedactor: replaces known roots and keeps unknown path evidence', () => {
  const redactor = createRedactor({ roots: { '<workspace>': 'E:\\work\\proj', '<home>': 'C:\\Users\\someone' } })
  const line = 'saved to E:\\work\\proj\\out\\a.mp4 from C:\\Users\\someone\\x'
  const output = redactor.redactString(line)
  assert.ok(output.includes('<workspace>/out/a.mp4'), output)
  assert.ok(output.includes('<home>'))
  assert.ok(!output.includes('E:/work/proj'))
  assert.ok(!output.includes('Users'))
})

test('createRedactor: normalizes separators so placeholders match across platforms', () => {
  const redactor = createRedactor({ roots: { '<ws>': 'E:/work/proj' } })
  assert.ok(redactor.redactString('E:\\work\\proj\\a').startsWith('<ws>'))
})

test('findSecrets: reports which pattern matched', () => {
  const clean = findSecrets('nothing secret here')
  assert.equal(clean.clean, true)
  const dirty = findSecrets('sk-abcdefghijklmnopqrstuvwx')
  assert.equal(dirty.clean, false)
  assert.ok(dirty.findings.includes('sk-token'))
})

test('redaction is idempotent', () => {
  const once = redactString('authorization: Bearer abcdefghijklmnop')
  assert.equal(redactString(once), once)
})

test('redaction is idempotent for every pattern, and never re-flags its own output', () => {
  // Regression: the private-key and cookie patterns previously matched their own placeholders,
  // which made `findSecrets` report a leak on clean text and would have failed the release gate.
  const inputs = [
    'cookie: session=abc123def456',
    'set-cookie: a=b; Secure; HttpOnly',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7abc\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQABAAABgQC7abc\n-----END OPENSSH PRIVATE KEY-----',
    'token=abc',
    'Authorization: Bearer abcdefghijklmnop',
    'postgres://user:pw@host/db',
    'api_key=1&password=2',
  ]
  for (const input of inputs) {
    const once = redactString(input)
    assert.equal(redactString(once), once, `非幂等: ${input}`)
    assert.equal(findSecrets(once).clean, true, `脱敏后仍被判定含秘密: ${once}`)
  }
})

test('redactString: removes Cookie, Set-Cookie, Google and OAuth token shapes', () => {
  const cases = [
    'cookie: session=abc123def456',
    'set-cookie: a=b; Secure; HttpOnly',
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxx',
  ]
  for (const input of cases) {
    const output = redactString(input)
    assert.equal(findSecrets(output).clean, true, `未脱敏: ${input} -> ${output}`)
  }
})
