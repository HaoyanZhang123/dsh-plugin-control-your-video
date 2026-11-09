/**
 * Adopt / verify / rollback tasks: the durable record of what was planned, authorized and actually done,
 * and the state machine that refuses to skip authorization.
 *
 * The product rule this encodes is narrow and absolute: **nothing outside the plugin happens without an
 * explicit, scoped, recorded user authorization** (C06 §4.3 "无用户授权不静默执行"; SYS-03 "有范围，无
 * 永远允许一切"). So a task starts as `planned`, can only advance past `awaiting-authorization` when an
 * authorization exists for THIS plan, and an authorization for one plan cannot be replayed onto another.
 *
 * ## Authorization ownership (user decision, 2026-11-08)
 *
 * Two authorization regimes exist and are deliberately kept separate:
 *
 * - **project authorizations** belong to C10 (`core/project/decisions.js`), because they are scoped to a
 *   project version;
 * - **tool authorizations** belong here, because installing/adopting/updating a machine-wide external tool
 *   has no causal relationship to any project version.
 *
 * When a tool action is motivated by a project, this module stores only `{ projectId, projectVersion }` —
 * a REFERENCE. It never copies project facts (no title, no phase, no materials), because C10 remains the
 * only owner of what a project version means. A pin is the same idea: an id plus a version id.
 *
 * ## Why an authorization here is not "once per internal step"
 *
 * A user decision is "adopt this tool at this location and verify it", not "start one check". So the
 * authorization covers the whole task, and the onceliness is enforced by the TASK being runnable exactly
 * once — which is both stronger and closer to what the user agreed to.
 *
 * @module tools/tasks
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Clock, ConflictError, NotFoundError, ValidationError, readJson, writeJsonAtomic } from '../base/index.js'
import { TOOL_SCHEMA_VERSION, CURRENT_TOOL_SCHEMA_GENERATION } from './schema.js'
import {
  DisclosureField,
  DISCLOSURE_FIELDS,
  EffectKind,
  TaskKind,
  TaskState,
  isTaskInFlight,
  isTaskTerminal,
} from './schema.js'
import { assertTaskId, assertBuildSegment, assertToolId } from './paths.js'
import { contentHash } from '../base/index.js'

/**
 * Text that cannot name a concrete action or scope.
 *
 * Mirrors C10's guard so the tool layer cannot accept a vaguer authorization than the project layer
 * would. "任何操作" authorizes nothing in particular and therefore everything at once.
 */
const VAGUE_PATTERN = /^(?:\*+|any|all|everything|whatever|任何|所有|全部|一切|随便|任意)(?![a-z])/u

/** Tool identifiers are validated by `paths.js`; project ids keep C10's shape. */
const PROJECT_ID_PATTERN = /^[a-z]+-[A-Za-z0-9]+$/

/**
 * The single user-visible action one task kind performs.
 *
 * @param {string} kind
 * @returns {string}
 */
export function actionForKind(kind) {
  switch (kind) {
    case TaskKind.ADOPT:
      return 'adopt-install'
    case TaskKind.REVERIFY:
      return 'verify-install'
    case TaskKind.ROLLBACK:
      return 'rollback-build'
    default:
      throw new ValidationError('任务类型未知', { kind: String(kind) })
  }
}

/**
 * @typedef {object} AuthorizationRecord
 * @property {string} authorizationId
 * @property {string} action the concrete action, e.g. `adopt-install`
 * @property {string} scope what it reaches, e.g. the tool id and build
 * @property {string} grantedBy the user's own words or a faithful summary
 * @property {string} grantedAt ISO timestamp
 * @property {string} validFor `once` or an explicit scope description
 * @property {string} planHash the plan this authorization is bound to
 * @property {string|null} dataDestination
 * @property {string|null} feeSummary
 * @property {string|null} environmentImpact
 * @property {{ projectId: string, projectVersion: string|null }|null} projectRef reference only, never facts
 * @property {Array<{ at: string, action: string, detail: object }>} uses
 * @property {string|null} consumedAt set when the task reaches a terminal state
 */

