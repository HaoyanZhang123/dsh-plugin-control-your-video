/**
 * The frozen vocabulary of TOOL-MANAGEMENT.
 *
 * Everything a later card (C11 UI, C12 media runtime, C13 orchestration, C16 acceptance) reads from
 * this module is defined here ONCE: tool statuses, task states, verification bases, channel kinds,
 * impact codes and the Chinese labels a surface renders.
 *
 * Two vocabularies are deliberately kept SEPARATE, because the product requires it:
 *
 * - **internal status** ({@link ToolStatus}) — what the evidence actually proves, including the
 *   distinction between `needs-update` and `incompatible`, and the `checking` / `unknown` states
 *   that must never be shown as `available`;
 * - **user-facing label** ({@link TOOL_STATUS_LABELS} / {@link userStatusLabel}) — the five
 *   simplified states the UI blueprint fixes (可用、未安装、需更新／不兼容、已安装未验证、验证失败),
 *   with `调研候选`/`检测中`/`状态未知` shown as their own honest non-usable labels rather than being
 *   folded into "可用".
 *
 * Collapsing the two would be exactly the failure C06 §4.2 forbids: a tool that is merely installed
 * (not verified) or still being detected would read as usable.
 *
 * **Scope decision (user, 2026-11-08):** the plugin provides MANUAL GUIDANCE ONLY. It does not
 * download, unpack or install anything, so this module has no download task state, no archive entry
 * handling and no artifact-integrity vocabulary. That is why {@link TaskKind} contains adopt /
 * reverify / rollback and nothing that moves bytes.
 *
 * @module tools/schema
 */

import { ValidationError } from '../base/index.js'

/**
 * Versions of the on-disk formats this module writes.
 *
 * A reader compares the stored number; a mismatch goes through an explicit refusal, never a silent
 * best-effort parse (CT-02 §6).
 */
export const TOOL_SCHEMA_VERSION = Object.freeze({
  /** `<stateRoot>/tools/<toolId>.json` — detection, adopted install, verification and pin facts */
  toolState: 1,
  /** `<stateRoot>/tasks/<taskId>.json` — one adopt/verify/rollback task with its full trail */
  task: 1,
  /** `<stateRoot>/log.jsonl` — redacted management log (append-only) */
  log: 1,
})

/** The single schema generation this build can read without migration. */
export const CURRENT_TOOL_SCHEMA_GENERATION = 1

/**
 * How the tool is related to the plugin's own delivery boundary (CT-10 §1).
 *
 * This is a delivery-boundary fact, NOT a quality claim: `external` does not mean "untrusted" and
 * `plugin-internal` does not mean "MIT verified". It only decides which rights regime applies.
 */
export const SupportClass = Object.freeze({
  /** Declared plugin-built content (adapter code, Skill, template, management code). Strict MIT. */
  PLUGIN_INTERNAL: 'plugin-internal',
  /** A real external tool body. Not subject to the plugin MIT gate; its own conditions apply. */
  EXTERNAL: 'external',
  /** Provided by the Host (DSH / Electron / OS). Out of the plugin's delivery scope entirely. */
  HOST: 'host',
})

/**
 * Whether an entry is part of the OFFICIAL support catalog or merely a research candidate.
 *
 * A research candidate is recorded so a later decision has evidence, but it can never enter
 * production and must not appear in the usable list (P3 §3.3.9, UI §11.1).
 */
export const CatalogClass = Object.freeze({
  OFFICIAL: 'official',
  RESEARCH_CANDIDATE: 'research-candidate',
})

/**
 * Internal capability status. Derived from real facts by `tools/state.js#deriveToolStatus`; never
 * assigned by a caller.
 *
 * `checking` and `unknown` exist because "检测中不提前显示可用" and "状态未知不重复动作" are product
 * rules (C06 §4.2): a probe in flight, a crashed probe and an unreadable record are all distinct from
 * "not installed".
 */
