/**
 * Per-tool state: what was detected, which user-installed build was adopted, what was verified, and
 * which project pins it.
 *
 * The single most important function here is {@link deriveToolStatus}. It is a PURE function of recorded
 * facts, so the status a user sees cannot be asserted by a caller — it follows from evidence. The rules
 * it enforces are the product's status-truth rules (C06 §4.2):
 *
 * 1. a research candidate is `research-candidate` even when installed and verified;
 * 2. detection in flight is `checking`, never `available`;
 * 3. an unverified install is `installed-unverified`, never `available`;
 * 4. a verification only counts for the EXACT build it ran against AND the exact schema fingerprint
 *    observed then — "不能因工具名相同就沿用旧可用状态";
 * 5. a version below the supported minimum is `needs-update`; above the maximum is `incompatible`;
 * 6. a failed verification is `verification-failed`, which is NOT the same as never verified;
 * 7. an untrustworthy record is `unknown`, which must never be auto-retried.
 *
 * **What "installed" means now.** The plugin does not install anything, so the recorded build is a
 * location the user pointed at and the plugin verified. The state therefore stores an absolute
 * `location` per build, and the plugin never writes there — it only reads. That keeps the plugin unable
 * to break a user's install even if its own bookkeeping is wrong.
 *
 * State lives OUTSIDE the tool directory (in the state root), so clearing plugin records never touches a
 * tool, and a tool never owns project facts (C06 §4.1).
 *
 * @module tools/state
 */

import fs from 'node:fs'
import path from 'node:path'
import { Clock, ConflictError, NotFoundError, ValidationError, readJson, writeJsonAtomic } from '../base/index.js'
import { TOOL_SCHEMA_VERSION, CURRENT_TOOL_SCHEMA_GENERATION } from './schema.js'
import {
  CatalogClass,
  DetectionOutcome,
  InstallOrigin,
  RangeVerdict,
  ToolStatus,
  VerificationBasis,
  VerificationStatus,
  isProductionVerificationBasis,
} from './schema.js'
import { assertToolId } from './paths.js'
import { buildFingerprint, satisfiesRange, sameBuild, tryParseVersion } from './version.js'
import {
  advancePin,
  bindPin,
  pinHistory,
  recheckPin,
  rechooseBuild,
  normalizePin,
  assertProjectId,
  PinState,
} from './pins.js'

/**
 * @typedef {object} DetectionRecord
 * @property {string} outcome one of `DetectionOutcome`
 * @property {string|null} version detected version string, when the probe produced one
 * @property {string} mode `files-only` or `version-probe`
 * @property {string} at ISO timestamp
 * @property {string|null} location absolute location the probe looked at
 * @property {string|null} reason why it was inconclusive/error, when it was
 */

/**
 * @typedef {object} VerificationRecord
 * @property {string} status one of `VerificationStatus`
 * @property {string} basis one of `VerificationBasis`
 * @property {string} version exact build the verification ran against
 * @property {string} schemaFingerprint fingerprint of the observed description/schema
 * @property {string} at ISO timestamp
 * @property {Array<{ id: string, ok: boolean, detail: string }>} checks individual check results
 * @property {string|null} reason why it failed or was inconclusive
 */

/**
 * One adopted build: a location the user installed, recorded by the plugin.
 *
 * @typedef {object} AdoptedBuild
 * @property {string} version exact build adopted
 * @property {string} buildSegment stable key for this exact build
 * @property {string} location absolute path of the tool the user installed
 * @property {string} origin one of `InstallOrigin`
 * @property {string} adoptedAt ISO timestamp
 * @property {string} taskId the task that adopted it
 * @property {Array<{ path: string, sha256: string, bytes: number }>} [files] declared files inspected
 */

/**
 * @typedef {object} ToolPin
 * @property {string} version exact build the project used
 * @property {string} projectId which project pins it
 * @property {string} [projectVersion] the project version the pin was recorded against (reference only)
 * @property {string} at ISO timestamp
 */

/** An empty, valid state document for one tool. */
function emptyState(toolId) {
  return {
    schemaVersion: TOOL_SCHEMA_VERSION.toolState,
    schemaGeneration: CURRENT_TOOL_SCHEMA_GENERATION,
    toolId,
    detection: null,
    detectionInFlight: false,
    builds: [],
    currentBuild: null,
    previousBuild: null,
    verification: null,
    pins: [],
    lastTaskId: null,
    unknownReason: null,
    updatedAt: null,
  }
}

