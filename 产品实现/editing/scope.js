/**
 * Edit scope, ripple and protection checks: what a change is allowed to touch, and what must stay
 * byte-for-byte identical.
 *
 * The rule from CT-05 §7 is implemented rather than described: a candidate is only acceptable when
 * the plan diff shows the target (and its declared, necessary ripple) changed and everything else —
 * neighbours, unselected objects, the sound manifest and the output spec — did not. Timing edits are
 * the one place where the total duration may legitimately change, so they are declared up front and
 * their ripple is listed instead of hidden behind "the diff looks small".
 *
 * @module editing/scope
 */

import { Clock, ValidationError, contentHash } from '../base/index.js'
import {
  applyPropertyChange,
  bumpVersion,
  deriveLayout,
  editScopeOf,
  mergeFrameRanges,
  normalizePlan,
  substituteText,
} from '../media/index.js'
import { assertFieldScope, diffPlanFields } from './field-diff.js'

/**
 * Normalize a plan whose scene/transition durations may have changed.
 *
 * C12 validates the DECLARED total against the derived layout, so a timing edit must update the
 * declaration first; otherwise re-normalizing a valid plan would fail on its own old total.
 * @param {any} plan
 * @param {(() => string)|undefined} now
 * @returns {any}
 */
function normalizeTimingPlan(plan, now) {
  const layout = deriveLayout(plan)
  return normalizePlan({
    ...plan,
    timebase: {
      ...plan.timebase,
      totalFrames: layout.totalFrames,
      totalRational: layout.totalRational,
      totalSeconds: layout.totalSeconds,
    },
  }, { now })
}

/** Timing intents, the only operations allowed to change total duration. */
export const TIMING_INTENTS = Object.freeze(['set-object-timing', 'set-transition-overlap', 'set-scene-duration'])

/** Declared-editable properties the current FFmpeg adapter does not read. */
export const UNOBSERVED_PROPERTIES = Object.freeze([
  { prop: 'scale', reason: '当前 FFmpeg 适配器不读取 scale；计划差异成立，但像素可能不变' },
  { prop: 'fontFamily', reason: '当前 FFmpeg 适配器只取 plan.fonts[0].file；改 fontFamily 不会改字形' },
  { prop: 'hue', reason: '当前 FFmpeg 适配器不读取 hue' },
  { prop: 'amplitude', reason: '当前 FFmpeg 适配器不读取 amplitude' },
  { prop: 'style', reason: '当前 FFmpeg 适配器不读取 style' },
])

/** Timing fields that must not be passed to `set-property` (that would write a dead params key). */
const TIMELINE_PROPS = Object.freeze(['startFrame', 'durationFrames', 'sourceOffsetFrames'])

/**
 * Assert a normalized plan shape this module can compare.
 * @param {unknown} plan
 * @param {string} field
 * @returns {any}
 */
export function assertPlan(plan, field = 'plan') {
  if (plan === null || typeof plan !== 'object' || typeof plan.planVersion !== 'string') {
    throw new ValidationError(`${field} 必须是规范化计划（含 planVersion）`, { field })
  }
  if (!Array.isArray(plan.objects) || !Array.isArray(plan.scenes) || !Array.isArray(plan.transitions)) {
    throw new ValidationError(`${field} 缺少 objects/scenes/transitions`, { field })
  }
  if (plan.timebase === null || typeof plan.timebase !== 'object' || !Number.isInteger(plan.timebase.totalFrames)) {
    throw new ValidationError(`${field} 缺少时间基`, { field })
  }
  return plan
}

/**
 * Apply one direct-edit intent to a plan and return a NEW plan version.
 *
 * Supported intents (deliberately narrow):
 * - `{ kind: 'set-property', objectId, prop, value, propagate? }`
 * - `{ kind: 'replace-text', objectId, text }`
 * - `{ kind: 'set-object-timing', objectId, startFrame?, durationFrames?, sourceOffsetFrames? }`
 * - `{ kind: 'set-transition-overlap', transitionId, overlapFrames }`
 * - `{ kind: 'set-scene-duration', sceneId, durationFrames }`
 *
 * @param {object} input
 * @param {any} input.plan normalized plan
 * @param {any} input.intent
 * @param {{ now?: () => string }} [input.normalizeOptions]
 * @returns {{ plan: any, applied: object, warnings: string[], ripple: object }}
 */
