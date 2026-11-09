/**
 * Candidate-to-plan links: which plan snapshot a candidate actually applies, and on which base.
 *
 * C10's candidate record stores only bounded references (by design), while acceptance must write the
 * candidate's real plan onto the new current version. This module keeps that mapping in the project
 * directory so it survives a restart. A link is replaced only when a re-check rebuilds the candidate
 * on a newer base; the previous link is kept as history so the old claim stays traceable.
 *
 * @module editing/links
 */

import { Clock, ValidationError } from '../base/index.js'
import {
  EDITING_DOCUMENT,
  EDITING_LAYOUT,
  assertPlanRef,
  assertRef,
  assertText,
  copy,
  readEditingDocument,
  writeEditingDocument,
} from './ids.js'

/** Empty links document. @param {string} projectId */
export function emptyCandidateLinksDocument(projectId) {
  return { kind: 'editing-candidate-links', projectId, links: [] }
}

/**
 * Open the candidate-link store of one project.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {object}
 */
export function createCandidateLinks(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('候选链接需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const file = EDITING_LAYOUT.linksFile

  /** @returns {{ doc: any, revision: string|null }} */
  function read() {
    const stored = readEditingDocument(
      paths,
      file,
      'editing-candidate-links',
      () => emptyCandidateLinksDocument(paths.projectId),
    )
    return { doc: stored.value, revision: stored.revision }
  }

  /** @param {any} doc @param {string|null} revision */
  function save(doc, revision) {
    return writeEditingDocument(paths, file, doc, revision, clock, '候选链接')
  }

  /**
   * Record (or replace) which plan snapshot and base a candidate applies to.
   *
   * @param {object} input
   * @param {string} input.candidateId
   * @param {string} input.comparisonId
   * @param {string} input.planRef
   * @param {string} input.planVersion
   * @param {string} input.baseVersionId
   * @param {boolean} [input.rebased]
   * @param {boolean} [input.previewStale] the linked plan changed after the recorded preview
   * @param {string} [input.note]
   * @returns {object}
   */
  function setLink(input = {}) {
    const candidateId = assertRef(input.candidateId, 'candidateId')
    const comparisonId = assertRef(input.comparisonId, 'comparisonId')
    const planRef = assertPlanRef(input.planRef)
    const planVersion = assertText(input.planVersion, 'planVersion', 80)
    const baseVersionId = assertRef(input.baseVersionId, 'baseVersionId')
    const { doc, revision } = read()
    const existing = doc.links.find((entry) => entry.candidateId === candidateId) ?? null
    const link = {
      candidateId,
      comparisonId,
      planRef,
      planVersion,
      baseVersionId,
      rebased: input.rebased === true,
      previewStale: input.previewStale === true,
      note: input.note ?? null,
      updatedAt: clock.iso(),
      previous: existing === null ? null : copy(existing),
    }
    doc.links = doc.links.filter((entry) => entry.candidateId !== candidateId)
    doc.links.push(link)
    save(doc, revision)
    return copy(link)
  }

  /**
   * One link or `null`.
   * @param {string} candidateId
   * @returns {object|null}
   */
  function getLink(candidateId) {
    const id = assertRef(candidateId, 'candidateId')
    const { doc } = read()
    const link = doc.links.find((entry) => entry.candidateId === id) ?? null
    return link === null ? null : copy(link)
  }

  /**
   * All links, oldest first.
   * @returns {object[]}
   */
  function listLinks() {
    const { doc } = read()
    return doc.links.map((entry) => copy(entry))
  }

  return {
    projectId: paths.projectId,
    setLink,
    getLink,
    listLinks,
  }
}
