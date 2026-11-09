/**
 * CompositionPlan — the plugin's own authoritative timeline document.
 *
 * Contract (CT-04): time is integer frames plus a rational frame rate, never only a float
 * second; a scene's start is derived from the previous scene's duration minus the declared
 * overlap; the total duration is computed, not guessed by a renderer. This module owns the
 * schema, the structural validation and the version diff. It does not render and it does not
 * talk to any runtime: an adapter reads the normalized plan and declares what it can do.
 *
 * Design notes:
 * - Every derived value (scene end, total frames, seconds) is recomputed here, so a hand-edited
 *   plan that disagrees with itself fails loudly instead of rendering something else.
 * - Object identity is `id`; the same id is used by the object map, the plan node, the runtime
 *   reference and the evidence. Nothing in this file invents a second id space.
 * - Validation returns every problem it finds, because fixing plan errors one exception at a
 *   time is how a wrong value survives.
 *
 * @module media/plan
 */

import { ValidationError, contentHash, Rational } from '../base/index.js'

/** Schema version written by this module. */
export const PLAN_SCHEMA_VERSION = '1.0.0'

/** Schema versions this module can read. */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(['1.0.0'])

/** Unit profiles from CT-07 §3. */
export const UNIT_PROFILES = Object.freeze(['StaticDetailUnit', 'TemporalMotionUnit'])

/** Operations from CT-07 §3 and CT-05 §7–8. */
export const PLAN_OPERATIONS = Object.freeze(['CreateOperation', 'RepairOperation', 'AdaptOperation'])

/**
 * Object kinds this product layer recognises.
 *
 * `hit` describes the only honest selection granularity for the kind; `scope` says whether the
 * object belongs to one scene or to the whole movie (audio, titles that outlive a cut).
 */
export const OBJECT_KINDS = Object.freeze({
  solid: {
    label: '底色板',
    scope: 'scene',
    hit: 'rect',
    editableProps: ['color', 'opacity'],
  },
  'text-native': {
    label: '原生文字',
    scope: 'scene',
    hit: 'text-box',
    editableProps: ['text', 'fontSize', 'fontFamily', 'color', 'x', 'y', 'fontWeight'],
  },
  subtitle: {
    label: '字幕',
    // A subtitle can legally outlive one scene: C02's S02 runs from 2.5 s to 5.6 s across the
    // 4.0 s cut. Making it a single-scene object would silently clip it or drop it from the
    // transition, so subtitles live on a movie-level track.
    scope: 'movie',
    hit: 'text-box',
    editableProps: ['text', 'startFrame', 'durationFrames', 'color', 'backgroundColor', 'fontSize'],
  },
  image: {
    label: '图片实例',
    scope: 'scene',
    hit: 'rect',
    editableProps: ['opacity', 'scale', 'x', 'y'],
  },
  'video-source-with-offset': {
    label: '已有视频实例',
    scope: 'scene',
    hit: 'rect',
    editableProps: ['sourceOffsetFrames', 'startFrame', 'durationFrames', 'opacity', 'scale'],
  },
  'flattened-video': {
    label: '压平外部视频',
    scope: 'scene',
    hit: 'rect',
    editableProps: ['startFrame', 'durationFrames'],
  },
  'program-pattern': {
    label: '程序图案',
    scope: 'scene',
    hit: 'rect',
    editableProps: ['pattern', 'seed', 'rule', 'hue', 'amplitude'],
  },
  'program-counter': {
    label: '程序计数文字',
    scope: 'scene',
    hit: 'text-box',
    editableProps: ['fontSize', 'color', 'x', 'y', 'style'],
  },
  'canvas-program-animation': {
    label: 'Canvas 程序动画',
    scope: 'scene',
    hit: 'canvas-region',
    editableProps: ['particleCount', 'speed', 'amplitude', 'hue', 'trailLength'],
  },
  'audio-continuous': {
    label: '连续音轨',
    scope: 'movie',
    hit: 'timeline-track',
    editableProps: ['volume', 'startFrame', 'durationFrames'],
  },
})

/** Transition kinds this layer models. */
export const TRANSITION_KINDS = Object.freeze(['cut', 'crossfade', 'wipe'])

/** Quality tiers an adapter must tell apart (CT-06 §5). */
export const RENDER_TIERS = Object.freeze(['preview', 'final'])

const KIND_NAMES = Object.keys(OBJECT_KINDS)

/**
 * @typedef {{ code: string, path: string, message: string }} PlanProblem
 */

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

/** @param {unknown} value */
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** @param {PlanProblem[]} problems @param {string} code @param {string} path @param {string} message */
function add(problems, code, path, message) {
  problems.push({ code, path, message })
}