export function applyDirectIntent(input) {
  const plan = assertPlan(input.plan)
  const intent = input.intent
  if (intent === null || typeof intent !== 'object' || typeof intent.kind !== 'string') {
    throw new ValidationError('直接修改需要明确的 kind', { field: 'intent' })
  }
  const now = input.normalizeOptions?.now
  /** @type {string[]} */
  const warnings = []
  if (intent.kind === 'set-property') {
    const object = plan.objects.find((entry) => entry.id === intent.objectId)
    if (object === undefined) throw new ValidationError('计划中没有这个对象', { objectId: intent.objectId ?? null })
    if (TIMELINE_PROPS.includes(intent.prop)) {
      throw new ValidationError('时间字段不能用 set-property 修改；请用 set-object-timing', {
        prop: intent.prop,
        action: '改用 set-object-timing，让计划时间轴真正变化',
      })
    }
    const unobserved = UNOBSERVED_PROPERTIES.find((entry) => entry.prop === intent.prop)
    if (unobserved !== undefined) warnings.push(unobserved.reason)
    const result = applyPropertyChange(plan, intent.objectId, intent.prop, intent.value, {
      propagate: intent.propagate === true,
      planVersion: bumpVersion(plan.planVersion),
    })
    return {
      plan: result.plan,
      applied: { kind: intent.kind, ...result.applied },
      warnings,
      ripple: { objectIds: [...result.applied.targets], kitPropagated: result.applied.kitScope?.propagated === true },
    }
  }
  if (intent.kind === 'replace-text') {
    const result = substituteText(plan, intent.objectId, intent.text, { planVersion: bumpVersion(plan.planVersion) })
    return {
      plan: result.plan,
      applied: { kind: intent.kind, objectId: result.change.objectId, from: result.change.from, to: result.change.to },
      warnings,
      ripple: { objectIds: [intent.objectId], kitPropagated: false },
    }
  }
  if (intent.kind === 'set-object-timing') {
    return applyObjectTiming(plan, intent, now, warnings)
  }
  if (intent.kind === 'set-transition-overlap') {
    return applyTransitionOverlap(plan, intent, now, warnings)
  }
  if (intent.kind === 'set-scene-duration') {
    return applySceneDuration(plan, intent, now, warnings)
  }
  throw new ValidationError('未知直接修改意图', { kind: String(intent.kind) })
}

/**
 * Move or trim one object on the timeline.
 * @param {any} plan
 * @param {any} intent
 * @param {(() => string)|undefined} now
 * @param {string[]} warnings
 * @returns {{ plan: any, applied: object, warnings: string[], ripple: object }}
 */
