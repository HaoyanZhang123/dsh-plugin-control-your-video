/**
 * AI complex modification: a declared work package handed to the ORIGINAL production sub-agent, and
 * the returned result checked before it may become a candidate.
 *
 * The organization is the product requirement (C14 §4.4, CT-08): the main agent prepares a bounded
 * work package and the same making sub-agent that produced the work performs the modification. This
 * module therefore has no "spawn agent" path at all: it requires the producer session id that C13
 * already bound to the run and refuses anything else. It also refuses to dispatch while production
 * is running — the edit waits for a real pause.
 *
 * @module editing/producer
 */

import { Clock, ConflictError, NotFoundError, ValidationError, contentHash } from '../base/index.js'
import { appendEvents, buildEvent, createDecisionLog, createVersionStore } from '../core/project/index.js'
import { ConfirmAspect, ConfirmScope } from '../core/project/schema.js'
import { normalizePlan } from '../media/index.js'
import { createOrchestrationKit } from '../orchestration/index.js'
import { createComparisonStore } from './comparisons.js'
import { ensureEditingAllowed, ensurePlanningAllowed, pauseProductionForEditing, withEditingWrite } from './guard.js'
import { createCandidateLinks } from './links.js'
import {
  EDITING_DOCUMENT,
  EDITING_LAYOUT,
  assertRef,
  assertRefList,
  assertText,
  copy,
  newEditingId,
  optionalText,
  planOfVersion,
  readEditingDocument,
  readPlanSnapshot,
  writeEditingDocument,
  writePlanSnapshot,
} from './ids.js'
import { analyzeScope, describeEditScope } from './scope.js'

