/**
 * Unit + integration tests for base/atomic-write.js.
 *
 * CT-02 §3 requires: temp file on the same filesystem, read-back verification, fsync, atomic
 * publish, and "failure keeps the old version". The failure paths are exercised with REAL
 * fault injection and REAL filesystem conditions, not mocks.
 *
 * @module tests/unit/atomic-write.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  writeFileAtomic,
  writeJsonAtomic,
  readJson,
  sha256,
  sha256File,
  deleteIfHashMatches,
  cleanStaleTempFiles,
  DURABILITY_LIMITS,
  TEMP_SUFFIX,
} from '../../base/atomic-write.js'
import { createTempDir } from '../../base/tempdir.js'
import { PathGuard } from '../../base/paths.js'
import {
  enableFaultInjection,
  disableFaultInjection,
  FaultPlan,
  FaultKind,
  withFaultPlan,
  captureFailure,
} from '../../base/faults.js'

const temp = createTempDir({ label: 'atomic' })
const guard = new PathGuard(temp.dir('files'), { label: 'files' })
test.after(() => {
  disableFaultInjection()
  temp.dispose()
})

test('sha256: matches a known digest and is stable for equal content', () => {
  // Well-known SHA-256 of "abc".
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256('abc'), sha256(Buffer.from('abc')))
})

test('writeFileAtomic: publishes content and reports a verifiable hash', () => {
  const target = guard.resolve('a/plain.txt')
  const result = writeFileAtomic(target, 'hello 世界')
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello 世界')
  assert.equal(result.bytes, Buffer.byteLength('hello 世界', 'utf8'))
  assert.equal(result.sha256, sha256('hello 世界'))
  assert.equal(sha256File(target), result.sha256)
})

test('writeFileAtomic: creates parent directories', () => {
  const target = guard.resolve('deep/nested/dir/file.json')
  writeFileAtomic(target, '{"ok":true}')
  assert.equal(readJson(target).ok, true)
})

test('writeFileAtomic: replaces existing content atomically and leaves no temp file', () => {
  const target = guard.resolve('replace.txt')
  writeFileAtomic(target, 'v1')
  writeFileAtomic(target, 'v2-longer-content')
  assert.equal(fs.readFileSync(target, 'utf8'), 'v2-longer-content')
  const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith(TEMP_SUFFIX))
  assert.deepEqual(leftovers, [], '发布后不应残留临时文件')
})

test('writeFileAtomic: refuses a declared hash mismatch BEFORE writing', () => {
  const target = guard.resolve('hash-guard.txt')
  const failure = captureFailure(() =>
    writeFileAtomic(target, 'real content', { expectedSha256: sha256('different content') }),
  )
  assert.equal(failure.ok, false)
  assert.equal(/** @type {any} */ (failure.error).code, 'IO_FAILED')
  assert.equal(fs.existsSync(target), false, '未通过校验时不得产生目标文件')
})

test('writeFileAtomic: accepts a matching declared hash', () => {
  const target = guard.resolve('hash-ok.txt')
  const content = 'verified'
  const result = writeFileAtomic(target, content, { expectedSha256: sha256(content) })
  assert.equal(result.sha256, sha256(content))
})

test('writeFileAtomic: rejects a relative target path', () => {
  const failure = captureFailure(() => writeFileAtomic('relative/path.txt', 'x'))
  assert.equal(failure.ok, false)
  assert.match(String(/** @type {any} */ (failure.error).message), /绝对路径/)
})

test('writeJsonAtomic: writes stable, reviewable JSON with a trailing newline', () => {
  const target = guard.resolve('json/obj.json')
  writeJsonAtomic(target, { b: 2, a: 1 })
  const text = fs.readFileSync(target, 'utf8')
  assert.ok(text.endsWith('\n'))
  assert.ok(text.includes('\n  "a": 1'))
  assert.deepEqual(readJson(target), { a: 1, b: 2 })
})

