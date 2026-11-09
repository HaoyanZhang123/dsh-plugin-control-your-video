/**
 * Professional methods inside the one making agent: packs, routes, the fault handbook, reference
 * analysis and bounded visual convergence.
 *
 * Two rules shape the whole module:
 * - a method is a written, versioned production spec (inputs, order, boundaries, standards,
 *   failures, checks, exit), never a style word and never a second agent;
 * - convergence is bounded and staged. Overall composition is fixed before mid structure, mid
 *   structure before detail, and when the round budget runs out the remaining gaps are shown to the
 *   user instead of being called "good enough" (C13 card §4.8, CT-14 §1–§6).
 *
 * @module orchestration/methods
 */

import { Clock, ConflictError, ValidationError } from '../base/index.js'
import {
  ORCH_DOCUMENT,
  OrchestrationDocument,
  appendJournal,
  copy,
  optionalText,
  orchestrationId,
  requireOneOf,
  requireText,
  requireTextList,
} from './ids.js'

/** Version of the method pack format. */
export const METHOD_PACK_VERSION = '1.0.0'

/** Stages of visual convergence, in the order they may run. */
export const ConvergenceStage = Object.freeze({
  OVERALL: 'overall',
  MID: 'mid-structure',
  DETAIL: 'detail',
})

/** Gap priority, used to decide what a limited repair round touches. */
export const GapPriority = Object.freeze({
  BLOCKING: 'blocking',
  MAJOR: 'major',
  MINOR: 'minor',
})

/** Required sections of one domain method pack. */
export const METHOD_PACK_SECTIONS = Object.freeze([
  'sourceAndSelfWritten',
  'applicableTasks',
  'userOutcome',
  'requiredInputs',
  'productionSteps',
  'fixedAndVariable',
  'standards',
  'commonFailures',
  'evidenceRequirements',
  'exitAndSwitch',
])

/** Required fields of one fault-handbook entry, in the order it is read. */
export const FAULT_ENTRY_FIELDS = Object.freeze([
  'symptom',
  'possibleCauses',
  'minimalVerification',
  'preferredFix',
  'protectedScope',
  'reobserveEvidence',
])

/** What the method layer can and cannot claim. */
export const METHOD_CAPABILITIES = Object.freeze({
  packs: {
    supported: ['自写、版本化的方法包', '适用条件、输入、顺序、边界、标准、失败、检查与退出齐全'],
    limits: ['方法包是内部制作能力，不是新的正式效果类型', '不加载外部 Skill，不整包复制来源资料'],
  },
  routes: {
    supported: ['每次实际任务记录方法、顺序、理由、输入、工具与预期证据', '路线变化形成新配方版本'],
    limits: ['路线记录不证明执行成功', '不静默改动已确认基线'],
  },
  handbook: {
    supported: ['症状→原因→最小验证→首选修复→保护项→复查证据'],
    limits: ['修复后必须重新观察，未复查不算已解决'],
  },
  reference: {
    supported: ['先分析后制作，记录真实参考、未知与不可判断项'],
    limits: ['分析不扩大参考使用权', '不先制作再补分析'],
  },
  convergence: {
    supported: ['分阶段、按影响排序、每轮限定修复并复查', '轮数用尽展示剩余差距并交用户决定'],
    limits: ['固定轮数或统一分数不代表通过', 'SHIP／NO-SHIP 不代替完整初版与用户验收'],
  },
})

/**
 * @param {string} projectId
 * @returns {any}
 */
function emptyLibrary(projectId) {
  return {
    kind: ORCH_DOCUMENT.methods.kind,
    projectId,
    version: 1,
    packs: [],
    routes: [],
    handbook: [],
    analyses: [],
    convergences: [],
    journal: [],
  }
}

/**
 * Method library, routes, handbook, reference analyses and convergence profiles of one project.
 */
