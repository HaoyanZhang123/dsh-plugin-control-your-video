/**
 * Deterministic time, seeded randomness and stable serialization.
 *
 * Product rule (CT-06 §7, CT-04): a frame must be reproducible from the plan alone.
 * Every dependency that could make two runs differ — the clock, randomness, iteration
 * order, and float formatting — is therefore injectable here and must never be read
 * directly from `Date.now()` / `Math.random()` inside render-relevant code.
 *
 * @module base/determinism
 */

import crypto from 'node:crypto'
import { ValidationError } from './errors.js'

/**
 * A clock that can be frozen or advanced. Tests and render paths use this instead of the
 * ambient wall clock, so an "authored at" field cannot make evidence differ between runs.
 */
export class Clock {
  /**
   * @param {{ mode?: 'system' | 'frozen' | 'manual', start?: number, stepMs?: number }} [options]
   */
  constructor(options = {}) {
    this.mode = options.mode ?? 'system'
    // Clock is the one component allowed to read the wall clock.
    this.base = options.start ?? Date.now() // dsh-allow S2: Clock owns the wall clock
    this.current = this.base
    this.stepMs = options.stepMs ?? 0
    this.reads = 0
  }

  /** Milliseconds since epoch, according to this clock. */
  now() {
    this.reads += 1
    if (this.mode === 'system') return Date.now() // dsh-allow S2: Clock owns the wall clock
    if (this.mode === 'frozen') return this.base
    this.current += this.stepMs
    return this.current
  }

  /** ISO-8601 string, always UTC so evidence is timezone-independent. */
  iso() {
    return new Date(this.now()).toISOString()
  }

  /** Advance a manual clock by an exact amount. */
  advance(ms) {
    if (this.mode !== 'manual') {
      throw new ValidationError('只有 manual 时钟可以前进')
    }
    this.current += ms
    return this.current
  }

  /** A stable snapshot for evidence ("this run used this clock"). */
  describe() {
    return { mode: this.mode, start: new Date(this.base).toISOString(), stepMs: this.stepMs, reads: this.reads }
  }
}

/** A monotonic duration timer based on `process.hrtime.bigint`, unaffected by clock changes. */
export function startTimer() {
  const start = process.hrtime.bigint()
  return {
    /** Elapsed milliseconds, rounded to 1/1000 ms. */
    elapsedMs() {
      return Number(process.hrtime.bigint() - start) / 1e6
    },
  }
}

/**
 * Deterministic pseudo-random generator (mulberry32).
 *
 * Chosen because it is tiny, well understood, and identical across platforms — unlike
 * `Math.random`. It is NOT cryptographically secure; tokens must use `node:crypto`.
 *
 * @param {number} seed 32-bit integer seed
 * @returns {{
 *   nextFloat: () => number,
 *   nextInt: (maxExclusive: number) => number,
 *   ints: (count: number, maxExclusive: number) => number[],
 *   seed: number,
 * }}
 */
export function createSeededRandom(seed) {
  if (!Number.isInteger(seed)) throw new ValidationError('随机种子必须是整数')
  let state = seed >>> 0
  const nextFloat = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    seed,
    nextFloat,
    nextInt(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new ValidationError('nextInt 需要正整数上界')
      }
      return Math.floor(nextFloat() * maxExclusive)
    },
    ints(count, maxExclusive) {
      const out = []
      for (let index = 0; index < count; index += 1) out.push(this.nextInt(maxExclusive))
      return out
    },
  }
}

/**
 * Stable JSON: object keys sorted, so two structurally equal values always serialize
 * identically. Used for content hashes and cache keys.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  const walk = (input) => {
    if (input === null || typeof input !== 'object') return input
    if (Array.isArray(input)) return input.map(walk)
    if (input instanceof Date) return input.toISOString()
    const out = {}
    for (const key of Object.keys(input).sort()) out[key] = walk(input[key])
    return out
  }
  return JSON.stringify(walk(value))
}

/**
 * Content hash of an arbitrary value, stable across key order and platform.
 * @param {unknown} value
 * @returns {string}
 */
export function contentHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

/**
 * A cache key that includes every dependency that can change a rendered result.
 *
 * Deliberately explicit: forgetting a dependency here is the exact failure CT-06 §7 names
 * ("缓存键包含全部影响结果的依赖"). Callers must pass the parts they actually depend on.
 *
 * @param {object} parts
 * @returns {{ key: string, components: Record<string, string> }}
 */
export function buildCacheKey(parts) {
  if (parts === null || typeof parts !== 'object') {
    throw new ValidationError('buildCacheKey 需要依赖对象')
  }
  const components = {}
  for (const key of Object.keys(parts).sort()) {
    const value = parts[key]
    if (value === undefined) continue
    components[key] = typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : contentHash(value)
  }
  const key = crypto.createHash('sha256').update(stableStringify(components)).digest('hex')
  return { key, components }
}

