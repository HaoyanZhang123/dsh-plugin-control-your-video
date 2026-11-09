/**
 * TOOL-MANAGEMENT public interface: the ONLY entry point later cards use.
 *
 * `tools/index.js` is a facade, following the convention C04 set for `base/index.js` and C10 set for
 * `core/project/index.js`: importing the internal modules directly is acceptable for THIS card's tests but
 * not for product code, so an internal refactor cannot break a caller that only used this surface.
 *
 * The interface is frozen for the version in {@link TOOL_MANAGEMENT_INTERFACE_VERSION}. A later card that
 * needs a different shape submits a change request rather than reaching past this file (CT-00 §5.5).
 *
 * ## Scope: manual guidance only (user decision, 2026-11-08)
 *
 * The plugin does not download, unpack, install or update external tools. This facade therefore exposes
 * detection, adoption of a user's own install, authorized verification, status, pins, rollback of which
 * recorded build is current, and capability impact — and nothing that moves bytes.
 *
 * ## Ownership boundary (user decision, 2026-11-08)
 *
 * Project authorizations stay in C10; tool authorizations stay here. When a tool action is motivated by a
 * project, only `{ projectId, projectVersion }` crosses the boundary — a reference, never project facts.
 *
 * What a caller gets, in the order a surface needs it:
 *
 * ```text
 * kernel.listCapabilities()          -> per-capability real status + what still works
 * kernel.inspectTool(toolId)         -> status, version, location, manual guidance, license boundary
 * kernel.detect({ toolId, at })      -> look in a location the user named (files only by default)
 * kernel.planAdoption({ ... })       -> the 7 disclosures, no side effect
 * kernel.createAdoptionTask(plan)    -> a task waiting for the user's answer
 * kernel.authorize(taskId, ...)      -> records the USER's answer, bound to the plan hash
 * kernel.run(taskId)                 -> adopt + verify, or a structured failure
 * kernel.planRollback({ toolId })    -> the previously adopted build, with its own disclosure
 * ```
 *
 * @module tools/index
 */

import fs from 'node:fs'
import path from 'node:path'
import { Clock, NotFoundError, ValidationError } from '../base/index.js'
import { createToolPaths, ToolPaths, assertToolId } from './paths.js'
import { createDefaultCatalog, PACKS } from './packs.js'
import {
  buildCatalog,
  listOfficialTools,
  listResearchCandidates,
  requireTool,
  toolUserOutcomes,
  describeSource,
} from './catalog.js'
import { ToolStateStore, deriveToolStatus, describeState, pinBlockingUpgrade } from './state.js'
import { PinCheck, PinState, SupersedeReason, recheckPin, pinHistory, assertProjectId, assertProjectVersion } from './pins.js'
import { TaskStore, describeTaskTrail, taskEffects, planHash, actionForKind, normalizeProjectRef } from './tasks.js'
import { ToolLifecycle, AUTHORIZED_ACTION } from './install.js'
import { ToolLog, summarizeLog } from './log.js'
import {
  detectTool,
  buildManualGuidance,
  buildCandidates,
  buildSegmentFor,
  candidateFrom,
} from './detect.js'
import { computeImpact, impactSummary, capabilitiesUsingTool, impactCodeForStatus } from './impact.js'
import { normalizeChannel, describeChannel, schemaFingerprint, fingerprintChange } from './channels.js'
import {
  CatalogClass,
  DetectionMode,
  DisclosureField,
  DISCLOSURE_FIELDS,
  SupportClass,
  TaskKind,
  TaskState,
  TOOL_STATUS_LABELS,
  TOOL_MANAGEMENT_CAPABILITIES,
  ToolStatus,
  TASK_STATE_LABELS,
  VerificationBasis,
  VerificationStatus,
  isProductionUsable,
  simplifiedUserState,
  userStatusLabel,
} from './schema.js'
import { parseRange, satisfiesRange } from './version.js'

/** Version of the frozen public interface. A change means dependent cards must be re-checked. */
export const TOOL_MANAGEMENT_INTERFACE_VERSION = '2.0.0'

