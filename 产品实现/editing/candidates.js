/**
 * Candidate decisions: accept as current, reject, abandon, continue editing, partial adoption and
 * partial user confirmation.
 *
 * Four states are kept strictly apart (CT-03 §5, C14 §4.5): accepting a candidate, partially
 * confirming one object, accepting the whole film and persisting an effect are different records on
 * different facts. Accepting a candidate never finalizes; a partial adoption returns a NEW candidate
 * that still needs re-production checks and is never reported as done.
 *
 * @module editing/candidates
 */

import { Clock, ConflictError, NotFoundError, ValidationError } from '../base/index.js'
import {
  appendEvents,
  buildEvent,
  createDecisionLog,
  createVersionStore,
  readDocument,
  tryReadDocument,
} from '../core/project/index.js'
import { ConfirmAspect, ConfirmScope, ConfirmationState } from '../core/project/schema.js'
import { normalizePlan, planFingerprint, bumpVersion } from '../media/index.js'
import { diffPlanFields } from './field-diff.js'
import { createComparisonStore } from './comparisons.js'
import { ensureEditingAllowed, withEditingWrite } from './guard.js'
import { createCandidateLinks } from './links.js'
import {
  EDITING_DOCUMENT,
  EDITING_LAYOUT,
  assertPlanRef,
  assertRef,
  assertRefList,
  assertText,
  copy,
  optionalText,
  readPlanSnapshot,
  writePlanSnapshot,
} from './ids.js'
import { analyzeScope } from './scope.js'

/** How a partial adoption stands. It is a candidate, never a completed edit. */
export const PartialAdoptionStatus = Object.freeze({
  NEW_CANDIDATE: 'new-candidate-needs-recheck',
})

/**
 * Open the candidate review of one project.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {object}
 */
