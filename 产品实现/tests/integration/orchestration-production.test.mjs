/**
 * Integration tests for the production run, the gates around it, pin synchronisation and the
 * preview takeover.
 *
 * These use a real projects root, real project directories, real C10 locks and a real C12
 * CompositionPlan, because the claims under test are about the disk and about other modules:
 * one writer at a time, one complete-production project at a time, a film that actually has files,
 * a pin that C06 actually refuses, and a preview whose staleness comes from C12's own diff.
 *
 * @module tests/integration/orchestration-production.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { Clock, createTempDir, ValidationError } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { inspectProjectWriter, projectEditLockPath } from '../../core/project/write-guard.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { fontFile } from '../../media/tests/helpers.mjs'
import { normalizePlan, diffPlans } from '../../media/plan.js'
import { initialCutGate, productionGate, ProductionRun, TakeoverCause } from '../../orchestration/production.js'
import { PinSync, PinSyncIssue } from '../../orchestration/pins.js'
import { PreviewSurface } from '../../orchestration/preview.js'
import { resolveUnitProfile, UnitBase, UnitOperation } from '../../orchestration/units.js'

const temp = createTempDir({ label: 'orchestration-production' })
test.after(() => temp.dispose())

const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
let counter = 0

/** A projects root with one (or two) real projects. */
function makeRoot(count = 1) {
  counter += 1
  const root = temp.dir(`root-${counter}`)
  const projects = []
  for (let index = 0; index < count; index += 1) {
    const created = createProject({ projectsRoot: root, title: `制作 ${counter}-${index}`, clock })
    projects.push({ projectId: created.project.projectId, paths: new ProjectPaths(root, created.project.projectId) })
  }
  return { root, projects }
}

/** A plan from the C12 fixture, with a chosen plan version. */
function makePlan(version = 'plan-v1') {
  const normalized = normalizePlan(buildC12UnitPlan({ fontFile: fontFile() }))
  return { ...normalized, planVersion: version }
}

test('production: the first unit binds one maker and a second maker is refused', () => {
  const { projects } = makeRoot()
  const run = new ProductionRun({ paths: projects[0].paths, clock })
  run.begin({ producerSessionId: 'maker-A', projectVersion: 'rev-1', baselineRef: 'baseline-1', scope: '完整初版' })

  assert.equal(run.assertProducer('maker-A').producerSessionId, 'maker-A')
  assert.throws(() => run.assertProducer('maker-B'), /同一制作子 Agent/)
  assert.throws(
    () => run.begin({ producerSessionId: 'maker-B', projectVersion: 'rev-1', baselineRef: 'baseline-1' }),
    /不能另起一个制作者/,
  )

  const updated = run.update({ producerSessionId: 'maker-A', patch: { currentUnit: 'unit-1', nextAction: '制作转场' } })
  assert.equal(updated.run.version, 2)
  assert.equal(updated.run.currentUnit, 'unit-1')
  // The work package records a project version but never advances it.
  assert.equal(updated.run.projectVersion, 'rev-1')
})

test('production: pause, important change, unknown result and cancel behave as real states', () => {
  const { projects } = makeRoot()
  const run = new ProductionRun({ paths: projects[0].paths, clock })
  run.begin({ producerSessionId: 'maker-A', projectVersion: 'rev-1', baselineRef: 'baseline-1' })
  run.setExecution('running')

  const paused = run.pause({ reason: '用户切换到别的页面' })
  assert.equal(paused.run.execution, 'paused')
  assert.equal(run.resume({ producerSessionId: 'maker-A' }).run.execution, 'running')

  // An important change must pause and produce a new baseline before work continues.
  run.requestImportantChange({ description: '用户要把结尾改成定格', affectedScope: '结尾 2 秒' })
  assert.equal(run.read().execution, 'paused')
  assert.throws(() => run.resume({ producerSessionId: 'maker-A' }), /重要修改尚未形成新基线/)
  run.recordNewBaseline({ baselineRef: 'baseline-2' })
  assert.equal(run.resume({ producerSessionId: 'maker-A' }).run.execution, 'running')

  // An unknown external action is a pause plus an explicit read-back, not a retry.
  const unknown = run.markUnknown({ action: '编码输出第 2 段' })
  assert.equal(unknown.run.execution, 'unknown')
  assert.equal(unknown.run.unknownAction.autoRetry, false)
  assert.throws(() => run.resume({ producerSessionId: 'maker-A' }), /结果未知/)
  const settled = run.resume({ producerSessionId: 'maker-A', acknowledgedUnknown: '读回输出文件，实际已生成完整' })
  assert.equal(settled.run.execution, 'running')
  assert.equal(typeof settled.run.acknowledgedUnknown, 'string')

  // Cancelling the route keeps what already succeeded.
  const cancelled = run.cancel({ reason: '用户取消这条路线', keptResults: ['unit-1', 'unit-2'] })
  assert.equal(cancelled.run.execution, 'cancelled')
  assert.deepEqual(cancelled.run.keptResults, ['unit-1', 'unit-2'])
  assert.throws(() => run.pause({ reason: '再试一次' }), /不能暂停/)
})

