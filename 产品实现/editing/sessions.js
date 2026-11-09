/**
 * Direct-edit sessions: deterministic property/timing edits, autosave, undo/redo, abandon and
 * candidate formation.
 *
 * A direct edit is a WORKING DRAFT, not an overwrite (CT-05 §5: "修改计划并生成候选，不覆盖当前版").
 * The draft lives in this module's own session document with one plan snapshot per step; the C10
 * current version only changes when a candidate is accepted. Undo/redo move through the recorded
 * steps, and abandoning the session leaves the current version untouched.
 *
 * The single write lock, the production pause rule and the scope check are applied to every step; a
 * step that would touch anything outside the declared targets is refused before it is saved.
 *
 * @module editing/sessions
 */

import fs from 'node:fs'
import { Clock, ConflictError, NotFoundError, ValidationError, contentHash } from '../base/index.js'
import { appendEvents, buildEvent, createVersionStore } from '../core/project/index.js'
import { describePreviewState } from '../media/index.js'
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
  newEditingId,
  optionalText,
  planOfVersion,
  readEditingDocument,
  readPlanSnapshot,
  writeEditingDocument,
  writePlanSnapshot,
} from './ids.js'
import { analyzeScope, applyDirectIntent, describeEditScope, TIMING_INTENTS } from './scope.js'

/** Direct session lifecycle. */
export const EditSessionStatus = Object.freeze({
  OPEN: 'open',
  CANDIDATE_FORMED: 'candidate-formed',
  ACCEPTED: 'accepted',
  ABANDONED: 'abandoned',
})

/** Empty sessions document. @param {string} projectId */
export function emptySessionsDocument(projectId) {
  return { kind: EDITING_DOCUMENT.sessions, projectId, sessions: [] }
}

/**
 * Open the direct-edit session store of one project.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {object}
 */
