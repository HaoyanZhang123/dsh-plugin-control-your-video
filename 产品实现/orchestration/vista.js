/**
 * VISTA mechanisms as real execution records, plus the baseline C16 needs to compare.
 *
 * The point of this module is that a mechanism is either executed or it is not. A field named
 * `ObservationResult` proves nothing; an observation records which model, which input view and which
 * evidence ids actually went in, and when no real image entered the model the record says
 * "not executed" instead of summarising the plan (C13 card §4.7, CT-07 §5).
 *
 * Nothing here claims a benefit. `gainProven` is a constant `false`: C16 owns the same-task
 * comparison and the user-value check, and only that may turn a mechanism into "增益已证实".
 *
 * @module orchestration/vista
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

/** The seven mechanisms, in the order the tracking table lists them. */
export const VistaMechanism = Object.freeze({
  REAL_OBSERVATION: 'real-observation',
  EVIDENCE_IDENTITY: 'evidence-identity',
  INSPECTION: 'cross-region-inspection',
  PREDICTION_LOOP: 'prediction-observation-decision',
  LAYERED_MEMORY: 'layered-memory-recovery',
  MULTISCALE: 'multiscale-proxy',
  TOOL_GOVERNANCE: 'tool-governance',
})

/** What an inspection can return, so "inspect" is never a full-frame dump. */
export const InspectionKind = Object.freeze({
  REGION: 'region',
  MULTI_FRAME: 'multi-frame',
  ADJACENT_CONTEXT: 'adjacent-context',
  PREVIOUS_VERSION: 'previous-version',
  ORIGINAL_RATIO: 'original-ratio',
})

/** Why a recovery happened. */
export const RecoveryCause = Object.freeze({
  COMPACTION: 'context-compaction',
  SESSION_RESTART: 'session-restart',
  PAGE_SWITCH: 'page-switch',
})

/** Per-mechanism completion state. */
export const MechanismState = Object.freeze({
  EXECUTED: 'executed',
  PARTIAL: 'partial',
  NOT_EXECUTED: 'not-executed',
})

/** What the VISTA ledger can and cannot claim. */
export const VISTA_CAPABILITIES = Object.freeze({
  observation: {
    supported: ['记录模型、输入视图、版本、问题与观察范围', '没有真实输入时明确标未执行'],
    limits: ['不证明模型看懂了什么', '文字摘要不替代真实输入'],
  },
  inspection: {
    supported: ['按当前问题取回区域、多帧、相邻上下文或旧版本'],
    limits: ['不机械保存全部帧', '返回范围由问题决定，不由工具便利决定'],
  },
  loop: {
    supported: ['预期→实际→决定闭环，含意外牵连与未选范围'],
    limits: ['闭环成功不等于效果好', '决定者区分 AI 与用户'],
  },
  memory: {
    supported: ['长期设定／当前工作／恢复引用分离', '压缩不替换旧证据身份'],
    limits: ['摘要可能漂移，关键决定仍引用证据', '图片 offload 不可逆，恢复需重新读取原文'],
  },
  efficiency: {
    supported: ['记录实际输入策略、轮数、等待与存储可得数据'],
    limits: ['不预设节省，不宣称增益', '缺少计量时字段留空而不是估算'],
  },
  governance: {
    supported: ['只读与状态改变分开，记录调用身份、版本、顺序和去重'],
    limits: ['状态未知不重复调用', '不代替真实工具权限系统'],
  },
})

/**
 * @param {string} projectId
 * @returns {any}
 */
function emptyLedger(projectId) {
  return {
    kind: ORCH_DOCUMENT.vista.kind,
    version: 1,
    projectId,
    producerSessionId: null,
    observations: [],
    identities: [],
    inspections: [],
    loops: [],
    memory: { project: [], work: [], recoveryRefs: [] },
    recoveries: [],
    efficiency: [],
    toolCalls: [],
    baselines: [],
    journal: [],
  }
}

/**
 * The VISTA execution ledger of one project.
 */
