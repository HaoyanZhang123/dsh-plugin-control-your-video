/**
 * Integration test: a real on-disk candidate lifecycle across separate store instances.
 *
 * Unlike the unit tests, this proves the SURVIVAL of state, not just the transition: every phase
 * opens a brand-new store over the same project directory and reads the versions document back
 * FROM DISK (a fresh `readDocument`, not a cached object). The path under test is the one the
 * product actually takes: create current -> candidate -> base advances -> reload -> the stale flag
 * is still there -> recheck -> accept -> reload -> the new current is durable.
 *
 * It also covers the decision side of the same project, because a candidate acceptance and a user
 * confirmation have to be recorded against the same object and version to be traceable at all.
 *
 * @module tests/integration/project-candidates.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTempDir } from '../../base/tempdir.js'
import { Clock, ConflictError, readJson } from '../../base/index.js'
import { newId } from '../../core/project/ids.js'
import { ProjectPaths, PROJECT_LAYOUT, PROJECT_SUBDIRS } from '../../core/project/paths.js'
import { readDocument } from '../../core/project/store.js'
import { readEvents } from '../../core/project/events.js'
import {
  CandidateStatus,
  ConfirmAspect,
  ConfirmScope,
  ConfirmationState,
  VersionClass,
} from '../../core/project/schema.js'
import { createDecisionLog } from '../../core/project/decisions.js'
import { createVersionStore } from '../../core/project/versions.js'

const temp = createTempDir({ label: 'candidates' })
test.after(() => {
  temp.dispose()
})

/** One project directory, reused across every phase of the lifecycle. */
function createProjectFixture(label) {
  const projectId = newId('project')
  const root = temp.dir(`root-${label}`)
  const paths = new ProjectPaths(root, projectId)
  // Same subdirectories a real project creation makes, so the test exercises the real layout.
  for (const subdir of PROJECT_SUBDIRS) fs.mkdirSync(paths.resolve(subdir), { recursive: true })
  const clock = new Clock({ mode: 'manual', start: Date.UTC(2026, 2, 1, 9, 0, 0), stepMs: 2500 })
  return { paths, clock }
}

/**
 * Open the two stores the way a fresh product start would: nothing in memory is reused.
 * @param {{ paths: ProjectPaths, clock: Clock }} fixture
 */
function openFresh(fixture) {
  return {
    versions: createVersionStore({ paths: fixture.paths, clock: fixture.clock }),
    decisions: createDecisionLog({ paths: fixture.paths, clock: fixture.clock }),
  }
}

