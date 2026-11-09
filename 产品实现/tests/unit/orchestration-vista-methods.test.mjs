/**
 * Unit tests for the VISTA execution ledger, the method layer and the craft layer.
 *
 * The pattern these tests enforce is "executed or honestly not executed": each mechanism has a
 * record that only exists when something really happened, and a summary that refuses to call a plan
 * an execution. Method and craft tests assert refusals — a pack without a fault handbook, a reference
 * route without analysis, a detail round before the overall problem is solved, a term swap by the AI,
 * or a craft recipe that is only a colour change.
 *
 * @module tests/unit/orchestration-vista-methods.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'
import { fontFile } from '../../media/tests/helpers.mjs'
import {
  InspectionKind,
  MechanismState,
  RecoveryCause,
  VistaLedger,
  VistaMechanism,
} from '../../orchestration/vista.js'
import { ConvergenceStage, GapPriority, MethodLibrary } from '../../orchestration/methods.js'
import { CraftAspect, CraftBook, NarrativeSeamKind } from '../../orchestration/craft.js'

const temp = createTempDir({ label: 'orchestration-vista-methods' })
test.after(() => temp.dispose())

const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
let counter = 0

/** The four recovery checks a real continuation must confirm. */
const ALL_CHECKS = Object.freeze({ baseline: true, version: true, evidence: true, openWork: true })

/** @returns {any} */
function makePaths() {
  counter += 1
  const root = temp.dir(`root-${counter}`)
  const created = createProject({ projectsRoot: root, title: `证据 ${counter}`, clock })
  return new ProjectPaths(root, created.project.projectId)
}

/** A complete, honest VISTA record set produced by one maker. */
function fillVista(ledger) {
  ledger.recordObservation({
    producerSessionId: 'maker-A',
    model: 'vision-test',
    inputViews: ['关键帧 1920×1080', '整片代理'],
    evidenceRefs: ['evd:frame-1', 'evd:proxy'],
    observedScope: '整片代理＋2 个关键帧',
    issues: ['第 2 秒字体边缘发虚'],
  })
  ledger.registerIdentity({ evidenceRef: 'evd:src-1', role: 'source', sha256: 'a'.repeat(64) })
  ledger.registerIdentity({ evidenceRef: 'evd:proxy', role: 'derived', derivedFrom: 'evd:src-1', transform: 'scale 0.5' })
  ledger.requestInspection({
    producerSessionId: 'maker-A',
    question: '第 2 秒字幕右侧是否被裁切',
    kind: InspectionKind.REGION,
    evidenceRefs: ['evd:frame-1'],
    returnedScope: '原比例区域 1200×400',
  })
  const loop = ledger.openLoop({
    producerSessionId: 'maker-A',
    prediction: { target: '字幕安全区', scope: '第 2 秒', preserve: ['其余画面'], expectedChange: '字幕整体内收 24px' },
  })
  ledger.closeLoop({
    loopId: loop.loop.loopId,
    action: '只在字幕层内收 24px',
    observation: { observedChange: '字幕进入安全区', unexpected: [], unobserved: ['其他镜头未看'] },
    decision: { choice: '接受本次修复', by: 'ai', reason: '目标达成且未牵连其他对象' },
  })
  ledger.setMemory({ project: ['系列固定片头'], work: ['当前第 2 秒字幕'], recoveryRefs: ['evd:frame-1'] })
  ledger.recordRecovery({ producerSessionId: 'maker-A', cause: RecoveryCause.COMPACTION, checks: ALL_CHECKS })
  ledger.recordEfficiency({ producerSessionId: 'maker-A', strategy: ['overview-proxy', 'on-demand-original'], rounds: 3, metrics: { tokens: 1200 } })
  ledger.recordToolCall({ toolId: 'ffmpeg', toolVersion: '9.0.1', readOnly: false, permission: '渲染输出', result: '产出 270 帧', outcomeKnown: true })
  ledger.recordToolCall({ toolId: 'ffprobe', toolVersion: '9.0.1', readOnly: true, permission: '只读探测', result: '读到 25fps', outcomeKnown: true })
}

