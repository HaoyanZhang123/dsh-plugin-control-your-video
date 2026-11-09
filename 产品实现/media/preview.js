/**
 * Preview freshness: what a preview actually covers, and what is already stale.
 *
 * Contract (CT-06 §5, MAKE/REV): a preview is bound to one plan version and one frame range. After a
 * local edit, only the changed window becomes stale — and the product must be able to say that in
 * data, not in prose, so a surface can render "待更新范围" instead of guessing.
 *
 * @module media/preview
 */

import { ValidationError } from '../base/index.js'
import { diffPlans } from './plan.js'
import { mergeFrameRanges, uncoveredFrameRanges } from './timeline.js'

/**
 * Describe how fresh one preview result is against a (possibly newer) plan.
 *
 * @param {object} input
 * @param {any} input.basePlan the plan the preview was rendered from
 * @param {any} input.currentPlan the plan the user is looking at now
 * @param {{ startFrame: number, endFrameExclusive: number }|null} [input.coveredRange]
 *   rendered range; null means whole movie
 * @returns {{
 *   stale: boolean,
 *   planVersion: { preview: string, current: string },
 *   changedObjectIds: string[],
 *   staleFrames: Array<{ startFrame: number, endFrameExclusive: number }>,
 *   staleSeconds: number,
 *   freshFrames: number,
 *   totalFrames: number,
 *   summary: string,
 * }}
 */
export function describePreviewState(input) {
  if (input?.basePlan === undefined || input?.currentPlan === undefined) {
    throw new ValidationError('预览状态需要旧计划与当前计划')
  }
  const base = input.basePlan
  const current = input.currentPlan
  const totalFrames = current.timebase.totalFrames
  const covered =
    input.coveredRange === null || input.coveredRange === undefined
      ? [{ startFrame: 0, endFrameExclusive: totalFrames }]
      : [input.coveredRange]
  const diff = diffPlans(base, current)
  const changedFrames = diff.changedFrames.length === 0
    ? []
    : mergeFrameRanges(current, diff.changedFrames)
  // Stale = changed frames the preview claims to cover.
  const staleFrames = mergeFrameRanges(
    current,
    changedFrames
      .map((range) => ({
        startFrame: Math.max(range.startFrame, covered[0].startFrame),
        endFrameExclusive: Math.min(range.endFrameExclusive, covered[0].endFrameExclusive),
      }))
      .filter((range) => range.endFrameExclusive > range.startFrame),
  )
  const staleCount = staleFrames.reduce((sum, range) => sum + (range.endFrameExclusive - range.startFrame), 0)
  const fresh = uncoveredFrameRanges(current, staleFrames)
  const freshCount = fresh.reduce((sum, range) => sum + (range.endFrameExclusive - range.startFrame), 0)
  const fps = current.timebase.fpsNumerator / current.timebase.fpsDenominator
  return {
    stale: staleFrames.length > 0,
    planVersion: { preview: base.planVersion, current: current.planVersion },
    changedObjectIds: diff.changedObjectIds,
    staleFrames,
    freshFrames: fresh,
    staleSeconds: Number((staleCount / fps).toFixed(3)),
    freshFrameCount: freshCount,
    totalFrames,
    summary:
      staleFrames.length === 0
        ? '预览与当前计划一致'
        : `预览已过期 ${staleFrames.length} 段共 ${staleCount} 帧（${(staleCount / fps).toFixed(2)}s），其余 ${freshCount} 帧仍有效`,
  }
}
