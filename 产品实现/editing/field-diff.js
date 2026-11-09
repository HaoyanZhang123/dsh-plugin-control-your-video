/**
 * Complete field-level plan comparison for edit protection.
 *
 * C12's `diffPlans` compares a fixed set of object fields and deliberately omits top-level `box`,
 * `motion`, `derivedFrom` and `zIndex`. For a scope assertion that is not acceptable: moving a
 * neighbour's box or changing its motion would pass and only a later pixel check could catch it.
 * This module compares every own field of every object (excluding only its identity), plus scenes,
 * transitions and the plan's top-level fields, and asserts that only the declared targets and ripple
 * changed.
 *
 * It does not modify or replace C12; C12 keeps its own diff for rendering concerns. EDITING-REVIEW
 * uses this module instead of `diffPlans` for every protection decision.
 *
 * @module editing/field-diff
 */

import { ValidationError, contentHash } from '../base/index.js'
import { mergeFrameRanges } from '../media/index.js'

/** Plan bookkeeping fields that legitimately differ between any two versions. */
export const IGNORED_PLAN_FIELDS = Object.freeze([
  'planVersion',
  'normalizedAt',
  'lockedAt',
  'notes',
  'normalization',
])

/** Object fields that are never a semantic change because they are identity or provenance markers. */
export const IGNORED_OBJECT_FIELDS = Object.freeze(['id', 'evidenceRefs'])

/**
 * Assert a plan shape this module can compare.
 * @param {unknown} plan
 * @param {string} field
 * @returns {any}
 */
export function assertComparablePlan(plan, field = 'plan') {
  if (plan === null || typeof plan !== 'object') {
    throw new ValidationError(`${field} 必须是计划对象`, { field })
  }
  if (!Array.isArray(plan.objects) || !Array.isArray(plan.scenes) || !Array.isArray(plan.transitions)) {
    throw new ValidationError(`${field} 缺少 objects/scenes/transitions`, { field })
  }
  return plan
}

/** @param {any} value @returns {boolean} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Compare one field, including "absent" as a distinct value.
 * @param {any} left
 * @param {any} right
 * @param {string} key
 * @returns {boolean}
 */
function sameField(left, right, key) {
  const hasLeft = Object.prototype.hasOwnProperty.call(left, key)
  const hasRight = Object.prototype.hasOwnProperty.call(right, key)
  if (hasLeft !== hasRight) return false
  if (!hasLeft) return true
  return contentHash(left[key]) === contentHash(right[key])
}

/**
 * Names of fields that differ, using the union of own keys.
 * @param {any[]} left
 * @param {any[]} right
 * @param {boolean} [skipEvidenceRefs]
 * @returns {string[]}
 */
function changedFieldNames(left, right, skipEvidenceRefs = false) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const changed = []
  for (const key of keys) {
    if (key === 'id') continue
    if (skipEvidenceRefs && IGNORED_OBJECT_FIELDS.includes(key)) continue
    if (!sameField(left, right, key)) changed.push(key)
  }
  return changed.sort()
}

/**
 * Diff two id-keyed lists field by field.
 * @param {any[]} base
 * @param {any[]} next
 * @param {{ skipEvidenceRefs?: boolean }} [options]
 * @returns {{ added: string[], removed: string[], changed: Array<{ id: string, fields: string[] }> }}
 */
function diffRecordList(base, next, options = {}) {
  const baseById = new Map(base.map((entry) => [entry?.id, entry]))
  const nextById = new Map(next.map((entry) => [entry?.id, entry]))
  const added = [...nextById.keys()].filter((id) => !baseById.has(id))
  const removed = [...baseById.keys()].filter((id) => !nextById.has(id))
  const changed = []
  for (const [id, nextEntry] of nextById.entries()) {
    const baseEntry = baseById.get(id)
    if (baseEntry === undefined) continue
    const fields = changedFieldNames(baseEntry, nextEntry, options.skipEvidenceRefs === true)
    if (fields.length > 0) changed.push({ id, fields })
  }
  return { added, removed, changed }
}

/**
 * Diff two plans field by field.
 *
 * @param {any} base
 * @param {any} next
 * @returns {{
 *   identical: boolean,
 *   outputChanged: boolean,
 *   timebaseChanged: boolean,
 *   soundChanged: boolean,
 *   scenes: { added: string[], removed: string[], changed: Array<{id: string, fields: string[]}> },
 *   transitions: { added: string[], removed: string[], changed: Array<{id: string, fields: string[]}> },
 *   objects: { added: string[], removed: string[], changed: Array<{id: string, fields: string[]}> },
 *   planFieldsChanged: string[],
 *   changedObjectIds: string[],
 *   protectedObjectIds: string[],
 *   changedFieldsByObject: Record<string, string[]>,
 *   changedFrames: Array<{ startFrame: number, endFrameExclusive: number, reason: string }>,
 *   ignoredPlanFields: string[],
 * }}
 */
