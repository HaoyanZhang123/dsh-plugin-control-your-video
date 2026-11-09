/**
 * Creative-period history and revert.
 *
 * History is read-only (CT-03 §5, C14 §4.5): entries are copies, and a revert makes a chosen version
 * current again instead of rewriting the past. A partial revert is deliberately a candidate with
 * named dependencies, never a silent rollback, and after finalization the delivered record cannot
 * be turned back into an editable current version.
 *
 * @module editing/history
 */

import { Clock, ConflictError, NotFoundError, ValidationError } from '../base/index.js'
import { appendEvents, buildEvent, createVersionStore } from '../core/project/index.js'
import { bumpVersion, editScopeOf, mergeFrameRanges, normalizePlan } from '../media/index.js'
import { ensureEditingAllowed, withEditingWrite } from './guard.js'
import { assertRef, assertRefList, copy, planOfVersion, readPlanSnapshot } from './ids.js'

/**
 * Open the creative-period history view of one project.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {object}
 */
export function createHistoryView(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('历史视图需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const versions = createVersionStore({ paths, clock })

  /**
   * Describe what can be recovered right now.
   * @returns {object}
   */
  function describeHistory() {
    const doc = versions.describe()
    const final = versions.getFinal()
    const entries = versions.listHistory()
    // After finalization with no retained earlier versions (C15 may delete them), the product must
    // not show a recovery entry that cannot restore anything.
    const noRecoveryEntry = final !== null && doc.versions <= 1
    return {
      finalized: final !== null,
      finalVersionId: final === null ? null : final.versionId,
      currentVersionId: doc.currentVersionId,
      versions: doc.versions,
      candidates: doc.candidates,
      liveCandidates: doc.liveCandidates,
      readOnly: true,
      recoveryAvailable: final === null && !noRecoveryEntry,
      noRecoveryEntry,
      note: noRecoveryEntry
        ? '结项后历史已删除：不显示恢复入口'
        : final === null
          ? '创作期历史只读查看；回退把选定版本变回当前版本，旧当前版保留为历史'
          : '项目已定稿：交付记录不可变，历史只读查看；继续修改应从定稿版本形成新候选',
    }
  }

  /**
   * Read-only history list with per-entry revert eligibility.
   * @param {{ includeCandidates?: boolean }} [filter]
   * @returns {object}
   */
  function listHistory(filter = {}) {
    const state = describeHistory()
    const entries = versions.listHistory()
      .filter((entry) => (filter.includeCandidates === false ? entry.kind === 'version' : true))
      .map((entry) => {
        const revertEligible =
          state.recoveryAvailable &&
          entry.kind === 'version' &&
          entry.active !== true &&
          entry.immutable !== true
        let revertReason = null
        if (revertEligible !== true) {
          if (state.finalized) revertReason = '项目已定稿；历史只读查看'
          else if (entry.kind !== 'version') revertReason = '候选不是可回退版本'
          else if (entry.active === true) revertReason = '已经是当前版本或定稿版本'
          else if (entry.immutable === true) revertReason = '定稿版本不可作为回退目标'
          else revertReason = '没有可恢复的当前历史'
        }
        return {
          ...entry,
          readOnly: true,
          revertEligible,
          revertReason,
        }
      })
    return {
      entries,
      readOnly: true,
      recoveryAvailable: state.recoveryAvailable,
      finalized: state.finalized,
      noRecoveryEntry: state.noRecoveryEntry,
      note: state.note,
    }
  }

  /**
   * Whether a version could be made current again.
   * @param {string} versionId
   * @returns {object}
   */
  function canRevert(versionId) {
    const id = assertRef(versionId, 'versionId')
    const state = describeHistory()
    const version = versions.getVersion(id)
    if (version === null) return { allowed: false, reason: '版本不存在' }
    if (version.class === 'final' || version.immutable === true) {
      return { allowed: false, reason: '定稿版本不可作为回退目标' }
    }
    if (state.finalized) return { allowed: false, reason: '项目已定稿；继续修改应从定稿版本形成新候选' }
    if (!state.recoveryAvailable) return { allowed: false, reason: state.note }
    if (state.currentVersionId === id) return { allowed: false, reason: '已经是当前版本' }
    return { allowed: true, reason: null }
  }

  /**
   * Make one historical version the current version again.
   *
   * @param {object} input
   * @param {string} input.versionId
   * @param {string} [input.actor] must be the user in the product flow
   * @param {string} [input.reason]
   * @returns {object}
   */
  function revertToVersion(input = {}) {
    const versionId = assertRef(input.versionId, 'versionId')
    const actor = input.actor ?? 'user'
    if (actor !== 'user') {
      throw new ValidationError('回退是用户决定；AI 不能替用户回退', { field: 'actor', actor })
    }
    const reason = input.reason === undefined ? null : String(input.reason)
    const eligibility = canRevert(versionId)
    if (eligibility.allowed !== true) throw new ConflictError('该版本不能回退', { versionId, reason: eligibility.reason })
    ensureEditingAllowed({ paths, clock, operation: 'revert-version' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:revert:${versionId}` }, () => {
      const result = versions.revertToVersion(versionId, { actor, reason })
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.version-reverted',
          projectId: paths.projectId,
          actor,
          versionId,
          detail: {
            fromVersionId: result.previousCurrentVersionId,
            staleCandidateIds: result.staleCandidateIds,
            reason,
          },
        }),
      ], { clock })
      return {
        version: result.version,
        previousCurrentVersionId: result.previousCurrentVersionId,
        retainedHistoryVersionId: result.retainedHistoryVersionId,
        staleCandidateIds: result.staleCandidateIds,
        notice: '回退已成为当前版本；旧当前版保留为历史，候选已标为需要重新核对',
      }
    })
  }

  /**
   * Describe what a partial revert would depend on, before forming the candidate.
   * @param {string} versionId source version
   * @param {string[]} objectIds
   * @returns {object}
   */
  function describePartialRevert(versionId, objectIds) {
    const id = assertRef(versionId, 'versionId')
    const ids = assertRefList(objectIds, 'objectIds')
    if (ids.length === 0) throw new ValidationError('局部回退必须指明至少一个对象', { field: 'objectIds' })
    const source = versions.getVersion(id)
    if (source === null) throw new NotFoundError('来源版本不存在', { versionId: id })
    const currentVersionId = versions.getCurrent()?.versionId ?? null
    if (currentVersionId === null) throw new ConflictError('还没有当前版本', {})
    const currentVersion = versions.getVersion(currentVersionId)
    const currentPlanEntry = planOfVersion(paths, currentVersion)
    const sourcePlanEntry = planOfVersion(paths, source)
    if (currentPlanEntry === null || sourcePlanEntry === null) {
      return {
        applied: false,
        partial: true,
        versionId: id,
        objectIds: ids,
        dependenciesRequireRecheck: true,
        requiresRecheck: ids,
        plansAvailable: false,
        note: '当前或来源版本没有计划快照；只能形成候选，依赖影响无法从计划层列出，需重新制作检查',
      }
    }
    const currentPlan = currentPlanEntry.plan
    const sourcePlan = sourcePlanEntry.plan
    const scenes = new Set()
    const kits = []
    for (const objectId of ids) {
      const currentObject = currentPlan.objects.find((entry) => entry.id === objectId)
      if (currentObject === undefined) {
        throw new ValidationError('当前计划里没有要回退的对象', { objectId })
      }
      if (currentObject.sceneId !== null && currentObject.sceneId !== undefined) scenes.add(currentObject.sceneId)
      const kit = (currentPlan.kits ?? []).find((entry) => (entry.objectIds ?? []).includes(objectId))
      if (kit !== undefined) kits.push(...(kit.objectIds ?? []).filter((member) => !ids.includes(member)))
    }
    const neighbours = currentPlan.objects
      .filter((entry) => !ids.includes(entry.id))
      .filter((entry) => scenes.has(entry.sceneId))
      .map((entry) => entry.id)
    const windows = ids
      .map((objectId) => currentPlan.objects.find((entry) => entry.id === objectId))
      .filter((entry) => entry !== undefined)
      .map((entry) => ({ startFrame: entry.timeline.startFrame, endFrameExclusive: entry.timeline.endFrameExclusive }))
    const overlappingMovie = currentPlan.objects
      .filter((entry) => (entry.scope ?? 'scene') === 'movie')
      .filter((entry) => !ids.includes(entry.id))
      .filter((entry) =>
        windows.some(
          (window) =>
            entry.timeline.startFrame < window.endFrameExclusive &&
            entry.timeline.endFrameExclusive > window.startFrame,
        ),
      )
      .map((entry) => entry.id)
    const affectedFrames = mergeFrameRanges(currentPlan, windows)
    return {
      applied: false,
      partial: true,
      versionId: id,
      objectIds: ids,
      currentVersionId,
      plansAvailable: true,
      affectedFrames,
      sceneIds: [...scenes],
      neighbours,
      kitMembers: [...new Set(kits)],
      overlappingMovieObjects: overlappingMovie,
      dependenciesRequireRecheck: true,
      requiresRecheck: [...new Set([...neighbours, ...kits, ...overlappingMovie])],
      note: '局部回退只形成候选；相邻、共享组件实例、同场景对象与跨场景声音/字幕需要重新检查后才能接受',
    }
  }

  /**
   * Form a partial-revert candidate and report its dependencies. The current version is not changed.
   *
   * @param {object} input
   * @param {string} input.versionId
   * @param {string[]} input.objectIds
   * @param {string} [input.actor]
   * @param {string} [input.reason]
   * @returns {object}
   */
  function revertPartial(input = {}) {
    const versionId = assertRef(input.versionId, 'versionId')
    const objectIds = assertRefList(input.objectIds, 'objectIds')
    const actor = input.actor ?? 'user'
    if (actor !== 'user') {
      throw new ValidationError('局部回退是用户决定；AI 不能替用户回退', { field: 'actor', actor })
    }
    const reason = input.reason === undefined ? null : String(input.reason)
    if (objectIds.length === 0) throw new ValidationError('局部回退必须指明至少一个对象', { field: 'objectIds' })
    const state = describeHistory()
    if (state.finalized) throw new ConflictError('项目已定稿；历史只读查看', { versionId })
    const impact = describePartialRevert(versionId, objectIds)
    ensureEditingAllowed({ paths, clock, operation: 'partial-revert' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:partial-revert:${versionId}` }, () => {
      const result = versions.revertPartial({ versionId, objectIds, actor, reason })
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.partial-revert-formed',
          projectId: paths.projectId,
          actor,
          versionId,
          detail: {
            candidateId: result.candidate.candidateId,
            objectIds,
            requiresRecheck: impact.requiresRecheck,
          },
        }),
      ], { clock })
      return {
        ...result,
        applied: false,
        partial: true,
        requiresRecheck: impact.requiresRecheck,
        dependenciesRequireRecheck: true,
        impact,
        notice: '局部回退只形成候选，当前版本未变；依赖内容重新检查并接受后才能算完成',
      }
    })
  }

  /**
   * Counts for a projection.
   * @returns {object}
   */
  function describe() {
    const state = describeHistory()
    return {
      versions: state.versions,
      candidates: state.candidates,
      liveCandidates: state.liveCandidates,
      finalized: state.finalized,
      recoveryAvailable: state.recoveryAvailable,
      noRecoveryEntry: state.noRecoveryEntry,
    }
  }

  return {
    projectId: paths.projectId,
    describeHistory,
    listHistory,
    canRevert,
    revertToVersion,
    describePartialRevert,
    revertPartial,
    describe,
  }
}