/** Exact seconds of a whole frame index at a rational rate. @param {number} frame */
export function frameDurationRational(frame, fpsNumerator, fpsDenominator) {
  if (!Number.isInteger(frame)) throw new ValidationError('帧号必须是整数', { field: 'frame' })
  if (!isPositiveInteger(fpsNumerator) || !isPositiveInteger(fpsDenominator)) {
    throw new ValidationError('帧率必须由正整数分子与分母组成')
  }
  return new Rational(frame * fpsDenominator, fpsNumerator)
}

/** Seconds rounded for display only; the rational value stays authoritative. */
export function frameDurationSeconds(frame, fpsNumerator, fpsDenominator, decimals = 6) {
  return frameDurationRational(frame, fpsNumerator, fpsDenominator).toSeconds(decimals)
}

/**
 * Derived scene layout: start of scene N is the end of scene N−1 minus the overlap.
 *
 * @param {{ scenes: Array<{id: string, timeline: {durationFrames: number}}>, transitions: Array<{id: string,
 * fromScene: string, toScene: string, overlapFrames: number}> }} plan
 * @returns {{ scenes: Array<{ id: string, startFrame: number, durationFrames: number, endFrameExclusive: number,
 * seconds: { start: number, duration: number }, durationRational: string }>, totalFrames: number, totalSeconds:
 * number, overlaps: Array<{ id: string, fromScene: string, toScene: string, startFrame: number, endFrameExclusive:
 * number, frames: number }>, totalRational: string }}
 */
export function deriveLayout(plan) {
  const fpsNumerator = plan?.timebase?.fpsNumerator
  const fpsDenominator = plan?.timebase?.fpsDenominator
  if (!isPositiveInteger(fpsNumerator) || !isPositiveInteger(fpsDenominator)) {
    throw new ValidationError('派生时间线需要合法的帧率分子与分母')
  }
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : []
  const transitions = Array.isArray(plan.transitions) ? plan.transitions : []
  const transitionByFrom = new Map()
  for (const transition of transitions) {
    if (transitionByFrom.has(transition.fromScene)) {
      throw new ValidationError('同一场景之后存在多个转场', { scene: String(transition.fromScene) })
    }
    transitionByFrom.set(transition.fromScene, transition)
  }

  const laid = []
  const overlaps = []
  let cursor = 0
  scenes.forEach((scene, index) => {
    const duration = scene?.timeline?.durationFrames
    if (!isPositiveInteger(duration)) {
      throw new ValidationError('场景时长必须是正整数帧', { scene: String(scene?.id ?? index) })
    }
    if (index === 0) {
      cursor = 0
    }
    const startFrame = cursor
    const endFrameExclusive = startFrame + duration
    const next = transitionByFrom.get(scene.id)
    let advance = duration
    if (next !== undefined) {
      const overlap = next.overlapFrames
      if (!isPositiveInteger(overlap)) {
        throw new ValidationError('转场重叠必须是正整数帧', { transition: String(next.id) })
      }
      if (overlap >= duration) {
        throw new ValidationError('转场重叠不能吃掉整个左侧场景', { transition: String(next.id) })
      }
      overlaps.push({
        id: next.id,
        fromScene: next.fromScene,
        toScene: next.toScene,
        startFrame: endFrameExclusive - overlap,
        endFrameExclusive,
        frames: overlap,
      })
      advance = duration - overlap
    }
    laid.push({
      id: scene.id,
      startFrame,
      durationFrames: duration,
      endFrameExclusive,
      durationRational: frameDurationRational(duration, fpsNumerator, fpsDenominator).toString(),
      seconds: {
        start: frameDurationSeconds(startFrame, fpsNumerator, fpsDenominator),
        duration: frameDurationSeconds(duration, fpsNumerator, fpsDenominator),
      },
    })
    cursor = startFrame + advance
  })

  const totalFrames = laid.length === 0 ? 0 : laid[laid.length - 1].endFrameExclusive
  return {
    scenes: laid,
    totalFrames,
    totalRational: frameDurationRational(totalFrames, fpsNumerator, fpsDenominator).toString(),
    totalSeconds: frameDurationSeconds(totalFrames, fpsNumerator, fpsDenominator),
    overlaps,
  }
}

/**
 * Every structural problem in one pass.
 *
 * @param {any} plan
 * @returns {PlanProblem[]}
 */