/**
 * Read, normalize and write one tool's state document.
 *
 * Writes use `writeJsonAtomic` (atomic rename + fsync of content + read-back verification), so a crashed
 * write leaves the previous state instead of a truncated one (CT-02 §3).
 */
export class ToolStateStore {
  /**
   * @param {import('./paths.js').ToolPaths} paths
   * @param {{ clock?: Clock }} [options]
   */
  constructor(paths, options = {}) {
    this.paths = paths
    this.clock = options.clock ?? new Clock()
  }

  /**
   * Read one tool's state. An absent document is a normal empty state, not an error.
   * @param {string} toolId
   * @returns {object}
   */
  read(toolId) {
    const id = assertToolId(toolId)
    const file = this.paths.stateFor(id)
    if (!fs.existsSync(file)) return emptyState(id)
    let parsed
    try {
      parsed = readJson(file)
    } catch (error) {
      // A corrupt state file must not be treated as "nothing installed": that would silently downgrade a
      // working tool to unavailable and could trigger a needless re-adoption.
      throw new ValidationError('工具状态记录损坏，需要处理', {
        toolId: id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    return normalizeState(parsed, id)
  }

  /**
   * Write one tool's state, verifying the read-back hash.
   * @param {string} toolId
   * @param {object} state
   * @returns {{ path: string, sha256: string }}
   */
  write(toolId, state) {
    const id = assertToolId(toolId)
    const file = this.paths.stateFor(id)
    const document = {
      ...normalizeState(state, id),
      schemaVersion: TOOL_SCHEMA_VERSION.toolState,
      schemaGeneration: CURRENT_TOOL_SCHEMA_GENERATION,
      updatedAt: this.clock.iso(),
    }
    const written = writeJsonAtomic(file, document)
    return { path: file, sha256: written.sha256 }
  }

  /**
   * Apply a mutation to one tool's state and persist it.
   * @param {string} toolId
   * @param {(state: object) => object} mutate
   * @returns {object} the written state
   */
  update(toolId, mutate) {
    const current = this.read(toolId)
    const next = mutate({ ...current })
    if (next === null || typeof next !== 'object') {
      throw new ValidationError('状态更新必须返回状态对象', { toolId: String(toolId) })
    }
    this.write(toolId, next)
    return next
  }

  /**
   * Record a detection result.
   * @param {string} toolId
   * @param {DetectionRecord} detection
   * @returns {object}
   */
  recordDetection(toolId, detection) {
    if (!Object.values(DetectionOutcome).includes(detection?.outcome)) {
      throw new ValidationError('检测结果必须是已知结论', { outcome: String(detection?.outcome) })
    }
    return this.update(toolId, (state) => ({
      ...state,
      detection: {
        outcome: detection.outcome,
        version: detection.version ?? null,
        mode: detection.mode,
        at: detection.at ?? this.clock.iso(),
        location: detection.location ?? null,
        reason: detection.reason ?? null,
      },
      detectionInFlight: false,
      unknownReason: detection.outcome === DetectionOutcome.ERROR ? (detection.reason ?? '探测失败') : null,
    }))
  }

  /**
   * Mark detection as in flight.
   *
   * This is what makes "检测中不提前显示可用" real: while the flag is set, `deriveToolStatus` returns
   * `checking` regardless of what the previous detection said.
   *
   * @param {string} toolId
   * @returns {object}
   */
  markDetectionStarted(toolId) {
    return this.update(toolId, (state) => ({ ...state, detectionInFlight: true }))
  }

  /**
   * Record an adopted build: a location the user installed the tool at.
   *
   * The location is REQUIRED and is stored verbatim (not copied, not moved, not normalized into the
   * tools root). A build already recorded for the same version is re-pointed rather than duplicated,
   * because the user may have moved the install.
   *
   * @param {string} toolId
   * @param {{ version: string, buildSegment: string, location: string, origin?: string, taskId: string,
   *   files?: Array<{ path: string, sha256: string, bytes: number }> }} build
   * @returns {object}
   */
  recordAdoption(toolId, build) {
    for (const field of ['version', 'buildSegment', 'location', 'taskId']) {
      if (typeof build?.[field] !== 'string' || build[field].length === 0) {
        throw new ValidationError(`采纳记录缺少 ${field}`, { field })
      }
    }
    if (!path.isAbsolute(build.location)) {
      throw new ValidationError('采纳记录的位置必须是绝对路径', { field: 'location' })
    }
    const origin = build.origin ?? InstallOrigin.MANUAL
    if (!Object.values(InstallOrigin).includes(origin)) {
      throw new ValidationError('采纳来源未知', { origin: String(origin) })
    }
    return this.update(toolId, (state) => {
      /** @type {AdoptedBuild} */
      const record = {
        version: build.version,
        buildSegment: build.buildSegment,
        location: path.resolve(build.location),
        origin,
        adoptedAt: this.clock.iso(),
        taskId: build.taskId,
        files: Array.isArray(build.files) ? build.files : [],
      }
      const builds = state.builds.filter((existing) => !sameBuild(existing.version, record.version))
      builds.push(record)
      // Re-adopting the SAME build keeps its verification only if the location is unchanged: the
      // verification was about the bytes at that path, and a different path is a different payload until
      // proven otherwise.
      const hasCurrent = state.currentBuild !== null && state.currentBuild !== undefined
      const sameAsCurrent = hasCurrent && sameBuild(state.currentBuild.version, record.version)
      const sameLocation = sameAsCurrent && state.currentBuild.location === record.location
      return {
        ...state,
        builds,
        verification: sameLocation ? state.verification : null,
        previousBuild: state.currentBuild,
        currentBuild: {
          version: record.version,
          buildSegment: record.buildSegment,
          location: record.location,
          origin: record.origin,
        },
        detection: state.detection,
      }
    })
  }

  /**
   * Select an already-adopted build as current (used by rollback).
   * @param {string} toolId
   * @param {string} version
   * @returns {object}
   */
  selectBuild(toolId, version) {
    return this.update(toolId, (state) => {
      const target = state.builds.find((build) => sameBuild(build.version, version))
      if (target === undefined) {
        throw new NotFoundError('该构建没有被记录为已采纳，不能回退到它', { toolId: String(toolId) })
      }
      if (state.currentBuild !== null && sameBuild(state.currentBuild.version, version)) {
        throw new ConflictError('目标构建已经是当前构建', { toolId: String(toolId) })
      }
      return {
        ...state,
        previousBuild: state.currentBuild,
        currentBuild: {
          version: target.version,
          buildSegment: target.buildSegment,
          location: target.location,
          origin: target.origin,
        },
        // Selecting a different build discards the verification: it was for the other build.
        verification: null,
      }
    })
  }

  /**
   * Record a verification result.
   * @param {string} toolId
   * @param {VerificationRecord} verification
   * @returns {object}
   */
  recordVerification(toolId, verification) {
    if (!Object.values(VerificationStatus).includes(verification?.status)) {
      throw new ValidationError('验证状态未知', { status: String(verification?.status) })
    }
    if (!Object.values(VerificationBasis).includes(verification?.basis)) {
      throw new ValidationError('验证依据未知', { basis: String(verification?.basis) })
    }
    return this.update(toolId, (state) => ({
      ...state,
      verification: {
        status: verification.status,
        basis: verification.basis,
        version: verification.version,
        schemaFingerprint: verification.schemaFingerprint ?? null,
        at: verification.at ?? this.clock.iso(),
        checks: Array.isArray(verification.checks) ? verification.checks : [],
        reason: verification.reason ?? null,
      },
    }))
  }

  /**
   * Record the FIRST pin for one project version.
   *
   * Refuses to rewrite an existing (project, version) association: changing which build a version used is a
   * different, attributable operation (`rechooseProjectPin`). The old implementation filtered by projectId
   * and replaced, which is exactly the silent overwrite CR-6 forbids.
   *
   * @param {string} toolId
   * @param {{ projectId: string, projectVersion: string, version: string, note?: string }} pin
   * @returns {object}
   */
  recordPin(toolId, pin) {
    return this.update(toolId, (state) => {
      const result = bindPin(state.pins, { ...pin, at: this.clock.iso() })
      return { ...state, pins: result.pins }
    })
  }

  /**
   * Advance a project's pin when its version changes. Called by C13's coordination layer, not by C06.
   *
   * @param {string} toolId
   * @param {{ projectId: string, fromProjectVersion: string, toProjectVersion: string, version: string,
   *   reason?: string, note?: string }} input
   * @returns {object}
   */
  advanceProjectPin(toolId, input) {
    return this.update(toolId, (state) => {
      const result = advancePin(state.pins, { ...input, at: this.clock.iso() })
      return { ...state, pins: result.pins }
    })
  }

  /**
   * Explicitly re-pin one project version to another build, keeping the old record and requiring a reason.
   *
   * @param {string} toolId
   * @param {{ projectId: string, projectVersion: string, version: string, note: string }} input
   * @returns {object}
   */
  rechooseProjectPin(toolId, input) {
    return this.update(toolId, (state) => {
      const result = rechooseBuild(state.pins, { ...input, at: this.clock.iso() })
      return { ...state, pins: result.pins }
    })
  }

  /**
   * Read-only pin alignment check for project open / resume. Never writes.
   *
   * @param {string} toolId
   * @param {{ projectId: string, currentProjectVersion: string, isVersionNewer?: Function }} input
   * @returns {object}
   */
  recheckProjectPin(toolId, input) {
    return recheckPin(this.read(toolId).pins, input)
  }

  /**
   * The pin history for one project, oldest first.
   * @param {string} toolId
   * @param {string} projectId
   * @returns {object[]}
   */
  projectPinHistory(toolId, projectId) {
    return pinHistory(this.read(toolId).pins, projectId)
  }

  /**
   * Remove pins for one project.
   *
   * Kept for an explicit user action only. It deletes history, so a caller must have a real reason; the
   * normal way a pin stops being current is being superseded, not being removed.
   *
   * @param {string} toolId
   * @param {string} projectId
   * @returns {object}
   */
  clearPin(toolId, projectId) {
    assertProjectId(projectId)
    return this.update(toolId, (state) => ({
      ...state,
      pins: state.pins.filter((pin) => pin.projectId !== projectId),
    }))
  }

  /**
   * Record the task that last touched this tool, so a crash leaves a discoverable trail.
   * @param {string} toolId
   * @param {string} taskId
   * @returns {object}
   */
  recordTask(toolId, taskId) {
    return this.update(toolId, (state) => ({ ...state, lastTaskId: taskId }))
  }

  /**
   * Every tool that has a state document, for a catalog-wide status sweep.
   * @returns {string[]}
   */
  listKnownToolIds() {
    const dir = this.paths.stateGuard.resolve('tools')
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  }
}

/**
 * Normalize a read document into the current shape, refusing a newer generation.
 * @param {any} parsed
 * @param {string} toolId
 * @returns {object}
 */
function normalizeState(parsed, toolId) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('工具状态记录不是对象', { toolId })
  }
  const generation = parsed.schemaGeneration
  if (Number.isInteger(generation) && generation > CURRENT_TOOL_SCHEMA_GENERATION) {
    // Downgrading would silently drop fields, so a newer writer's document is refused instead.
    throw new ValidationError('工具状态由更新版本写入，当前版本不能安全读取', {
      toolId,
      found: generation,
      supported: CURRENT_TOOL_SCHEMA_GENERATION,
    })
  }
  return {
    ...emptyState(toolId),
    ...parsed,
    toolId,
    builds: Array.isArray(parsed.builds) ? parsed.builds : [],
    // Pins are normalized individually so a corrupt pin is reported instead of silently dropped: a dropped
    // pin would look like "this project never pinned anything".
    pins: Array.isArray(parsed.pins) ? parsed.pins.map((pin, index) => normalizePin(pin, `pins[${index}]`)) : [],
    detectionInFlight: parsed.detectionInFlight === true,
    detection: parsed.detection ?? null,
    currentBuild: parsed.currentBuild ?? null,
    previousBuild: parsed.previousBuild ?? null,
    verification: parsed.verification ?? null,
    unknownReason: parsed.unknownReason ?? null,
  }
}

/**
 * The status derivation. Pure: same facts in, same status out, with the reason attached.
 *
 * @param {object} input
 * @param {object} input.tool the catalog tool definition
 * @param {object} input.state the stored per-tool state
 * @param {object|null} [input.capabilityRange] a narrowed range from the capability, when asking per-capability
 * @param {string|null} [input.expectSchemaFingerprint] the fingerprint observed now, when it is known
 * @returns {{ status: string, reason: string|null, detail: object }}
 */
export function deriveToolStatus(input) {
  const tool = input?.tool
  const state = input?.state ?? emptyState('unknown')
  if (tool === null || typeof tool !== 'object') {
    throw new ValidationError('deriveToolStatus 需要目录中的工具定义', { field: 'tool' })
  }
  const range = input?.capabilityRange ?? tool.supportedVersions
  const detectedVersion = state.detection?.version ?? null
  const currentVersion = state.currentBuild?.version ?? null

  // 1. A research candidate never becomes usable, whatever the machine has installed.
  if (tool.catalogClass === CatalogClass.RESEARCH_CANDIDATE) {
    return {
      status: ToolStatus.RESEARCH_CANDIDATE,
      reason: '调研候选未采用，不能用于制作',
      detail: { catalogClass: tool.catalogClass },
    }
  }

  // 2. A probe is running: the honest answer is "checking", not the previous answer.
  if (state.detectionInFlight === true) {
    return { status: ToolStatus.CHECKING, reason: '正在检测，不能提前显示可用', detail: {} }
  }

  // 3. Detection itself failed: the state is unknowable and must be handled, not retried silently.
  if (state.detection?.outcome === DetectionOutcome.ERROR) {
    return {
      status: ToolStatus.UNKNOWN,
      reason: state.unknownReason ?? '检测失败，状态未知',
      detail: { detectionOutcome: state.detection.outcome },
    }
  }

  // 4. Not adopted: no recorded build.
  if (currentVersion === null) {
    if (state.detection?.outcome === DetectionOutcome.NOT_FOUND) {
      return { status: ToolStatus.NOT_INSTALLED, reason: '检测未发现该工具', detail: {} }
    }
    if (state.detection?.outcome === DetectionOutcome.INCONCLUSIVE) {
      // Never equate "we could not tell" with "not installed": a user who DID install it would be told
      // to install it again.
      return {
        status: ToolStatus.UNKNOWN,
        reason: state.detection?.reason ?? '检测结论不确定，需要处理',
        detail: { detectionOutcome: state.detection.outcome },
      }
    }
    // A `found` detection that was never adopted still has no recorded location, so it is not usable yet;
    // the honest label is "not installed" from the plugin's point of view, with a reason that says so.
    if (state.detection?.outcome === DetectionOutcome.FOUND) {
      return {
        status: ToolStatus.NOT_INSTALLED,
        reason: `检测到 ${detectedVersion ?? '未知版本'}，但尚未采纳并验证`,
        detail: { detectedVersion },
      }
    }
    return {
      status: ToolStatus.NOT_INSTALLED,
      reason: state.detection === null ? '尚未检测该工具' : '没有已采纳的安装记录',
      detail: { detectedVersion },
    }
  }

  // 5. Version range decides needs-update vs incompatible BEFORE verification, because a version that is
  //    out of range is not usable even if some check passed against it.
  const rangeVerdict = satisfiesRange(range, currentVersion)
  if (rangeVerdict.verdict === RangeVerdict.BELOW_MINIMUM) {
    return {
      status: ToolStatus.NEEDS_UPDATE,
      reason: rangeVerdict.reason,
      detail: { version: currentVersion, range: range.raw ?? String(range) },
    }
  }
  if (rangeVerdict.verdict === RangeVerdict.ABOVE_MAXIMUM) {
    return {
      status: ToolStatus.INCOMPATIBLE,
      reason: rangeVerdict.reason,
      detail: { version: currentVersion, range: range.raw ?? String(range) },
    }
  }
  if (rangeVerdict.verdict === RangeVerdict.INVALID_RANGE) {
    // An unreadable version cannot be declared compatible.
    return {
      status: ToolStatus.UNKNOWN,
      reason: rangeVerdict.reason ?? '版本无法判断',
      detail: { version: currentVersion },
    }
  }

  // 6. Verification must be for THIS build and THIS schema fingerprint.
  const verification = state.verification
  if (verification === null || verification === undefined) {
    return {
      status: ToolStatus.INSTALLED_UNVERIFIED,
      reason: '已记录安装位置但尚未验证',
      detail: { version: currentVersion },
    }
  }
  if (verification.status === VerificationStatus.FAILED) {
    return {
      status: ToolStatus.VERIFICATION_FAILED,
      reason: verification.reason ?? '验证失败',
      detail: { version: currentVersion, basis: verification.basis },
    }
  }
  if (verification.status === VerificationStatus.INCONCLUSIVE) {
    // The check could not be completed (typically: running the tool needs its own authorization). That is
    // NOT the same as a failed verification, and it is certainly not usable: it stays unverified.
    return {
      status: ToolStatus.INSTALLED_UNVERIFIED,
      reason: verification.reason ?? '验证未能完成，仍需授权运行工具后才能确认可用',
      detail: { version: currentVersion, basis: verification.basis, verification: 'inconclusive' },
    }
  }
  if (verification.status !== VerificationStatus.PASSED) {
    return {
      status: ToolStatus.UNKNOWN,
      reason: '验证记录状态未知',
      detail: { verificationStatus: String(verification.status) },
    }
  }
  if (!sameBuild(verification.version ?? '', currentVersion)) {
    // A verification of another build says nothing about this one.
    return {
      status: ToolStatus.INSTALLED_UNVERIFIED,
      reason: `验证记录属于 ${verification.version ?? '未知构建'}，不是当前构建`,
      detail: { version: currentVersion, verifiedVersion: verification.version ?? null },
    }
  }
  if (input?.expectSchemaFingerprint !== undefined && input.expectSchemaFingerprint !== null) {
    if (verification.schemaFingerprint !== input.expectSchemaFingerprint) {
      // The tool's description/schema changed after verification (C06 §4.4 "外部工具更新后 schema／能力
      // 变化需重新验证").
      return {
        status: ToolStatus.INSTALLED_UNVERIFIED,
        reason: '工具描述或 schema 自验证后发生变化，需要重新验证',
        detail: { version: currentVersion, changed: 'schema-fingerprint' },
      }
    }
  }

  // 7. A verification by a test double proves the management logic, not the real tool.
  if (!isProductionVerificationBasis(verification.basis)) {
    return {
      status: ToolStatus.INSTALLED_UNVERIFIED,
      reason:
        verification.basis === VerificationBasis.TEST_DOUBLE
          ? '仅在隔离测试替身上验证过，不能声称真实工具已验证'
          : '只做了文件／声明核对，没有运行验证',
      detail: { version: currentVersion, basis: verification.basis },
    }
  }

  return {
    status: ToolStatus.AVAILABLE,
    reason: null,
    detail: {
      version: currentVersion,
      location: state.currentBuild?.location ?? null,
      verifiedAt: verification.at,
      fingerprint: buildFingerprint(currentVersion),
    },
  }
}

/**
 * Whether a status permits a project to use the capability.
 * @param {string} status
 * @returns {boolean}
 */
export function statusIsUsable(status) {
  return status === ToolStatus.AVAILABLE
}

/**
 * Summarize a state document for a surface that must not show raw records.
 * @param {object} state
 * @returns {object}
 */
export function describeState(state) {
  const current = state.currentBuild ?? null
  const verification = state.verification ?? null
  const parsed = current === null ? null : tryParseVersion(current.version)
  return {
    detected: state.detection === null ? null : state.detection.outcome,
    detectedVersion: state.detection?.version ?? null,
    detectedLocation: state.detection?.location ?? null,
    installedVersion: current?.version ?? null,
    installedLocation: current?.location ?? null,
    installOrigin: current?.origin ?? null,
    adoptedVersions: (state.builds ?? []).map((build) => build.version),
    previousVersion: state.previousBuild?.version ?? null,
    verified: verification !== null && verification.status === VerificationStatus.PASSED,
    verificationBasis: verification?.basis ?? null,
    verificationVersion: verification?.version ?? null,
    hasVerification: verification !== null,
    // Every pin is reported, including superseded history: an old project version still points at its own
    // build, and hiding that would make "which build was this made with" unanswerable (CR-6 item 4).
    pins: (state.pins ?? []).map((pin) => ({
      pinId: pin.pinId,
      projectId: pin.projectId,
      projectVersion: pin.projectVersion,
      version: pin.version,
      state: pin.state,
      supersededBy: pin.supersededBy ?? null,
      supersedeReason: pin.supersedeReason ?? null,
    })),
    versionParsed: parsed !== null && parsed.ok === true,
  }
}

/**
 * The pins that would block switching this tool to a target version, if any.
 *
 * A pin on the SAME build does not block (nothing changes). A pin on another build blocks the switch,
 * because that project version's output was produced with the pinned build (C06 §4.2; CT-03 §5).
 *
 * Only ACTIVE pins block: a superseded pin describes a version the project has already left, so it must not
 * freeze the tool forever. It stays in the history as the answer for that old version.
 *
 * @param {object} state
 * @param {string} targetVersion
 * @returns {{ blocked: boolean, pin: object|null, activePins: object[] }}
 */
export function pinBlockingUpgrade(state, targetVersion) {
  const active = (state.pins ?? []).filter((pin) => (pin.state ?? PinState.ACTIVE) === PinState.ACTIVE)
  for (const pin of active) {
    if (!sameBuild(pin.version, targetVersion)) {
      return { blocked: true, pin, activePins: active }
    }
  }
  return { blocked: false, pin: null, activePins: active }
}
