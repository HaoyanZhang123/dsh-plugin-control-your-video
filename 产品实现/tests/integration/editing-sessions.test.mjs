/**
 * Integration: direct-edit sessions on a real project directory.
 *
 * The point of these tests is the combination the card names: autosaved draft, undo/redo/abandon,
 * real candidate that does not overwrite the current version, base-version conflicts, re-check that
 * REBUILDS the candidate on a newer base instead of dropping the newer changes, partial adoption that
 * stays a candidate, and the production pause rule.
 *
 * @module tests/integration/editing-sessions.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createVersionStore } from '../../core/project/versions.js'
import { acquireProjectWriter } from '../../core/project/write-guard.js'
import { createOrchestrationKit } from '../../orchestration/index.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'
import { createEditingKit } from '../../editing/index.js'
import { pauseProductionForEditing } from '../../editing/guard.js'
import { writePlanSnapshot } from '../../editing/ids.js'

const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 10, 0, 0, 0) })
const fontFile = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc')
const skip = fs.existsSync(fontFile) ? false : '需要系统中文字体构建 C12 计划；当前环境缺失，如实跳过'
const temp = createTempDir({ label: 'c14-sessions' })
test.after(() => temp.dispose())

let counter = 0

/** One project with a real current version and plan snapshot. */
function makeProject() {
  counter += 1
  const projectsRoot = temp.dir(`root-${counter}`)
  const created = createProject({ projectsRoot, title: `会话测试 ${counter}`, clock })
  const paths = new ProjectPaths(projectsRoot, created.project.projectId)
  const versions = createVersionStore({ paths, clock })
  const current = versions.ensureCurrent({ actor: 'user' })
  const plan = normalizePlan(buildC12UnitPlan({ fontFile }), { now: () => clock.iso() })
  const snapshot = writePlanSnapshot({ paths, ownerId: `base-${counter}`, plan, clock })
  versions.updateCurrentContent({ content: { planRef: snapshot.planRef } }, { actor: 'system' })
  const kit = createEditingKit({ paths, clock })
  return { projectsRoot, paths, versions, plan, kit, previewFile: null }
}

/** A readable placeholder file used as a media reference (path checking only). */
function makePreview(project) {
  const dir = temp.dir(`previews-${counter}`)
  const file = path.join(dir, 'preview.mp4')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, 'placeholder preview bytes')
  return file
}

test('direct edit: autosave, undo/redo, candidate, accept as current (not final)', { skip }, () => {
  const project = makeProject()
  const { kit, versions } = project
  const session = kit.sessions.beginSession({
    target: '只改 S02 字幕',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
    actor: 'user',
  })
  assert.equal(session.steps.length, 1)
  const edited = kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '修订后的字幕' },
  })
  assert.deepEqual(edited.scope.changedObjectIds, ['obj-subtitle-S02'])
  assert.equal(edited.scope.audioProtected, true)
  const undo = kit.sessions.undoEdit({ sessionId: session.sessionId })
  assert.equal(undo.pointer, 0)
  const redo = kit.sessions.redoEdit({ sessionId: session.sessionId })
  assert.equal(redo.pointer, 1)
  const preview = makePreview(project)
  kit.sessions.attachPreview({ sessionId: session.sessionId, mediaRef: preview })
  const formed = kit.sessions.formCandidate({ sessionId: session.sessionId })
  assert.equal(formed.candidate.status, 'open')
  assert.equal(formed.comparison.realComparison, true)
  assert.equal(formed.candidate.baseVersionId, session.baseVersionId)
  const accepted = kit.candidates.acceptCandidate({ candidateId: formed.candidate.candidateId })
  assert.equal(accepted.version.class, 'current')
  assert.equal(kit.history.describeHistory().finalized, false, 'candidate acceptance is not finalization')
  const currentNow = versions.getCurrent()
  assert.equal(currentNow.versionId, accepted.version.versionId)
  const link = kit.candidates.describeCandidate(formed.candidate.candidateId).link
  assert.equal(currentNow.content.planRef, link.planRef)
  assert.equal(currentNow.content.acceptedCandidateRef, formed.candidate.candidateId)
})