export function createCandidateReview(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('候选审阅需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const versions = createVersionStore({ paths, clock })
  const decisions = createDecisionLog({ paths, clock })
  const comparisons = createComparisonStore({ paths, clock })
  const links = createCandidateLinks({ paths, clock })

  /**
   * Read the comparison a candidate points at, or throw.
   * @param {string} comparisonId
   * @returns {any}
   */
  function requireComparison(comparisonId) {
    const comparison = comparisons.getComparison(assertRef(comparisonId, 'comparisonId'))
    if (comparison === null) throw new NotFoundError('候选的对照记录不存在', { comparisonId })
    return comparison
  }

  /**
   * Describe one candidate, its base and whether it may be accepted right now.
   *
   * @param {string} candidateId
   * @returns {object}
   */
  function describeCandidate(candidateId) {
    const id = assertRef(candidateId, 'candidateId')
    const candidate = versions.getCandidate(id)
    if (candidate === null) throw new NotFoundError('候选不存在', { candidateId: id })
    const current = versions.getCurrent()
    const link = links.getLink(id)
    const comparison = link === null
      ? comparisons.getComparison(candidate.diffRef)
      : comparisons.getComparison(link.comparisonId)
    const stillCurrent = current !== null && candidate.baseVersionId === current.versionId
    const effectiveBase = candidate.recheckBaseVersionId ?? candidate.baseVersionId
    const baseStillValid = current !== null && effectiveBase === current.versionId
    const needsRecheck = candidate.status === 'needs-recheck' || baseStillValid !== true
    let acceptBlockedReason = null
    if (candidate.status === 'accepted') acceptBlockedReason = '候选已接受为当前版本'
    else if (candidate.status === 'rejected') acceptBlockedReason = '候选已被否定'
    else if (candidate.status === 'superseded') acceptBlockedReason = '候选已被取代'
    else if (needsRecheck) acceptBlockedReason = '基础版本已变化；必须先重新核对'
    else if (link === null) acceptBlockedReason = '候选没有可应用的计划快照；不能接受'
    else if (link.previewStale === true) acceptBlockedReason = '重新核对后还没有新预览；接受前需明确确认这一点'
    else if (candidate.previewRef === null) acceptBlockedReason = '候选还没有真实预览；接受前需明确确认缺预览'
    return {
      candidate: copy(candidate),
      comparison: comparison === null ? null : copy(comparison),
      link: link === null ? null : copy(link),
      currentVersionId: current === null ? null : current.versionId,
      baseStillCurrent: stillCurrent,
      baseStillValid,
      needsRecheck,
      needsRecheckReason: needsRecheck ? (candidate.recheckReason ?? '基础版本已不是当前版本') : null,
      acceptBlockedReason,
      previewAvailable: candidate.previewRef !== null,
      previewStale: link !== null && link.previewStale === true,
      partialConfirmationIsNotAcceptance: true,
    }
  }

  /**
   * Accept a candidate as the CURRENT version and apply its plan reference to the version content.
   *
   * C10 refuses a stale candidate; this wrapper additionally refuses an unseen candidate unless the
   * caller explicitly acknowledges that the preview is missing.
   *
   * @param {object} input
   * @param {string} input.candidateId
   * @param {string} [input.actor] must be `user` in the product flow
   * @param {boolean} [input.acknowledgeMissingPreview]
   * @param {string} [input.label]
   * @param {string} [input.substate]
   * @returns {object}
   */
  function acceptCandidate(input = {}) {
    const candidateId = assertRef(input.candidateId, 'candidateId')
    const actor = input.actor ?? 'user'
    if (actor !== 'user') {
      throw new ValidationError('只有用户能接受候选；AI 只能形成候选并等待用户决定', { field: 'actor', actor })
    }
    ensureEditingAllowed({ paths, clock, operation: 'accept-candidate' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:accept:${candidateId}` }, () => {
      const described = describeCandidate(candidateId)
      const candidate = described.candidate
      if (candidate.status === 'needs-recheck') {
        throw new ConflictError('候选的基础版本已变化，必须重新核对后才能接受', {
          candidateId,
          baseVersionId: candidate.baseVersionId,
          currentVersionId: described.currentVersionId,
          needsRecheck: true,
          action: '先调用 recheckCandidate 重新核对；程序不会静默套用旧候选',
        })
      }
      if (described.baseStillValid !== true) {
        throw new ConflictError('候选的基础版本已变化，必须重新核对后才能接受', {
          candidateId,
          baseVersionId: candidate.baseVersionId,
          currentVersionId: described.currentVersionId,
          needsRecheck: true,
        })
      }
      if (candidate.previewRef === null && input.acknowledgeMissingPreview !== true) {
        throw new ConflictError('候选没有真实预览；接受前必须由用户明确确认这一情况', {
          candidateId,
          action: '取得真实预览，或明确 acknowledgeMissingPreview 后接受',
        })
      }
      const link = links.getLink(candidateId)
      if (link === null) {
        throw new ConflictError('候选没有可应用的计划快照，不能把“接受”当成改写当前版', {
          candidateId,
          action: '重新形成候选并登记计划快照',
        })
      }
      const effectiveBase = candidate.recheckBaseVersionId ?? candidate.baseVersionId
      if (link.baseVersionId !== effectiveBase || effectiveBase !== described.currentVersionId) {
        throw new ConflictError('候选应用的计划与当前基础版本不一致，必须先重新核对', {
          candidateId,
          linkBaseVersionId: link.baseVersionId,
          effectiveBase,
          currentVersionId: described.currentVersionId,
        })
      }
      if (link.previewStale === true && input.acknowledgeStalePreview !== true) {
        throw new ConflictError('候选在重新核对后还没有新预览；接受前必须由用户明确确认', {
          candidateId,
          action: '重新渲染预览，或明确 acknowledgeStalePreview 后接受',
        })
      }
      const comparison = requireComparison(link.comparisonId)
      const accepted = versions.acceptCandidate(candidateId, {
        actor,
        substate: input.substate,
        label: input.label,
      })
      const patched = versions.updateCurrentContent({
        content: {
          planRef: link.planRef,
          planVersion: link.planVersion,
          comparisonRef: link.comparisonId,
          acceptedCandidateRef: candidateId,
          baseVersionRef: link.baseVersionId,
        },
      }, { actor: 'system' })
      const touchedConfirmations = markTouchedConfirmations(comparison)
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.candidate-accepted',
          projectId: paths.projectId,
          actor,
          versionId: accepted.version.versionId,
          detail: {
            candidateId,
            newCurrentVersionId: accepted.version.versionId,
            touchedConfirmations: touchedConfirmations.map((entry) => entry?.confirmationId ?? null),
            staleCandidateIds: accepted.staleCandidateIds,
          },
        }),
      ], { clock })
      return {
        candidate: accepted.candidate,
        version: patched,
        staleCandidateIds: accepted.staleCandidateIds,
        touchedConfirmations,
        previewMissing: candidate.previewRef === null,
        notice: '候选已接受为当前版本，不是定稿；整片验收与效果沉淀仍需单独决定',
      }
    })
  }

  /**
   * Mark any confirmation the accepted change actually touched, without pretending it still holds.
   * @param {any} comparison
   * @returns {object[]}
   */
  function markTouchedConfirmations(comparison) {
    const touched = []
    for (const objectId of comparison.diff.changedObjectIds) {
      const state = decisions.markChangedAfterConfirmation({
        objectId,
        aspect: ConfirmAspect.OBJECT_EDIT,
        reason: `候选 ${comparison.comparisonId} 修改了已确认对象`,
      })
      if (state !== null) touched.push({ objectId, aspect: ConfirmAspect.OBJECT_EDIT, state })
    }
    const whole = decisions.markChangedAfterConfirmation({
      objectId: 'movie',
      aspect: ConfirmAspect.INITIAL_CUT,
      reason: '整片内容在确认后被修改',
    })
    if (whole !== null) touched.push({ objectId: 'movie', aspect: ConfirmAspect.INITIAL_CUT, state: whole })
    return touched
  }

  /**
   * Reject a candidate. The record stays as history and the current version is untouched.
   * @param {object} input
   * @param {string} input.candidateId
   * @param {string} [input.reason]
   * @param {string} [input.actor]
   * @returns {object}
   */
  function rejectCandidate(input = {}) {
    const candidateId = assertRef(input.candidateId, 'candidateId')
    const actor = input.actor ?? 'user'
    const reason = optionalText(input.reason, 'reason')
    ensureEditingAllowed({ paths, clock, operation: 'reject-candidate' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:reject:${candidateId}` }, () => {
      const candidate = versions.getCandidate(candidateId)
      if (candidate === null) throw new NotFoundError('候选不存在', { candidateId })
      const rejected = versions.rejectCandidate(candidateId, { actor, reason })
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.candidate-rejected',
          projectId: paths.projectId,
          actor,
          detail: { candidateId, reason },
        }),
      ], { clock })
      return { candidate: rejected, notice: '候选已否定；原版本保持不变' }
    })
  }

  /**
   * Abandon a candidate without judging it.
   * @param {object} input
   * @param {string} input.candidateId
   * @param {string} [input.reason]
   * @param {string} [input.actor]
   * @returns {object}
   */
  function abandonCandidate(input = {}) {
    const candidateId = assertRef(input.candidateId, 'candidateId')
    const actor = input.actor ?? 'user'
    const reason = optionalText(input.reason, 'reason')
    ensureEditingAllowed({ paths, clock, operation: 'abandon-candidate' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:abandon-candidate:${candidateId}` }, () => {
      const candidate = versions.getCandidate(candidateId)
      if (candidate === null) throw new NotFoundError('候选不存在', { candidateId })
      return { candidate: versions.abandonCandidate(candidateId, { actor, reason }) }
    })
  }

  /**
   * Re-check a stale candidate against the current version, then record the result.
   * @param {object} input
   * @param {string} input.candidateId
   * @param {string} [input.actor]
   * @param {string} [input.note]
   * @returns {object}
   */
  function recheckCandidate(input = {}) {
    const candidateId = assertRef(input.candidateId, 'candidateId')
    const actor = input.actor ?? 'user'
    const note = optionalText(input.note, 'note')
    ensureEditingAllowed({ paths, clock, operation: 'recheck-candidate' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:recheck:${candidateId}` }, () => {
      const candidate = versions.getCandidate(candidateId)
      if (candidate === null) throw new NotFoundError('候选不存在', { candidateId })
      if (!['open', 'needs-recheck'].includes(candidate.status)) {
        throw new ConflictError('候选已经结束，不能再重新核对', { candidateId, status: candidate.status })
      }
      const current = versions.getCurrent()
      if (current === null) throw new ConflictError('还没有当前版本，无法重新核对', {})
      const link = links.getLink(candidateId)
      if (link === null) throw new ConflictError('候选没有计划快照，无法重建', { candidateId })
      if (current.versionId === link.baseVersionId) {
        return {
          candidate: versions.recheckCandidate(candidateId, { actor, note, againstVersionId: current.versionId }),
          rebased: false,
          comparison: comparisons.getComparison(link.comparisonId),
          notice: '基础版本未变化；仅记录重新核对，候选仍需用户接受',
        }
      }
      const currentRef = current.content?.planRef
      if (typeof currentRef !== 'string') {
        throw new ConflictError('当前版本没有计划快照，无法把候选重放到新基础', { currentVersionId: current.versionId })
      }
      const baseComparison = requireComparison(link.comparisonId)
      const oldBase = readPlanSnapshot(paths, baseComparison.base.planRef).plan
      const candidatePlan = readPlanSnapshot(paths, link.planRef).plan
      const currentPlan = readPlanSnapshot(paths, currentRef).plan
      const oldToCurrent = diffPlanFields(oldBase, currentPlan)
      const oldToCandidate = diffPlanFields(oldBase, candidatePlan)
      if (
        oldToCandidate.transitions.added.length > 0 ||
        oldToCandidate.transitions.removed.length > 0 ||
        oldToCandidate.transitions.changed.length > 0 ||
        oldToCandidate.scenes.added.length > 0 ||
        oldToCandidate.scenes.removed.length > 0 ||
        oldToCandidate.timebaseChanged === true
      ) {
        throw new ConflictError('候选包含时间、转场或场景结构变化，不能按对象重放到新基础', {
          candidateId,
          action: '基于当前版本重新形成候选，并重新渲染对照',
        })
      }
      const overlap = oldToCurrent.changedObjectIds.filter((objectId) =>
        oldToCandidate.changedObjectIds.includes(objectId),
      )
      if (overlap.length > 0) {
        throw new ConflictError('候选与新的当前版本改了同一对象，必须重新形成候选', {
          candidateId,
          conflictObjectIds: overlap,
          action: '重新发起修改；不能把两边的改动互相覆盖',
        })
      }
      let objects = currentPlan.objects.filter((entry) => !oldToCandidate.objects.removed.includes(entry.id))
      objects = objects.map((entry) => {
        if (!oldToCandidate.changedObjectIds.includes(entry.id)) return entry
        const replacement = candidatePlan.objects.find((item) => item.id === entry.id)
        return replacement === undefined ? entry : copy(replacement)
      })
      for (const addedId of oldToCandidate.objects.added) {
        if (objects.some((entry) => entry.id === addedId)) continue
        const added = candidatePlan.objects.find((item) => item.id === addedId)
        if (added !== undefined) objects.push(copy(added))
      }
      const rebased = normalizePlan(
        { ...currentPlan, objects, planVersion: bumpVersion(currentPlan.planVersion) },
        { now: () => clock.iso() },
      )
      const rebasedDiff = diffPlanFields(currentPlan, rebased)
      const outside = rebasedDiff.changedObjectIds.filter(
        (objectId) => !oldToCandidate.changedObjectIds.includes(objectId),
      )
      if (outside.length > 0 || rebasedDiff.timebaseChanged === true || rebasedDiff.soundChanged === true) {
        throw new ConflictError('把候选重放到新基础后，改动范围失控，拒绝标记已核对', {
          candidateId,
          outside,
        })
      }
      const stored = writePlanSnapshot({
        paths,
        ownerId: `recheck-${candidateId}`,
        plan: rebased,
        clock,
      })
      const comparison = comparisons.createComparison({
        baseVersionId: current.versionId,
        againstVersionId: null,
        basePlan: currentPlan,
        nextPlan: rebased,
        basePlanRef: currentRef,
        againstPlanRef: stored.planRef,
        targetObjectIds: oldToCandidate.changedObjectIds,
        preserveObjectIds: rebasedDiff.protectedObjectIds,
        previews: [],
        runtimeLabel: 'ffmpeg',
        createdBy: actor,
      })
      links.setLink({
        candidateId,
        comparisonId: comparison.comparisonId,
        planRef: stored.planRef,
        planVersion: rebased.planVersion,
        baseVersionId: current.versionId,
        rebased: true,
        previewStale: true,
        note: note ?? '基础版本变化后把候选改动重放到当前版本；预览尚未重做',
      })
      const rechecked = versions.recheckCandidate(candidateId, {
        actor,
        note: note ?? '基础版本变化后已重建候选计划',
        againstVersionId: current.versionId,
      })
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.candidate-rechecked',
          projectId: paths.projectId,
          actor,
          detail: {
            candidateId,
            comparisonId: comparison.comparisonId,
            rebased: true,
            changedObjectIds: rebasedDiff.changedObjectIds,
            previewStale: true,
          },
        }),
      ], { clock })
      return {
        candidate: rechecked,
        comparison,
        rebased: true,
        changedObjectIds: rebasedDiff.changedObjectIds,
        previewStale: true,
        notice: '已把候选改动重放到当前版本；预览未重做，接受前需用户明确确认或重新渲染',
      }
    })
  }

  /**
   * Partially adopt one candidate's object changes.
   *
   * This does NOT change the current version and does not claim completion: it forms a NEW candidate
   * whose dependency re-checks are named, because adopting some objects leaves everything that
   * depended on the full candidate in a newer state.
   *
   * @param {object} input
   * @param {string} input.candidateId
   * @param {string[]} input.objectIds the changed objects to adopt
   * @param {string} [input.actor]
   * @param {string} [input.reason]
   * @returns {object}
   */
  function partialAdopt(input = {}) {
    const candidateId = assertRef(input.candidateId, 'candidateId')
    const objectIds = assertRefList(input.objectIds, 'objectIds')
    if (objectIds.length === 0) throw new ValidationError('部分采用必须指明至少一个对象', { field: 'objectIds' })
    const actor = input.actor ?? 'user'
    const reason = optionalText(input.reason, 'reason')
    if (actor !== 'user') {
      throw new ValidationError('部分采用是用户决定；AI 不能替用户选择采用哪一部分', { field: 'actor', actor })
    }
    ensureEditingAllowed({ paths, clock, operation: 'partial-adopt' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:partial-adopt:${candidateId}` }, () => {
      const candidate = versions.getCandidate(candidateId)
      if (candidate === null) throw new NotFoundError('候选不存在', { candidateId })
      if (candidate.status === 'needs-recheck') {
        throw new ConflictError('候选基础版本已变化；重新核对后才能部分采用', { candidateId })
      }
      if (candidate.status !== 'open') throw new ConflictError('候选已经结束', { candidateId, status: candidate.status })
      const current = versions.getCurrent()
      if (current === null) throw new ConflictError('还没有当前版本', {})
      if (candidate.baseVersionId !== current.versionId) {
        throw new ConflictError('候选的基础版本已变化；重新核对后才能部分采用', {
          candidateId,
          baseVersionId: candidate.baseVersionId,
          currentVersionId: current.versionId,
        })
      }
      const comparison = requireComparison(candidate.diffRef)
      const basePlan = readPlanSnapshot(paths, comparison.base.planRef).plan
      const candidatePlan = readPlanSnapshot(paths, comparison.against.planRef).plan
      const changed = comparison.diff.changedObjectIds
      for (const objectId of objectIds) {
        if (!changed.includes(objectId)) {
          throw new ValidationError('该对象不在候选的变更范围内，不能假装部分采用', { candidateId, objectId })
        }
      }
      if (comparison.diff.transitions.changed.length > 0 || comparison.timing.totalFrames.deltaFrames !== 0) {
        throw new ConflictError('候选改变了转场或总时长，不能按对象部分采用', {
          candidateId,
          action: '时间变化需要整段重新制作检查，不能拆成对象采用',
        })
      }
      const objects = basePlan.objects.map((object) => {
        if (!objectIds.includes(object.id)) return object
        const replacement = candidatePlan.objects.find((entry) => entry.id === object.id)
        if (replacement === undefined) throw new ValidationError('候选计划缺少该对象', { objectId: object.id })
        return copy(replacement)
      })
      const mixed = normalizePlan(
        { ...basePlan, objects, planVersion: bumpVersion(basePlan.planVersion) },
        { now: () => clock.iso() },
      )
      if (planFingerprint(mixed) === planFingerprint(basePlan)) {
        throw new ConflictError('所选对象在候选里没有实际变化', { candidateId, objectIds })
      }
      const scope = analyzeScope({
        basePlan,
        nextPlan: mixed,
        targetObjectIds: objectIds,
        allowedRippleIds: [],
        preserveObjectIds: [],
      })
      if (scope.ok !== true) throw new ConflictError('部分采用会越出所选对象', { violations: scope.violations })
      const stored = writePlanSnapshot({ paths, ownerId: `partial-${candidateId}`, plan: mixed, clock })
      const requiresRecheck = computeDependencies(basePlan, mixed, objectIds)
      const comparisonMixed = comparisons.createComparison({
        baseVersionId: current.versionId,
        againstVersionId: null,
        basePlan,
        nextPlan: mixed,
        basePlanRef: comparison.base.planRef,
        againstPlanRef: stored.planRef,
        targetObjectIds: objectIds,
        preserveObjectIds: scope.protectedObjectIds,
        previews: [],
        runtimeLabel: 'ffmpeg',
        createdBy: actor,
      })
      const partial = versions.createCandidate({
        baseVersionId: current.versionId,
        target: `部分采用候选 ${candidateId} 的 ${objectIds.length} 个对象`,
        scope: ConfirmScope.PART,
        preservedItems: scope.protectedObjectIds,
        diffRef: comparisonMixed.comparisonId,
        previewRef: null,
        checkScope: [...objectIds, ...requiresRecheck],
        actor,
      })
      links.setLink({
        candidateId: partial.candidateId,
        comparisonId: comparisonMixed.comparisonId,
        planRef: stored.planRef,
        planVersion: mixed.planVersion,
        baseVersionId: current.versionId,
        note: '部分采用形成的候选；依赖对象仍需重新检查',
      })
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.candidate-partial-adopted',
          projectId: paths.projectId,
          actor,
          detail: {
            sourceCandidateId: candidateId,
            partialCandidateId: partial.candidateId,
            objectIds,
            requiresRecheck,
            reason,
          },
        }),
      ], { clock })
      return {
        status: PartialAdoptionStatus.NEW_CANDIDATE,
        applied: false,
        partial: true,
        sourceCandidateId: candidateId,
        candidate: copy(partial),
        comparison: copy(comparisonMixed),
        adoptedObjectIds: objectIds,
        requiresRecheck,
        dependenciesRequireRecheck: requiresRecheck.length > 0,
        notice: '部分采用只形成新候选，没有改动当前版本；依赖对象重新检查并通过后，才能接受',
      }
    })
  }

  /**
   * Objects whose meaning depends on the adopted ones: same scene, shared kit, transition participants,
   * and audio/subtitle windows that overlap the adopted window.
   * @param {any} basePlan
   * @param {any} mixedPlan
   * @param {string[]} adoptedIds
   * @returns {string[]}
   */
  function computeDependencies(basePlan, mixedPlan, adoptedIds) {
    const targets = mixedPlan.objects.filter((entry) => adoptedIds.includes(entry.id))
    const scenes = new Set(targets.map((entry) => entry.sceneId).filter(Boolean))
    const kits = (basePlan.kits ?? []).filter((kit) => (kit.objectIds ?? []).some((id) => adoptedIds.includes(id)))
    const kitMembers = kits.flatMap((kit) => (kit.objectIds ?? []).filter((id) => !adoptedIds.includes(id)))
    const windows = targets.map((entry) => ({
      start: entry.timeline.startFrame,
      end: entry.timeline.endFrameExclusive,
    }))
    const neighbours = mixedPlan.objects
      .filter((entry) => !adoptedIds.includes(entry.id))
      .filter((entry) => scenes.has(entry.sceneId))
      .map((entry) => entry.id)
    const overlapping = mixedPlan.objects
      .filter((entry) => !adoptedIds.includes(entry.id))
      .filter((entry) => (entry.scope ?? 'scene') === 'movie')
      .filter((entry) =>
        windows.some(
          (window) => entry.timeline.startFrame < window.end && entry.timeline.endFrameExclusive > window.start,
        ),
      )
      .map((entry) => entry.id)
    const transitions = mixedPlan.transitions
      .filter((entry) => scenes.has(entry.fromScene) || scenes.has(entry.toScene))
      .map((entry) => `transition:${entry.id}`)
    return [...new Set([...neighbours, ...kitMembers, ...overlapping, ...transitions])]
  }

  /**
   * Record a LOCAL user confirmation: object + aspect + scope + version, never a whole-film pass.
   *
   * @param {object} input
   * @param {string} input.objectId
   * @param {string} input.aspect one of `ConfirmAspect`
   * @param {string} [input.scope] `object` | `range` | `part`; `whole` is refused here
   * @param {string} input.versionId
   * @param {string} input.humanResponse the user's own words
   * @param {string[]} [input.evidenceRefs]
   * @param {string} [input.candidateId] when the confirmation is about a candidate's object change
   * @returns {object}
   */
  function recordPartialConfirmation(input = {}) {
    const objectId = assertRef(input.objectId, 'objectId')
    const aspect = assertText(input.aspect, 'aspect', 40)
    const scope = input.scope ?? ConfirmScope.OBJECT
    if (scope === ConfirmScope.WHOLE) {
      throw new ValidationError('局部确认不能作用于整片；整片验收是另一个决定', { scope })
    }
    if (![ConfirmScope.OBJECT, ConfirmScope.RANGE, ConfirmScope.PART].includes(scope)) {
      throw new ValidationError('局部确认范围不合法', { scope })
    }
    const versionId = assertRef(input.versionId, 'versionId')
    const humanResponse = assertText(input.humanResponse, 'humanResponse')
    const candidateId = input.candidateId === undefined ? null : assertRef(input.candidateId, 'candidateId')
    if (candidateId !== null) {
      const candidate = versions.getCandidate(candidateId)
      if (candidate === null) throw new NotFoundError('候选不存在', { candidateId })
      const comparison = requireComparison(candidate.diffRef)
      if (!comparison.diff.changedObjectIds.includes(objectId)) {
        throw new ValidationError('该对象不在候选的变更范围，局部确认不能扩展', { candidateId, objectId })
      }
    }
    ensureEditingAllowed({ paths, clock, operation: 'partial-confirmation' })
    return withEditingWrite({ paths, clock, taskId: 'EDITING-REVIEW:partial-confirmation' }, () => {
      const record = decisions.recordConfirmation({
        actor: 'user',
        objectId,
        aspect,
        scope,
        versionId,
        state: ConfirmationState.PARTIALLY_CONFIRMED,
        humanResponse,
        evidenceRefs: assertRefList(input.evidenceRefs, 'evidenceRefs'),
      })
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.partial-confirmation',
          projectId: paths.projectId,
          actor: 'user',
          detail: { confirmationId: record.confirmationId, objectId, aspect, scope, versionId, candidateId },
        }),
      ], { clock })
      return {
        confirmation: record,
        wholeFilmAccepted: false,
        candidateAccepted: false,
        notice: '局部确认已记录；它不等于整片验收，也不自动接受候选',
      }
    })
  }

  /**
   * Read-only status of one candidate for a surface.
   * @param {string} candidateId
   * @returns {object}
   */
  function candidateStatus(candidateId) {
    return describeCandidate(candidateId)
  }

  return {
    projectId: paths.projectId,
    describeCandidate,
    candidateStatus,
    acceptCandidate,
    rejectCandidate,
    abandonCandidate,
    recheckCandidate,
    partialAdopt,
    recordPartialConfirmation,
    _versions: versions,
    _comparisons: comparisons,
    _decisions: decisions,
    _docs: { readDocument, tryReadDocument, EDITING_LAYOUT, EDITING_DOCUMENT },
  }
}