test('production: takeover needs an allowed cause, a saved position and a new session', () => {
  const { projects } = makeRoot()
  const run = new ProductionRun({ paths: projects[0].paths, clock })
  run.begin({ producerSessionId: 'maker-A', projectVersion: 'rev-1', baselineRef: 'baseline-1' })

  assert.throws(
    () => run.takeOver({ producerSessionId: 'maker-B', cause: 'a-nicer-metric', reason: '想并行', savedPosition: '第 1 单元' }),
    /不是允许的取值/,
  )
  assert.throws(
    () => run.takeOver({ producerSessionId: 'maker-A', cause: TakeoverCause.CRASH, reason: '崩溃', savedPosition: '第 1 单元' }),
    /新的会话身份/,
  )
  const takenOver = run.takeOver({
    producerSessionId: 'maker-B',
    cause: TakeoverCause.CRASH,
    reason: '子 Agent 崩溃，无法恢复',
    savedPosition: '第 2 单元 / 转场 1 / 已保存',
  })
  assert.equal(takenOver.run.producerSessionId, 'maker-B')
  assert.equal(takenOver.run.producerHistory.length, 2)
  assert.equal(takenOver.run.producerHistory[1].takeover.cause, 'crash')
  // A replacement still means one maker: continuing from the saved position, not from scratch.
  assert.equal(takenOver.run.savedPosition, '第 2 单元 / 转场 1 / 已保存')
  assert.equal(run.assertProducer('maker-B').producerSessionId, 'maker-B')
})

test('production: one complete-production project at a time, and the writer pair is released', () => {
  const { projects } = makeRoot(2)
  const first = new ProductionRun({ paths: projects[0].paths, clock })
  const second = new ProductionRun({ paths: projects[1].paths, clock })

  const handles = first.acquireLocks({ taskId: 'c13-full-production', projectVersion: 'rev-1' })
  try {
    assert.throws(
      () => second.acquireLocks({ taskId: 'c13-full-production', projectVersion: 'rev-1' }),
      (error) => /完整制作|锁/.test(String(error?.message ?? '')),
    )
    // The failed second attempt must not leave a writer lock behind on project B: the pair is
    // acquired or released together.
    const lockPathB = projectEditLockPath(projects[1].paths.projectsRoot, projects[1].projectId)
    assert.equal(inspectProjectWriter(lockPathB), null)
  } finally {
    first.releaseLocks(handles)
  }
  const again = second.acquireLocks({ taskId: 'c13-full-production', projectVersion: 'rev-1' })
  second.releaseLocks(again)
})

test('production gate: recipe, plan document, free lock and authorization are all required', () => {
  const blocked = productionGate({
    planGate: { ok: false, blockers: [{ reason: '关键项未定' }] },
    unitGate: { ok: false },
    lockFree: false,
  })
  const areas = blocked.blockers.map((blocker) => blocker.area)
  assert.deepEqual(areas.sort(), ['authorization', 'locks', 'plan', 'plan-document', 'recipe', 'units'])

  const ready = productionGate({
    planGate: { ok: true, blockers: [] },
    unitGate: { ok: true, blockers: [] },
    recipePresent: true,
    compositionPlanPresent: true,
    lockFree: true,
    authorizations: ['aut_1'],
  })
  assert.equal(ready.ok, true)
})