/**
 * Round a float to a fixed number of decimals using a deterministic rule.
 * `toFixed` is used (not banker's rounding) and the result is re-parsed to a number.
 * @param {number} value
 * @param {number} [decimals]
 * @returns {number}
 */
export function roundDeterministic(value, decimals = 6) {
  if (!Number.isFinite(value)) throw new ValidationError('只能舍入有限数值')
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 15) {
    throw new ValidationError('小数位必须是 0..15 的整数')
  }
  return Number.parseFloat(value.toFixed(decimals))
}

/**
 * Exact rational time for frame-accurate arithmetic, avoiding float drift.
 *
 * CompositionPlan time is rational by contract (CT-04 §1); a float second is not allowed
 * to be the only representation of a time relation.
 */
export class Rational {
  /**
   * @param {number} numerator
   * @param {number} denominator
   */
  constructor(numerator, denominator) {
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
      throw new ValidationError('Rational 需要整数分子与分母')
    }
    if (denominator === 0) throw new ValidationError('Rational 分母不能为 0')
    const sign = denominator < 0 ? -1 : 1
    const gcd = greatestCommonDivisor(Math.abs(numerator), Math.abs(denominator))
    this.num = (numerator / gcd) * sign
    this.den = Math.abs(denominator) / gcd
  }

  /** @returns {number} */
  toNumber() {
    return this.num / this.den
  }

  /** Decimal seconds, rounded only at the boundary. */
  toSeconds(decimals = 9) {
    return roundDeterministic(this.toNumber(), decimals)
  }

  /** Normalized "num/den" representation used in evidence files. */
  toString() {
    return `${this.num}/${this.den}`
  }

  /**
   * Frames at a rational frame rate, using exact integer math.
   *
   * seconds * (num/den frames per second) => frame index. For 9 s at 30000/1001 fps this
   * yields 9 * 30000 / 1001 ≈ 269.73 frames, which is the value C02 measured (270 frames
   * after rounding up to a whole frame).
   *
   * @param {number} fpsNumerator frames per second numerator (e.g. 30000)
   * @param {number} fpsDenominator frames per second denominator (e.g. 1001)
   * @returns {number} may be fractional; callers decide rounding
   */
  toFrames(fpsNumerator, fpsDenominator) {
    const validRate =
      Number.isInteger(fpsNumerator) && Number.isInteger(fpsDenominator) && fpsNumerator > 0 && fpsDenominator > 0
    if (!validRate) {
      throw new ValidationError('帧率必须由正整数分子与分母组成')
    }
    if (this.num === 0) return 0
    return (this.num * fpsNumerator) / (this.den * fpsDenominator)
  }

  /**
   * The frame index that contains this instant, using floor semantics for `[start, end)` ranges.
   * @param {number} fpsNumerator
   * @param {number} fpsDenominator
   * @returns {number}
   */
  toFrameIndex(fpsNumerator, fpsDenominator) {
    return Math.floor(this.toFrames(fpsNumerator, fpsDenominator))
  }

  /** @param {number} value @param {number} [den] */
  static fromNumber(value, den = 1000000) {
    if (!Number.isFinite(value)) throw new ValidationError('Rational.fromNumber 需要有限数值')
    return new Rational(Math.round(value * den), den)
  }
}

/** Euclidean GCD for normalization. */
function greatestCommonDivisor(a, b) {
  let x = a
  let y = b
  while (y !== 0) {
    const temp = y
    y = x % y
    x = temp
  }
  return x === 0 ? 1 : x
}

/**
 * Total duration with overlapping transitions subtracted, in exact frames.
 * Mirrors the CT-04 rule: `total = Σ sceneDuration − Σ overlap`.
 * @param {number[]} sceneFrames
 * @param {number[]} overlapFrames
 * @returns {{ frames: number, scenes: number, overlaps: number }}
 */
export function totalDurationFrames(sceneFrames, overlapFrames = []) {
  if (!Array.isArray(sceneFrames)) throw new ValidationError('sceneFrames 必须是数组')
  for (const value of sceneFrames) {
    if (!Number.isInteger(value) || value < 0) throw new ValidationError('场景帧数必须是非负整数')
  }
  for (const value of overlapFrames) {
    if (!Number.isInteger(value) || value < 0) throw new ValidationError('重叠帧数必须是非负整数')
  }
  const scenes = sceneFrames.reduce((sum, value) => sum + value, 0)
  const overlaps = overlapFrames.reduce((sum, value) => sum + value, 0)
  const frames = scenes - overlaps
  if (frames < 0) throw new ValidationError('重叠超过总时长')
  return { frames, scenes, overlaps }
}
