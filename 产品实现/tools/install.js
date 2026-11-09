/**
 * The shared adopt / verify / rollback lifecycle.
 *
 * With the manual-guidance decision (user, 2026-11-08) the plugin **does not download, unpack, install or
 * update** external tools. What it does is the harder half:
 *
 * ```text
 * plan (7 disclosures) -> explicit scoped authorization -> record the location the user installed
 *   -> run the pack's verification checks against THAT location -> derive the real status
 * ```
 *
 * So "adopt" means: the user tells us where their tool is, we record it, and then we prove what it is by
 * reading its files and — only with authorization — running its own version command. The plugin never
 * writes inside a tool's directory. That asymmetry is deliberate: a plugin that cannot write to a user's
 * install cannot break it, no matter what its bookkeeping says.
 *
 * Properties this module maintains structurally rather than by intention:
 *
 * - **No network, no process of its own.** A version probe is an injected `executor` and needs its own
 *   authorization; there is no other way to run anything from here.
 * - **No bytes are written to `toolsRoot`.** The only writes are state records under `stateRoot`.
 * - **An adopted record never overwrites a verification it cannot justify.** Changing location discards the
 *   old verification, because the old one was about the bytes at the old path.
 * - **Failure and cancellation leave the previous record intact.** A failed adopt does not erase a working
 *   adoption, and a cancelled task leaves nothing that reads as verified.
 * - **Unknown outcome is its own state.** A probe that throws without a trustworthy result becomes
 *   `unknown`, not `failed`, and is not retried automatically.
 *
 * @module tools/install
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  AbortedError,
  Clock,
  ConflictError,
  ErrorCode,
  ExternalError,
  IoError,
  ValidationError,
  WorkbenchError,
  sha256,
} from '../base/index.js'
import { TaskKind, TaskState, VerificationBasis, VerificationStatus, CatalogClass } from './schema.js'
import { assertBuildSegment, assertTaskId, assertToolId } from './paths.js'
import { parseVersion, sameBuild, tryParseVersion } from './version.js'
import { buildDisclosure, toolRangeVerdict } from './catalog.js'
import {
  assertPermissions,
  beginExecution,
  endExecution,
  normalizeChannel,
  resolveExecutionRoute,
  schemaFingerprint,
} from './channels.js'
import { PermissionKind } from './schema.js'
import { pinBlockingUpgrade } from './state.js'
import { actionForKind, normalizeProjectRef } from './tasks.js'

/**
 * Actions an authorization can cover. One per task kind, so the action a user agrees to is the action the
 * task performs; `tools/tasks.js#actionForKind` is the single source of truth for the mapping.
 */
export const AUTHORIZED_ACTION = Object.freeze({
  ADOPT: 'adopt-install',
  VERIFY: 'verify-install',
  ROLLBACK: 'rollback-build',
})

/**
 * The adopt/verify/rollback lifecycle for one open workbench.
 */
export class ToolLifecycle {
  /**
   * @param {object} input
   * @param {import('./paths.js').ToolPaths} input.paths
   * @param {object} input.catalog
   * @param {import('./tasks.js').TaskStore} input.tasks
   * @param {import('./state.js').ToolStateStore} input.states
   * @param {Clock} [input.clock]
   * @param {(entry: object) => void} [input.log]
   */
  constructor(input) {
    this.paths = input?.paths
    this.catalog = input?.catalog
    this.tasks = input?.tasks
    this.states = input?.states
    this.clock = input?.clock ?? new Clock()
    this.log = typeof input?.log === 'function' ? input.log : () => {}
    for (const field of ['paths', 'catalog', 'tasks', 'states']) {
      if (this[field] === null || this[field] === undefined) {
        throw new ValidationError('ToolLifecycle 缺少必要依赖', { field })
      }
    }
  }

