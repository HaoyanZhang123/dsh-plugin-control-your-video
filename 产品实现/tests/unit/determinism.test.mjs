/**
 * Unit tests for base/determinism.js.
 *
 * CT-06 §7 requires reproducible renders: the clock, randomness and cache keys must be
 * injectable and stable. These tests prove stability, not just "returns a number".
 *
 * @module tests/unit/determinism.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Clock,
  startTimer,
  createSeededRandom,
  stableStringify,
  contentHash,
  buildCacheKey,
  roundDeterministic,
  Rational,
  totalDurationFrames,
} from '../../base/determinism.js'

test('Clock: frozen clock never advances', () => {
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
  const first = clock.now()
  const second = clock.now()
  assert.equal(first, second)
  assert.equal(clock.iso(), new Date(1_700_000_000_000).toISOString())
})

test('Clock: manual clock advances only when told', () => {
  const clock = new Clock({ mode: 'manual', start: 1000, stepMs: 10 })
  assert.equal(clock.now(), 1010)
  assert.equal(clock.now(), 1020)
  clock.advance(500)
  assert.equal(clock.now(), 1530)
})

test('Clock: iso() is UTC regardless of local timezone', () => {
  const clock = new Clock({ mode: 'frozen', start: 0 })
  assert.equal(clock.iso(), '1970-01-01T00:00:00.000Z')
})

test('Clock: describe() records the mode for evidence', () => {
  const clock = new Clock({ mode: 'frozen', start: 0 })
  const described = clock.describe()
  assert.equal(described.mode, 'frozen')
  assert.equal(described.reads, 0)
})

test('startTimer: measures elapsed monotonic time', () => {
  const timer = startTimer()
  const elapsed = timer.elapsedMs()
  assert.ok(elapsed >= 0)
  assert.ok(elapsed < 5000)
})

test('createSeededRandom: same seed gives the same sequence', () => {
  const a = createSeededRandom(42).ints(20, 1000)
  const b = createSeededRandom(42).ints(20, 1000)
  assert.deepEqual(a, b)
})

test('createSeededRandom: different seeds diverge', () => {
  const a = createSeededRandom(1).ints(10, 1000)
  const b = createSeededRandom(2).ints(10, 1000)
  assert.notDeepEqual(a, b)
})

test('createSeededRandom: nextInt stays in range', () => {
  const random = createSeededRandom(7)
  for (let index = 0; index < 500; index += 1) {
    const value = random.nextInt(10)
    assert.ok(Number.isInteger(value) && value >= 0 && value < 10)
  }
})

test('createSeededRandom: rejects an invalid upper bound', () => {
  assert.throws(() => createSeededRandom(1).nextInt(0))
  assert.throws(() => createSeededRandom(1).nextInt(1.5))
})

test('stableStringify: key order does not change the output', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
  assert.equal(stableStringify({ a: 2, b: 1 }), '{"a":2,"b":1}')
})

test('stableStringify: handles nested objects, arrays and dates', () => {
  const value = { z: [{ b: 2, a: 1 }], when: new Date(0) }
  assert.equal(stableStringify(value), '{"when":"1970-01-01T00:00:00.000Z","z":[{"a":1,"b":2}]}')
})

test('contentHash: equal structures hash equally, differing ones do not', () => {
  assert.equal(contentHash({ a: 1, b: [2, 3] }), contentHash({ b: [2, 3], a: 1 }))
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }))
})

test('buildCacheKey: includes every supplied dependency', () => {
  const base = { plan: 'p1', source: 's1', font: 'f1', code: 'c1', tool: 't1', params: { fps: 30 } }
  const key = buildCacheKey(base)
  assert.match(key.key, /^[a-f0-9]{64}$/)
  for (const dependency of ['plan', 'source', 'font', 'code', 'tool', 'params']) {
    assert.ok(key.components[dependency], `缓存键应包含 ${dependency}`)
  }
})

test('buildCacheKey: changing any dependency changes the key', () => {
  const base = { plan: 'p1', source: 's1', font: 'f1' }
  const changed = buildCacheKey({ ...base, font: 'f2' })
  assert.notEqual(buildCacheKey(base).key, changed.key)
})

test('buildCacheKey: is order-independent', () => {
  assert.equal(buildCacheKey({ a: 1, b: 2 }).key, buildCacheKey({ b: 2, a: 1 }).key)
})

test('roundDeterministic: rounds predictably and rejects non-finite input', () => {
  assert.equal(roundDeterministic(1.23456789, 4), 1.2346)
  assert.equal(roundDeterministic(2.5, 0), 3)
  assert.throws(() => roundDeterministic(Number.NaN))
  assert.throws(() => roundDeterministic(1, 99))
})

test('Rational: normalizes and reports exact seconds', () => {
  const rational = new Rational(9, 1)
  assert.equal(rational.toString(), '9/1')
  assert.equal(rational.toSeconds(), 9)
  assert.equal(new Rational(6, 8).toString(), '3/4')
  assert.equal(new Rational(-6, 8).toString(), '-3/4')
  assert.throws(() => new Rational(1, 0))
})

test('Rational.toFrames: 9s at 30000/1001 matches the C02 baseline', () => {
  const frames = new Rational(9, 1).toFrames(30000, 1001)
  assert.ok(Math.abs(frames - 269.7303) < 0.001, `实际 ${frames}`)
  assert.equal(new Rational(9, 1).toFrames(30, 1), 270)
})

test('Rational.toFrameIndex: floor semantics for [start, end)', () => {
  assert.equal(new Rational(9, 1).toFrameIndex(30000, 1001), 269)
  assert.equal(new Rational(0, 1).toFrameIndex(30, 1), 0)
})

test('Rational.fromNumber: round-trips a decimal within tolerance', () => {
  const rational = Rational.fromNumber(1.5)
  assert.equal(rational.toNumber(), 1.5)
})

test('totalDurationFrames: subtracts overlapping transitions (CT-04 example)', () => {
  const result = totalDurationFrames([150, 150], [30])
  assert.equal(result.frames, 270)
  assert.equal(result.scenes, 300)
  assert.equal(result.overlaps, 30)
})

test('totalDurationFrames: rejects a negative total and invalid input', () => {
  assert.throws(() => totalDurationFrames([10], [20]))
  assert.throws(() => totalDurationFrames([-1]))
  assert.throws(() => totalDurationFrames([1.5]))
})

test('totalDurationFrames: no transitions means a plain sum', () => {
  assert.equal(totalDurationFrames([100, 50]).frames, 150)
})
