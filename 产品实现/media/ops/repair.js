/**
 * RepairOperation: change one target, prove everything else was protected.
 *
 * Contract (CT-05 §7): lock the original unit, target, range, preserved content and recipe; produce
 * a plan diff that lists the necessary ripple; render a candidate on a NEW version; and check the
 * target changed while the boundary, neighbours, unselected range and audio did not. A whole-file
 * hash is worthless for this; the diff and the region checks are the evidence.
 *
 * @module media/ops/repair
 */

import { ValidationError } from '../../base/index.js'
import { diffPlans, assertRepairScope, normalizePlan } from '../plan.js'
import { bumpVersion, applyPropertyChange, substituteText } from '../motion.js'
import { mergeFrameRanges } from '../timeline.js'
import { editScopeOf } from '../objects.js'

/**
 * @typedef {object} RepairOperation
 * @property {string} id
 * @property {string} basePlanVersion
 * @property {string} candidatePlanVersion
 * @property {string[]} targetObjectIds
 * @property {string[]} preserveObjectIds
 * @property {{ startFrame: number, endFrameExclusive: number }[]} targetFrames
 * @property {any} diff
 * @property {any} verdict
 */

/**
 * Create a repair candidate from a declarative intent.
 *
 * Supported intents are deliberately narrow, because an "edit anything" API would make the scope
 * check meaningless:
 * - `{ kind: 'set-property', objectId, prop, value, propagate? }`
 * - `{ kind: 'replace-text', objectId, text }`
 *
 * @param {object} input
 * @param {any} input.basePlan normalized plan
 * @param {{ kind: string, objectId: string, prop?: string, value?: unknown, text?: string, propagate?: boolean }}
 * input.intent
 * @param {any} [input.clock]
 * @returns {{ operation: RepairOperation, plan: any }}
 */
export function createRepairOperation(input) {
  const base = input.basePlan
  const intent = input.intent
  if (intent?.kind === undefined) throw new ValidationError('修复操作必须声明 kind')

  const scope = editScopeOf(base, intent.objectId)
  let candidate
  if (intent.kind === 'set-property') {
    if (intent.prop === undefined) throw new ValidationError('set-property 需要 prop')
    const applied = applyPropertyChange(base, intent.objectId, intent.prop, intent.value, {
      propagate: intent.propagate,
      planVersion: bumpVersion(base.planVersion),
    })
    candidate = applied.plan
  } else if (intent.kind === 'replace-text') {
    if (typeof intent.text !== 'string') throw new ValidationError('replace-text 需要 text')
    const result = substituteText(base, intent.objectId, intent.text, { planVersion: bumpVersion(base.planVersion) })
    candidate = result.plan
  } else {
    throw new ValidationError('未知修复意图', { kind: String(intent.kind) })
  }

  const normalized = normalizePlan(candidate, { now: () => (input.clock ? input.clock.iso() : null) })
  const diff = diffPlans(base, normalized)
  const check = assertRepairScope(diff, {
    targetObjectIds: [intent.objectId, ...(intent.propagate === true ? scope.protected.filter((id) => false) : [])],
    allowTimebaseChanges: false,
    allowSoundChanges: false,
    allowSceneChanges: false,
    allowOutputChanges: false,
  })
  const targetFrames = mergeFrameRanges(
    base,
    diff.objects.changed
      .filter((entry) => entry.id === intent.objectId)
      .map((entry) => ({ startFrame: entry.startFrame, endFrameExclusive: entry.endFrameExclusive })),
  )
  /** @type {RepairOperation} */
  const operation = {
    id: `repair-${intent.objectId}-${normalized.planVersion}`,
    basePlanVersion: base.planVersion,
    candidatePlanVersion: normalized.planVersion,
    targetObjectIds: [intent.objectId],
    preserveObjectIds: scope.protected,
    targetFrames,
    diff,
    verdict: {
      ok: check.ok,
      violations: check.violations,
      changedObjects: diff.changedObjectIds,
      protectedObjects: diff.protectedObjectIds,
      rule: '只允许目标及其声明牵连发生变化；时间基、声音清单、输出规格与场景结构必须原样',
    },
  }
  return { operation, plan: normalized }
}

/**
 * The regions a repair must and must not change, in output pixels.
 *
 * @param {any} basePlan
 * @param {any} candidatePlan
 * @param {{ targetObjectId: string, frame: number }} input
 */
export function repairRegionPlan(basePlan, candidatePlan, input) {
  const target = basePlan.objects.find((object) => object.id === input.targetObjectId)
  if (target === undefined) throw new ValidationError('修复目标不存在', { objectId: input.targetObjectId })
  const box = target.box
  if (box === undefined || box === null) {
    throw new ValidationError('修复目标没有可对照的区域', { objectId: input.targetObjectId })
  }
  // The drawn area can exceed the declared box by the text border; the target region is padded so
  // the boundary strips sit outside the pixels that actually change.
  const margin = 18
  const targetRegion = {
    x: Math.max(0, Math.round(box.x) - margin),
    y: Math.max(0, Math.round(box.y) - margin),
    width: Math.round(box.width) + margin * 2,
    height: Math.round(box.height) + margin * 2,
  }
  // Neighbours: objects visible at the same frame that do NOT contain the target box. A full-frame
  // background contains the target, so comparing it whole would mostly measure the target change
  // itself — that is not a protection check, it is the same change measured twice.
  const contains = (outer, inner) =>
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  const neighbours = basePlan.objects
    .filter((object) => object.id !== input.targetObjectId && object.box !== undefined)
    .filter(
      (object) =>
        input.frame >= object.timeline.startFrame &&
        input.frame < object.timeline.startFrame + object.timeline.durationFrames,
    )
    .filter((object) => !contains(object.box, box))
    .map((object) => ({
      objectId: object.id,
      region: {
        x: Math.max(0, Math.round(object.box.x)),
        y: Math.max(0, Math.round(object.box.y)),
        width: Math.round(object.box.width),
        height: Math.round(object.box.height),
      },
    }))

  // Boundary strips just outside the target: the strongest local proof that the edit did not bleed.
  const strip = 10
  const boundaries = [
    {
      objectId: 'boundary-top',
      region: { x: targetRegion.x, y: Math.max(0, targetRegion.y - strip), width: targetRegion.width, height: strip },
    },
    {
      objectId: 'boundary-bottom',
      region: { x: targetRegion.x, y: targetRegion.y + targetRegion.height, width: targetRegion.width, height: strip },
    },
    {
      objectId: 'boundary-left',
      region: { x: Math.max(0, targetRegion.x - strip), y: targetRegion.y, width: strip, height: targetRegion.height },
    },
    {
      objectId: 'boundary-right',
      region: { x: targetRegion.x + targetRegion.width, y: targetRegion.y, width: strip, height: targetRegion.height },
    },
  ].filter((entry) => entry.region.width > 0 && entry.region.height > 0)
    .filter(
      (entry) =>
        entry.region.y + entry.region.height <= basePlan.outputSpec.height &&
        entry.region.x + entry.region.width <= basePlan.outputSpec.width,
    )

  return {
    targetRegion,
    neighbours: [...neighbours, ...boundaries],
    excluded: basePlan.objects
      .filter((object) => object.box !== undefined && contains(object.box, box) && object.id !== input.targetObjectId)
      .map((object) => ({ objectId: object.id, reason: '区域包含目标，整块比较无法区分保护与改动，改用目标四周边界带' })),
    frame: input.frame,
  }
}
