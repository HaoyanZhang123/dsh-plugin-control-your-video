/**
 * Timeline queries: who is visible when, how a movie frame maps into a source file, and which
 * objects a transition must actually show.
 *
 * Contract (CT-04 §2–4): `authored.sourceOffset` is an in-point inside the source, not the start
 * inside the movie; the frame index inside a scene is not the frame index inside the source. This
 * module is the single place that converts between the three, using integer frames and rational
 * seconds so that a 30 fps plan and a 23.976 fps source cannot silently agree on the wrong frame.
 *
 * @module media/timeline
 */

import { ValidationError, Rational } from '../base/index.js'
import { deriveLayout } from './plan.js'

/**
 * Layout for a plan, with a small memo so repeated queries during one render do not re-derive.
 * @type {WeakMap<object, ReturnType<typeof deriveLayout>>}
 */
const layoutCache = new WeakMap()

/**
 * @param {any} plan
 * @returns {ReturnType<typeof deriveLayout>}
 */
export function layoutOf(plan) {
  const cached = layoutCache.get(plan)
  if (cached !== undefined) return cached
  const layout = deriveLayout(plan)
  layoutCache.set(plan, layout)
  return layout
}

/** Frames per second as a float, for display only. */
export function fpsOf(plan) {
  return plan.timebase.fpsNumerator / plan.timebase.fpsDenominator
}

/**
 * @param {any} plan
 * @param {string} objectId
 * @returns {any}
 */
export function objectOf(plan, objectId) {
  const object = plan.objects.find((entry) => entry.id === objectId)
  if (object === undefined) throw new ValidationError('计划中没有这个对象', { objectId: String(objectId) })
  return object
}

/**
 * Visibility window of an object in movie frames, `[start, end)`.
 * @param {any} plan
 * @param {string} objectId
 */
export function objectWindow(plan, objectId) {
  const object = objectOf(plan, objectId)
  return {
    startFrame: object.timeline.startFrame,
    endFrameExclusive: object.timeline.startFrame + object.timeline.durationFrames,
  }
}

/**
 * Whether an object is on screen at a movie frame. `[start, end)` semantics: the end frame is
 * the first frame after the object, so a 1-frame object at 0 is invisible at frame 1.
 * @param {any} plan
 * @param {string} objectId
 * @param {number} movieFrame
 */
export function isVisibleAt(plan, objectId, movieFrame) {
  const window = objectWindow(plan, objectId)
  return movieFrame >= window.startFrame && movieFrame < window.endFrameExclusive
}

/**
 * Objects visible at a movie frame, in draw order.
 *
 * Draw order is the scene order first (later scenes paint above earlier ones during an overlap),
 * then the object's `zIndex` (default 0 preserving array order).
 *
 * @param {any} plan
 * @param {number} movieFrame
 * @returns {any[]}
 */
export function activeObjectsAt(plan, movieFrame) {
  if (!Number.isInteger(movieFrame) || movieFrame < 0) {
    throw new ValidationError('帧号必须是非负整数', { field: 'movieFrame' })
  }
  const layout = layoutOf(plan)
  const sceneOrder = new Map(layout.scenes.map((scene, index) => [scene.id, index]))
  const visible = plan.objects.filter((object) => isVisibleAt(plan, object.id, movieFrame))
  return visible
    .map((object, index) => ({ object, index }))
    .sort((left, right) => {
      const leftMovie = (left.object.scope ?? 'scene') === 'movie' ? 1 : 0
      const rightMovie = (right.object.scope ?? 'scene') === 'movie' ? 1 : 0
      if (leftMovie !== rightMovie) return leftMovie - rightMovie
      const leftScene = sceneOrder.get(left.object.sceneId) ?? 0
      const rightScene = sceneOrder.get(right.object.sceneId) ?? 0
      if (leftScene !== rightScene) return leftScene - rightScene
      const leftZ = left.object.zIndex ?? 0
      const rightZ = right.object.zIndex ?? 0
      if (leftZ !== rightZ) return leftZ - rightZ
      return left.index - right.index
    })
    .map((entry) => entry.object)
}

/**
 * Scenes whose declared window contains the frame. Two scenes overlap inside a transition.
 * @param {any} plan
 * @param {number} movieFrame
 */
export function scenesAt(plan, movieFrame) {
  return layoutOf(plan).scenes.filter(
    (scene) => movieFrame >= scene.startFrame && movieFrame < scene.endFrameExclusive,
  )
}

/**
 * The transition whose overlap window contains the frame, or null.
 * @param {any} plan
 * @param {number} movieFrame
 */
export function transitionAt(plan, movieFrame) {
  const overlap = layoutOf(plan).overlaps.find(
    (entry) => movieFrame >= entry.startFrame && movieFrame < entry.endFrameExclusive,
  )
  return overlap ?? null
}