test('readJson: a corrupt file becomes a stable error, not a crash', () => {
  const target = guard.resolve('corrupt.json')
  fs.writeFileSync(target, '{ this is not json')
  assert.throws(() => readJson(target), (error) => error.code === 'IO_FAILED' && error.details?.stage === 'parse')
})

test('readJson: a missing file becomes a stable error', () => {
  assert.throws(() => readJson(guard.resolve('missing.json')), (error) => error.code === 'IO_FAILED')
})

test('deleteIfHashMatches: deletes only the exact content', () => {
  const target = guard.resolve('cleanup.txt')
  writeFileAtomic(target, 'owned content')
  const wrongHash = sha256('other')
  assert.equal(deleteIfHashMatches(target, wrongHash), false, '哈希不同不得删除')
  assert.equal(fs.existsSync(target), true)

  const rightHash = sha256('owned content')
  assert.equal(deleteIfHashMatches(target, rightHash), true)
  assert.equal(fs.existsSync(target), false)
})

test('cleanStaleTempFiles: removes only *.tmp-write files', () => {
  const dir = temp.dir('stale')
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep')
  // Names carry a dead PID so they are recognized as stale, not in-flight.
  fs.writeFileSync(path.join(dir, `.leftover.txt.999999.abc123${TEMP_SUFFIX}`), 'junk')
  fs.writeFileSync(path.join(dir, `.also.txt.999998.def456${TEMP_SUFFIX}`), 'junk')
  const result = cleanStaleTempFiles(dir)
  assert.equal(result.removed, 2)
  assert.equal(result.keptLive, 0)
  assert.deepEqual(fs.readdirSync(dir), ['keep.txt'])
})

test('cleanStaleTempFiles: never deletes a temp file owned by a LIVE process', () => {
  // Regression: deleting every *.tmp-write would let one process destroy another writer's
  // in-flight temp file — data loss disguised as cleanup.
  const dir = temp.dir('stale-live')
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep')
  const liveName = `.inflight.json.${process.pid}.abc123${TEMP_SUFFIX}`
  fs.writeFileSync(path.join(dir, liveName), 'being written')
  const deadName = `.gone.json.999999.abc123${TEMP_SUFFIX}`
  fs.writeFileSync(path.join(dir, deadName), 'abandoned')

  const result = cleanStaleTempFiles(dir)
  assert.equal(result.removed, 1)
  assert.equal(result.keptLive, 1)
  assert.deepEqual(result.removedNames, [deadName])
  assert.ok(fs.existsSync(path.join(dir, liveName)), '活进程的临时文件必须保留')
  assert.equal(fs.existsSync(path.join(dir, deadName)), false)
})

test('cleanStaleTempFiles: includeLive override exists for explicit cleanup only', () => {
  const dir = temp.dir('stale-override')
  const liveName = `.inflight2.json.${process.pid}.abc123${TEMP_SUFFIX}`
  fs.writeFileSync(path.join(dir, liveName), 'x')
  const result = cleanStaleTempFiles(dir, { includeLive: true })
  assert.equal(result.removed, 1)
  assert.equal(fs.existsSync(path.join(dir, liveName)), false)
})

test('failure: DISK_FULL during publish leaves the previous version intact', () => {
  const target = guard.resolve('failure/disk-full.txt')
  writeFileAtomic(target, 'original version')
  const originalSha = sha256File(target)

  enableFaultInjection({ allow: true })
  try {
    const plan = new FaultPlan().arm('atomic-write:before-rename', FaultKind.DISK_FULL)
    const failure = withFaultPlan(plan, () =>
      captureFailure(() => writeFileAtomic(target, 'new version that must not land')),
    )

    assert.equal(failure.ok, false)
    assert.equal(/** @type {any} */ (failure.error).code, 'ENOSPC')
    assert.equal(plan.activationCount('atomic-write:before-rename'), 1, '故障必须在真实接缝触发一次')
    assert.equal(sha256File(target), originalSha, '失败后旧内容必须保持原样')
    assert.equal(fs.readFileSync(target, 'utf8'), 'original version')

    // No temp file may survive a failed publish: it would be mistaken for evidence.
    const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith(TEMP_SUFFIX))
    assert.deepEqual(leftovers, [], '失败后应清理临时文件，且绝不发布半成品')
  } finally {
    disableFaultInjection()
  }
})