test('vista: everything starts not executed and nothing claims a benefit', () => {
  const ledger = new VistaLedger({ paths: makePaths(), clock })
  const gate = ledger.gate()
  assert.equal(gate.executed, 0)
  assert.equal(gate.ok, false)
  assert.equal(gate.gainProven, false)
  assert.equal(gate.mechanisms.length, 7)
  assert.deepEqual(
    gate.mechanisms.map((entry) => entry.mechanism).sort(),
    Object.values(VistaMechanism).sort(),
  )
})

test('vista: a full honest record set makes all seven mechanisms executed, still without gain', () => {
  const ledger = new VistaLedger({ paths: makePaths(), clock })
  fillVista(ledger)
  const gate = ledger.gate()
  assert.equal(gate.ok, true, JSON.stringify(gate.mechanisms.map((m) => [m.mechanism, m.state])))
  assert.equal(gate.executed, 7)
  assert.equal(gate.gainProven, false)
  assert.equal(gate.notes.some((note) => note.includes('不等于增益已证实')), true)
})

test('vista: an observation needs real input, and "did not look" is recorded as such', () => {
  const ledger = new VistaLedger({ paths: makePaths(), clock })
  assert.throws(
    () => ledger.recordObservation({ producerSessionId: 'x', model: 'm', inputViews: [], evidenceRefs: ['e'], observedScope: '整片' }),
    /真实观察必须记录/,
  )
  const none = ledger.recordUnobserved({ producerSessionId: 'x', reason: '宿主没有图像输入通道' })
  assert.equal(none.observation.actuallyObserved, false)
  const observation = ledger.gate().mechanisms.find((entry) => entry.mechanism === VistaMechanism.REAL_OBSERVATION)
  assert.equal(observation.state, MechanismState.NOT_EXECUTED)

  const ledger2 = new VistaLedger({ paths: makePaths(), clock })
  const observationInput = { model: 'm', inputViews: ['proxy'], evidenceRefs: ['e'], observedScope: '整片代理' }
  ledger2.recordObservation({ producerSessionId: 'x', ...observationInput })
  assert.throws(
    () => ledger2.recordObservation({ producerSessionId: 'y', ...observationInput }),
    /同一制作子 Agent/,
  )
})

test('vista: inspection is question-driven and refuses a vague request', () => {
  const ledger = new VistaLedger({ paths: makePaths(), clock })
  assert.throws(
    () =>
      ledger.requestInspection({
        producerSessionId: 'a',
        question: '看看',
        kind: InspectionKind.REGION,
        evidenceRefs: ['e'],
        returnedScope: '全片',
      }),
    /具体问题驱动/,
  )
  const ok = ledger.requestInspection({
    producerSessionId: 'a',
    question: '转场第 2 帧是否出现黑边',
    kind: InspectionKind.MULTI_FRAME,
    evidenceRefs: ['e'],
    returnedScope: '第 2 秒附近 5 帧',
  })
  assert.equal(ok.inspection.drivenByQuestion, true)
})

test('vista: a loop cannot close without a real observation and decision', () => {
  const ledger = new VistaLedger({ paths: makePaths(), clock })
  const loop = ledger.openLoop({
    producerSessionId: 'a',
    prediction: { target: '标题', scope: '开场', preserve: [], expectedChange: '更清晰' },
  })
  assert.throws(
    () => ledger.closeLoop({ loopId: loop.loop.loopId, observation: {}, decision: {} }),
    /observation.observedChange/,
  )
  const closed = ledger.closeLoop({
    loopId: loop.loop.loopId,
    observation: { observedChange: '标题更清晰', unexpected: ['背景亮度略升'], unobserved: [] },
    decision: { choice: '接受', by: 'ai', reason: '目标达成' },
  })
  assert.equal(closed.loop.state, 'closed')
  assert.equal(closed.loop.decision.isUserConfirmation, false)
  assert.throws(
    () =>
      ledger.closeLoop({
        loopId: loop.loop.loopId,
        observation: { observedChange: 'x' },
        decision: { choice: '接受', by: 'ai' },
      }),
    /已关闭/,
  )
})

