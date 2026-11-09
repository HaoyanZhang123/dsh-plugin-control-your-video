/**
 * Unit tests for base/tempdir.js and base/faults.js.
 *
 * CT-11 §3 requires isolated directories for untrusted input, and CT-06 §6 requires temp
 * cleanup to touch only registrable, rebuildable paths. CT-11 §5 requires the listed faults
 * to be real. These tests cover both.
 *
 * @module tests/unit/tempdir-faults.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  createTempDir,
  findStaleTempDirs,
  resolveTempRoot,
  TempDir,
  MARKER_FILE,
  TEMP_PREFIX,
} from '../../base/tempdir.js'
import {
  FaultKind,
  FaultPlan,
  InjectedFault,
  enableFaultInjection,
  disableFaultInjection,
  isFaultInjectionEnabled,
  faults,
  hitFault,
  withFaultPlan,
  captureFailure,
} from '../../base/faults.js'

test('createTempDir: creates a marker-tagged directory under the chosen root', () => {
  const temp = createTempDir({ label: 'meta' })
  try {
    assert.ok(fs.existsSync(temp.path))
    assert.ok(path.basename(temp.path).startsWith(TEMP_PREFIX))
    const marker = JSON.parse(fs.readFileSync(path.join(temp.path, MARKER_FILE), 'utf8'))
    assert.equal(marker.label, 'meta')
    assert.equal(marker.pid, process.pid)
  } finally {
    temp.dispose()
  }
})

test('TempDir: dir() and file() create nested paths inside the temp dir', () => {
  const temp = createTempDir({ label: 'nest' })
  try {
    const dir = temp.dir('a/b')
    assert.ok(fs.existsSync(dir))
    const file = temp.file('a/b/c.json')
    fs.writeFileSync(file, '{}')
    assert.deepEqual(temp.list(), ['.workbench-temp.json', 'a/b/c.json'].sort())
  } finally {
    temp.dispose()
  }
})

test('TempDir: file() refuses traversal', () => {
  const temp = createTempDir({ label: 'traverse' })
  try {
    assert.throws(() => temp.file('../escape.txt'))
    assert.throws(() => temp.dir('C:\\windows'))
  } finally {
    temp.dispose()
  }
})

test('TempDir: dispose removes the tree and is idempotent', () => {
  const temp = createTempDir({ label: 'dispose' })
  const p = temp.path
  temp.file('x/y.txt')
  const first = temp.dispose()
  assert.equal(first.removed, true)
  assert.equal(fs.existsSync(p), false)
  const second = temp.dispose()
  assert.equal(second.reason, 'already-disposed')
})

test('TempDir: keep=true preserves the directory for diagnosis', () => {
  const temp = createTempDir({ label: 'keep', keep: true })
  try {
    const result = temp.dispose()
    assert.equal(result.removed, false)
    assert.ok(fs.existsSync(temp.path))
  } finally {
    fs.rmSync(temp.path, { recursive: true, force: true })
  }
})

test('TempDir: use after dispose is refused rather than silently re-creating', () => {
  const temp = createTempDir({ label: 'dead' })
  temp.dispose()
  assert.throws(() => temp.file('x.txt'), (error) => error.code === 'VALIDATION_FAILED')
})

test('TempDir: sizeBytes counts nested files', () => {
  const temp = createTempDir({ label: 'size' })
  try {
    fs.writeFileSync(temp.file('a.txt'), 'aaaa')
    fs.writeFileSync(temp.file('b/c.txt'), 'bbbbbb')
    assert.ok(temp.sizeBytes() >= 10)
  } finally {
    temp.dispose()
  }
})

test('resolveTempRoot: reports every candidate it tried', () => {
  const { root, checked } = resolveTempRoot()
  assert.ok(typeof root === 'string' && root.length > 0)
  assert.ok(Array.isArray(checked) && checked.length >= 1)
  assert.equal(checked.at(-1).ok, true)
})

test('findStaleTempDirs: recognizes our own live directory as owned', () => {
  const temp = createTempDir({ label: 'stale-scan' })
  try {
    const found = findStaleTempDirs(path.dirname(temp.path))
    const mine = found.find((entry) => entry.path === temp.path)
    assert.ok(mine, '应能发现自己创建的临时目录')
    assert.equal(mine.pid, process.pid)
    assert.equal(mine.ownerAlive, true)
  } finally {
    temp.dispose()
  }
})

test('faults: disabled by default and inert', () => {
  assert.equal(isFaultInjectionEnabled(), false)
  assert.equal(hitFault('any:seam'), undefined)
  assert.throws(() => faults().arm('x', FaultKind.IO_ERROR))
})

test('faults: enable requires allow:true', () => {
  assert.throws(() => enableFaultInjection())
  assert.throws(() => enableFaultInjection({ allow: false }))
})

test('faults: an armed seam throws the matching syscall code exactly once', () => {
  enableFaultInjection({ allow: true })
  try {
    const plan = new FaultPlan().arm('test:seam', FaultKind.DISK_FULL, { times: 1 })
    const result = withFaultPlan(plan, () => {
      const first = captureFailure(() => plan.hit('test:seam'))
      const second = captureFailure(() => plan.hit('test:seam'))
      return { first, second }
    })
    assert.equal(result.first.ok, false)
    assert.equal(/** @type {any} */ (result.first.error).code, 'ENOSPC')
    assert.equal(result.first.error.faultKind, FaultKind.DISK_FULL)
    assert.equal(result.second.ok, true, '一次性故障只应触发一次')
  } finally {
    disableFaultInjection()
  }
})

test('faults: report lists seams and activation counts for evidence', () => {
  enableFaultInjection({ allow: true })
  try {
    const plan = new FaultPlan().arm('a:b', FaultKind.PERMISSION_DENIED, { times: 2 })
    withFaultPlan(plan, () => {
      // Two armed activations must both fire; catching them keeps the counts observable.
      captureFailure(() => plan.hit('a:b'))
      captureFailure(() => plan.hit('a:b'))
      // A third hit must be a no-op once the budget is exhausted.
      assert.equal(plan.hit('a:b'), undefined)
    })
    const report = plan.report()
    assert.equal(report.executed, true)
    assert.equal(report.rules[0].seam, 'a:b')
    assert.equal(report.rules[0].fired, 2)
    assert.equal(report.rules[0].remaining, 0)
  } finally {
    disableFaultInjection()
  }
})

test('faults: unknown kinds are rejected', () => {
  const plan = new FaultPlan()
  assert.throws(() => plan.arm('x', 'NOT_A_KIND'))
  assert.throws(() => plan.arm('', FaultKind.IO_ERROR))
})

test('faults: InjectedFault carries a code callers can branch on', () => {
  const fault = new InjectedFault(FaultKind.FILE_BUSY, 'locked')
  assert.equal(fault.code, 'EBUSY')
  assert.equal(fault.isInjectedFault, true)
  assert.equal(fault.faultKind, FaultKind.FILE_BUSY)
})

test('faults: withFaultPlan restores the previous enabled state', () => {
  const plan = new FaultPlan().arm('s', FaultKind.IO_ERROR)
  assert.equal(isFaultInjectionEnabled(), false)
  withFaultPlan(plan, () => {
    assert.equal(isFaultInjectionEnabled(), true)
  })
  assert.equal(isFaultInjectionEnabled(), false, '嵌套使用后必须恢复原状态')
  assert.equal(hitFault('s'), undefined, '禁用后 seam 必须失效')
})