export function collectPlanProblems(plan) {
  /** @type {PlanProblem[]} */
  const problems = []
  if (!isPlainObject(plan)) {
    add(problems, 'plan-not-object', '', '计划必须是对象')
    return problems
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(plan.schemaVersion)) {
    add(problems, 'schema-version', 'schemaVersion', `不支持的 schemaVersion：${String(plan.schemaVersion)}`)
  }
  for (const field of ['planId', 'planVersion', 'projectId']) {
    if (!isNonEmptyString(plan[field])) add(problems, 'plan-field', field, `${field} 必须是非空字符串`)
  }
  if (!UNIT_PROFILES.includes(plan.profile)) {
    add(problems, 'profile', 'profile', `未知 UnitProfile：${String(plan.profile)}`)
  }
  if (!PLAN_OPERATIONS.includes(plan.operation)) {
    add(problems, 'operation', 'operation', `未知操作：${String(plan.operation)}`)
  }

  const timebase = plan.timebase
  if (!isPlainObject(timebase)) {
    add(problems, 'timebase', 'timebase', 'timebase 必须是对象')
    return problems
  }
  if (timebase.unit !== 'frame') {
    add(problems, 'timebase-unit', 'timebase.unit', '只支持以整数帧为单位的时间基')
  }
  for (const field of ['fpsNumerator', 'fpsDenominator', 'sampleRate']) {
    if (!isPositiveInteger(timebase[field])) {
      add(problems, 'timebase-rate', `timebase.${field}`, `${field} 必须是正整数`)
    }
  }

  const spec = plan.outputSpec
  if (!isPlainObject(spec)) {
    add(problems, 'output-spec', 'outputSpec', 'outputSpec 必须是对象')
  } else {
    for (const field of ['width', 'height']) {
      if (!isPositiveInteger(spec[field])) {
        add(problems, 'output-size', `outputSpec.${field}`, `${field} 必须是正整数`)
      }
    }
    if (String(spec.pixelFormat ?? '') === '') {
      add(problems, 'output-pixel-format', 'outputSpec.pixelFormat', '必须声明 pixelFormat')
    }
    if (String(spec.videoCodec ?? '') === '') {
      add(problems, 'output-video-codec', 'outputSpec.videoCodec', '必须声明 videoCodec')
    }
  }

  const scenes = plan.scenes
  if (!Array.isArray(scenes) || scenes.length === 0) {
    add(problems, 'scenes', 'scenes', '至少需要一个场景')
    return problems
  }
  const sceneIds = new Set()
  for (const [index, scene] of scenes.entries()) {
    const path = `scenes[${index}]`
    if (!isPlainObject(scene)) {
      add(problems, 'scene-shape', path, '场景必须是对象')
      continue
    }
    if (!isNonEmptyString(scene.id)) add(problems, 'scene-id', `${path}.id`, '场景 id 必须是非空字符串')
    if (sceneIds.has(scene.id)) add(problems, 'scene-id-duplicate', `${path}.id`, '场景 id 重复')
    sceneIds.add(scene.id)
    if (!isPositiveInteger(scene?.timeline?.durationFrames)) {
      add(problems, 'scene-duration', `${path}.timeline.durationFrames`, '场景时长必须是正整数帧')
    }
  }

  const transitions = Array.isArray(plan.transitions) ? plan.transitions : []
  const transitionIds = new Set()
  for (const [index, transition] of transitions.entries()) {
    const path = `transitions[${index}]`
    if (!isPlainObject(transition)) {
      add(problems, 'transition-shape', path, '转场必须是对象')
      continue
    }
    if (!isNonEmptyString(transition.id)) add(problems, 'transition-id', `${path}.id`, '转场 id 必须是非空字符串')
    if (transitionIds.has(transition.id)) add(problems, 'transition-id-duplicate', `${path}.id`, '转场 id 重复')
    transitionIds.add(transition.id)
    if (!TRANSITION_KINDS.includes(transition.kind)) {
      add(problems, 'transition-kind', `${path}.kind`, `未知转场类型：${String(transition.kind)}`)
    }
    if (!sceneIds.has(transition.fromScene)) {
      add(problems, 'transition-from', `${path}.fromScene`, '转场左侧场景不存在')
    }
    if (!sceneIds.has(transition.toScene)) {
      add(problems, 'transition-to', `${path}.toScene`, '转场右侧场景不存在')
    }
    if (!isPositiveInteger(transition.overlapFrames)) {
      add(problems, 'transition-overlap', `${path}.overlapFrames`, '重叠必须是正整数帧')
    }
  }

  // The scene order must be adjustable ONLY through the declared transitions: a start that does
  // not follow the rule means two people edited the same timeline and one edit is now a lie.
  try {
    const layout = deriveLayout(plan)
    const declaredStart = Array.isArray(plan.scenes) ? plan.scenes : []
    for (const [index, laid] of layout.scenes.entries()) {
      const expected = declaredStart[index]?.timeline?.startFrame
      if (expected !== undefined && expected !== laid.startFrame) {
        add(
          problems,
          'scene-start',
          `scenes[${index}].timeline.startFrame`,
          `声明起点 ${String(expected)} 与派生起点 ${laid.startFrame} 不一致`,
        )
      }
    }
    if (timebase.totalFrames !== undefined && timebase.totalFrames !== layout.totalFrames) {
      add(
        problems,
        'total-frames',
        'timebase.totalFrames',
        `声明总帧数 ${String(timebase.totalFrames)} 与派生 ${layout.totalFrames} 不一致`,
      )
    }
  } catch (error) {
    add(problems, 'layout', 'scenes', `无法派生时间线：${error instanceof Error ? error.message : String(error)}`)
    return problems
  }

  // Objects.
  const objects = plan.objects
  if (!Array.isArray(objects)) {
    add(problems, 'objects', 'objects', 'objects 必须是数组')
    return problems
  }
  const objectIds = new Set()
  /** @type {Map<string, any>} */
  const byId = new Map()
  for (const [index, object] of objects.entries()) {
    const path = `objects[${index}]`
    if (!isPlainObject(object)) {
      add(problems, 'object-shape', path, '对象必须是对象')
      continue
    }
    if (!isNonEmptyString(object.id)) {
      add(problems, 'object-id', `${path}.id`, '对象 id 必须是非空字符串')
      continue
    }
    if (objectIds.has(object.id)) add(problems, 'object-id-duplicate', `${path}.id`, '对象 id 重复')
    objectIds.add(object.id)
    byId.set(object.id, object)

    const kindSpec = OBJECT_KINDS[object.kind]
    if (kindSpec === undefined) {
      add(problems, 'object-kind', `${path}.kind`, `未知对象类型：${String(object.kind)}`)
    }
    if (!isNonEmptyString(object.semanticRole)) {
      add(problems, 'object-role', `${path}.semanticRole`, '对象必须有语义角色说明')
    }
    // CT-04 v1.1 §2.1: every object must declare its scope. Defaulting silently would let a
    // cross-cut subtitle end up owned by a scene by accident.
    if (object.scope === undefined) {
      add(problems, 'object-scope-missing', `${path}.scope`, '对象必须显式声明 scope（scene 或 movie）')
    } else if (!['scene', 'movie'].includes(object.scope)) {
      add(problems, 'object-scope-unknown', `${path}.scope`, `未知作用域：${String(object.scope)}`)
    }
    const declaredScope = object.scope ?? kindSpec?.scope
    if (!isNonEmptyString(object.sceneId) && declaredScope === 'scene') {
      add(problems, 'object-scene', `${path}.sceneId`, '场景级对象必须声明所属场景')
    } else if (declaredScope !== 'movie' && !sceneIds.has(object.sceneId)) {
      add(problems, 'object-scene-missing', `${path}.sceneId`, '对象所属场景不存在')
    }
    if (object.scope !== undefined && kindSpec !== undefined && object.scope !== kindSpec.scope) {
      add(
        problems,
        'object-scope-kind',
        `${path}.scope`,
        `${object.kind} 的作用域固定为 ${kindSpec.scope}，不能声明为 ${String(object.scope)}`,
      )
    }
    if (!isNonNegativeInteger(object?.timeline?.startFrame)) {
      add(problems, 'object-start', `${path}.timeline.startFrame`, '对象起点必须是非负整数帧')
    }
    if (!isPositiveInteger(object?.timeline?.durationFrames)) {
      add(problems, 'object-duration', `${path}.timeline.durationFrames`, '对象时长必须是正整数帧')
    }
    if (!Array.isArray(object.editableProps)) {
      add(problems, 'object-editable', `${path}.editableProps`, '对象必须声明可编辑属性列表')
    } else {
      const declared = new Set(object.editableProps)
      for (const prop of declared) {
        if (kindSpec !== undefined && !kindSpec.editableProps.includes(prop)) {
          add(problems, 'object-editable-unknown', `${path}.editableProps`, `${object.kind} 不支持可编辑属性 ${String(prop)}`)
        }
      }
    }
    if (object.hitTest === undefined || object.hitTest === null) {
      add(problems, 'object-hit', `${path}.hitTest`, '对象必须声明命中方式，不能靠猜')
    }
    if (kindSpec !== undefined && object.hitTest !== undefined) {
      const mode = typeof object.hitTest === 'string' ? object.hitTest : object.hitTest?.mode
      if (mode !== kindSpec.hit) {
        add(problems, 'object-hit-mode', `${path}.hitTest`, `${object.kind} 只能使用 ${kindSpec.hit} 命中（声明为 ${String(mode)}）`)
      }
    }
    if (!isNonEmptyString(object.modificationScope)) {
      add(problems, 'object-scope', `${path}.modificationScope`, '对象必须说明修改影响范围')
    }
    if (object.kind === 'video-source-with-offset' || object.kind === 'flattened-video') {
      if (!isNonEmptyString(object?.authored?.sourceFile)) {
        add(problems, 'object-source', `${path}.authored.sourceFile`, '视频对象必须声明源文件')
      }
      if (!isNonNegativeInteger(object?.authored?.sourceOffsetFrames)) {
        add(problems, 'object-source-offset', `${path}.authored.sourceOffsetFrames`, '视频对象必须声明非负的源偏移帧')
      }
    }
    if (object.kind === 'subtitle') {
      if (!isNonEmptyString(object?.derivedFrom?.lockedCopy)) {
        add(problems, 'subtitle-copy', `${path}.derivedFrom.lockedCopy`, '字幕必须引用锁定文案段落')
      }
      if (!isNonEmptyString(object?.params?.text)) {
        add(problems, 'subtitle-text', `${path}.params.text`, '字幕必须有实际文本')
      }
    }
  }

  // Scene membership: a scene lists its own scene-scoped objects, never a movie-level one.
  for (const [index, scene] of scenes.entries()) {
    if (!isPlainObject(scene) || !Array.isArray(scene.objects)) {
      add(problems, 'scene-objects', `scenes[${index}].objects`, '场景必须声明对象列表')
      continue
    }
    for (const id of scene.objects) {
      const listed = byId.get(id)
      if (!objectIds.has(id)) {
        add(problems, 'scene-object-missing', `scenes[${index}].objects`, `场景引用了不存在的对象 ${String(id)}`)
      } else if ((listed?.scope ?? OBJECT_KINDS[listed?.kind]?.scope) === 'movie') {
        // Checked before the scene-id mismatch: a movie object has no scene, and reporting it as a
        // mismatch would hide the real rule that it must not be in a scene list at all.
        add(
          problems,
          'scene-object-movie-scope',
          `scenes[${index}].objects`,
          `影片级对象 ${String(id)} 不应挂在单个场景下，应登记在 tracks`,
        )
      } else if (listed?.sceneId !== scene.id) {
        add(problems, 'scene-object-mismatch', `scenes[${index}].objects`, `对象 ${String(id)} 声明的场景不是 ${String(scene.id)}`)
      }
    }
    const claimed = objects
      .filter((object) => object?.sceneId === scene.id && (object?.scope ?? OBJECT_KINDS[object?.kind]?.scope) === 'scene')
      .map((object) => object.id)
    for (const id of claimed) {
      if (!scene.objects.includes(id)) {
        add(problems, 'scene-object-unlisted', `scenes[${index}].objects`, `对象 ${id} 声称属于本场景但未被列出`)
      }
    }
  }

  // Movie-level objects (subtitles, audio) must be reachable from exactly one track.
  const tracks = Array.isArray(plan.tracks) ? plan.tracks : []
  const trackIds = new Set()
  /** @type {Map<string, string>} */
  const trackOfObject = new Map()
  for (const [index, track] of tracks.entries()) {
    const path = `tracks[${index}]`
    if (!isPlainObject(track)) {
      add(problems, 'track-shape', path, '轨道必须是对象')
      continue
    }
    if (!isNonEmptyString(track.id)) add(problems, 'track-id', `${path}.id`, '轨道 id 必须是非空字符串')
    if (trackIds.has(track.id)) add(problems, 'track-id-duplicate', `${path}.id`, '轨道 id 重复')
    trackIds.add(track.id)
    if (!Array.isArray(track.objectIds)) {
      add(problems, 'track-objects', `${path}.objectIds`, '轨道必须声明 objectIds 数组')
      continue
    }
    for (const id of track.objectIds) {
      if (!objectIds.has(id)) {
        add(problems, 'track-object-missing', `${path}.objectIds`, `轨道引用了不存在的对象 ${String(id)}`)
        continue
      }
      if (trackOfObject.has(id)) {
        add(problems, 'track-object-duplicate', `${path}.objectIds`, `对象 ${String(id)} 同时属于多条轨道`)
      }
      trackOfObject.set(id, track.id)
    }
  }
  for (const object of objects) {
    const scope = object?.scope ?? OBJECT_KINDS[object?.kind]?.scope
    if (scope !== 'movie' || !isNonEmptyString(object?.id)) continue
    if (!trackOfObject.has(object.id)) {
      add(problems, 'movie-object-untracked', `objects.${object.id}`, `影片级对象 ${object.id} 必须登记在某条轨道上`)
    }
  }

  // An object must live inside its scene window, and inside the movie.
  /** @type {Map<string, any>} */
  const sceneById = new Map(scenes.filter((scene) => isPlainObject(scene)).map((scene) => [scene.id, scene]))
  let layout = null
  try {
    layout = deriveLayout(plan)
  } catch {
    layout = null
  }
  if (layout !== null) {
    const laidById = new Map(layout.scenes.map((scene) => [scene.id, scene]))
    for (const object of objects) {
      if (!isPlainObject(object) || !isNonEmptyString(object.id)) continue
      const start = object?.timeline?.startFrame
      const duration = object?.timeline?.durationFrames
      if (!isNonNegativeInteger(start) || !isPositiveInteger(duration)) continue
      const kindSpec = OBJECT_KINDS[object.kind]
      const scope = object.scope ?? kindSpec?.scope
      const scene = sceneById.get(object.sceneId)
      if (scene !== undefined && kindSpec !== undefined && scope === 'scene') {
        const laid = laidById.get(object.sceneId)
        if (laid !== undefined) {
          const end = start + duration
          if (start < laid.startFrame || end > laid.endFrameExclusive) {
            add(
              problems,
              'object-outside-scene',
              `objects.${object.id}.timeline`,
              `对象 ${object.id} [${start}, ${end}) 超出场景 ${object.sceneId} [${laid.startFrame}, ${laid.endFrameExclusive})`,
            )
          }
        }
      }
      if (start + duration > layout.totalFrames) {
        add(
          problems,
          'object-outside-movie',
          `objects.${object.id}.timeline`,
          `对象 ${object.id} 越过影片总时长 ${layout.totalFrames}`,
        )
      }
    }
  }

  // Sound manifest consistency: durations come from a probe, not from character counts.
  const sound = plan.soundManifest
  if (sound !== undefined && sound !== null) {
    if (!isPlainObject(sound)) {
      add(problems, 'sound-shape', 'soundManifest', 'soundManifest 必须是对象')
    } else {
      if (!Array.isArray(sound.segments)) {
        add(problems, 'sound-segments', 'soundManifest.segments', 'soundManifest 必须声明 segments 数组')
      } else {
        const paragraphIds = new Set()
        for (const [index, segment] of sound.segments.entries()) {
          const path = `soundManifest.segments[${index}]`
          if (!isNonEmptyString(segment?.paragraphId)) {
            add(problems, 'sound-paragraph', `${path}.paragraphId`, '段落必须有 paragraphId')
          } else if (paragraphIds.has(segment.paragraphId)) {
            add(problems, 'sound-paragraph-duplicate', `${path}.paragraphId`, '段落 id 重复')
          } else {
            paragraphIds.add(segment.paragraphId)
          }
          const probe = segment?.actualDurationSeconds
          if (typeof probe !== 'number' || !(probe > 0)) {
            add(problems, 'sound-duration', `${path}.actualDurationSeconds`, '实际时长必须来自 probe 的正数')
          }
          if (segment?.wordLevel !== undefined && segment?.wordLevel !== null) {
            add(
              problems,
              'sound-word-level',
              `${path}.wordLevel`,
              '没有真实词级时间时不得声明 wordLevel（本产品不做 ASR）',
            )
          }
        }
      }
    }
  }

  return problems
}