function applyObjectTiming(plan, intent, now, warnings) {
  const object = plan.objects.find((entry) => entry.id === intent.objectId)
  if (object === undefined) throw new ValidationError('计划中没有这个对象', { objectId: intent.objectId ?? null })
  const props = object.editableProps ?? []
  for (const prop of ['startFrame', 'durationFrames']) {
    if (intent[prop] !== undefined && !props.includes(prop)) {
      throw new ValidationError('该对象不允许直接改这个时间字段', { objectId: object.id, prop })
    }
  }
  if (intent.sourceOffsetFrames !== undefined && !props.includes('sourceOffsetFrames')) {
    throw new ValidationError('该对象不允许改源偏移', { objectId: object.id, prop: 'sourceOffsetFrames' })
  }
  if (
    intent.startFrame === undefined &&
    intent.durationFrames === undefined &&
    intent.sourceOffsetFrames === undefined
  ) {
    throw new ValidationError('时间修改至少需要一个字段', { field: 'intent' })
  }
  for (const field of ['startFrame', 'durationFrames', 'sourceOffsetFrames']) {
    if (intent[field] !== undefined && !Number.isInteger(intent[field])) {
      throw new ValidationError(`${field} 必须是整数帧`, { field })
    }
  }
  if (intent.durationFrames !== undefined && intent.durationFrames <= 0) {
    throw new ValidationError('对象时长必须为正', { field: 'durationFrames' })
  }
  if (intent.startFrame !== undefined && intent.startFrame < 0) {
    throw new ValidationError('对象起点必须非负', { field: 'startFrame' })
  }
  if (intent.sourceOffsetFrames !== undefined && intent.sourceOffsetFrames < 0) {
    throw new ValidationError('源偏移必须非负', { field: 'sourceOffsetFrames' })
  }

  const before = {
    timeline: { ...object.timeline },
    sourceOffsetFrames: object.authored?.sourceOffsetFrames ?? null,
  }
  const objects = plan.objects.map((entry) => {
    if (entry.id !== intent.objectId) return entry
    const timeline = { ...entry.timeline }
    if (intent.startFrame !== undefined) timeline.startFrame = intent.startFrame
    if (intent.durationFrames !== undefined) timeline.durationFrames = intent.durationFrames
    const authored = entry.authored === undefined
      ? entry.authored
      : { ...entry.authored }
    if (intent.sourceOffsetFrames !== undefined && authored !== undefined) {
      authored.sourceOffsetFrames = intent.sourceOffsetFrames
    }
    return { ...entry, timeline, ...(authored === undefined ? {} : { authored }) }
  })
  const next = normalizeTimingPlan({ ...plan, objects, planVersion: bumpVersion(plan.planVersion) }, now)
  return {
    plan: next,
    applied: {
      kind: intent.kind,
      objectId: intent.objectId,
      before,
      after: {
        timeline: next.objects.find((entry) => entry.id === intent.objectId).timeline,
        sourceOffsetFrames: next.objects.find((entry) => entry.id === intent.objectId)
          .authored?.sourceOffsetFrames ?? null,
      },
    },
    warnings,
    ripple: { objectIds: [intent.objectId], windowChanged: true },
  }
}

/**
 * Change one transition's overlap. The total duration moves because transitions shorten it.
 * @param {any} plan
 * @param {any} intent
 * @param {(() => string)|undefined} now
 * @param {string[]} warnings
 */
function applyTransitionOverlap(plan, intent, now, warnings) {
  const transition = plan.transitions.find((entry) => entry.id === intent.transitionId)
  if (transition === undefined) throw new ValidationError('计划中没有这个转场', { transitionId: intent.transitionId ?? null })
  if (!Number.isInteger(intent.overlapFrames) || intent.overlapFrames <= 0) {
    throw new ValidationError('转场重叠必须是正整数帧', { field: 'overlapFrames' })
  }
  const delta = transition.overlapFrames - intent.overlapFrames
  const toSceneIndex = plan.scenes.findIndex((entry) => entry.id === transition.toScene)
  if (toSceneIndex < 0) throw new ValidationError('转场的目标场景不存在', { toScene: transition.toScene })
  const laterScenes = plan.scenes.slice(toSceneIndex).map((entry) => entry.id)
  warnings.push(
    `转场重叠变化 ${-delta >= 0 ? '+' : ''}${-delta} 帧：目标场景及其后内容顺延 ${delta >= 0 ? '+' : ''}${delta} 帧，并改变总时长；必须看整片影响`,
  )
  const scenes = plan.scenes.map((entry, index) =>
    index >= toSceneIndex
      ? { ...entry, timeline: { ...entry.timeline, startFrame: entry.timeline.startFrame + delta } }
      : entry,
  )
  const shiftedObjectIds = plan.objects
    .filter((entry) => laterScenes.includes(entry.sceneId))
    .map((entry) => entry.id)
  const objects = plan.objects.map((entry) => {
    if (!laterScenes.includes(entry.sceneId)) return entry
    return { ...entry, timeline: { ...entry.timeline, startFrame: entry.timeline.startFrame + delta } }
  })
  const transitions = plan.transitions.map((entry) =>
    entry.id === intent.transitionId ? { ...entry, overlapFrames: intent.overlapFrames } : entry,
  )
  const next = normalizeTimingPlan(
    { ...plan, scenes, objects, transitions, planVersion: bumpVersion(plan.planVersion) },
    now,
  )
  return {
    plan: next,
    applied: {
      kind: intent.kind,
      transitionId: intent.transitionId,
      from: transition.overlapFrames,
      to: intent.overlapFrames,
      shiftedScenes: laterScenes,
      shiftedObjectIds,
    },
    warnings,
    ripple: { objectIds: shiftedObjectIds, scenes: laterScenes, windowChanged: true, timebaseChanged: true },
  }
}

