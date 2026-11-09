/**
 * Tests for core/project/versions.js: current, candidate and final versions.
 *
 * The rules under test are the product rules from CT-03 §5 / 01 §7 that must be enforced in code:
 * exactly three user-visible classes, a candidate records its base version, a base change makes the
 * old candidate `needs-recheck` (never silently applicable), accepting a candidate makes it CURRENT
 * and not FINAL, only a user can finalize, the final version is immutable, history is read-only, and
 * a revert makes an old version current while flagging candidates.
 *
 * The document is written through `store.js` into a managed temp project directory, and several
 * assertions re-open the store to prove state survived a real write.
 *
 * @module tests/unit/project-versions.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createTempDir } from '../../base/tempdir.js'
import { Clock, ConflictError, NotFoundError, ValidationError } from '../../base/index.js'
import { newId } from '../../core/project/ids.js'
import { ProjectPaths, PROJECT_LAYOUT } from '../../core/project/paths.js'
import { tryReadDocument } from '../../core/project/store.js'
import { readEvents } from '../../core/project/events.js'
import {
  CandidateStatus,
  ConfirmScope,
  VersionClass,
  VersionSubstate,
  isVersionMutable,
} from '../../core/project/schema.js'
import { createVersionStore } from '../../core/project/versions.js'

const temp = createTempDir({ label: 'versions' })
test.after(() => {
  temp.dispose()
})

/**
 * A fresh, isolated project inside the managed temp dir.
 * @param {string} label
 * @returns {{ paths: ProjectPaths, store: ReturnType<typeof createVersionStore>, clock: Clock }}
 */
function newProject(label) {
  const projectId = newId('project')
  const root = temp.dir(`projects-${label}`)
  const clock = new Clock({ mode: 'manual', start: Date.UTC(2026, 1, 1, 0, 0, 0), stepMs: 1000 })
  const paths = new ProjectPaths(root, projectId)
  fs.mkdirSync(paths.dir, { recursive: true })
  const store = createVersionStore({ paths, clock })
  return { paths, store, clock }
}

/** A fresh store over the same project, to prove persistence instead of in-memory state. */
function reload(paths, clock) {
  return createVersionStore({ paths, clock })
}

test('versions: current -> candidate with base -> accept becomes current, not final', () => {
  const { paths, store, clock } = newProject('accept')
  const current = store.ensureCurrent({ actor: 'user' })
  assert.match(current.versionId, /^ver_/)
  assert.equal(current.class, VersionClass.CURRENT)
  assert.equal(current.substate, VersionSubstate.DRAFT)
  assert.equal(current.immutable, false)

  // A second call returns the SAME version: the current version id is stable.
  const again = store.ensureCurrent({ actor: 'user' })
  assert.equal(again.versionId, current.versionId)
  assert.equal(store.getCurrent().versionId, current.versionId)

  const candidate = store.createCandidate({
    baseVersionId: current.versionId,
    target: '把开场镜头换成横移',
    scope: ConfirmScope.PART,
    preservedItems: ['unit-01', 'unit-03'],
    diffRef: 'sha256:aaaaaaaaaaaaaaaa',
    previewRef: 'versions/candidates/preview.mp4',
    checkScope: ['unit-02'],
  })
  assert.match(candidate.candidateId, /^cnd_/)
  assert.equal(candidate.class, VersionClass.CANDIDATE)
  assert.equal(candidate.status, CandidateStatus.OPEN)
  assert.equal(candidate.baseVersionId, current.versionId)
  assert.equal(candidate.preservedItems.length, 2)
  assert.equal(isVersionMutable(candidate.class), true)

  const accepted = store.acceptCandidate(candidate.candidateId, { actor: 'user' })
  assert.equal(accepted.version.class, VersionClass.CURRENT, '接受候选成为当前版本，不是定稿')
  assert.notEqual(accepted.version.class, VersionClass.FINAL)
  assert.equal(accepted.version.origin.candidateId, candidate.candidateId)
  assert.equal(accepted.candidate.status, CandidateStatus.ACCEPTED)
  assert.equal(accepted.candidate.acceptedVersionId, accepted.version.versionId)
  assert.equal(accepted.version.content.diffRef, 'sha256:aaaaaaaaaaaaaaaa')

  const reopened = reload(paths, clock)
  assert.equal(reopened.getCurrent().versionId, accepted.version.versionId)
  assert.equal(reopened.getFinal(), null, '接受候选不等于定稿')
  assert.equal(reopened.getCandidate(candidate.candidateId).status, CandidateStatus.ACCEPTED)
  // The previous current version is still stored as history.
  assert.equal(reopened.getVersion(current.versionId).class, VersionClass.CURRENT)
  assert.equal(reopened.getVersion(current.versionId).versionId, current.versionId)
})