/**
 * @typedef {object} TaskRecord
 * @property {string} taskId
 * @property {string} kind one of `TaskKind`
 * @property {string} toolId
 * @property {string} state one of `TaskState`
 * @property {string} targetVersion
 * @property {string} targetBuildSegment
 * @property {string} targetLocation absolute location of the tool the user installed
 * @property {string} planHash
 * @property {Record<string, string>} disclosure the seven pre-execution disclosures
 * @property {AuthorizationRecord|null} authorization
 * @property {string|null} previousVersion
 * @property {{ projectId: string, projectVersion: string|null }|null} projectRef reference only
 * @property {Array<{ at: string, state: string, detail: object }>} trail
 * @property {object|null} result
 * @property {{ code: string, message: string, at: string }|null} failure
 * @property {number|null} runnerPid which process is executing this task
 * @property {string|null} runnerStartedAt
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Normalize a project reference.
 *
 * This is the CR-5 boundary in code: only an id and a version id may cross from C10 into here. Anything
 * else — a title, a phase, a path, a material list — is refused rather than silently accepted, because
 * accepting it is how a second copy of project facts gets created.
 *
 * @param {unknown} input
 * @returns {{ projectId: string, projectVersion: string|null }|null}
 */
export function normalizeProjectRef(input) {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('项目引用必须是对象或 null', { field: 'projectRef' })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const allowed = new Set(['projectId', 'projectVersion'])
  const extra = Object.keys(record).filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    // Refusing extra fields is the whole point: this is a reference, not a place to park project data.
    throw new ValidationError('项目引用只能包含 projectId 与 projectVersion，不复制项目事实', {
      field: 'projectRef',
      unexpectected: extra.slice(0, 5),
    })
  }
  if (typeof record.projectId !== 'string' || !PROJECT_ID_PATTERN.test(record.projectId)) {
    throw new ValidationError('项目引用需要合法的 projectId', { field: 'projectRef.projectId' })
  }
  if (record.projectVersion !== undefined && record.projectVersion !== null) {
    if (typeof record.projectVersion !== 'string' || record.projectVersion.length === 0) {
      throw new ValidationError('projectVersion 必须是非空字符串或 null', { field: 'projectRef.projectVersion' })
    }
  }
  return {
    projectId: record.projectId,
    projectVersion: typeof record.projectVersion === 'string' ? record.projectVersion : null,
  }
}

/**
 * Build a stable hash of a plan, so an authorization cannot be replayed onto another plan.
 *
 * The hash covers everything a user was told before agreeing: the tool, the exact version, where it is,
 * where it came from, what data/fees/environment it involves and how it would roll back.
 *
 * @param {{ toolId: string, kind: string, targetVersion: string, installLocation: string,
 *   disclosure: Record<string, string> }} plan
 * @returns {string}
 */
export function planHash(plan) {
  if (plan === null || typeof plan !== 'object') {
    throw new ValidationError('需要核对方案才能计算 planHash', { field: 'plan' })
  }
  const disclosure = plan.disclosure ?? {}
  const missing = DISCLOSURE_FIELDS.filter(
    (field) => typeof disclosure[field] !== 'string' || disclosure[field].length === 0,
  )
  if (missing.length > 0) {
    // A plan that cannot show all seven disclosures is not authorizable: the user would be agreeing to
    // something they were not told.
    throw new ValidationError('核对方案缺少执行前必须展示的信息', { missing })
  }
  return contentHash({
    toolId: plan.toolId,
    kind: plan.kind,
    targetVersion: plan.targetVersion,
    installLocation: plan.installLocation,
    disclosure,
  })
}

/**
 * Validate an authorization's action/scope for concreteness.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function assertConcrete(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} 不能为空`, { field })
  }
  if (VAGUE_PATTERN.test(value.trim())) {
    throw new ValidationError(`${field} 太笼统；授权必须写明具体动作或范围`, { field, value })
  }
  if (value.length > 2000) {
    throw new ValidationError(`${field} 过长`, { field })
  }
  return value
}

/**
 * The task store: durable records plus the authorization gate.
 */
export class TaskStore {
  /**
   * @param {import('./paths.js').ToolPaths} paths
   * @param {{ clock?: Clock }} [options]
   */
  constructor(paths, options = {}) {
    this.paths = paths
    this.clock = options.clock ?? new Clock()
  }

