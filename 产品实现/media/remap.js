/**
 * TimeRemapSpec: the only legal way to change how scene time becomes movie time.
 *
 * Contract (CT-04 §6): movie time and scene time are named separately; speed keys and their
 * interpolation are explicit; a hold (speed 0) is a creative decision, not a rendering error;
 * events can be resolved back from scene time to movie frames; and the audio track keeps MOVIE
 * time — a speed ramp must never silently speed up the user's voice.
 *
 * @module media/remap
 */

import { ValidationError, Rational, roundDeterministic } from '../base/index.js'

/** Modes this module can honour. `reverse` is declared but refused unless the runtime supports it. */
export const REMAP_MODES = Object.freeze(['constant', 'continuous', 'hold', 'reverse'])

/** Interpolation between two speed keys. */
export const REMAP_INTERPOLATION = Object.freeze(['linear', 'step'])

/** Version of the event → movie-frame resolver, so evidence can be tied to one algorithm. */
export const EVENT_RESOLVER_VERSION = '1.0.0'

/**
 * Build a deterministic scene-time → movie-time map.
 *
 * `speed` is d(movieFrames)/d(sceneFrames). With speed 1 the remap does nothing. A segment with
 * speed 0 freezes the movie while scene time keeps moving — a real hold, and the reason a hold is
 * never treated as "no motion detected".
 *
 * @param {object} input
 * @param {string} input.id
 * @param {string} [input.targetObjectRef]
 * @param {'constant'|'continuous'|'hold'|'reverse'} input.mode
 * @param {Array<{ atSceneFrame: number, speed: number, interpolation?: 'linear'|'step' }>} input.speedKeys
 * @param {number} [input.sceneFrames] total scene frames; default is the last key
 * @param {boolean} [input.supportsReverse]
 * @returns {any}
 */