test('versions: base advances -> candidate needs recheck -> accept refused -> recheck -> accept works', () => {
  const { paths, store, clock } = newProject('recheck')
  const current = store.ensureCurrent({ actor: 'user' })
  const candidate = store.createCandidate({
    baseVersionId: current.versionId,
    target: '调整配色',
    scope: ConfirmScope.OBJECT,
  })

  // A second candidate is created on the same base, then the base advances by accepting the first.
  const result = store.acceptCandidate(candidate.candidateId, { actor: 'user' })
  const newCurrent = result.version.versionId
  assert.notEqual(newCurrent, current.versionId)

  const other = store.createCandidate({
    baseVersionId: current.versionId,
    target: '另一处调整',
    scope: ConfirmScope.OBJECT,
  })
  // Creating another candidate on the new current, then advancing again must flag the old one.
  const third = store.createCandidate({
    baseVersionId: newCurrent,
    target: '第三处',
    scope: ConfirmScope.OBJECT,
  })
  const advance = store.markBaseAdvanced(third.baseVersionId, { actor: 'user' })
  assert.equal(advance.staleCandidateIds.length, 1)
  assert.equal(advance.staleCandidateIds[0], other.candidateId)

  const stale = store.getCandidate(other.candidateId)
  assert.equal(stale.status, CandidateStatus.NEEDS_RECHECK)
  assert.equal(stale.recheckRequired, true)
  assert.equal(stale.staleBecauseVersionId, third.baseVersionId)

  // Accepting a stale candidate is refused, and says what to do.
  assert.throws(
    () => store.acceptCandidate(other.candidateId, { actor: 'user' }),
    (error) => {
      assert.ok(error instanceof ConflictError)
      assert.equal(error.details.needsRecheck, true)
      assert.equal(error.details.code, 'CANDIDATE_NEEDS_RECHECK')
      assert.match(error.message, /重新核对/)
      return true
    },
  )
  // The refusal did not silently accept it.
  assert.equal(store.getCandidate(other.candidateId).status, CandidateStatus.NEEDS_RECHECK)

  const rechecked = store.recheckCandidate(other.candidateId, {
    actor: 'user',
    againstVersionId: third.baseVersionId,
    note: '重新看过差异，结论不变',
  })
  assert.equal(rechecked.status, CandidateStatus.OPEN)
  assert.equal(rechecked.recheckRequired, false)
  assert.equal(rechecked.recheckBaseVersionId, third.baseVersionId)
  assert.equal(rechecked.baseVersionId, current.versionId, '复核不篡改候选来源')

  const accepted = store.acceptCandidate(other.candidateId, { actor: 'user' })
  assert.equal(accepted.candidate.status, CandidateStatus.ACCEPTED)
  const reopened = reload(paths, clock)
  assert.equal(reopened.getCurrent().versionId, accepted.version.versionId)
  assert.equal(reopened.getCandidate(other.candidateId).status, CandidateStatus.ACCEPTED)
})

test('versions: an unknown base version is refused instead of inventing one', () => {
  const { store } = newProject('bad-base')
  store.ensureCurrent({ actor: 'user' })
  assert.throws(
    () => store.createCandidate({ baseVersionId: newId('version'), target: '无依据的候选', scope: ConfirmScope.OBJECT }),
    NotFoundError,
  )
  assert.throws(
    () => store.acceptCandidate(newId('candidate'), { actor: 'user' }),
    NotFoundError,
  )
})