export class VistaLedger {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.vista, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => emptyLedger(this.projectId))
  }

  /** @returns {any} */
  read() {
    return this.load().value
  }

  /**
   * Bind the ledger to the one making session; a different session is refused.
   * @param {string} producerSessionId
   * @returns {any}
   */
  bindProducer(producerSessionId) {
    const sessionId = requireText(producerSessionId, 'producerSessionId', 120)
    const { value, revision } = this.load()
    if (value.producerSessionId === null) {
      const written = this.document.write({ ...value, producerSessionId: sessionId }, revision)
      return { producerSessionId: sessionId, revision: written.revision }
    }
    if (value.producerSessionId !== sessionId) {
      throw new ConflictError('VISTA 证据只能由同一制作子 Agent 产生', {
        expected: value.producerSessionId,
        actual: sessionId,
      })
    }
    return { producerSessionId: sessionId, revision }
  }

  /**
   * Record a real observation of real media. Without `inputViews` and evidence this is refused,
   * because "I looked at it" with nothing attached is exactly the fake this contract forbids.
   *
   * @param {object} input
   * @param {string} input.producerSessionId
   * @param {string} input.model
   * @param {string[]} input.inputViews what forms of input actually entered the model
   * @param {string[]} input.evidenceRefs
   * @param {string} input.observedScope
   * @param {string[]} [input.issues] what looked wrong
   * @param {string} [input.note] what was actually seen, in the observer's words
   * @param {string} [input.mediaVersion]
   * @returns {{ observation: any, revision: string }}
   */
  recordObservation(input = {}) {
    this.bindProducer(input.producerSessionId)
    const model = requireText(input.model, 'model', 200)
    const inputViews = requireTextList(input.inputViews, 'inputViews', 16)
    const evidenceRefs = requireTextList(input.evidenceRefs, 'evidenceRefs', 32)
    if (inputViews.length === 0 || evidenceRefs.length === 0) {
      throw new ValidationError('真实观察必须记录实际输入形式与证据引用', {
        field: inputViews.length === 0 ? 'inputViews' : 'evidenceRefs',
        action: '没有真实输入时请用 recordUnobserved',
      })
    }
    const observedScope = requireText(input.observedScope, 'observedScope', 500)
    const { value, revision } = this.load()
    const observation = {
      observationId: orchestrationId('observation', `${this.projectId}:${value.observations.length}:${observedScope}`),
      mechanism: VistaMechanism.REAL_OBSERVATION,
      producerSessionId: value.producerSessionId,
      model,
      inputViews,
      evidenceRefs,
      observedScope,
      mediaVersion: optionalText(input.mediaVersion, 'mediaVersion', 200),
      issues: requireTextList(input.issues, 'issues', 32),
      // The observer's own words are stored: a record with only booleans would not be evidence.
      note: optionalText(input.note, 'note', 2000),
      actuallyObserved: true,
      at: this.clock.iso(),
    }
    value.observations.push(observation)
    const written = this.document.write(value, revision)
    return { observation: copy(observation), revision: written.revision }
  }

  /**
   * Record that no real input was available. This is a first-class, honest record.
   * @param {object} input
   * @param {string} input.producerSessionId
   * @param {string} input.reason
   * @param {string} [input.scope]
   * @returns {{ observation: any, revision: string }}
   */
  recordUnobserved(input = {}) {
    this.bindProducer(input.producerSessionId)
    const reason = requireText(input.reason, 'reason', 500)
    const { value, revision } = this.load()
    const observation = {
      observationId: orchestrationId('observation', `${this.projectId}:none:${value.observations.length}`),
      mechanism: VistaMechanism.REAL_OBSERVATION,
      producerSessionId: value.producerSessionId,
      model: null,
      inputViews: [],
      evidenceRefs: [],
      observedScope: optionalText(input.scope, 'scope', 500) ?? '未执行',
      issues: [],
      actuallyObserved: false,
      reason,
      at: this.clock.iso(),
    }
    value.observations.push(observation)
    const written = this.document.write(value, revision)
    return { observation: copy(observation), revision: written.revision }
  }

  /**
   * Register an evidence identity. A derived proxy is never allowed to claim a source identity.
   * @param {object} input
   * @param {string} input.evidenceRef
   * @param {string} input.role `source` | `result` | `derived`
   * @param {string} [input.sha256]
   * @param {string} [input.derivedFrom]
   * @param {string} [input.transform]
   * @returns {{ identity: any, revision: string }}
   */
  registerIdentity(input = {}) {
    const evidenceRef = requireText(input.evidenceRef, 'evidenceRef', 200)
    const role = requireOneOf(input.role, { SOURCE: 'source', RESULT: 'result', DERIVED: 'derived' }, 'role')
    const { value, revision } = this.load()
    if (role === 'derived' && optionalText(input.derivedFrom, 'derivedFrom', 200) === null) {
      throw new ValidationError('派生证据必须记录来源身份', { field: 'derivedFrom' })
    }
    if (value.identities.some((identity) => identity.evidenceRef === evidenceRef)) {
      throw new ConflictError('证据身份不能静默替换', { evidenceRef, action: '新增一个身份，保留旧的' })
    }
    const identity = {
      identityId: orchestrationId('observation', `identity:${evidenceRef}`),
      mechanism: VistaMechanism.EVIDENCE_IDENTITY,
      evidenceRef,
      role,
      sha256: optionalText(input.sha256, 'sha256', 128),
      derivedFrom: optionalText(input.derivedFrom, 'derivedFrom', 200),
      transform: optionalText(input.transform, 'transform', 500),
      at: this.clock.iso(),
    }
    value.identities.push(identity)
    const written = this.document.write(value, revision)
    return { identity: copy(identity), revision: written.revision }
  }

  /**
   * Ask for a specific inspection, driven by a current question.
   *
   * A question shorter than eight characters is refused: "look at everything" is the mechanical
   * behaviour this mechanism is supposed to replace.
   *
   * @param {object} input
   * @param {string} input.producerSessionId
   * @param {string} input.question
   * @param {string} input.kind one of {@link InspectionKind}
   * @param {string[]} input.evidenceRefs
   * @param {string} input.returnedScope
   * @returns {{ inspection: any, revision: string }}
   */
  requestInspection(input = {}) {
    this.bindProducer(input.producerSessionId)
    const question = requireText(input.question, 'question', 500)
    if (question.length < 8) {
      throw new ValidationError('inspection 必须由具体问题驱动', {
        field: 'question',
        action: '写清要看什么、为什么现在要看，例如“转场 2 秒处字体是否被裁切”',
      })
    }
    const kind = requireOneOf(input.kind, InspectionKind, 'kind')
    const evidenceRefs = requireTextList(input.evidenceRefs, 'evidenceRefs', 16)
    if (evidenceRefs.length === 0) throw new ValidationError('inspection 需要证据引用', { field: 'evidenceRefs' })
    const returnedScope = requireText(input.returnedScope, 'returnedScope', 500)
    const { value, revision } = this.load()
    const inspection = {
      inspectionId: orchestrationId('inspection', `${this.projectId}:${value.inspections.length}:${question}`),
      mechanism: VistaMechanism.INSPECTION,
      question,
      kind,
      evidenceRefs,
      returnedScope,
      // Proof that the request was narrow rather than "save everything".
      drivenByQuestion: true,
      at: this.clock.iso(),
    }
    value.inspections.push(inspection)
    const written = this.document.write(value, revision)
    return { inspection: copy(inspection), revision: written.revision }
  }

  /**
   * Open a prediction→action→observation→decision loop.
   * @param {object} input
   * @param {string} input.producerSessionId
   * @param {object} input.prediction `{target, scope, preserve, expectedChange, baseline, check}`
   * @returns {{ loop: any, revision: string }}
   */
  openLoop(input = {}) {
    this.bindProducer(input.producerSessionId)
    const prediction = input.prediction
    if (prediction === null || typeof prediction !== 'object') {
      throw new ValidationError('闭环需要 CreativePrediction', { field: 'prediction' })
    }
    const target = requireText(prediction.target, 'prediction.target', 300)
    const scope = requireText(prediction.scope, 'prediction.scope', 500)
    const preserve = requireTextList(prediction.preserve, 'prediction.preserve', 16)
    const expectedChange = requireText(prediction.expectedChange, 'prediction.expectedChange', 1000)
    const { value, revision } = this.load()
    const loop = {
      loopId: orchestrationId('prediction', `${this.projectId}:${value.loops.length}:${target}`),
      mechanism: VistaMechanism.PREDICTION_LOOP,
      state: 'predicted',
      prediction: {
        target,
        scope,
        preserve,
        expectedChange,
        baseline: optionalText(prediction.baseline, 'prediction.baseline', 300),
        check: optionalText(prediction.check, 'prediction.check', 300),
      },
      action: null,
      observation: null,
      decision: null,
      at: this.clock.iso(),
    }
    value.loops.push(loop)
    const written = this.document.write(value, revision)
    return { loop: copy(loop), revision: written.revision }
  }

  /**
   * Close a loop with a real observation and a decision. Both are required.
   * @param {object} input
   * @param {string} input.loopId
   * @param {object} input.observation `{observedChange, unexpected, measurements, unobserved}`
   * @param {object} input.decision `{choice, by, reason, evidenceRefs}`
   * @param {string} [input.action]
   * @returns {{ loop: any, revision: string }}
   */
  closeLoop(input = {}) {
    const loopId = requireText(input.loopId, 'loopId', 120)
    const { value, revision } = this.load()
    const loop = value.loops.find((entry) => entry.loopId === loopId)
    if (loop === undefined) throw new ValidationError('闭环不存在', { field: 'loopId', loopId })
    if (loop.state === 'closed') throw new ConflictError('闭环已关闭，不重复记录', { loopId })
    const observedChange = requireText(input.observation?.observedChange, 'observation.observedChange', 2000)
    const choice = requireText(input.decision?.choice, 'decision.choice', 60)
    const by = requireOneOf(input.decision?.by, { AI: 'ai', USER: 'user' }, 'decision.by')
    loop.action = optionalText(input.action, 'action', 500) ?? loop.action
    loop.observation = {
      observedChange,
      unexpected: requireTextList(input.observation?.unexpected, 'observation.unexpected', 16),
      measurements: input.observation?.measurements ?? null,
      unobserved: requireTextList(input.observation?.unobserved, 'observation.unobserved', 16),
    }
    loop.decision = {
      choice,
      by,
      reason: optionalText(input.decision?.reason, 'decision.reason', 1000),
      evidenceRefs: requireTextList(input.decision?.evidenceRefs, 'decision.evidenceRefs', 16),
      // An AI decision is a decision about the work, never a user confirmation.
      isUserConfirmation: false,
    }
    loop.state = 'closed'
    loop.closedAt = this.clock.iso()
    const written = this.document.write(value, revision)
    return { loop: copy(loop), revision: written.revision }
  }

  /**
   * Set the three separated memories. Long-term settings may only grow here; the work memory is
   * what compaction is allowed to shrink.
   * @param {object} input
   * @param {string[]} [input.project] long-term confirmed rules
   * @param {string[]} [input.work] current working notes
   * @param {string[]} [input.recoveryRefs] evidence references needed to restart
   * @returns {{ memory: any, revision: string }}
   */
  setMemory(input = {}) {
    const { value, revision } = this.load()
    const project = requireTextList(input.project, 'project', 64)
    const work = requireTextList(input.work, 'work', 64)
    const recoveryRefs = requireTextList(input.recoveryRefs, 'recoveryRefs', 64)
    const memory = {
      project: project.length > 0 ? project : value.memory.project,
      work,
      recoveryRefs: recoveryRefs.length > 0 ? recoveryRefs : value.memory.recoveryRefs,
      // Identity of old evidence is never rewritten by this call.
      previousRecoveryRefs: value.memory.recoveryRefs,
      updatedAt: this.clock.iso(),
    }
    const written = this.document.write({ ...value, memory }, revision)
    return { memory: copy(memory), revision: written.revision }
  }

  /**
   * Compress the work memory. Old evidence identities stay, which is the whole point.
   * @param {object} input
   * @param {string[]} input.keep what remains in working memory
   * @param {string[]} [input.dropped] what was dropped (kept in the record)
   * @returns {{ memory: any, identityPreserved: boolean, revision: string }}
   */
  compressWorkMemory(input = {}) {
    const keep = requireTextList(input.keep, 'keep', 64)
    const dropped = requireTextList(input.dropped, 'dropped', 64)
    const { value, revision } = this.load()
    const previousRefs = value.memory.recoveryRefs
    const memory = {
      ...value.memory,
      work: keep,
      previousRecoveryRefs: previousRefs,
      lastCompression: { at: this.clock.iso(), kept: keep, dropped },
    }
    const written = this.document.write({ ...value, memory }, revision)
    return {
      memory: copy(memory),
      identityPreserved: JSON.stringify(memory.recoveryRefs) === JSON.stringify(previousRefs),
      revision: written.revision,
    }
  }

  /**
   * Record one recovery after compaction or a session restart.
   * @param {object} input
   * @param {string} input.producerSessionId
   * @param {string} input.cause one of {@link RecoveryCause}
   * @param {object} input.checks `{baseline, version, evidence, openWork}` booleans
   * @param {string[]} [input.repeatedActions] external actions that were repeated (should be empty)
   * @param {any} [input.packet] the recovery packet that was used
   * @returns {{ recovery: any, revision: string }}
   */
  recordRecovery(input = {}) {
    this.bindProducer(input.producerSessionId)
    const cause = requireOneOf(input.cause, RecoveryCause, 'cause')
    const checks = input.checks ?? {}
    const failed = []
    for (const key of ['baseline', 'version', 'evidence', 'openWork']) {
      if (checks[key] !== true) failed.push(key)
    }
    const repeatedActions = requireTextList(input.repeatedActions, 'repeatedActions', 32)
    const { value, revision } = this.load()
    const recovery = {
      recoveryId: orchestrationId('recoveryPacket', `${this.projectId}:${value.recoveries.length}:${cause}`),
      mechanism: VistaMechanism.LAYERED_MEMORY,
      cause,
      producerSessionId: value.producerSessionId,
      checks: {
        baseline: checks.baseline === true,
        version: checks.version === true,
        evidence: checks.evidence === true,
        openWork: checks.openWork === true,
      },
      failedChecks: failed,
      repeatedActions,
      packet: input.packet ?? null,
      ok: failed.length === 0 && repeatedActions.length === 0,
      at: this.clock.iso(),
    }
    value.recoveries.push(recovery)
    const written = this.document.write(value, revision)
    return { recovery: copy(recovery), revision: written.revision }
  }

  /**
   * Record the multiscale input strategy of one run. Missing measurements stay null.
   * @param {object} input
   * @param {string} input.producerSessionId
   * @param {string[]} input.strategy e.g. ['overview-proxy', 'on-demand-original']
   * @param {number} input.rounds
   * @param {object} [input.metrics] `{tokens, waitMs, storageBytes}`
   * @param {string[]} [input.evidenceRefs]
   * @returns {{ efficiency: any, revision: string }}
   */
  recordEfficiency(input = {}) {
    this.bindProducer(input.producerSessionId)
    const strategy = requireTextList(input.strategy, 'strategy', 8)
    if (strategy.length === 0) throw new ValidationError('多尺度策略需要至少一种输入策略', { field: 'strategy' })
    const rounds = Number(input.rounds)
    if (!Number.isInteger(rounds) || rounds <= 0) throw new ValidationError('轮数必须为正整数', { field: 'rounds' })
    const { value, revision } = this.load()
    const metrics = input.metrics ?? {}
    const efficiency = {
      efficiencyId: orchestrationId('observation', `eff:${this.projectId}:${value.efficiency.length}`),
      mechanism: VistaMechanism.MULTISCALE,
      strategy,
      rounds,
      tokens: Number.isFinite(metrics.tokens) ? metrics.tokens : null,
      waitMs: Number.isFinite(metrics.waitMs) ? metrics.waitMs : null,
      storageBytes: Number.isFinite(metrics.storageBytes) ? metrics.storageBytes : null,
      evidenceRefs: requireTextList(input.evidenceRefs, 'evidenceRefs', 16),
      // Not a warning but a fact: no saving is claimed by producing this record.
      claimedSaving: false,
      at: this.clock.iso(),
    }
    value.efficiency.push(efficiency)
    const written = this.document.write(value, revision)
    return { efficiency: copy(efficiency), revision: written.revision }
  }

  /**
   * Record one tool call with its identity, permission class and outcome knowledge.
   * @param {object} input
   * @param {string} input.toolId
   * @param {string} input.toolVersion
   * @param {boolean} input.readOnly
   * @param {string} input.permission
   * @param {string} input.result
   * @param {boolean} input.outcomeKnown
   * @param {string} [input.dedupKey]
   * @returns {{ call: any, revision: string }}
   */
  recordToolCall(input = {}) {
    const toolId = requireText(input.toolId, 'toolId', 120)
    const toolVersion = requireText(input.toolVersion, 'toolVersion', 80)
    if (typeof input.readOnly !== 'boolean') throw new ValidationError('工具调用必须声明是否只读', { field: 'readOnly' })
    const permission = requireText(input.permission, 'permission', 200)
    const result = requireText(input.result, 'result', 500)
    const outcomeKnown = input.outcomeKnown === true
    const { value, revision } = this.load()
    const dedupKey = optionalText(input.dedupKey, 'dedupKey', 200)
    if (!outcomeKnown) {
      const duplicated = value.toolCalls.find(
        (call) => call.toolId === toolId && call.outcomeKnown === false && call.dedupKey === dedupKey,
      )
      if (duplicated !== undefined) {
        throw new ConflictError('上次调用结果未知，不允许重复调用', {
          toolId,
          action: '先读回真实状态，再决定是否重试',
          previousCallId: duplicated.callId,
        })
      }
    }
    const call = {
      callId: orchestrationId('toolCall', `${this.projectId}:${value.toolCalls.length}:${toolId}:${result}`),
      mechanism: VistaMechanism.TOOL_GOVERNANCE,
      toolId,
      toolVersion,
      readOnly: input.readOnly,
      permission,
      result,
      outcomeKnown,
      dedupKey,
      sequence: value.toolCalls.length + 1,
      at: this.clock.iso(),
    }
    value.toolCalls.push(call)
    const written = this.document.write(value, revision)
    return { call: copy(call), revision: written.revision }
  }

  /**
   * Tool-governance verdict: read-only and state-changing calls stay separable and no unknown
   * outcome was retried.
   * @returns {{ ok: boolean, findings: any[], readOnlyCalls: number, stateChangingCalls: number }}
   */
  governance() {
    const calls = this.read().toolCalls
    const findings = []
    const knownUnknown = new Set()
    for (const call of calls) {
      if (call.outcomeKnown === false) knownUnknown.add(`${call.toolId}|${call.dedupKey ?? ''}`)
      const retriedLater =
        call.outcomeKnown === false &&
        calls.some(
          (other) =>
            other !== call &&
            other.toolId === call.toolId &&
            other.dedupKey === call.dedupKey &&
            other.sequence > call.sequence,
        )
      if (retriedLater) {
        findings.push({ rule: 'unknown-retried', callId: call.callId, toolId: call.toolId })
      }
      if (call.readOnly === false && call.permission.trim().length === 0) {
        findings.push({ rule: 'write-without-permission', callId: call.callId })
      }
    }
    return {
      ok: findings.length === 0,
      findings,
      readOnlyCalls: calls.filter((call) => call.readOnly === true).length,
      stateChangingCalls: calls.filter((call) => call.readOnly === false).length,
      unknownOutcomes: knownUnknown.size,
    }
  }

  /**
   * Store the same-task baseline C16 will re-run.
   * @param {object} input
   * @param {string} input.taskId
   * @param {string} input.work the work and inputs
   * @param {string} input.model
   * @param {string[]} input.steps
   * @param {string[]} input.questions
   * @param {string[]} input.inputViews
   * @param {object} input.budget `{rounds, tokens, minutes}`
   * @param {any} [input.result]
   * @returns {{ baseline: any, revision: string }}
   */
  recordC16Baseline(input = {}) {
    const taskId = requireText(input.taskId, 'taskId', 200)
    const steps = requireTextList(input.steps, 'steps', 64)
    const questions = requireTextList(input.questions, 'questions', 32)
    const inputViews = requireTextList(input.inputViews, 'inputViews', 16)
    if (steps.length === 0 || questions.length === 0 || inputViews.length === 0) {
      throw new ValidationError('C16 基线需要步骤、检查问题与输入视图', {
        field: steps.length === 0 ? 'steps' : questions.length === 0 ? 'questions' : 'inputViews',
      })
    }
    const { value, revision } = this.load()
    const baseline = {
      baselineId: orchestrationId('unit', `c16:${this.projectId}:${taskId}`),
      taskId,
      work: requireText(input.work, 'work', 1000),
      model: requireText(input.model, 'model', 200),
      steps,
      questions,
      inputViews,
      budget: {
        rounds: Number.isFinite(input.budget?.rounds) ? input.budget.rounds : null,
        tokens: Number.isFinite(input.budget?.tokens) ? input.budget.tokens : null,
        minutes: Number.isFinite(input.budget?.minutes) ? input.budget.minutes : null,
      },
      result: input.result ?? null,
      // Reproducibility is a claim this record does not make on its own.
      reproducible: false,
      at: this.clock.iso(),
    }
    value.baselines.push(baseline)
    const written = this.document.write(value, revision)
    return { baseline: copy(baseline), revision: written.revision }
  }

  /**
   * The per-mechanism verdict the C13 gate and C16 read.
   * @returns {{ mechanisms: any[], ok: boolean, gainProven: boolean, notes: string[] }}
   */
  gate() {
    const value = this.read()
    const observed = value.observations.filter((entry) => entry.actuallyObserved === true)
    const mechanisms = []
    /** @param {string} mechanism @param {'executed'|'partial'|'not-executed'} state @param {any[]} evidence @param {string} note */
    const add = (mechanism, state, evidence, note) => mechanisms.push({ mechanism, state, evidence, note })

    add(
      VistaMechanism.REAL_OBSERVATION,
      observed.length > 0 ? MechanismState.EXECUTED : MechanismState.NOT_EXECUTED,
      observed.map((entry) => entry.observationId),
      observed.length > 0 ? `实际观察 ${observed.length} 次` : '没有真实输入被观察；已如实记录未执行',
    )
    add(
      VistaMechanism.EVIDENCE_IDENTITY,
      value.identities.length > 0 ? MechanismState.EXECUTED : MechanismState.NOT_EXECUTED,
      value.identities.map((entry) => entry.identityId),
      value.identities.length > 0 ? `登记 ${value.identities.length} 个证据身份` : '尚未登记源／结果／派生身份',
    )
    add(
      VistaMechanism.INSPECTION,
      value.inspections.length > 0 ? MechanismState.EXECUTED : MechanismState.NOT_EXECUTED,
      value.inspections.map((entry) => entry.inspectionId),
      value.inspections.length > 0 ? `按问题取回 ${value.inspections.length} 次` : '没有由问题驱动的 inspection',
    )
    const closed = value.loops.filter((loop) => loop.state === 'closed')
    add(
      VistaMechanism.PREDICTION_LOOP,
      closed.length > 0
        ? MechanismState.EXECUTED
        : value.loops.length > 0
          ? MechanismState.PARTIAL
          : MechanismState.NOT_EXECUTED,
      closed.map((loop) => loop.loopId),
      closed.length > 0 ? `闭环 ${closed.length} 次` : value.loops.length > 0 ? '有预期但未闭环' : '没有预期—实际闭环',
    )
    const recoveries = value.recoveries.filter((entry) => entry.ok === true)
    add(
      VistaMechanism.LAYERED_MEMORY,
      recoveries.length > 0
        ? MechanismState.EXECUTED
        : value.memory.project.length > 0
          ? MechanismState.PARTIAL
          : MechanismState.NOT_EXECUTED,
      recoveries.map((entry) => entry.recoveryId),
      recoveries.length > 0 ? `证据化恢复 ${recoveries.length} 次` : '分层记忆已建立，但尚无通过检查的恢复',
    )
    add(
      VistaMechanism.MULTISCALE,
      value.efficiency.length > 0 ? MechanismState.EXECUTED : MechanismState.NOT_EXECUTED,
      value.efficiency.map((entry) => entry.efficiencyId),
      value.efficiency.length > 0 ? `记录 ${value.efficiency.length} 次输入策略与轮数` : '没有多尺度输入策略记录',
    )
    const governance = this.governance()
    add(
      VistaMechanism.TOOL_GOVERNANCE,
      value.toolCalls.length > 0
        ? (governance.ok ? MechanismState.EXECUTED : MechanismState.PARTIAL)
        : MechanismState.NOT_EXECUTED,
      value.toolCalls.map((entry) => entry.callId),
      value.toolCalls.length > 0 ? `记录 ${value.toolCalls.length} 次工具调用` : '没有工具调用记录',
    )
    const executed = mechanisms.filter((entry) => entry.state === MechanismState.EXECUTED)
    return {
      mechanisms,
      ok: executed.length === mechanisms.length,
      executed: executed.length,
      total: mechanisms.length,
      // Not negotiable: only C16's comparison plus user value may change this.
      gainProven: false,
      notes: [
        '机制实际执行不等于增益已证实',
        '同任务对照、效果与用户价值由 C16 专项验收',
      ],
    }
  }
}
