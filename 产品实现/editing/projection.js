/**
 * A read-only projection of the editing domain, published into the project's own event stream.
 *
 * The workbench shell can already read `/projects/events`, and C14 may not add a host route. So the
 * editing surface gets exactly what C13's creation surface gets: ONE bounded `editing.projection`
 * event, rebuilt from the real documents, carrying the revisions it was built from. It is a cache
 * with provenance, not a second fact source.
 *
 * @module editing/projection
 */

import { Clock, ValidationError } from '../base/index.js'
import {
  appendEvents,
  buildEvent,
  createDecisionLog,
  createVersionStore,
  PROJECT_LAYOUT,
  tryReadDocument,
} from '../core/project/index.js'
import { createAnnotationStore } from './annotations.js'
import { createComparisonStore } from './comparisons.js'
import { inspectEditingState } from './guard.js'
import { createHistoryView } from './history.js'
import { createAiEditing } from './producer.js'
import { createDirectEditing } from './sessions.js'

/** Event kind the shell matches. Stable because the client bundle compares it. */
export const EDITING_PROJECTION_KIND = 'editing.projection'

/** Version of the projection payload shape. */
export const EDITING_PROJECTION_VERSION = 1

/** Bounded sizes: a projection summarises, it does not copy the project. */
export const PROJECTION_LIMITS = Object.freeze({
  candidates: 6,
  annotations: 6,
  sessions: 4,
  requests: 4,
  comparisons: 3,
  confirmations: 6,
  history: 8,
})

/**
 * Trim one user-visible line so a projection cannot grow into a transcript.
 * @param {unknown} value
 * @param {number} [length]
 * @returns {string|null}
 */
function line(value, length = 160) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length <= length ? text : `${text.slice(0, length)}…`
}

/**
 * Build the projection from the documents as they are on disk right now.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {any}
 */