export const ToolStatus = Object.freeze({
  /** Recorded as a research candidate: never usable for production, even when installed+verified. */
  RESEARCH_CANDIDATE: 'research-candidate',
  /** Official support, but no install was detected at any known location. */
  NOT_INSTALLED: 'not-installed',
  /** Detection is actually in progress; must NOT be shown as available. */
  CHECKING: 'checking',
  /** Adopted/installed, but no passed verification exists for this exact version + schema fingerprint. */
  INSTALLED_UNVERIFIED: 'installed-unverified',
  /** Version in range, verification passed for this version and schema fingerprint, real tool ran. */
  AVAILABLE: 'available',
  /** Installed version is below the supported minimum. */
  NEEDS_UPDATE: 'needs-update',
  /** Installed version is above the supported maximum, or its schema drifted outside support. */
  INCOMPATIBLE: 'incompatible',
  /** A verification attempt ran and failed. Not the same as never having verified. */
  VERIFICATION_FAILED: 'verification-failed',
  /** Detection itself failed, or the recorded state cannot be trusted. Requires handling. */
  UNKNOWN: 'unknown',
})

/** Statuses that may be used to make real production output. Exactly one: `available`. */
export const PRODUCTION_USABLE_STATUSES = Object.freeze([ToolStatus.AVAILABLE])

/**
 * Statuses that mean "the user must do something" rather than "everything is fine".
 * `checking` is NOT in this list: it is transient and self-resolving.
 */
export const ACTIONABLE_STATUSES = Object.freeze([
  ToolStatus.NOT_INSTALLED,
  ToolStatus.NEEDS_UPDATE,
  ToolStatus.INCOMPATIBLE,
  ToolStatus.VERIFICATION_FAILED,
  ToolStatus.INSTALLED_UNVERIFIED,
  ToolStatus.UNKNOWN,
])

/**
 * What evidence a verification result rests on.
 *
 * The card requires that a test double is never passed off as a verified real tool (C06 §7 last
 * paragraph). This enum makes that distinction a stored fact instead of a promise: only `real-tool`
 * can justify the word "已验证可用" for a real tool.
 */
export const VerificationBasis = Object.freeze({
  /** The real external tool was executed at the declared location and its output checked. */
  REAL_TOOL: 'real-tool',
  /** A clearly-marked isolated test double stood in for the tool. Never a real tool claim. */
  TEST_DOUBLE: 'test-double',
  /** Only files/manifests were inspected; the tool was never run. */
  DECLARED_ONLY: 'declared-only',
})

/** Bases that may ever satisfy the "可用" gate for an external tool. */
export const PRODUCTION_VERIFICATION_BASES = Object.freeze([VerificationBasis.REAL_TOOL])

/** Result of one verification attempt. */
export const VerificationStatus = Object.freeze({
  NONE: 'none',
  PASSED: 'passed',
  FAILED: 'failed',
  /** The attempt could not establish a result; treated as not-verified for the usability gate. */
  INCONCLUSIVE: 'inconclusive',
})

/** Outcome of a detection probe. */
export const DetectionOutcome = Object.freeze({
  FOUND: 'found',
  NOT_FOUND: 'not-found',
  /** The probe ran but its answer is not trustworthy (wrong binary, unreadable manifest, timeout). */
  INCONCLUSIVE: 'inconclusive',
  /** The probe itself threw. State is unknown and must not be auto-retried. */
  ERROR: 'error',
})

/**
 * How a detection probe is obtained.
 *
 * `files-only` is the DEFAULT because it reads files and never starts a process. Starting an
 * external process is an environment action that needs its own authorization (C06 §2.6, CT-12 §4),
 * so `version-probe` is only reachable through an explicitly authorized executor.
 */
export const DetectionMode = Object.freeze({
  FILES_ONLY: 'files-only',
  VERSION_PROBE: 'version-probe',
})

/**
 * Where an adopted installation came from.
 *
 * This matters for honesty: the plugin did not install a `manual` tool, so no record of it may imply
 * that it did. It also decides who owns updating it — the user, not the plugin.
 */
