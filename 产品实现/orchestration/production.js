/**
 * The single production run: one main agent, one making sub-agent, one writer at a time.
 *
 * Everything here is designed so the organization cannot quietly change for a better metric:
 * the producer session is bound on the first real unit and every later call must present the same
 * id; a second complete-production project is refused by C10's global lock, not by a warning; a
 * takeover is allowed only for the three named causes and always continues from a saved position,
 * never by starting a second maker (C13 card §4.5, CT-08 §1–§3).
 *
 * The initial-cut gate is separate from the production gate on purpose: passing the production
 * gate means "may start", passing the cut gate means "there is a real whole film to review", and
 * neither of them means the user accepted anything.
 *
 * @module orchestration/production
 */

import { Clock, ConflictError, ValidationError } from '../base/index.js'
import { ExecutionState } from '../core/project/schema.js'
import { acquireProduction, inspectProduction, releaseProduction } from '../core/project/production-lock.js'
import { acquireProjectWriter } from '../core/project/write-guard.js'
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

/** Why a producer may be replaced. Anything else means "fix the same maker". */
export const TakeoverCause = Object.freeze({
  CRASH: 'crash',
  UNRECOVERABLE: 'unrecoverable',
  ROUTE_CANCELLED: 'route-cancelled',
})

/** Legal execution-state moves for a production run. */
export const PRODUCTION_TRANSITIONS = Object.freeze({
  [ExecutionState.IDLE]: [
    ExecutionState.RUNNING,
    ExecutionState.WAITING_USER,
    ExecutionState.WAITING_AUTHORIZATION,
    ExecutionState.PAUSED,
  ],
  [ExecutionState.WAITING_USER]: [ExecutionState.RUNNING, ExecutionState.PAUSED, ExecutionState.CANCELLING],
  [ExecutionState.WAITING_AUTHORIZATION]: [ExecutionState.RUNNING, ExecutionState.PAUSED, ExecutionState.CANCELLING],
  [ExecutionState.RUNNING]: [
    ExecutionState.PAUSING,
    // A cancel requested while running goes through `cancelling`; it is not an instant jump.
    ExecutionState.CANCELLING,
    ExecutionState.PAUSED,
    ExecutionState.WAITING_USER,
    ExecutionState.WAITING_AUTHORIZATION,
    ExecutionState.FAILED,
    ExecutionState.UNKNOWN,
    ExecutionState.NEEDS_ATTENTION,
    ExecutionState.IDLE,
  ],
  [ExecutionState.PAUSING]: [ExecutionState.PAUSED, ExecutionState.CANCELLED, ExecutionState.FAILED],
  [ExecutionState.PAUSED]: [
    ExecutionState.RUNNING,
    ExecutionState.CANCELLING,
    ExecutionState.CANCELLED,
    ExecutionState.NEEDS_ATTENTION,
  ],
  [ExecutionState.CANCELLING]: [ExecutionState.CANCELLED, ExecutionState.FAILED],
  [ExecutionState.CANCELLED]: [],
  [ExecutionState.FAILED]: [ExecutionState.NEEDS_ATTENTION, ExecutionState.PAUSED],
  [ExecutionState.UNKNOWN]: [ExecutionState.NEEDS_ATTENTION, ExecutionState.PAUSED],
  [ExecutionState.NEEDS_ATTENTION]: [ExecutionState.PAUSED],
})