/**
 * Normalize a plan: validate, then return a canonical copy with derived fields filled in.
 *
 * @param {any} input
 * @param {{ now?: () => string }} [options] optional clock ISO source, recorded, never guessed
 * @returns {any}
 */
export function normalizePlan(input, options = {}) {
  const problems = collectPlanProblems(input)
  if (problems.length > 0) {
    throw new ValidationError('CompositionPlan 校验失败', {
      details: { problems },
    })
  }
  const layout = deriveLayout(input)
  const plan = {
    ...input,
    schemaVersion: PLAN_SCHEMA_VERSION,
    timebase: {
      ...input.timebase,
      unit: 'frame',
      totalFrames: layout.totalFrames,
      totalRational: layout.totalRational,
      totalSeconds: layout.totalSeconds,
    },
    scenes: input.scenes.map((scene) => {
      const laid = layout.scenes.find((entry) => entry.id === scene.id)
      return {
        ...scene,
        timeline: {
          ...scene.timeline,
          startFrame: laid.startFrame,
          endFrameExclusive: laid.endFrameExclusive,
        },
        seconds: { start: laid.seconds.start, duration: laid.seconds.duration },
      }
    }),
    transitions: input.transitions.map((transition) => {
      const overlap = layout.overlaps.find((entry) => entry.id === transition.id)
      const fromScene = layout.scenes.find((entry) => entry.id === transition.fromScene)
      const toScene = layout.scenes.find((entry) => entry.id === transition.toScene)
      return {
        ...transition,
        shortensTotalDuration: transition.shortensTotalDuration !== false,
        startFrame: overlap.startFrame,
        endFrameExclusive: overlap.endFrameExclusive,
        overlapRational: frameDurationRational(
          transition.overlapFrames,
          input.timebase.fpsNumerator,
          input.timebase.fpsDenominator,
        ).toString(),
        fromStart: fromScene.startFrame,
        toStart: toScene.startFrame,
        cutPoint: overlap.startFrame,
      }
    }),
    objects: input.objects.map((object) => ({
      ...object,
      scope: object.scope ?? OBJECT_KINDS[object.kind].scope,
      timeline: {
        ...object.timeline,
        endFrameExclusive: object.timeline.startFrame + object.timeline.durationFrames,
      },
    })),
    normalizedAt: options.now === undefined ? (input.normalizedAt ?? null) : options.now(),
  }
  return plan
}

