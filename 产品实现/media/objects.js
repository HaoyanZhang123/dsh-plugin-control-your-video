/**
 * Object identity and on-screen mapping.
 *
 * Contract (CT-05): a user object id must resolve to a plan node, a runtime reference, a
 * structure position, a picture region or hit mode, its editable properties, its modification
 * scope and its evidence. A rendered pixel is not an object, and a flattened video is not a
 * container of hidden native objects — this module refuses to pretend otherwise.
 *
 * @module media/objects
 */

import { ValidationError } from '../base/index.js'
import { OBJECT_KINDS } from './plan.js'
import { activeObjectsAt, layoutOf, objectOf, objectWindow } from './timeline.js'

/** Hit modes that describe a picture region honestly. */
export const HIT_MODES = Object.freeze(['rect', 'text-box', 'canvas-region', 'timeline-track'])

/**
 * The only granularity a flattened external video exposes.
 * It is a clip with a range and a commentable region; the people and words inside stay pixels.
 */
export const FLATTENED_GRANULARITY = Object.freeze({
  internalObjects: 0,
  selectable: ['clip', 'time-range', 'region'],
  notSelectable: ['person', 'text', 'object', 'layer'],
  claim: '压平外部视频只暴露片段、时间范围和区域引用，不虚构内部原生对象',
})

/**
 * Geometry of an object in output pixels. Objects without a box (audio tracks) have none:
 * a missing box must not be invented as "somewhere in the frame".
 * @param {any} object
 * @param {{ width: number, height: number }} frameSize
 */
export function geometryOf(object, frameSize) {
  if (object.hitTest === 'timeline-track') return null
  const box = object.box
  if (box === undefined || box === null) {
    // Full-frame objects may omit the box; anything else without a box is a mapping defect.
    if (object.kind === 'solid') {
      return { mode: 'rect', x: 0, y: 0, width: frameSize.width, height: frameSize.height }
    }
    throw new ValidationError('对象缺少可命中的区域，不能凭空生成命中框', { objectId: String(object.id) })
  }
  const width = Number(box.width)
  const height = Number(box.height)
  if (!(width > 0) || !(height > 0)) {
    throw new ValidationError('对象命中框尺寸必须为正', { objectId: String(object.id) })
  }
  return {
    mode: object.hitTest,
    x: Number(box.x ?? 0),
    y: Number(box.y ?? 0),
    width,
    height,
  }
}

/**
 * Build the identity registry: one record per object, in plan order.
 *
 * @param {any} plan normalized plan
 * @returns {Map<string, any>}
 */
export function buildObjectRegistry(plan) {
  const layout = layoutOf(plan)
  const frameSize = { width: plan.outputSpec.width, height: plan.outputSpec.height }
  const sceneOrder = new Map(layout.scenes.map((scene, index) => [scene.id, index]))
  const trackOf = new Map()
  for (const track of plan.tracks ?? []) {
    for (const id of track.objectIds ?? []) trackOf.set(id, track)
  }
  const registry = new Map()
  plan.objects.forEach((object, index) => {
    const kindSpec = OBJECT_KINDS[object.kind]
    if (kindSpec === undefined) {
      throw new ValidationError('未知对象类型无法登记', { objectId: object.id, kind: String(object.kind) })
    }
    const scope = object.scope ?? kindSpec.scope
    const track = trackOf.get(object.id) ?? null
    const window = objectWindow(plan, object.id)
    const record = {
      objectId: object.id,
      kind: object.kind,
      kindLabel: kindSpec.label,
      semanticRole: object.semanticRole,
      scope,
      sceneId: object.sceneId ?? null,
      planNodePath: `objects[${index}]`,
      runtimeRef: {
        runtimeId: plan.runtimeId ?? null,
        runtimeVersion: plan.runtimeVersion ?? null,
        // A stable, human-auditable handle the adapter must honour; not a DOM selector claim.
        handle: `${plan.runtimeId ?? 'runtime'}://object/${object.id}`,
      },
      structure: {
        sceneId: object.sceneId ?? null,
        sceneIndex: sceneOrder.get(object.sceneId) ?? null,
        track: track === null ? null : { id: track.id, kind: track.kind ?? null },
        index,
        zIndex: object.zIndex ?? 0,
      },
      window,
      hitTest: { mode: object.hitTest, geometry: geometryOf(object, frameSize) },
      editableProps: [...object.editableProps],
      modificationScope: object.modificationScope,
      evidenceRefs: [...(object.evidenceRefs ?? [])],
      flattened: object.kind === 'flattened-video' ? { ...FLATTENED_GRANULARITY } : null,
      canvas: object.kind === 'canvas-program-animation'
        ? {
            regionOnly: true,
            note: 'Canvas 只能按已登记区域命中，不能声称逐粒子或逐绘元可选',
          }
        : null,
    }
    registry.set(object.id, record)
  })
  return registry
}

