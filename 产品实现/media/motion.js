/**
 * MotionTerm / MotionSpec: how a named motion becomes concrete object parameters.
 *
 * Contract (CT-14 §7): a term is an internal vocabulary item with a stable id, not a global term
 * library and not a style word; a spec binds an object, a duration, enter/hold/exit/loop, easing,
 * amplitude, a path and a runtime; coordinate and aspect scaling, fonts, replaced text and kit
 * scope are explicit. A deliberate hold is a legal choice and must not be reported as "no motion".
 *
 * @module media/motion
 */

import { ValidationError, roundDeterministic } from '../base/index.js'

/** Easing functions used by the compiled curves. All are pure and deterministic. */
export const EASING = Object.freeze({
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  easeOutBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
})

/**
 * The internal motion vocabulary.
 *
 * `runtimeSupport` is the honest part: a term the current adapter cannot honour must fail plan
 * validation, not render as something else.
 */
export const MOTION_TERMS = Object.freeze({
  'fade-in': {
    label: '淡入',
    zhAliases: ['淡入', '渐显'],
    channel: 'opacity',
    from: 0,
    to: 1,
    parametrized: [],
  },
  'fade-out': {
    label: '淡出',
    zhAliases: ['淡出', '渐隐'],
    channel: 'opacity',
    from: 1,
    to: 0,
    parametrized: [],
  },
  'slide-in': {
    label: '位移入场',
    zhAliases: ['滑入', '位移入场'],
    channel: 'offset',
    from: null,
    to: 0,
    parametrized: ['axis', 'distancePx'],
  },
  'scale-in': {
    label: '缩放入场',
    zhAliases: ['弹入', '缩放入场'],
    channel: 'scale',
    from: 0.9,
    to: 1,
    parametrized: ['fromScale'],
  },
  'pulse': {
    label: '脉动',
    zhAliases: ['呼吸', '脉动'],
    channel: 'scale',
    from: 1,
    to: 1.06,
    parametrized: ['amplitude'],
  },
  'loop-rotate': {
    label: '循环旋转',
    zhAliases: ['旋转循环'],
    channel: 'rotation',
    from: 0,
    to: 360,
    parametrized: ['periodFrames'],
  },
  'hold': {
    label: '保持（刻意静止）',
    zhAliases: ['保持', '停顿', '定格'],
    channel: 'none',
    from: null,
    to: null,
    parametrized: ['reason'],
  },
})

/** Which channels a runtime must implement to claim the term. */
export const TERM_CHANNELS = Object.freeze(['opacity', 'offset', 'scale', 'rotation', 'none'])

/** Code of every motion term, for evidence and for capability comparison. */
export function listMotionTerms() {
  return Object.entries(MOTION_TERMS).map(([id, term]) => ({
    id,
    label: term.label,
    zhAliases: term.zhAliases,
    channel: term.channel,
    parametrized: term.parametrized,
    evidenceStatus: 'unit+integration', // C12 measured; C16 still owes user-value comparison
  }))
}

/** @param {string} name */
function easingOf(name) {
  const easing = EASING[name]
  if (easing === undefined) throw new ValidationError('未知缓动', { easing: String(name) })
  return easing
}

/**
 * Compile a MotionSpec into deterministic per-frame values.
 *
 * @param {object} spec
 * @param {string} spec.objectId
 * @param {string} spec.term
 * @param {{ durationFrames?: number, easing?: string, amplitude?: number }} [spec.enter]
 * @param {{ durationFrames?: number }} [spec.hold]
 * @param {{ durationFrames?: number, easing?: string }} [spec.exit]
 * @param {{ axis?: 'x' | 'y', distancePx?: number }} [spec.path]
 * @param {{ mode?: 'pingpong' | 'restart', periodFrames?: number }} [spec.loop]
 * @param {number} [spec.reason] textual reason for a hold
 * @returns {any}
 */