  /**
   * Build an adopt plan: what would be recorded, where, and how to undo it. Nothing is executed.
   *
   * The plan is what the UI turns into the pre-execution disclosure, and its hash is what an authorization
   * is bound to.
   *
   * @param {object} input
   * @param {string} input.toolId
   * @param {string} input.location absolute path of the tool the user installed
   * @param {string} input.version the version found there (from detection or the user's statement)
   * @param {{ projectId: string, projectVersion?: string|null }|null} [input.projectRef]
   * @returns {object}
   */
  planAdoption(input) {
    const toolId = assertToolId(input?.toolId)
    const entry = this.catalog.toolIndex.get(toolId)
    if (entry === undefined) {
      throw new ValidationError('工具不在正式支持目录中', { toolId })
    }
    const tool = entry.definition
    // A research candidate may not enter the adoption flow at all. `deriveToolStatus` would also refuse to
    // call it usable, but relying on that final layer means one relaxation of the derivation order would let
    // a candidate into production (V-07). This is the FIRST of two independent gates, not the last.
    if (tool.catalogClass === CatalogClass.RESEARCH_CANDIDATE) {
      throw new ValidationError('调研候选不能进入采纳流程', {
        toolId,
        catalogClass: tool.catalogClass,
        action: '候选未经用户采用与验证，不得进入制作；请先在目录中把它转为正式支持',
      })
    }
    const location = requireAbsoluteLocation(input?.location, 'location')
    const targetVersion = requireText(input?.targetVersion ?? input?.version, 'targetVersion')

    const range = toolRangeVerdict(tool, targetVersion)
    if (!range.matched) {
      // Adopting an out-of-range build would create a record that can never verify.
      throw new ValidationError('目标版本不在该工具的正式支持范围内', {
        toolId,
        targetVersion,
        reason: range.reason,
        supported: tool.supportedVersions.raw,
      })
    }
    const parsed = parseVersion(targetVersion)
    const buildSegment = assertBuildSegment(
      `${parsed.core()}${parsed.qualifier === '' ? '' : `-${parsed.qualifier}`}`,
    )
    const state = this.states.read(toolId)
    // A pin from an existing project blocks the change: that project's output was made with the pinned
    // build, so switching without asking would silently change it (C06 §4.2).
    const pinCheck = pinBlockingUpgrade(state, targetVersion)
    const disclosure = buildDisclosure(tool, { targetVersion, installLocation: location })
    return {
      toolId,
      tool,
      packId: entry.packId,
      kind: TaskKind.ADOPT,
      targetVersion,
      targetBuildSegment: buildSegment,
      installLocation: location,
      previousVersion: state.currentBuild?.version ?? null,
      disclosure,
      currentStatus: state,
      pinBlocked: pinCheck.blocked,
      pin: pinCheck.pin,
      projectRef: normalizeProjectRef(input?.projectRef),
      /** This kernel never installs anything; the flag exists so a caller cannot ask it to. */
      canAutomate: false,
      authorizationRequired: true,
    }
  }

  /**
   * Create the task for a plan and leave it waiting for the user's answer.
   *
   * Deliberately does NOT authorize anything: this is the step that produces the disclosure a surface
   * shows, and the next call must come from the user's own answer.
   *
   * @param {object} plan a value from {@link ToolLifecycle#planAdoption}
   * @returns {{ task: object, plan: object }}
   */
  createAdoptionTask(plan) {
    if (plan?.pinBlocked === true) {
      throw new ConflictError('已有项目锁定该工具的其他版本，不能静默切换', {
        toolId: plan.toolId,
        pinnedBy: plan.pin?.projectId ?? null,
        pinnedVersion: plan.pin?.version ?? null,
        target: plan.targetVersion,
        action: '请先让相关项目迁移到新版本，或明确接受影响后再操作',
      })
    }
    const task = this.tasks.create({
      kind: plan.kind,
      toolId: plan.toolId,
      targetVersion: plan.targetVersion,
      targetBuildSegment: plan.targetBuildSegment,
      targetLocation: plan.installLocation,
      disclosure: plan.disclosure,
      previousVersion: plan.previousVersion,
      projectRef: plan.projectRef,
    })
    this.states.recordTask(plan.toolId, task.taskId)
    this.log({ event: 'task-created', taskId: task.taskId, toolId: plan.toolId, kind: plan.kind })
    return { task, plan }
  }

  /**
   * Execute an authorized adopt task.
   *
   * Returns a structured result rather than throwing for an expected failure, so a surface can show "failed,
   * previous record kept" instead of an error dialog. Genuine programming faults still throw.
   *
   * @param {string} taskId
   * @param {{ signal?: { aborted?: boolean }, executor?: object, description?: object }} [options]
   * @returns {Promise<object>}
   */
  async runAdoption(taskId, options = {}) {
    const task = this.tasks.read(taskId)
    if (task.kind === TaskKind.ROLLBACK) return this.runRollback(taskId, options)
    const tool = this.catalog.toolIndex.get(task.toolId)?.definition
    if (tool === undefined) {
      throw new ValidationError('任务引用的工具不在目录中', { toolId: task.toolId })
    }
    if (task.authorization === null) {
      // Running a task that has not been authorized does NOT consume or fail it: it is still waiting for the
      // user's answer, and marking it failed would make that answer impossible to give afterwards.
      this.log({ event: 'task-refused-unauthenticated', taskId })
      return {
        ok: false,
        taskId,
        needsAuthorization: true,
        failure: { code: 'CONFLICT', message: '没有用户授权，不能执行工具动作' },
      }
    }
    try {
      const expectedAction = actionForKind(task.kind)
      this.tasks.requireAuthorization(taskId, expectedAction)
      // Claim the task for THIS process, so a later reader can tell "actually running" from "abandoned by a
      // process that died mid-flight" (C06 §4.2).
      this.tasks.markRunning(taskId)

      // ---- step 1: the location must still be a real directory with the tool in it ------------------
      this.assertNotCancelled(taskId, options.signal)
      this.tasks.transition(taskId, TaskState.VERIFYING, { step: 'locate' })
      const located = this.locateTool({ tool, location: task.targetLocation })
      if (located.missing.length > 0) {
        // An executable was found (locateTool would have thrown otherwise); a missing manifest is recorded
        // as a real gap rather than being smoothed over, because the verification checks will judge it.
        this.log({ event: 'adopt-manifest-missing', taskId, missing: located.missing.slice(0, 6) })
      }

      // ---- step 2: record the user's install; the plugin writes nothing there ----------------------
      this.tasks.recordAuthorizationUse(taskId, {
        action: expectedAction,
        detail: { step: 'adopt', location: located.root },
      })
      this.states.recordAdoption(task.toolId, {
        version: task.targetVersion,
        buildSegment: task.targetBuildSegment,
        location: located.root,
        origin: tool.origin,
        taskId,
        files: located.files,
      })

      // ---- step 3: verify against that exact location ---------------------------------------------
      const verification = await this.verifyLocated({
        tool,
        task,
        location: located.root,
        options,
      })
      return this.settle({
        taskId,
        tool,
        version: task.targetVersion,
        verification,
        extra: { location: located.root, adoptedFiles: located.files.length },
      })
    } catch (error) {
      return this.failTask(taskId, error, options)
    }
  }