test('vista: compression keeps evidence identity and recovery checks are honest', () => {
  const ledger = new VistaLedger({ paths: makePaths(), clock })
  ledger.setMemory({ project: ['固定设定'], work: ['一', '二'], recoveryRefs: ['evd:a', 'evd:b'] })
  const compressed = ledger.compressWorkMemory({ keep: ['二'], dropped: ['一'] })
  assert.equal(compressed.identityPreserved, true)
  assert.deepEqual(compressed.memory.recoveryRefs, ['evd:a', 'evd:b'])

  const bad = ledger.recordRecovery({
    producerSessionId: 'a',
    cause: RecoveryCause.SESSION_RESTART,
    checks: { ...ALL_CHECKS, version: false },
  })
  assert.equal(bad.recovery.ok, false)
  assert.deepEqual(bad.recovery.failedChecks, ['version'])

  const repeated = ledger.recordRecovery({
    producerSessionId: 'a',
    cause: RecoveryCause.COMPACTION,
    checks: { baseline: true, version: true, evidence: true, openWork: true },
    repeatedActions: ['重新渲染整片'],
  })
  assert.equal(repeated.recovery.ok, false, '重复外部动作的恢复不算通过')
})

test('vista: an unknown tool outcome is not retried, and the ledger records it', () => {
  const ledger = new VistaLedger({ paths: makePaths(), clock })
  const renderCall = { toolId: 'ffmpeg', toolVersion: '9.0.1', readOnly: false, permission: '渲染', dedupKey: 'render-1' }
  ledger.recordToolCall({ ...renderCall, result: '超时', outcomeKnown: false })
  assert.throws(
    () => ledger.recordToolCall({ ...renderCall, result: '重试', outcomeKnown: false }),
    /不允许重复调用/,
  )
  // A read-back with a known outcome is allowed and keeps the read-only/state-changing split.
  ledger.recordToolCall({
    toolId: 'ffprobe',
    toolVersion: '9.0.1',
    readOnly: true,
    permission: '只读',
    result: '文件其实已生成',
    outcomeKnown: true,
    dedupKey: 'render-1',
  })
  const governance = ledger.governance()
  assert.equal(governance.readOnlyCalls, 1)
  assert.equal(governance.stateChangingCalls, 1)
  assert.equal(governance.ok, true)
})

test('vista: efficiency records actual rounds and never claims a saving', () => {
  const ledger = new VistaLedger({ paths: makePaths(), clock })
  assert.throws(() => ledger.recordEfficiency({ producerSessionId: 'a', strategy: ['proxy'], rounds: 0 }), /轮数必须为正整数/)
  const record = ledger.recordEfficiency({ producerSessionId: 'a', strategy: ['proxy'], rounds: 2 })
  assert.equal(record.efficiency.claimedSaving, false)
  assert.equal(record.efficiency.tokens, null)
})

test('vista: a C16 baseline needs steps, questions and input views to be reproducible', () => {
  const ledger = new VistaLedger({ paths: makePaths(), clock })
  assert.throws(
    () => ledger.recordC16Baseline({ taskId: 't1', work: '任务', model: 'm', steps: [], questions: [], inputViews: [] }),
    /C16 基线/,
  )
  const baseline = ledger.recordC16Baseline({
    taskId: 't1',
    work: '水墨短片 12 秒',
    model: 'vision-test',
    steps: ['概览代理', '按问题取原图', '修改并复查'],
    questions: ['字幕是否被裁切'],
    inputViews: ['整片代理', '原比例区域'],
    budget: { rounds: 3, tokens: 2000, minutes: 20 },
  })
  assert.equal(baseline.baseline.reproducible, false, '可复现性由 C16 判定，不由 C13 自称')
  assert.equal(baseline.baseline.steps.length, 3)
})

