/**
 * Unit tests for version identity, ordering and supported-version ranges.
 *
 * These prove the distinctions the product depends on: a build qualifier is not a prerelease, a version
 * outside the range must be told apart from one that cannot be parsed, and an unreadable version can
 * never read as "compatible" (C06 §4.2, CT-00 §1).
 *
 * @module tests/unit/tools-version.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFingerprint,
  checkVersionPin,
  compareVersions,
  newestSatisfying,
  parseRange,
  parseVersion,
  sameBuild,
  satisfiesRange,
  tryParseVersion,
} from '../../tools/version.js'
import { RangeVerdict } from '../../tools/schema.js'

test('version: parses the real FFmpeg build string without inventing a minor and patch', () => {
  const version = parseVersion('9.0.1-full_build-www.gyan.dev')
  assert.equal(version.major, 9)
  assert.equal(version.minor, 0)
  assert.equal(version.patch, 1)
  assert.equal(version.qualifier, 'full_build-www.gyan.dev')
  assert.equal(version.core(), '9.0.1')
})

test('version: a build qualifier is NOT a prerelease, so it does not sort below the release', () => {
  // This is the trap: treating `-full_build` as semver prerelease would make FFmpeg's normal Gyan build
  // "older than 9.0.1", which would corrupt every range decision.
  const build = parseVersion('9.0.1-full_build-www.gyan.dev')
  assert.equal(build.isPrerelease(), false)
  assert.equal(compareVersions(build, parseVersion('9.0.1')), 0)
  assert.equal(compareVersions(parseVersion('9.0.1'), build), 0)
})

test('version: a real prerelease DOES sort below its release', () => {
  assert.equal(compareVersions(parseVersion('4.0.541-rc1'), parseVersion('4.0.541')), -1)
  assert.equal(compareVersions(parseVersion('4.0.541'), parseVersion('4.0.541-rc1')), 1)
  assert.equal(parseVersion('4.0.541-beta.2').isPrerelease(), true)
  assert.equal(parseVersion('4.0.541-canary').isPrerelease(), true)
})

test('version: sameBuild is stricter than numeric equality, because two builds are different payloads', () => {
  assert.equal(sameBuild('9.0.1-full_build', '9.0.1-full_build'), true)
  assert.equal(sameBuild('9.0.1-full_build', '9.0.1'), false)
  assert.equal(compareVersions(parseVersion('9.0.1-full_build'), parseVersion('9.0.1')), 0)
  assert.equal(buildFingerprint('9.0.1-full_build'), '9.0.1-full_build')
  assert.equal(buildFingerprint('9.0.1'), '9.0.1')
})

test('version: a missing minor and patch default to zero rather than failing', () => {
  assert.equal(parseVersion('9').core(), '9.0.0')
  assert.equal(parseVersion('v4.0').core(), '4.0.0')
  assert.equal(parseVersion(' 0.9.19 ').raw, '0.9.19')
})

test('version: garbage input is refused, not silently coerced', () => {
  assert.throws(() => parseVersion('not-a-version'), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => parseVersion(''), (error) => error.code === 'VALIDATION_FAILED')
  const attempted = tryParseVersion('latest')
  assert.equal(attempted.ok, false)
  assert.equal(typeof attempted.reason, 'string')
})

test('version: the real catalog ranges accept and reject the right builds', () => {
  const ffmpegRange = parseRange('>=9.0.0 <10.0.0')
  const inside = satisfiesRange(ffmpegRange, '9.0.1-full_build-www.gyan.dev')
  assert.equal(inside.verdict, RangeVerdict.IN_RANGE)
  assert.equal(inside.matched, true)

  const tooOld = satisfiesRange(ffmpegRange, '8.1.0')
  assert.equal(tooOld.verdict, RangeVerdict.BELOW_MINIMUM)
  assert.match(tooOld.reason, /8|最低/)

  const tooNew = satisfiesRange(ffmpegRange, '10.0.0')
  assert.equal(tooNew.verdict, RangeVerdict.ABOVE_MAXIMUM)
})

test('version: an exact pin rejects a neighbour and a caret range bounds correctly', () => {
  const exact = parseRange('=0.9.19')
  assert.equal(satisfiesRange(exact, '0.9.19').matched, true)
  assert.equal(satisfiesRange(exact, '0.9.20').matched, false)
  assert.equal(satisfiesRange(exact, '0.9.18').verdict, RangeVerdict.BELOW_MINIMUM)

  const caret = parseRange('^4.0.541')
  assert.equal(satisfiesRange(caret, '4.9.0').matched, true)
  assert.equal(satisfiesRange(caret, '5.0.0').matched, false)
  assert.equal(satisfiesRange(caret, '4.0.540').matched, false)

  const tilde = parseRange('~4.0.541')
  assert.equal(satisfiesRange(tilde, '4.0.600').matched, true)
  assert.equal(satisfiesRange(tilde, '4.1.0').matched, false)
})

test('version: a disjunction accepts a version that satisfies any alternative', () => {
  const either = parseRange('=9.0.1 || =10.0.0')
  assert.equal(satisfiesRange(either, '9.0.1').matched, true)
  assert.equal(satisfiesRange(either, '10.0.0').matched, true)
  assert.equal(satisfiesRange(either, '9.5.0').matched, false)
})

test('version: an any-range accepts everything, including a prerelease', () => {
  const any = parseRange('*')
  assert.equal(any.isAny(), true)
  assert.equal(satisfiesRange(any, '0.0.1-alpha').matched, true)
})

test('version: an unparseable version is INVALID_RANGE, never "in range"', () => {
  const range = parseRange('>=9.0.0')
  const verdict = satisfiesRange(range, 'nine-point-oh')
  assert.equal(verdict.verdict, RangeVerdict.INVALID_RANGE)
  assert.equal(verdict.matched, false)
})

test('version: a malformed range is refused at parse time', () => {
  assert.throws(() => parseRange(''), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => parseRange('>=9.0.0 ||'), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => parseRange('>>9.0.0'), (error) => error.code === 'VALIDATION_FAILED')
})

test('version: a pinned project blocks an upgrade to a different build, and not a reinstall of the same', () => {
  const pin = { version: '9.0.1-full_build', projectId: 'project-abc' }

  const same = checkVersionPin(pin, '9.0.1-full_build')
  assert.equal(same.verdict, 'pinned-same')
  assert.equal(same.reason, null)

  const different = checkVersionPin(pin, '9.0.2-full_build')
  assert.equal(different.verdict, 'pinned-conflict')
  assert.match(different.reason, /9\.0\.1-full_build/)
  assert.match(different.reason, /不能静默升级/)

  const unpinned = checkVersionPin(null, '9.0.1-full_build')
  assert.equal(unpinned.verdict, 'unpinned')
})

test('version: newestSatisfying picks the newest in-range build and ignores out-of-range ones', () => {
  const chosen = newestSatisfying(['8.9.0', '9.0.0', '9.0.1-full_build', '10.0.0'], '>=9.0.0 <10.0.0')
  assert.equal(chosen.raw, '9.0.1-full_build')
  assert.equal(newestSatisfying(['8.0.0'], '>=9.0.0'), null)
  assert.equal(newestSatisfying([], '>=9.0.0'), null)
})
