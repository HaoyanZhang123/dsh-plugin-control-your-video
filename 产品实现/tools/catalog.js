/**
 * The official support catalog and the capability-pack contract.
 *
 * One shared management kernel handles directory, version range, detection, authorization, install
 * record, verification and logging. A **capability pack** supplies only what differs per capability:
 * which tools it needs, at which versions, how to detect them, how to verify them, what the user gets,
 * what data/fees/environment it involves, and how to roll back
 * (MIT P3 §3.3.8 "共用管理内核＋可插拔工具能力包").
 *
 * Two catalogs exist and are NOT mixed:
 *
 * - `official` — the supported list. Only these appear in the UI's usable set (UI §11.1
 *   "默认只列正式支持能力，不做工具市场");
 * - `research-candidate` — recorded so a later decision has evidence, permanently unusable for
 *   production. `deriveToolStatus` returns `research-candidate` for it even when a matching binary
 *   happens to be installed, because "候选未经采用与必要验证不得制作" (SAMPLE-03, JOB-04).
 *
 * **Scope decision (user, 2026-11-08): manual guidance only.** The plugin does not download, unpack or
 * install external tools. The catalog therefore has NO downloadable source kind and NO artifact
 * integrity field: those concepts would describe a mechanism this product deliberately does not have.
 * What the catalog CAN declare is where a user-installed tool may be found, how to verify it, and what
 * it would do — which is exactly what the tool page needs to guide someone.
 *
 * Everything here is a DECLARATION. A declaration is not a verification: the catalog says a tool needs
 * to be at version X and how it would be checked, and `tools/detect.js` + `tools/install.js` decide what
 * is actually true on this machine.
 *
 * @module tools/catalog
 */

import path from 'node:path'
import { ValidationError, invariant } from '../base/index.js'
import { parseRange, parseVersion, satisfiesRange } from './version.js'
import { assertToolId } from './paths.js'
import {
  CatalogClass,
  ChannelKind,
  DetectionMode,
  DisclosureField,
  EffectKind,
  InstallOrigin,
  PermissionKind,
  SupportClass,
  assertEnum,
} from './schema.js'

/**
 * How the plugin relates to a tool's presence.
 *
 * Only two values exist, and neither puts bytes on disk: the user installs it, or the Host provides it.
 * A `download` kind would imply plugin-assisted installation, which the product decision excludes.
 */
export const SourceKind = Object.freeze({
  /** The user installs it themselves; the catalog supplies guidance only. */
  MANUAL_ONLY: 'manual-only',
  /** Provided by the Host; the plugin never installs or moves it. */
  HOST_PROVIDED: 'host-provided',
})

/** How a verification check is carried out. */
export const CheckKind = Object.freeze({
  /** A declared file exists inside the located tool directory. */
  FILE_EXISTS: 'file-exists',
  /** A declared file's SHA-256 equals the declared hash. */
  FILE_HASH: 'file-hash',
  /** A text file contains an expected substring (license type, version banner). */
  FILE_CONTAINS: 'file-contains',
  /** The tool's version probe output matches this exact build. */
  VERSION_MATCH: 'version-match',
  /** The tool's own self-check command exits successfully (requires an authorized executor). */
  SELF_CHECK: 'self-check',
})

/** Fields a verification check may declare, validated below. */
const CHECK_FIELDS = Object.freeze({
  [CheckKind.FILE_EXISTS]: ['id', 'kind', 'relativePath', 'description'],
  [CheckKind.FILE_HASH]: ['id', 'kind', 'relativePath', 'sha256', 'description'],
  [CheckKind.FILE_CONTAINS]: ['id', 'kind', 'relativePath', 'contains', 'description'],
  [CheckKind.VERSION_MATCH]: ['id', 'kind', 'expectedBuild', 'command', 'args', 'description'],
  [CheckKind.SELF_CHECK]: ['id', 'kind', 'command', 'args', 'expectExitCode', 'description'],
})

/**
 * Validate one declared verification check.
 *
 * A check that cannot be evaluated is refused at catalog load time rather than at verification time,
 * because a check that silently does nothing would let an unverified tool read as verified.
 *
 * @param {unknown} input
 * @param {string} field
 * @returns {object}
 */