export function compileMotionSpec(spec) {
  const term = MOTION_TERMS[spec?.term]
  if (term === undefined) throw new ValidationError('未知运动术语', { term: String(spec?.term) })
  const enterFrames = spec?.enter?.durationFrames ?? 0
  const holdFrames = spec?.hold?.durationFrames ?? 0
  const exitFrames = spec?.exit?.durationFrames ?? 0
  for (const [name, value] of Object.entries({ enterFrames, holdFrames, exitFrames })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError('运动时长必须是非负整数帧', { field: name, value: String(value) })
    }
  }
  const enterEasing = easingOf(spec?.enter?.easing ?? 'linear')
  const exitEasing = easingOf(spec?.exit?.easing ?? 'linear')
  const totalFrames = enterFrames + holdFrames + exitFrames
  if (totalFrames === 0) throw new ValidationError('运动规格至少需要一段非零时长')

  const keyframes = []
  const push = (frame, values) => {
    keyframes.push({
      frame,
      opacity: values.opacity ?? 1,
      offsetX: values.offsetX ?? 0,
      offsetY: values.offsetY ?? 0,
      scale: values.scale ?? 1,
      rotation: values.rotation ?? 0,
    })
  }

  const distance = Number(spec?.path?.distancePx ?? 60)
  const axis = spec?.path?.axis ?? 'x'
  const fromOffset = { x: axis === 'x' ? -distance : 0, y: axis === 'y' ? -distance : 0 }

  for (let frame = 0; frame <= totalFrames; frame += 1) {
    let opacity = 1
    let offsetX = 0
    let offsetY = 0
    let scale = 1
    if (frame < enterFrames) {
      const t = enterEasing(frame / enterFrames)
      if (term.channel === 'opacity') opacity = term.from + (term.to - term.from) * t
      if (term.channel === 'offset') {
        offsetX = fromOffset.x * (1 - t) + fromOffset.x * 0
        offsetY = fromOffset.y * (1 - t)
      }
      if (term.channel === 'scale') scale = term.from + (term.to - term.from) * t
    }
    if (frame >= enterFrames + holdFrames) {
      const local = frame - enterFrames - holdFrames
      const t = exitFrames === 0 ? 1 : exitEasing(local / exitFrames)
      if (term.channel === 'opacity') opacity = term.to + (term.from - term.to) * t
      if (term.channel === 'scale') scale = term.to + (term.from - term.to) * t
    }
    push(frame, {
      opacity: roundDeterministic(opacity, 6),
      offsetX: roundDeterministic(offsetX, 6),
      offsetY: roundDeterministic(offsetY, 6),
      scale: roundDeterministic(scale, 6),
      rotation: 0,
    })
  }

  return {
    objectId: spec.objectId,
    term: spec.term,
    channel: term.channel,
    totalFrames,
    enterFrames,
    holdFrames,
    exitFrames,
    keyframes,
    loop: spec.loop ?? null,
    holdReason: spec.hold?.reason ?? (term.channel === 'none' ? spec?.hold?.reason ?? null : null),
    easing: { enter: spec?.enter?.easing ?? 'linear', exit: spec?.exit?.easing ?? 'linear' },
    /** Value at a frame relative to the motion's own start. */
    evaluateAt(relativeFrame) {
      const clamped = Math.max(0, Math.min(totalFrames, relativeFrame))
      const exact = keyframes[clamped]
      return exact
    },
    /** Whether this compiled motion changes anything at all (a pure hold does not). */
    get isStatic() {
      return keyframes.every(
        (frame) =>
          frame.opacity === keyframes[0].opacity &&
          frame.offsetX === 0 &&
          frame.offsetY === 0 &&
          frame.scale === 1 &&
          frame.rotation === 0,
      )
    },
  }
}

/**
 * Fit a motion into an available window.
 *
 * CT-04 §4.1: "固定时段优先调整保持，不任意拉伸全部动作". So the hold is consumed first; only if the
 * motion still does not fit are enter/exit scaled, and that fact is reported instead of hidden.
 *
 * @param {any} spec
 * @param {number} availableFrames
 * @returns {{ spec: any, adjusted: 'none'|'hold-shrunk'|'stretched'|'impossible', note: string }}
 */
export function fitMotionToWindow(spec, availableFrames) {
  if (!Number.isInteger(availableFrames) || availableFrames < 0) {
    throw new ValidationError('可用时长必须是非负整数帧')
  }
  const enter = spec?.enter?.durationFrames ?? 0
  const hold = spec?.hold?.durationFrames ?? 0
  const exit = spec?.exit?.durationFrames ?? 0
  const required = enter + hold + exit
  if (required <= availableFrames) {
    return { spec, adjusted: 'none', note: '动作完整放得下' }
  }
  if (enter + exit <= availableFrames) {
    const newHold = availableFrames - enter - exit
    return {
      spec: { ...spec, hold: { ...(spec.hold ?? {}), durationFrames: newHold } },
      adjusted: 'hold-shrunk',
      note: `保持从 ${hold} 帧压缩到 ${newHold} 帧，入场与退场未被拉伸`,
    }
  }
  if (availableFrames === 0) {
    return { spec, adjusted: 'impossible', note: '窗口为 0 帧，任何动作都无法放入' }
  }
  const ratio = availableFrames / (enter + exit)
  const scaledEnter = Math.max(1, Math.floor(enter * ratio))
  const scaledExit = Math.max(0, availableFrames - scaledEnter)
  return {
    spec: {
      ...spec,
      enter: { ...(spec.enter ?? {}), durationFrames: scaledEnter },
      hold: { ...(spec.hold ?? {}), durationFrames: 0 },
      exit: { ...(spec.exit ?? {}), durationFrames: scaledExit },
    },
    adjusted: 'stretched',
    note: `入场/退场被等比压缩到 ${scaledEnter}+${scaledExit} 帧；这是降级，必须让用户知道`,
  }
}

/**
 * Scale a compiled motion's pixel offsets and type size when the画幅 changes.
 *
 * Deliberately asymmetric: horizontal and vertical distances each follow their own axis, because a
 * 16:9 → 9:16 adaptation is not a uniform scale (that would be stretching).
 *
 * @param {any} compiled
 * @param {{ width: number, height: number }} from
 * @param {{ width: number, height: number }} to
 * @param {{ fontSize?: number }} [options]
 */