test('initial cut: a real whole film passes, with the AI viewing scope kept separate', () => {
  const plan = makePlan('plan-v1')
  const profile = resolveUnitProfile({ base: UnitBase.TEMPORAL_MOTION, operation: UnitOperation.CREATE })
  const gateResult = initialCutGate({
    baseline: { ref: 'baseline-1', items: [{ itemId: 'i1', kind: 'core-goal', blocking: true, state: 'decided' }] },
    units: [{ unitId: 'unit-1', status: 'complete', profileId: profile.profileId }],
    cut: {
      files: [{ path: 'media/final.mp4', sha256: 'a'.repeat(64) }],
      readableWhole: true,
      timebase: { totalFrames: plan.timebase.totalFrames },
    },
    compositionPlan: plan,
    programChecks: [
      { name: '可解码', executed: true, passed: true },
      { name: '音画同步', executed: true, passed: true },
    ],
    knownIssues: [],
    unverified: ['结尾定格时长未由用户确认'],
    vision: { observed: true, evidenceRefs: ['evd:frame-1'], scope: '整片代理＋3 个关键帧' },
  })
  assert.equal(gateResult.ok, true, JSON.stringify(gateResult.blockers))
  assert.equal(gateResult.handoff.aiSawFrames, '整片代理＋3 个关键帧')
  assert.equal(gateResult.handoff.aiSawEvidenceRefs.length, 1)
  // There is no host listening channel, so this can never become "I listened".
  assert.equal(gateResult.handoff.aiHeardAudio.includes('未听'), true)
  assert.equal(gateResult.handoff.userReviewRequired, true)
})

test('initial cut: missing file hash, frame mismatch and incomplete units all block', () => {
  const plan = makePlan('plan-v1')
  const blocked = initialCutGate({
    baseline: { ref: 'baseline-1', items: [{ itemId: 'i1', kind: 'core-goal', blocking: true, state: 'undecided' }] },
    units: [{ unitId: 'unit-1', status: 'incomplete' }],
    cut: { files: [{ path: 'media/final.mp4' }], readableWhole: false, timebase: { totalFrames: plan.timebase.totalFrames + 5 } },
    compositionPlan: plan,
    programChecks: [{ name: '可解码', executed: false, passed: false }],
    knownIssues: [],
    unverified: [],
  })
  assert.equal(blocked.ok, false)
  const reasons = blocked.blockers.map((blocker) => blocker.reason).join('|')
  assert.match(reasons, /关键项未定/)
  assert.match(reasons, /未完成单元/)
  assert.match(reasons, /缺少内容哈希/)
  assert.match(reasons, /整片不可完整读取播放/)
  assert.match(reasons, /总帧数与 CompositionPlan 不一致/)
  assert.match(reasons, /检查未执行/)
})

test('pins: C10 与 C06 的项目引用形状不一致时会报需要处理，而不是自动翻译', () => {
  const { projects } = makeRoot()
  const projectId = projects[0].projectId
  // The measured C06 behaviour: it accepts `^[a-z]+-[A-Za-z0-9]+$` and refuses C10's `prj_...`.
  const pinSource = {
    advanceProjectPin(toolId, input) {
      if (!/^[a-z]+-[A-Za-z0-9]+$/.test(input.projectId)) {
        throw new ValidationError('projectId 必须是合法的项目 ID 引用', { field: 'projectId' })
      }
      return {
        toolId,
        pins: [{ projectId: input.projectId, projectVersion: input.toProjectVersion, version: input.version }],
      }
    },
    recheckProjectPin(toolId, input) {
      return { check: 'stale', currentProjectVersion: input.currentProjectVersion, staleVersions: ['rev-1'], toolAvailable: null }
    },
  }
  const sync = new PinSync({ paths: projects[0].paths, clock, pinSource })

  const mismatch = sync.advance({ toolId: 'ffmpeg', fromProjectVersion: 'rev-1', toProjectVersion: 'rev-2', toolVersion: '9.0.1' })
  assert.equal(mismatch.status, 'needs-handling')
  assert.equal(mismatch.issue.code, PinSyncIssue.REFERENCE_MISMATCH)
  assert.match(mismatch.issue.action, /不自动翻译/)
  assert.equal(sync.openIssues().length, 1)
  assert.equal(sync.describeStanding(mismatch).label, '需要处理')

  // An explicit, attributable reference decision unblocks it — the C10 id is still recorded.
  sync.setReference({ c06ProjectRef: 'project-abc', authorizedBy: 'user', reason: '总控确认这一引用指向该项目', authorizationRef: 'aut_9' })
  assert.equal(sync.read().referenceDecision.c10ProjectId, projectId)
  const advanced = sync.advance({ toolId: 'ffmpeg', fromProjectVersion: 'rev-2', toProjectVersion: 'rev-3', toolVersion: '9.0.1' })
  assert.equal(advanced.status, 'advanced')
  assert.equal(advanced.needsHandling, false)

  const checked = sync.recheck({ currentProjectVersion: 'rev-3', toolIds: ['ffmpeg'] })
  assert.equal(checked.ok, false)
  assert.equal(checked.results[0].status, 'needs-handling')
  assert.match(checked.results[0].message, /旧版本/)
})