function normalizeCheck(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const kind = assertEnum(record.kind, CheckKind, `${field}.kind`)
  const allowed = CHECK_FIELDS[kind]
  const check = { id: requireToken(record.id, `${field}.id`), kind }
  for (const key of allowed) {
    if (key === 'id' || key === 'kind') continue
    if (key === 'args') {
      check.args = optionalStringArray(record.args, `${field}.args`)
      continue
    }
    if (key === 'expectExitCode') {
      check.expectExitCode = optionalInteger(record.expectExitCode, `${field}.expectExitCode`)
      continue
    }
    check[key] = requireText(record[key], `${field}.${key}`, 2000)
  }
  if (kind === CheckKind.SELF_CHECK) {
    if (typeof check.command !== 'string' || check.command.length === 0) {
      throw new ValidationError(`${field}.command 必须是非空字符串`, { field })
    }
    if (check.expectExitCode === undefined) check.expectExitCode = 0
  }
  if (kind === CheckKind.VERSION_MATCH) {
    // Refuse early so a typo cannot make the "is it this build" check vacuous.
    parseVersion(check.expectedBuild, { field: `${field}.expectedBuild` })
    assertBareCommand(check.command, `${field}.command`)
  }
  if (kind === CheckKind.FILE_HASH && !/^[a-f0-9]{64}$/.test(String(check.sha256))) {
    throw new ValidationError(`${field}.sha256 必须是 64 位小写十六进制`, { field })
  }
  return check
}

/**
 * Refuse a command that is a path rather than a bare program name.
 *
 * The command reaches a process spawn in the C12 adapter. Requiring a bare name means a catalog can
 * never redirect that spawn to an arbitrary binary, and keeps "which program will run" answerable from
 * the declaration alone.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function assertBareCommand(value, field) {
  const text = requireText(value, field, 200)
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new ValidationError(`${field} 必须是可执行文件名，不能是路径`, { field, value: text.slice(0, 60) })
  }
  return text
}

/**
 * Validate one declared detection rule.
 *
 * Two modes are kept apart on purpose (C06 §4.2, CT-12 §4):
 * - `files-only` reads manifests under a candidate root and never starts a process;
 * - `version-probe` runs the tool's own version command, which is an environment action needing an
 *   executor that was explicitly authorized.
 *
 * @param {unknown} input
 * @param {string} field
 * @returns {object}
 */
function normalizeDetection(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const mode = assertEnum(record.mode, DetectionMode, `${field}.mode`)
  /** @type {Record<string, unknown>} */
  const detection = {
    mode,
    manifestFiles: optionalStringArray(record.manifestFiles, `${field}.manifestFiles`),
    executables: optionalStringArray(record.executables, `${field}.executables`),
  }
  if (record.versionProbe !== undefined) {
    if (record.versionProbe === null || typeof record.versionProbe !== 'object') {
      throw new ValidationError(`${field}.versionProbe 必须是对象`, { field })
    }
    const probe = /** @type {Record<string, unknown>} */ (record.versionProbe)
    detection.versionProbe = {
      command: assertBareCommand(probe.command, `${field}.versionProbe.command`),
      args: optionalStringArray(probe.args, `${field}.versionProbe.args`),
    }
  }
  if (mode === DetectionMode.VERSION_PROBE && detection.versionProbe === undefined) {
    throw new ValidationError(`${field} 声明了 version-probe 但没有 versionProbe`, { field })
  }
  const declaredPaths =
    detection.manifestFiles.length + detection.executables.length + (detection.versionProbe === undefined ? 0 : 1)
  if (declaredPaths === 0) {
    throw new ValidationError(`${field} 至少需要一个 manifestFiles、executables 或 versionProbe`, { field })
  }
  return detection
}

/**
 * Validate the declared source of a tool.
 *
 * There is no `download` kind and no `integrity` field by design: the plugin does not fetch tool bytes
 * (user decision 2026-11-08). Only two facts are recorded — that the user installs it, or that the Host
 * provides it — plus where the user is told to get it.
 *
 * @param {unknown} input
 * @param {string} field
 * @returns {object}
 */