/**
 * Change one scene's duration and shift every later scene and its objects by the same delta.
 *
 * The shift is the honest alternative to silently reinterpreting absolute object times: a scene that
 * grows must either push later content later or cut it, and pushing is the smaller semantic change.
 * @param {any} plan
 * @param {any} intent
 * @param {(() => string)|undefined} now
 * @param {string[]} warnings
 */
function applySceneDuration(plan, intent, now, warnings) {
  const scene = plan.scenes.find((entry) => entry.id === intent.sceneId)
  if (scene === undefined) throw new ValidationError('计划中没有这个场景', { sceneId: intent.sceneId ?? null })
  if (!Number.isInteger(intent.durationFrames) || intent.durationFrames <= 0) {
    throw new ValidationError('场景时长必须是正整数帧', { field: 'durationFrames' })
  }
  const delta = intent.durationFrames - scene.timeline.durationFrames
  const sceneIndex = plan.scenes.findIndex((entry) => entry.id === intent.sceneId)
  const laterScenes = plan.scenes.slice(sceneIndex + 1).map((entry) => entry.id)
  warnings.push(
    `场景时长变化 ${delta >= 0 ? '+' : ''}${delta} 帧；后续场景与其中对象整体顺延，总时长随之变化`,
  )
  const scenes = plan.scenes.map((entry, index) => {
    if (index === sceneIndex) {
      return { ...entry, timeline: { ...entry.timeline, durationFrames: intent.durationFrames } }
    }
    if (index > sceneIndex) {
      return {
        ...entry,
        timeline: { ...entry.timeline, startFrame: entry.timeline.startFrame + delta },
      }
    }
    return entry
  })
  const shiftedObjectIds = plan.objects
    .filter((entry) => laterScenes.includes(entry.sceneId))
    .map((entry) => entry.id)
  // Movie-scope objects (`scope: 'movie'`, `sceneId: null`) can never match `laterScenes`, so the
  // whole class used to be invisible to ripple detection: extending a scene moved every picture cut
  // and left the audio bed where it was, with no warning at all (D6). They are deliberately NOT
  // auto-shifted — their timeline is movie time and retiming audio by machine is worse than saying
  // so — but they must be reported, so a human can decide.
  const movieScopeAudioIds = plan.objects
    .filter((entry) => (entry.scope ?? 'scene') === 'movie')
    .filter((entry) => ['audio-continuous', 'audio'].includes(entry.kind))
    .map((entry) => entry.id)
  if (movieScopeAudioIds.length > 0) {
    warnings.push(
      `音轨事件仍停在旧切点：影片级音轨 ${movieScopeAudioIds.join('、')} 不随场景/转场变化自动迁移，` +
        '需要人工确认或迁移后才能认为音画对齐',
    )
  }
  const objects = plan.objects.map((entry) => {
    if (!laterScenes.includes(entry.sceneId)) return entry
    return {
      ...entry,
      timeline: { ...entry.timeline, startFrame: entry.timeline.startFrame + delta },
    }
  })
  const next = normalizeTimingPlan(
    { ...plan, scenes, objects, planVersion: bumpVersion(plan.planVersion) },
    now,
  )
  return {
    plan: next,
    applied: {
      kind: intent.kind,
      sceneId: intent.sceneId,
      from: scene.timeline.durationFrames,
      to: intent.durationFrames,
      shiftedScenes: laterScenes,
      shiftedObjectIds,
    },
    warnings,
    ripple: {
      objectIds: shiftedObjectIds,
      scenes: laterScenes,
      windowChanged: true,
      timebaseChanged: true,
    },
  }
}