test('versions: reject and abandon keep the candidate as history', () => {
  const { store } = newProject('reject')
  const current = store.ensureCurrent({ actor: 'user' })
  const toReject = store.createCandidate({ baseVersionId: current.versionId, target: 'A', scope: ConfirmScope.OBJECT })
  const toAbandon = store.createCandidate({ baseVersionId: current.versionId, target: 'B', scope: ConfirmScope.OBJECT })

  const rejected = store.rejectCandidate(toReject.candidateId, { actor: 'user', reason: '不是想要的效果' })
  assert.equal(rejected.status, CandidateStatus.REJECTED)
  assert.equal(rejected.decisionReason, '不是想要的效果')
  assert.ok(rejected.decidedAt)

  const abandoned = store.abandonCandidate(toAbandon.candidateId, { actor: 'user', reason: '方向改了' })
  assert.equal(abandoned.status, CandidateStatus.SUPERSEDED)

  // Both records still exist, and the current version never changed.
  assert.equal(store.listCandidates().length, 2)
  assert.equal(store.listCandidates({ live: true }).length, 0)
  assert.equal(store.getCurrent().versionId, current.versionId)
  // A closed candidate cannot be accepted afterwards.
  assert.throws(() => store.acceptCandidate(toReject.candidateId, { actor: 'user' }), ConflictError)
})

test('versions: final requires a user and is immutable afterwards', () => {
  const { paths, store, clock } = newProject('final')
  // Final is not producible without a current version.
  assert.throws(() => store.finalize({ actor: 'user', confirmationRef: 'cnf_x' }), ValidationError)

  const current = store.ensureCurrent({ actor: 'user' })
  const confirmationRef = newId('confirmation')

  // An AI finalize attempt is refused: the user never accepted the result.
  assert.throws(
    () => store.finalize({ actor: 'ai', confirmationRef }),
    (error) => {
      assert.ok(error instanceof ValidationError)
      assert.match(error.message, /只有用户明确验收/)
      return true
    },
  )
  // A user finalize without an acceptance reference is refused too.
  assert.throws(() => store.finalize({ actor: 'user', confirmationRef: '' }), ValidationError)
  assert.equal(store.getFinal(), null)

  const final = store.finalize({ actor: 'user', confirmationRef, substate: VersionSubstate.BASELINE })
  assert.equal(final.class, VersionClass.FINAL)
  assert.equal(final.immutable, true)
  assert.equal(final.confirmationRef, confirmationRef)
  assert.equal(final.origin.sourceVersionId, current.versionId)
  assert.equal(isVersionMutable(final.class), false)

  // The final record is immutable: every later mutation throws.
  assert.throws(
    () => store.updateVersionContent(final.versionId, { content: { cutRef: 'sha256:bbbb' } }),
    (error) => {
      assert.ok(error instanceof ConflictError)
      assert.match(error.message, /定稿版本不可修改/)
      return true
    },
  )
  assert.throws(
    () => store.revertToVersion(final.versionId, { actor: 'user' }),
    (error) => {
      assert.ok(error instanceof ValidationError)
      assert.match(error.message, /不能作为回退目标/)
      return true
    },
  )
  // A second finalize is refused instead of overwriting the delivered state.
  assert.throws(() => store.finalize({ actor: 'user', confirmationRef: newId('confirmation') }), ConflictError)

  const reopened = reload(paths, clock)
  const storedFinal = reopened.getFinal()
  assert.ok(storedFinal)
  assert.equal(storedFinal.versionId, final.versionId)
  assert.equal(storedFinal.immutable, true)
  assert.equal(storedFinal.content && typeof storedFinal.content, 'object')
})

test('versions: the final version is a snapshot, so editing the current version cannot rewrite it', () => {
  const { store } = newProject('final-snapshot')
  store.ensureCurrent({ actor: 'user' })
  store.updateCurrentContent({ content: { cutRef: 'sha256:1111' } }, { actor: 'user' })
  const final = store.finalize({ actor: 'user', confirmationRef: newId('confirmation') })
  assert.equal(final.content.cutRef, 'sha256:1111')

  // Editing the current version after finalize must not change the delivered snapshot.
  store.updateCurrentContent({ content: { cutRef: 'sha256:2222' } }, { actor: 'user' })
  assert.equal(store.getCurrent().content.cutRef, 'sha256:2222')
  assert.equal(store.getFinal().content.cutRef, 'sha256:1111', '定稿快照不得被后续编辑改写')
})