function normalizeSource(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const kind = assertEnum(record.kind, SourceKind, `${field}.kind`)
  return {
    kind,
    publisher: optionalText(record.publisher, `${field}.publisher`, 500),
    /** Where the user would obtain it. Text for a human, never a machine fetch target. */
    obtainFrom: optionalText(record.obtainFrom, `${field}.obtainFrom`, 1000),
    note: optionalText(record.note, `${field}.note`, 1000),
  }
}

/**
 * Validate the declared license boundary.
 *
 * `plugin-internal` content must be strictly MIT; an external tool must NOT be marked MIT, because
 * "外部工具标为外部组件，不冒称 MIT" (UI §11.1) and Apache/GPL/custom licenses are not MIT (CT-10 §1).
 *
 * @param {unknown} input
 * @param {string} field
 * @returns {object}
 */
function normalizeLicense(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const spdx = requireText(record.spdx, `${field}.spdx`, 120)
  const licenseClass = assertEnum(record.class, SupportClass, `${field}.class`)
  const isMit = spdx === 'MIT' || spdx === 'MIT-0'
  if (licenseClass === SupportClass.PLUGIN_INTERNAL && !isMit) {
    throw new ValidationError(`${field}：插件内部内容必须严格 MIT，实际 ${spdx}`, { field, spdx })
  }
  const conditions = optionalStringArray(record.conditions, `${field}.conditions`)
  const evidenceRef = optionalText(record.evidenceRef, `${field}.evidenceRef`, 500)
  if (licenseClass === SupportClass.EXTERNAL && (conditions.length === 0 || evidenceRef === null)) {
    // An external body may itself be MIT (Editly, for example), and recording that is a fact, not a
    // claim that it is covered by the plugin's MIT delivery. What it may NOT do is appear as plugin
    // content — that is what `class` records — and its own conditions must be stated so a reader can
    // tell the two regimes apart (CT-10 §5).
    throw new ValidationError(`${field}：外部对象必须单独记录使用条件与许可证据位置`, { field, spdx })
  }
  return {
    spdx,
    class: licenseClass,
    copyright: optionalText(record.copyright, `${field}.copyright`, 500),
    conditions,
    /** Where the original license text was observed, so evidence is re-locatable. */
    evidenceRef,
  }
}

/**
 * Validate the declared data / fee / environment facts shown before execution.
 *
 * "新外部服务、新数据去向、下载、安装、更新、注册、付费和环境修改分别授权" (CT-03 §4). Refusing to
 * omit a field is what makes the pre-execution disclosure complete rather than best-effort.
 *
 * @param {unknown} input
 * @param {string} field
 * @returns {object}
 */
function normalizeEffects(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const effects = optionalStringArray(record.effects, `${field}.effects`).map((effect, index) =>
    assertEnum(effect, EffectKind, `${field}.effects[${index}]`),
  )
  /** @type {Record<string, unknown>} */
  const result = {
    effects,
    network: record.network === true,
    dataSubmission: record.dataSubmission === true,
    registration: record.registration === true,
    dataDestination: optionalText(record.dataDestination, `${field}.dataDestination`, 500),
    fee: normalizeFee(record.fee, `${field}.fee`),
    environmentImpact: optionalText(record.environmentImpact, `${field}.environmentImpact`, 1000),
    notes: optionalText(record.notes, `${field}.notes`, 2000),
  }
  if (result.network && typeof result.dataDestination !== 'string') {
    throw new ValidationError(`${field}：声明联网必须同时说明数据去向`, { field })
  }
  return result
}

/**
 * @param {unknown} input
 * @param {string} field
 * @returns {{ amount: number, currency: string, description: string }|null}
 */