export const InstallOrigin = Object.freeze({
  /** The user installed the tool themselves; the plugin only recorded where it is. */
  MANUAL: 'manual',
  /** Provided by the Host; the plugin never moves it. */
  HOST_PROVIDED: 'host-provided',
})

/** Lifecycle of one adopt / verify / rollback task. Deliberately has no network or install states. */
export const TaskState = Object.freeze({
  /** Plan built from the catalog; nothing has been recorded or authorized. */
  PLANNED: 'planned',
  /** The pre-execution disclosure was shown; waiting for an explicit user answer. */
  AWAITING_AUTHORIZATION: 'awaiting-authorization',
  /** An explicit, scoped authorization is recorded for exactly this plan hash. */
  AUTHORIZED: 'authorized',
  /** Re-running the capability pack's verification against the real located tool. */
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  /** Cancelled by the user or caller. Never leaves a verified-looking state. */
  CANCELLED: 'cancelled',
  /** The outcome cannot be established (e.g. a probe whose result we cannot trust). Never retried. */
  UNKNOWN_STATE: 'unknown',
})

/** Task states from which no further automatic step may run. */
export const TERMINAL_TASK_STATES = Object.freeze([
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.CANCELLED,
  TaskState.UNKNOWN_STATE,
])

/** Task states that mean "steps are in flight right now". */
export const IN_FLIGHT_TASK_STATES = Object.freeze([TaskState.VERIFYING])

/** Kind of lifecycle action a task performs. */
export const TaskKind = Object.freeze({
  /** Record a user-installed tool location and verify it. Nothing is installed by the plugin. */
  ADOPT: 'adopt',
  /** Re-run verification on an already-adopted install (after an update or a schema change). */
  REVERIFY: 'reverify',
  /** Switch which adopted build is current, so an old project's tool can be selected again. */
  ROLLBACK: 'rollback',
})

/**
 * Execution channels an external capability may be reached through (CT-14 §3, C06 §4.4).
 *
 * `structured` marks whether the channel can express a real tool description and schema. A
 * structured tool is always preferred; arbitrary code execution is a CT-12-constrained supplement
 * and is never the default route.
 */
export const ChannelKind = Object.freeze({
  MCP: 'mcp',
  CLI: 'cli',
  IPC: 'ipc',
})

/** Channels whose description/schema can be read as structured data. */
export const STRUCTURED_CHANNEL_KINDS = Object.freeze([ChannelKind.MCP, ChannelKind.IPC])

/**
 * Permission a capability needs before it may act (CT-12 §4, CT-01 §5).
 *
 * Declaring these is what makes "安装或执行不得自动读取无关用户文件、凭据或项目" checkable: a
 * capability that declares no `filesystem` permission may not be handed a filesystem scope.
 */
export const PermissionKind = Object.freeze({
  FILESYSTEM: 'filesystem',
  NETWORK: 'network',
  PROCESS: 'process',
  MEDIA: 'media',
  ENVIRONMENT: 'environment',
  EXTERNAL_SERVICE: 'external-service',
})

/**
 * A change a task makes to the outside world, each of which needs its own explicit authorization
 * (CT-03 §4 "下载、安装、更新、注册、付费、外部服务、数据去向和环境修改分别授权").
 *
 * With the manual-guidance decision, the plugin performs none of the file-moving ones itself; the
 * list is kept because a disclosure must still be able to state what the TOOL does when the user
 * chooses to use it.
 */
export const EffectKind = Object.freeze({
  NETWORK: 'network',
  ENVIRONMENT: 'environment',
  DATA_SUBMISSION: 'data-submission',
  REGISTRATION: 'registration',
  FEE: 'fee',
  PROCESS_START: 'process-start',
})

/**
 * The seven disclosures the UI must show BEFORE executing (UI §11.1, C06 §4.3):
 * 来源、版本、位置、数据、费用、环境、回退.
 *
 * Kept as a closed list so "the disclosure was shown" can be asserted instead of assumed.
 */