/**
 * Hash a possibly-missing value. `contentHash(undefined)` is not a hash — undefined is a real,
 * distinct state ("field absent") and must hash as such instead of throwing.
 * @param {unknown} value
 */
function hashOf(value) {
  return contentHash(value === undefined ? null : value)
}

/**
 * Stable content hash of the plan's semantic content, ignoring bookkeeping fields. */
export function planFingerprint(plan) {
  const copy = { ...plan }
  delete copy.normalizedAt
  delete copy.lockedAt
  return contentHash(copy)
}

/**
 * Semantic diff between two plan versions.
 *
 * Used by RepairOperation to prove that only the declared target changed, and by AdaptOperation to
 * prove that timing and audio were preserved. It compares meaning (ids, timelines, params), never
 * the whole-file hash, because a re-encoded file hash says nothing about semantic damage (CT-05 §7).
 *
 * @param {any} base
 * @param {any} next
 * @returns {{
 *   identical: boolean,
 *   outputChanged: boolean,
 *   timebaseChanged: boolean,
 *   scenes: { added: string[], removed: string[], changed: Array<{ id: string, fields: string[] }> },
 *   transitions: { added: string[], removed: string[], changed: Array<{ id: string, fields: string[] }> },
 * objects: { added: string[], removed: string[], changed: Array<{ id: string, fields: string[], startFrame: number,
 * endFrameExclusive: number }> },
 *   soundChanged: boolean,
 *   changedObjectIds: string[],
 *   changedFrames: Array<{ startFrame: number, endFrameExclusive: number, reason: string }>,
 *   protectedObjectIds: string[],
 * }}
 */