  /**
   * Re-verify an adopted install without changing what is adopted.
   *
   * Needed after the user updates a tool themselves, after an environment change, and when a previously
   * inconclusive verification (one that could not run the tool) gains an authorized executor.
   *
   * @param {string} taskId
   * @param {{ executor?: object, description?: object }} [options]
   * @returns {Promise<object>}
   */
  async runReverify(taskId, options = {}) {
    const task = this.tasks.read(taskId)
    const tool = this.catalog.toolIndex.get(task.toolId)?.definition
    if (tool === undefined) throw new ValidationError('工具不在目录中', { toolId: task.toolId })
    if (task.authorization === null) {
      this.log({ event: 'task-refused-unauthenticated', taskId })
      return {
        ok: false,
        taskId,
        needsAuthorization: true,
        failure: { code: 'CONFLICT', message: '没有用户授权，不能执行工具动作' },
      }
    }
    try {
      this.tasks.requireAuthorization(taskId, actionForKind(task.kind))
      this.tasks.markRunning(taskId)
      this.tasks.transition(taskId, TaskState.VERIFYING, { step: 'reverify' })
      const located = this.locateTool({ tool, location: task.targetLocation })
      if (located.missing.length > 0) {
        // A record that claims a location whose files are gone is an unknown state, not "not installed".
        this.log({ event: 'reverify-manifest-missing', taskId, missing: located.missing.slice(0, 6) })
      }
      const verification = await this.verifyLocated({ tool, task, location: located.root, options })
      return this.settle({ taskId, tool, version: task.targetVersion, verification, extra: { location: located.root } })
    } catch (error) {
      return this.failTask(taskId, error, options)
    }
  }

  /**
   * Plan a rollback to a previously adopted build.
   *
   * With manual installs the plugin cannot restore bytes; it switches which recorded location is current.
   * A rollback therefore still needs its own disclosure and authorization, and the selected build must be
   * re-verified: an old build was verified in the past, but the user may have moved or removed it since.
   *
   * @param {object} input
   * @param {string} input.toolId
   * @param {string} [input.toVersion] defaults to the retained previous build
   * @param {{ projectId: string, projectVersion?: string|null }|null} [input.projectRef]
   * @returns {object}
   */
  planRollback(input) {
    const toolId = assertToolId(input?.toolId)
    const entry = this.catalog.toolIndex.get(toolId)
    if (entry === undefined) throw new ValidationError('工具不在正式支持目录中', { toolId })
    const tool = entry.definition
    if (tool.catalogClass === CatalogClass.RESEARCH_CANDIDATE) {
      throw new ValidationError('调研候选没有采纳记录，不能回退', { toolId })
    }
    const state = this.states.read(toolId)
    const targetVersion = input?.toVersion ?? state.previousBuild?.version ?? null
    if (targetVersion === null) {
      throw new ValidationError('没有可回退的旧版本', {
        toolId,
        action: '该工具只采纳过一个版本，无法回退',
      })
    }
    const known = state.builds.find((build) => sameBuild(build.version, targetVersion))
    if (known === undefined) {
      throw new ValidationError('目标版本不在已采纳记录中，不能回退', { toolId, version: targetVersion })
    }
    if (state.currentBuild !== null && sameBuild(state.currentBuild.version, targetVersion)) {
      throw new ConflictError('目标版本已经是当前版本', { toolId })
    }
    const parsed = parseVersion(targetVersion)
    const buildSegment = known.buildSegment ?? parsed.core()
    const disclosure = buildDisclosure(tool, { targetVersion, installLocation: known.location })
    return {
      toolId,
      tool,
      packId: entry.packId,
      kind: TaskKind.ROLLBACK,
      targetVersion,
      targetBuildSegment: buildSegment,
      installLocation: known.location,
      previousVersion: state.currentBuild?.version ?? null,
      disclosure,
      projectRef: normalizeProjectRef(input?.projectRef),
      canAutomate: false,
      authorizationRequired: true,
    }
  }