  /**
   * Create a task record. It starts in `awaiting-authorization`.
   *
   * @param {object} input
   * @param {string} input.kind one of `TaskKind`
   * @param {string} input.toolId
   * @param {string} input.targetVersion
   * @param {string} input.targetLocation absolute location of the user's install
   * @param {Record<string, string>} input.disclosure the seven disclosures
   * @param {string|null} [input.previousVersion]
   * @param {{ projectId: string, projectVersion?: string|null }|null} [input.projectRef]
   * @returns {TaskRecord}
   */
  create(input) {
    const kind = input?.kind
    if (!Object.values(TaskKind).includes(kind)) {
      throw new ValidationError('任务类型未知', { kind: String(kind) })
    }
    const toolId = assertToolId(input.toolId)
    const targetVersion = requireText(input.targetVersion, 'targetVersion')
    const targetBuildSegment = assertBuildSegment(
      String(input.targetBuildSegment ?? targetVersion),
      'targetBuildSegment',
    )
    const targetLocation = requireText(input.targetLocation, 'targetLocation')
    if (!path.isAbsolute(targetLocation)) {
      throw new ValidationError('目标位置必须是绝对路径', { field: 'targetLocation' })
    }
    const disclosure = normalizeDisclosure(input.disclosure)
    const projectRef = normalizeProjectRef(input.projectRef)
    const hash = planHash({
      toolId,
      kind,
      targetVersion,
      installLocation: targetLocation,
      disclosure,
    })
    const now = this.clock.iso()
    /** @type {TaskRecord} */
    const record = {
      schemaVersion: TOOL_SCHEMA_VERSION.task,
      schemaGeneration: CURRENT_TOOL_SCHEMA_GENERATION,
      taskId: newTaskId(this.clock),
      kind,
      toolId,
      state: TaskState.AWAITING_AUTHORIZATION,
      targetVersion,
      targetBuildSegment,
      targetLocation: path.resolve(targetLocation),
      planHash: hash,
      disclosure,
      authorization: null,
      previousVersion: input.previousVersion ?? null,
      /** A reference to the motivating project, never a copy of it. */
      projectRef,
      trail: [{ at: now, state: TaskState.PLANNED, detail: { planHash: hash } }],
      result: null,
      failure: null,
      /** Which process is actually executing this task; null until a run starts (see `isRunning`). */
      runnerPid: null,
      runnerStartedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.write(record)
    return record
  }

  /**
   * Record the user's authorization for exactly this plan.
   *
   * Refused when: the plan hash does not match the task's, the action/scope is vague, the project reference
   * is not a pure reference, or the actor is not the user. The last point matters because an AI that can
   * "authorize" its own action has defeated the rule entirely.
   *
   * @param {object} input
   * @param {string} input.taskId
   * @param {string} input.planHash
   * @param {string} input.action
   * @param {string} input.scope
   * @param {string} input.grantedBy the user's explicit answer
   * @param {string} [input.actor] must be `user`
   * @param {string} [input.validFor]
   * @param {string|null} [input.dataDestination]
   * @param {string|null} [input.feeSummary]
   * @param {string|null} [input.environmentImpact]
   * @param {{ projectId: string, projectVersion?: string|null }|null} [input.projectRef]
   * @returns {TaskRecord}
   */
  authorize(input) {
    const actor = input?.actor ?? 'user'
    if (actor !== 'user') {
      // Structural, not advisory: an AI-authored authorization would make every other guard moot.
      throw new ValidationError('只有用户能授权采纳、核实、回退工具；AI 只能展示方案并等待回答', {
        actor: String(actor),
        action: '请把披露展示给用户，收到明确回答后再以 actor: "user" 调用',
      })
    }
    const record = this.read(input?.taskId)
    if (record.planHash !== input?.planHash) {
      throw new ConflictError('该授权对应的方案与当前方案不一致，已拒绝', {
        expected: record.planHash,
        received: String(input?.planHash ?? ''),
        action: '方案已变化，需要重新向用户展示并重新授权',
      })
    }
    if (isTaskTerminal(record.state)) {
      throw new ConflictError('任务已结束，不能追加授权', { state: record.state })
    }
    const projectRef =
      input?.projectRef === undefined ? record.projectRef : normalizeProjectRef(input.projectRef)
    const authorization = {
      authorizationId: `auth-${crypto.randomBytes(8).toString('hex')}`,
      action: assertConcrete(input.action, 'action'),
      scope: assertConcrete(input.scope, 'scope'),
      grantedBy: requireText(input.grantedBy, 'grantedBy'),
      grantedAt: this.clock.iso(),
      validFor: input.validFor === undefined ? 'once' : assertConcrete(input.validFor, 'validFor'),
      planHash: record.planHash,
      dataDestination: optionalText(input.dataDestination),
      feeSummary: optionalText(input.feeSummary),
      environmentImpact: optionalText(input.environmentImpact),
      projectRef,
      uses: [],
      consumedAt: null,
    }
    const next = {
      ...record,
      authorization,
      projectRef,
      state: TaskState.AUTHORIZED,
      updatedAt: this.clock.iso(),
    }
    next.trail = appendTrail(record, TaskState.AUTHORIZED, {
      authorizationId: authorization.authorizationId,
    })
    this.write(next)
    return next
  }

  /**
   * Assert a task may perform its work right now.
   *
   * @param {string} taskId
   * @param {string} [action] the action about to run; defaults to the task kind's action
   * @returns {{ task: TaskRecord, authorization: AuthorizationRecord }}
   */
  requireAuthorization(taskId, action) {
    const record = this.read(taskId)
    if (record.state === TaskState.UNKNOWN_STATE) {
      // A task whose outcome is unknown must not be resumed: repeating it could duplicate an external
      // action (C06 §4.5 "状态不明不自动重试").
      throw new ConflictError('任务状态未知，不能自动继续；需要先核实真实状态', {
        taskId: record.taskId,
        action: '请检查工具状态与日志，确认是否已部分完成',
      })
    }
    if (isTaskTerminal(record.state)) {
      throw new ConflictError('任务已结束，不能再执行', { taskId: record.taskId, state: record.state })
    }
    if (record.authorization === null) {
      throw new ConflictError('没有用户授权，不能执行工具动作', {
        taskId: record.taskId,
        action: '请展示执行前披露并等待用户明确回答',
      })
    }
    const expected = action ?? actionForKind(record.kind)
    if (record.authorization.action !== expected) {
      throw new ConflictError('即将执行的动作与授权动作不一致', {
        authorized: record.authorization.action,
        attempted: expected,
      })
    }
    if (record.authorization.consumedAt !== null && record.authorization.consumedAt !== undefined) {
      throw new ConflictError('该授权已随任务执行消耗，不能再次使用；需要用户重新授权', {
        taskId: record.taskId,
        consumedAt: record.authorization.consumedAt,
      })
    }
    return { task: record, authorization: record.authorization }
  }

  /**
   * Record that an authorized action actually ran.
   * @param {string} taskId
   * @param {{ action: string, detail?: object }} input
   * @returns {TaskRecord}
   */
  recordAuthorizationUse(taskId, input) {
    const record = this.read(taskId)
    if (record.authorization === null) {
      throw new ConflictError('任务没有授权记录，不能记录使用', { taskId })
    }
    const authorization = {
      ...record.authorization,
      uses: [
        ...record.authorization.uses,
        { at: this.clock.iso(), action: String(input?.action ?? ''), detail: input?.detail ?? {} },
      ],
    }
    const next = { ...record, authorization, updatedAt: this.clock.iso() }
    this.write(next)
    return next
  }

  /**
   * Whether a task is in flight, so the surface can show "running" only when that is TRUE.
   *
   * "远程或后台任务只有确知仍执行才显示运行" (C06 §4.2), and CT-01 §4 requires a restarted process to treat
   * an interrupted task as paused/unknown. A record alone cannot prove liveness: a crash leaves the state
   * at `verifying` with nobody working on it. So liveness is proven by the runner identity recorded when
   * the task actually started, compared with this process.
   *
   * @param {string} taskId
   * @returns {boolean}
   */
  isRunning(taskId) {
    try {
      const record = this.read(taskId)
      if (!isTaskInFlight(record.state)) return false
      return record.runnerPid === process.pid
    } catch {
      return false
    }
  }

  /**
   * Record that THIS process is now executing the task.
   * @param {string} taskId
   * @param {number} [pid]
   * @returns {TaskRecord}
   */
  markRunning(taskId, pid = process.pid) {
    const record = this.read(taskId)
    const next = { ...record, runnerPid: pid, runnerStartedAt: this.clock.iso() }
    this.write(next)
    return next
  }

  /**
   * Reconcile a task that this process is not running.
   *
   * A task left in an in-flight state by a process that is gone has an UNKNOWN outcome. Marking it unknown
   * (rather than failed or running) is what stops an automatic retry from duplicating an action.
   *
   * @param {string} taskId
   * @returns {{ reconciled: boolean, reason: string|null }}
   */
  reconcile(taskId) {
    const record = this.read(taskId)
    if (!isTaskInFlight(record.state)) return { reconciled: false, reason: null }
    if (record.runnerPid === process.pid) return { reconciled: false, reason: null }
    this.markUnknown(taskId, `上次执行进程（PID ${String(record.runnerPid ?? '未知')}）已不存在，真实状态未知`)
    return { reconciled: true, reason: 'runner-gone' }
  }

  /**
   * Move a task to a new state, appending to its trail.
   * @param {string} taskId
   * @param {string} state
   * @param {object} [detail]
   * @returns {TaskRecord}
   */
  transition(taskId, state, detail = {}) {
    if (!Object.values(TaskState).includes(state)) {
      throw new ValidationError('任务状态未知', { state: String(state) })
    }
    const record = this.read(taskId)
    // A terminal task's outcome is a recorded fact: a cancelled task must not become "completed", and a
    // completed one must not become "failed" (V-06). The same rule is applied by every writer below.
    assertTerminalNotRewritten(record, state)
    const next = consumeIfTerminal(
      {
        ...record,
        state,
        updatedAt: this.clock.iso(),
        trail: appendTrail(record, state, detail),
      },
      state,
      this.clock,
    )
    this.write(next)
    return next
  }

  /**
   * Mark a task failed with a real reason.
   * @param {string} taskId
   * @param {{ code: string, message: string }} failure
   * @returns {TaskRecord}
   */
  fail(taskId, failure) {
    const record = this.read(taskId)
    assertTerminalNotRewritten(record, TaskState.FAILED)
    const next = consumeIfTerminal(
      {
        ...record,
        state: TaskState.FAILED,
        failure: {
          code: String(failure?.code ?? 'EXTERNAL_FAILED'),
          message: String(failure?.message ?? '失败'),
          at: this.clock.iso(),
        },
        updatedAt: this.clock.iso(),
        trail: appendTrail(record, TaskState.FAILED, { code: failure?.code ?? null }),
      },
      TaskState.FAILED,
      this.clock,
    )
    this.write(next)
    return next
  }

  /**
   * Mark a task cancelled.
   *
   * A cancellation is recorded as its own terminal state, never as failure and never as success, so a
   * cancelled adopt cannot leave a state that reads as usable (C06 §7.3 "取消不留下假状态").
   *
   * @param {string} taskId
   * @param {{ reason?: string }} [input]
   * @returns {TaskRecord}
   */
  cancel(taskId, input = {}) {
    const record = this.read(taskId)
    // A terminal task keeps its outcome. Cancelling an already-cancelled task is still a no-op so a UI
    // double-click stays harmless; turning `completed` or `failed` into `cancelled` is not allowed.
    if (record.state === TaskState.CANCELLED) return record
    assertTerminalNotRewritten(record, TaskState.CANCELLED)
    const next = consumeIfTerminal(
      {
        ...record,
        state: TaskState.CANCELLED,
        updatedAt: this.clock.iso(),
        trail: appendTrail(record, TaskState.CANCELLED, { reason: input.reason ?? 'cancelled-by-user' }),
      },
      TaskState.CANCELLED,
      this.clock,
    )
    this.write(next)
    return next
  }

  /**
   * Mark a task's outcome as unknown, without retrying it.
   * @param {string} taskId
   * @param {string} reason
   * @returns {TaskRecord}
   */
  markUnknown(taskId, reason) {
    return this.transition(taskId, TaskState.UNKNOWN_STATE, { reason })
  }

  /**
   * Record the successful result of a task.
   * @param {string} taskId
   * @param {object} result
   * @returns {TaskRecord}
   */
  complete(taskId, result) {
    const record = this.read(taskId)
    assertTerminalNotRewritten(record, TaskState.COMPLETED)
    const next = consumeIfTerminal(
      {
        ...record,
        state: TaskState.COMPLETED,
        result: result ?? null,
        updatedAt: this.clock.iso(),
        trail: appendTrail(record, TaskState.COMPLETED, {}),
      },
      TaskState.COMPLETED,
      this.clock,
    )
    this.write(next)
    return next
  }

  /**
   * Read one task.
   * @param {string} taskId
   * @returns {TaskRecord}
   */
  read(taskId) {
    const id = assertTaskId(taskId)
    const file = this.paths.taskRecordPath(id)
    if (!fs.existsSync(file)) {
      throw new NotFoundError('任务记录不存在', { taskId: id })
    }
    let parsed
    try {
      parsed = readJson(file)
    } catch (error) {
      throw new ValidationError('任务记录损坏', {
        taskId: id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    return normalizeTask(parsed, id, this.clock)
  }

  /**
   * List tasks, newest first. Used by the tool page's history section and by evidence collection.
   * @param {{ toolId?: string, state?: string }} [filter]
   * @returns {TaskRecord[]}
   */
  list(filter = {}) {
    const dir = this.paths.stateGuard.resolve('tasks')
    if (!fs.existsSync(dir)) return []
    const out = []
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const record = this.read(name.slice(0, -'.json'.length))
        if (filter.toolId !== undefined && record.toolId !== filter.toolId) continue
        if (filter.state !== undefined && record.state !== filter.state) continue
        out.push(record)
      } catch {
        // A corrupt record must not break the list; it is reported by read() when asked for directly.
      }
    }
    return out.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /**
   * Persist one record.
   * @param {TaskRecord} record
   * @returns {{ path: string, sha256: string }}
   */
  write(record) {
    const id = assertTaskId(record?.taskId)
    const file = this.paths.taskRecordPath(id)
    const written = writeJsonAtomic(file, {
      ...record,
      schemaVersion: TOOL_SCHEMA_VERSION.task,
      schemaGeneration: CURRENT_TOOL_SCHEMA_GENERATION,
      updatedAt: this.clock.iso(),
    })
    return { path: file, sha256: written.sha256 }
  }
}

/**
 * Build a task id: sortable by time, safe as a filename, and unique without a random dependency.
 * @param {Clock} clock
 * @returns {string}
 */
export function newTaskId(clock) {
  const stamp = String(clock.now()).padStart(13, '0')
  return `task-${stamp}-${crypto.randomBytes(5).toString('hex')}`
}

/**
 * @param {TaskRecord} record
 * @param {string} state
 * @param {object} detail
 * @returns {Array<{ at: string, state: string, detail: object }>}
 */
function appendTrail(record, state, detail) {
  const trail = Array.isArray(record.trail) ? record.trail : []
  const at = record.updatedAt ?? record.createdAt ?? ''
  return [...trail, { at, state, detail: detail ?? {} }]
}

/**
 * Refuse to move a task OUT of a terminal state into a different one.
 *
 * Shared by every writer (`transition`, `fail`, `cancel`, `complete`) so the rule cannot be bypassed by
 * picking a different method. Re-writing the SAME terminal state is allowed and idempotent, because a
 * retried write must not fail where the first succeeded.
 *
 * @param {TaskRecord} record
 * @param {string} target
 */
function assertTerminalNotRewritten(record, target) {
  if (!isTaskTerminal(record.state)) return
  if (record.state === target) return
  throw new ConflictError('任务已处于终态，不能改写为其他状态', {
    taskId: record.taskId,
    from: record.state,
    to: target,
    action: '需要重做请新建任务并重新取得授权；终态记录保留原样',
  })
}

/**
 * Consume the authorization when the task becomes terminal.
 *
 * One authorization permits one execution attempt. Marking the moment of consumption makes the rule
 * inspectable in the record instead of being implied by an in-memory flag, so a resumed process cannot
 * reuse an authorization it already spent.
 *
 * @param {TaskRecord} record
 * @param {string} state
 * @param {Clock} clock
 * @returns {TaskRecord}
 */
function consumeIfTerminal(record, state, clock) {
  if (!isTaskTerminal(state)) return record
  if (record.authorization === null || record.authorization === undefined) return record
  if (typeof record.authorization.consumedAt === 'string') return record
  return {
    ...record,
    authorization: { ...record.authorization, consumedAt: clock.iso() },
  }
}

/**
 * Validate the disclosure bag: all seven fields present and non-empty.
 * @param {unknown} input
 * @returns {Record<string, string>}
 */
function normalizeDisclosure(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('披露必须是一组字段', { field: 'disclosure' })
  }
  const bag = /** @type {Record<string, unknown>} */ (input)
  /** @type {Record<string, string>} */
  const out = {}
  const missing = []
  for (const field of DISCLOSURE_FIELDS) {
    const value = bag[field]
    if (typeof value !== 'string' || value.trim().length === 0) {
      missing.push(field)
      continue
    }
    out[field] = value
  }
  if (missing.length > 0) {
    throw new ValidationError('执行前披露缺少字段，不能生成可授权任务', { missing })
  }
  return out
}

/**
 * Normalize a read task document.
 * @param {any} parsed
 * @param {string} taskId
 * @param {Clock} clock
 * @returns {TaskRecord}
 */
function normalizeTask(parsed, taskId, clock) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('任务记录不是对象', { taskId })
  }
  const generation = parsed.schemaGeneration
  if (Number.isInteger(generation) && generation > CURRENT_TOOL_SCHEMA_GENERATION) {
    throw new ValidationError('任务记录由更新版本写入，当前版本不能安全读取', {
      taskId,
      found: generation,
    })
  }
  return {
    ...parsed,
    taskId,
    trail: Array.isArray(parsed.trail) ? parsed.trail : [],
    authorization: parsed.authorization ?? null,
    projectRef: parsed.projectRef ?? null,
    disclosure: parsed.disclosure ?? {},
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : clock.iso(),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : clock.iso(),
    runnerPid: Number.isInteger(parsed.runnerPid) ? parsed.runnerPid : null,
    runnerStartedAt: typeof parsed.runnerStartedAt === 'string' ? parsed.runnerStartedAt : null,
  }
}