/** Request lifecycle. A failed request keeps both the original version and its real scope. */
export const EditRequestStatus = Object.freeze({
  NEEDS_USER: 'needs-user',
  PLANNED: 'planned',
  DISPATCHED: 'dispatched',
  RETURNED: 'returned',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

/** The return contract the producer must satisfy (C14 §4.4). */
export const PRODUCER_RETURN_CONTRACT = Object.freeze([
  'candidatePlan（真实候选计划，基于请求里的基础版本）',
  'originalNewComparison（原新对照：真实预览或明确的缺预览说明）',
  'knownIssues（已知问题，逐条）',
  'checkScope（实际检查范围，不能写成全部通过）',
  'evidenceRefs（证据引用）',
])

/** Empty requests document. @param {string} projectId */
export function emptyRequestsDocument(projectId) {
  return { kind: EDITING_DOCUMENT.requests, projectId, requests: [] }
}

/**
 * Open the AI-edit request store of one project.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {object}
 */
export function createAiEditing(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('AI 修改需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const versions = createVersionStore({ paths, clock })
  const decisions = createDecisionLog({ paths, clock })
  const comparisons = createComparisonStore({ paths, clock })
  const links = createCandidateLinks({ paths, clock })
  const file = EDITING_LAYOUT.requestsFile

  /** @returns {{ doc: any, revision: string|null }} */
  function read() {
    const stored = readEditingDocument(
      paths,
      file,
      EDITING_DOCUMENT.requests,
      () => emptyRequestsDocument(paths.projectId),
    )
    return { doc: stored.value, revision: stored.revision }
  }

  /** @param {any} doc @param {string|null} revision */
  function save(doc, revision) {
    return writeEditingDocument(paths, file, doc, revision, clock, 'AI 修改请求')
  }

  /**
   * @param {any} doc
   * @param {string} requestId
   * @returns {any}
   */
  function requireRequest(doc, requestId) {
    const id = assertRef(requestId, 'requestId')
    const request = doc.requests.find((entry) => entry.requestId === id)
    if (request === undefined) throw new NotFoundError('AI 修改请求不存在', { requestId: id })
    return request
  }

  /**
   * Verify that a user decision really exists in C10 before a direction change is dispatched.
   * @param {{ decisionRef?: string }} input
   * @returns {any|null}
   */
  function verifiedDecision(input) {
    if (input.decisionRef === undefined || input.decisionRef === null) return null
    const confirmationId = assertRef(input.decisionRef, 'decisionRef')
    const records = decisions.listConfirmations({}).filter((entry) => entry.confirmationId === confirmationId)
    if (records.length === 0) throw new ValidationError('引用的用户确认不存在', { decisionRef: confirmationId })
    const record = records[records.length - 1]
    if (!['partially-confirmed', 'confirmed'].includes(record.state)) {
      throw new ValidationError('引用的记录不是用户确认', { decisionRef: confirmationId, state: record.state })
    }
    if (![ConfirmAspect.OBJECT_EDIT, ConfirmAspect.DIRECTION].includes(record.aspect)) {
      throw new ValidationError('方向变化的确认方面不匹配', { decisionRef: confirmationId, aspect: record.aspect })
    }
    return record
  }

  /**
   * Plan one AI modification: declare base version, target, preserve, range and necessary ripple.
   *
   * A direction change without a real user decision is proposed to C10 and stops at `needs-user`;
   * nothing is dispatched and the user's silence is not a confirmation.
   *
   * @param {object} input
   * @param {string} input.instruction the user's words (stored verbatim)
   * @param {string[]} input.targetObjectIds
   * @param {string} input.target what should change
   * @param {string} input.scope one of `object` | `range` | `part`
   * @param {{ startFrame: number, endFrameExclusive: number }} [input.range]
   * @param {string[]} [input.preserveObjectIds]
   * @param {boolean} [input.directionChange]
   * @param {string} [input.decisionRef] a real C10 user confirmation, when the direction changed
   * @param {boolean} [input.timingEdit] the request may change total duration
   * @param {boolean} [input.transitionEdit]
   * @param {string[]} [input.allowedRippleObjectIds] declared necessary ripple beyond the targets
   * @param {string} [input.baseVersionId] must be the current version
   * @param {any} [input.plan] the normalized base plan
   * @param {string} [input.actor]
   * @param {string} [input.author]
   * @returns {object}
   */
  function planAiEdit(input = {}) {
    const instruction = assertText(input.instruction, 'instruction')
    const target = assertText(input.target, 'target')
    const scope = assertText(input.scope, 'scope', 20)
    if (![ConfirmScope.OBJECT, ConfirmScope.RANGE, ConfirmScope.PART].includes(scope)) {
      throw new ConflictError('AI 修改不接受整片重做范围；请分成对象／范围请求', { scope })
    }
    const targetObjectIds = assertRefList(input.targetObjectIds, 'targetObjectIds')
    if (targetObjectIds.length === 0) throw new ValidationError('AI 修改需要至少一个目标对象', { field: 'targetObjectIds' })
    const allowedRipple = assertRefList(input.allowedRippleObjectIds, 'allowedRippleObjectIds')
    ensurePlanningAllowed({ paths, clock, operation: 'plan-ai-edit' })
    return withEditingWrite({ paths, clock, taskId: 'EDITING-REVIEW:plan-ai-edit' }, () => {
      const current = versions.getCurrent()
      if (current === null) throw new ConflictError('还没有当前版本，不能发起修改', {})
      const baseVersionId = input.baseVersionId ?? current.versionId
      if (baseVersionId !== current.versionId) {
        throw new ConflictError('AI 复杂修改只能基于当前版本发起；旧版本请先形成新候选', {
          baseVersionId,
          currentVersionId: current.versionId,
        })
      }
      const storedPlan = planOfVersion(paths, current)
      const basePlan = storedPlan === null ? input.plan : storedPlan.plan
      if (basePlan === undefined || basePlan === null) {
        throw new ValidationError('当前版本还没有计划快照；发起修改必须提供基础计划', { baseVersionId })
      }
      if (storedPlan !== null && input.plan !== undefined && contentHash(input.plan) !== storedPlan.fingerprint) {
        throw new ConflictError('提交的计划与当前版本快照不一致', { baseVersionId })
      }
      const { doc, revision } = read()
      const requestId = newEditingId(
        'edt-req',
        `${paths.projectId}:${baseVersionId}:${doc.requests.length + 1}:${clock.iso()}`,
      )
      const baseSnapshot = writePlanSnapshot({ paths, ownerId: requestId, plan: basePlan, clock })
      const editScope = describeEditScope({
        plan: basePlan,
        targetObjectIds,
        preserveObjectIds: input.preserveObjectIds,
      })
      const ripple = [...allowedRipple]
      for (const id of ripple) {
        if (!basePlan.objects.some((entry) => entry.id === id)) {
          throw new ValidationError('声明牵连的对象不在基础计划里', { objectId: id })
        }
      }
      const directionChange = input.directionChange === true
      let decision = null
      let proposal = null
      let status = EditRequestStatus.PLANNED
      if (directionChange) {
        decision = verifiedDecision({ decisionRef: input.decisionRef })
        if (decision === null) {
          proposal = decisions.proposeConfirmation({
            actor: 'ai',
            objectId: targetObjectIds[0] ?? 'movie',
            aspect: ConfirmAspect.DIRECTION,
            scope: ConfirmScope.PART,
            versionId: baseVersionId,
            proposedState: 'partially-confirmed',
            rationale: `方向变化需要用户先确认：${instruction}`,
          })
          status = EditRequestStatus.NEEDS_USER
        }
      }
      const at = clock.iso()
      /** @type {any} */
      const request = {
        requestId,
        mode: 'ai',
        status,
        producerSessionId: null,
        producerRunId: null,
        baseVersionId,
        basePlanRef: baseSnapshot.planRef,
        basePlanVersion: basePlan.planVersion,
        basePlanFingerprint: baseSnapshot.fingerprint,
        instruction,
        author: input.author ?? 'user',
        actor: input.actor ?? 'user',
        target,
        scope,
        targetObjectIds,
        preserveObjectIds: editScope.preserve,
        explicitPreserveObjectIds: assertRefList(input.preserveObjectIds, 'preserveObjectIds'),
        allowedRippleObjectIds: ripple,
        declarations: {
          directionChange,
          timingEdit: input.timingEdit === true,
          transitionEdit: input.transitionEdit === true,
          decisionRef: decision === null ? null : decision.confirmationId,
          proposalRef: proposal === null ? null : proposal.proposalId,
        },
        range: input.range ?? null,
        scopePlan: {
          targets: editScope.targets,
          kits: editScope.kits,
          movieObjects: editScope.movieObjects,
          requiresWholeFilmWatch: editScope.requiresWholeFilmWatch,
          audioProtected: true,
        },
        workPackage: null,
        pausedProduction: null,
        result: null,
        failure: null,
        createdAt: at,
        updatedAt: at,
      }
      doc.requests.push(request)
      save(doc, revision)
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.ai-request-planned',
          projectId: paths.projectId,
          actor: input.actor ?? 'user',
          detail: {
            requestId,
            baseVersionId,
            target,
            targetObjectIds,
            status,
            proposalRef: request.declarations.proposalRef,
          },
        }),
      ], { clock })
      return {
        request: copy(request),
        needsUserDecision: status === EditRequestStatus.NEEDS_USER,
        proposal: proposal === null ? null : copy(proposal),
        notice: status === EditRequestStatus.NEEDS_USER
          ? '这次 AI 修改会改变方向或关键效果，已提交用户确认；未回复前不会交给制作子 Agent'
          : '工作包已声明；实际修改前会先暂停制作',
        returnContract: [...PRODUCER_RETURN_CONTRACT],
      }
    })
  }

  /**
   * Pause production and hand the work package to the ORIGINAL production sub-agent.
   *
   * @param {object} input
   * @param {string} input.requestId
   * @param {string} input.producerSessionId the session id C13 bound at the first unit
   * @returns {object}
   */
  function dispatchToProducer(input = {}) {
    const requestId = assertRef(input.requestId, 'requestId')
    const producerSessionId = assertText(input.producerSessionId, 'producerSessionId', 120)
    ensurePlanningAllowed({ paths, clock, operation: 'dispatch-ai-edit' })
    const paused = pauseProductionForEditing({
      paths,
      clock,
      reason: `修改请求 ${requestId}：先暂停制作再交给原子 Agent`,
    })
    const orchestration = createOrchestrationKit({ paths, clock })
    let run
    try {
      run = orchestration.production.assertProducer(producerSessionId)
    } catch (error) {
      throw new ConflictError('只能由原制作子 Agent 修改；没有可复用的制作身份', {
        producerSessionId,
        reason: error instanceof Error ? error.message : String(error),
        action: '不要新建制作 Agent；先在 C13 建立并绑定唯一制作会话',
      })
    }
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:dispatch:${requestId}` }, () => {
      const { doc, revision } = read()
      const request = requireRequest(doc, requestId)
      if (request.status === EditRequestStatus.RETURNED || request.status === EditRequestStatus.FAILED) {
        throw new ConflictError('该请求已经结束，不能再次派发', { requestId, status: request.status })
      }
      if (request.status === EditRequestStatus.NEEDS_USER) {
        throw new ConflictError('方向变化还没有用户确认，不能派发', {
          requestId,
          proposalRef: request.declarations.proposalRef,
        })
      }
      const current = versions.getCurrent()
      if (current === null || current.versionId !== request.baseVersionId) {
        throw new ConflictError('基础版本已变化；先重新核对并基于当前版本重建请求', {
          requestId,
          baseVersionId: request.baseVersionId,
          currentVersionId: current === null ? null : current.versionId,
        })
      }
      const active = doc.requests.filter(
        (entry) =>
          entry.requestId !== requestId &&
          (entry.status === EditRequestStatus.DISPATCHED || entry.status === EditRequestStatus.PLANNED),
      )
      if (active.length > 0) {
        throw new ConflictError('同一项目同一时刻只能有一个待执行的修改请求', {
          requestId,
          activeRequestIds: active.map((entry) => entry.requestId),
        })
      }
      /** @type {any} */
      const workPackage = {
        requestId,
        baseVersionId: request.baseVersionId,
        basePlanRef: request.basePlanRef,
        producerSessionId,
        producerRunId: run.runId,
        target: request.target,
        targetObjectIds: request.targetObjectIds,
        preserveObjectIds: request.preserveObjectIds,
        allowedRippleObjectIds: request.allowedRippleObjectIds,
        range: request.range,
        scope: request.scope,
        instruction: request.instruction,
        constraints: [
          '只重制目标及声明牵连，保护相邻、未选、共享组件与音轨',
          '返回真实候选、原新对照、已知问题和实际检查范围',
          '基础版本变化时先重新核对，不静默套用',
        ],
        returnContract: [...PRODUCER_RETURN_CONTRACT],
        issuedAt: clock.iso(),
      }
      request.producerSessionId = producerSessionId
      request.producerRunId = run.runId
      request.workPackage = workPackage
      request.pausedProduction = {
        changed: paused.changed,
        executionBefore: paused.changed ? 'running-or-waiting' : paused.execution,
        executionAfter: paused.execution,
        pausedAt: clock.iso(),
      }
      request.status = EditRequestStatus.DISPATCHED
      request.dispatchedAt = clock.iso()
      request.updatedAt = clock.iso()
      save(doc, revision)
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.ai-request-dispatched',
          projectId: paths.projectId,
          actor: 'system',
          detail: {
            requestId,
            producerSessionId,
            producerRunId: run.runId,
            productionPaused: paused.changed,
          },
        }),
      ], { clock })
      return {
        request: copy(request),
        workPackage,
        production: {
          paused: paused.changed,
          execution: paused.execution,
        },
        notice: paused.changed
          ? '制作已暂停，工作包已交给原制作子 Agent'
          : '制作已处于可编辑状态，工作包已交给原制作子 Agent',
      }
    })
  }

  /**
   * Record the producer's real return, validate it, and form an AI candidate.
   *
   * A returned plan outside the declared scope is recorded as a FAILURE with the real diff, not
   * silently trimmed into a candidate. A failure keeps the original version untouched.
   *
   * @param {object} input
   * @param {string} input.requestId
   * @param {string} input.producerSessionId
   * @param {any} [input.plan] the returned normalized (or normalizable) plan
   * @param {string} [input.previewRef] real media reference for the new result
   * @param {string[]} [input.checkScope]
   * @param {string[]} [input.knownIssues]
   * @param {string[]} [input.actualChecks]
   * @param {string[]} [input.evidenceRefs]
   * @param {object} [input.failure] `{ reason, realSuccessScope?, evidenceRefs? }`
   * @returns {object}
   */
  function recordProducerReturn(input = {}) {
    const requestId = assertRef(input.requestId, 'requestId')
    const producerSessionId = assertText(input.producerSessionId, 'producerSessionId', 120)
    ensureEditingAllowed({ paths, clock, operation: 'record-ai-return' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:return:${requestId}` }, () => {
      const { doc, revision } = read()
      const request = requireRequest(doc, requestId)
      if (request.status !== EditRequestStatus.DISPATCHED) {
        throw new ConflictError('该请求不在已派发状态，不能记录返回', { requestId, status: request.status })
      }
      const orchestration = createOrchestrationKit({ paths, clock })
      const run = orchestration.production.assertProducer(producerSessionId)
      if (run.runId !== request.producerRunId) {
        throw new ConflictError('返回者不是被派发的那次制作运行', {
          expected: request.producerRunId,
          actual: run.runId,
        })
      }
      if (input.failure !== undefined && input.failure !== null) {
        request.status = EditRequestStatus.FAILED
        request.failure = {
          at: clock.iso(),
          reason: assertText(input.failure.reason, 'failure.reason'),
          realSuccessScope: assertRefList(input.failure.realSuccessScope, 'failure.realSuccessScope'),
          evidenceRefs: assertRefList(input.failure.evidenceRefs, 'failure.evidenceRefs'),
          preservedOriginal: true,
        }
        request.returnedAt = clock.iso()
        request.updatedAt = clock.iso()
        save(doc, revision)
        appendEvents(paths.dir, [
          buildEvent({
            kind: 'editing.ai-request-failed',
            projectId: paths.projectId,
            actor: 'ai',
            detail: { requestId, reason: request.failure.reason, preservedOriginal: true },
          }),
        ], { clock })
        return {
          request: copy(request),
          status: request.status,
          candidate: null,
          notice: '修改失败；原版本保持不变，失败原因和真实成功范围已记录',
        }
      }
      if (input.plan === undefined || input.plan === null) {
        throw new ValidationError('返回必须带真实候选计划', { field: 'plan' })
      }
      const basePlan = readPlanSnapshot(paths, request.basePlanRef).plan
      let candidatePlan
      try {
        candidatePlan = normalizePlan(input.plan, { now: () => clock.iso() })
      } catch (error) {
        request.status = EditRequestStatus.FAILED
        request.failure = {
          at: clock.iso(),
          reason: `返回的计划无法规范化：${error instanceof Error ? error.message : String(error)}`,
          realSuccessScope: [],
          evidenceRefs: assertRefList(input.evidenceRefs, 'evidenceRefs'),
          preservedOriginal: true,
        }
        request.returnedAt = clock.iso()
        request.updatedAt = clock.iso()
        save(doc, revision)
        return {
          request: copy(request),
          status: request.status,
          candidate: null,
          notice: '返回的计划无效；原版本保持不变，失败已记录',
        }
      }
      const scope = analyzeScope({
        basePlan,
        nextPlan: candidatePlan,
        targetObjectIds: request.targetObjectIds,
        allowedRippleIds: request.allowedRippleObjectIds,
        preserveObjectIds: request.explicitPreserveObjectIds,
        timingEdit: request.declarations.timingEdit === true,
        transitionEdit: request.declarations.transitionEdit === true,
      })
      if (scope.ok !== true) {
        request.status = EditRequestStatus.FAILED
        request.failure = {
          at: clock.iso(),
          reason: '返回的候选越出声明范围',
          violations: scope.violations,
          actualChangedObjectIds: scope.changedObjectIds,
          realSuccessScope: scope.changedObjectIds,
          evidenceRefs: assertRefList(input.evidenceRefs, 'evidenceRefs'),
          preservedOriginal: true,
        }
        request.returnedAt = clock.iso()
        request.updatedAt = clock.iso()
        save(doc, revision)
        appendEvents(paths.dir, [
          buildEvent({
            kind: 'editing.ai-request-failed',
            projectId: paths.projectId,
            actor: 'ai',
            detail: { requestId, reason: 'scope-violation', violations: scope.violations },
          }),
        ], { clock })
        return {
          request: copy(request),
          status: request.status,
          candidate: null,
          notice: '返回结果越出声明范围，不能形成候选；原版本保持不变，差异已记录',
          violations: scope.violations,
        }
      }
      const returned = writePlanSnapshot({ paths, ownerId: requestId, plan: candidatePlan, clock })
      const previewRef = input.previewRef === undefined || input.previewRef === null
        ? null
        : assertRef(input.previewRef, 'previewRef')
      const previews = previewRef === null
        ? []
        : [{ kind: 'producer-result', ref: previewRef, planRef: returned.planRef }]
      const checked = assertRefList(input.checkScope, 'checkScope')
      if (checked.length === 0) {
        throw new ValidationError('返回必须写明实际检查范围；不能把“没检查”写成通过', { field: 'checkScope' })
      }
      const knownIssues = assertRefList(input.knownIssues, 'knownIssues')
      const actualChecks = assertRefList(input.actualChecks, 'actualChecks')
      const evidenceRefs = assertRefList(input.evidenceRefs, 'evidenceRefs')
      const comparison = comparisons.createComparison({
        baseVersionId: request.baseVersionId,
        againstVersionId: null,
        basePlan,
        nextPlan: candidatePlan,
        basePlanRef: request.basePlanRef,
        againstPlanRef: returned.planRef,
        targetObjectIds: request.targetObjectIds,
        preserveObjectIds: scope.protectedObjectIds,
        previews,
        runtimeLabel: 'ffmpeg',
        createdBy: 'ai',
      })
      const candidate = versions.createCandidate({
        baseVersionId: request.baseVersionId,
        target: request.target,
        scope: request.scope,
        preservedItems: scope.protectedObjectIds,
        diffRef: comparison.comparisonId,
        previewRef,
        checkScope: checked,
        actor: 'ai',
      })
      const current = versions.getCurrent()
      const baseStillCurrent = current !== null && current.versionId === request.baseVersionId
      links.setLink({
        candidateId: candidate.candidateId,
        comparisonId: comparison.comparisonId,
        planRef: returned.planRef,
        planVersion: candidatePlan.planVersion,
        baseVersionId: request.baseVersionId,
        note: '原制作子 Agent 返回的候选计划',
      })
      request.status = EditRequestStatus.RETURNED
      request.result = {
        candidateId: candidate.candidateId,
        comparisonId: comparison.comparisonId,
        planRef: returned.planRef,
        planVersion: candidatePlan.planVersion,
        previewRef,
        realComparison: comparison.realComparison,
        knownIssues,
        checkScope: checked,
        actualChecks,
        evidenceRefs,
        baseStillCurrent,
        aiViewed: false,
        aiListened: false,
      }
      request.returnedAt = clock.iso()
      request.updatedAt = clock.iso()
      save(doc, revision)
      if (baseStillCurrent !== true && current !== null) {
        versions.markBaseAdvanced(current.versionId, { actor: 'system' })
      }
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.ai-request-returned',
          projectId: paths.projectId,
          actor: 'ai',
          detail: {
            requestId,
            candidateId: candidate.candidateId,
            comparisonId: comparison.comparisonId,
            baseStillCurrent,
            realComparison: comparison.realComparison,
            knownIssues,
          },
        }),
      ], { clock })
      return {
        request: copy(request),
        candidate: copy(candidate),
        comparison: copy(comparison),
        scope: {
          changedObjectIds: scope.changedObjectIds,
          changedFieldsByObject: scope.changedFieldsByObject,
          protectedObjectIds: scope.protectedObjectIds,
          timing: scope.timing,
        },
        needsRecheck: baseStillCurrent !== true,
        notice: baseStillCurrent
          ? '已形成真实候选，未覆盖原版；接受前请对照新旧结果'
          : '基础版本已变化，候选被标为需要重新核对；不会静默应用',
      }
    })
  }

  /**
   * Cancel an undispatched request. A dispatched request cannot be cancelled here: the producer must
   * return or fail, because a half-run edit has an unknown state.
   *
   * @param {object} input
   * @param {string} input.requestId
   * @param {string} [input.reason]
   * @param {string} [input.actor]
   * @returns {object}
   */
  function cancelRequest(input = {}) {
    const requestId = assertRef(input.requestId, 'requestId')
    const reason = optionalText(input.reason, 'reason')
    ensurePlanningAllowed({ paths, clock, operation: 'cancel-ai-edit' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:cancel:${requestId}` }, () => {
      const { doc, revision } = read()
      const request = requireRequest(doc, requestId)
      if (request.status === EditRequestStatus.DISPATCHED) {
        throw new ConflictError('请求已派发；必须先记录制作子 Agent 的真实返回或失败，不能直接取消', {
          requestId,
          action: '让同一次制作运行返回成功或失败，保留真实状态',
        })
      }
      if (
        [EditRequestStatus.RETURNED, EditRequestStatus.FAILED, EditRequestStatus.CANCELLED].includes(request.status)
      ) {
        throw new ConflictError('请求已经结束', { requestId, status: request.status })
      }
      request.status = EditRequestStatus.CANCELLED
      request.cancelledReason = reason
      request.updatedAt = clock.iso()
      save(doc, revision)
      return copy(request)
    })
  }

  /**
   * One request or `null`.
   * @param {string} requestId
   * @returns {object|null}
   */
  function getRequest(requestId) {
    const id = assertRef(requestId, 'requestId')
    const { doc } = read()
    const request = doc.requests.find((entry) => entry.requestId === id)
    return request === undefined ? null : copy(request)
  }

  /**
   * Requests, oldest first.
   * @param {{ status?: string }} [filter]
   * @returns {object[]}
   */
  function listRequests(filter = {}) {
    const { doc } = read()
    return doc.requests
      .filter((entry) => (filter.status === undefined ? true : entry.status === filter.status))
      .map((entry) => copy(entry))
  }

  /**
   * Counts for a projection.
   * @returns {{ requests: number, dispatched: number, returned: number, failed: number, needsUser: number }}
   */
  function describe() {
    const { doc } = read()
    return {
      requests: doc.requests.length,
      dispatched: doc.requests.filter((entry) => entry.status === EditRequestStatus.DISPATCHED).length,
      returned: doc.requests.filter((entry) => entry.status === EditRequestStatus.RETURNED).length,
      failed: doc.requests.filter((entry) => entry.status === EditRequestStatus.FAILED).length,
      needsUser: doc.requests.filter((entry) => entry.status === EditRequestStatus.NEEDS_USER).length,
    }
  }

  return {
    projectId: paths.projectId,
    planAiEdit,
    dispatchToProducer,
    recordProducerReturn,
    cancelRequest,
    getRequest,
    listRequests,
    describe,
  }
}