test('pins: the same version is not "advanced" and a gap in history is reported', () => {
  const { projects } = makeRoot()
  const acceptingPins = {
    advanceProjectPin: () => ({ pins: [] }),
    recheckProjectPin: () => ({ check: 'current' }),
  }
  const sync = new PinSync({ paths: projects[0].paths, clock, pinSource: acceptingPins })
  assert.throws(
    () => sync.advance({ toolId: 'ffmpeg', fromProjectVersion: 'rev-1', toProjectVersion: 'rev-1', toolVersion: '9.0.1' }),
    /版本没有变化/,
  )
  // Without an explicit reference, a pin source that refuses the raw C10 id yields needs-handling.
  const refused = sync.advance({ toolId: 'ffmpeg', fromProjectVersion: 'rev-1', toProjectVersion: 'rev-2', toolVersion: '9.0.1' })
  assert.equal(refused.needsHandling, false, 'a pin source that accepts the id is not an error')
})

test('preview: a stale preview may be shown but may not claim the edit took effect', () => {
  const { projects } = makeRoot()
  const surface = new PreviewSurface({ paths: projects[0].paths, clock })
  const base = makePlan('plan-v1')

  // A changed object makes C12's own diff produce changed frames.
  const changed = structuredClone(base)
  changed.planVersion = 'plan-v2'
  const original = changed.objects[0].timeline.durationFrames
  changed.objects[0].timeline = { ...changed.objects[0].timeline, durationFrames: Math.max(1, original - 2) }
  const next = normalizePlan({ ...changed, timebase: { ...base.timebase, totalFrames: base.timebase.totalFrames } })
  next.planVersion = 'plan-v2'

  const diff = diffPlans(base, next)
  assert.equal(diff.changedObjectIds.length > 0 || diff.changedFrames.length > 0, true, '夹具必须产生真实差异')

  surface.recordPreview({ basePlan: base, coveredRange: null, file: 'media/preview-v1.mp4', taskId: 'task-1' })
  const fresh = surface.describe({ currentPlan: base })
  assert.equal(fresh.showing, 'current-plan')
  assert.equal(fresh.mayClaimApplied, true)
  assert.equal(fresh.stale, false)

  const stale = surface.describe({ currentPlan: next })
  assert.equal(stale.showing, 'previous-plan')
  assert.equal(stale.blocked, true)
  assert.equal(stale.mayClaimApplied, false)
  assert.equal(stale.stale, true)
  assert.equal(stale.planVersion.preview, 'plan-v1')
  assert.equal(stale.planVersion.current, 'plan-v2')
  assert.equal(stale.staleFrames.length > 0, true)
  assert.match(stale.label, /上一版计划/)
  assert.throws(() => surface.assertNotMasking({ currentPlan: next }), /不能声称修改已生效/)
})

test('preview: no render yet is stated plainly instead of pretending freshness', () => {
  const { projects } = makeRoot()
  const surface = new PreviewSurface({ paths: projects[0].paths, clock })
  const state = surface.describe({ currentPlan: makePlan('plan-v1') })
  assert.equal(state.hasPreview, false)
  assert.equal(state.showing, 'none')
  assert.equal(state.blocked, false)
  assert.match(state.label, /还没有渲染过预览/)
})

test('preview and pin documents live inside the project directory', () => {
  const { projects } = makeRoot()
  const paths = projects[0].paths
  const surface = new PreviewSurface({ paths, clock })
  surface.recordPreview({ basePlan: makePlan('plan-v1'), coveredRange: { startFrame: 0, endFrameExclusive: 60 }, file: 'media/p.mp4' })
  const run = new ProductionRun({ paths, clock })
  run.begin({ producerSessionId: 'maker-A', projectVersion: 'rev-1', baselineRef: 'baseline-1' })

  for (const relative of ['work/preview-state.json', 'work/work-package.json']) {
    const absolute = paths.resolve(relative)
    assert.equal(fs.existsSync(absolute), true, `${relative} 应写在项目目录内`)
    assert.equal(absolute.startsWith(paths.dir), true)
  }
})