export const DisclosureField = Object.freeze({
  SOURCE: 'source',
  VERSION: 'version',
  LOCATION: 'location',
  DATA: 'data',
  FEE: 'fee',
  ENVIRONMENT: 'environment',
  ROLLBACK: 'rollback',
})

/** Every disclosure field, in display order. */
export const DISCLOSURE_FIELDS = Object.freeze([
  DisclosureField.SOURCE,
  DisclosureField.VERSION,
  DisclosureField.LOCATION,
  DisclosureField.DATA,
  DisclosureField.FEE,
  DisclosureField.ENVIRONMENT,
  DisclosureField.ROLLBACK,
])

/**
 * Why a capability is unavailable to a creation surface.
 *
 * Values are stable machine codes so C11/C13 can render a real next step instead of a generic error,
 * and so a test can assert the exact reason (C06 §4.1 "日常创作只接收能力影响和必要处理").
 */
export const ImpactCode = Object.freeze({
  TOOL_NOT_INSTALLED: 'TOOL_NOT_INSTALLED',
  TOOL_NEEDS_UPDATE: 'TOOL_NEEDS_UPDATE',
  TOOL_INCOMPATIBLE: 'TOOL_INCOMPATIBLE',
  TOOL_VERIFICATION_FAILED: 'TOOL_VERIFICATION_FAILED',
  TOOL_INSTALLED_UNVERIFIED: 'TOOL_INSTALLED_UNVERIFIED',
  TOOL_STATE_UNKNOWN: 'TOOL_STATE_UNKNOWN',
  TOOL_RESEARCH_CANDIDATE: 'TOOL_RESEARCH_CANDIDATE',
  CAPABILITY_NOT_IMPLEMENTED: 'CAPABILITY_NOT_IMPLEMENTED',
})

/** How a capability degrades: nothing is silently replaced (C06 §4.5 "无静默 fallback"). */
export const CapabilityState = Object.freeze({
  /** Every required tool is available and verified. */
  AVAILABLE: 'available',
  /** Some tools are missing/outdated; the affected sub-capabilities are listed. */
  PARTIALLY_AVAILABLE: 'partially-available',
  /** No required tool is usable. */
  UNAVAILABLE: 'unavailable',
  /** Nothing is known yet; the caller must not assume availability. */
  UNKNOWN: 'unknown',
})

/** Reason a version is or is not inside a supported range. */
export const RangeVerdict = Object.freeze({
  IN_RANGE: 'in-range',
  BELOW_MINIMUM: 'below-minimum',
  ABOVE_MAXIMUM: 'above-maximum',
  /** The range itself is unusable (bad syntax, empty). */
  INVALID_RANGE: 'invalid-range',
})

/** Why a version pin from an existing project blocks an upgrade (C06 §4.2 last bullet). */
export const PinVerdict = Object.freeze({
  /** No project pins this tool. */
  UNPINNED: 'unpinned',
  /** The pinned version equals the target; nothing changes. */
  PINNED_SAME: 'pinned-same',
  /** A project pins this tool to a different version, so a silent upgrade is refused. */
  PINNED_CONFLICT: 'pinned-conflict',
})

/**
 * Chinese labels for internal statuses.
 *
 * `needs-update` and `incompatible` share the ONE label the UI blueprint fixes
 * (需更新／不兼容) while remaining distinct in evidence, so a receipt can state which it was.
 */
export const TOOL_STATUS_LABELS = Object.freeze({
  [ToolStatus.RESEARCH_CANDIDATE]: '调研候选（不可用于制作）',
  [ToolStatus.NOT_INSTALLED]: '未安装',
  [ToolStatus.CHECKING]: '检测中',
  [ToolStatus.INSTALLED_UNVERIFIED]: '已安装未验证',
  [ToolStatus.AVAILABLE]: '可用',
  [ToolStatus.NEEDS_UPDATE]: '需更新／不兼容',
  [ToolStatus.INCOMPATIBLE]: '需更新／不兼容',
  [ToolStatus.VERIFICATION_FAILED]: '验证失败',
  [ToolStatus.UNKNOWN]: '状态未知，需要处理',
})