/**
 * Whether a point hits a geometry, with `[x, x+w)` half-open bounds.
 * @param {{ x: number, y: number, width: number, height: number }} geometry
 * @param {{ x: number, y: number }} point
 */
function contains(geometry, point) {
  return (
    point.x >= geometry.x &&
    point.x < geometry.x + geometry.width &&
    point.y >= geometry.y &&
    point.y < geometry.y + geometry.height
  )
}

/**
 * Picture hit at one frame, topmost first.
 *
 * Hit testing never invents objects: if the point is inside no registered region, the caller must
 * fall back to the structure tree instead of guessing (CT-05 §3).
 *
 * @param {any} plan
 * @param {number} movieFrame
 * @param {{ x: number, y: number }} point
 * @returns {{ frame: number, point: { x: number, y: number }, hits: Array<any>, topmost: any|null, fallback:
 * string|null }}
 */
export function hitTest(plan, movieFrame, point) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw new ValidationError('命中点需要有限坐标', { field: 'point' })
  }
  const frameSize = { width: plan.outputSpec.width, height: plan.outputSpec.height }
  if (point.x < 0 || point.y < 0 || point.x >= frameSize.width || point.y >= frameSize.height) {
    return { frame: movieFrame, point, hits: [], topmost: null, fallback: '结构树' }
  }
  const visible = activeObjectsAt(plan, movieFrame)
  const hits = []
  for (const object of visible) {
    if (object.hitTest === 'timeline-track') continue
    const geometry = geometryOf(object, frameSize)
    if (geometry === null) continue
    if (contains(geometry, point)) {
      hits.push({
        objectId: object.id,
        kind: object.kind,
        mode: geometry.mode,
        zoom: null,
        region: { ...geometry },
        precisionNote:
          object.kind === 'canvas-program-animation'
            ? '区域命中：Canvas 内单个粒子/绘制元素不可单独选中'
            : object.kind === 'flattened-video'
              ? '片段命中：压平视频内部没有独立原生对象'
              : null,
      })
    }
  }
  // Draw order is painter's order: the last drawn object is what the user sees on top.
  const topmost = hits.length === 0 ? null : hits[hits.length - 1]
  return {
    frame: movieFrame,
    point,
    hits,
    topmost,
    fallback: topmost === null ? '结构树' : null,
  }
}

/**
 * Four-way selection: structure, picture, properties and time must name the same object.
 *
 * @param {any} plan
 * @param {{ objectId: string, frame: number, point?: {x:number,y:number} }} input
 */
export function describeSelection(plan, input) {
  const registry = buildObjectRegistry(plan)
  const record = registry.get(input.objectId)
  if (record === undefined) throw new ValidationError('计划中没有这个对象', { objectId: String(input.objectId) })
  const window = record.window
  const frameInside = input.frame >= window.startFrame && input.frame < window.endFrameExclusive
  const picture =
    input.point === undefined
      ? null
      : hitTest(plan, input.frame, input.point)
  return {
    objectId: record.objectId,
    structure: {
      path: record.planNodePath,
      scene: record.structure.sceneId,
      track: record.structure.track?.id ?? null,
      matches: true,
    },
    picture: {
      queried: picture !== null,
      frame: input.frame,
      topmost: picture?.topmost?.objectId ?? null,
      hit: picture === null ? null : picture.hits.some((entry) => entry.objectId === record.objectId),
      region: record.hitTest.geometry,
      mode: record.hitTest.mode,
    },
    properties: {
      editableProps: record.editableProps,
      origin: record.planNodePath,
    },
    time: {
      frame: input.frame,
      insideWindow: frameInside,
      window,
      windowText: `[${window.startFrame}, ${window.endFrameExclusive})`,
    },
    consistent:
      frameInside &&
      (picture === null ||
        (picture.topmost !== null && picture.topmost.objectId === record.objectId
          ? true
          : picture.hits.some((entry) => entry.objectId === record.objectId))),
  }
}