/**
 * Describe what editing a set of objects may reasonably touch, before anything is changed.
 *
 * @param {object} input
 * @param {any} input.plan
 * @param {string[]} input.targetObjectIds
 * @param {string[]} [input.preserveObjectIds]
 * @returns {object}
 */
export function describeEditScope(input) {
  const plan = assertPlan(input.plan)
  if (!Array.isArray(input.targetObjectIds) || input.targetObjectIds.length === 0) {
    throw new ValidationError('修改范围必须至少包含一个目标对象', { field: 'targetObjectIds' })
  }
  const scopes = input.targetObjectIds.map((objectId) => editScopeOf(plan, objectId))
  const allIds = plan.objects.map((entry) => entry.id)
  const preserve = input.preserveObjectIds === undefined
    ? allIds.filter((id) => !input.targetObjectIds.includes(id))
    : input.preserveObjectIds.map((id) => {
        if (!allIds.includes(id)) throw new ValidationError('保留项不是当前计划里的对象', { objectId: id })
        return id
      })
  const kits = plan.kits ?? []
  const kitMembers = new Map()
  for (const kit of kits) {
    for (const objectId of kit.objectIds ?? []) {
      if (input.targetObjectIds.includes(objectId)) {
        kitMembers.set(objectId, { kitId: kit.id, members: (kit.objectIds ?? []).filter((id) => id !== objectId) })
      }
    }
  }
  const movieObjects = plan.objects
    .filter((entry) => (entry.scope ?? 'scene') === 'movie')
    .map((entry) => ({ objectId: entry.id, kind: entry.kind, window: entry.timeline }))
  const transitions = plan.transitions.map((entry) => ({
    transitionId: entry.id,
    fromScene: entry.fromScene,
    toScene: entry.toScene,
    participants: (plan.scenes ?? [])
      .filter((scene) => [entry.fromScene, entry.toScene].includes(scene.id))
      .map((scene) => scene.id),
  }))
  return {
    planVersion: plan.planVersion,
    totalFrames: plan.timebase.totalFrames,
    targets: scopes.map((scope) => ({
      objectId: scope.objectId,
      scope: scope.scope,
      editableProps: scope.editableProps,
      window: scope.window,
      affectedScenes: scope.affectedScenes,
      renderScope: scope.renderScope,
    })),
    preserve,
    kits: [...kitMembers.entries()].map(([objectId, value]) => ({ objectId, ...value })),
    movieObjects,
    transitions,
    audioProtected: true,
    requiresWholeFilmWatch: scopes.some((scope) => scope.scope === 'movie') || movieObjects.length > 0,
    note: '只重制目标及其声明牵连；相邻、未选、共享组件本体与音轨默认保护',
  }
}

/**
 * Compare a proposed plan against its base and check the declared scope.
 *
 * @param {object} input
 * @param {any} input.basePlan
 * @param {any} input.nextPlan
 * @param {string[]} input.targetObjectIds the user-declared targets
 * @param {string[]} [input.allowedRippleIds] necessary ripple the edit declares (not silently allowed)
 * @param {string[]} [input.preserveObjectIds] items that must not change even if they appear in ripple
 * @param {boolean} [input.timingEdit] whether this intent legitimately changes the timebase
 * @param {boolean} [input.transitionEdit]
 * @returns {object}
 */
