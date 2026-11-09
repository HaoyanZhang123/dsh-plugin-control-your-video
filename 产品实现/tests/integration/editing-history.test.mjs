/**
 * Integration: creative-period history, revert and partial revert.
 *
 * These tests prove the three separate things the card keeps apart: history is read-only, a revert
 * becomes the current version while retaining the old current as history, and a partial revert stays
 * a candidate with named dependencies. Finalization closes the recovery entry for creative history.
 *
 * @module tests/integration/editing-history.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createVersionStore } from '../../core/project/versions.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'
import { createEditingKit } from '../../editing/index.js'
import { writePlanSnapshot } from '../../editing/ids.js'

const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 10, 0, 0, 0) })
const fontFile = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc')
const skip = fs.existsSync(fontFile) ? false : '需要系统中文字体构建 C12 计划；当前环境缺失，如实跳过'
const temp = createTempDir({ label: 'c14-history' })
test.after(() => temp.dispose())

let counter = 0

function makeProject() {
  counter += 1
  const projectsRoot = temp.dir(`root-${counter}`)
  const created = createProject({ projectsRoot, title: `历史测试 ${counter}`, clock })
  const paths = new ProjectPaths(projectsRoot, created.project.projectId)
  const versions = createVersionStore({ paths, clock })
  const current = versions.ensureCurrent({ actor: 'user' })
  const plan = normalizePlan(buildC12UnitPlan({ fontFile }), { now: () => clock.iso() })
  const snapshot = writePlanSnapshot({ paths, ownerId: `history-base-${counter}`, plan, clock })
  versions.updateCurrentContent({ content: { planRef: snapshot.planRef } }, { actor: 'system' })
  const kit = createEditingKit({ paths, clock })
  return { paths, versions, plan, kit }
}

/** Form and accept one direct candidate changing S01. */
function acceptS01Change(project, text) {
  const session = project.kit.sessions.beginSession({
    target: '改 S01',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S01'],
    plan: project.plan,
  })
  project.kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text },
  })
  const candidate = project.kit.sessions.formCandidate({ sessionId: session.sessionId }).candidate
  return project.kit.candidates.acceptCandidate({
    candidateId: candidate.candidateId,
    acknowledgeMissingPreview: true,
  })
}

test('history is read-only and reports which entries may be reverted', { skip }, () => {
  const project = makeProject()
  const history = project.kit.history.listHistory()
  assert.equal(history.readOnly, true)
  assert.equal(history.recoveryAvailable, true)
  const active = history.entries.filter((entry) => entry.active === true)
  assert.equal(active.length, 1)
  assert.equal(active[0].versionId, project.versions.getCurrent().versionId)
  assert.equal(active[0].revertEligible, false)
  assert.equal(history.entries[0].revertEligible, false, 'the only version is current, not revertible')
  // Mutating the returned copy must not change the stored document.
  history.entries[0].label = '被测试改掉'
  assert.notEqual(project.kit.history.listHistory().entries[0].label, '被测试改掉')
})

test('reverting makes a historical version current and keeps the old current as history', { skip }, () => {
  const project = makeProject()
  acceptS01Change(project, '第一版改动')
  const currentBefore = project.versions.getCurrent().versionId
  const history = project.kit.history.listHistory()
  const older = history.entries.find((entry) => entry.versionId !== currentBefore && entry.kind === 'version')
  assert.ok(older, 'an older version exists')
  const result = project.kit.history.revertToVersion({ versionId: older.versionId, reason: '回到之前' })
  assert.equal(result.version.versionId, older.versionId)
  assert.equal(result.previousCurrentVersionId, currentBefore)
  assert.equal(result.retainedHistoryVersionId, currentBefore)
  const after = project.kit.history.listHistory()
  assert.ok(after.entries.some((entry) => entry.versionId === currentBefore), 'old current retained as history')
  assert.equal(after.entries.find((entry) => entry.versionId === older.versionId).active, true)
})

test('a revert marks live candidates as needing re-check', { skip }, () => {
  const project = makeProject()
  acceptS01Change(project, '第一版改动')
  const current = project.versions.getCurrent()
  const candidate = project.versions.createCandidate({
    baseVersionId: current.versionId,
    target: '挂起候选',
    scope: 'object',
    preservedItems: [],
    diffRef: 'test-ref',
    checkScope: ['plan-diff'],
    actor: 'ai',
  })
  const older = project.versions.listHistory().find((entry) => entry.kind === 'version' && entry.versionId !== current.versionId)
  project.kit.history.revertToVersion({ versionId: older.versionId, reason: '回退' })
  assert.equal(project.versions.getCandidate(candidate.candidateId).status, 'needs-recheck')
  assert.ok(project.kit.history.listHistory().entries.every((entry) => entry.readOnly === true))
})

test('partial revert stays a candidate and names the dependencies to re-check', { skip }, () => {
  const project = makeProject()
  const before = acceptS01Change(project, '把 S01 改掉')
  const currentBefore = project.versions.getCurrent().versionId
  const older = project.versions.listHistory().find((entry) => entry.kind === 'version' && entry.versionId !== currentBefore)
  const impact = project.kit.history.describePartialRevert(older.versionId, ['obj-subtitle-S01'])
  assert.equal(impact.dependenciesRequireRecheck, true)
  assert.ok(impact.requiresRecheck.includes('obj-audio-main'), 'overlapping audio is a dependency')
  const result = project.kit.history.revertPartial({
    versionId: older.versionId,
    objectIds: ['obj-subtitle-S01'],
    reason: '只回退这一条字幕',
  })
  assert.equal(result.applied, false)
  assert.equal(result.partial, true)
  assert.equal(result.dependenciesRequireRecheck, true)
  assert.equal(result.candidate.status, 'open')
  assert.equal(project.versions.getCurrent().versionId, currentBefore, 'partial revert does not change current')
  assert.equal(before.version.class, 'current')
})

test('after finalization history is read-only and cannot be reverted', { skip }, () => {
  const project = makeProject()
  const final = project.versions.finalize({
    actor: 'user',
    confirmationRef: 'confirmation:test-accept',
    label: '定稿测试',
  })
  assert.equal(final.immutable, true)
  const state = project.kit.history.describeHistory()
  assert.equal(state.finalized, true)
  assert.equal(state.recoveryAvailable, false)
  assert.throws(
    () => project.kit.history.revertToVersion({ versionId: final.versionId }),
    /不能回退/,
  )
  const history = project.kit.history.listHistory()
  assert.equal(history.readOnly, true)
  assert.ok(history.entries.every((entry) => entry.revertEligible === false))
})

test('only the user may accept, revert or partially adopt', { skip }, () => {
  const project = makeProject()
  const session = project.kit.sessions.beginSession({
    target: '改 S01',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S01'],
    plan: project.plan,
  })
  project.kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text: 'AI 不能替用户接受' },
  })
  const candidate = project.kit.sessions.formCandidate({ sessionId: session.sessionId }).candidate
  assert.throws(
    () => project.kit.candidates.acceptCandidate({
      candidateId: candidate.candidateId,
      actor: 'ai',
      acknowledgeMissingPreview: true,
    }),
    /只有用户能接受候选/,
  )
  assert.throws(
    () => project.kit.candidates.partialAdopt({ candidateId: candidate.candidateId, objectIds: ['obj-subtitle-S01'], actor: 'ai' }),
    /用户决定/,
  )
  const current = project.versions.getCurrent().versionId
  assert.throws(
    () => project.kit.history.revertToVersion({ versionId: current, actor: 'ai' }),
    /用户决定/,
  )
})