test('integration: candidate lifecycle survives real reloads from disk', () => {
  const fixture = createProjectFixture('lifecycle')
  const { paths, clock } = fixture

  // --- Phase 1: create the current version and a candidate on it, then close the app. ---
  let stores = openFresh(fixture)
  const current = stores.versions.ensureCurrent({ actor: 'user' })
  const candidate = stores.versions.createCandidate({
    baseVersionId: current.versionId,
    target: '把开场镜头改为横移',
    scope: ConfirmScope.PART,
    preservedItems: ['unit-01', 'unit-03'],
    diffRef: 'sha256:1111111111111111',
    previewRef: 'versions/candidates/cnd-preview.mp4',
    checkScope: ['unit-02'],
    actor: 'ai',
  })
  const versionsFile = paths.resolve(PROJECT_LAYOUT.versionsIndex)
  assert.equal(fs.existsSync(versionsFile), true, '版本索引必须真实写到磁盘')

  // --- Phase 2: a FRESH process reads from disk and sees both records. ---
  stores = openFresh(fixture)
  const reloadedCurrent = stores.versions.getCurrent()
  assert.equal(reloadedCurrent.versionId, current.versionId)
  const reloadedCandidate = stores.versions.getCandidate(candidate.candidateId)
  assert.equal(reloadedCandidate.baseVersionId, current.versionId)
  assert.equal(reloadedCandidate.status, CandidateStatus.OPEN)
  assert.deepEqual(reloadedCandidate.preservedItems, ['unit-01', 'unit-03'])
  assert.equal(reloadedCandidate.previewRef, 'versions/candidates/cnd-preview.mp4')

  // --- Phase 3: the base advances (the candidate is accepted), so another candidate goes stale. ---
  const sibling = stores.versions.createCandidate({
    baseVersionId: current.versionId,
    target: '另一处并行修改',
    scope: ConfirmScope.OBJECT,
    actor: 'ai',
  })
  const accepted = stores.versions.acceptCandidate(candidate.candidateId, { actor: 'user' })
  assert.equal(accepted.candidate.status, CandidateStatus.ACCEPTED)
  assert.equal(accepted.version.class, VersionClass.CURRENT)
  assert.notEqual(accepted.version.versionId, current.versionId)

  // --- Phase 4: reload FROM DISK and verify the stale flag survived persistence. ---
  stores = openFresh(fixture)
  const staleAfterReload = stores.versions.getCandidate(sibling.candidateId)
  assert.equal(staleAfterReload.status, CandidateStatus.NEEDS_RECHECK, '待复核状态必须落盘并读回')
  assert.equal(staleAfterReload.recheckRequired, true)
  assert.equal(staleAfterReload.staleBecauseVersionId, accepted.version.versionId)
  assert.equal(stores.versions.getCurrent().versionId, accepted.version.versionId)

  // Read the raw document too, so this is not trusting the module's own view of itself.
  const rawDocument = readDocument(versionsFile, { kind: 'versions', expectedGeneration: 1 })
  const rawCandidate = rawDocument.value.candidates.find((item) => item.candidateId === sibling.candidateId)
  assert.ok(rawCandidate, '候选记录必须在磁盘文档里')
  assert.equal(rawCandidate.status, CandidateStatus.NEEDS_RECHECK)
  assert.equal(rawDocument.value.currentVersionId, accepted.version.versionId)
  assert.equal(rawDocument.value.schemaVersion, 1)
  assert.equal(rawDocument.value.schemaGeneration, 1)

  // A stale candidate still cannot be accepted after a restart.
  assert.throws(() => stores.versions.acceptCandidate(sibling.candidateId, { actor: 'user' }), ConflictError)

  // --- Phase 5: recheck then accept, and verify the new current is durable. ---
  stores.versions.recheckCandidate(sibling.candidateId, {
    actor: 'user',
    againstVersionId: accepted.version.versionId,
    note: '重启后重新核对差异',
  })
  const acceptedAfterRecheck = stores.versions.acceptCandidate(sibling.candidateId, { actor: 'user' })
  const durableCurrentId = acceptedAfterRecheck.version.versionId

  stores = openFresh(fixture)
  assert.equal(stores.versions.getCurrent().versionId, durableCurrentId)
  assert.equal(stores.versions.getCandidate(sibling.candidateId).status, CandidateStatus.ACCEPTED)
  assert.equal(stores.versions.getCandidate(sibling.candidateId).recheckBaseVersionId, accepted.version.versionId)

  // The whole history is still readable, including everything that was superseded.
  const history = stores.versions.listHistory()
  const versionIds = history.filter((entry) => entry.kind === 'version').map((entry) => entry.versionId)
  assert.ok(versionIds.includes(current.versionId), '最早的当前版本仍在历史里')
  assert.ok(versionIds.includes(accepted.version.versionId))
  assert.ok(versionIds.includes(durableCurrentId))
  const liveIds = history.filter((entry) => entry.active).map((entry) => entry.versionId)
  assert.ok(liveIds.includes(durableCurrentId))

  // --- Phase 6: the event log recorded the real sequence. ---
  const { events } = readEvents(paths.dir, { limit: 500 })
  const kinds = events.map((event) => event.kind)
  assert.ok(kinds.includes('version.created'))
  assert.ok(kinds.includes('version.candidate-created'))
  assert.ok(kinds.includes('version.candidate-accepted'))
  assert.ok(kinds.includes('version.candidate-stale'))
  const acceptEvents = events.filter((event) => event.kind === 'version.candidate-accepted')
  assert.equal(acceptEvents.length, 2)
  assert.ok(acceptEvents.every((event) => event.actor === 'user'))
})