/**
 * The task trail rendered for a user, without internal hashes.
 *
 * The management log is technical; this is the product-level story the user is allowed to read
 * (C06 §6 "不让用户审管理日志").
 *
 * @param {TaskRecord} record
 * @returns {Array<{ at: string, text: string }>}
 */
export function describeTaskTrail(record) {
  const labels = {
    [TaskState.PLANNED]: '已生成核对方案，尚未执行',
    [TaskState.AWAITING_AUTHORIZATION]: '等待你的授权',
    [TaskState.AUTHORIZED]: '已获得你的授权',
    [TaskState.VERIFYING]: '正在核对真实工具',
    [TaskState.COMPLETED]: '核对完成',
    [TaskState.FAILED]: '失败，原有记录未被改动',
    [TaskState.CANCELLED]: '已取消',
    [TaskState.UNKNOWN_STATE]: '状态未知，需要处理',
  }
  return (record.trail ?? []).map((entry) => ({
    at: entry.at,
    text: labels[entry.state] ?? String(entry.state),
  }))
}

/**
 * Which effects a task will have, for the authorization gate to check against the user's answer.
 *
 * With manual adoption the plugin moves no bytes; what it may do is start the tool's own version command,
 * which is an environment action and is listed as such.
 *
 * @param {object} tool
 * @param {string} kind
 * @returns {string[]}
 */