test('methods: a pack is refused while any required section is empty', () => {
  const library = new MethodLibrary({ paths: makePaths(), clock })
  assert.throws(
    () => library.definePack({ methodId: 'mth-x', sections: { sourceAndSelfWritten: '自写', applicableTasks: ['短片'] } }),
    /方法包缺少必需段落/,
  )
  const pack = library.definePack({
    methodId: 'mth-ink',
    sections: {
      sourceAndSelfWritten: '自写：以浓淡分层代替网点',
      applicableTasks: ['水墨静态细节', '水墨动态位移'],
      userOutcome: '安静但有层次的画面',
      requiredInputs: ['主体参考', '纸张纹理'],
      productionSteps: ['铺底', '分层浓淡', '边缘压线'],
      fixedAndVariable: { fixed: ['纸纹'], variable: ['墨量'] },
      standards: ['边缘不出现硬色块'],
      commonFailures: ['墨色过饱和'],
      evidenceRequirements: ['原比例细节区域'],
      exitAndSwitch: '连续两次复查仍过饱和则改用干笔',
    },
  })
  assert.equal(pack.pack.selfWritten, true)
  assert.equal(pack.pack.isFormalEffectType, false)
  assert.throws(() => library.definePack({ methodId: 'mth-ink', sections: pack.pack }), /同版本方法包已存在/)
})

test('methods: a reference route is refused before a real analysis exists', () => {
  const library = new MethodLibrary({ paths: makePaths(), clock })
  library.definePack({
    methodId: 'mth-ink',
    sections: {
      sourceAndSelfWritten: '自写',
      applicableTasks: ['参考复刻'],
      userOutcome: '接近参考的整体结构',
      requiredInputs: ['参考片段'],
      productionSteps: ['整体构图', '中结构', '细节'],
      fixedAndVariable: { fixed: ['构图'], variable: ['细节笔触'] },
      standards: ['整体轮廓可对应'],
      commonFailures: ['细节先行'],
      evidenceRequirements: ['参考视图'],
      exitAndSwitch: '整体不符则重做',
    },
  })
  assert.throws(
    () =>
      library.selectRoute({
        task: '复刻开场',
        producerSessionId: 'maker-A',
        methods: [{ methodId: 'mth-ink' }],
        order: ['整体'],
        reasons: ['用户要求'],
        referenceScopeId: 'rfs_1',
      }),
    /必须先完成 ReferenceAnalysis/,
  )
  assert.throws(
    () =>
      library.analyzeReference({
        referenceScopeId: 'rfs_1',
        referenceRef: '参考片',
        composition: '居中',
        silhouette: '圆',
        mainStructure: [],
        contentContinuation: '延续',
        keyFeatures: [],
        evidenceRefs: ['evd:ref-1'],
      }),
    /整体结构与关键特征/,
  )
  library.analyzeReference({
    referenceScopeId: 'rfs_1',
    referenceRef: '参考片',
    composition: '居中偏左，留白在右',
    silhouette: '单一圆形主体',
    mainStructure: ['主体占画面 1/3', '背景两层次'],
    contentContinuation: '主体从右入画',
    keyFeatures: ['边缘有纸纹'],
    evidenceRefs: ['evd:ref-1'],
  })
  const route = library.selectRoute({
    task: '复刻开场',
    producerSessionId: 'maker-A',
    methods: [{ methodId: 'mth-ink' }],
    order: ['整体构图', '中结构'],
    reasons: ['用户指定参考'],
    referenceScopeId: 'rfs_1',
    recipeVersion: 'recipe-1',
  })
  assert.equal(route.route.referenceScopeId, 'rfs_1')
  // A second route for the same task with the same recipe version demands a baseline re-check.
  const second = library.selectRoute({
    task: '复刻开场',
    producerSessionId: 'maker-A',
    methods: [{ methodId: 'mth-ink' }],
    order: ['整体构图'],
    reasons: ['换方法顺序'],
    recipeVersion: 'recipe-1',
  })
  assert.equal(second.route.baselineRecheckRequired, true)
})

