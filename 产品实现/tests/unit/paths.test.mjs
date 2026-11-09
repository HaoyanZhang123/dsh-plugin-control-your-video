/**
 * Unit + integration tests for base/paths.js — the path confinement guard.
 *
 * CT-12 §3 requires rejecting `..`, absolute paths, drive/UNC paths and link escapes,
 * and resolving the real path before the final check. These tests use REAL junctions
 * (created without admin on this machine, verified in C04) so link escape is exercised
 * against the filesystem rather than simulated.
 *
 * @module tests/unit/paths.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PathGuard, assertSafeRelativePath, isInside, resolveRealPath, assertNotLink } from '../../base/paths.js'
import { createTempDir } from '../../base/tempdir.js'

const temp = createTempDir({ label: 'paths' })
test.after(() => temp.dispose())

test('assertSafeRelativePath: accepts ordinary relative paths', () => {
  assert.equal(assertSafeRelativePath('a/b.txt'), 'a/b.txt')
  assert.equal(assertSafeRelativePath('a\\b.txt'), 'a/b.txt')
  assert.equal(assertSafeRelativePath('a/./b'), 'a/b')
  assert.equal(assertSafeRelativePath('a//b'), 'a/b')
  assert.equal(assertSafeRelativePath('中文/文件.txt'), '中文/文件.txt')
})

test('assertSafeRelativePath: rejects traversal and absolute forms', () => {
  const rejected = [
    ['../x', 'PATH_ESCAPE'],
    ['a/../../x', 'PATH_ESCAPE'],
    ['..', 'PATH_ESCAPE'],
    ['C:\\Windows\\x', 'PATH_ABSOLUTE'],
    ['C:relative', 'PATH_ABSOLUTE'],
    ['\\\\server\\share\\x', 'PATH_ABSOLUTE'],
    ['//server/share/x', 'PATH_ABSOLUTE'],
    ['/abs', 'PATH_ABSOLUTE'],
    ['', 'PATH_INVALID'],
    ['a\u0000b', 'PATH_INVALID'],
  ]
  for (const [input, code] of rejected) {
    assert.throws(
      () => assertSafeRelativePath(input),
      (error) => error.code === code,
      `${JSON.stringify(input)} 应被拒绝为 ${code}`,
    )
  }
})

test('assertSafeRelativePath: rejects Windows-specific hazards', () => {
  const rejected = [
    ['con', 'PATH_INVALID'],
    ['a/CON.txt', 'PATH_INVALID'],
    ['a/nul', 'PATH_INVALID'],
    ['a/b.txt:stream', 'PATH_INVALID'],
    ['a/b.txt.', 'PATH_INVALID'],
    ['a/b.txt ', 'PATH_INVALID'],
  ]
  for (const [input, code] of rejected) {
    assert.throws(() => assertSafeRelativePath(input), (error) => error.code === code, `${input} 应被拒绝`)
  }
})

test('assertSafeRelativePath: rejects overlong segments', () => {
  assert.throws(() => assertSafeRelativePath(`${'a'.repeat(300)}.txt`), (error) => error.code === 'PATH_INVALID')
})

test('assertSafeRelativePath: rejects traversal disguises and encoded forms', () => {
  // Found by adversarial probing: these do not escape the LOCAL filesystem, but they DO
  // escape naive normalization or a later URL-decode step, so the guard refuses them.
  const rejected = [
    '..;/etc/passwd',
    '....//....//etc/passwd',
    '.../.../x',
    'a/....//b',
    '.. ',
    '%2e%2e/%2e%2e/x',
    '%2e%2e%2f%2e%2e%2fx',
    '..%2f..%2fx',
    'a/%2e%2e/b',
    '..%00/x',
    '%00.txt',
  ]
  for (const input of rejected) {
    assert.throws(
      () => assertSafeRelativePath(input),
      (error) => error.code === 'PATH_ESCAPE',
      `${input} 必须被拒绝为 PATH_ESCAPE`,
    )
  }
})

test('assertSafeRelativePath: rejects names that could spoof their display', () => {
  // Bidirectional overrides render "…\u202Ecod.exe" as something else entirely.
  const rejected = ['a/b\u202e.txt', 'a/\u202dname', '\u2066x\u2069']
  for (const input of rejected) {
    assert.throws(() => assertSafeRelativePath(input), (error) => error.code === 'PATH_INVALID', JSON.stringify(input))
  }
})

test('assertSafeRelativePath: rejects leading whitespace', () => {
  // A leading space is legal on disk but invisible in a listing, so it is refused.
  assert.throws(() => assertSafeRelativePath('  a'), (error) => error.code === 'PATH_INVALID')
  assert.throws(() => assertSafeRelativePath('a/ b'), (error) => error.code === 'PATH_INVALID')
})

test('PathGuard: resolves inside the root', () => {
  const guard = new PathGuard(temp.dir('proj-a'), { label: 'proj-a' })
  const resolved = guard.resolve('sub/file.json')
  assert.ok(resolved.startsWith(guard.root))
  assert.ok(guard.contains('sub/file.json'))
})

test('PathGuard: refuses traversal through a real junction', () => {
  const root = temp.dir('jail')
  const outside = temp.dir('outside')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET')

  const linkPath = path.join(root, 'escape')
  fs.symlinkSync(outside, linkPath, 'junction')

  const guard = new PathGuard(root, { label: 'jail' })
  // Without link resolution this would look like "escape/secret.txt" inside the root.
  assert.throws(
    () => guard.resolve('escape/secret.txt'),
    (error) => error.code === 'LINK_ESCAPE',
    'junction 逃逸必须被拒绝',
  )
})

test('PathGuard: a link INSIDE the root is still allowed', () => {
  const root = temp.dir('jail-inner')
  // The link target must itself be inside the root; otherwise the correct verdict is refusal.
  const inside = path.join(root, 'target-dir')
  fs.mkdirSync(inside, { recursive: true })
  fs.writeFileSync(path.join(inside, 'ok.txt'), 'fine')
  fs.symlinkSync(inside, path.join(root, 'inner-link'), 'junction')

  const guard = new PathGuard(root, { label: 'inner' })
  const resolved = guard.resolve('inner-link/ok.txt')
  assert.ok(resolved.includes('ok.txt'))
})

test('PathGuard: rejects writing through a link at the target itself', () => {
  const root = temp.dir('jail-write')
  const outside = temp.dir('outside-write')
  const targetFile = path.join(outside, 'target.txt')
  fs.writeFileSync(targetFile, 'original')
  const link = path.join(root, 'link.txt')
  fs.symlinkSync(targetFile, link, 'file')

  assert.throws(() => assertNotLink(link), (error) => error.code === 'LINK_ESCAPE')
})

test('PathGuard: mustExist reports a stable error for a missing file', () => {
  const guard = new PathGuard(temp.dir('exists'), { label: 'exists' })
  assert.throws(() => guard.resolve('nope.json', { mustExist: true }), (error) => error.code === 'PATH_INVALID')
})

test('PathGuard: kind check distinguishes file from directory', () => {
  const guard = new PathGuard(temp.dir('kinds'), { label: 'kinds' })
  fs.writeFileSync(guard.resolve('a.txt'), 'x')
  fs.mkdirSync(guard.resolve('d'), { recursive: true })
  assert.doesNotThrow(() => guard.resolve('a.txt', { mustExist: true, kind: 'file' }))
  assert.doesNotThrow(() => guard.resolve('d', { mustExist: true, kind: 'directory' }))
  assert.throws(() => guard.resolve('a.txt', { mustExist: true, kind: 'directory' }))
  assert.throws(() => guard.resolve('d', { mustExist: true, kind: 'file' }))
})

test('isInside: handles separators, case and siblings', () => {
  const root = path.resolve('E:/root')
  assert.equal(isInside(root, path.resolve('E:/root/a')), true)
  assert.equal(isInside(root, root), true)
  assert.equal(isInside(root, path.resolve('E:/root/a/b')), true)
  assert.equal(isInside(root, path.resolve('E:/root-other/a')), false)
  assert.equal(isInside(root, path.resolve('E:/root/../x')), false)
})

test('resolveRealPath: resolves a not-yet-existing suffix without throwing', () => {
  const root = temp.dir('real')
  const target = path.join(root, 'not', 'yet', 'there.txt')
  const result = resolveRealPath(target)
  assert.equal(result.existed, false)
  assert.ok(result.real.endsWith('there.txt'))
})

test('relativeTo: returns a posix relative path and refuses outsiders', () => {
  const guard = new PathGuard(temp.dir('rel'), { label: 'rel' })
  fs.mkdirSync(guard.resolve('a/b'), { recursive: true })
  fs.writeFileSync(guard.resolve('a/b/c.txt'), 'x')
  assert.equal(guard.relativeTo(guard.resolve('a/b/c.txt')), 'a/b/c.txt')
  assert.throws(() => guard.relativeTo(path.resolve('E:/')), (error) => error.code === 'PATH_ESCAPE')
})

test('contains: returns false instead of throwing for bad paths', () => {
  const guard = new PathGuard(temp.dir('contains'), { label: 'contains' })
  assert.equal(guard.contains('ok.txt'), true)
  assert.equal(guard.contains('../escape.txt'), false)
  assert.equal(guard.contains('C:\\x'), false)
})