export function createTimeRemap(input) {
  if (typeof input?.id !== 'string' || input.id.length === 0) {
    throw new ValidationError('TimeRemapSpec 需要 id')
  }
  if (!REMAP_MODES.includes(input.mode)) {
    throw new ValidationError('未知时间重映射模式', { mode: String(input.mode) })
  }
  if (input.mode === 'reverse' && input.supportsReverse !== true) {
    throw new ValidationError('当前运行时不支持反向时间映射，不能声称支持', { mode: 'reverse' })
  }
  const keys = [...(input.speedKeys ?? [])]
  if (keys.length === 0) throw new ValidationError('TimeRemapSpec 至少需要一个速度键')
  keys.sort((left, right) => left.atSceneFrame - right.atSceneFrame)
  for (const [index, key] of keys.entries()) {
    if (!Number.isInteger(key.atSceneFrame) || key.atSceneFrame < 0) {
      throw new ValidationError('速度键的场景帧必须是非负整数', { index })
    }
    if (!Number.isFinite(key.speed)) throw new ValidationError('速度键必须有有限速度', { index })
    if (key.interpolation !== undefined && !REMAP_INTERPOLATION.includes(key.interpolation)) {
      throw new ValidationError('未知速度插值', { index, interpolation: String(key.interpolation) })
    }
    if (key.interpolation === 'step' && index === keys.length - 1) {
      // A trailing step key is legal but means "hold forever"; make the author say so with a terminal key.
      continue
    }
  }
  if (keys[0].atSceneFrame !== 0) {
    throw new ValidationError('第一个速度键必须从场景帧 0 开始，否则前段没有定义')
  }
  const sceneFrames = input.sceneFrames ?? keys[keys.length - 1].atSceneFrame
  if (!Number.isInteger(sceneFrames) || sceneFrames <= 0) {
    throw new ValidationError('sceneFrames 必须是正整数')
  }
  if (keys[keys.length - 1].atSceneFrame > sceneFrames) {
    throw new ValidationError('速度键超出场景时长')
  }

  /** Cumulative movie frames at each key. */
  const cumulative = [{ sceneFrame: keys[0].atSceneFrame, movieFrames: 0 }]
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1]
    const current = keys[index]
    const span = current.atSceneFrame - previous.atSceneFrame
    const interpolation = previous.interpolation ?? 'linear'
    const advanced = interpolation === 'step'
      ? previous.speed * span
      : ((previous.speed + current.speed) / 2) * span
    cumulative.push({
      sceneFrame: current.atSceneFrame,
      movieFrames: roundDeterministic(cumulative[index - 1].movieFrames + advanced, 6),
    })
  }

  /** Speed at the end of the declared keys: hold it to the scene end. */
  const tail = keys[keys.length - 1]
  const tailSceneFrame = sceneFrames
  const advancedTail = tail.speed * (tailSceneFrame - tail.atSceneFrame)
  const totalMovieFrames = roundDeterministic(cumulative[cumulative.length - 1].movieFrames + advancedTail, 6)
  if (totalMovieFrames < 0) throw new ValidationError('时间重映射得到负的影片时长')

  const monotone = (() => {
    for (let index = 0; index < cumulative.length; index += 1) {
      if (index > 0 && cumulative[index].movieFrames < cumulative[index - 1].movieFrames) return false
    }
    return true
  })()
  if (!monotone) throw new ValidationError('速度键使影片时间倒退，除非显式支持 reverse 否则拒绝')

  /**
   * Exact movie frames at a (possibly fractional) scene frame.
   * @param {number} sceneFrame
   */
  function movieFramesAt(sceneFrame) {
    if (!Number.isFinite(sceneFrame) || sceneFrame < 0) {
      throw new ValidationError('场景帧必须是非负数', { sceneFrame })
    }
    const clamped = Math.min(sceneFrame, sceneFrames)
    let segment = 0
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      if (clamped >= keys[index].atSceneFrame) {
        segment = index
        break
      }
    }
    const previous = keys[segment]
    const base = cumulative[segment]
    const span = clamped - previous.atSceneFrame
    const nextKey = keys[segment + 1]
    const interpolation = previous.interpolation ?? 'linear'
    let advanced
    if (interpolation === 'step' || nextKey === undefined) {
      advanced = previous.speed * span
    } else {
      // Trapezoid area: (speed at the segment start + speed at this sample) / 2 × span.
      const segmentLength = nextKey.atSceneFrame - previous.atSceneFrame
      const speedHere = previous.speed + ((nextKey.speed - previous.speed) * span) / segmentLength
      advanced = ((previous.speed + speedHere) * span) / 2
    }
    return roundDeterministic(base.movieFrames + advanced, 6)
  }

  /**
   * Inverse: which scene frame is being shown at a movie frame.
   * Non-monotone maps are refused at construction, so a bisection is sound.
   * @param {number} movieFrame
   */
  function sceneFramesAt(movieFrame) {
    if (!Number.isFinite(movieFrame) || movieFrame < 0) {
      throw new ValidationError('影片帧必须是非负数', { movieFrame })
    }
    let low = 0
    let high = sceneFrames
    if (movieFramesAt(0) > movieFrame) return 0
    if (movieFramesAt(sceneFrames) <= movieFrame) return sceneFrames
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const middle = (low + high) / 2
      if (movieFramesAt(middle) <= movieFrame) low = middle
      else high = middle
    }
    return roundDeterministic(low, 6)
  }

  return {
    id: input.id,
    targetObjectRef: input.targetObjectRef ?? null,
    mode: input.mode,
    speedKeys: keys.map((key) => ({ ...key, interpolation: key.interpolation ?? 'linear' })),
    sceneFrames,
    totalMovieFrames,
    eventToMovieFrameResolverVersion: EVENT_RESOLVER_VERSION,
    /** @param {number} sceneFrame */
    movieFramesAt,
    /** @param {number} sceneFrame integer frame index */
    movieFrameAt(sceneFrame) {
      return Math.floor(movieFramesAt(sceneFrame))
    },
    /** @param {number} movieFrame */
    sceneFramesAt,
    /** @param {number} movieFrame integer frame index */
    sceneFrameAt(movieFrame) {
      return Math.floor(sceneFramesAt(movieFrame))
    },
    /** Speed at a scene frame, for evidence and for explaining a hold. */
    speedAt(sceneFrame) {
      const clamped = Math.min(Math.max(sceneFrame, 0), sceneFrames)
      let index = 0
      for (let position = keys.length - 1; position >= 0; position -= 1) {
        if (clamped >= keys[position].atSceneFrame) {
          index = position
          break
        }
      }
      const previous = keys[index]
      const next = keys[index + 1]
      if (next === undefined || (previous.interpolation ?? 'linear') === 'step') return previous.speed
      const ratio = (clamped - previous.atSceneFrame) / (next.atSceneFrame - previous.atSceneFrame)
      return roundDeterministic(previous.speed + (next.speed - previous.speed) * ratio, 6)
    },
    /**
     * Resolve named scene events into movie frames.
     * @param {Array<{ label: string, sceneFrame: number }>} events
     */
    resolveEvents(events) {
      return (events ?? []).map((event) => ({
        label: event.label,
        sceneFrame: event.sceneFrame,
        movieFrame: Math.floor(movieFramesAt(event.sceneFrame)),
        speed: this.speedAt(event.sceneFrame),
      }))
    },
    /** Whether the movie is frozen at a scene frame — an intentional hold, not a defect. */
    isHoldAt(sceneFrame) {
      return this.speedAt(sceneFrame) === 0
    },
    /** A plain description for receipts and evidence. */
    describe() {
      return {
        id: this.id,
        mode: this.mode,
        targetObjectRef: this.targetObjectRef,
        speedKeys: this.speedKeys,
        sceneFrames,
        totalMovieFrames,
        eventToMovieFrameResolverVersion: EVENT_RESOLVER_VERSION,
        holdsAt: this.speedKeys.filter((key) => key.speed === 0).map((key) => key.atSceneFrame),
      }
    },
  }
}

