/**
 * Comparison records: one old/new pair, its versions, conditions, diff, previews and what it can
 * honestly claim.
 *
 * The record is deliberately data-heavy and claim-light: a plan diff is not a picture, so a record
 * without a real media reference says `realComparison: false` instead of being presented as a
 * visible before/after. The record outlives the session: a candidate's `diffRef` points here, and a
 * later reader can find the exact two plan snapshots and the conditions they were rendered under.
 *
 * @module editing/comparisons
 */

import { Clock, ValidationError, contentHash } from '../base/index.js'
import {
  EDITING_DOCUMENT,
  EDITING_LAYOUT,
  assertRef,
  assertRefList,
  copy,
  newEditingId,
  readEditingDocument,
  readPlanSnapshot,
  writeEditingDocument,
} from './ids.js'
import { buildComparison, assertPlan } from './scope.js'

/** Empty comparisons document. @param {string} projectId */
export function emptyComparisonsDocument(projectId) {
  return { kind: EDITING_DOCUMENT.comparisons, projectId, comparisons: [] }
}

/**
 * Open the comparison store of one project.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {object}
 */
export function createComparisonStore(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('对照记录需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const file = EDITING_LAYOUT.comparisonsFile

  /** @returns {{ doc: any, revision: string|null }} */
  function read() {
    const stored = readEditingDocument(
      paths,
      file,
      EDITING_DOCUMENT.comparisons,
      () => emptyComparisonsDocument(paths.projectId),
    )
    return { doc: stored.value, revision: stored.revision }
  }

  /** @param {any} doc @param {string|null} revision */
  function save(doc, revision) {
    return writeEditingDocument(paths, file, doc, revision, clock, '对照记录')
  }

  /**
   * Verify one supplied plan reference really holds the plan it is being paired with.
   * @param {string} planRef
   * @param {any} plan
   * @param {string} field
   * @returns {object}
   */
  function verifyPlanRef(planRef, plan, field) {
    const ref = assertRef(planRef, field)
    const stored = readPlanSnapshot(paths, ref)
    if (contentHash(stored.plan) !== contentHash(plan)) {
      throw new ValidationError(`${field} 指向的计划与提交的计划不一致`, { planRef: ref })
    }
    return stored
  }

  /**
   * Record one old/new comparison.
   *
   * @param {object} input
   * @param {any} input.basePlan normalized old plan
   * @param {any} input.nextPlan normalized new plan
   * @param {string} input.basePlanRef
   * @param {string} input.againstPlanRef
   * @param {string} [input.baseVersionId]
   * @param {string} [input.againstVersionId]
   * @param {string[]} [input.targetObjectIds]
   * @param {string[]} [input.preserveObjectIds]
   * @param {Array<{ kind: string, ref: string, planRef?: string }>} [input.previews]
   * @param {string[]} [input.modes]
   * @param {string} [input.runtimeLabel]
   * @param {string} [input.createdBy]
   * @returns {object}
   */
  function createComparison(input = {}) {
    const basePlan = assertPlan(input.basePlan, 'basePlan')
    const nextPlan = assertPlan(input.nextPlan, 'nextPlan')
    const baseRef = verifyPlanRef(input.basePlanRef, basePlan, 'basePlanRef')
    const againstRef = verifyPlanRef(input.againstPlanRef, nextPlan, 'againstPlanRef')
    const previews = (input.previews ?? []).map((entry, index) => ({
      kind: String(entry.kind ?? 'unknown'),
      ref: assertRef(entry.ref, `previews[${index}].ref`),
      planRef: entry.planRef === undefined || entry.planRef === null
        ? null
        : assertRef(entry.planRef, `previews[${index}].planRef`),
    }))
    const { doc, revision } = read()
    const comparisonId = newEditingId(
      'edt-cmp',
      `${paths.projectId}:${basePlan.planVersion}:${nextPlan.planVersion}:${doc.comparisons.length + 1}:${clock.iso()}`,
    )
    const base = buildComparison({
      basePlan,
      nextPlan,
      baseVersionId: input.baseVersionId ?? null,
      againstVersionId: input.againstVersionId ?? null,
      modes: input.modes,
      previews,
      runtimeLabel: input.runtimeLabel,
    })
    /** @type {any} */
    const record = {
      comparisonId,
      projectId: paths.projectId,
      baseVersionId: input.baseVersionId ?? null,
      againstVersionId: input.againstVersionId ?? null,
      base: {
        planRef: baseRef.planRef,
        planVersion: basePlan.planVersion,
        planFingerprint: baseRef.fingerprint,
        totalFrames: basePlan.timebase.totalFrames,
      },
      against: {
        planRef: againstRef.planRef,
        planVersion: nextPlan.planVersion,
        planFingerprint: againstRef.fingerprint,
        totalFrames: nextPlan.timebase.totalFrames,
      },
      modes: base.modes,
      conditions: base.conditions,
      targetObjectIds: assertRefList(input.targetObjectIds, 'targetObjectIds'),
      preserveObjectIds: assertRefList(input.preserveObjectIds, 'preserveObjectIds'),
      diff: base.diff,
      timing: base.timing,
      previews: base.previews,
      realPreviewCount: base.realPreviewCount,
      realComparison: base.realComparison,
      missingPreviewReason: base.missingPreviewReason,
      wholeFilmRequired: base.wholeFilmRequired,
      createdAt: clock.iso(),
      createdBy: input.createdBy ?? 'user',
    }
    doc.comparisons.push(record)
    save(doc, revision)
    return copy(record)
  }

  /**
   * One comparison or `null`.
   * @param {string} comparisonId
   * @returns {object|null}
   */
  function getComparison(comparisonId) {
    const id = assertRef(comparisonId, 'comparisonId')
    const { doc } = read()
    const record = doc.comparisons.find((entry) => entry.comparisonId === id)
    return record === undefined ? null : copy(record)
  }

  /**
   * Comparisons, oldest first.
   * @param {{ baseVersionId?: string, realComparison?: boolean }} [filter]
   * @returns {object[]}
   */
  function listComparisons(filter = {}) {
    const { doc } = read()
    return doc.comparisons
      .filter((entry) => (filter.baseVersionId === undefined ? true : entry.baseVersionId === filter.baseVersionId))
      .filter((entry) => (filter.realComparison === undefined ? true : entry.realComparison === filter.realComparison))
      .map((entry) => copy(entry))
  }

  /**
   * Counts for a projection.
   * @returns {{ comparisons: number, real: number, planOnly: number }}
   */
  function describe() {
    const { doc } = read()
    return {
      comparisons: doc.comparisons.length,
      real: doc.comparisons.filter((entry) => entry.realComparison === true).length,
      planOnly: doc.comparisons.filter((entry) => entry.realComparison !== true).length,
    }
  }

  return {
    projectId: paths.projectId,
    createComparison,
    getComparison,
    listComparisons,
    describe,
  }
}