export function diffPlanFields(base, next) {
  assertComparablePlan(base, 'base')
  assertComparablePlan(next, 'next')
  const objects = diffRecordList(base.objects ?? [], next.objects ?? [], { skipEvidenceRefs: true })
  const scenes = diffRecordList(base.scenes ?? [], next.scenes ?? [])
  const transitions = diffRecordList(base.transitions ?? [], next.transitions ?? [])
  const planFieldsChanged = changedFieldNames(base, next).filter(
    (key) =>
      !IGNORED_PLAN_FIELDS.includes(key) &&
      !['objects', 'scenes', 'transitions', 'outputSpec', 'timebase', 'soundManifest'].includes(key),
  )
  const changedObjectIds = [
    ...new Set([
      ...objects.added,
      ...objects.removed,
      ...objects.changed.map((entry) => entry.id),
    ]),
  ].sort()
  /** @type {Record<string, string[]>} */
  const changedFieldsByObject = {}
  for (const entry of objects.changed) changedFieldsByObject[entry.id] = [...entry.fields]
  for (const id of objects.added) changedFieldsByObject[id] = ['added']
  for (const id of objects.removed) changedFieldsByObject[id] = ['removed']
  const changedFrames = collectChangedFrames(base, next, objects, scenes, transitions)
  return {
    identical:
      changedObjectIds.length === 0 &&
      scenes.added.length === 0 &&
      scenes.removed.length === 0 &&
      scenes.changed.length === 0 &&
      transitions.added.length === 0 &&
      transitions.removed.length === 0 &&
      transitions.changed.length === 0 &&
      planFieldsChanged.length === 0,
    outputChanged: !sameField(base, next, 'outputSpec'),
    timebaseChanged: !sameField(base, next, 'timebase'),
    soundChanged: !sameField(base, next, 'soundManifest'),
    scenes,
    transitions,
    objects,
    planFieldsChanged,
    changedObjectIds,
    protectedObjectIds: (base.objects ?? [])
      .map((object) => object.id)
      .filter((id) => !changedObjectIds.includes(id)),
    changedFieldsByObject,
    changedFrames,
    ignoredPlanFields: [...IGNORED_PLAN_FIELDS],
  }
}

/**
 * Frames whose picture may be affected by the change: changed/add/removed object windows, changed
 * scene windows and changed transition overlaps.
 * @param {any} base
 * @param {any} next
 * @param {any} objects
 * @param {any} scenes
 * @param {any} transitions
 * @returns {Array<{ startFrame: number, endFrameExclusive: number, reason: string }>}
 */
function collectChangedFrames(base, next, objects, scenes, transitions) {
  const ranges = []
  const pushObjectWindow = (plan, id, reason) => {
    const object = (plan.objects ?? []).find((entry) => entry.id === id)
    if (object === undefined) return
    ranges.push({
      startFrame: object.timeline.startFrame,
      endFrameExclusive: object.timeline.startFrame + object.timeline.durationFrames,
      reason,
    })
  }
  for (const entry of objects.changed) {
    const before = base.objects.find((object) => object.id === entry.id)
    const after = next.objects.find((object) => object.id === entry.id)
    if (before === undefined || after === undefined) continue
    ranges.push({
      startFrame: Math.min(before.timeline.startFrame, after.timeline.startFrame),
      endFrameExclusive: Math.max(
        before.timeline.startFrame + before.timeline.durationFrames,
        after.timeline.startFrame + after.timeline.durationFrames,
      ),
      reason: `对象 ${entry.id} 变更：${entry.fields.join('、')}`,
    })
  }
  for (const id of objects.added) pushObjectWindow(next, id, `新增对象 ${id}`)
  for (const id of objects.removed) pushObjectWindow(base, id, `删除对象 ${id}`)
  for (const entry of scenes.changed) {
    const before = base.scenes.find((scene) => scene.id === entry.id)
    const after = next.scenes.find((scene) => scene.id === entry.id)
    if (before === undefined || after === undefined) continue
    ranges.push({
      startFrame: Math.min(before.timeline.startFrame, after.timeline.startFrame),
      endFrameExclusive: Math.max(before.timeline.endFrameExclusive, after.timeline.endFrameExclusive),
      reason: `场景 ${entry.id} 变更：${entry.fields.join('、')}`,
    })
  }
  for (const entry of transitions.changed) {
    const before = base.transitions.find((transition) => transition.id === entry.id)
    const after = next.transitions.find((transition) => transition.id === entry.id)
    if (before === undefined || after === undefined) continue
    if (typeof before.startFrame !== 'number' || typeof after.startFrame !== 'number') continue
    ranges.push({
      startFrame: Math.min(before.startFrame, after.startFrame),
      endFrameExclusive: Math.max(before.endFrameExclusive, after.endFrameExclusive),
      reason: `转场 ${entry.id} 变更：${entry.fields.join('、')}`,
    })
  }
  return ranges.length === 0 ? [] : mergeFrameRanges(next, ranges)
}