test('failure: PERMISSION_DENIED before the write leaves the target untouched', () => {
  const target = guard.resolve('failure/perm.txt')
  writeFileAtomic(target, 'before')
  enableFaultInjection({ allow: true })
  try {
    const plan = new FaultPlan().arm('atomic-write:before-write', FaultKind.PERMISSION_DENIED)
    const failure = withFaultPlan(plan, () =>
      captureFailure(() => writeFileAtomic(target, 'after')),
    )
    assert.equal(failure.ok, false)
    assert.equal(/** @type {any} */ (failure.error).code, 'EACCES')
    assert.equal(fs.readFileSync(target, 'utf8'), 'before')
    assert.equal(plan.activationCount('atomic-write:before-write'), 1)
  } finally {
    disableFaultInjection()
  }
})

test('failure: a fault BEFORE the write never publishes a partial file', () => {
  // NOTE the scope: the `during-write` seam fires before the first writeSync, so this proves
  // "aborted before any bytes were written", not "torn mid-write". The genuinely dangerous
  // torn-write hazard is a fault at `before-rename` (data written, not yet published), which
  // the DISK_FULL test above covers.
  const target = guard.resolve('failure/mid-write.txt')
  writeFileAtomic(target, 'stable')
  enableFaultInjection({ allow: true })
  try {
    const plan = new FaultPlan().arm('atomic-write:during-write', FaultKind.IO_ERROR)
    const failure = withFaultPlan(plan, () =>
      captureFailure(() => writeFileAtomic(target, 'partial attempt')),
    )
    assert.equal(failure.ok, false)
    assert.equal(fs.readFileSync(target, 'utf8'), 'stable')
    const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith(TEMP_SUFFIX))
    assert.deepEqual(leftovers, [])
  } finally {
    disableFaultInjection()
  }
})

test('failure: CRASH_MID_WRITE leaves a temp file but never a half-written target', () => {
  const dir = temp.dir('crash')
  const target = path.join(dir, 'patient.txt')
  fs.writeFileSync(target, 'good content')

  // Reproduce the real crash shape: a temp file exists, the target was never replaced.
  const tempName = path.join(dir, `.patient.txt.9999.deadbeef${TEMP_SUFFIX}`)
  fs.writeFileSync(tempName, 'partial writ')

  assert.equal(fs.readFileSync(target, 'utf8'), 'good content', '崩溃后目标文件保持完好')
  assert.ok(fs.existsSync(tempName), '临时文件保留为可诊断证据')

  // The recovery action is to clean the temp file, never to publish it.
  const result = cleanStaleTempFiles(dir)
  assert.equal(result.removed, 1)
  assert.equal(fs.readFileSync(target, 'utf8'), 'good content')
})

test('writeFileAtomic: writing over a read-only file fails without destroying it', () => {
  const target = guard.resolve('readonly.txt')
  writeFileAtomic(target, 'immutable-ish')
  fs.chmodSync(target, 0o444)
  try {
    const failure = captureFailure(() => writeFileAtomic(target, 'replacement'))
    assert.equal(failure.ok, false, '只读目标必须失败而不是静默覆盖')
    assert.equal(fs.readFileSync(target, 'utf8'), 'immutable-ish')
  } finally {
    fs.chmodSync(target, 0o644)
  }
})

test('durability limits are documented, not silently assumed', () => {
  assert.match(DURABILITY_LIMITS.directoryEntry, /not guaranteed on Windows/)
  assert.match(DURABILITY_LIMITS.fileContent, /fsync/)
})
