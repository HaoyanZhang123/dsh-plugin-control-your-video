/**
 * Edit-time guards: the project write lock, the production pause rule and the version facts an edit
 * must read before it may change anything.
 *
 * CT-05 §5 and C14 §4.6 require the same single writer for user and AI edits, and require an actual
 * edit to wait while production is running. Both are enforced here in code, not only in prose: every
 * editing module calls {@link withEditingWrite} and {@link ensureEditingAllowed} instead of writing
 * project documents directly.
 *
 * @module editing/guard
 */

import { Clock, ConflictError, ValidationError } from '../base/index.js'
import {
  checkWriterAvailable,
  createVersionStore,
  describeLockConflict,
  inspectProjectWriter,
  projectEditLockPath,
  withProjectWriter,
} from '../core/project/index.js'
import { ExecutionState } from '../core/project/schema.js'
import { createOrchestrationKit } from '../orchestration/index.js'

/** Production states in which a real edit must pause the run first. */
export const PAUSE_FIRST_STATES = Object.freeze([
  ExecutionState.RUNNING,
  ExecutionState.PAUSING,
  ExecutionState.WAITING_USER,
  ExecutionState.WAITING_AUTHORIZATION,
])

/** Production states in which editing is safe without another pause. */
export const EDITABLE_PRODUCTION_STATES = Object.freeze([
  ExecutionState.IDLE,
  ExecutionState.PAUSED,
  ExecutionState.CANCELLED,
  ExecutionState.FAILED,
])

/** States where the true production state must be checked by a human before anything else. */
export const NEEDS_CHECK_STATES = Object.freeze([ExecutionState.UNKNOWN, ExecutionState.NEEDS_ATTENTION])

/**
 * Read the lock, production and version facts an edit depends on.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @returns {object}
 */
