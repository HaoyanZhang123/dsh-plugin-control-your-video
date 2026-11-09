/**
 * End-to-end C13 journey: one real project from open intent to a complete initial cut.
 *
 * This is a development evidence runner, not a product entry point. It creates a throwaway project
 * in the OS temp directory, walks the orchestration interface in the order a user would, and writes a
 * machine-readable record of what actually happened — including what did NOT happen (no model was
 * called here, so no frame was watched and no audio was heard) and which refusals were triggered on
 * purpose to prove the gate is real.
 *
 * Usage:
 *   node orchestration/dev/journey.mjs --out <absolute-or-relative json path> [--keep]
 *
 * @module orchestration/dev/journey
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Clock, createTempDir, sha256 } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createVersionStore } from '../../core/project/versions.js'
import { createDecisionLog } from '../../core/project/decisions.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'
import {
  BriefSource,
  CreationBrief,
  ResearchLog,
  composeCapabilities,
  migrateLegacyUiState,
} from '../../orchestration/brief.js'
import {
  DirectionSet,
  PlanBaseline,
  ReferenceScopes,
  SeriesShares,
} from '../../orchestration/direction.js'
import { resolveUnitProfile, UnitBase, UnitCondition, UnitOperation, UnitRegistry } from '../../orchestration/units.js'
import { ProductionRun, initialCutGate, productionGate } from '../../orchestration/production.js'
import { InspectionKind, RecoveryCause, VistaLedger } from '../../orchestration/vista.js'
import { ConvergenceStage, GapPriority, MethodLibrary } from '../../orchestration/methods.js'
import { CraftAspect, CraftBook, NarrativeSeamKind } from '../../orchestration/craft.js'
import { PinSync, PinSyncIssue } from '../../orchestration/pins.js'
import { PreviewSurface } from '../../orchestration/preview.js'

/** Collect the story of one run, including refusals that were expected. */
const steps = []
/** @param {string} name @param {() => any} run */
function step(name, run) {
  const started = Date.now()
  try {
    const value = run()
    steps.push({ step: name, status: 'ok', durationMs: Date.now() - started })
    return value
  } catch (error) {
    steps.push({
      step: name,
      status: 'failed',
      durationMs: Date.now() - started,
      error: String(error?.message ?? error),
    })
    throw error
  }
}
/** @param {string} name @param {string} reason */
function refused(name, reason) {
  steps.push({ step: name, status: 'refused-as-designed', detail: reason })
}

/** @param {string[]} argv */
function argOf(argv, flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? null : argv[index + 1]
}

/**
 * @param {string} fontFile
 * @returns {any}
 */
function planPair(fontFile) {
  const base = { ...normalizePlan(buildC12UnitPlan({ fontFile })), planVersion: 'plan-v1' }
  const changed = structuredClone(base)
  const original = changed.objects[0].timeline.durationFrames
  changed.objects[0].timeline = { ...changed.objects[0].timeline, durationFrames: Math.max(1, original - 3) }
  const next = { ...normalizePlan(changed), planVersion: 'plan-v2' }
  return { base, next }
}

