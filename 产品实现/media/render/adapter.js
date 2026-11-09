/**
 * The RenderAdapter contract and the lifecycle of one render task.
 *
 * Contract (CT-06 §2, §6): an adapter declares capabilities, validates a plan, renders a preview
 * and a final output, reports real progress, and can be paused or cancelled. A forced stop must
 * leave a readable record of where the work was; an unknown state is treated as paused and is
 * NEVER retried automatically, because a render that may have happened must not happen twice.
 *
 * This module owns the state machine and the durable task record. The concrete runtime (FFmpeg in
 * this card) owns the pixels.
 *
 * @module media/render/adapter
 */

import fs from 'node:fs'
import path from 'node:path'
import { ConflictError, ValidationError, WorkbenchError, writeJsonAtomic, readJson } from '../../base/index.js'

/** Interface version of the adapter contract; a change means dependent cards must re-check. */
export const ADAPTER_INTERFACE_VERSION = '1.0.0'

/** Every state a render task may be in. */
export const TASK_STATES = Object.freeze([
  'queued',
  'running',
  'paused',
  'cancelled',
  'failed',
  'completed',
  'unknown',
])

/** States from which a task may NOT be restarted without a human decision. */
export const NO_AUTO_RETRY_STATES = Object.freeze(['unknown', 'failed'])

/** Methods an adapter must provide, checked so a half-implemented adapter cannot register. */
export const REQUIRED_ADAPTER_METHODS = Object.freeze([
  'capabilities',
  'validatePlan',
  'renderPreview',
  'renderFinal',
  'readProgress',
  'pause',
  'cancel',
  'resumeFromSavedWork',
  'probeResult',
  'snapshotExternalEngineering',
])

/**
 * One render task's state machine and durable record.
 */
export class RenderTask {
  /**
   * @param {object} input
   * @param {string} input.id
   * @param {string} input.adapterId
   * @param {'preview'|'final'} input.tier
   * @param {string} input.planFingerprint
   * @param {any} input.clock
   * @param {number} [input.totalFrames]
   * @param {string|null} [input.recordPath]
   */
  constructor(input) {
    this.id = input.id
    this.adapterId = input.adapterId
    this.tier = input.tier
    this.planFingerprint = input.planFingerprint
    this.clock = input.clock
    this.totalFrames = input.totalFrames ?? null
    this.recordPath = input.recordPath ?? null
    this.state = 'queued'
    this.createdAt = input.clock.iso()
    this.updatedAt = this.createdAt
    this.framesDone = 0
    this.phase = 'created'
    this.savedWork = null
    this.resultRef = null
    this.failure = null
    this.stateHistory = [{ state: 'queued', at: this.createdAt, reason: '任务创建' }]
    this.persist()
  }

  /** Write the record so a crash leaves a readable position instead of a mystery. */
  persist() {
    if (this.recordPath === null) return
    const directory = path.dirname(this.recordPath)
    fs.mkdirSync(directory, { recursive: true })
    writeJsonAtomic(this.recordPath, this.snapshot())
  }