  /**
   * Execute an authorized rollback.
   * @param {string} taskId
   * @param {{ executor?: object, description?: object }} [options]
   * @returns {Promise<object>}
   */
  async runRollback(taskId, options = {}) {
    const task = this.tasks.read(taskId)
    if (task.kind !== TaskKind.ROLLBACK) {
      throw new ValidationError('该任务不是回退任务', { taskId, kind: task.kind })
    }
    if (task.authorization === null) {
      this.log({ event: 'task-refused-unauthenticated', taskId })
      return {
        ok: false,
        taskId,
        needsAuthorization: true,
        failure: { code: 'CONFLICT', message: '没有用户授权，不能执行工具动作' },
      }
    }
    try {
      this.tasks.requireAuthorization(taskId, actionForKind(TaskKind.ROLLBACK))
      this.tasks.markRunning(taskId)
      const tool = this.catalog.toolIndex.get(task.toolId)?.definition
      if (tool === undefined) throw new ValidationError('工具不在目录中', { toolId: task.toolId })
      this.tasks.transition(taskId, TaskState.VERIFYING, { step: 'rollback' })
      const located = this.locateTool({ tool, location: task.targetLocation })
      if (located.missing.length > 0) {
        // A rollback whose target is gone must not read as available; record the gap, then verify.
        this.log({ event: 'rollback-manifest-missing', taskId, missing: located.missing.slice(0, 6) })
      }
      const state = this.states.selectBuild(task.toolId, task.targetVersion)
      this.tasks.recordAuthorizationUse(taskId, {
        action: AUTHORIZED_ACTION.ROLLBACK,
        detail: { to: task.targetVersion, location: state.currentBuild.location },
      })
      const verification = await this.verifyLocated({
        tool,
        task,
        location: state.currentBuild.location,
        options,
      })
      return this.settle({
        taskId,
        tool,
        version: task.targetVersion,
        verification,
        extra: { rolledBack: true, location: state.currentBuild.location },
      })
    } catch (error) {
      return this.failTask(taskId, error, options)
    }
  }

  /**
   * Confirm a location actually contains the declared tool, and record what was found.
   *
   * This is a READ-ONLY check of the user's own install. It never writes, never moves and never deletes
   * anything there — the plugin has no reason to touch a program it did not install.
   *
   * @param {{ tool: object, location: string }} input
   * @returns {{ root: string, files: Array<{ path: string, sha256: string, bytes: number }>, missing: string[] }}
   */
  locateTool(input) {
    const root = path.resolve(input.location)
    let stat
    try {
      stat = fs.statSync(root)
    } catch {
      throw new IoError('指定的安装位置不存在', {
        details: { stage: 'locate', reason: 'ENOENT' },
      })
    }
    if (!stat.isDirectory()) {
      throw new ValidationError('指定的安装位置不是目录', { field: 'location' })
    }
    /** @type {string[]} */
    const missing = []
    /** @type {Array<{ path: string, sha256: string, bytes: number }>} */
    const files = []
    const detection = input.tool?.detection ?? {}
    /** @type {string[]} */
    const executables = [...(detection.executables ?? [])]
    /** @type {string[]} */
    const manifests = [...(detection.manifestFiles ?? [])]

    /**
     * Executables are declared as ALTERNATIVES, not a checklist: `bin/ffmpeg.exe` (Windows) and
     * `bin/ffmpeg` (POSIX) describe the same program on different platforms, and demanding both would
     * make a correct install look broken. Presence of at least one is what proves the tool is here;
     * exact per-file rigour belongs to the verification checks, which name one path each.
     */
    let foundExecutable = false
    for (const relative of executables) {
      const target = safeJoin(root, relative)
      if (target === null) continue
      if (!fs.existsSync(target)) {
        missing.push(relative)
        continue
      }
      foundExecutable = true
      this.#recordFile(files, root, relative, target)
    }
    if (!foundExecutable) {
      throw new ValidationError('在指定位置没有找到该工具的可执行文件', {
        field: 'location',
        tried: executables.slice(0, 6),
        action: '请确认指向的是工具安装根目录（例如包含 bin/ 的那一层）',
      })
    }

    // Manifests are evidence that can be read, but their absence is not proof the tool is missing: a
    // distribution may ship none. They are recorded when present and reported when absent.
    for (const relative of manifests) {
      const target = safeJoin(root, relative)
      if (target === null) {
        missing.push(`${relative}（路径不安全）`)
        continue
      }
      if (!fs.existsSync(target)) {
        missing.push(relative)
        continue
      }
      this.#recordFile(files, root, relative, target)
    }

    if (executables.length === 0 && manifests.length === 0) {
      throw new ValidationError('该工具没有声明任何可核对的相对路径，无法采纳', {
        field: 'detection',
      })
    }
    return { root, files, missing }
  }