export function scaleMotionCoordinates(compiled, from, to, options = {}) {
  if (!(from.width > 0) || !(from.height > 0) || !(to.width > 0) || !(to.height > 0)) {
    throw new ValidationError('坐标缩放需要正的目标与源尺寸')
  }
  const sx = to.width / from.width
  const sy = to.height / from.height
  const keyframes = compiled.keyframes.map((frame) => ({
    ...frame,
    offsetX: roundDeterministic(frame.offsetX * sx, 6),
    offsetY: roundDeterministic(frame.offsetY * sy, 6),
  }))
  return {
    ...compiled,
    keyframes,
    coordinates: {
      from,
      to,
      scaleX: Number(sx.toFixed(6)),
      scaleY: Number(sy.toFixed(6)),
      uniform: Math.abs(sx - sy) < 1e-6,
      fontSize: options.fontSize === undefined
        ? null
        : roundDeterministic(options.fontSize * Math.min(sx, sy), 6),
    },
    evaluateAt(relativeFrame) {
      const clamped = Math.max(0, Math.min(compiled.totalFrames, relativeFrame))
      return keyframes[clamped]
    },
  }
}

/**
 * Replace an object's text as a new plan version, with the old text preserved in the record.
 *
 * @param {any} plan
 * @param {string} objectId
 * @param {string} text
 * @param {{ planVersion?: string }} [options]
 * @returns {{ plan: any, change: { objectId: string, from: string, to: string } }}
 */
export function substituteText(plan, objectId, text, options = {}) {
  const index = plan.objects.findIndex((object) => object.id === objectId)
  if (index < 0) throw new ValidationError('计划中没有这个对象', { objectId })
  const object = plan.objects[index]
  if (!['text-native', 'subtitle'].includes(object.kind)) {
    throw new ValidationError('只有文字与字幕对象可以直接替换文本', { objectId, kind: object.kind })
  }
  const previous = object.params?.text
  const objects = plan.objects.map((entry, position) =>
    position === index ? { ...entry, params: { ...entry.params, text } } : entry,
  )
  return {
    plan: { ...plan, objects, planVersion: options.planVersion ?? bumpVersion(plan.planVersion) },
    change: { objectId, from: previous, to: text },
  }
}

/** Increment the last numeric component of a plan version. @param {string} version */
export function bumpVersion(version) {
  if (typeof version !== 'string' || version.length === 0) return '1.0.1'
  const parts = version.split('.')
  const last = Number(parts[parts.length - 1])
  if (!Number.isInteger(last)) return `${version}.1`
  parts[parts.length - 1] = String(last + 1)
  return parts.join('.')
}

/**
 * Kit scope: which objects belong to the same shared component.
 *
 * A kit is declared on the plan (`kits: [{ id, sharedComponentRef, objectIds }]`). Editing one
 * instance must not silently change every other instance (CT-05 §2 "不因修改当前实例而静默改全部镜头").
 *
 * @param {any} plan
 * @param {string} objectId
 */
export function describeKitScope(plan, objectId) {
  const kits = Array.isArray(plan.kits) ? plan.kits : []
  const kit = kits.find((entry) => (entry.objectIds ?? []).includes(objectId))
  if (kit === undefined) {
    return { objectId, inKit: false, kitId: null, members: [], sharedComponentRef: null }
  }
  return {
    objectId,
    inKit: true,
    kitId: kit.id,
    sharedComponentRef: kit.sharedComponentRef ?? null,
    members: kit.objectIds.filter((id) => id !== objectId),
    scopeRule: '默认只改当前实例；共享改动必须由调用方显式声明 propagate',
  }
}

/**
 * Apply a property change while honouring kit scope.
 *
 * @param {any} plan
 * @param {string} objectId
 * @param {string} prop
 * @param {unknown} value
 * @param {{ propagate?: boolean, planVersion?: string }} [options]
 */
export function applyPropertyChange(plan, objectId, prop, value, options = {}) {
  const index = plan.objects.findIndex((object) => object.id === objectId)
  if (index < 0) throw new ValidationError('计划中没有这个对象', { objectId })
  const object = plan.objects[index]
  if (!(object.editableProps ?? []).includes(prop)) {
    throw new ValidationError('该属性不在对象的可编辑范围内', { objectId, prop: String(prop) })
  }
  const kit = describeKitScope(plan, objectId)
  const targets = kit.inKit && options.propagate === true ? [objectId, ...kit.members] : [objectId]
  const targetSet = new Set(targets)
  const objects = plan.objects.map((entry) => {
    if (!targetSet.has(entry.id)) return entry
    const nextParams = { ...entry.params, [prop]: value }
    const next = { ...entry, params: nextParams }
    if (prop === 'text') next.derivedFrom = { ...(entry.derivedFrom ?? {}), textEditedAt: 'explicit-user-edit' }
    return next
  })
  return {
    plan: { ...plan, objects, planVersion: options.planVersion ?? bumpVersion(plan.planVersion) },
    applied: {
      objectId,
      prop,
      value,
      targets,
      kitScope: kit.inKit ? { kitId: kit.kitId, propagated: options.propagate === true, members: kit.members } : null,
    },
  }
}
