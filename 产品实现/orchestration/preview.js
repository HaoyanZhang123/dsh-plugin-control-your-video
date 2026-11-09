/**
 * What the user is actually looking at when a preview and a plan disagree.
 *
 * C12 answers the hard part: which frames are stale, against which plan version, with real frame
 * ranges. C13's job is to make that answer impossible to ignore on the work surface — the picture in
 * front of the user must say whether it is the current plan or the previous one, and a stale range
 * must not be presented as if the last edit had already been rendered (C13 card §4.11).
 *
 * @module orchestration/preview
 */

import { Clock, ConflictError, ValidationError } from '../base/index.js'
import { describePreviewState } from '../media/index.js'
import {
  ORCH_DOCUMENT,
  OrchestrationDocument,
  copy,
  optionalText,
  orchestrationId,
  requireText,
} from './ids.js'

/** How many rendered previews stay addressable; older ones are dropped, never silently re-used. */
export const PREVIEW_HISTORY_LIMIT = 8

/** What this takeover can and cannot claim. */
export const PREVIEW_CAPABILITIES = Object.freeze({
  freshness: {
    supported: ['按 C12 describePreviewState 显示过期帧段与有效帧', '标明画面属于当前计划还是上一版计划'],
    limits: ['不重新渲染，只描述真实渲染结果与当前计划的差距', '不把过期预览当作修改已生效'],
  },
  blocking: {
    supported: ['过期范围存在时拒绝“已生效”的陈述'],
    limits: ['不阻止用户继续编辑，只阻止误导性展示'],
  },
})

/**
 * @param {string} projectId
 * @returns {any}
 */
function emptySurface(projectId) {
  return { kind: ORCH_DOCUMENT.preview.kind, projectId, version: 1, previews: [] }
}

/**
 * The preview standing of one project.
 */
export class PreviewSurface {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.preview, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => emptySurface(this.projectId))
  }

  /**
   * Record one real rendered preview and the plan it was rendered from.
   *
   * The plan snapshot is what makes `describePreviewState` possible later without re-reading a file
   * that may have moved on; it is stored because a preview state that cannot prove its base plan is
   * a guess.
   *
   * @param {object} input
   * @param {any} input.basePlan
   * @param {{startFrame: number, endFrameExclusive: number}|null} [input.coveredRange]
   * @param {string} input.file
   * @param {string} [input.taskId]
   * @returns {{ preview: any, revision: string }}
   */
  recordPreview(input = {}) {
    const basePlan = input.basePlan
    if (basePlan === null || typeof basePlan !== 'object' || typeof basePlan.planVersion !== 'string') {
      throw new ValidationError('预览必须记录它渲染自哪个计划版本', { field: 'basePlan.planVersion' })
    }
    const file = requireText(input.file, 'file', 500)
    const covered = input.coveredRange ?? null
    if (covered !== null) {
      if (!Number.isInteger(covered.startFrame) || !Number.isInteger(covered.endFrameExclusive)) {
        throw new ValidationError('预览覆盖范围必须是整数帧', { field: 'coveredRange' })
      }
      if (covered.endFrameExclusive <= covered.startFrame) {
        throw new ValidationError('预览覆盖范围为空', { field: 'coveredRange' })
      }
    }
    const { value, revision } = this.load()
    const preview = {
      previewId: orchestrationId('unit', `preview:${this.projectId}:${value.previews.length}:${basePlan.planVersion}`),
      planVersion: basePlan.planVersion,
      basePlan: copy(basePlan),
      coveredRange: covered,
      file,
      taskId: optionalText(input.taskId, 'taskId', 120),
      at: this.clock.iso(),
    }
    const previews = [...value.previews, preview].slice(-PREVIEW_HISTORY_LIMIT)
    const written = this.document.write({ ...value, previews }, revision)
    return { preview: copy(preview), revision: written.revision }
  }

  /** @returns {any|null} the newest preview, or `null` */
  latest() {
    const previews = this.load().value.previews
    return previews.length === 0 ? null : copy(previews[previews.length - 1])
  }

  /**
   * Describe the standing of the newest preview against the plan the user is looking at.
   *
   * @param {object} input
   * @param {any} input.currentPlan
   * @returns {any}
   */
  describe(input = {}) {
    const preview = this.latest()
    if (preview === null) {
      return {
        hasPreview: false,
        showing: 'none',
        stale: null,
        label: '还没有渲染过预览',
        blocked: false,
        planVersion: { preview: null, current: input.currentPlan?.planVersion ?? null },
        staleFrames: [],
        freshFrames: [],
      }
    }
    const state = describePreviewState({
      basePlan: preview.basePlan,
      currentPlan: input.currentPlan,
      coveredRange: preview.coveredRange,
    })
    const showing = preview.planVersion === input.currentPlan?.planVersion ? 'current-plan' : 'previous-plan'
    return {
      hasPreview: true,
      previewId: preview.previewId,
      file: preview.file,
      renderedAt: preview.at,
      ...state,
      showing,
      // The two facts a surface must not blur: whose plan this is, and whether part of it is stale.
      planLabel: showing === 'current-plan' ? '当前计划' : `上一版计划（${preview.planVersion}）`,
      label:
        showing === 'current-plan'
          ? '画面对应当前计划'
          : `画面是上一版计划；${state.stale ? `其中 ${state.staleSeconds}s 已过期` : '尚未覆盖当前计划的改动'}`,
      // A stale preview may still be shown; what it may not do is claim the edit took effect.
      blocked: state.stale === true,
      mayClaimApplied: state.stale !== true && showing === 'current-plan',
    }
  }

  /**
   * Assert the surface is not presenting an old picture as the applied result.
   * @param {object} input
   * @param {any} input.currentPlan
   * @returns {any} the describe result when nothing is masked
   */
  assertNotMasking(input = {}) {
    const state = this.describe(input)
    if (state.blocked === true) {
      throw new ConflictError('预览里有过期帧，不能声称修改已生效', {
        action: '重新渲染过期范围，或明确显示“上一版计划＋待更新范围”',
        staleFrames: state.staleFrames,
        staleSeconds: state.staleSeconds,
        planVersion: state.planVersion,
      })
    }
    return state
  }
}