export function buildEditingProjection(input = {}) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('编辑投影需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const versions = createVersionStore({ paths, clock })
  const decisions = createDecisionLog({ paths, clock })
  const annotations = createAnnotationStore({ paths, clock })
  const sessions = createDirectEditing({ paths, clock })
  const requests = createAiEditing({ paths, clock })
  const comparisons = createComparisonStore({ paths, clock })
  const history = createHistoryView({ paths, clock })
  const guard = inspectEditingState({ paths, clock })

  const current = versions.getCurrent()
  const final = versions.getFinal()
  const versionState = versions.describe()
  const candidateList = versions.listCandidates()
  const annotationList = annotations.listAnnotations()
  const sessionList = sessions.listSessions()
  const requestList = requests.listRequests()
  const comparisonList = comparisons.listComparisons()
  const confirmationList = decisions.listConfirmations({})
  const historyState = history.listHistory()
  const historyList = historyState.entries

  const revisionOf = (relative, kind) => {
    const stored = tryReadDocument(paths.resolve(relative), { kind })
    return stored === null ? null : stored.revision
  }

  return {
    projectionVersion: EDITING_PROJECTION_VERSION,
    generatedAt: clock.iso(),
    projectId: paths.projectId,
    current: current === null
      ? null
      : {
          versionId: current.versionId,
          class: current.class,
          substate: current.substate,
          label: current.label,
          planVersion: current.content?.planVersion ?? null,
          planRef: current.content?.planRef ?? null,
        },
    final: final === null
      ? null
      : { versionId: final.versionId, label: final.label, createdAt: final.createdAt },
    versionState: {
      currentVersionId: versionState.currentVersionId,
      finalVersionId: versionState.finalVersionId,
      versions: versionState.versions,
      candidates: versionState.candidates,
      liveCandidates: versionState.liveCandidates,
      staleCandidates: versionState.staleCandidates,
    },
    production: {
      execution: guard.production.execution,
      editable: guard.production.editable,
      producerSessionId: guard.production.producerSessionId,
      reason: guard.edit.reason,
      action: guard.edit.action,
      pauseFirst: guard.edit.pauseFirst,
      writerAvailable: guard.writer.available,
    },
    candidates: candidateList.slice(-PROJECTION_LIMITS.candidates).map((candidate) => ({
      candidateId: candidate.candidateId,
      target: line(candidate.target),
      scope: candidate.scope,
      status: candidate.status,
      baseVersionId: candidate.baseVersionId,
      preservedItems: (candidate.preservedItems ?? []).slice(0, 10),
      checkScope: (candidate.checkScope ?? []).slice(0, 10),
      diffRef: candidate.diffRef,
      previewRef: candidate.previewRef,
      previewAvailable: candidate.previewRef !== null,
      recheckRequired: candidate.recheckRequired === true,
      recheckReason: line(candidate.recheckReason),
      createdAt: candidate.createdAt,
      createdBy: candidate.createdBy,
    })),
    annotations: annotationList.slice(-PROJECTION_LIMITS.annotations).map((annotation) => ({
      annotationId: annotation.annotationId,
      objectId: annotation.objectId,
      anchorKind: annotation.anchorKind,
      aspect: annotation.aspect,
      scope: annotation.scope,
      versionId: annotation.versionId,
      planVerified: annotation.versionRef?.planVerified === true,
      range: annotation.range,
      region: annotation.region,
      body: line(annotation.body),
      author: annotation.author,
      status: annotation.status,
      flattened: annotation.flattened !== null,
      createdAt: annotation.createdAt,
    })),
    annotationState: annotations.describe(),
    sessions: sessionList.slice(-PROJECTION_LIMITS.sessions).map((session) => {
      const step = session.steps[session.pointer]
      return {
        sessionId: session.sessionId,
        status: session.status,
        target: line(session.target),
        baseVersionId: session.baseVersionId,
        basePlanVersion: session.basePlanVersion,
        planVersion: step?.planVersion ?? null,
        pointer: session.pointer,
        steps: session.steps.length,
        canUndo: session.pointer > 0,
        canRedo: session.pointer < session.steps.length - 1,
        changedObjectIds: step?.diff?.changedObjectIds ?? [],
        previewState: session.preview?.ref === null || session.preview?.ref === undefined
          ? 'missing'
          : session.preview.planRef === (step?.planRef ?? null)
            ? 'fresh'
            : 'stale',
        candidateId: session.candidateId,
        warnings: (session.warnings ?? []).slice(0, 4).map((entry) => line(entry)),
      }
    }),
    requests: requestList.slice(-PROJECTION_LIMITS.requests).map((request) => ({
      requestId: request.requestId,
      status: request.status,
      target: line(request.target),
      targetObjectIds: request.targetObjectIds,
      baseVersionId: request.baseVersionId,
      producerSessionId: request.producerSessionId,
      producerRunId: request.producerRunId,
      dispatchedAt: request.dispatchedAt,
      pausedProduction: request.pausedProduction,
      result: request.result === null
        ? null
        : {
            candidateId: request.result.candidateId,
            realComparison: request.result.realComparison,
            baseStillCurrent: request.result.baseStillCurrent,
            knownIssues: (request.result.knownIssues ?? []).slice(0, 4).map((entry) => line(entry)),
            checkScope: (request.result.checkScope ?? []).slice(0, 8),
          },
      failure: request.failure === null
        ? null
        : {
            reason: line(request.failure.reason),
            preservedOriginal: request.failure.preservedOriginal === true,
            realSuccessScope: (request.failure.realSuccessScope ?? []).slice(0, 8),
          },
    })),
    comparisons: comparisonList
      .slice(-PROJECTION_LIMITS.comparisons)
      .map((comparison) => ({
        comparisonId: comparison.comparisonId,
        baseVersionId: comparison.baseVersionId,
        modes: comparison.modes,
        realComparison: comparison.realComparison,
        realPreviewCount: comparison.realPreviewCount,
        missingPreviewReason: line(comparison.missingPreviewReason),
        changedObjectIds: (comparison.diff?.changedObjectIds ?? []).slice(0, 10),
        changedFieldsByObject: comparison.diff?.changedFieldsByObject ?? null,
        changedFrames: (comparison.diff?.changedFrames ?? []).slice(0, 6),
        totalFrames: comparison.timing?.totalFrames ?? null,
        wholeFilmRequired: comparison.wholeFilmRequired === true,
        createdAt: comparison.createdAt,
      })),
    confirmations: confirmationList
      .filter((entry) =>
        ['partially-confirmed', 'confirmed', 'changed-after-confirmation', 'ai-allowed'].includes(entry.state),
      )
      .slice(-PROJECTION_LIMITS.confirmations)
      .map((entry) => ({
        confirmationId: entry.confirmationId,
        objectId: entry.objectId,
        aspect: entry.aspect,
        scope: entry.scope,
        versionId: entry.versionId,
        state: entry.state,
        humanResponse: line(entry.humanResponse, 120),
        respondedAt: entry.respondedAt,
        wholeFilm: entry.scope === 'whole',
      })),
    history: {
      entries: historyList.slice(-PROJECTION_LIMITS.history).map((entry) => ({
        versionId: entry.versionId,
        kind: entry.kind,
        class: entry.class,
        status: entry.status ?? null,
        label: line(entry.label, 80),
        active: entry.active,
        immutable: entry.immutable,
        createdAt: entry.createdAt,
        createdBy: entry.createdBy,
        revertEligible: entry.revertEligible,
        revertReason: line(entry.revertReason),
      })),
      readOnly: true,
      recoveryAvailable: historyState.recoveryAvailable,
      finalized: historyState.finalized,
      noRecoveryEntry: historyState.noRecoveryEntry,
      note: line(historyState.note, 160),
    },
    summary: {
      candidates: versionState.candidates,
      liveCandidates: versionState.liveCandidates,
      staleCandidates: versionState.staleCandidates,
      annotations: annotations.describe().annotations,
      openAnnotations: annotations.describe().open,
      sessions: sessions.describe().sessions,
      requests: requests.describe().requests,
      comparisons: comparisons.describe().comparisons,
      realComparisons: comparisons.describe().real,
      confirmations: confirmationList.filter((entry) => entry.state === 'confirmed').length,
      partialConfirmations: confirmationList.filter((entry) => entry.state === 'partially-confirmed').length,
    },
    // What this projection can and cannot stand for. A surface must not read it as user acceptance.
    honest: {
      readOnly: true,
      interactiveControls: false,
      candidateIsNotAcceptance: true,
      partialConfirmationIsNotWholeFilm: true,
      note: '只读投影：数据来自项目事实；页面挂载由客户端领域视图负责，接受／回退等交互按钮尚未接入，投影不推定用户接受或验收',
    },
    aiObservation: {
      viewed: false,
      listened: false,
      note: '本模块不生成也不观看媒体；AI 未看／未听，程序检查不等于用户验收',
    },
    sources: {
      versions: revisionOf(PROJECT_LAYOUT.versionsIndex, 'versions'),
      annotations: revisionOf('editing/annotations.json', 'editing-annotations'),
      sessions: revisionOf('editing/sessions.json', 'editing-sessions'),
      requests: revisionOf('editing/requests.json', 'editing-requests'),
      comparisons: revisionOf('editing/comparisons.json', 'editing-comparisons'),
    },
  }
}