/**
 * Objects a transition must show, derived from the plan's geometry.
 *
 * CT-04 §3: participants are derived, never hand-listed, and a coverage check must fail when an
 * object that is visible inside the overlap is absent from the set. C02's real defect was a
 * transition that faded content but left a subtitle fully lit — the object was not in any
 * participant set, so nothing told the renderer it had to fade.
 *
 * @param {any} plan
 * @param {string} transitionId
 * @returns {{ transitionId: string, overlap: { startFrame: number, endFrameExclusive: number }, participants: Array<{
 * id: string, side: string, startFrame: number, endFrameExclusive: number }> }}
 */
export function transitionParticipants(plan, transitionId) {
  const layout = layoutOf(plan)
  const overlap = layout.overlaps.find((entry) => entry.id === transitionId)
  if (overlap === undefined) {
    throw new ValidationError('计划中没有这个转场', { transitionId: String(transitionId) })
  }
  const participants = []
  for (const side of [overlap.fromScene, overlap.toScene]) {
    for (const object of plan.objects) {
      if ((object.scope ?? 'scene') !== 'scene') continue
      if (object.sceneId !== side) continue
      const startFrame = object.timeline.startFrame
      const endFrameExclusive = startFrame + object.timeline.durationFrames
      const intersects = startFrame < overlap.endFrameExclusive && endFrameExclusive > overlap.startFrame
      if (!intersects) continue
      participants.push({ id: object.id, side, startFrame, endFrameExclusive })
    }
  }
  // CT-04 v1.1 §2.1: participants contain ONLY scene-scoped objects. A movie-level subtitle or the
  // continuous audio must keep its own state through a cross-dissolve — music must not duck because
  // the picture fades, and a subtitle must not fade twice at a cut.
  return {
    transitionId: overlap.id,
    overlap: { startFrame: overlap.startFrame, endFrameExclusive: overlap.endFrameExclusive },
    participants,
  }
}

/**
 * Coverage check for every transition: the declared participant list (if any) must equal the
 * derived one, and every object visible inside the overlap must belong to one of the two scenes.
 *
 * @param {any} plan
 * @returns {Array<{ transitionId: string, code: string, detail: string, objectId?: string }>}
 */
export function checkTransitionCoverage(plan) {
  const layout = layoutOf(plan)
  const problems = []
  for (const overlap of layout.overlaps) {
    const derived = transitionParticipants(plan, overlap.id)
    const derivedIds = derived.participants.map((entry) => entry.id)
    const declared = plan.transitions.find((entry) => entry.id === overlap.id)?.participants
    if (Array.isArray(declared)) {
      for (const id of derivedIds) {
        if (!declared.includes(id)) {
          problems.push({
            transitionId: overlap.id,
            code: 'participant-missing',
            objectId: id,
            detail: `对象 ${id} 在重叠窗口内可见但不在声明的参与者集合中`,
          })
        }
      }
      for (const id of declared) {
        if (!derivedIds.includes(id)) {
          problems.push({
            transitionId: overlap.id,
            code: 'participant-extra',
            objectId: id,
            detail: `参与者 ${id} 在重叠窗口内并不可见，声明会夸大覆盖`,
          })
        }
      }
    }
    // An object from a third scene that happens to be visible here means the timeline itself is wrong.
    const visible = activeObjectsAt(plan, overlap.startFrame)
    for (const object of visible) {
      if ((object.scope ?? 'scene') === 'movie') continue
      if (object.sceneId !== overlap.fromScene && object.sceneId !== overlap.toScene) {
        problems.push({
          transitionId: overlap.id,
          code: 'foreign-object-visible',
          objectId: object.id,
          detail: `对象 ${object.id} 属于第三个场景却在转场窗口内可见`,
        })
      }
    }
  }
  return problems
}

/**
 * Map a movie frame into a source file for one video/image instance.
 *
 * The returned `sourceFrame` is computed at the SOURCE frame rate, so a 30 fps plan reading a
 * 23.976 fps file reports the frame the decoder would actually show, not a fictitious one.
 *
 * @param {any} plan
 * @param {string} objectId
 * @param {number} movieFrame
 * @param {{ fpsNumerator?: number, fpsDenominator?: number }} [sourceRate]
 * @returns {{
 *   movieFrame: number,
 *   objectStartFrame: number,
 *   inObjectFrames: number,
 *   sourceOffsetFrames: number,
 *   sourceSeconds: number,
 *   sourceSecondsRational: string,
 *   sourceFrame: number,
 *   sourceFrameExact: number,
 * }}
 */