export function diffPlans(base, next) {
  const baseObjects = new Map((base.objects ?? []).map((object) => [object.id, object]))
  const nextObjects = new Map((next.objects ?? []).map((object) => [object.id, object]))
  const added = [...nextObjects.keys()].filter((id) => !baseObjects.has(id))
  const removed = [...baseObjects.keys()].filter((id) => !nextObjects.has(id))
  /** @type {Array<{ id: string, fields: string[], startFrame: number, endFrameExclusive: number }>} */
  const changed = []
  /** @type {Array<{ startFrame: number, endFrameExclusive: number, reason: string }>} */
  const changedFrames = []

  for (const [id, nextObject] of nextObjects.entries()) {
    const baseObject = baseObjects.get(id)
    if (baseObject === undefined) {
      changedFrames.push({
        startFrame: nextObject.timeline.startFrame,
        endFrameExclusive: nextObject.timeline.startFrame + nextObject.timeline.durationFrames,
        reason: `新增对象 ${id}`,
      })
      continue
    }
    const fields = []
    for (const key of ['kind', 'sceneId', 'params', 'authored', 'editableProps', 'modificationScope', 'hitTest']) {
      if (hashOf(baseObject[key]) !== hashOf(nextObject[key])) fields.push(key)
    }
    const baseStart = baseObject.timeline.startFrame
    const nextStart = nextObject.timeline.startFrame
    const baseDuration = baseObject.timeline.durationFrames
    const nextDuration = nextObject.timeline.durationFrames
    if (baseStart !== nextStart) fields.push('timeline.startFrame')
    if (baseDuration !== nextDuration) fields.push('timeline.durationFrames')
    if (fields.length > 0) {
      const startFrame = Math.min(baseStart, nextStart)
      const endFrameExclusive = Math.max(baseStart + baseDuration, nextStart + nextDuration)
      changed.push({ id, fields, startFrame, endFrameExclusive })
      changedFrames.push({ startFrame, endFrameExclusive, reason: `对象 ${id} 变更：${fields.join('、')}` })
    }
  }
  for (const [id, baseObject] of baseObjects.entries()) {
    if (nextObjects.has(id)) continue
    changedFrames.push({
      startFrame: baseObject.timeline.startFrame,
      endFrameExclusive: baseObject.timeline.startFrame + baseObject.timeline.durationFrames,
      reason: `删除对象 ${id}`,
    })
  }

  const sceneDiff = diffById(base.scenes ?? [], next.scenes ?? [], ['label', 'timeline', 'objects'])
  const transitionDiff = diffById(base.transitions ?? [], next.transitions ?? [], ['kind', 'overlapFrames', 'fromScene', 'toScene'])

  const changedObjectIds = [...new Set([...added, ...removed, ...changed.map((entry) => entry.id)])]
  const protectedObjectIds = (base.objects ?? [])
    .map((object) => object.id)
    .filter((id) => !changedObjectIds.includes(id))

  return {
    identical:
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      sceneDiff.added.length === 0 &&
      sceneDiff.removed.length === 0 &&
      sceneDiff.changed.length === 0 &&
      transitionDiff.added.length === 0 &&
      transitionDiff.removed.length === 0 &&
      transitionDiff.changed.length === 0 &&
      hashOf(base.outputSpec) === hashOf(next.outputSpec) &&
      hashOf(base.timebase) === hashOf(next.timebase) &&
      hashOf(base.soundManifest) === hashOf(next.soundManifest),
    outputChanged: hashOf(base.outputSpec) !== hashOf(next.outputSpec),
    timebaseChanged: hashOf(base.timebase) !== hashOf(next.timebase),
    scenes: sceneDiff,
    transitions: transitionDiff,
    objects: { added, removed, changed },
    soundChanged: hashOf(base.soundManifest) !== hashOf(next.soundManifest),
    changedObjectIds,
    changedFrames,
    protectedObjectIds,
  }
}