function normalizeFee(input, field) {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象或 null`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const amount = Number(record.amount)
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ValidationError(`${field}.amount 必须是非负有限数字`, { field })
  }
  return {
    amount,
    currency: requireText(record.currency, `${field}.currency`, 12),
    description: requireText(record.description, `${field}.description`, 500),
  }
}

/**
 * Validate the declared rollback story.
 *
 * With manual installs, "rollback" means selecting a previously recorded build again — the plugin never
 * had the bytes, so it can only point at one that the user still has. A `none` strategy is legitimate
 * and must then say what the user is expected to do instead.
 *
 * @param {unknown} input
 * @param {string} field
 * @returns {{ strategy: string, retainedVersions: number, instructions: string }}
 */
function normalizeRollback(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const strategy = assertEnum(
    record.strategy,
    { PREVIOUS_BUILD: 'previous-build', MANUAL_GUIDANCE: 'manual-guidance', NONE: 'none' },
    `${field}.strategy`,
  )
  const retainedVersions = optionalInteger(record.retainedVersions, `${field}.retainedVersions`) ?? 1
  if (strategy === 'none' && retainedVersions > 0) {
    throw new ValidationError(`${field}：strategy=none 时不应声明 retainedVersions`, { field })
  }
  return {
    strategy,
    retainedVersions,
    instructions: requireText(record.instructions, `${field}.instructions`, 2000),
  }
}

/**
 * Validate and freeze one tool definition.
 * @param {unknown} input
 * @param {string} field
 * @returns {Readonly<object>}
 */
function normalizeTool(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const toolId = assertToolId(record.toolId, `${field}.toolId`)
  const supportClass = assertEnum(record.supportClass, SupportClass, `${field}.supportClass`)
  const catalogClass = assertEnum(record.catalogClass, CatalogClass, `${field}.catalogClass`)
  const supportedVersionsRaw = requireText(record.supportedVersions, `${field}.supportedVersions`, 200)
  const supportedVersions = parseRange(supportedVersionsRaw, { field: `${field}.supportedVersions` })
  const permissions = optionalStringArray(record.permissions, `${field}.permissions`).map((value, index) =>
    assertEnum(value, PermissionKind, `${field}.permissions[${index}]`),
  )
  const checks = requireArray(record.verificationChecks, `${field}.verificationChecks`).map((check, index) =>
    normalizeCheck(check, `${field}.verificationChecks[${index}]`),
  )
  if (checks.length === 0) {
    // An external tool with no verification could never become "可用", which defeats the catalog.
    throw new ValidationError(`${field}：必须至少声明一项 verificationChecks`, { field, toolId })
  }
  const tool = {
    toolId,
    displayName: requireText(record.displayName, `${field}.displayName`, 200),
    supportClass,
    catalogClass,
    channel: assertEnum(record.channel, ChannelKind, `${field}.channel`),
    supportedVersions,
    permissions,
    detection: normalizeDetection(record.detection, `${field}.detection`),
    verificationChecks: checks,
    license: normalizeLicense(record.license, `${field}.license`),
    effects: normalizeEffects(record.effects, `${field}.effects`),
    rollback: normalizeRollback(record.rollback, `${field}.rollback`),
    /** Declared facts that C02/C01 established, quoted rather than re-invented. */
    evidenceRefs: optionalStringArray(record.evidenceRefs, `${field}.evidenceRefs`),
    notes: optionalText(record.notes, `${field}.notes`, 2000),
  }
  tool.source = normalizeSource(record.source, `${field}.source`)
  const defaultOrigin =
    tool.source.kind === SourceKind.HOST_PROVIDED ? InstallOrigin.HOST_PROVIDED : InstallOrigin.MANUAL
  tool.origin = assertEnum(record.origin ?? defaultOrigin, InstallOrigin, `${field}.origin`)
  if (record.manualGuidance !== undefined) {
    tool.manualGuidance = normalizeManualGuidance(record.manualGuidance, `${field}.manualGuidance`)
  } else {
    tool.manualGuidance = { steps: [], verifyHint: null }
  }
  if (tool.catalogClass === CatalogClass.OFFICIAL && tool.supportClass === SupportClass.EXTERNAL) {
    if (tool.manualGuidance.steps.length === 0) {
      // "未安装→检测→手动指引" is the minimum verification in C06 §7.1, and with the manual-only decision
      // the guidance IS the install path. Without steps there is nothing to show a user at all.
      throw new ValidationError(`${field}：正式支持的外部工具必须提供手动指引步骤`, { field, toolId })
    }
  }
  return Object.freeze(tool)
}

/**
 * @param {unknown} input
 * @param {string} field
 * @returns {{ steps: string[], verifyHint: string|null }}
 */
function normalizeManualGuidance(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const steps = optionalStringArray(record.steps, `${field}.steps`)
  return {
    steps,
    verifyHint: optionalText(record.verifyHint, `${field}.verifyHint`, 2000),
  }
}

/**
 * Validate one capability: what a user can do, and which tool versions they need for it.
 * @param {unknown} input
 * @param {string} field
 * @returns {Readonly<object>}
 */
function normalizeCapability(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const requirements = requireArray(record.requires, `${field}.requires`).map((requirement, index) => {
    const inner = `${field}.requires[${index}]`
    if (requirement === null || typeof requirement !== 'object' || Array.isArray(requirement)) {
      throw new ValidationError(`${inner} 必须是对象`, { field: inner })
    }
    const bag = /** @type {Record<string, unknown>} */ (requirement)
    const supportedVersions =
      bag.supportedVersions === undefined
        ? null
        : parseRange(requireText(bag.supportedVersions, `${inner}.supportedVersions`, 200), {
            field: `${inner}.supportedVersions`,
          })
    return {
      toolId: assertToolId(bag.toolId, `${inner}.toolId`),
      supportedVersions,
      optional: bag.optional === true,
    }
  })
  if (requirements.length === 0) {
    throw new ValidationError(`${field}：能力必须声明至少一个 requires 工具`, { field })
  }
  return Object.freeze({
    capabilityId: requireToken(record.capabilityId, `${field}.capabilityId`),
    displayName: requireText(record.displayName, `${field}.displayName`, 200),
    userOutcome: requireText(record.userOutcome, `${field}.userOutcome`, 2000),
    inputs: optionalStringArray(record.inputs, `${field}.inputs`),
    outputs: optionalStringArray(record.outputs, `${field}.outputs`),
    requires: requirements,
    /** Which product surface this capability belongs to, so impact can name the affected feature. */
    surface: optionalText(record.surface, `${field}.surface`, 200),
    notes: optionalText(record.notes, `${field}.notes`, 2000),
  })
}

/**
 * Validate one capability pack — the unit later cards depend on.
 * @param {unknown} input
 * @param {string} field
 * @returns {Readonly<object>}
 */
function normalizePack(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const tools = requireArray(record.tools, `${field}.tools`).map((tool, index) =>
    normalizeTool(tool, `${field}.tools[${index}]`),
  )
  if (tools.length === 0) {
    throw new ValidationError(`${field}：能力包必须声明至少一个工具`, { field })
  }
  const toolIds = new Set()
  for (const tool of tools) {
    if (toolIds.has(tool.toolId)) {
      throw new ValidationError(`${field}：工具 ${tool.toolId} 重复声明`, { field, toolId: tool.toolId })
    }
    toolIds.add(tool.toolId)
  }
  const capabilities = requireArray(record.capabilities, `${field}.capabilities`).map((capability, index) =>
    normalizeCapability(capability, `${field}.capabilities[${index}]`),
  )
  if (capabilities.length === 0) {
    throw new ValidationError(`${field}：能力包必须声明至少一个 capability`, { field })
  }
  const capabilityIds = new Set()
  for (const capability of capabilities) {
    if (capabilityIds.has(capability.capabilityId)) {
      throw new ValidationError(`${field}：能力 ${capability.capabilityId} 重复声明`, {
        field,
        capabilityId: capability.capabilityId,
      })
    }
    capabilityIds.add(capability.capabilityId)
    for (const requirement of capability.requires) {
      if (!toolIds.has(requirement.toolId)) {
        throw new ValidationError(
          `${field}：能力 ${capability.capabilityId} 引用了未声明的工具 ${requirement.toolId}`,
          { field, capabilityId: capability.capabilityId, toolId: requirement.toolId },
        )
      }
    }
  }
  const pluginCode = record.pluginCode
  if (pluginCode === null || typeof pluginCode !== 'object' || Array.isArray(pluginCode)) {
    throw new ValidationError(`${field}.pluginCode 必须是对象`, { field })
  }
  const codeBag = /** @type {Record<string, unknown>} */ (pluginCode)
  const pluginLicense = requireText(codeBag.license, `${field}.pluginCode.license`, 40)
  if (pluginLicense !== 'MIT' && pluginLicense !== 'MIT-0') {
    // "插件适配、Skill、模板和管理代码纳入严格 MIT" (C06 §4.4). This is the plugin's OWN content, so an
    // Apache-2.0 adapter would breach the delivery promise even though the external tool is fine.
    throw new ValidationError(`${field}.pluginCode.license：插件内置内容必须严格 MIT`, {
      field: `${field}.pluginCode.license`,
      license: pluginLicense,
    })
  }
  const packClass = assertEnum(record.catalogClass ?? CatalogClass.OFFICIAL, CatalogClass, `${field}.catalogClass`)
  if (packClass === CatalogClass.RESEARCH_CANDIDATE) {
    // A research pack is for recording candidates only. A candidate tool inside it may not be
    // presented as official, and vice versa: the two lists must not mix (UI §11.1).
    for (const tool of tools) {
      if (tool.catalogClass !== CatalogClass.RESEARCH_CANDIDATE) {
        throw new ValidationError(`${field}：调研包中的工具必须标为 research-candidate`, {
          field,
          toolId: tool.toolId,
        })
      }
    }
  } else {
    for (const tool of tools) {
      if (tool.catalogClass === CatalogClass.RESEARCH_CANDIDATE) {
        throw new ValidationError(`${field}：正式包中的工具不得标为 research-candidate`, {
          field,
          toolId: tool.toolId,
        })
      }
    }
  }
  return Object.freeze({
    packId: requireToken(record.packId, `${field}.packId`),
    version: requireText(record.version, `${field}.version`, 40),
    displayName: requireText(record.displayName, `${field}.displayName`, 200),
    description: optionalText(record.description, `${field}.description`, 2000),
    catalogClass: packClass,
    tools: Object.freeze(tools),
    capabilities: Object.freeze(capabilities),
    /**
     * The plugin-internal part of this capability: adapter code, Skill text, templates, management
     * code. Strictly MIT is the plugin's own obligation, and it is recorded so C16 can verify it.
     */
    pluginCode: Object.freeze({
      license: pluginLicense,
      components: optionalStringArray(codeBag.components, `${field}.pluginCode.components`),
      evidenceRef: optionalText(codeBag.evidenceRef, `${field}.pluginCode.evidenceRef`, 500),
    }),
  })
}

/**
 * Build a validated catalog from capability packs.
 *
 * @param {{ packs: unknown[], catalogVersion?: string, note?: string }} input
 * @returns {Readonly<object>}
 */
export function buildCatalog(input) {
  const packs = requireArray(input?.packs, 'catalog.packs').map((pack, index) =>
    normalizePack(pack, `catalog.packs[${index}]`),
  )
  const packIds = new Set()
  /** @type {Map<string, object>} */
  const toolIndex = new Map()
  /** @type {Map<string, object>} */
  const capabilityIndex = new Map()
  for (const pack of packs) {
    if (packIds.has(pack.packId)) {
      throw new ValidationError('能力包 packId 重复', { packId: pack.packId })
    }
    packIds.add(pack.packId)
    for (const tool of pack.tools) {
      // One tool may serve several packs. Two different definitions of the same tool would mean two
      // different version ranges for one installation, which is exactly the ambiguity to refuse.
      const existing = toolIndex.get(tool.toolId)
      if (existing !== undefined && existing.definition !== tool) {
        throw new ValidationError('同一工具被两处以不同定义声明，拒绝合并', { toolId: tool.toolId })
      }
      toolIndex.set(tool.toolId, { toolId: tool.toolId, packId: pack.packId, definition: tool })
    }
    for (const capability of pack.capabilities) {
      if (capabilityIndex.has(capability.capabilityId)) {
        throw new ValidationError('能力 capabilityId 重复', { capabilityId: capability.capabilityId })
      }
      // The pack's class travels with the capability so a caller can filter to the official set
      // without re-deriving it from the tools.
      capabilityIndex.set(capability.capabilityId, {
        packId: pack.packId,
        catalogClass: pack.catalogClass,
        capability,
      })
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    catalogVersion: input?.catalogVersion ?? '1.0.0',
    note: input?.note ?? null,
    packs: Object.freeze(packs),
    packIndex: new Map(packs.map((pack) => [pack.packId, pack])),
    toolIndex,
    capabilityIndex,
  })
}

/**
 * Look up one tool definition.
 * @param {object} catalog
 * @param {string} toolId
 * @returns {object}
 */
export function requireTool(catalog, toolId) {
  const entry = catalog?.toolIndex?.get(toolId)
  if (entry === undefined) {
    throw new ValidationError('工具不在正式支持目录中', { toolId: String(toolId) })
  }
  return entry.definition
}

/**
 * Look up one capability.
 * @param {object} catalog
 * @param {string} capabilityId
 * @returns {{ packId: string, catalogClass: string, capability: object }}
 */
export function requireCapability(catalog, capabilityId) {
  const entry = catalog?.capabilityIndex?.get(capabilityId)
  if (entry === undefined) {
    throw new ValidationError('能力不在正式支持目录中', { capabilityId: String(capabilityId) })
  }
  return entry
}

/**
 * Every official tool, in a stable order, with the pack that declares it.
 * Research candidates are excluded from this list by contract (UI §11.1).
 * @param {object} catalog
 * @returns {Array<{ toolId: string, packId: string, definition: object }>}
 */
export function listOfficialTools(catalog) {
  return [...catalog.toolIndex.values()]
    .filter((entry) => entry.definition.catalogClass === CatalogClass.OFFICIAL)
    .sort((left, right) => left.toolId.localeCompare(right.toolId))
}

/**
 * Every research candidate, listed separately so it can never be confused with the usable set.
 * @param {object} catalog
 * @returns {Array<{ toolId: string, packId: string, definition: object }>}
 */
export function listResearchCandidates(catalog) {
  return [...catalog.toolIndex.values()]
    .filter((entry) => entry.definition.catalogClass === CatalogClass.RESEARCH_CANDIDATE)
    .sort((left, right) => left.toolId.localeCompare(right.toolId))
}

/**
 * Resolve the version range that applies to one tool inside one capability.
 *
 * A capability may narrow the tool's catalog range (e.g. a subtitle capability needing a newer
 * build); the narrower range wins. Returning `null` means "the catalog range applies".
 *
 * @param {object} capability
 * @param {string} toolId
 * @returns {object|null}
 */
export function capabilityRangeFor(capability, toolId) {
  const requirement = capability.requires.find((item) => item.toolId === toolId)
  return requirement?.supportedVersions ?? null
}

/**
 * Decide whether a capability is satisfied by a set of tool statuses. Pure; no I/O.
 *
 * @param {object} capability
 * @param {Record<string, string>} statusByToolId
 * @returns {{ satisfied: boolean, missing: string[], unusable: Array<{ toolId: string, status: string }> }}
 */
export function capabilitySatisfiedBy(capability, statusByToolId) {
  const missing = []
  const unusable = []
  for (const requirement of capability.requires) {
    const status = statusByToolId[requirement.toolId]
    if (status === undefined) {
      if (!requirement.optional) missing.push(requirement.toolId)
      continue
    }
    if (status !== 'available' && !requirement.optional) unusable.push({ toolId: requirement.toolId, status })
  }
  return { satisfied: missing.length === 0 && unusable.length === 0, missing, unusable }
}

/**
 * The seven disclosures, assembled from a tool definition. Used by the verification plan and by any
 * surface that must show them before executing (UI §11.1).
 *
 * With manual installs, "location" is where the tool is expected to be found, and "rollback" describes
 * selecting a previously recorded build — the plugin never had bytes to restore.
 *
 * @param {object} tool
 * @param {{ targetVersion: string, installLocation: string }} plan
 * @returns {Record<string, string>}
 */
export function buildDisclosure(tool, plan) {
  invariant(typeof plan?.targetVersion === 'string', '需要目标版本才能生成披露')
  invariant(typeof plan?.installLocation === 'string', '需要安装位置才能生成披露')
  const feeText =
    tool.effects.fee === null
      ? '本工具本身无已知费用'
      : `${tool.effects.fee.currency} ${tool.effects.fee.amount}（${tool.effects.fee.description}）`
  return {
    [DisclosureField.SOURCE]: describeSource(tool.source),
    [DisclosureField.VERSION]: `${tool.displayName} ${plan.targetVersion}`,
    [DisclosureField.LOCATION]: plan.installLocation,
    [DisclosureField.DATA]: tool.effects.dataSubmission
      ? `会提交数据到：${tool.effects.dataDestination ?? '未声明'}`
      : tool.effects.network
        ? `工具自身可能联网（去向：${tool.effects.dataDestination ?? '未声明'}）；插件不上传项目数据`
        : '不联网，不回传数据',
    [DisclosureField.FEE]: feeText,
    [DisclosureField.ENVIRONMENT]: tool.effects.environmentImpact ?? '只读取本机该工具的文件，不修改系统环境',
    [DisclosureField.ROLLBACK]: tool.rollback.instructions,
  }
}

/**
 * Human description of a declared source, used in the disclosure.
 * @param {object} source
 * @returns {string}
 */
export function describeSource(source) {
  switch (source.kind) {
    case SourceKind.MANUAL_ONLY:
      return source.obtainFrom === null || source.obtainFrom === undefined
        ? '需要你自行安装，插件只提供手动指引'
        : `需要你自行安装（来源：${source.obtainFrom}），插件只提供手动指引`
    case SourceKind.HOST_PROVIDED:
      return '由 DSH 宿主提供，插件不安装也不移动'
    default:
      return '来源未声明'
  }
}

/**
 * Version-range verdict for one tool against a candidate version.
 * @param {object} tool
 * @param {string} version
 * @returns {{ verdict: string, reason: string|null, matched: boolean }}
 */
export function toolRangeVerdict(tool, version) {
  return satisfiesRange(tool.supportedVersions, version)
}

/**
 * The user-visible purpose of a tool, derived from the capabilities that require it.
 * Keeps "每项说明用户用途" (UI §11.1) sourced from the catalog instead of hand-written prose.
 *
 * @param {object} catalog
 * @param {string} toolId
 * @returns {string[]}
 */
export function toolUserOutcomes(catalog, toolId) {
  const outcomes = []
  for (const pack of catalog.packs) {
    for (const capability of pack.capabilities) {
      if (capability.requires.some((requirement) => requirement.toolId === toolId)) {
        outcomes.push(capability.userOutcome)
      }
    }
  }
  return [...new Set(outcomes)]
}

/**
 * Where a build is expected to live inside the tools root, used in the pre-execution disclosure.
 * @param {import('./paths.js').ToolPaths} paths
 * @param {string} toolId
 * @param {string} buildFingerprint
 * @returns {string}
 */
export function installLocationFor(paths, toolId, buildFingerprint) {
  return path.join(paths.buildDir(toolId, buildFingerprint), 'payload')
}

// ---- small validators ---------------------------------------------------------------------

/** @param {unknown} value @param {string} field @returns {string} */
function requireText(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field })
  }
  if (value.length > maxLength) {
    throw new ValidationError(`${field} 过长（${value.length} > ${maxLength}）`, { field })
  }
  return value
}

/** @param {unknown} value @param {string} field @returns {string|null} */
function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return null
  return requireText(value, field, maxLength)
}

/** Identifiers inside the catalog: lowercase kebab-case. @param {unknown} value @param {string} field */
function requireToken(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new ValidationError(`${field} 必须是小写 kebab-case 标识`, { field, value: String(value) })
  }
  return value
}

/** @param {unknown} value @param {string} field @returns {unknown[]} */
function requireArray(value, field) {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} 必须是数组`, { field })
  }
  return value
}

/** @param {unknown} value @param {string} field @returns {string[]} */
function optionalStringArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} 必须是字符串数组`, { field })
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ValidationError(`${field}[${index}] 必须是非空字符串`, { field })
    }
    return item
  })
}

/** @param {unknown} value @param {string} field @returns {number|undefined} */
function optionalInteger(value, field) {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${field} 必须是非负整数`, { field })
  }
  return value
}