/** The exact label for the combined 需更新／不兼容 user state. */
export const NEEDS_UPDATE_LABEL = '需更新／不兼容'

/** Chinese labels for task states, used in the management log and receipts. */
export const TASK_STATE_LABELS = Object.freeze({
  [TaskState.PLANNED]: '已生成核对方案（未执行）',
  [TaskState.AWAITING_AUTHORIZATION]: '等待你明确授权',
  [TaskState.AUTHORIZED]: '已授权（仅本次核对）',
  [TaskState.VERIFYING]: '正在核对真实工具',
  [TaskState.COMPLETED]: '核对完成',
  [TaskState.FAILED]: '核对失败',
  [TaskState.CANCELLED]: '已取消',
  [TaskState.UNKNOWN_STATE]: '状态未知',
})

/** Chinese labels for impact codes, so every surface says the same thing. */
export const IMPACT_LABELS = Object.freeze({
  [ImpactCode.TOOL_NOT_INSTALLED]: '所需工具尚未安装',
  [ImpactCode.TOOL_NEEDS_UPDATE]: '所需工具版本过旧',
  [ImpactCode.TOOL_INCOMPATIBLE]: '所需工具版本不受支持',
  [ImpactCode.TOOL_VERIFICATION_FAILED]: '所需工具验证失败',
  [ImpactCode.TOOL_INSTALLED_UNVERIFIED]: '所需工具已安装但尚未验证',
  [ImpactCode.TOOL_STATE_UNKNOWN]: '所需工具状态未知，需要处理',
  [ImpactCode.TOOL_RESEARCH_CANDIDATE]: '该能力目前只是调研候选，不能用于制作',
  [ImpactCode.CAPABILITY_NOT_IMPLEMENTED]: '该能力在本版本尚未实现',
})

/**
 * Assert membership in a closed enum with a useful error.
 * @param {unknown} value
 * @param {Record<string, string>} enumObject
 * @param {string} field
 * @returns {string}
 */
export function assertEnum(value, enumObject, field) {
  const allowed = new Set(Object.values(enumObject))
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new ValidationError(`${field} 不在允许取值内`, { field, value: String(value), allowed: [...allowed] })
  }
  return value
}

/**
 * Whether a status may produce real output for a project.
 * @param {string} status
 * @returns {boolean}
 */
export function isProductionUsable(status) {
  return PRODUCTION_USABLE_STATUSES.includes(status)
}

/**
 * Whether a status requires the user to do something in the tool page.
 * @param {string} status
 * @returns {boolean}
 */
export function requiresUserAction(status) {
  return ACTIONABLE_STATUSES.includes(status)
}

/**
 * The honest user-facing label for a status.
 *
 * Deliberately does NOT map anything but `available` onto "可用". A caller that wants a short happy
 * label for "installed" must show 已安装未验证, which is the truth.
 *
 * @param {string} status
 * @returns {{ status: string, label: string, usable: boolean, actionable: boolean }}
 */
export function userStatusLabel(status) {
  assertEnum(status, ToolStatus, 'status')
  return {
    status,
    label: TOOL_STATUS_LABELS[status],
    usable: isProductionUsable(status),
    actionable: requiresUserAction(status),
  }
}

/**
 * The five simplified user states from the UI blueprint, for a surface that must not show more.
 *
 * `research-candidate`, `checking` and `unknown` are reported under their own keys because folding
 * them into one of the five would either hide a research-only entry or claim usability early.
 *
 * @param {string} status
 * @returns {'available'|'not-installed'|'needs-update-or-incompatible'|'installed-unverified'|
 *   'verification-failed'|'research-candidate'|'checking'|'unknown'}
 */