export function inspectEditingState(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('编辑状态需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const lockPath = projectEditLockPath(paths.projectsRoot, paths.projectId)
  const writerAvailable = checkWriterAvailable(lockPath, { clock })
  const productionRun = createOrchestrationKit({ paths, clock }).production.read()
  const execution = productionRun.execution
  const versions = createVersionStore({ paths, clock })
  const current = versions.getCurrent()
  const final = versions.getFinal()

  let editable = false
  let reason = null
  let action = null
  if (writerAvailable.ok === false) {
    reason = '另一个写入者正持有项目写入锁'
    action = writerAvailable.detail?.action ?? '等待对方结束，或先处理锁'
  } else if (PAUSE_FIRST_STATES.includes(execution)) {
    reason = '制作正在运行；实际修改前必须先暂停'
    action = '先暂停制作，再修改'
  } else if (NEEDS_CHECK_STATES.includes(execution)) {
    reason = execution === ExecutionState.UNKNOWN
      ? '上次制作结果未知，按暂停处理；先核对真实结果'
      : '制作需要处理；先处理问题再修改'
    action = '核对制作真实状态并处理，再修改'
  } else if (EDITABLE_PRODUCTION_STATES.includes(execution)) {
    editable = true
  } else {
    reason = `未知制作状态：${String(execution)}`
    action = '先核对状态，不自动继续'
  }

  return {
    projectId: paths.projectId,
    writer: {
      available: writerAvailable.ok,
      conflict: writerAvailable.ok ? null : writerAvailable.detail,
    },
    production: {
      execution,
      editable,
      producerSessionId: productionRun.producerSessionId ?? null,
      runId: productionRun.runId ?? null,
      pendingImportantChange: productionRun.pendingImportantChange ?? null,
    },
    versions: {
      currentVersionId: current === null ? null : current.versionId,
      currentLabel: current === null ? null : current.label,
      finalVersionId: final === null ? null : final.versionId,
      finalized: final !== null,
    },
    edit: {
      allowed: editable && writerAvailable.ok === true,
      reason,
      action,
      pauseFirst: PAUSE_FIRST_STATES.includes(execution),
    },
  }
}

/**
 * Refuse an actual edit when production is running, the write lock is held or the state is unknown.
 *
 * @param {object} input
 * @param {any} input.paths
 * @param {any} [input.clock]
 * @param {string} input.operation what is about to change, used in the refusal
 * @returns {object} the inspected state
 */
export function ensureEditingAllowed(input) {
  const state = inspectEditingState(input)
  if (state.edit.allowed === true) return state
  throw new ConflictError(`现在不能实际修改：${state.edit.reason}`, {
    operation: input.operation,
    execution: state.production.execution,
    writerAvailable: state.writer.available,
    reason: state.edit.reason,
    action: state.edit.action,
    pauseFirst: state.edit.pauseFirst,
    code: state.writer.available === false ? 'PROJECT_WRITER_HELD' : 'EDIT_BLOCKED_BY_PRODUCTION',
  })
}

/**
 * Refuse a planning/comment write only when the write lock is held or the production state is
 * unknowable. Browsing, selecting and leaving comments during production is allowed (C14 §4.6);
 * an actual film modification is what must wait for a pause.
 *
 * @param {object} input
 * @param {any} input.paths
 * @param {any} [input.clock]
 * @param {string} input.operation
 * @returns {object} the inspected state
 */
export function ensurePlanningAllowed(input) {
  const state = inspectEditingState(input)
  if (state.writer.available !== true) {
    throw new ConflictError('现在不能写入项目记录', {
      operation: input.operation,
      reason: '另一个写入者正持有项目写入锁',
      action: state.writer.conflict?.action ?? '等待对方结束，或先处理锁',
      code: 'PROJECT_WRITER_HELD',
    })
  }
  if (NEEDS_CHECK_STATES.includes(state.production.execution)) {
    throw new ConflictError('制作状态未知或需要处理，先核对再写入', {
      operation: input.operation,
      execution: state.production.execution,
      action: '核对制作真实状态并处理，再继续',
      code: 'EDIT_BLOCKED_BY_PRODUCTION',
    })
  }
  return state
}

/**
 * Pause the production run so an actual edit may proceed.
 *
 * This is a deliberate action with its own record: C14 does not silently edit under a running
 * production, and it does not mark the run paused on its own initiative. The caller (UI or the
 * main agent acting on an explicit request) asks for the pause first.
 *
 * @param {object} input
 * @param {any} input.paths
 * @param {any} [input.clock]
 * @param {string} [input.reason]
 * @returns {{ changed: boolean, execution: string, run: object|null }}
 */
export function pauseProductionForEditing(input) {
  const clock = input.clock ?? new Clock()
  const state = inspectEditingState({ paths: input.paths, clock })
  if (state.production.editable === true) {
    return { changed: false, execution: state.production.execution, run: null }
  }
  if (
    state.production.execution === ExecutionState.UNKNOWN ||
    state.production.execution === ExecutionState.NEEDS_ATTENTION
  ) {
    throw new ConflictError('制作状态未知或需要处理，不能靠自动暂停继续', {
      execution: state.production.execution,
      action: '先核对真实结果并处理，再暂停或修改',
    })
  }
  if (state.edit.pauseFirst !== true) {
    throw new ConflictError('当前制作状态不需要或不支持暂停', {
      execution: state.production.execution,
      action: state.edit.action,
    })
  }
  const production = createOrchestrationKit({ paths: input.paths, clock }).production
  const paused = production.pause({ reason: input.reason ?? '实际修改前暂停制作' })
  return { changed: true, execution: paused.run.execution, run: paused.run }
}

/**
 * Run one project-modifying operation under C10's project write lock.
 *
 * Every editing document write happens inside this call, so two writers cannot interleave an
 * annotation with a candidate acceptance.
 *
 * @template T
 * @param {object} input
 * @param {any} input.paths
 * @param {any} [input.clock]
 * @param {string} input.taskId describes the operation, shown in "需要处理"
 * @param {string} [input.projectVersion]
 * @param {string} [input.reason]
 * @param {(lock: object) => T} fn
 * @returns {T}
 */
export function withEditingWrite(input, fn) {
  if (typeof fn !== 'function') throw new ValidationError('withEditingWrite 需要操作函数', { field: 'fn' })
  return withProjectWriter(
    {
      projectsRoot: input.paths.projectsRoot,
      projectId: input.paths.projectId,
      taskId: input.taskId,
      projectVersion: input.projectVersion,
      ownerLabel: 'EDITING-REVIEW',
      reason: input.reason,
      clock: input.clock,
    },
    fn,
  )
}

/**
 * Describe an existing lock conflict for a UI surface.
 * @param {string} lockPath
 * @param {{ clock?: Clock }} [options]
 * @returns {object|null}
 */
export function describeEditingLock(lockPath, options = {}) {
  const inspected = inspectProjectWriter(lockPath, options)
  if (inspected === null) return null
  return describeLockConflict(inspected)
}