export function taskEffects(tool, kind) {
  /** @type {string[]} */
  const effects = []
  if (tool?.effects?.environmentImpact) effects.push(EffectKind.ENVIRONMENT)
  if (tool?.effects?.dataSubmission === true) effects.push(EffectKind.DATA_SUBMISSION)
  if (tool?.effects?.registration === true) effects.push(EffectKind.REGISTRATION)
  if (tool?.effects?.fee !== null && tool?.effects?.fee !== undefined) effects.push(EffectKind.FEE)
  if (kind === TaskKind.ADOPT || kind === TaskKind.REVERIFY) {
    // Verification runs the tool's own version/self-check command, so a process start is possible.
    const hasProcessCheck = (tool?.verificationChecks ?? []).some(
      (check) => check.kind === 'version-match' || check.kind === 'self-check',
    )
    if (hasProcessCheck) effects.push(EffectKind.PROCESS_START)
  }
  return [...new Set(effects)]
}

/** @param {unknown} value @param {string} field @returns {string} */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field })
  }
  return value
}

/** @param {unknown} value @returns {string|null} */
function optionalText(value) {
  if (value === undefined || value === null) return null
  return String(value)
}

/** Re-exported so a caller importing only `tasks.js` can assert the disclosure shape. */
export { DISCLOSURE_FIELDS, DisclosureField }
