/**
 * Integration: AI complex modification through the ORIGINAL production sub-agent.
 *
 * These tests prove the organization and the contract, not a model's taste: the same producer session
 * C13 bound is required, production is paused before dispatch, a direction change waits for a real
 * user confirmation, a returned plan outside the declared scope becomes a recorded FAILURE instead of
 * a candidate, and a candidate whose base moved is flagged instead of applied.
 *
 * @module tests/integration/editing-ai.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createVersionStore } from '../../core/project/versions.js'
import { createDecisionLog } from '../../core/project/decisions.js'
import { ConfirmAspect, ConfirmScope, ConfirmationState } from '../../core/project/schema.js'
import { createOrchestrationKit } from '../../orchestration/index.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'
import { createEditingKit } from '../../editing/index.js'
import { writePlanSnapshot } from '../../editing/ids.js'
import { applyDirectIntent } from '../../editing/scope.js'

const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 10, 0, 0, 0) })
const fontFile = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc')
const skip = fs.existsSync(fontFile) ? false : '需要系统中文字体构建 C12 计划；当前环境缺失，如实跳过'
const temp = createTempDir({ label: 'c14-ai' })
test.after(() => temp.dispose())

let counter = 0

/** One project with a bound production run and a plan snapshot behind the current version. */
function makeProject() {
  counter += 1
  const projectsRoot = temp.dir(`root-${counter}`)
  const created = createProject({ projectsRoot, title: `AI 修改测试 ${counter}`, clock })
  const paths = new ProjectPaths(projectsRoot, created.project.projectId)
  const versions = createVersionStore({ paths, clock })
  const decisions = createDecisionLog({ paths, clock })
  const current = versions.ensureCurrent({ actor: 'user' })
  const plan = normalizePlan(buildC12UnitPlan({ fontFile }), { now: () => clock.iso() })
  const snapshot = writePlanSnapshot({ paths, ownerId: `ai-base-${counter}`, plan, clock })
  versions.updateCurrentContent({ content: { planRef: snapshot.planRef } }, { actor: 'system' })
  const orchestration = createOrchestrationKit({ paths, clock })
  orchestration.production.begin({
    producerSessionId: 'producer-session-1',
    projectVersion: 'v1',
    baselineRef: 'baseline-1',
  })
  const kit = createEditingKit({ paths, clock })
  const previewFile = path.join(temp.dir(`ai-preview-${counter}`), 'result.mp4')
  fs.mkdirSync(path.dirname(previewFile), { recursive: true })
  fs.writeFileSync(previewFile, 'placeholder result media')
  return { projectsRoot, paths, versions, decisions, orchestration, kit, plan, current, previewFile }
}

/** Plan with one subtitle text changed. @param {any} base @param {string} text */
function changedPlan(base, text = '制作子 Agent 返回的修订') {
  return applyDirectIntent({
    plan: base,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text },
  }).plan
}

test('a direction change waits for a real user confirmation', { skip }, () => {
  const project = makeProject()
  const { kit } = project
  const planned = kit.ai.planAiEdit({
    instruction: '把方向改成更冷静的叙述',
    target: 'S02 字幕与叙述方向',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
    directionChange: true,
  })
  assert.equal(planned.request.status, 'needs-user')
  assert.equal(planned.needsUserDecision, true)
  assert.equal(planned.proposal.isConfirmation, false, 'AI proposal is not a confirmation')
  assert.throws(
    () => kit.ai.dispatchToProducer({
      requestId: planned.request.requestId,
      producerSessionId: 'producer-session-1',
    }),
    /还没有用户确认/,
  )
})

test('with a real user confirmation the direction change may be planned and dispatched', { skip }, () => {
  const project = makeProject()
  const { kit, decisions, current } = project
  const confirmation = decisions.recordConfirmation({
    actor: 'user',
    objectId: 'obj-subtitle-S02',
    aspect: ConfirmAspect.DIRECTION,
    scope: ConfirmScope.PART,
    versionId: current.versionId,
    state: ConfirmationState.PARTIALLY_CONFIRMED,
    humanResponse: '同意把这一段方向改冷一点，其它不动',
  })
  const planned = kit.ai.planAiEdit({
    instruction: '把方向改成更冷静的叙述',
    target: 'S02 字幕与叙述方向',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
    directionChange: true,
    decisionRef: confirmation.confirmationId,
  })
  assert.equal(planned.request.status, 'planned')
  const dispatched = kit.ai.dispatchToProducer({
    requestId: planned.request.requestId,
    producerSessionId: 'producer-session-1',
  })
  assert.equal(dispatched.request.status, 'dispatched')
  assert.equal(dispatched.request.pausedProduction.changed, false, 'idle production needs no pause')
  assert.ok(['idle', 'paused'].includes(dispatched.production.execution))
})