/** What the run can and cannot claim. */
export const PRODUCTION_CAPABILITIES = Object.freeze({
  organization: {
    supported: ['主 Agent 唯一总控', '同一制作子 Agent 从首个单元连续工作', '接替只在崩溃／无法恢复／取消路线时发生'],
    limits: ['不提供 Team、Fork、独立审校或按镜头拆分的接口', '不证明模型的真实长上下文能力，只证明工作包与身份可持续'],
  },
  writer: {
    supported: ['同一项目单写入者', '全插件同时只有一个完整制作项目', '重要修改先暂停'],
    limits: ['锁只证明声明的写入权，不证明其他进程已停止', '跨机器竞争未验证'],
  },
  state: {
    supported: ['真实进度、暂停、取消、失败位置和保留范围', '状态未知按暂停处理且不自动重试'],
    limits: ['不承诺渲染原帧续跑', '外部动作状态未知时不会自动核对'],
  },
  initialCut: {
    supported: ['基线覆盖、单元完整、整片可读、程序检查、AI 看／未看结构化'],
    limits: ['程序与 AI 检查都不等于用户验收', '没有音频听辨通道，只能标未听并请用户审片'],
  },
})

/**
 * @param {string} from
 * @param {string} to
 */
function assertTransition(from, to) {
  const allowed = PRODUCTION_TRANSITIONS[from]
  if (allowed === undefined) throw new ValidationError(`未知执行状态: ${String(from)}`)
  if (!allowed.includes(to)) {
    throw new ConflictError('执行状态不能这样变化', {
      from,
      to,
      allowed,
      action: '按真实状态推进；未知先暂停，不直接回到运行',
    })
  }
}

/**
 * Empty work package (CT-08 §3 fields, nothing invented).
 * @param {string} projectId
 * @returns {any}
 */
function emptyRun(projectId) {
  return {
    kind: ORCH_DOCUMENT.workPackage.kind,
    version: 1,
    projectId,
    runId: null,
    execution: ExecutionState.IDLE,
    producerSessionId: null,
    producerHistory: [],
    baselineRef: null,
    authorizedInputs: [],
    scope: null,
    preserve: [],
    unitProfile: null,
    productionRecipe: null,
    compositionPlanRef: null,
    currentUnit: null,
    currentObject: null,
    nextAction: null,
    evidenceRefs: [],
    knownIssues: [],
    openQuestions: [],
    locks: null,
    inFlightActions: [],
    externalSnapshots: [],
    savedPosition: null,
    projectVersion: null,
    pendingImportantChange: null,
    unknownAction: null,
    createdAt: null,
    updatedAt: null,
    journal: [],
  }
}

/**
 * One production run of one project.
 */