export class MethodLibrary {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.methods, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => emptyLibrary(this.projectId))
  }

  /** @returns {any} */
  read() {
    return this.load().value
  }

  /**
   * Define one self-written, versioned method pack.
   * @param {object} input
   * @param {string} input.methodId
   * @param {object} input.sections the ten sections of {@link METHOD_PACK_SECTIONS}
   * @param {string} [input.version]
   * @returns {{ pack: any, revision: string }}
   */
  definePack(input = {}) {
    const methodId = requireText(input.methodId, 'methodId', 120)
    const sections = input.sections
    if (sections === null || typeof sections !== 'object') {
      throw new ValidationError('方法包需要 sections', { field: 'sections' })
    }
    const missing = METHOD_PACK_SECTIONS.filter((section) => {
      const value = sections[section]
      if (Array.isArray(value)) return value.length === 0
      if (value === null || value === undefined) return true
      return typeof value === 'string' ? value.trim().length === 0 : false
    })
    if (missing.length > 0) {
      throw new ValidationError('方法包缺少必需段落，不能登记', {
        field: 'sections',
        missing,
        action: '补齐适用条件、顺序、标准、常见失败与退出条件',
      })
    }
    const version = optionalText(input.version, 'version', 40) ?? METHOD_PACK_VERSION
    const { value, revision } = this.load()
    const existing = value.packs.find((pack) => pack.methodId === methodId && pack.version === version)
    if (existing !== undefined) {
      throw new ConflictError('同版本方法包已存在，不静默覆盖', { methodId, version, action: '提升版本号再登记' })
    }
    const pack = {
      packId: orchestrationId('method', `${this.projectId}:${methodId}:${version}`),
      methodId,
      version,
      selfWritten: true,
      sourceAndSelfWritten: sections.sourceAndSelfWritten,
      applicableTasks: requireTextList(sections.applicableTasks, 'sections.applicableTasks', 32),
      userOutcome: sections.userOutcome,
      requiredInputs: requireTextList(sections.requiredInputs, 'sections.requiredInputs', 32),
      productionSteps: requireTextList(sections.productionSteps, 'sections.productionSteps', 64),
      fixedAndVariable: sections.fixedAndVariable,
      standards: requireTextList(sections.standards, 'sections.standards', 32),
      commonFailures: requireTextList(sections.commonFailures, 'sections.commonFailures', 32),
      evidenceRequirements: requireTextList(sections.evidenceRequirements, 'sections.evidenceRequirements', 32),
      exitAndSwitch: sections.exitAndSwitch,
      createdAt: this.clock.iso(),
      // A pack is internal production capability, never a formal effect type.
      isFormalEffectType: false,
    }
    value.packs.push(pack)
    value.journal = appendJournal(value.journal, { action: 'method-pack-defined', methodId, version, at: pack.createdAt })
    const written = this.document.write(value, revision)
    return { pack: copy(pack), revision: written.revision }
  }

  /** @returns {any[]} */
  listPacks() {
    return copy(this.read().packs)
  }

  /**
   * Select the method route for one real task.
   *
   * A changed route bumps its version and flags that the confirmed baseline needs a re-check; the
   * route itself never edits the baseline.
   *
   * @param {object} input
   * @param {string} input.task
   * @param {string} input.producerSessionId
   * @param {Array<{methodId: string, version?: string}>} input.methods
   * @param {string[]} input.order
   * @param {string[]} input.reasons
   * @param {string[]} [input.authorizedInputs]
   * @param {string[]} [input.tools]
   * @param {string[]} [input.expectedEvidence]
   * @param {string} [input.recipeVersion]
   * @param {string} [input.referenceScopeId] set when the route produces from a reference
   * @returns {{ route: any, revision: string }}
   */
  selectRoute(input = {}) {
    const task = requireText(input.task, 'task', 300)
    const producerSessionId = requireText(input.producerSessionId, 'producerSessionId', 120)
    const methods = Array.isArray(input.methods) ? input.methods : []
    if (methods.length === 0) throw new ValidationError('方法路线需要至少一个方法', { field: 'methods' })
    const { value, revision } = this.load()
    const resolved = []
    for (const entry of methods) {
      const methodId = requireText(entry?.methodId, 'methods[].methodId', 120)
      const packs = value.packs.filter((pack) => pack.methodId === methodId)
      if (packs.length === 0) throw new ValidationError('方法包不存在', { field: 'methods[].methodId', methodId })
      const version = entry?.version === undefined ? packs[packs.length - 1].version : requireText(entry.version, 'methods[].version', 40)
      const pack = packs.find((candidate) => candidate.version === version)
      if (pack === undefined) throw new ValidationError('方法包版本不存在', { field: 'methods[].version', methodId, version })
      resolved.push({ methodId, version, packId: pack.packId })
    }
    const referenceScopeId = optionalText(input.referenceScopeId, 'referenceScopeId', 120)
    if (referenceScopeId !== null) {
      const analysis = value.analyses.find((entry) => entry.referenceScopeId === referenceScopeId)
      if (analysis === undefined) {
        throw new ConflictError('参考复刻必须先完成 ReferenceAnalysis 再制作', {
          referenceScopeId,
          action: '先分析真实参考的构图、结构、特征与未知，再开始制作',
        })
      }
    }
    const previous = value.routes.filter((route) => route.task === task)
    const version = previous.length + 1
    const recipeVersion = optionalText(input.recipeVersion, 'recipeVersion', 120)
    const route = {
      routeId: orchestrationId('route', `${this.projectId}:${task}:${version}`),
      task,
      version,
      producerSessionId,
      methods: resolved,
      order: requireTextList(input.order, 'order', 32),
      reasons: requireTextList(input.reasons, 'reasons', 32),
      authorizedInputs: requireTextList(input.authorizedInputs, 'authorizedInputs', 32),
      tools: requireTextList(input.tools, 'tools', 32),
      expectedEvidence: requireTextList(input.expectedEvidence, 'expectedEvidence', 32),
      recipeVersion,
      referenceScopeId,
      actualResults: null,
      failure: null,
      switchDecision: null,
      baselineRecheckRequired: previous.length > 0 && previous[previous.length - 1].recipeVersion === recipeVersion,
      at: this.clock.iso(),
    }
    value.routes.push(route)
    value.journal = appendJournal(value.journal, { action: 'route-selected', routeId: route.routeId, version, at: route.at })
    const written = this.document.write(value, revision)
    return { route: copy(route), revision: written.revision }
  }

  /**
   * Close a route with its real result, failure and switch decision.
   * @param {object} input
   * @param {string} input.routeId
   * @param {any} input.actualResults
   * @param {string} [input.failure]
   * @param {string} [input.switchDecision]
   * @returns {{ route: any, revision: string }}
   */
  closeRoute(input = {}) {
    const routeId = requireText(input.routeId, 'routeId', 120)
    const { value, revision } = this.load()
    const route = value.routes.find((entry) => entry.routeId === routeId)
    if (route === undefined) throw new ValidationError('方法路线不存在', { field: 'routeId', routeId })
    if (route.actualResults !== null) throw new ConflictError('方法路线已结算，不重复记录', { routeId })
    route.actualResults = input.actualResults ?? null
    route.failure = optionalText(input.failure, 'failure', 1000)
    route.switchDecision = optionalText(input.switchDecision, 'switchDecision', 1000)
    route.closedAt = this.clock.iso()
    const written = this.document.write(value, revision)
    return { route: copy(route), revision: written.revision }
  }

  /**
   * Add one fault-handbook entry. All six fields are mandatory: an entry without a re-observation
   * requirement would let a "fix" pass unseen.
   * @param {object} input
   * @param {string} input.methodId
   * @param {object} input.entry
   * @returns {{ entry: any, revision: string }}
   */
  addFaultEntry(input = {}) {
    const methodId = requireText(input.methodId, 'methodId', 120)
    const entry = input.entry ?? {}
    const missing = FAULT_ENTRY_FIELDS.filter((field) => {
      const value = entry[field]
      if (Array.isArray(value)) return value.length === 0
      return value === null || value === undefined || (typeof value === 'string' && value.trim().length === 0)
    })
    if (missing.length > 0) {
      throw new ValidationError('故障手册条目缺少必需字段', { field: 'entry', missing })
    }
    const { value, revision } = this.load()
    const record = {
      entryId: orchestrationId('failure', `${this.projectId}:${methodId}:${value.handbook.length}`),
      methodId,
      symptom: requireText(entry.symptom, 'entry.symptom', 500),
      possibleCauses: requireTextList(entry.possibleCauses, 'entry.possibleCauses', 16),
      minimalVerification: requireText(entry.minimalVerification, 'entry.minimalVerification', 1000),
      preferredFix: requireText(entry.preferredFix, 'entry.preferredFix', 1000),
      protectedScope: requireText(entry.protectedScope, 'entry.protectedScope', 1000),
      reobserveEvidence: requireTextList(entry.reobserveEvidence, 'entry.reobserveEvidence', 16),
      // A fix is not "done" until it was observed again; the record starts unresolved on purpose.
      reobservedAt: null,
      at: this.clock.iso(),
    }
    value.handbook.push(record)
    const written = this.document.write(value, revision)
    return { entry: copy(record), revision: written.revision }
  }

  /**
   * Mark one handbook entry as re-observed, with the evidence that proves it.
   * @param {object} input
   * @param {string} input.entryId
   * @param {string[]} input.evidenceRefs
   * @returns {{ entry: any, revision: string }}
   */
  markReobserved(input = {}) {
    const entryId = requireText(input.entryId, 'entryId', 120)
    const evidenceRefs = requireTextList(input.evidenceRefs, 'evidenceRefs', 16)
    if (evidenceRefs.length === 0) throw new ValidationError('复查需要真实证据引用', { field: 'evidenceRefs' })
    const { value, revision } = this.load()
    const entry = value.handbook.find((item) => item.entryId === entryId)
    if (entry === undefined) throw new ValidationError('故障手册条目不存在', { field: 'entryId', entryId })
    entry.reobservedAt = this.clock.iso()
    entry.reobserveRefs = evidenceRefs
    const written = this.document.write(value, revision)
    return { entry: copy(entry), revision: written.revision }
  }

  /** @param {string} methodId @returns {any[]} */
  handbookFor(methodId) {
    return copy(this.read().handbook.filter((entry) => entry.methodId === methodId))
  }

  /**
   * Reference analysis. It must be recorded before any route uses the reference, which
   * {@link MethodLibrary#selectRoute} enforces.
   * @param {object} input
   * @param {string} input.referenceScopeId
   * @param {string} input.referenceRef
   * @param {string} input.composition
   * @param {string} input.silhouette
   * @param {string[]} input.mainStructure
   * @param {string} input.contentContinuation
   * @param {string[]} input.keyFeatures
   * @param {string[]} [input.movement]
   * @param {string[]} [input.gaps]
   * @param {string[]} [input.unknown]
   * @param {string[]} [input.undecidable]
   * @param {string[]} [input.evidenceRefs]
   * @returns {{ analysis: any, revision: string }}
   */
  analyzeReference(input = {}) {
    const referenceScopeId = requireText(input.referenceScopeId, 'referenceScopeId', 120)
    const referenceRef = requireText(input.referenceRef, 'referenceRef', 300)
    const evidenceRefs = requireTextList(input.evidenceRefs, 'evidenceRefs', 16)
    if (evidenceRefs.length === 0) {
      throw new ValidationError('参考分析必须引用真实观察证据', { field: 'evidenceRefs', action: '没有真实参考输入时不得编造分析' })
    }
    const composition = requireText(input.composition, 'composition', 2000)
    const silhouette = requireText(input.silhouette, 'silhouette', 2000)
    const mainStructure = requireTextList(input.mainStructure, 'mainStructure', 16)
    const contentContinuation = requireText(input.contentContinuation, 'contentContinuation', 2000)
    const keyFeatures = requireTextList(input.keyFeatures, 'keyFeatures', 32)
    if (mainStructure.length === 0 || keyFeatures.length === 0) {
      throw new ValidationError('参考分析需要整体结构与关键特征', {
        field: mainStructure.length === 0 ? 'mainStructure' : 'keyFeatures',
      })
    }
    const { value, revision } = this.load()
    const analysis = {
      analysisId: orchestrationId('referenceAnalysis', `${this.projectId}:${referenceScopeId}:${value.analyses.length}`),
      referenceScopeId,
      referenceRef,
      composition,
      silhouette,
      mainStructure,
      contentContinuation,
      keyFeatures,
      movement: requireTextList(input.movement, 'movement', 32),
      gaps: requireTextList(input.gaps, 'gaps', 32),
      // Unknown and undecidable are separate: "I did not see it" and "this cannot be judged here"
      // are different reasons to leave something out of production.
      unknown: requireTextList(input.unknown, 'unknown', 32),
      undecidable: requireTextList(input.undecidable, 'undecidable', 32),
      evidenceRefs,
      // Whole-first: the analysis records overall structure before any detail claim.
      overallFirst: true,
      productionStartedBeforeAnalysis: false,
      at: this.clock.iso(),
    }
    value.analyses.push(analysis)
    const written = this.document.write(value, revision)
    return { analysis: copy(analysis), revision: written.revision }
  }

  /**
   * Open a bounded convergence profile.
   * @param {object} input
   * @param {any} input.targetAndPreserve `{target, preserve}`
   * @param {Array<{stage: string, requiredEvidence: string[]}>} input.stages
   * @param {string[]} [input.gapPriorityRules]
   * @param {object} input.bounds `{maxRounds, maxMinutes?}`
   * @param {string} [input.completionRule]
   * @returns {{ convergence: any, revision: string }}
   */
  openConvergence(input = {}) {
    const stages = Array.isArray(input.stages) ? input.stages : []
    if (stages.length === 0) throw new ValidationError('收敛配置需要至少一个重要阶段', { field: 'stages' })
    const normalized = stages.map((stage) => {
      const name = requireOneOf(stage?.stage, ConvergenceStage, 'stages[].stage')
      const requiredEvidence = requireTextList(stage?.requiredEvidence, 'stages[].requiredEvidence', 16)
      if (requiredEvidence.length === 0) throw new ValidationError('阶段必须有必需证据', { field: 'stages[].requiredEvidence', stage: name })
      return { stage: name, requiredEvidence }
    })
    const order = [ConvergenceStage.OVERALL, ConvergenceStage.MID, ConvergenceStage.DETAIL]
    const sorted = [...normalized].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage))
    const maxRounds = Number(input.bounds?.maxRounds)
    if (!Number.isInteger(maxRounds) || maxRounds <= 0) throw new ValidationError('收敛需要有界的轮数上限', { field: 'bounds.maxRounds' })
    const { value, revision } = this.load()
    const convergence = {
      convergenceId: orchestrationId('convergence', `${this.projectId}:${value.convergences.length}`),
      version: 1,
      targetAndPreserve: {
        target: requireText(input.targetAndPreserve?.target, 'targetAndPreserve.target', 1000),
        preserve: requireTextList(input.targetAndPreserve?.preserve, 'targetAndPreserve.preserve', 16),
      },
      stages: sorted,
      gapPriorityRules: requireTextList(input.gapPriorityRules, 'gapPriorityRules', 16),
      bounds: { maxRounds, maxMinutes: Number.isFinite(input.bounds?.maxMinutes) ? input.bounds.maxMinutes : null },
      completionRule: optionalText(input.completionRule, 'completionRule', 1000),
      rounds: [],
      state: 'open',
      // A round count is not a quality signal; the profile says so from the start.
      scoreBased: false,
      at: this.clock.iso(),
    }
    value.convergences.push(convergence)
    const written = this.document.write(value, revision)
    return { convergence: copy(convergence), revision: written.revision }
  }

  /**
   * Record one convergence round: what was observed, the ranked gaps, the limited fix, then the
   * re-observation. Detail work is refused while an overall gap is still blocking.
   * @param {object} input
   * @param {string} input.convergenceId
   * @param {string} input.stage
   * @param {Array<{description: string, impact: number, priority: string}>} input.gaps
   * @param {string} input.limitedFix
   * @param {string[]} [input.evidenceRefs]
   * @param {boolean} [input.reobserved]
   * @returns {{ round: any, convergence: any, exhausted: boolean, revision: string }}
   */
  recordRound(input = {}) {
    const convergenceId = requireText(input.convergenceId, 'convergenceId', 120)
    const stage = requireOneOf(input.stage, ConvergenceStage, 'stage')
    const gaps = Array.isArray(input.gaps) ? input.gaps : []
    const limitedFix = requireText(input.limitedFix, 'limitedFix', 1000)
    const { value, revision } = this.load()
    const convergence = value.convergences.find((entry) => entry.convergenceId === convergenceId)
    if (convergence === undefined) throw new ValidationError('收敛配置不存在', { field: 'convergenceId', convergenceId })
    if (convergence.state === 'closed') throw new ConflictError('收敛已关闭，不重复记录', { convergenceId })
    const previousRounds = convergence.rounds
    if (previousRounds.length >= convergence.bounds.maxRounds) {
      throw new ConflictError('已达轮数上限，需要把剩余差距交给用户决定', {
        convergenceId,
        maxRounds: convergence.bounds.maxRounds,
        action: '展示剩余问题，由用户决定继续、换案或接受',
      })
    }
    const blockingOverall = previousRounds.some(
      (round) =>
        round.stage === ConvergenceStage.OVERALL &&
        Array.isArray(round.gaps) &&
        round.gaps.some((gap) => gap.priority === GapPriority.BLOCKING),
    )
    if (stage !== ConvergenceStage.OVERALL && blockingOverall) {
      throw new ConflictError('整体问题未解决前不进入中结构或细节', {
        stage,
        action: '先解决构图／轮廓／主要结构，再处理细节',
      })
    }
    const normalizedGaps = gaps.map((gap, index) => ({
      description: requireText(gap?.description, 'gaps[].description', 500),
      impact: Number.isFinite(gap?.impact) ? gap.impact : index + 1,
      priority: requireOneOf(gap?.priority, GapPriority, 'gaps[].priority'),
    }))
    const round = {
      roundId: orchestrationId('convergence', `${convergenceId}:${previousRounds.length}`),
      round: previousRounds.length + 1,
      stage,
      gaps: normalizedGaps.sort((a, b) => a.impact - b.impact),
      limitedFix,
      evidenceRefs: requireTextList(input.evidenceRefs, 'evidenceRefs', 16),
      reobserved: input.reobserved === true,
      at: this.clock.iso(),
    }
    convergence.rounds = [...previousRounds, round]
    const exhausted = convergence.rounds.length >= convergence.bounds.maxRounds
    if (exhausted) convergence.state = 'budget-exhausted'
    const written = this.document.write(value, revision)
    return { round: copy(round), convergence: copy(convergence), exhausted, revision: written.revision }
  }

  /**
   * The honest verdict of one convergence: converged only when the last round had no blocking gap
   * and was actually re-observed; otherwise the remaining gaps go to the user.
   * @param {string} convergenceId
   * @returns {any}
   */
  convergenceVerdict(convergenceId) {
    const id = requireText(convergenceId, 'convergenceId', 120)
    const convergence = this.read().convergences.find((entry) => entry.convergenceId === id)
    if (convergence === undefined) throw new ValidationError('收敛配置不存在', { field: 'convergenceId' })
    const last = convergence.rounds[convergence.rounds.length - 1] ?? null
    const remaining = last === null ? [] : last.gaps.filter((gap) => gap.priority !== GapPriority.MINOR)
    const converged =
      last !== null &&
      last.reobserved === true &&
      remaining.filter((gap) => gap.priority === GapPriority.BLOCKING).length === 0
    return {
      convergenceId,
      rounds: convergence.rounds.length,
      maxRounds: convergence.bounds.maxRounds,
      converged,
      // Never "failed the score": either it converged, or a human decides what happens next.
      userDecisionRequired: !converged,
      remainingGaps: remaining,
      exhausted: convergence.state === 'budget-exhausted',
      note: converged ? '本轮复查未发现阻塞级差距；仍需用户验收' : '未收敛：展示剩余差距，由用户决定继续、换案或接受',
    }
  }
}