export function simplifiedUserState(status) {
  assertEnum(status, ToolStatus, 'status')
  switch (status) {
    case ToolStatus.AVAILABLE:
      return 'available'
    case ToolStatus.NOT_INSTALLED:
      return 'not-installed'
    case ToolStatus.NEEDS_UPDATE:
    case ToolStatus.INCOMPATIBLE:
      return 'needs-update-or-incompatible'
    case ToolStatus.INSTALLED_UNVERIFIED:
      return 'installed-unverified'
    case ToolStatus.VERIFICATION_FAILED:
      return 'verification-failed'
    case ToolStatus.RESEARCH_CANDIDATE:
      return 'research-candidate'
    case ToolStatus.CHECKING:
      return 'checking'
    default:
      return 'unknown'
  }
}

/**
 * Whether a task state means steps are currently in flight.
 * @param {string} state
 * @returns {boolean}
 */
export function isTaskInFlight(state) {
  return IN_FLIGHT_TASK_STATES.includes(state)
}

/**
 * Whether a task state is terminal. A terminal task is never resumed automatically.
 * @param {string} state
 * @returns {boolean}
 */
export function isTaskTerminal(state) {
  return TERMINAL_TASK_STATES.includes(state)
}

/**
 * Whether a channel can express a machine-readable description/schema.
 * @param {string} kind
 * @returns {boolean}
 */
export function isStructuredChannel(kind) {
  return STRUCTURED_CHANNEL_KINDS.includes(kind)
}

/**
 * Whether a verification basis is strong enough to justify "可用" for an external tool.
 * @param {string} basis
 * @returns {boolean}
 */
export function isProductionVerificationBasis(basis) {
  return PRODUCTION_VERIFICATION_BASES.includes(basis)
}

/**
 * Static description of what this module can honestly claim and where each claim stops.
 *
 * Data rather than prose, so a receipt, test or later card reads it instead of trusting a comment.
 */
export const TOOL_MANAGEMENT_CAPABILITIES = Object.freeze({
  catalog: {
    supported: [
      'official support catalog with version ranges, source, license boundary and permissions',
      'research candidates recorded but never usable for production',
      'per-capability packs declaring tools, inputs/outputs, detection and verification',
    ],
    limits: [
      '目录内容是声明，不是已验证可用；只有通过真实验证的工具才标可用',
      '不内置工具市场，不自动采用调研候选',
    ],
  },
  detection: {
    supported: ['file/manifest detection without starting a process', 'authorized version probe', 'inconclusive and error reported distinctly'],
    limits: [
      '默认不启动外部进程：版本探针需要单独授权的执行器',
      '检测成功不等于可用：仍须验证通过，且版本在支持范围内',
    ],
  },
  installLifecycle: {
    supported: [
      'record a user-installed (manual) tool location, then verify it against that exact location',
      'an authorized verification runs the real tool and records a real-tool basis',
      'rollback switches which adopted build is current and re-verifies it',
    ],
    limits: [
      '插件不下载、不解包、不安装、不更新外部工具（用户决定：只提供手动指引）',
      '手工安装的实际位置由用户或检测提供；插件不猜测交互式安装器的落点',
      '更新由用户完成；插件只重新检测与重新验证',
    ],
  },
  statusTruth: {
    supported: [
      'installed-unverified is never reported as available',
      'verification is bound to exact version + schema fingerprint',
      'unknown state is never auto-retried',
      'project version pins block silent upgrades',
    ],
    limits: ['状态只反映已记录的证据；未检测过的工具不会显示为可用'],
  },
  channels: {
    supported: ['mcp / cli / ipc description, schema fingerprint, permissions and before/after state read-back'],
    limits: [
      '真实 MCP/CLI/IPC 调用由 C12 适配层执行；C06 只负责登记、权限与生命周期',
      '任意代码执行不是默认通道，需要 CT-12 授权',
    ],
  },
  isolation: {
    supported: [
      'external tool root is checked disjoint from plugin root and project root',
      'external payloads keep their own license and are never marked MIT',
    ],
    limits: [
      '目录隔离是路径级证明；不把普通进程或目录称为安全沙箱',
      '本模块校验"外部工具"的声明与许可边界；一个包是否真的属于用户外装而非随包依赖，' +
        '最终由 C16 按实际发布包核对（普通依赖伪装成外部工具是无法靠声明自证的）',
    ],
  },
})