export function analyzeScope(input) {
  const base = assertPlan(input.basePlan, 'basePlan')
  const next = assertPlan(input.nextPlan, 'nextPlan')
  const targets = input.targetObjectIds ?? []
  const ripple = input.allowedRippleIds ?? []
  const allowed = [...new Set([...targets, ...ripple])]
  const preserveDeclared = input.preserveObjectIds ?? []
  // Protection uses the complete field-level diff, not C12's diffPlans: moving a neighbour's box
  // or changing its motion must fail here even when diffPlans would not see the field.
  const diff = diffPlanFields(base, next)
  const timingEdit = input.timingEdit === true
  const transitionEdit = input.transitionEdit === true
  const check = assertFieldScope(diff, {
    targetObjectIds: targets,
    allowedRippleIds: ripple,
    preserveObjectIds: preserveDeclared,
    allowTimebaseChanges: timingEdit,
    allowOutputChanges: false,
    allowSoundChanges: false,
    allowSceneStructureChanges: false,
    allowSceneFieldChanges: timingEdit,
    allowTransitionStructureChanges: false,
    allowTransitionFieldChanges: timingEdit || transitionEdit,
  })
  /** @type {Array<{ rule: string, detail: string }>} */
  const violations = [...check.violations]
  const kit = (base.kits ?? []).find((entry) =>
    (entry.objectIds ?? []).some((id) => targets.includes(id)),
  )
  if (kit !== undefined) {
    const members = (kit.objectIds ?? []).filter((id) => !targets.includes(id))
    const changedMembers = diff.changedObjectIds.filter((id) => members.includes(id))
    for (const id of changedMembers) {
      if (!ripple.includes(id)) {
        violations.push({ rule: 'shared-component-leaked', detail: `共享组件实例被牵连修改：${id}` })
      }
    }
  }
  const timing = describeTimingImpact(base, next)
  return {
    ok: violations.length === 0,
    violations,
    diff,
    timing,
    changedObjectIds: diff.changedObjectIds,
    changedFieldsByObject: diff.changedFieldsByObject,
    changedFrames: diff.changedFrames,
    protectedObjectIds: diff.protectedObjectIds,
    preservedIds: input.preserveObjectIds ?? diff.protectedObjectIds,
    audioProtected: !diff.soundChanged,
    outputProtected: !diff.outputChanged,
    scopeRule: '目标与声明牵连可以变；相邻、未选、共享组件、输出规格和音轨必须原样',
  }
}

/**
 * How a timing change moves the whole film.
 *
 * @param {any} basePlan
 * @param {any} nextPlan
 * @returns {object}
 */
export function describeTimingImpact(basePlan, nextPlan) {
  const beforeFrames = basePlan.timebase.totalFrames
  const afterFrames = nextPlan.timebase.totalFrames
  const sceneChanges = nextPlan.scenes
    .map((scene) => {
      const baseScene = basePlan.scenes.find((entry) => entry.id === scene.id)
      if (baseScene === undefined) return null
      const startDelta = scene.timeline.startFrame - baseScene.timeline.startFrame
      const durationDelta = scene.timeline.durationFrames - baseScene.timeline.durationFrames
      if (startDelta === 0 && durationDelta === 0) return null
      return { sceneId: scene.id, startDeltaFrames: startDelta, durationDeltaFrames: durationDelta }
    })
    .filter(Boolean)
  const transitionChanges = nextPlan.transitions
    .map((transition) => {
      const baseTransition = basePlan.transitions.find((entry) => entry.id === transition.id)
      if (baseTransition === undefined) return null
      const delta = transition.overlapFrames - baseTransition.overlapFrames
      return delta === 0 ? null : { transitionId: transition.id, overlapDeltaFrames: delta }
    })
    .filter(Boolean)
  const objectWindowChanges = nextPlan.objects
    .map((object) => {
      const baseObject = basePlan.objects.find((entry) => entry.id === object.id)
      if (baseObject === undefined) return null
      const startDelta = object.timeline.startFrame - baseObject.timeline.startFrame
      const durationDelta = object.timeline.durationFrames - baseObject.timeline.durationFrames
      return startDelta === 0 && durationDelta === 0
        ? null
        : { objectId: object.id, startDeltaFrames: startDelta, durationDeltaFrames: durationDelta }
    })
    .filter(Boolean)
  return {
    totalFrames: { before: beforeFrames, after: afterFrames, deltaFrames: afterFrames - beforeFrames },
    totalSeconds: {
      before: basePlan.timebase.totalSeconds,
      after: nextPlan.timebase.totalSeconds,
    },
    sceneChanges,
    transitionChanges,
    objectWindowChanges,
    audio: {
      protected: contentHash(basePlan.soundManifest ?? null) === contentHash(nextPlan.soundManifest ?? null),
      note: '音轨内容未被修改时字节仍应一致；是否真的一致需在媒体层验证，不能用计划相等代替',
    },
    requiresWholeFilmWatch: beforeFrames !== afterFrames || sceneChanges.length > 0,
    note: beforeFrames === afterFrames
      ? '总时长未变；仍要检查被改对象的相邻画面与音画关系'
      : '总时长变化：必须看整片，不能只对照被改片段',
  }
}