  /** @param {string} state @param {string} reason */
  #enter(state, reason) {
    if (!TASK_STATES.includes(state)) throw new ValidationError('未知任务状态', { state: String(state) })
    this.state = state
    this.updatedAt = this.clock.iso()
    this.stateHistory.push({ state, at: this.updatedAt, reason })
    this.persist()
  }

  /** Start rendering. Only a queued task may start; a running one is never double-started. */
  begin() {
    if (this.state !== 'queued') {
      throw new ConflictError('任务不是待执行状态，不能重复开始', { taskId: this.id, state: this.state })
    }
    this.#enter('running', '开始渲染')
    return this
  }

  /** @param {{ framesDone?: number, phase?: string }} patch */
  progress(patch) {
    if (this.state !== 'running') {
      throw new ConflictError('只有运行中的任务可以推进进度', { taskId: this.id, state: this.state })
    }
    if (patch?.framesDone !== undefined) {
      if (!Number.isInteger(patch.framesDone) || patch.framesDone < 0) {
        throw new ValidationError('进度帧数必须是非负整数')
      }
      this.framesDone = this.totalFrames === null ? patch.framesDone : Math.min(patch.framesDone, this.totalFrames)
    }
    if (patch?.phase !== undefined) this.phase = String(patch.phase)
    this.updatedAt = this.clock.iso()
    this.persist()
    return this.snapshot()
  }

  /**
   * Pause, keeping the real position and whatever partial artefact exists.
   * @param {{ lastFrame?: number, partialOutputPath?: string|null, tempDir?: string|null, reason?: string }} [work]
   */
  pause(work = {}) {
    if (!['running', 'queued'].includes(this.state)) {
      throw new ConflictError('当前状态不能暂停', { taskId: this.id, state: this.state })
    }
    this.savedWork = {
      lastFrame: Number.isInteger(work.lastFrame) ? work.lastFrame : this.framesDone,
      partialOutputPath: work.partialOutputPath ?? null,
      tempDir: work.tempDir ?? null,
      savedAt: this.clock.iso(),
      note: '暂停只记录真实位置；是否可从原帧续渲由运行时能力决定，本卡不承诺',
    }
    this.#enter('paused', work.reason ?? '用户暂停')
    return this.snapshot()
  }

  /** Cancel the current attempt; a previously successful result is not deleted by this. */
  cancel(reason = '用户取消') {
    if (['completed', 'cancelled'].includes(this.state)) {
      throw new ConflictError('任务已结束，不能再次取消', { taskId: this.id, state: this.state })
    }
    this.#enter('cancelled', reason)
    return this.snapshot()
  }

  /** @param {{ message: string, code?: string, details?: any }} failure */
  fail(failure) {
    this.failure = { message: String(failure?.message ?? '未知失败'), code: failure?.code ?? 'RENDER_FAILED', at: this.clock.iso() }
    this.#enter('failed', this.failure.message)
    return this.snapshot()
  }

  /**
   * The process died or the outcome is unknown. Recorded as its own state, not as "failed", so the
   * product can say "we do not know whether it finished" instead of guessing.
   * @param {string} reason
   */
  markUnknown(reason) {
    this.#enter('unknown', reason)
    return this.snapshot()
  }

  /**
   * Resume after pause or an unknown outcome.
   * @param {{ userAction?: string, acknowledgeUnknown?: boolean, startFrame?: number }} [options]
   */
  resume(options = {}) {
    if (this.state === 'unknown') {
      if (options.acknowledgeUnknown !== true || typeof options.userAction !== 'string' || options.userAction.length === 0) {
        throw new ConflictError('状态未知时必须由用户确认后才能继续', {
          taskId: this.id,
          state: this.state,
          remedy: '先检查输出是否真实存在，再由用户明确确认继续',
        })
      }
    } else if (this.state !== 'paused') {
      throw new ConflictError('只有暂停中的任务可以继续', { taskId: this.id, state: this.state })
    }
    this.#enter('running', options.userAction ?? '从保存位置继续')
    return this.snapshot()
  }

  /** @param {any} result */
  complete(result) {
    if (this.state !== 'running') {
      throw new ConflictError('只有运行中的任务可以完成', { taskId: this.id, state: this.state })
    }
    this.resultRef = result ?? null
    this.framesDone = this.totalFrames ?? this.framesDone
    this.phase = 'completed'
    this.#enter('completed', '渲染完成')
    return this.snapshot()
  }

  /** A plain object safe to persist and to put in a receipt. */
  snapshot() {
    return {
      taskId: this.id,
      adapterId: this.adapterId,
      tier: this.tier,
      planFingerprint: this.planFingerprint,
      state: this.state,
      phase: this.phase,
      framesDone: this.framesDone,
      totalFrames: this.totalFrames,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      savedWork: this.savedWork,
      failure: this.failure,
      stateHistory: [...this.stateHistory],
      repeatProtection: {
        autoRetry: false,
        rule: '状态未知先按暂停；重复执行必须由用户确认',
      },
    }
  }
}

/**
 * A durable task store: one JSON file per task under `<workRoot>/tasks`.
 */
export function createTaskStore({ workRoot, clock }) {
  if (typeof workRoot !== 'string' || workRoot.length === 0) {
    throw new ValidationError('任务存储需要工作目录', { field: 'workRoot' })
  }
  const root = path.resolve(workRoot)
  const tasksDir = path.join(root, 'tasks')
  /** @type {Map<string, RenderTask>} */
  const live = new Map()

  return {
    root,
    tasksDir,
    /** @param {{ id: string, adapterId: string, tier: string, planFingerprint: string, totalFrames?: number }} input */
    create(input) {
      if (live.has(input.id)) throw new ConflictError('任务 id 已存在', { taskId: input.id })
      fs.mkdirSync(tasksDir, { recursive: true })
      const task = new RenderTask({
        ...input,
        clock,
        recordPath: path.join(tasksDir, `${input.id}.json`),
      })
      live.set(task.id, task)
      return task
    },
    /** @param {string} taskId */
    get(taskId) {
      const task = live.get(taskId)
      if (task !== undefined) return task
      const recordPath = path.join(tasksDir, `${taskId}.json`)
      if (!fs.existsSync(recordPath)) return null
      const stored = readJson(recordPath)
      return { stored, snapshot: () => stored }
    },
    /** Every persisted record, for a recovery screen. */
    list() {
      if (!fs.existsSync(tasksDir)) return []
      return fs
        .readdirSync(tasksDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(tasksDir, name)))
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    },
    /**
     * Refuse a second concurrent render of the same plan+tier.
     * @param {{ adapterId: string, planFingerprint: string, tier: string }} key
     */
    assertNotRunning(key) {
      for (const task of live.values()) {
        if (task.state !== 'running') continue
        if (
          task.adapterId === key.adapterId &&
          task.tier === key.tier &&
          task.planFingerprint === key.planFingerprint
        ) {
          throw new ConflictError('同一计划同一质量的渲染已经在进行', {
            taskId: task.id,
            remedy: '等待当前任务结束或先暂停它；不要重复提交',
          })
        }
      }
    },
  }
}