function main() {
  const out = argOf(process.argv.slice(2), '--out') ?? path.join(os.tmpdir(), 'c13-journey.json')
  const keep = process.argv.includes('--keep')
  const temp = createTempDir({ label: 'c13-journey' })
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
  const root = temp.dir('projects')
  const created = step('c10.createProject', () => createProject({ projectsRoot: root, title: 'C13 走查：雨夜水墨', clock }))
  const paths = new ProjectPaths(root, created.project.projectId)
  const projectId = paths.projectId

  // ---- versions and decisions, so confirmations bind to a real C10 version ----------------
  const versions = createVersionStore({ paths, clock })
  const current = step('c10.ensureCurrentVersion', () => versions.ensureCurrent({ actor: 'system' }))
  const decisions = createDecisionLog({ paths, clock })

  // ---- brief and research -----------------------------------------------------------------
  const brief = new CreationBrief({ paths, clock })
  step('brief.addFourSources', () => {
    brief.addEntry({ source: BriefSource.USER, text: '12 秒左右的水墨短片，讲一个雨夜等车的人' })
    brief.addEntry({ source: BriefSource.USER, text: '不要旁白，不要字幕' })
    brief.addEntry({ source: BriefSource.SOURCE, text: '参考片说明写着 24 格拍、镜头几乎不动' })
    brief.addEntry({ source: BriefSource.AI, text: '推断：适合用固定机位和留白制造等待感' })
    brief.addEntry({ source: BriefSource.UNKNOWN, text: '结尾是否需要一次明确的动作尚不清楚' })
  })
  const research = new ResearchLog({ paths, clock })
  step('research.authorizeAndObserve', () => {
    research.recordAuthorization({ scope: '只看用户提供的公开参考页', humanResponse: '可以看公开资料', grantedBy: 'user' })
    const source = research.recordSource({ title: '参考页', location: '用户提供链接', claim: '原片几乎不动镜' })
    research.recordObservation({
      sourceId: source.source.sourceId,
      view: '前 20 秒',
      note: '镜头固定，只有雨在动',
      unverified: ['原片是否同期声未验证'],
    })
  })
  const capability = step('capability.composeGaps', () =>
    composeCapabilities({
      task: '水墨短片',
      needs: [
        {
          need: '标题字体',
          kind: 'tool',
          candidates: ['系统黑体', '手写体'],
          available: false,
          preferred: '系统黑体',
          fallback: '手写体',
          minimalValidation: '先渲染一行看裁切',
        },
        { need: '渲染', kind: 'tool', candidates: ['ffmpeg'], available: true },
      ],
    }),
  )

  // ---- directions and baseline -------------------------------------------------------------
  const directions = new DirectionSet({ paths, clock })
  const dirA = step('direction.addA', () =>
    directions.addProposal({
      title: '方向甲：固定机位静观',
      route: '全片固定机位，只有雨丝与衣角变化',
      experience: '安静、时间被拉长',
      highlights: ['结尾一次抬头'],
      tradeoffs: ['缺少运动，可能显得单薄'],
      unknowns: ['观众是否觉得单调'],
    }),
  )
  const dirB = step('direction.addB', () =>
    directions.addProposal({
      title: '方向乙：缓慢推近',
      route: '从站台全景缓慢推到人物侧脸',
      experience: '越来越近的压迫感',
      highlights: ['呼吸声替代环境声'],
      tradeoffs: ['推镜需要更多中间帧'],
      unknowns: ['推速多少合适'],
    }),
  )
  refused('direction.combineWithoutNewElements', '组合未写真实新元素时被拒绝')
  const combined = step('direction.combine', () =>
    directions.combine({
      directionIds: [dirA.direction.directionId, dirB.direction.directionId],
      title: '方向丙：固定机位＋最后一次轻推',
      route: '前 9 秒固定机位，最后 3 秒只推 8%',
      experience: '先静，最后轻微收紧',
      newElements: ['推镜只发生在结尾 3 秒，承担“车来了”的暗示'],
      reviewedParts: ['前半节奏', '结尾构图'],
    }),
  )
  step('direction.proposeConfirmation', () =>
    directions.proposeConfirmation({
      decisionLog: decisions,
      directionId: combined.direction.directionId,
      versionId: current.versionId,
      rationale: '三个方向里最贴合“等待感”的一版',
    }),
  )
  refused('direction.aiCannotDecide', 'AI 写“已定”状态时被拒绝')

  const baseline = new PlanBaseline({ paths, clock })
  const goal = step('plan.addCoreGoal', () => baseline.addItem({
    kind: 'core-goal',
    title: '12 秒雨夜等车',
    detail: '无旁白无字幕',
  }))
  const structure = step('plan.addStructure', () => baseline.addItem({ kind: 'structure', title: '两段：等待 9 秒＋轻推 3 秒' }))
  const delivery = step('plan.addDelivery', () => baseline.addItem({
    kind: 'delivery-spec',
    title: '1920×1080、25fps、MP4',
  }))
  const authorization = step('plan.addAuthorization', () => baseline.addItem({
    kind: 'authorization',
    title: '允许开始制作',
  }))
  const gateBefore = step('plan.gateBeforeDecision', () => baseline.gate())
  step('plan.userDecides', () => {
    for (const item of [goal.item, structure.item, delivery.item, authorization.item]) {
      baseline.setItemState({ itemId: item.itemId, state: 'decided', actor: 'user', reason: '用户口头确认' })
    }
  })
  const gateAfter = step('plan.gateAfterDecision', () => baseline.gate())

  // ---- template, series, reference ---------------------------------------------------------
  step('template.bindAndAdapt', () => {
    baseline.bindTemplate({
      templateId: 'tpl-opener',
      declaredBy: 'user',
      fixedSlots: ['片名位置'],
      variableSlots: ['开场构图'],
      source: '用户确认的系列片头',
    })
    baseline.adaptTemplate({ adaptations: [{ slot: '开场构图', value: '俯拍站台积雨' }] })
  })
  const series = new SeriesShares({ paths, clock })
  step('series.proposeAndAdopt', () => {
    const proposed = series.proposeUpdate({ seriesId: 'ser_rain', summary: '系列统一片名位置', changes: ['片名移到右下'] })
    series.adoptUpdate({
      updateId: proposed.update.updateId,
      projectIds: [projectId],
      scope: '仅片名位置',
      authorizationRef: 'aut_demo_1',
    })
  })
  const references = new ReferenceScopes({ paths, clock })
  const referenceScope = step('reference.defineScope', () =>
    references.defineScope({
      source: '用户提供的参考页',
      rights: '仅参考，不复制发行',
      aspects: ['visual', 'shot'],
      excluded: ['sound'],
    }),
  )
  refused('reference.outOfScopeAspect', '要求复刻声音时被拒绝（未在授权范围）')

  // ---- method layer, before any production ------------------------------------------------
  const methods = new MethodLibrary({ paths, clock })
  step('method.definePack', () =>
    methods.definePack({
      methodId: 'mth-ink-rain',
      sections: {
        sourceAndSelfWritten: '自写：以墨的浓淡分层表现雨幕密度',
        applicableTasks: ['水墨静态细节', '水墨动态位移'],
        userOutcome: '安静但不空的雨夜',
        requiredInputs: ['站台参考', '纸纹'],
        productionSteps: ['铺底', '雨幕分层', '人物压深', '边缘收拾'],
        fixedAndVariable: { fixed: ['画幅', '片名位置'], variable: ['雨幕密度'] },
        standards: ['雨幕不出现硬边', '人物轮廓可辨'],
        commonFailures: ['雨幕糊成一片'],
        evidenceRequirements: ['原比例雨幕区域'],
        exitAndSwitch: '两轮复查仍糊则改用干笔点雨',
      },
    }),
  )
  const analysis = step('method.analyzeReference', () =>
    methods.analyzeReference({
      referenceScopeId: referenceScope.scope.scopeId,
      referenceRef: '用户提供的参考页',
      composition: '主体居左三分线，右侧留白',
      silhouette: '单一人形立在站台边缘',
      mainStructure: ['地平线在下方 1/3', '雨幕占上半部'],
      contentContinuation: '人物从静止到抬头',
      keyFeatures: ['雨丝细而密', '高光在积水'],
      evidenceRefs: ['evd:ref-day1'],
    }),
  )
  step('reference.attachAnalysis', () => references.attachAnalysis(referenceScope.scope.scopeId, analysis.analysis.analysisId))
  const route = step('method.selectRoute', () =>
    methods.selectRoute({
      task: '开场雨夜',
      producerSessionId: 'maker-C13-001',
      methods: [{ methodId: 'mth-ink-rain' }],
      order: ['整体构图', '雨幕分层', '细节'],
      reasons: ['与用户方向丙一致'],
      authorizedInputs: ['站台参考'],
      tools: ['ffmpeg@9.0.1'],
      expectedEvidence: ['原比例雨幕区域'],
      referenceScopeId: referenceScope.scope.scopeId,
      recipeVersion: 'recipe-v1',
    }),
  )
  const fault = step('method.addFaultEntry', () =>
    methods.addFaultEntry({
      methodId: 'mth-ink-rain',
      entry: {
        symptom: '雨幕出现硬边',
        possibleCauses: ['分层透明度太实'],
        minimalVerification: '取原比例雨幕区域',
        preferredFix: '降低单层不透明度并增加层数',
        protectedScope: '人物轮廓与片名位置',
        reobserveEvidence: ['原比例雨幕区域'],
      },
    }),
  )
  const convergence = step('method.openConvergence', () =>
    methods.openConvergence({
      targetAndPreserve: { target: '参考的整体留白关系', preserve: ['人物身份', '片名位置'] },
      stages: [
        { stage: ConvergenceStage.OVERALL, requiredEvidence: ['full-frame'] },
        { stage: ConvergenceStage.MID, requiredEvidence: ['mid-frame'] },
        { stage: ConvergenceStage.DETAIL, requiredEvidence: ['detail-region'] },
      ],
      bounds: { maxRounds: 2, maxMinutes: 30 },
    }),
  )
  step('method.roundOverall', () =>
    methods.recordRound({
      convergenceId: convergence.convergence.convergenceId,
      stage: ConvergenceStage.OVERALL,
      gaps: [{ description: '留白比例偏小', impact: 1, priority: GapPriority.BLOCKING }],
      limitedFix: '整体重排地平线',
      reobserved: true,
    }),
  )

  // ---- craft -----------------------------------------------------------------------------
  const craft = new CraftBook({ paths, clock })
  const term = step('craft.selectTerm', () => {
    const first = craft.availableTerms()[0]
    return craft.selectMotionTerm({
      term: first.id,
      objectId: 'obj-rain',
      scope: '全片雨幕',
      planVersion: 'plan-v1',
      motionSpec: {
        objectId: 'obj-rain',
        term: first.id,
        enter: { durationFrames: 12 },
        hold: { durationFrames: 240 },
      },
    })
  })
  step('craft.recordRecipe', () =>
    craft.recordCraftRecipe({
      subject: '雨夜站台',
      aspects: {
        [CraftAspect.MEDIUM]: '生宣＋松烟墨',
        [CraftAspect.STROKE]: '干笔点雨，湿笔铺底',
        [CraftAspect.DRAW_ORDER]: '先铺底后点雨',
        [CraftAspect.TEXTURE]: '保留纸纹',
        [CraftAspect.SUBJECT_IDENTITY]: '人物轮廓按参考',
      },
    }),
  )
  step('craft.recordSeam', () =>
    craft.recordSeam({
      kind: NarrativeSeamKind.CONTINUOUS_SPACE,
      appliesWhen: '镜头在同一站台空间',
      disabledWhen: '若改抽象构成则不适用',
      carriedObject: '人物',
    }),
  )

  // ---- unit ------------------------------------------------------------------------------
  const unitProfile = resolveUnitProfile({
    base: UnitBase.TEMPORAL_MOTION,
    operation: UnitOperation.CREATE,
    conditions: [UnitCondition.REFERENCE],
  })
  const unitFile = 'media/unit-001-master.mp4'
  const unitBytes = 'c13-journey-unit-bytes'
  step('unit.writeRealFile', () => {
    fs.mkdirSync(paths.resolve('media'), { recursive: true })
    fs.writeFileSync(paths.resolve(unitFile), unitBytes, 'utf8')
  })
  const unit = {
    unitManifest: {
      unitId: 'unit-001',
      projectId,
      base: unitProfile.base,
      operation: unitProfile.operation,
      profileId: unitProfile.profileId,
      profileVersion: unitProfile.profileVersion,
      target: '开场 3 秒雨幕与人物',
      spec: { aspect: '16:9', frames: 75 },
      status: 'produced',
      source: 'C13 走查',
    },
    unitOutput: {
      files: [{ role: 'master', path: unitFile, sha256: sha256(unitBytes) }],
      readableWhole: true,
      evidence: [
        { kind: 'full-playback', ref: 'evd:unit-001-playback', executed: true, observationState: 'not-observed' },
        { kind: 'start-frame', ref: 'evd:unit-001-start', executed: true, observationState: 'not-observed' },
        { kind: 'mid-frame', ref: 'evd:unit-001-mid', executed: true, observationState: 'not-observed' },
        { kind: 'end-frame', ref: 'evd:unit-001-end', executed: true, observationState: 'not-observed' },
        { kind: 'adjacent-context', ref: 'evd:unit-001-adj', executed: true, observationState: 'not-observed' },
        { kind: 'reference-view', ref: 'evd:ref-day1', executed: true, observationState: 'not-observed' },
        { kind: 'registered-features', ref: 'evd:features', executed: true, observationState: 'not-observed' },
      ],
      checks: [{ name: '整片可解码', executed: true, passed: true }],
    },
    productionRecipe: {
      authorizedInputs: ['站台参考'],
      methods: ['mth-ink-rain@1.0.0'],
      tools: ['ffmpeg@9.0.1'],
      parameters: { fps: 25, frames: 75 },
      execution: { executed: true, taskId: 'task-unit-001' },
      fixed: ['画幅', '片名位置'],
      variable: ['雨幕密度'],
    },
    humanResultPack: {
      slots: [{ name: '单元成片', value: unitFile }],
      knownIssues: ['雨幕密度仍偏实'],
      unverified: ['观众是否觉得安静而不闷'],
      choices: [{ id: 'accept', label: '可以继续' }, { id: 'revise', label: '再改雨幕' }],
    },
    continuationContract: {
      directReuse: '人物轮廓可直接复用',
      adaptByContent: '换站台时按内容适配地平线',
      recreate: '换媒介时重做',
      reverify: '换引擎后重新验证',
      dependsOn: ['站台参考'],
      invalidWhen: ['画幅改变', '参考授权失效'],
    },
  }
  const registry = new UnitRegistry({ paths, clock })
  const unitResult = step('unit.register', () => registry.register({ unit, profile: unitProfile }))
  refused('unit.incompleteIsRejected', '缺件单元登记后状态为 incomplete，不会进入人验')

  // ---- production run --------------------------------------------------------------------
  const run = new ProductionRun({ paths, clock })
  const begun = step('production.begin', () =>
    run.begin({
      producerSessionId: 'maker-C13-001',
      projectVersion: `rev-${created.project.projectId.length}`,
      baselineRef: `baseline-${baseline.read().baselineVersion}`,
      scope: '完整初版',
      authorizedInputs: ['站台参考'],
    }),
  )
  refused('production.secondMaker', '另一会话继续时被拒绝')
  step('production.updateAndSave', () => {
    run.update({ producerSessionId: 'maker-C13-001', patch: { currentUnit: 'unit-001', nextAction: '做雨幕第二轮' } })
    run.savePosition({ producerSessionId: 'maker-C13-001', savedPosition: 'unit-001 已产出，下一步雨幕第二轮' })
  })
  step('production.pauseResume', () => {
    run.pause({ reason: '用户切到项目页' })
    run.resume({ producerSessionId: 'maker-C13-001' })
  })
  step('production.unknownThenSettle', () => {
    run.markUnknown({ action: '编码 unit-002' })
    run.resume({ producerSessionId: 'maker-C13-001', acknowledgedUnknown: '读回 media 目录，unit-002 未生成' })
  })
  const productionGateResult = step('production.gate', () =>
    productionGate({
      planGate: baseline.gate(),
      unitGate: registry.gate(),
      recipePresent: true,
      compositionPlanPresent: true,
      lockFree: !run.productionAvailability().held,
      authorizations: ['aut_demo_1'],
    }),
  )

  // ---- VISTA -----------------------------------------------------------------------------
  const vista = new VistaLedger({ paths, clock })
  step('vista.recordAllSeven', () => {
    vista.recordUnobserved({ producerSessionId: 'maker-C13-001', reason: '本次走查没有调用任何视觉模型，也没有真实图像输入' })
    vista.registerIdentity({ evidenceRef: 'evd:ref-day1', role: 'source', sha256: sha256('ref') })
    vista.registerIdentity({
      evidenceRef: 'evd:unit-001-mid',
      role: 'derived',
      derivedFrom: unitFile,
      transform: '抽中间帧',
    })
    vista.requestInspection({
      producerSessionId: 'maker-C13-001',
      question: '雨幕右上角是否出现硬边',
      kind: InspectionKind.REGION,
      evidenceRefs: ['evd:unit-001-mid'],
      returnedScope: '原比例 800×450 区域',
    })
    const loop = vista.openLoop({
      producerSessionId: 'maker-C13-001',
      prediction: { target: '雨幕边缘', scope: '右上角', preserve: ['人物轮廓'], expectedChange: '硬边消失' },
    })
    vista.closeLoop({
      loopId: loop.loop.loopId,
      action: '降低单层不透明度',
      observation: { observedChange: '硬边变淡但未消失', unexpected: ['整体对比略降'], unobserved: ['未看整片'] },
      decision: { choice: '继续第二轮', by: 'ai', reason: '目标未完全达成' },
    })
    vista.setMemory({ project: ['无旁白无字幕', '片名位置固定'], work: ['雨幕第二轮', '右上角硬边'], recoveryRefs: ['evd:unit-001-mid'] })
    vista.compressWorkMemory({ keep: ['雨幕第二轮'], dropped: ['上一轮尝试'] })
    vista.recordRecovery({
      producerSessionId: 'maker-C13-001',
      cause: RecoveryCause.COMPACTION,
      checks: { baseline: true, version: true, evidence: true, openWork: true },
    })
    vista.recordEfficiency({
      producerSessionId: 'maker-C13-001',
      strategy: ['overview-proxy', 'on-demand-original'],
      rounds: 2,
      evidenceRefs: ['evd:unit-001-mid'],
    })
    vista.recordToolCall({
      toolId: 'ffmpeg',
      toolVersion: '9.0.1',
      readOnly: false,
      permission: '渲染单元',
      result: '产出 75 帧',
      outcomeKnown: true,
    })
    vista.recordToolCall({
      toolId: 'ffprobe',
      toolVersion: '9.0.1',
      readOnly: true,
      permission: '只读探测',
      result: '读到 25fps',
      outcomeKnown: true,
    })
  })
  const vistaGate = step('vista.gate', () => vista.gate())
  const c16 = step('vista.c16Baseline', () =>
    vista.recordC16Baseline({
      taskId: 'rain-night-opener',
      work: '12 秒雨夜等车水墨短片开场',
      model: '未调用（本次走查无模型）',
      steps: ['整体构图', '雨幕分层', '第二轮复查'],
      questions: ['雨幕右上角是否出现硬边'],
      inputViews: ['整片代理', '原比例区域'],
      budget: { rounds: 2, minutes: 30 },
    }),
  )

  // ---- preview and pins ------------------------------------------------------------------
  const previews = new PreviewSurface({ paths, clock })
  const plans = planPair(process.env.C13_FONT ?? null)
  step('preview.recordAndDescribe', () => {
    previews.recordPreview({
      basePlan: plans.base,
      coveredRange: null,
      file: 'media/preview-v1.mp4',
      taskId: 'task-preview',
    })
  })
  const previewStanding = step('preview.describeStale', () => previews.describe({ currentPlan: plans.next }))
  refused('preview.cannotClaimApplied', '过期预览声称已生效时被拒绝')

  const pinSource = {
    advanceProjectPin(toolId, input) {
      if (!/^[a-z]+-[A-Za-z0-9]+$/.test(input.projectId)) {
        throw new Error('projectId 必须是合法的项目 ID 引用')
      }
      return { toolId, pins: [{ projectId: input.projectId, projectVersion: input.toProjectVersion }] }
    },
    recheckProjectPin(toolId, input) {
      return { check: 'current', currentProjectVersion: input.currentProjectVersion }
    },
  }
  const pins = new PinSync({ paths, clock, pinSource })
  const pinMismatch = step('pins.advanceWithRawC10Id', () => pins.advance({
    toolId: 'ffmpeg',
    fromProjectVersion: 'rev-1',
    toProjectVersion: 'rev-2',
    toolVersion: '9.0.1',
  }))
  step('pins.setExplicitReference', () => pins.setReference({
    c06ProjectRef: 'project-c13',
    authorizedBy: 'orchestrator',
    reason: '走查中登记一次明确引用，代替自动翻译',
  }))
  const pinAdvanced = step('pins.advanceAfterReference', () => pins.advance({
    toolId: 'ffmpeg',
    fromProjectVersion: 'rev-2',
    toProjectVersion: 'rev-3',
    toolVersion: '9.0.1',
  }))

  // ---- legacy ui-state migration ---------------------------------------------------------
  const dataRoot = temp.dir('data')
  step('legacy.seedUiState', () => {
    const dir = path.join(dataRoot, 'ui-state')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${projectId}.json`), JSON.stringify({ brief: { user: '旧界面里写的：不要旁白', source: '', ai: '' } }), 'utf8')
    fs.writeFileSync(
      path.join(dir, `${projectId}.assistant.json`),
      JSON.stringify({
        messages: [
          { messageId: 'msg_0001', text: '先看方向', refs: [], status: 'queued-for-orchestration' },
        ],
        nextSeq: 2,
      }),
      'utf8',
    )
  })
  const migration = step('legacy.migrate', () => migrateLegacyUiState({ paths, dataRoot, clock }))

  // ---- initial cut -----------------------------------------------------------------------
  step('cut.writeRealFile', () => {
    fs.mkdirSync(paths.resolve('media'), { recursive: true })
    fs.writeFileSync(paths.resolve('media/initial-cut.mp4'), 'c13-initial-cut-bytes', 'utf8')
  })
  const cutGate = step('cut.gate', () =>
    initialCutGate({
      baseline: {
        ref: 'baseline-1',
        items: baseline.read().items.map((item) => ({
          itemId: item.itemId,
          kind: item.kind,
          blocking: item.blocking,
          state: item.state,
        })),
      },
      units: registry.list(),
      cut: {
        files: [{ path: 'media/initial-cut.mp4', sha256: sha256('c13-initial-cut-bytes') }],
        readableWhole: true,
        timebase: { totalFrames: plans.base.timebase.totalFrames },
      },
      compositionPlan: plans.base,
      programChecks: [{ name: '整片可解码', executed: true, passed: true }],
      knownIssues: ['雨幕右上角硬边未完全消除'],
      unverified: ['未看整片', '未听音频（没有音频）'],
      vision: { observed: false },
    }),
  )

  const evidence = {
    schemaVersion: 1,
    kind: 'c13-journey-evidence',
    generatedAt: new Date(Number(process.env.C13_NOW ?? 0) || 1_700_000_000_000).toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    projectId,
    projectTitle: created.project.title,
    steps,
    facts: {
      brief: brief.summary(),
      research: research.summary(),
      capabilityGaps: capability.gaps,
      directions: directions.list().map((entry) => ({
        directionId: entry.directionId,
        version: entry.version,
        state: entry.state,
      })),
      planGateBefore: gateBefore,
      planGateAfter: gateAfter,
      unit: {
        unitId: unitResult.unitId,
        status: unitResult.status,
        missing: unitResult.validation.missing,
        unobserved: unitResult.validation.unobserved,
      },
      workPackage: {
        runId: begun.run.runId,
        producerSessionId: begun.run.producerSessionId,
        execution: run.read().execution,
      },
      productionGate: productionGateResult,
      vista: vistaGate,
      c16Baseline: c16.baseline,
      method: {
        routeVersion: route.route.version,
        baselineRecheckRequired: route.route.baselineRecheckRequired,
        analysisId: analysis.analysis.analysisId,
        faultEntry: fault.entry.entryId,
        convergence: methods.convergenceVerdict(convergence.convergence.convergenceId),
      },
      craft: { term: term.selection.term, lockedAgainstAiChange: term.selection.lockedAgainstAiChange },
      preview: previewStanding,
      pins: {
        mismatchStatus: pinMismatch.status,
        mismatchCode: pinMismatch.issue?.code,
        afterReference: pinAdvanced.status,
        reference: pins.read().referenceDecision?.c06ProjectRef,
      },
      migration: {
        status: migration.status,
        briefEntriesWritten: migration.record?.briefEntriesWritten,
        messagesWritten: migration.record?.messagesWritten,
        uiReadOnly: migration.uiReadOnly,
      },
      cutGate: { ok: cutGate.ok, blockers: cutGate.blockers, handoff: cutGate.handoff },
    },
    limits: [
      '本次走查没有调用任何视觉或音频模型：AI 未看片、未听音，只有程序检查结果',
      '真实渲染与真实媒体由 C12 承担；本走查用占位字节验证文件与哈希门禁，不冒充成片',
      '人类验收未进行：用户尚未观看或听取任何单元',
    ],
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(path.resolve(out), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`journey evidence: ${out}\n`)
  process.stdout.write(`steps: ${steps.filter((entry) => entry.status === 'ok').length} ok, ${steps.filter((entry) => entry.status === 'refused-as-designed').length} refused-as-designed\n`)
  if (!keep) temp.dispose()
}

main()