/**
 * Assert a remap does not touch the audio track.
 *
 * CT-04 §6: "音轨默认保持影片真实时间，场景变速不得擅自改声音". The check is structural: an audio
 * object may not be the target of a remap, and no object of kind `audio-continuous` may carry one.
 *
 * @param {any} plan
 * @param {{ targetObjectRef?: string|null }|null} remap
 */
export function assertAudioKeepsMovieTime(plan, remap) {
  const audioIds = (plan.objects ?? []).filter((object) => object.kind === 'audio-continuous').map((object) => object.id)
  if (remap !== null && remap !== undefined && remap.targetObjectRef !== null && remap.targetObjectRef !== undefined) {
    if (audioIds.includes(remap.targetObjectRef)) {
      throw new ValidationError('时间重映射不能作用于音轨；音轨保持影片真实时间', {
        targetObjectRef: String(remap.targetObjectRef),
      })
    }
  }
  const offenders = (plan.objects ?? []).filter((object) => object.timeRemap !== undefined && object.timeRemap !== null)
  if (offenders.length > 0) {
    throw new ValidationError('音轨或对象上出现了未声明的时间重映射', {
      objectIds: offenders.map((object) => object.id),
    })
  }
  return { audioObjects: audioIds, policy: 'movie-time', untouched: true }
}

/**
 * Declare the audio truth: whole-segment timing only, never word-level.
 * @param {any} soundManifest
 */
export function describeAudioTimeTruth(soundManifest) {
  const segments = soundManifest?.segments ?? []
  return {
    granularity: 'segment',
    wordLevel: false,
    reason: '本产品不做 ASR，只有整段实际时长；不提供虚假逐字控制',
    segments: segments.map((segment) => ({
      paragraphId: segment.paragraphId,
      actualDurationSeconds: segment.actualDurationSeconds,
      derivedFrames: null,
    })),
  }
}

/** Rational seconds for a movie frame at a declared rate, for evidence. */
export function movieTimeRational(movieFrame, fpsNumerator, fpsDenominator) {
  return new Rational(movieFrame * fpsDenominator, fpsNumerator)
}