test('abandon: the current version is untouched and the candidate is superseded', { skip }, () => {
  const project = makeProject()
  const { kit, versions } = project
  const before = versions.getCurrent().versionId
  const session = kit.sessions.beginSession({
    target: '改 S01',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S01'],
    plan: project.plan,
  })
  kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text: '这一版不要了' },
  })
  const formed = kit.sessions.formCandidate({ sessionId: session.sessionId })
  const abandoned = kit.sessions.abandonSession({ sessionId: session.sessionId, reason: '用户放弃' })
  assert.equal(abandoned.status, 'abandoned')
  assert.equal(versions.getCandidate(formed.candidate.candidateId).status, 'superseded')
  assert.equal(versions.getCurrent().versionId, before)
})

test('a scope violation is refused before it is saved', { skip }, () => {
  const project = makeProject()
  const { kit } = project
  const session = kit.sessions.beginSession({
    target: '只改 S02',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  assert.throws(
    () => kit.sessions.applyEdit({
      sessionId: session.sessionId,
      intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text: '偷改别人的字幕' },
    }),
    /越出声明范围/,
  )
  const reread = kit.sessions.getSession(session.sessionId)
  assert.equal(reread.steps.length, 1, 'refused step was not persisted')
})

test('stale candidate: re-check rebuilds it on the newer base and keeps both edits', { skip }, () => {
  const project = makeProject()
  const { kit, versions } = project
  const first = kit.sessions.beginSession({
    target: '改 S02',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  kit.sessions.applyEdit({
    sessionId: first.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '候选一：S02 改动' },
  })
  const firstPreview = makePreview(project)
  kit.sessions.attachPreview({ sessionId: first.sessionId, mediaRef: firstPreview })
  const firstCandidate = kit.sessions.formCandidate({ sessionId: first.sessionId }).candidate

  const second = kit.sessions.beginSession({
    target: '改 S01',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S01'],
    plan: project.plan,
  })
  kit.sessions.applyEdit({
    sessionId: second.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text: '候选二：S01 改动' },
  })
  const secondPreview = makePreview(project)
  kit.sessions.attachPreview({ sessionId: second.sessionId, mediaRef: secondPreview })
  const secondCandidate = kit.sessions.formCandidate({ sessionId: second.sessionId }).candidate
  kit.candidates.acceptCandidate({ candidateId: secondCandidate.candidateId })

  assert.throws(
    () => kit.candidates.acceptCandidate({ candidateId: firstCandidate.candidateId, acknowledgeMissingPreview: true }),
    /重新核对/,
  )
  const rechecked = kit.candidates.recheckCandidate({ candidateId: firstCandidate.candidateId })
  assert.equal(rechecked.rebased, true)
  assert.equal(rechecked.previewStale, true)
  assert.throws(
    () => kit.candidates.acceptCandidate({ candidateId: firstCandidate.candidateId, acknowledgeMissingPreview: true }),
    /新预览/,
  )
  const accepted = kit.candidates.acceptCandidate({
    candidateId: firstCandidate.candidateId,
    acknowledgeStalePreview: true,
  })
  const link = kit.candidates.describeCandidate(firstCandidate.candidateId).link
  const plan = kit.sessions.readPlanSnapshotOf(link.planRef).plan
  assert.equal(plan.objects.find((entry) => entry.id === 'obj-subtitle-S02').params.text, '候选一：S02 改动')
  assert.equal(plan.objects.find((entry) => entry.id === 'obj-subtitle-S01').params.text, '候选二：S01 改动')
  assert.equal(accepted.version.content.planRef, link.planRef)
})

test('a re-check that would overwrite the same object is refused', { skip }, () => {
  const project = makeProject()
  const { kit } = project
  const first = kit.sessions.beginSession({
    target: '改 S02 第一版',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  kit.sessions.applyEdit({
    sessionId: first.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '第一版' },
  })
  const firstCandidate = kit.sessions.formCandidate({ sessionId: first.sessionId }).candidate
  const secondPreview = makePreview(project)
  const second = kit.sessions.beginSession({
    target: '改 S02 第二版',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  kit.sessions.applyEdit({
    sessionId: second.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '第二版' },
  })
  kit.sessions.attachPreview({ sessionId: second.sessionId, mediaRef: secondPreview })
  const secondCandidate = kit.sessions.formCandidate({ sessionId: second.sessionId }).candidate
  kit.candidates.acceptCandidate({ candidateId: secondCandidate.candidateId })
  assert.throws(
    () => kit.candidates.recheckCandidate({ candidateId: firstCandidate.candidateId }),
    /同一对象/,
  )
})

test('partial adoption forms a new candidate and names dependency re-checks', { skip }, () => {
  const project = makeProject()
  const { kit, versions } = project
  const session = kit.sessions.beginSession({
    target: '改两条字幕',
    scope: 'part',
    targetObjectIds: ['obj-subtitle-S01', 'obj-subtitle-S02'],
    plan: project.plan,
  })
  kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text: 'S01 新文案' },
  })
  kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: 'S02 新文案' },
  })
  const formed = kit.sessions.formCandidate({ sessionId: session.sessionId })
  const before = versions.getCurrent().versionId
  const partial = kit.candidates.partialAdopt({
    candidateId: formed.candidate.candidateId,
    objectIds: ['obj-subtitle-S02'],
  })
  assert.equal(partial.applied, false)
  assert.equal(partial.partial, true)
  assert.equal(partial.status, 'new-candidate-needs-recheck')
  assert.equal(partial.dependenciesRequireRecheck, true)
  assert.equal(partial.candidate.status, 'open')
  assert.ok(partial.requiresRecheck.includes('obj-audio-main'), 'overlapping audio must be re-checked')
  assert.equal(versions.getCurrent().versionId, before, 'partial adoption does not change current')
})