/**
 * Diff two id-keyed lists by the given fields.
 * @param {any[]} base
 * @param {any[]} next
 * @param {string[]} fields
 */
function diffById(base, next, fields) {
  const baseById = new Map(base.map((entry) => [entry?.id, entry]))
  const nextById = new Map(next.map((entry) => [entry?.id, entry]))
  const added = [...nextById.keys()].filter((id) => !baseById.has(id))
  const removed = [...baseById.keys()].filter((id) => !nextById.has(id))
  const changed = []
  for (const [id, nextEntry] of nextById.entries()) {
    const baseEntry = baseById.get(id)
    if (baseEntry === undefined) continue
    const differing = fields.filter((field) => hashOf(baseEntry[field]) !== hashOf(nextEntry[field]))
    if (differing.length > 0) changed.push({ id, fields: differing })
  }
  return { added, removed, changed }
}

/**
 * Assert a diff stayed inside a declared repair scope.
 *
 * @param {ReturnType<typeof diffPlans>} diff
 * @param {{ targetObjectIds: string[], allowSceneChanges?: boolean, allowSoundChanges?: boolean }} scope
 * @returns {{ ok: boolean, violations: Array<{ rule: string, detail: string }> }}
 */
export function assertRepairScope(diff, scope) {
  const allowed = new Set(scope.targetObjectIds ?? [])
  /** @type {Array<{ rule: string, detail: string }>} */
  const violations = []
  for (const id of diff.changedObjectIds) {
    if (!allowed.has(id)) violations.push({ rule: 'changed-outside-target', detail: `未授权对象被修改：${id}` })
  }
  if (diff.timebaseChanged && scope.allowTimebaseChanges !== true) {
    violations.push({ rule: 'timebase-changed', detail: '修复不得改变时间基或总时长' })
  }
  if (diff.outputChanged && scope.allowOutputChanges !== true) {
    violations.push({ rule: 'output-changed', detail: '修复不得改变输出规格' })
  }
  if (diff.soundChanged && scope.allowSoundChanges !== true) {
    violations.push({ rule: 'sound-changed', detail: '修复不得改变声音清单' })
  }
  if ((diff.scenes.added.length > 0 || diff.scenes.removed.length > 0) && scope.allowSceneChanges !== true) {
    violations.push({ rule: 'scene-structure-changed', detail: '修复不得增删场景' })
  }
  if (
    (diff.transitions.added.length > 0 || diff.transitions.removed.length > 0) &&
    scope.allowTransitionChanges !== true
  ) {
    violations.push({ rule: 'transition-structure-changed', detail: '修复不得增删转场' })
  }
  return { ok: violations.length === 0, violations }
}