export function mapMovieFrameToSource(plan, objectId, movieFrame, sourceRate = {}) {
  const object = objectOf(plan, objectId)
  const authored = object.authored ?? {}
  if (!Number.isInteger(movieFrame)) throw new ValidationError('影片帧号必须是整数', { field: 'movieFrame' })
  const offsetFrames = authored.sourceOffsetFrames
  if (!Number.isInteger(offsetFrames) || offsetFrames < 0) {
    throw new ValidationError('该对象没有合法的源偏移帧', { objectId })
  }
  if (movieFrame < object.timeline.startFrame) {
    throw new ValidationError('影片帧早于对象起点，源内没有对应帧', {
      objectId,
      movieFrame,
      objectStartFrame: object.timeline.startFrame,
    })
  }
  const inObjectFrames = movieFrame - object.timeline.startFrame
  const fpsNumerator = plan.timebase.fpsNumerator
  const fpsDenominator = plan.timebase.fpsDenominator
  // Seconds inside the source = offset seconds + in-object duration.
  const offset = new Rational(offsetFrames * fpsDenominator, fpsNumerator)
  const consumed = new Rational(inObjectFrames * fpsDenominator, fpsNumerator)
  const sourceSeconds = new Rational(offset.num * consumed.den + consumed.num * offset.den, offset.den * consumed.den)
  const srcNum = sourceRate.fpsNumerator
  const srcDen = sourceRate.fpsDenominator
  const exact =
    srcNum !== undefined && srcDen !== undefined
      ? sourceSeconds.toFrames(srcNum, srcDen)
      : sourceSeconds.toFrames(fpsNumerator, fpsDenominator)
  return {
    movieFrame,
    objectStartFrame: object.timeline.startFrame,
    inObjectFrames,
    sourceOffsetFrames: offsetFrames,
    sourceSeconds: sourceSeconds.toSeconds(6),
    sourceSecondsRational: sourceSeconds.toString(),
    sourceFrame: Math.floor(exact),
    sourceFrameExact: Number(exact.toFixed(6)),
  }
}

/**
 * The source range one instance consumes, in seconds. Used to refuse an offset that runs past
 * the end of the file before a renderer wastes a minute discovering it.
 *
 * @param {any} plan
 * @param {string} objectId
 */
export function sourceRangeOf(plan, objectId) {
  const object = objectOf(plan, objectId)
  const authored = object.authored ?? {}
  const offsetFrames = authored.sourceOffsetFrames
  if (!Number.isInteger(offsetFrames)) {
    throw new ValidationError('该对象没有源偏移', { objectId })
  }
  const fpsNumerator = plan.timebase.fpsNumerator
  const fpsDenominator = plan.timebase.fpsDenominator
  const startSeconds = new Rational(offsetFrames * fpsDenominator, fpsNumerator).toSeconds(6)
  const durationSeconds = new Rational(object.timeline.durationFrames * fpsDenominator, fpsNumerator).toSeconds(6)
  return {
    startSeconds,
    durationSeconds,
    endSeconds: Number((startSeconds + durationSeconds).toFixed(6)),
  }
}

/**
 * Format a frame index as `HH:MM:SS:FF` at the plan rate.
 * @param {number} movieFrame
 * @param {number} fpsNumerator
 * @param {number} fpsDenominator
 */
export function formatTimecode(movieFrame, fpsNumerator, fpsDenominator) {
  if (!Number.isInteger(movieFrame) || movieFrame < 0) {
    throw new ValidationError('帧号必须是非负整数', { field: 'movieFrame' })
  }
  const nominalFps = Math.round(fpsNumerator / fpsDenominator)
  const totalSeconds = Math.floor(movieFrame / (fpsNumerator / fpsDenominator))
  const frames = movieFrame - Math.floor(totalSeconds * (fpsNumerator / fpsDenominator))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(Math.min(frames, nominalFps - 1))}`
}

/**
 * Frame ranges a plan diff actually touches, merged and clipped to the movie.
 * @param {any} plan
 * @param {Array<{ startFrame: number, endFrameExclusive: number }>} ranges
 */
export function mergeFrameRanges(plan, ranges) {
  const total = layoutOf(plan).totalFrames
  const clipped = ranges
    .map((range) => ({
      startFrame: Math.max(0, Math.min(total, range.startFrame)),
      endFrameExclusive: Math.max(0, Math.min(total, range.endFrameExclusive)),
    }))
    .filter((range) => range.endFrameExclusive > range.startFrame)
    .sort((left, right) => left.startFrame - right.startFrame)
  const merged = []
  for (const range of clipped) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.startFrame <= last.endFrameExclusive) {
      last.endFrameExclusive = Math.max(last.endFrameExclusive, range.endFrameExclusive)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * Inverse range: which movie frames are NOT covered by the given ranges.
 * This is the "待更新范围" of a preview after a local change.
 * @param {any} plan
 * @param {Array<{ startFrame: number, endFrameExclusive: number }>} ranges
 */
export function uncoveredFrameRanges(plan, ranges) {
  const total = layoutOf(plan).totalFrames
  const merged = mergeFrameRanges(plan, ranges)
  const out = []
  let cursor = 0
  for (const range of merged) {
    if (range.startFrame > cursor) out.push({ startFrame: cursor, endFrameExclusive: range.startFrame })
    cursor = Math.max(cursor, range.endFrameExclusive)
  }
  if (cursor < total) out.push({ startFrame: cursor, endFrameExclusive: total })
  return out
}