/**
 * Publish the projection into the project's append-only event stream.
 * @param {object} input see {@link buildEditingProjection}
 * @returns {{ projection: any, event: any }}
 */
export function publishEditingProjection(input = {}) {
  const projection = buildEditingProjection(input)
  const clock = input.clock ?? new Clock()
  const event = buildEvent({
    kind: EDITING_PROJECTION_KIND,
    projectId: projection.projectId,
    actor: 'system',
    detail: projection,
  })
  appendEvents(input.paths.dir, [event], { clock })
  return { projection, event }
}

/**
 * The newest projection carried by a list of project events, or `null`.
 *
 * The append-only log's `sequence` decides, never array position: the route returns newest-first and
 * C13 already learned not to trust the caller's ordering.
 *
 * @param {any[]} events
 * @returns {any|null}
 */
export function latestEditingProjection(events) {
  if (!Array.isArray(events)) return null
  let latest = null
  let latestSequence = -1
  for (const event of events) {
    if (event?.kind !== EDITING_PROJECTION_KIND) continue
    if (event.detail === null || typeof event.detail !== 'object') continue
    const sequence = Number.isInteger(event.sequence) ? event.sequence : Number.MAX_SAFE_INTEGER
    if (sequence >= latestSequence) {
      latestSequence = sequence
      latest = event.detail
    }
  }
  return latest === null ? null : structuredClone(latest)
}