/**
 * Build the kernel for one workbench instance.
 *
 * @param {object} input
 * @param {object} input.paths a {@link ToolPaths}, or the roots to build one from
 * @param {object} [input.catalog] defaults to {@link createDefaultCatalog}
 * @param {Clock} [input.clock]
 * @returns {object} the kernel
 */
export function createToolKernel(input) {
  const paths =
    input?.paths instanceof ToolPaths
      ? input.paths
      : createToolPaths({
          toolsRoot: input?.toolsRoot,
          stateRoot: input?.stateRoot,
          pluginRoot: input?.pluginRoot,
          projectsRoot: input?.projectsRoot,
        })
  // Even a caller-supplied ToolPaths is re-checked here: isolation is a property of the configuration, and
  // this is the last place it can be verified before anything is written.
  paths.assertIsolated()
  const clock = input?.clock ?? new Clock()
  const catalog = input?.catalog ?? createDefaultCatalog()
  const states = new ToolStateStore(paths, { clock })
  const tasks = new TaskStore(paths, { clock })
  const log = new ToolLog(paths.logPath(), { clock })
  const lifecycle = new ToolLifecycle({
    paths,
    catalog,
    tasks,
    states,
    clock,
    log: (entry) => log.append(entry),
  })

  /**
   * Status for one tool, derived from stored facts.
   *
   * When the caller supplies the description the tool reports NOW, the recorded schema fingerprint is
   * compared against it, so an updated tool that kept its version number stops reading as `available`
   * (C06 §4.4). Leaving the description out skips only the comparison, not the rest of the derivation.
   *
   * @param {string} toolId
   * @param {{ capabilityRange?: object|null, description?: object|null }} [options]
   * @returns {{ status: string, reason: string|null, detail: object }}
   */
  function statusOf(toolId, options = {}) {
    const tool = requireTool(catalog, toolId)
    const state = states.read(toolId)
    // A live description is fingerprinted with the build the state actually recorded, so a version change
    // and a schema change are told apart rather than conflated.
    const description = options.description ?? null
    const expectedFingerprint =
      description === null
        ? null
        : schemaFingerprint({
            ...description,
            version: state.currentBuild?.version ?? 'unknown',
          }).fingerprint
    return deriveToolStatus({
      tool,
      state,
      capabilityRange: options.capabilityRange ?? null,
      expectSchemaFingerprint: expectedFingerprint,
    })
  }

  /**
   * Every tool's status, as a map, so capability impact can be computed in one pass.
   * @returns {Record<string, string>}
   */
  function statusMap() {
    /** @type {Record<string, string>} */
    const map = {}
    for (const toolId of catalog.toolIndex.keys()) {
      try {
        map[toolId] = statusOf(toolId).status
      } catch {
        // A corrupt state document makes this tool unknown, not the whole page broken.
        map[toolId] = ToolStatus.UNKNOWN
      }
    }
    return map
  }

  return {
    version: TOOL_MANAGEMENT_INTERFACE_VERSION,
    paths,
    catalog,
    states,
    tasks,
    log,
    lifecycle,

    /** Every official capability with its real state and what still stands. */
    listCapabilities(scope) {
      return computeImpact({ catalog, statusByToolId: statusMap(), scope })
    },

    /** The one-line product message a creation surface may show, or null. */
    capabilityImpactSummary(scope) {
      return impactSummary(computeImpact({ catalog, statusByToolId: statusMap(), scope }))
    },

    /** Every official tool, with its honest status. Research candidates are listed separately. */
    listTools() {
      return listOfficialTools(catalog).map((entry) => {
        const derived = statusOf(entry.toolId)
        const state = states.read(entry.toolId)
        return {
          toolId: entry.toolId,
          packId: entry.packId,
          displayName: entry.definition.displayName,
          purpose: toolUserOutcomes(catalog, entry.toolId),
          supportClass: entry.definition.supportClass,
          status: derived.status,
          label: TOOL_STATUS_LABELS[derived.status],
          userState: simplifiedUserState(derived.status),
          usable: isProductionUsable(derived.status),
          reason: derived.reason,
          supportedVersions: entry.definition.supportedVersions.raw,
          installedVersion: state.currentBuild?.version ?? null,
          installedLocation: state.currentBuild?.location ?? null,
          detectedVersion: state.detection?.version ?? null,
          license: { spdx: entry.definition.license.spdx, class: entry.definition.license.class },
          /** External-only: never shown as MIT (UI §11.1). */
          pluginMit: entry.definition.supportClass === SupportClass.PLUGIN_INTERNAL,
        }
      })
    },

    /** Research candidates, in their own list so they cannot be confused with the usable set. */
    listResearchCandidates() {
      return listResearchCandidates(catalog).map((entry) => ({
        toolId: entry.toolId,
        displayName: entry.definition.displayName,
        note: entry.definition.notes ?? null,
        usable: false,
      }))
    },

    /**
     * Everything one tool page needs for one tool, without internal hashes.
     * @param {string} toolId
     */
    inspectTool(toolId) {
      const id = assertToolId(toolId)
      const entry = catalog.toolIndex.get(id)
      if (entry === undefined) throw new NotFoundError('工具不在正式支持目录中', { toolId: id })
      const tool = entry.definition
      const state = states.read(id)
      const derived = statusOf(id)
      const range = tool.supportedVersions
      const channel = normalizeChannel({
        kind: tool.channel,
        permissions: tool.permissions,
        // A CLI declaration needs a bare command name. Prefer the declared probe command, then a declared
        // executable's basename, then the tool id — so inspecting a tool that declares no probe does not
        // throw just because its channel is CLI.
        entrypoint:
          tool.channel === 'cli'
            ? (tool.detection?.versionProbe?.command ??
              path.basename(String(tool.detection?.executables?.[0] ?? tool.toolId)).replace(/\.[^.]*$/, ''))
            : null,
        serverName: tool.channel === 'mcp' ? tool.displayName : null,
        socketPath: null,
      })
      return {
        toolId: id,
        displayName: tool.displayName,
        packId: entry.packId,
        catalogClass: tool.catalogClass,
        supportClass: tool.supportClass,
        purpose: toolUserOutcomes(catalog, id),
        status: derived.status,
        label: TOOL_STATUS_LABELS[derived.status],
        userState: simplifiedUserState(derived.status),
        usable: isProductionUsable(derived.status),
        statusReason: derived.reason,
        versions: {
          supported: range.raw,
          installed: state.currentBuild?.version ?? null,
          detected: state.detection?.version ?? null,
          previous: state.previousBuild?.version ?? null,
          inRange: state.currentBuild === null ? null : satisfiesRange(range, state.currentBuild.version).matched,
        },
        state: describeState(state),
        license: {
          spdx: tool.license.spdx,
          class: tool.license.class,
          conditions: tool.license.conditions,
          evidenceRef: tool.license.evidenceRef,
          /** Explicit, so no surface accidentally renders an external tool as plugin MIT. */
          pluginMit: tool.supportClass === SupportClass.PLUGIN_INTERNAL,
        },
        channel: describeChannel(channel),
        effects: {
          network: tool.effects.network,
          dataSubmission: tool.effects.dataSubmission,
          dataDestination: tool.effects.dataDestination,
          registration: tool.effects.registration,
          fee: tool.effects.fee,
          environmentImpact: tool.effects.environmentImpact,
        },
        source: {
          kind: tool.source.kind,
          description: describeSource(tool.source),
          obtainFrom: tool.source.obtainFrom ?? null,
        },
        /** The install path this product actually has: guidance for the user. */
        manualGuidance: buildManualGuidance(tool, paths.suggestedToolDir(id)),
        rollback: tool.rollback,
        capabilities: capabilitiesUsingTool(catalog, id),
        pins: state.pins,
        lastTaskId: state.lastTaskId,
        evidenceRefs: tool.evidenceRefs,
        notes: tool.notes ?? null,
        /** The responsibility boundary this module keeps (CR-6), stated where a UI reader will see it. */
        pinOwnership: {
          c06Owns: 'pin 的保存、校验与历史引用',
          c13Owns: '监听 C10 版本变化并调用 pin 接口同步',
          c06Never: ['读取或改写项目事实', '在 C13 同步前自行推进 projectVersion'],
        },
      }
    },

    /**
     * Run detection for one tool.
     *
     * Defaults to files-only. A version probe needs `probeAuthorized: true` AND an executor, because
     * starting a process is an environment action with its own authorization.
     *
     * When the caller also supplies the tool's structured `description`, the recorded schema fingerprint is
     * compared against it and a drift is reported in the returned status, so a capability change is caught
     * here rather than only in a unit test.
     *
     * @param {object} input
     * @param {string} input.toolId
     * @param {string} [input.at] an absolute location the user named; searched first
     * @param {Array<{ root: string, label?: string }>} [input.extra] further locations to try
     * @param {object} [input.description] the tool's structured description, when the channel exposes one
     * @param {object} [input.executor]
     * @param {boolean} [input.probeAuthorized]
     * @param {string} [input.mode]
     * @returns {Promise<object>}
     */
    async detect(input) {
      const id = assertToolId(input?.toolId)
      const tool = requireTool(catalog, id)
      // Validate every caller-supplied location BEFORE touching state. `candidateFrom` throws on a relative
      // path, and the old order marked detection in flight first, so a bad argument left the tool pinned at
      // `checking` forever (V-05).
      /** @type {Array<{ root: string, label?: string }>} */
      const extra = []
      if (input?.at !== undefined && input.at !== null) {
        extra.push(candidateFrom(input.at, '你指定的位置'))
      }
      for (const candidate of input?.extra ?? []) {
        if (candidate === null || typeof candidate !== 'object') continue
        extra.push(candidateFrom(candidate.root, candidate.label))
      }
      const candidates = buildCandidates({ ownRoot: path.join(paths.toolsRoot, id), extra })

      states.markDetectionStarted(id)
      let result
      try {
        result = await detectTool(
          {
            tool,
            candidates,
            executor: input?.executor ?? null,
            probeAuthorized: input?.probeAuthorized === true,
          },
          { mode: input?.mode ?? tool.detection.mode, clock },
        )
      } catch (error) {
        // A throwing detection must not leave the in-flight flag set: that state is unreachable from the UI
        // (it is not actionable) and would freeze the tool at `checking`.
        states.recordDetection(id, {
          outcome: 'error',
          version: null,
          mode: input?.mode ?? tool.detection.mode,
          at: clock.iso(),
          location: null,
          reason: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      states.recordDetection(id, result)
      log.append({
        event: 'detected',
        toolId: id,
        outcome: result.outcome,
        version: result.version,
        mode: result.mode,
      })
      const derived = statusOf(id, { description: input?.description ?? null })
      return {
        toolId: id,
        detection: result,
        status: derived.status,
        label: TOOL_STATUS_LABELS[derived.status],
        statusReason: derived.reason,
        /** For a not-found result, the surface needs the manual guidance right here. */
        guidance: result.outcome === 'not-found' ? buildManualGuidance(tool, paths.suggestedToolDir(id)) : null,
      }
    },

    /** Build an adopt plan. No side effect; this is what the disclosure is rendered from. */
    planAdoption(input) {
      return lifecycle.planAdoption(input)
    },

    /** Plan a rollback to the retained previous adopted build. */
    planRollback(input) {
      return lifecycle.planRollback(input)
    },

    /** Create the adopt task for a plan; it starts waiting for the user's answer. */
    createAdoptionTask(plan) {
      return lifecycle.createAdoptionTask(plan)
    },

    /**
     * Plan a re-verification of the currently adopted build.
     *
     * Needed after the user updates a tool themselves, or when a previously inconclusive verification gains
     * an authorized executor.
     *
     * @param {{ toolId: string, grantedBy?: string, projectRef?: object }} input
     * @returns {{ task: object, plan: object }}
     */
    planReverify(input) {
      const id = assertToolId(input?.toolId)
      const entry = catalog.toolIndex.get(id)
      if (entry === undefined) throw new NotFoundError('工具不在正式支持目录中', { toolId: id })
      const tool = entry.definition
      const state = states.read(id)
      if (state.currentBuild === null) {
        throw new ValidationError('该工具没有已采纳的构建，无法重新验证', { toolId: id })
      }
      const disclosure = {
        [DisclosureField.SOURCE]: '本机已记录的安装位置（不下载、不安装）',
        [DisclosureField.VERSION]: state.currentBuild.version,
        [DisclosureField.LOCATION]: state.currentBuild.location,
        [DisclosureField.DATA]: '不联网，不回传数据',
        [DisclosureField.FEE]: '无费用',
        [DisclosureField.ENVIRONMENT]: '只读取该位置的文件；如授权，会运行一次该工具的版本命令',
        [DisclosureField.ROLLBACK]: '重新验证不改变安装，无需回退',
      }
      const task = tasks.create({
        kind: TaskKind.REVERIFY,
        toolId: id,
        targetVersion: state.currentBuild.version,
        targetBuildSegment: state.currentBuild.buildSegment,
        targetLocation: state.currentBuild.location,
        disclosure,
        previousVersion: state.previousBuild?.version ?? null,
        projectRef: normalizeProjectRef(input?.projectRef),
      })
      states.recordTask(id, task.taskId)
      // The user asked for this verification, so the authorization is recorded from their request. The gate
      // is still crossed explicitly: nothing runs until `authorize` has written a scoped record.
      tasks.authorize({
        taskId: task.taskId,
        planHash: task.planHash,
        action: AUTHORIZED_ACTION.VERIFY,
        scope: `reverify ${id} ${state.currentBuild.version}`,
        grantedBy: input?.grantedBy ?? '用户请求重新验证',
      })
      return { task: tasks.read(task.taskId), plan: { tool, disclosure, kind: TaskKind.REVERIFY } }
    },

    /**
     * Record the user's authorization for a task. `actor` must be `user`.
     * @param {object} input
     */
    authorize(input) {
      const task = tasks.authorize(input)
      log.append({
        event: 'authorized',
        taskId: task.taskId,
        toolId: task.toolId,
        action: task.authorization?.action ?? null,
      })
      return task
    },

    /** Execute an authorized adopt / verify / rollback task. */
    async run(taskId, options) {
      const task = tasks.read(taskId)
      if (task.kind === TaskKind.ROLLBACK) return lifecycle.runRollback(taskId, options)
      if (task.kind === TaskKind.REVERIFY) return lifecycle.runReverify(taskId, options)
      return lifecycle.runAdoption(taskId, options)
    },

    /** Cancel a task; leaves nothing verified-looking behind. */
    cancel(taskId, options) {
      return lifecycle.cancel(taskId, options)
    },

    /**
     * Record the FIRST pin for one project version. / 记录某项目版本首次关联的工具构建。
     *
     * This is the association C13 calls when a project version gains a tool build. Callers must pass an
     * EXPLICIT `projectVersion`: this module will not use a tool-derived value as a project version, because
     * that would be C06 advancing project state (CR-6 item 6).
     *
     * @param {{ toolId: string, projectId: string, projectVersion: string, version?: string, note?: string }} input
     */
    pinForProject(input) {
      const id = assertToolId(input?.toolId)
      if (typeof input?.projectVersion !== 'string' || input.projectVersion.trim().length === 0) {
        // Refusing here is the CR-6 item 6 guard: without an explicit project version there is nothing to
        // reference, and inventing one would mean owning project facts.
        throw new ValidationError('pin 必须显式给出 projectVersion；C06 不替项目决定版本', {
          field: 'projectVersion',
          action: '请由 C10/C13 传入当前项目版本引用',
        })
      }
      const state = states.read(id)
      const version = input?.version ?? state.currentBuild?.version ?? state.detection?.version ?? null
      if (version === null) {
        throw new ValidationError('没有可锁定的工具版本；请先采纳或显式给出', { toolId: id })
      }
      return states.recordPin(id, {
        projectId: input.projectId,
        projectVersion: input.projectVersion,
        version,
        note: input.note,
      })
    },

    /**
     * Advance a project's pin when C10 reports a version change. **C13 owns calling this.**
     *
     * The old pin is superseded and kept, so the previous project version still resolves to the build it was
     * made with. A missing predecessor is refused rather than treated as "no history".
     *
     * @param {{ toolId: string, projectId: string, fromProjectVersion: string, toProjectVersion: string,
     *   version?: string, note?: string }} input
     */
    advanceProjectPin(input) {
      const id = assertToolId(input?.toolId)
      const state = states.read(id)
      const version = input?.version ?? state.currentBuild?.version ?? null
      if (version === null) {
        throw new ValidationError('没有可关联的工具版本；请先采纳', { toolId: id })
      }
      return states.advanceProjectPin(id, {
        projectId: input.projectId,
        fromProjectVersion: input.fromProjectVersion,
        toProjectVersion: input.toProjectVersion,
        version,
        note: input.note,
      })
    },

    /**
     * Explicitly re-pin ONE project version to another build, keeping the old record. Needs a reason.
     * @param {{ toolId: string, projectId: string, projectVersion: string, version: string, note: string }} input
     */
    rechooseProjectPin(input) {
      return states.rechooseProjectPin(assertToolId(input?.toolId), input)
    },

    /**
     * READ-ONLY pin alignment check for project open / resume (CR-6 item 5).
     *
     * Answers whether the pin matches the project version the project is at now, and NEVER writes. A `stale`
     * answer means "C13 has not synced this yet"; it is reported, not repaired here.
     *
     * @param {{ toolId: string, projectId: string, currentProjectVersion: string, isVersionNewer?: Function }} input
     */
    recheckProjectPin(input) {
      return states.recheckProjectPin(assertToolId(input?.toolId), {
        projectId: input.projectId,
        currentProjectVersion: input.currentProjectVersion,
        isVersionNewer: input.isVersionNewer,
      })
    },

    /**
     * Every pin for one project (including superseded history), oldest first.
     * @param {{ toolId: string, projectId: string }} input
     */
    projectPinHistory(input) {
      return states.projectPinHistory(assertToolId(input?.toolId), input?.projectId)
    },

    /** Remove one project's pins. Deletes history, so only for an explicit user action. */
    unpinForProject(input) {
      return states.clearPin(assertToolId(input?.toolId), input?.projectId)
    },

    /**
     * What a user would be told before an action runs, for a UI that must not recompose it.
     * @param {object} plan
     * @returns {{ fields: Array<{ field: string, value: string }>, effects: string[], verb: string }}
     */
    describePlan(plan) {
      const disclosure = plan?.disclosure ?? {}
      const missing = DISCLOSURE_FIELDS.filter((field) => typeof disclosure[field] !== 'string')
      if (missing.length > 0) {
        throw new ValidationError('方案缺少执行前披露', { missing })
      }
      return {
        fields: DISCLOSURE_FIELDS.map((field) => ({ field, value: disclosure[field] })),
        effects: taskEffects(plan.tool, plan.kind),
        verb:
          plan.kind === TaskKind.ROLLBACK
            ? '回退'
            : plan.kind === TaskKind.REVERIFY
              ? '重新验证'
              : '采纳并验证',
      }
    },

    /** The product-level story of one task, safe to show a user. */
    taskStory(taskId) {
      const task = tasks.read(taskId)
      return {
        taskId: task.taskId,
        toolId: task.toolId,
        kind: task.kind,
        state: task.state,
        stateLabel: TASK_STATE_LABELS[task.state],
        /** True only when THIS process is actually executing it (C06 §4.2). */
        running: tasks.isRunning(taskId),
        targetVersion: task.targetVersion,
        targetLocation: task.targetLocation,
        previousVersion: task.previousVersion,
        projectRef: task.projectRef,
        trail: describeTaskTrail(task),
        failure: task.failure,
        result: task.result,
        authorization: task.authorization === null ? null : {
          authorizedAt: task.authorization.grantedAt,
          scope: task.authorization.scope,
          validFor: task.authorization.validFor,
          uses: task.authorization.uses.length,
          projectRef: task.authorization.projectRef,
        },
      }
    },

    /**
     * The MIT boundary statement: which parts of this module are plugin content and which are not.
     *
     * C06 must keep these separate (C06 §4.4). Returning data rather than prose lets C16 read it instead of
     * trusting a README.
     */
    mitBoundary() {
      return {
        pluginInternal: {
          license: 'MIT',
          components: [
            '工具管理内核（目录、检测、授权任务、采纳记录、验证、日志、回退流程）',
            '能力包中的适配声明、参数转换与错误解释',
            '检测与验证规则、手动指引文本、工具页面文案',
          ],
          note: '以上为自写内容，纳入插件严格 MIT 核对范围。',
        },
        external: [...catalog.toolIndex.values()]
          .filter((entry) => entry.definition.supportClass === SupportClass.EXTERNAL)
          .map((entry) => ({
            toolId: entry.definition.toolId,
            displayName: entry.definition.displayName,
            spdx: entry.definition.license.spdx,
            conditions: entry.definition.license.conditions,
            evidenceRef: entry.definition.license.evidenceRef,
            pluginMit: false,
          })),
        note:
          '外部工具本体不适用插件 MIT 门槛，也不随插件再分发；其原许可与使用条件单独记录。' +
          '本条不是插件整体 MIT 已达成，实际发布包核对由 C16 完成。',
      }
    },

    /** Facts a receipt or evidence file should state instead of re-deriving them. */
    describe() {
      return {
        interfaceVersion: TOOL_MANAGEMENT_INTERFACE_VERSION,
        catalogVersion: catalog.catalogVersion,
        packCount: catalog.packs.length,
        officialToolCount: listOfficialTools(catalog).length,
        researchCandidateCount: listResearchCandidates(catalog).length,
        capabilityCount: catalog.capabilityIndex.size,
        toolStatuses: statusMap(),
        logEntries: summarizeLog(log).entries,
        limits: TOOL_MANAGEMENT_CAPABILITIES,
      }
    },
  }
}

/** Re-exported surface pieces a caller may need without importing internals. */
export {
  PACKS,
  createDefaultCatalog,
  buildCatalog,
  assertToolId,
  createToolPaths,
  ToolPaths,
  deriveToolStatus,
  describeState,
  pinBlockingUpgrade,
  describeTaskTrail,
  taskEffects,
  planHash,
  actionForKind,
  normalizeProjectRef,
  buildManualGuidance,
  buildCandidates,
  candidateFrom,
  buildSegmentFor,
  // pin responsibility boundary (CR-6)
  PinCheck,
  PinState,
  SupersedeReason,
  recheckPin,
  pinHistory,
  assertProjectId,
  assertProjectVersion,
  impactCodeForStatus,
  computeImpact,
  impactSummary,
  capabilitiesUsingTool,
  normalizeChannel,
  describeChannel,
  schemaFingerprint,
  fingerprintChange,
  parseRange,
  satisfiesRange,
  describeSource,
  userStatusLabel,
  simplifiedUserState,
  isProductionUsable,
  AUTHORIZED_ACTION,
  // vocabulary and labels
  CatalogClass,
  DetectionMode,
  DisclosureField,
  DISCLOSURE_FIELDS,
  SupportClass,
  TaskKind,
  TaskState,
  TOOL_STATUS_LABELS,
  TASK_STATE_LABELS,
  ToolStatus,
  VerificationBasis,
  VerificationStatus,
  TOOL_MANAGEMENT_CAPABILITIES,
}