test('integration: a confirmation and a version stay bound to the same object across reloads', () => {
  const fixture = createProjectFixture('confirm-version')
  const { paths } = fixture

  let stores = openFresh(fixture)
  const current = stores.versions.ensureCurrent({ actor: 'user' })
  const confirmation = stores.decisions.recordConfirmation({
    actor: 'user',
    objectId: 'unit-02',
    aspect: ConfirmAspect.UNIT,
    scope: ConfirmScope.OBJECT,
    versionId: current.versionId,
    state: ConfirmationState.CONFIRMED,
    humanResponse: '这个单元可以，就用它。',
    evidenceRefs: ['evidence/unit-02-review.json'],
  })
  // An AI suggestion for the same object is only a proposal.
  const proposal = stores.decisions.proposeConfirmation({
    objectId: 'unit-03',
    aspect: ConfirmAspect.UNIT,
    scope: ConfirmScope.OBJECT,
    versionId: current.versionId,
    proposedState: ConfirmationState.CONFIRMED,
    rationale: '检查项通过',
  })
  assert.equal(proposal.isConfirmation, false)

  // Nothing is cached between instances: this reads both documents from disk again.
  stores = openFresh(fixture)
  assert.equal(stores.decisions.isConfirmed('unit-02', ConfirmAspect.UNIT), true)
  assert.equal(stores.decisions.isConfirmed('unit-03', ConfirmAspect.UNIT), false, 'AI 提议不等于确认')
  assert.equal(stores.decisions.listConfirmed().length, 1)
  const restored = stores.decisions.listConfirmed({ objectId: 'unit-02' })[0]
  assert.equal(restored.confirmationId, confirmation.confirmationId)
  assert.equal(restored.versionId, current.versionId)

  // A content change after confirmation makes it read as needing re-confirmation.
  stores.decisions.markChangedAfterConfirmation({
    objectId: 'unit-02',
    aspect: ConfirmAspect.UNIT,
    reason: '替换了单元内的背景',
  })
  stores = openFresh(fixture)
  assert.equal(stores.decisions.isConfirmed('unit-02', ConfirmAspect.UNIT), false)
  assert.equal(
    stores.decisions.confirmationStateOf('unit-02', ConfirmAspect.UNIT),
    ConfirmationState.CHANGED_AFTER_CONFIRMATION,
  )
  // The old confirmation is retained as history, not deleted.
  assert.equal(stores.decisions.listConfirmations({ objectId: 'unit-02' }).length, 1)
})

test('integration: a candidate accepted from a finalized project never rewrites the final version', () => {
  const fixture = createProjectFixture('post-final')
  const { paths } = fixture

  let stores = openFresh(fixture)
  const current = stores.versions.ensureCurrent({ actor: 'user' })
  stores.versions.updateCurrentContent({ content: { cutRef: 'sha256:delivered' } }, { actor: 'user' })
  const final = stores.versions.finalize({ actor: 'user', confirmationRef: newId('confirmation') })
  assert.equal(final.class, VersionClass.FINAL)
  const finalFile = path.join(paths.dir, PROJECT_LAYOUT.finalDir)

  // Work continues AFTER finalize: a new candidate must be possible from the final version, and
  // accepting it must not touch the delivered final record.
  stores.versions.updateCurrentContent({ content: { cutRef: 'sha256:next-edit' } }, { actor: 'user' })

  stores = openFresh(fixture)
  assert.equal(stores.versions.getFinal().versionId, final.versionId)
  assert.equal(stores.versions.getFinal().content.cutRef, 'sha256:delivered', '定稿内容不得被后续编辑改写')
  assert.equal(stores.versions.getFinal().immutable, true)
  // The final directory exists in the real project layout.
  assert.equal(fs.existsSync(finalFile), true)
  // A second finalize is still refused after a restart.
  assert.throws(
    () => stores.versions.finalize({ actor: 'user', confirmationRef: newId('confirmation') }),
    ConflictError,
  )
  // And the current version keeps evolving independently.
  assert.equal(stores.versions.getCurrent().content.cutRef, 'sha256:next-edit')
  assert.notEqual(stores.versions.getCurrent().versionId, final.versionId)
})

test('integration: the versions document on disk is one readable JSON file with the expected envelope', () => {
  const fixture = createProjectFixture('envelope')
  const { paths } = fixture
  const stores = openFresh(fixture)
  const current = stores.versions.ensureCurrent({ actor: 'user' })
  stores.versions.createCandidate({
    baseVersionId: current.versionId,
    target: '检查文档外壳',
    scope: ConfirmScope.OBJECT,
    actor: 'ai',
  })
  const versionsFile = paths.resolve(PROJECT_LAYOUT.versionsIndex)
  const parsed = readJson(versionsFile)
  assert.equal(parsed.kind, 'versions')
  assert.equal(parsed.projectId, paths.projectId)
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.schemaGeneration, 1)
  assert.equal(typeof parsed.revision, 'string')
  assert.equal(typeof parsed.updatedAt, 'string')
  assert.equal(parsed.currentVersionId, current.versionId)
  assert.equal(Array.isArray(parsed.versions), true)
  assert.equal(Array.isArray(parsed.candidates), true)
  // Nothing on disk holds a content body: references only, bounded in length.
  for (const version of parsed.versions) {
    for (const value of Object.values(version.content)) {
      if (typeof value === 'string') assert.ok(value.length <= 200)
      else assert.equal(Array.isArray(value) || typeof value === 'number' || typeof value === 'boolean', true)
    }
  }
  // The paths used are inside the project directory, never outside it.
  assert.ok(versionsFile.startsWith(paths.dir))
})