  /**
   * Read one located file's identity for the adoption record. Read-only; the plugin never writes here.
   * @param {Array<{ path: string, sha256: string, bytes: number }>} files
   * @param {string} root
   * @param {string} relative
   * @param {string} target
   */
  #recordFile(files, root, relative, target) {
    try {
      const bytes = fs.readFileSync(target)
      files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length })
    } catch {
      files.push({ path: relative, sha256: 'unreadable', bytes: -1 })
    }
    void root
  }

  /**
   * Run the pack's verification checks against a real located tool.
   *
   * The basis is recorded honestly: `real-tool` only when a check actually ran the tool through an
   * authorized executor that is not a declared test double. A caller cannot pass `real-tool` for a
   * file-only run or for a double, because the basis is derived from what ran.
   *
   * @param {{ tool: object, task: object, location: string, options: object }} input
   * @returns {Promise<object>}
   */
  async verifyLocated(input) {
    const { tool, task, location, options } = input
    /**
     * CT-14 §3 ToolExecutionProtocol, applied to the one place this kernel actually runs something: a
     * verification that may invoke the tool. Before doing anything it reads the declared channel and asserts
     * the operation's permissions; afterwards it records the observed state so "执行后读回真实结果" is a
     * recorded fact rather than a promise.
     */
    const channel = normalizeChannel({
      kind: tool.channel,
      permissions: tool.permissions,
      entrypoint:
        tool.channel === 'cli'
          ? (tool.detection?.versionProbe?.command ?? path.basename(String(tool.toolId)))
          : null,
      serverName: tool.channel === 'mcp' ? tool.displayName : null,
      socketPath: null,
    })
    assertPermissions(channel, requiredPermissionsFor(tool))
    /**
     * Prefer the structured route (CT-14 §3.3). A verification that needs to run the tool may only take the
     * arbitrary-code path when the channel has no structured alternative AND the caller carries a CT-12 code
     * authorization; otherwise this throws rather than silently downgrading.
     */
    const route = resolveExecutionRoute({
      channel,
      wantsArbitraryCode: options?.arbitraryCode === true,
      codeAuthorizationId: options?.codeAuthorizationId ?? null,
    })
    const envelope = beginExecution({
      callId: `verify-${task.taskId}`,
      toolId: tool.toolId,
      beforeState: {
        taskState: task.state,
        adoptedVersion: this.states.read(tool.toolId).currentBuild?.version ?? null,
        location,
        route: route.route,
      },
    })

    /** @type {Array<{ id: string, ok: boolean, detail: string, blocked?: boolean }>} */
    const checks = []
    /** Whether any check actually invoked a tool through an executor (real or double). */
    let ranExecutor = false
    for (const check of tool.verificationChecks) {
      const outcome = await this.runCheck({ check, location, options })
      checks.push(outcome)
      if (outcome.ranExecutor === true) ranExecutor = true
    }
    const failed = checks.filter((check) => check.ok !== true && check.blocked !== true)
    const blocked = checks.filter((check) => check.blocked === true)
    /**
     * Three distinct statements, and conflating them is exactly the dishonesty this card forbids:
     * - `real-tool`: the actual tool was invoked and its output checked;
     * - `test-double`: something was invoked, but it was a declared substitute — proves the kernel only;
     * - `declared-only`: nothing was invoked at all; only files were inspected.
     */
    const executorIsTestDouble = options?.executor?.marksTestDouble === true
    const basis = ranExecutor
      ? executorIsTestDouble
        ? VerificationBasis.TEST_DOUBLE
        : VerificationBasis.REAL_TOOL
      : VerificationBasis.DECLARED_ONLY
    const description = options?.description ?? null
    const fingerprint =
      description === null ? null : schemaFingerprint({ ...description, version: task.targetVersion }).fingerprint
    /**
     * Three outcomes, not two. A check that could not run (no authorized executor) is NOT a failure: calling
     * it "验证失败" would tell the user their tool is broken when nobody looked. It becomes `inconclusive`,
     * which reads as 已安装未验证 — the truth.
     */
    const status =
      failed.length > 0
        ? VerificationStatus.FAILED
        : blocked.length > 0
          ? VerificationStatus.INCONCLUSIVE
          : VerificationStatus.PASSED
    const record = {
      status,
      basis,
      version: task.targetVersion,
      schemaFingerprint: fingerprint,
      at: this.clock.iso(),
      checks,
      reason:
        failed.length > 0
          ? `以下检查未通过：${failed.map((check) => check.id).join('、')}`
          : blocked.length > 0
            ? `以下检查需要授权后运行工具才能完成：${blocked.map((check) => check.id).join('、')}`
            : null,
    }
    this.states.recordVerification(task.toolId, record)
    // Read back the real post-state and attach it, so the execution has a recorded before/after pair.
    endExecution(envelope, {
      afterState: {
        verificationStatus: status,
        basis,
        currentBuild: this.states.read(tool.toolId).currentBuild?.version ?? null,
        location,
      },
      result: { status, basis, checks: checks.length },
      completedAt: this.clock.iso(),
    })
    return record
  }

  /**
   * Run one declared verification check against a located tool.
   * @param {{ check: object, location: string, options: object }} input
   * @returns {Promise<{ id: string, ok: boolean, detail: string, ranExecutor?: boolean, blocked?: boolean }>}
   */
  async runCheck(input) {
    const { check, location, options } = input
    // A `file-*` check inspects the located directory; the others run the tool from it.
    const target = check.relativePath === undefined ? null : safeJoin(location, check.relativePath)
    try {
      switch (check.kind) {
        case 'file-exists': {
          const exists = target !== null && fs.existsSync(target)
          return { id: check.id, ok: exists, detail: exists ? '存在' : `缺少 ${check.relativePath}` }
        }
        case 'file-hash': {
          if (target === null || !fs.existsSync(target)) {
            return { id: check.id, ok: false, detail: `缺少 ${check.relativePath}` }
          }
          const actual = sha256(fs.readFileSync(target))
          return {
            id: check.id,
            ok: actual === check.sha256,
            detail: actual === check.sha256 ? '哈希一致' : '哈希不一致',
          }
        }
        case 'file-contains': {
          if (target === null || !fs.existsSync(target)) {
            return { id: check.id, ok: false, detail: `缺少 ${check.relativePath}` }
          }
          const text = fs.readFileSync(target, 'utf8')
          const found = text.includes(check.contains)
          return { id: check.id, ok: found, detail: found ? '包含预期内容' : '未包含预期内容' }
        }
        case 'version-match': {
          const executor = options?.executor ?? null
          if (executor === null || typeof executor.runVersionProbe !== 'function') {
            return {
              id: check.id,
              ok: false,
              blocked: true,
              detail: '需要授权的执行器才能核对真实版本；仅凭文件不能证明',
            }
          }
          // The same gate detection uses: an executor must prove it was authorized, and a declared double
          // must say so. Without this, a naked object with a `runVersionProbe` method could be taken as
          // proof that a real tool was run (V-02).
          assertVerifyExecutorSafe(executor)
          const probe = await executor.runVersionProbe({
            command: check.command ?? '',
            args: check.args ?? [],
            cwd: location,
            timeoutMs: options?.timeoutMs ?? 15_000,
          })
          const observed = String(probe?.stdout ?? '').trim()
          /**
           * Parse both sides and compare builds. A substring test would accept `11.0.0` for `1.0.0` and
           * `1.0.0-rc1` for `1.0.0` (V-01) — exactly the "looks like the right version" failure this card
           * exists to prevent.
           */
          const expected = tryParseVersion(check.expectedBuild)
          const found = findReportedVersion(observed, check.command)
          if (expected.ok !== true) {
            return { id: check.id, ok: false, detail: '目录声明的期望版本无法解析，按未通过处理' }
          }
          if (found === null) {
            return { id: check.id, ok: false, detail: '版本命令输出中没有可识别的版本号' }
          }
          const same = sameBuild(found, expected.version)
          return {
            id: check.id,
            ok: same,
            detail: same ? '真实版本一致' : `真实版本不一致（期望 ${expected.version.raw}，实际 ${found.raw}）`,
            ranExecutor: true,
          }
        }
        case 'self-check': {
          const executor = options?.executor ?? null
          if (executor === null || typeof executor.runSelfCheck !== 'function') {
            return {
              id: check.id,
              ok: false,
              blocked: true,
              detail: '需要授权的执行器才能运行自检；仅凭文件不能证明',
            }
          }
          assertVerifyExecutorSafe(executor)
          const result = await executor.runSelfCheck({
            command: check.command,
            args: check.args ?? [],
            cwd: location,
            timeoutMs: options?.timeoutMs ?? 30_000,
          })
          const ok = result?.exitCode === (check.expectExitCode ?? 0)
          return { id: check.id, ok, detail: `exit=${String(result?.exitCode)}`, ranExecutor: true }
        }
        default:
          return { id: check.id, ok: false, detail: '未知检查类型，按未通过处理' }
      }
    } catch (error) {
      return {
        id: check.id,
        ok: false,
        detail: error instanceof Error ? `检查抛出异常：${error.message}` : '检查抛出异常',
      }
    }
  }

  /**
   * Turn a completed verification into a task outcome.
   *
   * A failed verification is a real failure; an inconclusive one is NOT — the tool may be fine and simply
   * not yet proven, so the task is recorded as unknown-state (never auto-resumed) rather than failed.
   *
   * @param {object} input
   * @returns {object}
   */
  settle(input) {
    const { taskId, tool, version, verification, extra } = input
    const failed = verification.status === VerificationStatus.FAILED
    const result = {
      ok: verification.status === VerificationStatus.PASSED,
      taskId,
      toolId: tool.toolId,
      version,
      location: extra?.location ?? null,
      ...extra,
      verification,
      // A non-passing outcome must carry the reason in the same field a caller already reads for other
      // failures, so `result.failure` is never silently empty on a failed run.
      failure: failed ? { code: 'VERIFICATION_FAILED', message: verification.reason ?? '核对未通过' } : null,
    }
    if (verification.status === VerificationStatus.PASSED) {
      this.tasks.complete(taskId, result)
    } else if (verification.status === VerificationStatus.INCONCLUSIVE) {
      this.tasks.markUnknown(taskId, verification.reason ?? '核对未完成')
    } else {
      this.tasks.fail(taskId, {
        code: 'VERIFICATION_FAILED',
        message: verification.reason ?? '核对未通过',
      })
    }
    this.log({
      event: 'task-finished',
      taskId,
      ok: result.ok,
      verificationStatus: verification.status,
    })
    return result
  }

  /**
   * Record a failure without erasing what was working before.
   * @param {string} taskId
   * @param {unknown} error
   * @param {{ signal?: { aborted?: boolean } }} options
   * @returns {object}
   */
  failTask(taskId, error, options) {
    if (error instanceof AbortedError || options?.signal?.aborted === true) {
      this.tasks.cancel(taskId, { reason: 'cancelled-during-run' })
      this.log({ event: 'task-cancelled', taskId })
      return { ok: false, taskId, cancelled: true, reason: '已取消，未记录任何采纳或验证结果' }
    }
    const classified = classifyFailure(error)
    // A task that is already terminal (cancelled or completed elsewhere) keeps its recorded outcome: the
    // terminal state is a fact, and a late failure must not rewrite it. The failure is reported instead of
    // thrown, so a caller still gets a structured answer.
    const current = this.tasks.read(taskId)
    if (isTaskTerminal(current.state)) {
      this.log({ event: 'task-failure-ignored-terminal', taskId, state: current.state })
      return {
        ok: false,
        taskId,
        cancelled: current.state === TaskState.CANCELLED,
        failure: { code: classified.code, message: classified.message },
        stateUnknown: false,
        previousRecordKept: true,
        note: `任务已处于终态（${current.state}），本次失败未改写它`,
      }
    }
    if (classified.stateUnknown) {
      this.tasks.markUnknown(taskId, classified.message)
    } else {
      this.tasks.fail(taskId, { code: classified.code, message: classified.message })
    }
    this.log({ event: 'task-failed', taskId, code: classified.code, stateUnknown: classified.stateUnknown })
    return {
      ok: false,
      taskId,
      cancelled: false,
      failure: { code: classified.code, message: classified.message },
      stateUnknown: classified.stateUnknown,
      previousRecordKept: true,
    }
  }

  /**
   * Cancel a task before or during execution.
   *
   * Cancelling an already-terminal task that is not failed is a no-op rather than an error, so a UI
   * double-click or a late signal cannot corrupt the record.
   *
   * @param {string} taskId
   * @param {{ reason?: string }} [input]
   * @returns {object}
   */
  cancel(taskId, input = {}) {
    const record = this.tasks.read(taskId)
    if (record.state === TaskState.COMPLETED) {
      throw new ConflictError('任务已完成，不能取消', { taskId })
    }
    const cancelled = this.tasks.cancel(taskId, input)
    this.log({ event: 'task-cancelled', taskId, reason: input.reason ?? 'cancelled-by-user' })
    return cancelled
  }

  /**
   * Throw when the caller's signal says the work was cancelled.
   * @param {string} taskId
   * @param {{ aborted?: boolean }|undefined} signal
   */
  assertNotCancelled(taskId, signal) {
    if (signal?.aborted === true) {
      throw new AbortedError('操作已取消', { taskId })
    }
  }
}