test('methods: a fault entry needs all six parts and re-observation', () => {
  const library = new MethodLibrary({ paths: makePaths(), clock })
  assert.throws(
    () => library.addFaultEntry({ methodId: 'mth-ink', entry: { symptom: '文字被裁切' } }),
    /故障手册条目缺少必需字段/,
  )
  const entry = library.addFaultEntry({
    methodId: 'mth-ink',
    entry: {
      symptom: '字幕右侧被裁切',
      possibleCauses: ['安全区计算用了旧画幅'],
      minimalVerification: '原比例区域取第 2 秒右边缘',
      preferredFix: '按目标画幅重算安全区',
      protectedScope: '其余对象位置不变',
      reobserveEvidence: ['原比例右边缘区域'],
    },
  })
  assert.equal(entry.entry.reobservedAt, null, '修复未复查前不算已解决')
  assert.throws(() => library.markReobserved({ entryId: entry.entry.entryId, evidenceRefs: [] }), /真实证据/)
  const reobserved = library.markReobserved({ entryId: entry.entry.entryId, evidenceRefs: ['evd:after-1'] })
  assert.equal(typeof reobserved.entry.reobservedAt, 'string')
})

test('methods: convergence fixes overall before detail and hands remaining gaps to the user', () => {
  const library = new MethodLibrary({ paths: makePaths(), clock })
  const opened = library.openConvergence({
    targetAndPreserve: { target: '参考整体构图', preserve: ['主体身份'] },
    stages: [
      { stage: ConvergenceStage.DETAIL, requiredEvidence: ['detail-region'] },
      { stage: ConvergenceStage.OVERALL, requiredEvidence: ['full-frame'] },
      { stage: ConvergenceStage.MID, requiredEvidence: ['mid-frame'] },
    ],
    bounds: { maxRounds: 2 },
  })
  assert.deepEqual(opened.convergence.stages.map((entry) => entry.stage), ['overall', 'mid-structure', 'detail'])
  const first = library.recordRound({
    convergenceId: opened.convergence.convergenceId,
    stage: ConvergenceStage.OVERALL,
    gaps: [{ description: '主体偏右过多', impact: 1, priority: GapPriority.BLOCKING }],
    limitedFix: '整体重取景',
    reobserved: false,
  })
  assert.equal(first.exhausted, false)
  assert.throws(
    () =>
      library.recordRound({
        convergenceId: opened.convergence.convergenceId,
        stage: ConvergenceStage.DETAIL,
        gaps: [],
        limitedFix: '细节修边',
      }),
    /整体问题未解决/,
  )
  const second = library.recordRound({
    convergenceId: opened.convergence.convergenceId,
    stage: ConvergenceStage.OVERALL,
    gaps: [{ description: '主体位置已接近', impact: 2, priority: GapPriority.MINOR }],
    limitedFix: '整体微调',
    reobserved: true,
  })
  assert.equal(second.exhausted, true)
  const verdict = library.convergenceVerdict(opened.convergence.convergenceId)
  assert.equal(verdict.converged, true, '整体阻塞差距已清除且复查过')
  assert.throws(
    () =>
      library.recordRound({
        convergenceId: opened.convergence.convergenceId,
        stage: ConvergenceStage.MID,
        gaps: [],
        limitedFix: '再修',
      }),
    /轮数上限/,
  )
})

test('methods: unconverged rounds are reported with the remaining gaps', () => {
  const library = new MethodLibrary({ paths: makePaths(), clock })
  const opened = library.openConvergence({
    targetAndPreserve: { target: '目标', preserve: [] },
    stages: [{ stage: ConvergenceStage.OVERALL, requiredEvidence: ['full-frame'] }],
    bounds: { maxRounds: 1 },
  })
  library.recordRound({
    convergenceId: opened.convergence.convergenceId,
    stage: ConvergenceStage.OVERALL,
    gaps: [{ description: '轮廓仍不符', impact: 1, priority: GapPriority.BLOCKING }],
    limitedFix: '整体重画',
    reobserved: false,
  })
  const verdict = library.convergenceVerdict(opened.convergence.convergenceId)
  assert.equal(verdict.converged, false)
  assert.equal(verdict.userDecisionRequired, true)
  assert.equal(verdict.remainingGaps.length, 1)
  assert.match(verdict.note, /未收敛/)
})