export class ProductionRun {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({
      paths: input.paths,
      spec: ORCH_DOCUMENT.workPackage,
      clock: this.clock,
    })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => emptyRun(this.projectId))
  }

  /** @returns {any} */
  read() {
    return this.load().value
  }

  /**
   * Start the run and bind the one making session.
   * @param {object} input
   * @param {string} input.producerSessionId
   * @param {string} input.projectVersion
   * @param {string} input.baselineRef
   * @param {string} [input.scope]
   * @param {string[]} [input.preserve]
   * @param {string[]} [input.authorizedInputs]
   * @returns {{ run: any, revision: string }}
   */
  begin(input = {}) {
    const producerSessionId = requireText(input.producerSessionId, 'producerSessionId', 120)
    const projectVersion = requireText(input.projectVersion, 'projectVersion', 200)
    const baselineRef = requireText(input.baselineRef, 'baselineRef', 200)
    const { value, revision } = this.load()
    if (value.producerSessionId !== null && value.execution !== ExecutionState.CANCELLED) {
      throw new ConflictError('该项目已有制作会话，不能另起一个制作者', {
        action: '继续同一制作子 Agent；只有崩溃、无法恢复或取消整条路线才允许接替',
        producerSessionId: value.producerSessionId,
      })
    }
    const now = this.clock.iso()
    const run = {
      ...value,
      runId: orchestrationId('workPackage', `${this.projectId}:run:${value.producerHistory.length + 1}`),
      execution: ExecutionState.IDLE,
      producerSessionId,
      producerHistory: [
        ...value.producerHistory,
        { producerSessionId, at: now, reason: 'first-unit', takeover: null },
      ],
      baselineRef,
      authorizedInputs: requireTextList(input.authorizedInputs, 'authorizedInputs', 64),
      scope: optionalText(input.scope, 'scope', 1000),
      preserve: requireTextList(input.preserve, 'preserve', 32),
      projectVersion,
      createdAt: now,
      updatedAt: now,
      journal: appendJournal(value.journal, { action: 'run-begun', producerSessionId, at: now }),
    }
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * Assert the caller is the same maker that started the run.
   * @param {string} producerSessionId
   * @returns {any} the run
   */
  assertProducer(producerSessionId) {
    const run = this.read()
    const sessionId = requireText(producerSessionId, 'producerSessionId', 120)
    if (run.producerSessionId === null) {
      throw new ConflictError('制作尚未开始，没有可复用身份', { action: '从首个真实早期单元开始建立制作会话' })
    }
    if (run.producerSessionId !== sessionId) {
      throw new ConflictError('只能由同一制作子 Agent 继续', {
        expected: run.producerSessionId,
        actual: sessionId,
        action: '不要另开制作 Agent；如确有崩溃／无法恢复／取消路线，走 takeOver',
      })
    }
    return copy(run)
  }

  /**
   * Replace the maker. Only the three named causes pass, and the new maker continues from the
   * saved position rather than restarting the work.
   * @param {object} input
   * @param {string} input.producerSessionId new session
   * @param {string} input.cause one of {@link TakeoverCause}
   * @param {string} input.reason
   * @param {string} input.savedPosition
   * @returns {{ run: any, revision: string }}
   */
  takeOver(input = {}) {
    const cause = requireOneOf(input.cause, TakeoverCause, 'cause')
    const reason = requireText(input.reason, 'reason', 1000)
    const savedPosition = requireText(input.savedPosition, 'savedPosition', 500)
    const producerSessionId = requireText(input.producerSessionId, 'producerSessionId', 120)
    const { value, revision } = this.load()
    if (value.producerSessionId === null) throw new ConflictError('没有可接替的制作会话', { action: '先开始制作' })
    if (value.producerSessionId === producerSessionId) {
      throw new ConflictError('接替必须来自新的会话身份', { action: '同一会话直接 resume，不要假接替' })
    }
    const now = this.clock.iso()
    const previous = value.producerSessionId
    const run = {
      ...value,
      producerSessionId,
      savedPosition,
      // A replacement still means ONE maker at a time; the count is history, not parallelism.
      producerHistory: [
        ...value.producerHistory,
        { producerSessionId, at: now, reason, takeover: { cause, previous, savedPosition } },
      ],
      execution: ExecutionState.PAUSED,
      updatedAt: now,
      journal: appendJournal(value.journal, { action: 'producer-takeover', cause, previous, producerSessionId, at: now }),
    }
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * Change the execution state through a legal transition.
   * @param {string} next one of C10 `ExecutionState`
   * @param {object} [detail]
   * @returns {{ run: any, revision: string }}
   */
  setExecution(next, detail = {}) {
    const state = requireOneOf(next, ExecutionState, 'execution')
    const { value, revision } = this.load()
    assertTransition(value.execution, state)
    const now = this.clock.iso()
    const run = { ...value, execution: state, updatedAt: now }
    if (state === ExecutionState.WAITING_USER && typeof detail.waitingReason === 'string') {
      run.waitingReason = optionalText(detail.waitingReason, 'waitingReason', 500)
    }
    if (state === ExecutionState.RUNNING) run.waitingReason = null
    run.journal = appendJournal(value.journal, { action: 'execution', from: value.execution, to: state, at: now })
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * Update the work package. The version increments; the project version is never moved here.
   * @param {object} input
   * @param {object} input.patch
   * @param {string} input.producerSessionId
   * @returns {{ run: any, revision: string }}
   */
  update(input = {}) {
    this.assertProducer(input.producerSessionId)
    const patch = input.patch
    if (patch === null || typeof patch !== 'object') throw new ValidationError('工作包更新需要 patch', { field: 'patch' })
    const forbidden = ['projectId', 'producerSessionId', 'runId', 'execution', 'producerHistory']
    for (const field of forbidden) {
      if (patch[field] !== undefined) {
        throw new ValidationError(`工作包更新不能直接改 ${field}`, { field, action: '用专门的状态操作或不要改' })
      }
    }
    const { value, revision } = this.load()
    const now = this.clock.iso()
    const run = { ...value, ...copy(patch), version: value.version + 1, updatedAt: now }
    if (patch.projectVersion !== undefined && patch.projectVersion !== value.projectVersion) {
      // A work package MAY record a newer project version, but it must be explicit, and the baseline
      // is then stale until re-checked.
      run.projectVersion = requireText(patch.projectVersion, 'projectVersion', 200)
      run.baselineStale = true
    }
    run.journal = appendJournal(value.journal, { action: 'work-package-updated', version: run.version, at: now })
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * Save the current position, which is what any later recovery reads.
   * @param {object} input
   * @param {string} input.producerSessionId
   * @param {string} input.savedPosition
   * @param {string} [input.currentUnit]
   * @param {string} [input.nextAction]
   * @returns {{ run: any, revision: string }}
   */
  savePosition(input = {}) {
    this.assertProducer(input.producerSessionId)
    const { value, revision } = this.load()
    const now = this.clock.iso()
    const run = {
      ...value,
      savedPosition: requireText(input.savedPosition, 'savedPosition', 500),
      currentUnit: optionalText(input.currentUnit, 'currentUnit', 200) ?? value.currentUnit,
      nextAction: optionalText(input.nextAction, 'nextAction', 500) ?? value.nextAction,
      updatedAt: now,
    }
    run.journal = appendJournal(value.journal, { action: 'position-saved', at: now })
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * Pause. Used for user-visible pauses, page switches and important changes alike.
   * @param {object} input
   * @param {string} input.reason
   * @param {string} [input.producerSessionId]
   * @returns {{ run: any, revision: string }}
   */
  pause(input = {}) {
    const reason = requireText(input.reason, 'reason', 500)
    const { value, revision } = this.load()
    if (value.execution === ExecutionState.PAUSED) return { run: copy(value), revision }
    const allowed = PRODUCTION_TRANSITIONS[value.execution] ?? []
    const viaPausing = allowed.includes(ExecutionState.PAUSING)
    if (!viaPausing && !allowed.includes(ExecutionState.PAUSED)) {
      throw new ConflictError('当前状态不能暂停', { execution: value.execution, action: '先结束当前取消或失败处理' })
    }
    const now = this.clock.iso()
    // `pausing` exists for a real in-flight step. Here the pause is a recorded decision with no
    // asynchronous work between the two states, so it settles in one write instead of faking a
    // window in which nobody could observe anything.
    const run = {
      ...value,
      execution: ExecutionState.PAUSED,
      pauseReason: reason,
      updatedAt: now,
      journal: appendJournal(value.journal, { action: 'paused', reason, from: value.execution, at: now }),
    }
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * Resume a paused run. An unknown external action must be acknowledged first.
   * @param {object} input
   * @param {string} input.producerSessionId
   * @param {string} [input.acknowledgedUnknown] how the unknown action was actually resolved
   * @returns {{ run: any, revision: string }}
   */
  resume(input = {}) {
    this.assertProducer(input.producerSessionId)
    const acknowledged = optionalText(input.acknowledgedUnknown, 'acknowledgedUnknown', 1000)
    const { value, revision } = this.load()
    if (value.execution === ExecutionState.UNKNOWN) {
      if (acknowledged === null) {
        throw new ConflictError('上次外部动作结果未知，先核对真实状态再继续', {
          action: '核对文件／媒体／工具的真实结果，写入 acknowledgedUnknown 后再恢复',
          unknownAction: value.unknownAction,
        })
      }
      // Settling an unknown action goes through a pause, never straight back to running: the new
      // state has to be a real read-back, and the pause is where that read-back is recorded.
      const now = this.clock.iso()
      const settled = {
        ...value,
        execution: ExecutionState.PAUSED,
        waitingReason: null,
        acknowledgedUnknown: acknowledged,
        unknownAction: { ...(value.unknownAction ?? {}), resolvedAt: now, resolution: acknowledged },
        updatedAt: now,
        journal: appendJournal(value.journal, { action: 'unknown-settled', at: now }),
      }
      const first = this.document.write(settled, revision)
      const running = {
        ...settled,
        execution: ExecutionState.RUNNING,
        updatedAt: now,
        journal: appendJournal(settled.journal, { action: 'resumed', at: now }),
      }
      const second = this.document.write(running, first.revision)
      return { run: copy(running), revision: second.revision }
    }
    if (value.execution === ExecutionState.NEEDS_ATTENTION && acknowledged === null) {
      throw new ConflictError('需要处理后才能继续', { action: '说明问题如何解决，再恢复' })
    }
    if (value.pendingImportantChange !== null) {
      throw new ConflictError('有重要修改尚未形成新基线，不能直接继续制作', {
        action: '先确认修改范围并生成新基线版本',
        pending: value.pendingImportantChange,
      })
    }
    assertTransition(value.execution, ExecutionState.RUNNING)
    const now = this.clock.iso()
    const run = {
      ...value,
      execution: ExecutionState.RUNNING,
      waitingReason: null,
      acknowledgedUnknown: acknowledged,
      updatedAt: now,
    }
    run.journal = appendJournal(value.journal, { action: 'resumed', at: now })
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * Pause for an important change before it is applied (CT-08 §3 "重要修改先暂停").
   * @param {object} input
   * @param {string} input.description
   * @param {string} [input.affectedScope]
   * @returns {{ run: any, revision: string, requiresBaseline: boolean }}
   */
  requestImportantChange(input = {}) {
    const description = requireText(input.description, 'description', 1000)
    const paused = this.pause({ reason: '重要修改：先暂停并形成新基线' })
    const { value, revision } = this.load()
    const now = this.clock.iso()
    const run = {
      ...value,
      pendingImportantChange: {
        description,
        affectedScope: optionalText(input.affectedScope, 'affectedScope', 500),
        requestedAt: now,
        baselineRecorded: false,
      },
      updatedAt: now,
    }
    run.journal = appendJournal(value.journal, { action: 'important-change-requested', at: now })
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision, requiresBaseline: true }
  }

  /**
   * Close the pending important change once a new baseline version exists.
   * @param {object} input
   * @param {string} input.baselineRef
   * @returns {{ run: any, revision: string }}
   */
  recordNewBaseline(input = {}) {
    const baselineRef = requireText(input.baselineRef, 'baselineRef', 200)
    const { value, revision } = this.load()
    if (value.pendingImportantChange === null) {
      throw new ConflictError('没有待处理的重要修改', { action: '先提出修改，再记录新基线' })
    }
    const now = this.clock.iso()
    const run = {
      ...value,
      baselineRef,
      baselineStale: false,
      // The change is closed by a real new baseline, so the pause reason no longer blocks resuming.
      // The old request stays in the journal instead of lingering as a half-clear flag.
      pendingImportantChange: null,
      lastImportantChange: { ...value.pendingImportantChange, baselineRecorded: true, baselineRef, recordedAt: now },
      updatedAt: now,
    }
    run.journal = appendJournal(value.journal, { action: 'new-baseline-recorded', baselineRef, at: now })
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * Cancel the route. Successful work is kept and never overwritten.
   * @param {object} input
   * @param {string} input.reason
   * @param {string[]} [input.keptResults]
   * @returns {{ run: any, revision: string }}
   */
  cancel(input = {}) {
    const reason = requireText(input.reason, 'reason', 500)
    const { value, revision } = this.load()
    const allowed = PRODUCTION_TRANSITIONS[value.execution] ?? []
    const viaCancelling = allowed.includes(ExecutionState.CANCELLING)
    if (!viaCancelling && !allowed.includes(ExecutionState.CANCELLED)) {
      throw new ConflictError('当前状态不能取消', { execution: value.execution, action: '已结束的路线不需要取消' })
    }
    const now = this.clock.iso()
    const kept = requireTextList(input.keptResults, 'keptResults', 32)
    const cancelled = {
      ...value,
      execution: ExecutionState.CANCELLED,
      cancelReason: reason,
      // Cancelling the route never deletes what already succeeded.
      keptResults: kept.length > 0 ? kept : (value.keptResults ?? []),
      updatedAt: now,
    }
    cancelled.journal = appendJournal(value.journal, { action: 'cancelled', reason, from: value.execution, at: now })
    const written = this.document.write(cancelled, revision)
    return { run: copy(cancelled), revision: written.revision }
  }

  /**
   * Record a real failure with its location, evidence and what was preserved.
   * @param {object} input
   * @param {string} input.reason
   * @param {string} [input.location]
   * @param {string[]} [input.evidenceRefs]
   * @param {string[]} [input.keptScope]
   * @returns {{ run: any, revision: string }}
   */
  fail(input = {}) {
    const reason = requireText(input.reason, 'reason', 500)
    const { value, revision } = this.load()
    assertTransition(value.execution, ExecutionState.FAILED)
    const now = this.clock.iso()
    const run = {
      ...value,
      execution: ExecutionState.FAILED,
      failure: {
        reason,
        location: optionalText(input.location, 'location', 500),
        evidenceRefs: requireTextList(input.evidenceRefs, 'evidenceRefs', 32),
        keptScope: requireTextList(input.keptScope, 'keptScope', 32),
        at: now,
      },
      // Failure does not delete what already succeeded.
      keptResults: value.keptResults ?? [],
      updatedAt: now,
    }
    run.journal = appendJournal(value.journal, { action: 'failed', reason, at: now })
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * An external action whose result nobody knows. The run goes to `unknown`, not to `running`, and
   * nothing retries until a human or a real read-back settles it.
   * @param {object} input
   * @param {string} input.action what was attempted
   * @param {string[]} [input.attemptedTargets]
   * @returns {{ run: any, revision: string }}
   */
  markUnknown(input = {}) {
    const action = requireText(input.action, 'action', 500)
    const { value, revision } = this.load()
    assertTransition(value.execution, ExecutionState.UNKNOWN)
    const now = this.clock.iso()
    const run = {
      ...value,
      execution: ExecutionState.UNKNOWN,
      unknownAction: {
        action,
        attemptedTargets: requireTextList(input.attemptedTargets, 'attemptedTargets', 32),
        at: now,
        autoRetry: false,
      },
      updatedAt: now,
    }
    run.journal = appendJournal(value.journal, { action: 'unknown', action, at: now })
    const written = this.document.write(run, revision)
    return { run: copy(run), revision: written.revision }
  }

  /**
   * Real progress: what is current, what is saved, what was not executed and why it waits.
   * @param {{ totalUnits?: number }} [context]
   * @returns {any}
   */
  progress(context = {}) {
    const run = this.read()
    const completed = Array.isArray(run.unitResults) ? run.unitResults.filter((unit) => unit.status === 'complete').length : 0
    const total = Number.isFinite(context.totalUnits) ? context.totalUnits : null
    return {
      runId: run.runId,
      execution: run.execution,
      currentUnit: run.currentUnit,
      currentObject: run.currentObject,
      nextAction: run.nextAction,
      completed,
      total,
      // Percentages are omitted on purpose when there is no honest denominator (CT-03 §2).
      percent: total === null || total === 0 ? null : Math.round((completed / total) * 100),
      savedPosition: run.savedPosition,
      savedScope: run.keptResults ?? [],
      notExecuted: run.notExecuted ?? [],
      waitingReason: run.waitingReason ?? null,
      pendingImportantChange: run.pendingImportantChange,
      unknownAction: run.unknownAction,
      realTaskState: run.execution,
    }
  }

  /**
   * Acquire the single-project writer and the global complete-production lock.
   * @param {object} input
   * @param {string} input.taskId
   * @param {string} input.projectVersion
   * @param {string} [input.ownerLabel]
   * @returns {{ writer: any, production: any, everything: any }}
   */
  acquireLocks(input = {}) {
    const taskId = requireText(input.taskId, 'taskId', 120)
    const projectVersion = requireText(input.projectVersion, 'projectVersion', 200)
    const writer = acquireProjectWriter({
      projectsRoot: this.paths.projectsRoot,
      projectId: this.projectId,
      taskId,
      projectVersion,
      ownerLabel: optionalText(input.ownerLabel, 'ownerLabel', 120) ?? `项目 ${this.projectId}`,
      clock: this.clock,
    })
    let production = null
    try {
      production = acquireProduction({
        projectsRoot: this.paths.projectsRoot,
        projectId: this.projectId,
        taskId,
        projectVersion,
        ownerLabel: optionalText(input.ownerLabel, 'ownerLabel', 120) ?? `项目 ${this.projectId}`,
        clock: this.clock,
      })
    } catch (error) {
      // Never leave a half-held pair behind: the writer lock is released before reporting.
      writer.release()
      throw error
    }
    return { writer, production, everything: { writer, production } }
  }

  /**
   * Release both locks; a missing one is reported rather than thrown.
   * @param {any} handles result of {@link acquireLocks}
   * @returns {{ released: string[] }}
   */
  releaseLocks(handles) {
    const released = []
    if (handles?.production) {
      releaseProduction(handles.production)
      released.push('production')
    }
    if (handles?.writer) {
      handles.writer.release()
      released.push('writer')
    }
    return { released }
  }

  /**
   * Whether another project currently holds the complete-production lock.
   * @returns {any}
   */
  productionAvailability() {
    return inspectProduction(this.paths.projectsRoot, { clock: this.clock })
  }
}

/**
 * The complete-production gate: may the making start at all?
 *
 * @param {object} input
 * @param {any} input.planGate result of `PlanBaseline.gate()`
 * @param {{ ok: boolean, blockers: any[] }} input.unitGate result of `UnitRegistry.gate()`
 * @param {boolean} input.recipePresent
 * @param {boolean} input.compositionPlanPresent
 * @param {boolean} input.lockFree
 * @param {string[]} [input.authorizations] authorization refs already granted
 * @returns {{ ok: boolean, blockers: any[] }}
 */
export function productionGate(input = {}) {
  const blockers = []
  if (input.planGate?.ok !== true) {
    blockers.push({ area: 'plan', reason: '关键方案项未定', detail: input.planGate?.blockers ?? [] })
  }
  if (input.unitGate?.ok !== true) {
    blockers.push({ area: 'units', reason: '早期单元未闭合', detail: input.unitGate?.blockers ?? [] })
  }
  if (input.recipePresent !== true) blockers.push({ area: 'recipe', reason: '缺少 ProductionRecipe' })
  if (input.compositionPlanPresent !== true) blockers.push({ area: 'plan-document', reason: '缺少 CompositionPlan' })
  if (input.lockFree !== true) blockers.push({ area: 'locks', reason: '另一个完整制作项目正在进行' })
  if (!Array.isArray(input.authorizations) || input.authorizations.length === 0) {
    blockers.push({ area: 'authorization', reason: '没有记录的制作授权' })
  }
  return { ok: blockers.length === 0, blockers }
}

/**
 * The initial-cut gate: is there a real whole film, and what has actually been looked at?
 *
 * @param {object} input
 * @param {any} input.baseline `{ ref, items }`
 * @param {any[]} input.units stored unit records
 * @param {any} input.cut `{ files, readableWhole, timebase }`
 * @param {any} [input.compositionPlan]
 * @param {Array<{name: string, executed: boolean, passed: boolean}>} [input.programChecks]
 * @param {{observed: boolean, evidenceRefs?: string[], scope?: string}} [input.vision]
 * @returns {any}
 */
export function initialCutGate(input = {}) {
  const blockers = []
  const baseline = input.baseline ?? {}
  const items = Array.isArray(baseline.items) ? baseline.items : []
  if (typeof baseline.ref !== 'string' || baseline.ref.length === 0) blockers.push({ area: 'baseline', reason: '缺少基线引用' })
  if (items.length === 0) blockers.push({ area: 'baseline', reason: '基线没有方案项' })
  const undecided = items.filter((item) => item.blocking === true && item.state === 'undecided')
  if (undecided.length > 0) {
    blockers.push({
      area: 'baseline',
      reason: '关键项未定',
      detail: undecided.map((item) => item.itemId ?? item.kind),
    })
  }

  const units = Array.isArray(input.units) ? input.units : []
  const incomplete = units.filter((unit) => unit.status !== 'complete')
  if (units.length === 0) blockers.push({ area: 'units', reason: '没有早期生产单元' })
  if (incomplete.length > 0) {
    blockers.push({ area: 'units', reason: '存在未完成单元', detail: incomplete.map((unit) => unit.unitId) })
  }

  const cut = input.cut ?? {}
  const files = Array.isArray(cut.files) ? cut.files : []
  if (files.length === 0) blockers.push({ area: 'cut', reason: '完整初版没有真实媒体文件' })
  for (const [index, file] of files.entries()) {
    if (typeof file?.path !== 'string' || file.path.length === 0) blockers.push({ area: 'cut', reason: '缺少文件路径', index })
    if (file?.sha256 === undefined || file?.sha256 === null) blockers.push({ area: 'cut', reason: '缺少内容哈希', index })
  }
  if (cut.readableWhole !== true) blockers.push({ area: 'cut', reason: '整片不可完整读取播放' })

  const planFrames = input.compositionPlan?.timebase?.totalFrames
  if (
    Number.isFinite(planFrames) &&
    Number.isFinite(cut.timebase?.totalFrames) &&
    planFrames !== cut.timebase.totalFrames
  ) {
    blockers.push({
      area: 'cut',
      reason: '成片总帧数与 CompositionPlan 不一致',
      expected: planFrames,
      actual: cut.timebase.totalFrames,
    })
  }

  const checks = Array.isArray(input.programChecks) ? input.programChecks : []
  if (checks.length === 0) blockers.push({ area: 'checks', reason: '没有程序检查结果' })
  for (const check of checks) {
    if (check.executed !== true) blockers.push({ area: 'checks', reason: '检查未执行', check: check.name })
    else if (check.passed !== true) blockers.push({ area: 'checks', reason: '检查未通过', check: check.name })
  }
  if (!Array.isArray(input.knownIssues)) blockers.push({ area: 'handoff', reason: '没有列出已知问题（可以为空数组）' })
  if (!Array.isArray(input.unverified)) blockers.push({ area: 'handoff', reason: '没有列出未验证项' })

  const vision = input.vision ?? { observed: false }
  return {
    ok: blockers.length === 0,
    blockers,
    // Program-passing is not watching; the two are reported separately and never merged.
    handoff: {
      aiSawFrames: vision.observed === true ? (vision.scope ?? '关键帧与整片') : '未看',
      aiSawEvidenceRefs: Array.isArray(vision.evidenceRefs) ? vision.evidenceRefs : [],
      aiHeardAudio: '未听（宿主没有听辨通道）',
      userReviewRequired: true,
      note: '初版不是定稿；程序通过不等于用户验收',
    },
  }
}