test('versions: revert makes an old version current and flags live candidates', () => {
  const { paths, store, clock } = newProject('revert')
  const first = store.ensureCurrent({ actor: 'user' })
  const candidate = store.createCandidate({ baseVersionId: first.versionId, target: '改为冷色', scope: ConfirmScope.WHOLE })
  const accepted = store.acceptCandidate(candidate.candidateId, { actor: 'user' })
  const second = accepted.version

  // A live candidate built on the newest current version.
  const liveCandidate = store.createCandidate({
    baseVersionId: second.versionId,
    target: '再加一段字幕',
    scope: ConfirmScope.RANGE,
  })
  assert.equal(store.getCandidate(liveCandidate.candidateId).status, CandidateStatus.OPEN)

  const reverted = store.revertToVersion(first.versionId, { actor: 'user', reason: '第二版方向偏了' })
  assert.equal(reverted.version.versionId, first.versionId)
  assert.equal(reverted.previousCurrentVersionId, second.versionId)
  assert.equal(reverted.retainedHistoryVersionId, second.versionId)
  assert.deepEqual(reverted.staleCandidateIds, [liveCandidate.candidateId])

  const current = store.getCurrent()
  assert.equal(current.versionId, first.versionId)
  assert.equal(current.class, VersionClass.CURRENT)
  // The version that used to be current is RETAINED as history, not deleted.
  const retained = store.getVersion(second.versionId)
  assert.ok(retained)
  assert.equal(retained.versionId, second.versionId)
  // And the live candidate is flagged rather than left looking acceptable.
  assert.equal(store.getCandidate(liveCandidate.candidateId).status, CandidateStatus.NEEDS_RECHECK)

  const reopened = reload(paths, clock)
  assert.equal(reopened.getCurrent().versionId, first.versionId)
  assert.equal(reopened.getCandidate(liveCandidate.candidateId).status, CandidateStatus.NEEDS_RECHECK)
  const history = reopened.listHistory()
  const retainedEntry = history.find((entry) => entry.kind === 'version' && entry.versionId === second.versionId)
  assert.ok(retainedEntry)
  assert.equal(retainedEntry.active, false)
  assert.equal(retainedEntry.retiredByVersionId, first.versionId)
})

test('versions: history is read-only, not a live handle into storage', () => {
  const { store } = newProject('history')
  const first = store.ensureCurrent({ actor: 'user' })
  const candidate = store.createCandidate({ baseVersionId: first.versionId, target: '调整', scope: ConfirmScope.OBJECT })
  store.acceptCandidate(candidate.candidateId, { actor: 'user' })
  store.rejectCandidate(
    store.createCandidate({
      baseVersionId: store.getCurrent().versionId,
      target: 'B',
      scope: ConfirmScope.OBJECT,
    }).candidateId,
    { actor: 'user' },
  )

  const history = store.listHistory()
  assert.ok(history.length >= 3)
  // Every entry states one of exactly three classes, never a fourth.
  const classes = new Set(history.filter((entry) => entry.kind === 'version').map((entry) => entry.class))
  for (const value of classes) {
    assert.ok([VersionClass.CURRENT, VersionClass.CANDIDATE, VersionClass.FINAL].includes(value))
  }
  assert.equal(history.filter((entry) => entry.class === VersionClass.FINAL).length, 0)
  assert.ok(history.some((entry) => entry.kind === 'candidate'))

  // Mutating a returned entry must not change stored state.
  const before = JSON.stringify(store.listHistory())
  const mutable = store.listHistory()
  mutable[0].label = '被外部改掉的标签'
  mutable[0].active = true
  assert.equal(JSON.stringify(store.listHistory()), before, '历史是只读副本，不是存储的实时句柄')
  assert.notEqual(store.getCurrent().label, '被外部改掉的标签')

  // Filtering by class keeps the same guarantee.
  const versionOnly = store.listHistory({ class: VersionClass.CURRENT })
  assert.ok(versionOnly.length >= 1)
  assert.ok(versionOnly.every((entry) => entry.class === VersionClass.CURRENT))
})