/**
 * Join a declared relative path to a located root, refusing anything that escapes it.
 *
 * The location is a user-chosen directory, so the catalog's relative paths are confined exactly like
 * untrusted input (CT-12 §3).
 *
 * @param {string} root
 * @param {string} relative
 * @returns {string|null}
 */
function safeJoin(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0) return null
  if (relative.includes('\u0000')) return null
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, relative)
  const rel = path.relative(resolvedRoot, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return target
}

/**
 * Refuse a verification executor that has not proven it is authorized.
 *
 * Detection already had this gate; verification did not, which meant any object exposing a
 * `runVersionProbe` method could be accepted and the result recorded as `real-tool` (V-02). The rule is
 * the same one CT-12 §4 states: running an external process is an environment action with its own
 * authorization, and a declared test double must identify itself.
 *
 * @param {unknown} executor
 * @returns {{ ok: true, testDouble: boolean }}
 */
export function assertVerifyExecutorSafe(executor) {
  if (executor === null || typeof executor !== 'object') {
    throw new ValidationError('验证执行器必须是对象', { field: 'executor' })
  }
  if (executor.marksTestDouble === true) {
    // A double is legitimate; it just can never yield the `real-tool` basis.
    return { ok: true, testDouble: true }
  }
  if (typeof executor.authorizationId !== 'string' || executor.authorizationId.length === 0) {
    // An unauthorized executor is refused rather than downgraded: recording anything from it would be a
    // claim nobody made.
    throw new ValidationError('验证执行器没有携带授权记录，不能采信其运行结果', {
      field: 'executor.authorizationId',
      action: '请传入携带 authorizationId 的授权执行器，或标记 marksTestDouble: true',
    })
  }
  return { ok: true, testDouble: false }
}