test('only the bound original producer may return a result', { skip }, () => {
  const project = makeProject()
  const { kit } = project
  const planned = kit.ai.planAiEdit({
    instruction: '缩短 S02',
    target: 'S02',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  assert.throws(
    () => kit.ai.dispatchToProducer({ requestId: planned.request.requestId, producerSessionId: 'some-new-agent' }),
    /原制作子 Agent/,
  )
  project.orchestration.production.setExecution('running', { reason: 'fake in-flight production' })
  const dispatched = kit.ai.dispatchToProducer({
    requestId: planned.request.requestId,
    producerSessionId: 'producer-session-1',
  })
  assert.equal(dispatched.production.paused, true, 'running production is paused before the edit')
  assert.throws(
    () => kit.ai.recordProducerReturn({
      requestId: dispatched.request.requestId,
      producerSessionId: 'some-new-agent',
      plan: changedPlan(project.plan),
      checkScope: ['plan-diff'],
    }),
    /只能由同一制作子 Agent/,
  )
})

test('a returned plan becomes a real candidate with comparison, issues and check scope', { skip }, () => {
  const project = makeProject()
  const { kit, versions, current } = project
  const planned = kit.ai.planAiEdit({
    instruction: '缩短 S02 字幕',
    target: 'S02 字幕',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  const dispatched = kit.ai.dispatchToProducer({
    requestId: planned.request.requestId,
    producerSessionId: 'producer-session-1',
  })
  assert.equal(dispatched.request.workPackage.producerSessionId, 'producer-session-1')
  const returned = kit.ai.recordProducerReturn({
    requestId: planned.request.requestId,
    producerSessionId: 'producer-session-1',
    plan: changedPlan(project.plan),
    previewRef: project.previewFile,
    checkScope: ['plan-diff', 'scope-protection', 'render-result'],
    knownIssues: ['字幕右缘离背景条略近'],
    actualChecks: ['plan-diff', 'region-compare'],
    evidenceRefs: ['evidence:c14-ai-return'],
  })
  assert.equal(returned.request.status, 'returned')
  assert.equal(returned.candidate.status, 'open')
  assert.equal(returned.candidate.baseVersionId, current.versionId)
  assert.equal(returned.comparison.realComparison, true)
  assert.deepEqual(returned.request.result.checkScope, ['plan-diff', 'scope-protection', 'render-result'])
  assert.deepEqual(returned.request.result.knownIssues, ['字幕右缘离背景条略近'])
  assert.equal(returned.request.result.aiViewed, false, 'program checks are not AI viewing')
  assert.equal(returned.request.result.aiListened, false)
  const link = kit.candidates.describeCandidate(returned.candidate.candidateId).link
  assert.equal(typeof link.planRef, 'string')
  assert.equal(link.baseVersionId, current.versionId)
  assert.throws(
    () => kit.ai.dispatchToProducer({ requestId: planned.request.requestId, producerSessionId: 'producer-session-1' }),
    /已经结束/,
  )
  assert.equal(versions.getCurrent().versionId, current.versionId, 'return does not modify current')
})

test('a return outside the declared scope is a recorded failure, not a trimmed candidate', { skip }, () => {
  const project = makeProject()
  const { kit, versions } = project
  const before = versions.getCurrent().versionId
  const planned = kit.ai.planAiEdit({
    instruction: '只改 S02',
    target: 'S02',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  kit.ai.dispatchToProducer({ requestId: planned.request.requestId, producerSessionId: 'producer-session-1' })
  const result = applyDirectIntent({
    plan: project.plan,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text: '子 Agent 偷改了 S01' },
  }).plan
  const returned = kit.ai.recordProducerReturn({
    requestId: planned.request.requestId,
    producerSessionId: 'producer-session-1',
    plan: result,
    checkScope: ['plan-diff'],
  })
  assert.equal(returned.status, 'failed')
  assert.equal(returned.candidate, null)
  assert.equal(returned.request.failure.preservedOriginal, true)
  assert.ok(returned.request.failure.violations.some((entry) => entry.rule === 'changed-outside-target'))
  assert.equal(versions.getCurrent().versionId, before)
})

test('a bare failure keeps the original version and records the real scope', { skip }, () => {
  const project = makeProject()
  const { kit, versions } = project
  const before = versions.getCurrent().versionId
  const planned = kit.ai.planAiEdit({
    instruction: '把 S02 改成两行',
    target: 'S02',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  kit.ai.dispatchToProducer({ requestId: planned.request.requestId, producerSessionId: 'producer-session-1' })
  const returned = kit.ai.recordProducerReturn({
    requestId: planned.request.requestId,
    producerSessionId: 'producer-session-1',
    failure: {
      reason: '渲染失败：字幕字体缺字',
      realSuccessScope: [],
      evidenceRefs: ['evidence:c14-fail-log'],
    },
  })
  assert.equal(returned.status, 'failed')
  assert.equal(returned.request.failure.reason, '渲染失败：字幕字体缺字')
  assert.equal(versions.getCurrent().versionId, before)
})

test('a base that moved after dispatch is flagged, not silently applied', { skip }, () => {
  const project = makeProject()
  const { kit, versions } = project
  const planned = kit.ai.planAiEdit({
    instruction: '改 S02',
    target: 'S02',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: project.plan,
  })
  const dispatched = kit.ai.dispatchToProducer({
    requestId: planned.request.requestId,
    producerSessionId: 'producer-session-1',
  })
  assert.equal(dispatched.request.status, 'dispatched')

  // The user edits S01 directly while the producer works; the current version advances.
  const session = kit.sessions.beginSession({
    target: '改 S01',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S01'],
    plan: project.plan,
  })
  kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text: '用户直接改动' },
  })
  const candidate = kit.sessions.formCandidate({ sessionId: session.sessionId }).candidate
  kit.candidates.acceptCandidate({ candidateId: candidate.candidateId, acknowledgeMissingPreview: true })

  const returned = kit.ai.recordProducerReturn({
    requestId: planned.request.requestId,
    producerSessionId: 'producer-session-1',
    plan: changedPlan(project.plan),
    checkScope: ['plan-diff'],
  })
  assert.equal(returned.needsRecheck, true)
  assert.equal(versions.getCandidate(returned.candidate.candidateId).status, 'needs-recheck')
  assert.throws(
    () => kit.candidates.acceptCandidate({
      candidateId: returned.candidate.candidateId,
      acknowledgeMissingPreview: true,
    }),
    /重新核对/,
  )
})