/**
 * Validate and freeze an adapter implementation.
 *
 * @param {any} spec
 * @returns {any}
 */
export function defineAdapter(spec) {
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof spec?.[method] !== 'function') {
      throw new ValidationError(`适配器缺少必需方法 ${method}`, { adapterId: String(spec?.id ?? 'unknown') })
    }
  }
  const capabilities = spec.capabilities()
  if (capabilities?.interfaceVersion !== ADAPTER_INTERFACE_VERSION) {
    throw new ValidationError('适配器接口版本不匹配', {
      expected: ADAPTER_INTERFACE_VERSION,
      actual: String(capabilities?.interfaceVersion ?? 'missing'),
    })
  }
  return Object.freeze({
    ...spec,
    id: String(spec.id),
    version: String(spec.version),
  })
}

/**
 * Shared plan validation every adapter can extend.
 *
 * Checks the things that are true for any runtime, then demands the adapter's own capability
 * answers for kinds, transitions, motions and output size.
 *
 * @param {any} plan
 * @param {any} capabilities
 * @param {{ materialExists?: (file: string) => boolean, fontExists?: (file: string) => boolean }} [context]
 * @returns {{ ok: boolean, problems: Array<{ code: string, detail: string, remedy?: string }> }}
 */
export function validateCommon(plan, capabilities, context = {}) {
  /** @type {Array<{ code: string, detail: string, remedy?: string }>} */
  const problems = []
  const supportedKinds = new Set(capabilities?.objectKinds ?? [])
  for (const object of plan.objects ?? []) {
    if (!supportedKinds.has(object.kind)) {
      problems.push({
        code: 'object-kind-unsupported',
        detail: `运行时 ${String(capabilities?.runtimeId)} 不支持对象类型 ${object.kind}（${object.id}）`,
        remedy: '改用支持该类型的运行时，或把该对象替换为受支持的等价对象并生成新版本',
      })
    }
    const motion = object.motion
    if (motion !== undefined && motion !== null) {
      if (!(capabilities?.motions ?? []).includes(motion.term)) {
        problems.push({
          code: 'motion-unsupported',
          detail: `运行时 ${String(capabilities?.runtimeId)} 不支持运动术语 ${String(motion.term)}（${object.id}）`,
          remedy: '改用受支持的运动，或换用支持该术语的运行时',
        })
      }
    }
  }
  const supportedTransitions = new Set(capabilities?.transitions ?? [])
  for (const transition of plan.transitions ?? []) {
    if (!supportedTransitions.has(transition.kind)) {
      problems.push({
        code: 'transition-unsupported',
        detail: `运行时不支持转场 ${transition.kind}（${transition.id}）`,
        remedy: '改用语支支持的转场并重新验证总时长',
      })
    }
  }
  const maxSize = capabilities?.limits?.maxFrameSize
  if (maxSize !== undefined) {
    if (plan.outputSpec.width > maxSize.width || plan.outputSpec.height > maxSize.height) {
      problems.push({
        code: 'frame-size-unsupported',
        detail: `${plan.outputSpec.width}×${plan.outputSpec.height} 超过运行时上限 ${maxSize.width}×${maxSize.height}`,
      })
    }
  }
  for (const material of plan.materials ?? []) {
    if (context.materialExists !== undefined && !context.materialExists(material.file)) {
      problems.push({
        code: 'material-missing',
        detail: `素材缺失：${material.file}`,
        remedy: '在项目中重新定位或替换素材；不要静默跳过',
      })
    }
  }
  for (const font of plan.fonts ?? []) {
    if (context.fontExists !== undefined && !context.fontExists(font.file)) {
      problems.push({
        code: 'font-missing',
        detail: `字体缺失：${font.family}（${font.file}）`,
        remedy: '安装字体或改用已安装字体并重排文字；不得静默回退到系统默认字体',
      })
    }
  }
  return { ok: problems.length === 0, problems }
}