/**
 * Whether a task state is terminal, so a late failure must not rewrite it.
 * @param {string} state
 * @returns {boolean}
 */
function isTaskTerminal(state) {
  return (
    state === TaskState.COMPLETED ||
    state === TaskState.FAILED ||
    state === TaskState.CANCELLED ||
    state === TaskState.UNKNOWN_STATE
  )
}

/**
 * Which permissions a verification actually needs.
 *
 * A file-only check reads the install directory; any check that runs the tool also starts a process. Listing
 * them explicitly is what makes `assertPermissions` meaningful instead of decorative.
 *
 * @param {object} tool
 * @returns {string[]}
 */
function requiredPermissionsFor(tool) {
  /** @type {string[]} */
  const needed = [PermissionKind.FILESYSTEM]
  const runsTool = (tool?.verificationChecks ?? []).some(
    (check) => check.kind === 'version-match' || check.kind === 'self-check',
  )
  if (runsTool) needed.push(PermissionKind.PROCESS)
  return needed
}

/**
 * Find the version a tool's `-version` banner reports.
 *
 * Reuses the same parser detection uses, so "what version is this" has exactly one answer in the product.
 *
 * @param {string} output
 * @param {string} [command] the command name, to bias matching toward its own banner
 * @returns {import('./version.js').ToolVersion|null}
 */
