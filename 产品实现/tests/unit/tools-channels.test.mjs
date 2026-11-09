/**
 * Unit tests for the ToolExecutionProtocol channel layer (CT-14 §3).
 *
 * The behaviours tested are the ones CT-14 makes mandatory: read the real declaration, prefer the
 * structured route, refuse arbitrary code when a structured route exists, and treat a schema change
 * after a tool update as a re-verification trigger rather than as "same tool name, same status".
 *
 * @module tests/unit/tools-channels.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beginExecution,
  describeChannel,
  endExecution,
  fingerprintChange,
  normalizeChannel,
  resolveExecutionRoute,
  schemaFingerprint,
} from '../../tools/channels.js'
import { assertPermissions } from '../../tools/channels.js'

test('channels: a CLI declaration needs an entrypoint and at least one permission', () => {
  assert.throws(() => normalizeChannel({ kind: 'cli', permissions: ['process'] }), (error) => {
    return error.code === 'VALIDATION_FAILED'
  })
  const declaration = normalizeChannel({ kind: 'cli', entrypoint: 'ffmpeg', permissions: ['process', 'media'] })
  assert.equal(declaration.structured, false)
  assert.deepEqual(declaration.permissions, ['process', 'media'])
})

test('channels: an MCP declaration needs a serverName and counts as structured', () => {
  assert.throws(() => normalizeChannel({ kind: 'mcp', permissions: ['network'] }), (error) => {
    return error.code === 'VALIDATION_FAILED'
  })
  const declaration = normalizeChannel({ kind: 'mcp', serverName: 'blender', permissions: ['network', 'process'] })
  assert.equal(declaration.structured, true)
  assert.equal(declaration.serverName, 'blender')
})

test('channels: an IPC declaration needs an endpoint', () => {
  assert.throws(() => normalizeChannel({ kind: 'ipc', permissions: ['process'] }), (error) => {
    return error.code === 'VALIDATION_FAILED'
  })
  const declaration = normalizeChannel({ kind: 'ipc', socketPath: 'pipe', permissions: ['process'] })
  assert.equal(declaration.structured, true)
})

test('channels: a declaration that lists no permission is refused rather than assumed harmless', () => {
  assert.throws(() => normalizeChannel({ kind: 'cli', entrypoint: 'x', permissions: [] }), (error) => {
    return error.code === 'VALIDATION_FAILED'
  })
})

test('channels: a permission the declaration does not include cannot be used at the call site', () => {
  const declaration = normalizeChannel({ kind: 'cli', entrypoint: 'ffmpeg', permissions: ['process'] })
  assert.equal(assertPermissions(declaration, ['process']).ok, true)
  assert.throws(() => assertPermissions(declaration, ['filesystem']), (error) => {
    assert.equal(error.code, 'VALIDATION_FAILED')
    assert.deepEqual(error.details.missing, ['filesystem'])
    return true
  })
})

test('channels: arbitrary code is refused when a structured route exists', () => {
  const structured = normalizeChannel({ kind: 'mcp', serverName: 'blender', permissions: ['process'] })
  const route = resolveExecutionRoute({ channel: structured, wantsArbitraryCode: false })
  assert.equal(route.route, 'structured')

  assert.throws(
    () => resolveExecutionRoute({ channel: structured, wantsArbitraryCode: true }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('channels: arbitrary code on a non-structured channel needs a CT-12 authorization', () => {
  const cli = normalizeChannel({ kind: 'cli', entrypoint: 'render', permissions: ['process'] })
  assert.throws(
    () => resolveExecutionRoute({ channel: cli, wantsArbitraryCode: true }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  const authorized = resolveExecutionRoute({
    channel: cli,
    wantsArbitraryCode: true,
    codeAuthorizationId: 'auth-code-1',
  })
  assert.equal(authorized.route, 'arbitrary-code')
  assert.match(authorized.reason, /auth-code-1/)
})

test('channels: the schema fingerprint is stable for the same shape and changes with a schema change', () => {
  const description = {
    version: '0.9.19',
    tools: [
      { name: 'render', inputSchema: { type: 'object', properties: { fps: { type: 'number' } } } },
      { name: 'probe', inputSchema: { type: 'object', properties: {} } },
    ],
    capabilities: ['render', 'probe'],
  }
  const first = schemaFingerprint(description)
  const same = schemaFingerprint(description)
  assert.equal(first.fingerprint, same.fingerprint)

  // Reordering the tool list must NOT change the fingerprint: the shape is what matters.
  const reordered = schemaFingerprint({ ...description, tools: [description.tools[1], description.tools[0]] })
  assert.equal(reordered.fingerprint, first.fingerprint)

  // A schema change MUST change it.
  const changed = schemaFingerprint({
    version: '0.9.19',
    tools: [
      { name: 'render', inputSchema: { type: 'object', properties: { fps: { type: 'string' } } } },
      description.tools[1],
    ],
    capabilities: ['render', 'probe'],
  })
  assert.notEqual(changed.fingerprint, first.fingerprint)
})

test('channels: a version bump alone changes the fingerprint, because capability drift can come with it', () => {
  const base = { version: '1.0.0', tools: [{ name: 'a', inputSchema: {} }] }
  const bumped = { version: '1.1.0', tools: [{ name: 'a', inputSchema: {} }] }
  assert.notEqual(schemaFingerprint(base).fingerprint, schemaFingerprint(bumped).fingerprint)
})

test('channels: fingerprintChange reports "must re-verify" when it changed or was never recorded', () => {
  assert.equal(fingerprintChange('abc', 'abc').changed, false)
  assert.equal(fingerprintChange('abc', 'def').changed, true)
  assert.match(fingerprintChange('abc', 'def').reason, /重新验证/)
  assert.equal(fingerprintChange(null, 'def').changed, true)
  // No description read this time is NOT evidence of a change; it just cannot be compared.
  assert.equal(fingerprintChange('abc', null).changed, false)
})

test('channels: an execution envelope cannot claim success without a real read-back', () => {
  const envelope = beginExecution({ callId: 'call-1', toolId: 'ffmpeg', beforeState: { items: 0 } })
  assert.equal(envelope.afterState, null)

  assert.throws(
    () => beginExecution({ callId: 'call-2', toolId: 'ffmpeg' }),
    (error) => error.code === 'VALIDATION_FAILED',
  )

  const empty = endExecution(envelope, {})
  assert.equal(empty.stateUnknown, true)
  assert.equal(empty.complete, false)

  const filled = endExecution(envelope, { afterState: { items: 1 }, result: { ok: true } })
  assert.equal(filled.stateUnknown, false)
  assert.equal(filled.complete, true)
  assert.deepEqual(filled.afterState, { items: 1 })
})

test('channels: describeChannel renders permissions in product language, not enum names', () => {
  const declaration = normalizeChannel({ kind: 'cli', entrypoint: 'ffmpeg', permissions: ['filesystem', 'process'] })
  const described = describeChannel(declaration)
  assert.equal(described.kind, 'cli')
  assert.equal(described.structured, false)
  assert.match(described.summary, /读写本机文件/)
  assert.match(described.summary, /启动外部进程/)
  assert.equal(described.summary.includes('filesystem'), false)
})

test('channels: a CLI entrypoint must be a bare command name, so a spawn cannot be redirected', () => {
  const declaration = normalizeChannel({ kind: 'cli', entrypoint: 'ffmpeg', permissions: ['process'] })
  assert.equal(declaration.entrypoint, 'ffmpeg')
  // A path, a parent traversal or an absolute binary would let a catalog decide which program runs.
  for (const evil of ['..\\evil.exe', 'C:\\Windows\\System32\\cmd.exe', '/usr/bin/env', 'bin/ffmpeg', '', '../x']) {
    assert.throws(
      () => normalizeChannel({ kind: 'cli', entrypoint: evil, permissions: ['process'] }),
      `entrypoint ${JSON.stringify(evil)} should be refused`,
    )
  }
})