test('production running blocks an actual edit until it is paused', { skip }, () => {
  const project = makeProject()
  const { paths, kit } = project
  const orchestration = createOrchestrationKit({ paths, clock })
  orchestration.production.begin({
    producerSessionId: 'producer-session-1',
    projectVersion: 'v1',
    baselineRef: 'baseline-1',
  })
  orchestration.production.setExecution('running', { reason: 'fake in-flight production' })
  assert.throws(
    () => kit.sessions.beginSession({
      target: '改 S02',
      scope: 'object',
      targetObjectIds: ['obj-subtitle-S02'],
      plan: project.plan,
    }),
    /先暂停/,
  )
  const paused = pauseProductionForEditing({ paths, clock, reason: '测试暂停' })
  assert.equal(paused.execution, 'paused')
  const session = kit.sessions.beginSession({
    target: '改 S02',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  assert.ok(session.sessionId.length > 0)
})

test('a second writer is refused while the project writer lock is held', { skip }, () => {
  const project = makeProject()
  const { paths, kit } = project
  const lock = acquireProjectWriter({
    projectsRoot: paths.projectsRoot,
    projectId: paths.projectId,
    taskId: 'other-writer',
    ownerLabel: '另一个写入者',
    clock,
  })
  try {
    assert.throws(
      () => kit.sessions.beginSession({
        target: '改 S02',
        scope: 'object',
        targetObjectIds: ['obj-subtitle-S02'],
        plan: project.plan,
      }),
      /写入锁/,
    )
  } finally {
    lock.release()
  }
})

test('a candidate without a preview needs an explicit acknowledgement to accept', { skip }, () => {
  const project = makeProject()
  const { kit } = project
  const session = kit.sessions.beginSession({
    target: '改 S02',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '没有预览的次要改动' },
  })
  const formed = kit.sessions.formCandidate({ sessionId: session.sessionId })
  assert.equal(formed.previewAvailable, false)
  assert.throws(
    () => kit.candidates.acceptCandidate({ candidateId: formed.candidate.candidateId }),
    /没有真实预览/,
  )
  const accepted = kit.candidates.acceptCandidate({
    candidateId: formed.candidate.candidateId,
    acknowledgeMissingPreview: true,
    acknowledgeStalePreview: true,
  })
  assert.equal(accepted.previewMissing, true)
})