function findReportedVersion(output, command) {
  const text = String(output ?? '')
  if (text.length === 0) return null
  const lines = text.split(/\r?\n/).slice(0, 6)
  // Prefer the token right after the command name (`ffmpeg version 9.0.1-...`), then fall back to the first
  // token that parses. Preferring the own banner avoids picking up a library version on a later line.
  if (typeof command === 'string' && command.length > 0) {
    for (const line of lines) {
      const match = line.match(/version\s+([vV]?\d+\.\d+[^\s,)]*)/i)
      if (match !== null) {
        const parsed = tryParseVersion(match[1])
        if (parsed.ok === true) return parsed.version
      }
    }
  }
  const firstLine = lines[0] ?? ''
  for (const token of firstLine.split(/\s+/)) {
    const cleaned = token.replace(/^[vV]/, '').replace(/[),;]$/, '')
    if (!/^\d+\.\d+/.test(cleaned)) continue
    const parsed = tryParseVersion(cleaned)
    if (parsed.ok === true) return parsed.version
  }
  return null
}

/**
 * Classify a thrown failure into a code plus whether the outside state is now unknown.
 *
 * A probe that threw after starting a process may have left the tool in an unknown condition; that is
 * `unknown`, not `failed`, because retrying could duplicate an external action (C06 §4.5).
 *
 * @param {unknown} error
 * @returns {{ code: string, message: string, stateUnknown: boolean }}
 */
export function classifyFailure(error) {
  if (error instanceof ConflictError) {
    return { code: 'CONFLICT', message: error.message, stateUnknown: false }
  }
  if (error instanceof ValidationError) {
    return { code: 'VALIDATION_FAILED', message: error.message, stateUnknown: false }
  }
  if (error instanceof ExternalError) {
    return {
      code: error.code,
      message: error.message,
      stateUnknown: error.details?.stateUnknown === true,
    }
  }
  if (error instanceof WorkbenchError) {
    return { code: error.code, message: error.message, stateUnknown: false }
  }
  const stateUnknown = error !== null && typeof error === 'object' && error.stateUnknown === true
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'INTERNAL', message: redactMessage(message), stateUnknown }
}

/** Keep a failure message free of absolute paths. */
function redactMessage(message) {
  const text = String(message).replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>')
  return text.length <= 500 ? text : `${text.slice(0, 497)}…`
}

/**
 * Require an absolute location, naming the field but never echoing a private path.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireAbsoluteLocation(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field })
  }
  if (!path.isAbsolute(value)) {
    throw new ValidationError(`${field} 必须是绝对路径`, { field })
  }
  return path.resolve(value)
}

/** @param {unknown} value @param {string} field @returns {string} */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field })
  }
  return value.trim()
}

/** Re-exported so a caller can assert a task id without importing `paths.js`. */
export { assertTaskId, ErrorCode }