/**
 * Frame ranges a change can affect, merged into contiguous windows.
 * @param {any} plan
 * @param {object} diff result of `diffPlanFields`
 * @returns {Array<{ startFrame: number, endFrameExclusive: number }>}
 */
export function affectedWindows(plan, diff) {
  return mergeFrameRanges(plan, diff.changedFrames ?? [])
}

/**
 * Build the comparison record for an old/new pair.
 *
 * A comparison is only called REAL when at least one real media reference exists; otherwise the
 * record says so instead of presenting plan data as pictures.
 *
 * @param {object} input
 * @param {any} input.basePlan
 * @param {any} input.nextPlan
 * @param {string} [input.baseVersionId]
 * @param {string} [input.againstVersionId]
 * @param {string[]} [input.modes]
 * @param {Array<{ kind: string, ref: string, planRef?: string }>} [input.previews]
 * @param {string} [input.runtimeLabel]
 * @param {string} [input.outputLabel]
 * @returns {object}
 */
export function buildComparison(input) {
  const base = assertPlan(input.basePlan, 'basePlan')
  const next = assertPlan(input.nextPlan, 'nextPlan')
  const diff = diffPlanFields(base, next)
  const previews = (input.previews ?? []).map((entry) => ({
    kind: String(entry.kind ?? 'unknown'),
    ref: String(entry.ref ?? ''),
    planRef: entry.planRef === undefined ? null : String(entry.planRef),
  }))
  const realPreviewCount = previews.filter((entry) => entry.ref.length > 0).length
  return {
    baseVersionId: input.baseVersionId ?? null,
    againstVersionId: input.againstVersionId ?? null,
    modes: input.modes ?? ['single', 'side-by-side', 'synchronized'],
    base: { planVersion: base.planVersion, totalFrames: base.timebase.totalFrames },
    against: { planVersion: next.planVersion, totalFrames: next.timebase.totalFrames },
    conditions: {
      runtime: input.runtimeLabel ?? 'ffmpeg',
      output: input.outputLabel ?? `${base.outputSpec.width}x${base.outputSpec.height}`,
      fps: `${base.timebase.fpsNumerator}/${base.timebase.fpsDenominator}`,
      note: '版本、条件与范围都写在记录上；不把不同条件下的画面当同一对照',
    },
    diff: {
      identical: diff.identical,
      changedObjectIds: diff.changedObjectIds,
      changedFieldsByObject: diff.changedFieldsByObject,
      changedFrames: diff.changedFrames,
      protectedObjectIds: diff.protectedObjectIds,
      scenes: diff.scenes,
      transitions: diff.transitions,
      planFieldsChanged: diff.planFieldsChanged,
      outputChanged: diff.outputChanged,
      timebaseChanged: diff.timebaseChanged,
      soundChanged: diff.soundChanged,
    },
    timing: describeTimingImpact(base, next),
    previews,
    realPreviewCount,
    realComparison: realPreviewCount > 0,
    missingPreviewReason: realPreviewCount > 0 ? null : '还没有真实渲染的新旧媒体；现在只有计划差异，不冒充真实对照',
    wholeFilmRequired: describeTimingImpact(base, next).requiresWholeFilmWatch,
    createdAt: null,
  }
}