test('craft: a term binds to object, scope and version, and the AI cannot swap it', () => {
  const book = new CraftBook({ paths: makePaths(), clock })
  const terms = book.availableTerms()
  assert.equal(terms.length > 0, true)
  const term = terms[0]

  assert.throws(
    () => book.selectMotionTerm({ term: 'not-a-term', objectId: 'obj-1', scope: '开场', planVersion: 'v1', motionSpec: { term: 'not-a-term' } }),
    /未知运动术语/,
  )
  const selected = book.selectMotionTerm({
    term: term.id,
    objectId: 'obj-1',
    scope: '开场 0–24 帧',
    planVersion: 'v1',
    motionSpec: { objectId: 'obj-1', term: term.id, enter: { durationFrames: 12 }, hold: { durationFrames: 6 } },
  })
  assert.equal(selected.selection.lockedAgainstAiChange, true)
  assert.equal(selected.recipeFragment.term, term.id)

  const other = terms.find((entry) => entry.id !== term.id)
  assert.throws(
    () => book.selectMotionTerm({ term: other.id, objectId: 'obj-1', scope: '开场 0–24 帧', planVersion: 'v1', motionSpec: { term: other.id } }),
    /不能擅自更换/,
  )
})

test('craft: a recipe that is only a colour change is refused', () => {
  const book = new CraftBook({ paths: makePaths(), clock })
  assert.throws(
    () => book.recordCraftRecipe({ subject: '山', aspects: { [CraftAspect.MEDIUM]: '墨', color: '朱红' } }),
    /至少需要四项真实工艺差异/,
  )
  const recipe = book.recordCraftRecipe({
    subject: '山',
    aspects: {
      [CraftAspect.MEDIUM]: '生宣＋松烟墨',
      [CraftAspect.STROKE]: '中锋为主，侧锋压边',
      [CraftAspect.DRAW_ORDER]: '先远山后近树',
      [CraftAspect.TEXTURE]: '纸纹保留',
      [CraftAspect.SUBJECT_IDENTITY]: '山形按参考轮廓',
    },
    subjectMap: { parts: ['山脊', '树'], viewpoints: ['平视'], referenceId: 'evd:ref-1', beforeAfter: '浓淡反转' },
  })
  assert.equal(recipe.recipe.notJustPalette, true)
  assert.equal(Object.keys(recipe.recipe.aspects).length >= 4, true)
})

test('craft: a seam carries applicability and a work may declare none', () => {
  const book = new CraftBook({ paths: makePaths(), clock })
  assert.throws(
    () => book.recordSeam({ kind: NarrativeSeamKind.CONTINUOUS_SPACE, appliesWhen: '', disabledWhen: '' }),
    /appliesWhen/,
  )
  const seam = book.recordSeam({
    kind: NarrativeSeamKind.CONTINUOUS_SPACE,
    appliesWhen: '镜头在同一空间连续移动',
    disabledWhen: '作品为抽象构成，没有空间连续',
    carriedObject: '主体',
  })
  assert.equal(seam.seam.forced, false)
  const none = book.declareNoSeam({ reason: '本片为抽象色块，刻意不使用叙事承接' })
  assert.equal(none.declaration.declared, 'none')
  const policy = book.describeMotionPolicy({ stillByDesign: true, silentByDesign: true })
  assert.equal(policy.universalMotionRule, false)
  assert.equal(policy.requirements.length, 2)
})

test('craft: a freeze uses TimeRemapSpec and the audio protection is really checked', () => {
  const paths = makePaths()
  const plan = normalizePlan(buildC12UnitPlan({ fontFile: fontFile() }))
  const book = new CraftBook({ paths, clock })
  const recorded = book.recordTimeRemap({
    id: 'remap-1',
    mode: 'hold',
    speedKeys: [{ atSceneFrame: 0, speed: 0 }],
    sceneFrames: 48,
    deliberateHold: true,
    plan,
    evidenceRefs: ['evd:freeze-1'],
  })
  assert.equal(recorded.remap.deliberateHold, true)
  assert.equal(recorded.remap.verifiedAgainstPlan, true)
  assert.equal(recorded.remap.audioKeepsMovieTime, true)
})