/**
 * What editing one object may touch.
 *
 * `protected` is computed from the plan, not hand-written: every other object is protected unless
 * the caller declares a dependency (for example a shared component's instances).
 *
 * @param {any} plan
 * @param {string} objectId
 */
export function editScopeOf(plan, objectId) {
  const registry = buildObjectRegistry(plan)
  const record = registry.get(objectId)
  if (record === undefined) throw new ValidationError('计划中没有这个对象', { objectId: String(objectId) })
  const protectedIds = plan.objects.map((object) => object.id).filter((id) => id !== objectId)
  const layout = layoutOf(plan)
  if (record.scope === 'movie') {
    // CT-04 v1.1 §2.1 rule 5: editing a movie object touches every scene it covers. The impact must
    // name the scenes, the scene objects it overlaps, the audio and the total duration up front.
    const window = record.window
    const affectedScenes = layout.scenes
      .filter((scene) => scene.startFrame < window.endFrameExclusive && scene.endFrameExclusive > window.startFrame)
      .map((scene) => scene.id)
    const overlappingSceneObjects = plan.objects
      .filter((object) => (object.scope ?? 'scene') === 'scene')
      .filter((object) => {
        const start = object.timeline.startFrame
        const end = start + object.timeline.durationFrames
        return start < window.endFrameExclusive && end > window.startFrame
      })
      .map((object) => object.id)
    return {
      objectId,
      scope: 'movie',
      editableProps: record.editableProps,
      affected: [objectId],
      affectedScenes,
      overlappingSceneObjects,
      protected: protectedIds,
      renderScope: '整单元重渲；影片级对象的改动必须逐场景检查遮挡、裁切与总时长',
      window,
      totalDurationFrames: layout.totalFrames,
      audioProtected: true,
    }
  }
  return {
    objectId,
    scope: 'scene',
    editableProps: record.editableProps,
    affected: [objectId],
    affectedScenes: record.sceneId === null ? [] : [record.sceneId],
    overlappingSceneObjects: [],
    protected: protectedIds,
    renderScope: '整单元重渲，但只允许该对象的语义变化',
    window: record.window,
    totalDurationFrames: layout.totalFrames,
    audioProtected: true,
  }
}

/**
 * Assert a property may be edited on this object.
 * @param {any} plan
 * @param {string} objectId
 * @param {string} prop
 */
export function assertEditable(plan, objectId, prop) {
  const object = objectOf(plan, objectId)
  if (!Array.isArray(object.editableProps) || !object.editableProps.includes(prop)) {
    throw new ValidationError('该属性不在对象的可编辑范围内', {
      objectId,
      prop: String(prop),
      editableProps: object.editableProps ?? [],
    })
  }
  return true
}

/**
 * Describe a flattened external clip's real granularity.
 * @param {any} plan
 * @param {string} objectId
 */
export function describeFlattened(plan, objectId) {
  const object = objectOf(plan, objectId)
  if (object.kind !== 'flattened-video') {
    throw new ValidationError('该对象不是压平外部视频', { objectId })
  }
  return {
    objectId,
    ...FLATTENED_GRANULARITY,
    range: objectWindow(plan, objectId),
    region: geometryOf(object, { width: plan.outputSpec.width, height: plan.outputSpec.height }),
  }
}

/** The plan output frame size. */
export function frameSizeOf(plan) {
  return { width: plan.outputSpec.width, height: plan.outputSpec.height }
}