/**
 * Assert that a field-level diff stayed inside the declared scope.
 *
 * This is the protection decision used by EDITING-REVIEW; it does not call C12's `assertRepairScope`.
 *
 * @param {ReturnType<typeof diffPlanFields>} diff
 * @param {object} scope
 * @param {string[]} scope.targetObjectIds
 * @param {string[]} [scope.allowedRippleIds]
 * @param {string[]} [scope.preserveObjectIds]
 * @param {boolean} [scope.allowTimebaseChanges]
 * @param {boolean} [scope.allowOutputChanges]
 * @param {boolean} [scope.allowSoundChanges]
 * @param {boolean} [scope.allowSceneStructureChanges]
 * @param {boolean} [scope.allowSceneFieldChanges]
 * @param {boolean} [scope.allowTransitionStructureChanges]
 * @param {boolean} [scope.allowTransitionFieldChanges]
 * @param {boolean} [scope.allowPlanFieldChanges]
 * @returns {{
 *   ok: boolean,
 *   violations: Array<{ rule: string, detail: string }>,
 *   changedObjectIds: string[],
 *   changedFieldsByObject: Record<string, string[]>,
 * }}
 */
export function assertFieldScope(diff, scope = {}) {
  const allowed = new Set([...(scope.targetObjectIds ?? []), ...(scope.allowedRippleIds ?? [])])
  const preserve = new Set(scope.preserveObjectIds ?? [])
  /** @type {Array<{ rule: string, detail: string }>} */
  const violations = []
  for (const id of diff.objects.added) {
    if (!allowed.has(id)) violations.push({ rule: 'changed-outside-target', detail: `未授权新增对象：${id}` })
  }
  for (const id of diff.objects.removed) {
    if (!allowed.has(id)) violations.push({ rule: 'changed-outside-target', detail: `未授权删除对象：${id}` })
  }
  for (const entry of diff.objects.changed) {
    if (!allowed.has(entry.id)) {
      violations.push({
        rule: 'changed-outside-target',
        detail: `未授权对象被修改：${entry.id}（${entry.fields.join('、')}）`,
      })
    }
  }
  for (const id of preserve) {
    if (diff.changedObjectIds.includes(id)) {
      violations.push({ rule: 'preserved-item-changed', detail: `声明保留的对象被改了：${id}` })
    }
  }
  if (diff.timebaseChanged && scope.allowTimebaseChanges !== true) {
    violations.push({ rule: 'timebase-changed', detail: '修改不得改变时间基或总时长' })
  }
  if (diff.outputChanged && scope.allowOutputChanges !== true) {
    violations.push({ rule: 'output-changed', detail: '修改不得改变输出规格' })
  }
  if (diff.soundChanged && scope.allowSoundChanges !== true) {
    violations.push({ rule: 'sound-changed', detail: '修改不得改变声音清单' })
  }
  if (
    (diff.scenes.added.length > 0 || diff.scenes.removed.length > 0) &&
    scope.allowSceneStructureChanges !== true
  ) {
    violations.push({ rule: 'scene-structure-changed', detail: '修改不得增删场景' })
  }
  if (diff.scenes.changed.length > 0 && scope.allowSceneFieldChanges !== true) {
    violations.push({
      rule: 'scene-canvas-changed',
      detail: `场景字段被改：${diff.scenes.changed.map((entry) => `${entry.id}(${entry.fields.join('、')})`).join('；')}`,
    })
  }
  if (
    (diff.transitions.added.length > 0 || diff.transitions.removed.length > 0) &&
    scope.allowTransitionStructureChanges !== true
  ) {
    violations.push({ rule: 'transition-structure-changed', detail: '修改不得增删转场' })
  }
  if (diff.transitions.changed.length > 0 && scope.allowTransitionFieldChanges !== true) {
    violations.push({
      rule: 'transition-fields-changed',
      detail: `转场字段被改：${diff.transitions.changed.map((entry) => `${entry.id}(${entry.fields.join('、')})`).join('；')}`,
    })
  }
  if (diff.planFieldsChanged.length > 0 && scope.allowPlanFieldChanges !== true) {
    violations.push({
      rule: 'plan-field-changed',
      detail: `计划顶层字段被改：${diff.planFieldsChanged.join('、')}`,
    })
  }
  return {
    ok: violations.length === 0,
    violations,
    changedObjectIds: diff.changedObjectIds,
    changedFieldsByObject: diff.changedFieldsByObject,
  }
}

/**
 * A compact comparison summary for evidence, including the fields that old diffPlans would miss.
 * @param {any} base
 * @param {any} next
 * @returns {object}
 */
export function describeFieldDiff(base, next) {
  const diff = diffPlanFields(base, next)
  return {
    changedObjectIds: diff.changedObjectIds,
    fieldsByObject: diff.changedFieldsByObject,
    changedFrames: diff.changedFrames,
    timebaseChanged: diff.timebaseChanged,
    outputChanged: diff.outputChanged,
    soundChanged: diff.soundChanged,
    scenesChanged: diff.scenes.changed,
    transitionsChanged: diff.transitions.changed,
    planFieldsChanged: diff.planFieldsChanged,
    protectedObjects: diff.protectedObjectIds.length,
  }
}

/**
 * Whether a record is an object (used by callers that only hold arbitrary plan fragments).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlanRecord(value) {
  return isRecord(value)
}