test('versions: a partial revert flags dependencies instead of claiming success', () => {
  const { store } = newProject('partial')
  const first = store.ensureCurrent({ actor: 'user' })
  store.updateCurrentContent({ content: { cutRef: 'sha256:old' } }, { actor: 'user' })
  const candidate = store.createCandidate({ baseVersionId: first.versionId, target: '整片换色', scope: ConfirmScope.WHOLE })
  const accepted = store.acceptCandidate(candidate.candidateId, { actor: 'user' })

  const partial = store.revertPartial({
    versionId: first.versionId,
    objectIds: ['unit-02', 'unit-05'],
    actor: 'user',
    reason: '只回退这两个对象',
  })
  assert.equal(partial.applied, false, '局部回退不直接改动当前版本')
  assert.equal(partial.partial, true)
  assert.equal(partial.dependenciesRequireRecheck, true)
  assert.deepEqual(partial.requiresRecheck, ['unit-02', 'unit-05'])
  assert.equal(partial.candidate.class, VersionClass.CANDIDATE)
  assert.equal(partial.candidate.scope, ConfirmScope.PART)
  assert.equal(partial.candidate.status, CandidateStatus.OPEN)
  assert.match(partial.note, /必须重新检查/)
  // The current version did not change: a partial revert is a candidate to review, not a result.
  assert.equal(store.getCurrent().versionId, accepted.version.versionId)

  // An empty object list is refused rather than treated as "the whole project".
  assert.throws(
    () => store.revertPartial({ versionId: first.versionId, objectIds: [], actor: 'user' }),
    ValidationError,
  )
})

test('versions: content is stored by reference only, never as inlined bytes', () => {
  const { store } = newProject('refs')
  store.ensureCurrent({ actor: 'user' })
  // A reference is accepted.
  const updated = store.updateCurrentContent({ content: { cutRef: 'sha256:cccccccccccc' } }, { actor: 'user' })
  assert.equal(updated.content.cutRef, 'sha256:cccccccccccc')
  // An inline blob (long text) is refused.
  assert.throws(
    () => store.updateCurrentContent({ content: { cutRef: 'x'.repeat(500) } }, { actor: 'user' }),
    ValidationError,
  )
  // A nested object (an inlined tree) is refused.
  assert.throws(
    () => store.updateCurrentContent({ content: { plan: { scenes: [1, 2, 3] } } }, { actor: 'user' }),
    ValidationError,
  )
})

test('versions: a stale write is rejected instead of overwriting another writer', () => {
  const { paths, store } = newProject('conflict')
  store.ensureCurrent({ actor: 'user' })
  const file = paths.resolve(PROJECT_LAYOUT.versionsIndex)
  const stored = tryReadDocument(file, { kind: 'versions' })
  assert.ok(stored)
  assert.equal(stored.value.projectId, paths.projectId)
  assert.equal(stored.value.schemaVersion, 1)
  assert.equal(stored.revision.length > 0, true)
  assert.equal(typeof stored.value.currentVersionId, 'string')
})

test('versions: expected events are appended', () => {
  const { paths, store } = newProject('events')
  const current = store.ensureCurrent({ actor: 'user' })
  const candidate = store.createCandidate({ baseVersionId: current.versionId, target: 'X', scope: ConfirmScope.OBJECT })
  store.acceptCandidate(candidate.candidateId, { actor: 'user' })
  // A candidate left OPEN on the new current version: reverting must flag it as stale.
  const live = store.createCandidate({
    baseVersionId: store.getCurrent().versionId,
    target: 'Y',
    scope: ConfirmScope.OBJECT,
  })
  const reverted = store.revertToVersion(current.versionId, { actor: 'user' })
  assert.deepEqual(reverted.staleCandidateIds, [live.candidateId])
  const { events } = readEvents(paths.dir, { limit: 200 })
  const kinds = events.map((event) => event.kind)
  assert.ok(kinds.includes('version.created'))
  assert.ok(kinds.includes('version.candidate-created'))
  assert.ok(kinds.includes('version.candidate-accepted'))
  assert.ok(kinds.includes('version.reverted'))
  assert.ok(kinds.includes('version.candidate-stale'), '回退后必须记录旧候选失效')
})

test('versions: describe() reports the real version facts', () => {
  const { store } = newProject('describe')
  assert.deepEqual(store.describe(), {
    projectId: store.projectId,
    currentVersionId: null,
    finalVersionId: null,
    versions: 0,
    candidates: 0,
    liveCandidates: 0,
    staleCandidates: 0,
  })
  const current = store.ensureCurrent({ actor: 'user' })
  store.createCandidate({ baseVersionId: current.versionId, target: 'A', scope: ConfirmScope.OBJECT })
  const summary = store.describe()
  assert.equal(summary.currentVersionId, current.versionId)
  assert.equal(summary.versions, 1)
  assert.equal(summary.candidates, 1)
  assert.equal(summary.liveCandidates, 1)
  assert.equal(summary.staleCandidates, 0)
})