export function createDirectEditing(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('直接修改需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const versions = createVersionStore({ paths, clock })
  const comparisons = createComparisonStore({ paths, clock })
  const links = createCandidateLinks({ paths, clock })
  const file = EDITING_LAYOUT.sessionsFile

  /** @returns {{ doc: any, revision: string|null }} */
  function read() {
    const stored = readEditingDocument(
      paths,
      file,
      EDITING_DOCUMENT.sessions,
      () => emptySessionsDocument(paths.projectId),
    )
    return { doc: stored.value, revision: stored.revision }
  }

  /** @param {any} doc @param {string|null} revision */
  function save(doc, revision) {
    return writeEditingDocument(paths, file, doc, revision, clock, '直接修改会话')
  }

  /**
   * Find one session, or throw a not-found error.
   * @param {any} doc
   * @param {string} sessionId
   * @returns {any}
   */
  function requireSession(doc, sessionId) {
    const id = assertRef(sessionId, 'sessionId')
    const session = doc.sessions.find((entry) => entry.sessionId === id)
    if (session === undefined) throw new NotFoundError('直接修改会话不存在', { sessionId: id })
    return session
  }

  /**
   * Resolve the base plan of a version: the stored snapshot when present, otherwise the caller's
   * plan, which is then recorded so later steps have a real base.
   * @param {any} plan caller plan or undefined
   * @param {string} baseVersionId
   * @param {string} sessionId
   * @returns {{ basePlan: any, basePlanRef: string, planVersion: string }}
   */
  function resolveBasePlan(plan, baseVersionId, sessionId) {
    const version = versions.getVersion(baseVersionId)
    if (version === null) throw new ValidationError('基础版本不存在', { baseVersionId })
    const stored = planOfVersion(paths, version)
    if (stored !== null) {
      if (plan !== undefined && plan !== null && contentHash(plan) !== stored.fingerprint) {
        throw new ConflictError('提交的计划与基础版本的快照不一致', {
          baseVersionId,
          basePlanRef: stored.planRef,
          action: '用该版本的真实计划开始修改，不要拿另一版画面当基础',
        })
      }
      return { basePlan: stored.plan, basePlanRef: stored.planRef, planVersion: stored.planVersion }
    }
    if (plan === undefined || plan === null) {
      throw new ValidationError('该版本还没有计划快照；开始修改时必须提供基础计划', { baseVersionId })
    }
    const written = writePlanSnapshot({ paths, ownerId: sessionId, plan, clock })
    return { basePlan: plan, basePlanRef: written.planRef, planVersion: plan.planVersion }
  }

  /**
   * Start one direct-edit session against the current version (or a named base version).
   *
   * @param {object} input
   * @param {string} input.target what the user asked to change
   * @param {string} input.scope one of `object` | `range` | `part`
   * @param {string[]} input.targetObjectIds
   * @param {any} [input.plan] the normalized base plan of the base version
   * @param {string} [input.baseVersionId]
   * @param {string} [input.actor]
   * @param {string[]} [input.preserveObjectIds]
   * @param {{ timingEdit?: boolean, transitionEdit?: boolean, directionChange?: boolean }} [input.declarations]
   * @returns {object}
   */
  function beginSession(input = {}) {
    const target = assertText(input.target, 'target')
    const scope = assertText(input.scope, 'scope', 20)
    if (!['object', 'range', 'part'].includes(scope)) {
      throw new ConflictError('整片级修改不能走一次性直接修改；请拆成对象／范围修改', {
        scope,
        action: '整片语义重做不是直接修改的范围',
      })
    }
    const targetObjectIds = assertRefList(input.targetObjectIds, 'targetObjectIds')
    if (targetObjectIds.length === 0) throw new ValidationError('直接修改需要至少一个目标对象', { field: 'targetObjectIds' })
    ensureEditingAllowed({ paths, clock, operation: 'begin-direct-edit' })
    return withEditingWrite(
      { paths, clock, taskId: 'EDITING-REVIEW:begin-direct-edit' },
      () => {
        let baseVersionId = input.baseVersionId
        if (baseVersionId === undefined || baseVersionId === null) {
          const current = versions.getCurrent() ?? versions.ensureCurrent({ actor: input.actor ?? 'user' })
          baseVersionId = current.versionId
        }
        const { doc, revision } = read()
        const sessionId = newEditingId(
          'ses',
          `${paths.projectId}:${baseVersionId}:${doc.sessions.length + 1}:${clock.iso()}`,
        )
        const base = resolveBasePlan(input.plan, baseVersionId, sessionId)
        const editScope = describeEditScope({
          plan: base.basePlan,
          targetObjectIds,
          preserveObjectIds: input.preserveObjectIds,
        })
        const declarations = {
          timingEdit: input.declarations?.timingEdit === true,
          transitionEdit: input.declarations?.transitionEdit === true,
          directionChange: input.declarations?.directionChange === true,
        }
        const at = clock.iso()
        /** @type {any} */
        const session = {
          sessionId,
          mode: 'direct',
          baseVersionId,
          basePlanRef: base.basePlanRef,
          basePlanVersion: base.basePlan.planVersion,
          basePlanFingerprint: contentHash(base.basePlan),
          target,
          scope,
          targetObjectIds,
          protectedObjectIds: editScope.preserve,
          explicitPreserveObjectIds: assertRefList(input.preserveObjectIds, 'preserveObjectIds'),
          declarations,
          steps: [{
            index: 0,
            planRef: base.basePlanRef,
            planVersion: base.basePlan.planVersion,
            fingerprint: contentHash(base.basePlan),
            intent: null,
            warnings: [],
            rippleObjectIds: [],
            timingEdit: false,
            createdAt: at,
            actor: 'system',
          }],
          pointer: 0,
          status: EditSessionStatus.OPEN,
          candidateId: null,
          comparisonId: null,
          preview: { ref: null, planRef: null, coveredRange: null, state: null, recordedAt: null },
          warnings: [],
          createdAt: at,
          updatedAt: at,
        }
        doc.sessions.push(session)
        save(doc, revision)
        const current = versions.getCurrent()
        if (current !== null && current.versionId === baseVersionId && typeof current.content?.planRef !== 'string') {
          versions.updateCurrentContent(
            { content: { planRef: base.basePlanRef, planVersion: base.basePlan.planVersion } },
            { actor: 'system' },
          )
        }
        appendEvents(paths.dir, [
          buildEvent({
            kind: 'editing.session-begun',
            projectId: paths.projectId,
            actor: input.actor ?? 'user',
            detail: { sessionId, baseVersionId, target, targetObjectIds },
          }),
        ], { clock })
        return copy(session)
      },
    )
  }

  /**
   * Compute how stale the recorded preview is against the draft plan.
   * @param {any} session
   * @param {any} currentPlan
   * @returns {object}
   */
  function previewStateOf(session, currentPlan) {
    if (typeof session.preview.planRef !== 'string') {
      return {
        state: 'missing',
        stale: true,
        summary: '还没有这一版的真实预览；不能把计划差异当画面对照',
      }
    }
    try {
      const previewPlan = readPlanSnapshot(paths, session.preview.planRef).plan
      const state = describePreviewState({
        basePlan: previewPlan,
        currentPlan,
        coveredRange: session.preview.coveredRange ?? null,
      })
      return {
        ...state,
        state: state.stale ? 'stale' : 'fresh',
        ref: session.preview.ref,
      }
    } catch (error) {
      return {
        state: 'unreadable',
        stale: true,
        summary: `预览来源读不回来：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * Apply one intent to the current draft step.
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {any} input.intent
   * @param {string} [input.actor]
   * @returns {object}
   */
  function applyEdit(input = {}) {
    const sessionId = assertRef(input.sessionId, 'sessionId')
    const actor = input.actor ?? 'user'
    ensureEditingAllowed({ paths, clock, operation: 'direct-edit' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:direct:${sessionId}` }, () => {
      const { doc, revision } = read()
      const session = requireSession(doc, sessionId)
      if (session.status === EditSessionStatus.ABANDONED) throw new ConflictError('会话已放弃，不能再修改', { sessionId })
      if (session.status === EditSessionStatus.ACCEPTED) {
        throw new ConflictError('会话已经接受为当前版本，不能再改', { sessionId })
      }
      if (session.status === EditSessionStatus.CANDIDATE_FORMED && session.candidateId !== null) {
        versions.abandonCandidate(session.candidateId, { actor, reason: '继续修改，旧候选不再代表工作草稿' })
        session.candidateId = null
        session.comparisonId = null
        session.status = EditSessionStatus.OPEN
      }
      const currentStep = session.steps[session.pointer]
      const currentPlan = readPlanSnapshot(paths, currentStep.planRef).plan
      const basePlan = readPlanSnapshot(paths, session.steps[0].planRef).plan
      const result = applyDirectIntent({ plan: currentPlan, intent: input.intent })
      const timingEdit = TIMING_INTENTS.includes(input.intent?.kind)
      const changedTiming = timingEdit || result.ripple?.timebaseChanged === true
      // `ripple.objectIds` includes the intent's own object for object-scoped intents; that object
      // only counts as allowed when the caller already declared it as a target. Keeping it in the
      // ripple set would let an edit to an undeclared object pass its own scope check.
      const intentObjectId = input.intent?.objectId
      const rippleIds = (result.ripple?.objectIds ?? []).filter(
        (id) => id !== undefined && id !== intentObjectId,
      )
      const scope = analyzeScope({
        basePlan,
        nextPlan: result.plan,
        targetObjectIds: session.targetObjectIds,
        allowedRippleIds: rippleIds,
        preserveObjectIds: session.explicitPreserveObjectIds,
        timingEdit: changedTiming,
        transitionEdit: input.intent?.kind === 'set-transition-overlap',
      })
      if (scope.ok !== true) {
        throw new ConflictError('修改会越出声明范围，已拒绝保存', {
          violations: scope.violations,
          action: '只改目标和必要牵连；相邻、未选、共享组件与音轨必须原样',
        })
      }
      const written = writePlanSnapshot({ paths, ownerId: sessionId, plan: result.plan, clock })
      const previewState = previewStateOf(session, result.plan)
      const step = {
        index: session.steps.length,
        planRef: written.planRef,
        planVersion: result.plan.planVersion,
        fingerprint: written.fingerprint,
        intent: copy(input.intent),
        applied: copy(result.applied),
        warnings: [...result.warnings],
        rippleObjectIds: rippleIds,
        timingEdit: changedTiming,
        diff: {
          changedObjectIds: scope.changedObjectIds,
          changedFrames: scope.changedFrames,
          timebaseChanged: scope.diff.timebaseChanged,
          totalFrames: scope.timing.totalFrames,
        },
        previewState: previewState.state,
        createdAt: clock.iso(),
        actor,
      }
      session.steps.push(step)
      session.pointer = session.steps.length - 1
      session.status = EditSessionStatus.OPEN
      session.warnings = [...new Set([...session.warnings, ...result.warnings])]
      session.updatedAt = clock.iso()
      save(doc, revision)
      return {
        sessionId,
        status: session.status,
        pointer: session.pointer,
        steps: session.steps.length,
        step: copy(step),
        scope: {
          ok: scope.ok,
          changedObjectIds: scope.changedObjectIds,
          changedFieldsByObject: scope.changedFieldsByObject,
          protectedObjectIds: scope.protectedObjectIds,
          timing: scope.timing,
          audioProtected: scope.audioProtected,
        },
        previewState,
        warnings: result.warnings,
      }
    })
  }

  /**
   * Undo one step. The stored steps are history; undo only moves the pointer.
   * @param {{ sessionId: string }} input
   * @returns {object}
   */
  function undoEdit(input = {}) {
    const sessionId = assertRef(input.sessionId, 'sessionId')
    ensureEditingAllowed({ paths, clock, operation: 'undo' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:undo:${sessionId}` }, () => {
      const { doc, revision } = read()
      const session = requireSession(doc, sessionId)
      if (session.pointer <= 0) throw new ConflictError('已经在会话起点，没有可撤销的修改', { sessionId })
      session.pointer -= 1
      const step = session.steps[session.pointer]
      const plan = readPlanSnapshot(paths, step.planRef).plan
      const previewState = previewStateOf(session, plan)
      session.updatedAt = clock.iso()
      save(doc, revision)
      return {
        sessionId,
        pointer: session.pointer,
        steps: session.steps.length,
        step: copy(step),
        previewState,
        canUndo: session.pointer > 0,
        canRedo: session.pointer < session.steps.length - 1,
      }
    })
  }

  /**
   * Redo one undone step.
   * @param {{ sessionId: string }} input
   * @returns {object}
   */
  function redoEdit(input = {}) {
    const sessionId = assertRef(input.sessionId, 'sessionId')
    ensureEditingAllowed({ paths, clock, operation: 'redo' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:redo:${sessionId}` }, () => {
      const { doc, revision } = read()
      const session = requireSession(doc, sessionId)
      if (session.pointer >= session.steps.length - 1) throw new ConflictError('没有可重做的步骤', { sessionId })
      session.pointer += 1
      const step = session.steps[session.pointer]
      const plan = readPlanSnapshot(paths, step.planRef).plan
      const previewState = previewStateOf(session, plan)
      session.updatedAt = clock.iso()
      save(doc, revision)
      return {
        sessionId,
        pointer: session.pointer,
        steps: session.steps.length,
        step: copy(step),
        previewState,
        canUndo: session.pointer > 0,
        canRedo: session.pointer < session.steps.length - 1,
      }
    })
  }

  /**
   * Whether a preview reference names a readable file.
   * @param {string} mediaRef
   * @returns {boolean}
   */
  function verifyMediaRef(mediaRef) {
    try {
      const absolute = mediaRef.includes(':\\') || mediaRef.startsWith('/') ? mediaRef : paths.resolve(mediaRef)
      return fs.existsSync(absolute) && fs.statSync(absolute).isFile()
    } catch {
      return false
    }
  }

  /**
   * Record a real preview of the current draft against the recorded plan snapshot.
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} input.mediaRef absolute path or project-relative path of the preview media
   * @param {{ startFrame: number, endFrameExclusive: number }|null} [input.coveredRange]
   * @returns {object}
   */
  function attachPreview(input = {}) {
    const sessionId = assertRef(input.sessionId, 'sessionId')
    const mediaRef = assertRef(input.mediaRef, 'mediaRef')
    const coveredRange = input.coveredRange ?? null
    ensureEditingAllowed({ paths, clock, operation: 'attach-preview' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:preview:${sessionId}` }, () => {
      const { doc, revision } = read()
      const session = requireSession(doc, sessionId)
      if (verifyMediaRef(mediaRef) !== true) {
        throw new NotFoundError('预览媒体不存在，不能登记为真实预览', { mediaRef })
      }
      const step = session.steps[session.pointer]
      session.preview = {
        ref: mediaRef,
        planRef: step.planRef,
        coveredRange,
        state: 'fresh',
        recordedAt: clock.iso(),
      }
      session.updatedAt = clock.iso()
      save(doc, revision)
      return copy(session.preview)
    })
  }

  /**
   * Abandon the session: the draft is dropped, the current version is untouched.
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} [input.reason]
   * @param {string} [input.actor]
   * @returns {object}
   */
  function abandonSession(input = {}) {
    const sessionId = assertRef(input.sessionId, 'sessionId')
    const actor = input.actor ?? 'user'
    const reason = optionalText(input.reason, 'reason')
    ensureEditingAllowed({ paths, clock, operation: 'abandon-session' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:abandon:${sessionId}` }, () => {
      const { doc, revision } = read()
      const session = requireSession(doc, sessionId)
      if (session.status === EditSessionStatus.ACCEPTED) {
        throw new ConflictError('已接受的会话不能“放弃”；回退请走创作期历史', { sessionId })
      }
      if (session.candidateId !== null) {
        versions.abandonCandidate(session.candidateId, { actor, reason: reason ?? '放弃修改会话' })
      }
      session.status = EditSessionStatus.ABANDONED
      session.candidateId = null
      session.comparisonId = null
      session.abandonedReason = reason
      session.updatedAt = clock.iso()
      save(doc, revision)
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.session-abandoned',
          projectId: paths.projectId,
          actor,
          detail: { sessionId, reason },
        }),
      ], { clock })
      return copy(session)
    })
  }

  /**
   * Form a real candidate from the current draft. The base version is not modified.
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} [input.actor]
   * @returns {object}
   */
  function formCandidate(input = {}) {
    const sessionId = assertRef(input.sessionId, 'sessionId')
    const actor = input.actor ?? 'user'
    ensureEditingAllowed({ paths, clock, operation: 'form-candidate' })
    return withEditingWrite({ paths, clock, taskId: `EDITING-REVIEW:candidate:${sessionId}` }, () => {
      const { doc, revision } = read()
      const session = requireSession(doc, sessionId)
      if (session.status === EditSessionStatus.ABANDONED || session.status === EditSessionStatus.ACCEPTED) {
        throw new ConflictError('该会话不能再形成候选', { status: session.status })
      }
      if (session.pointer <= 0) throw new ConflictError('还没有任何修改，不能形成候选', { sessionId })
      if (session.candidateId !== null) {
        versions.abandonCandidate(session.candidateId, { actor, reason: '重新形成候选，旧候选不再代表当前草稿' })
        session.candidateId = null
        session.comparisonId = null
      }
      const basePlan = readPlanSnapshot(paths, session.steps[0].planRef).plan
      const step = session.steps[session.pointer]
      const nextPlan = readPlanSnapshot(paths, step.planRef).plan
      const ripple = [...new Set(session.steps.flatMap((entry) => entry.rippleObjectIds ?? []))]
      const scope = analyzeScope({
        basePlan,
        nextPlan,
        targetObjectIds: session.targetObjectIds,
        allowedRippleIds: ripple,
        preserveObjectIds: session.explicitPreserveObjectIds,
        timingEdit: step.timingEdit === true,
        transitionEdit: step.intent?.kind === 'set-transition-overlap',
      })
      if (scope.ok !== true) {
        throw new ConflictError('草稿越出声明范围，拒绝形成候选', { violations: scope.violations })
      }
      const preservedItems = basePlan.objects
        .map((entry) => entry.id)
        .filter((id) => !scope.changedObjectIds.includes(id))
      const comparison = comparisons.createComparison({
        baseVersionId: session.baseVersionId,
        againstVersionId: null,
        basePlan,
        nextPlan,
        basePlanRef: session.steps[0].planRef,
        againstPlanRef: step.planRef,
        targetObjectIds: session.targetObjectIds,
        preserveObjectIds: preservedItems,
        previews: session.preview.ref === null
          ? []
          : [{ kind: 'draft-preview', ref: session.preview.ref, planRef: session.preview.planRef }],
        runtimeLabel: 'ffmpeg',
        createdBy: actor,
      })
      const previewState = previewStateOf(session, nextPlan)
      const previewStale = session.preview.ref !== null && previewState.stale === true
      const checkScope = [
        'plan-diff',
        'scope-protection',
        session.preview.ref === null ? 'preview-missing' : 'preview-rendered',
      ]
      const candidate = versions.createCandidate({
        baseVersionId: session.baseVersionId,
        target: session.target,
        scope: session.scope,
        preservedItems,
        diffRef: comparison.comparisonId,
        previewRef: session.preview.ref,
        checkScope,
        actor,
      })
      session.candidateId = candidate.candidateId
      session.comparisonId = comparison.comparisonId
      session.status = EditSessionStatus.CANDIDATE_FORMED
      session.updatedAt = clock.iso()
      links.setLink({
        candidateId: candidate.candidateId,
        comparisonId: comparison.comparisonId,
        planRef: step.planRef,
        planVersion: step.planVersion,
        baseVersionId: session.baseVersionId,
        previewStale,
        note: '直接修改形成的候选计划',
      })
      save(doc, revision)
      appendEvents(paths.dir, [
        buildEvent({
          kind: 'editing.candidate-formed',
          projectId: paths.projectId,
          actor,
          detail: {
            sessionId,
            candidateId: candidate.candidateId,
            comparisonId: comparison.comparisonId,
            baseVersionId: session.baseVersionId,
            changedObjectIds: scope.changedObjectIds,
            realPreview: session.preview.ref !== null,
          },
        }),
      ], { clock })
      return {
        session: copy(session),
        candidate: copy(candidate),
        comparison: copy(comparison),
        scope: {
          changedObjectIds: scope.changedObjectIds,
          protectedObjectIds: scope.protectedObjectIds,
          timing: scope.timing,
        },
        previewAvailable: session.preview.ref !== null,
        previewStale,
        previewState,
        notice: session.preview.ref === null
          ? '候选已形成，但还没有真实预览；接受前必须让用户看到真实结果或明确说明缺预览'
          : previewStale
            ? '候选已形成，但登记的真实预览对应的是更早的计划；接受前必须重渲或明确确认这一点'
            : '候选已形成，未覆盖当前版本',
      }
    })
  }

  /**
   * One session (deep copy) or `null`.
   * @param {string} sessionId
   * @returns {object|null}
   */
  function getSession(sessionId) {
    const id = assertRef(sessionId, 'sessionId')
    const { doc } = read()
    const session = doc.sessions.find((entry) => entry.sessionId === id)
    return session === undefined ? null : copy(session)
  }

  /**
   * Sessions, oldest first.
   * @param {{ status?: string, mode?: string }} [filter]
   * @returns {object[]}
   */
  function listSessions(filter = {}) {
    const { doc } = read()
    return doc.sessions
      .filter((entry) => (filter.status === undefined ? true : entry.status === filter.status))
      .filter((entry) => (filter.mode === undefined ? true : entry.mode === filter.mode))
      .map((entry) => copy(entry))
  }

  /**
   * Read-only summary of one session for a surface or receipt.
   * @param {string} sessionId
   * @returns {object}
   */
  function describeSession(sessionId) {
    const session = getSession(sessionId)
    if (session === null) throw new NotFoundError('直接修改会话不存在', { sessionId: String(sessionId) })
    const step = session.steps[session.pointer]
    const basePlan = readPlanSnapshot(paths, session.steps[0].planRef).plan
    const plan = readPlanSnapshot(paths, step.planRef).plan
    const ripple = [...new Set(session.steps.flatMap((entry) => entry.rippleObjectIds ?? []))]
    const scope = analyzeScope({
      basePlan,
      nextPlan: plan,
      targetObjectIds: session.targetObjectIds,
      allowedRippleIds: ripple,
      preserveObjectIds: session.explicitPreserveObjectIds,
      timingEdit: step.timingEdit === true,
    })
    return {
      sessionId: session.sessionId,
      status: session.status,
      baseVersionId: session.baseVersionId,
      basePlanVersion: session.basePlanVersion,
      planVersion: step.planVersion,
      pointer: session.pointer,
      steps: session.steps.length,
      canUndo: session.pointer > 0,
      canRedo: session.pointer < session.steps.length - 1,
      target: session.target,
      targetObjectIds: session.targetObjectIds,
      protectedObjectIds: session.protectedObjectIds,
      explicitPreserveObjectIds: session.explicitPreserveObjectIds,
      changedObjectIds: scope.changedObjectIds,
      timing: scope.timing,
      previewState: previewStateOf(session, plan),
      candidateId: session.candidateId,
      comparisonId: session.comparisonId,
      warnings: session.warnings,
    }
  }

  /**
   * Counts for a projection.
   * @returns {{ sessions: number, open: number, candidates: number, abandoned: number }}
   */
  function describe() {
    const { doc } = read()
    return {
      sessions: doc.sessions.length,
      open: doc.sessions.filter((entry) => entry.status === EditSessionStatus.OPEN).length,
      candidates: doc.sessions.filter((entry) => entry.status === EditSessionStatus.CANDIDATE_FORMED).length,
      abandoned: doc.sessions.filter((entry) => entry.status === EditSessionStatus.ABANDONED).length,
    }
  }

  return {
    projectId: paths.projectId,
    beginSession,
    applyEdit,
    undoEdit,
    redoEdit,
    attachPreview,
    abandonSession,
    formCandidate,
    getSession,
    listSessions,
    describeSession,
    describe,
    readPlanSnapshotOf: (planRef) => readPlanSnapshot(paths, assertPlanRef(planRef)),
    readVersionPlan: (versionId) => {
      const version = versions.getVersion(assertRef(versionId, 'versionId'))
      return version === null ? null : planOfVersion(paths, version)
    },
  }
}
