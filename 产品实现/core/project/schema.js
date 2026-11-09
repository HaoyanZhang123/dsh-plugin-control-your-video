/**
 * The frozen vocabulary of PROJECT-CORE.
 *
 * Everything a later card reads or writes through this module's public interface is defined
 * here once: schema versions, the three separate state axes, object-confirmation states, plan
 * item states, the three user-visible version classes, and the closed enums for materials and
 * preferences. A later card must never invent a parallel enum (C10 card §4.5: "不另建平行事实源").
 *
 * Three axes are SEPARATE on purpose (CT-03 §2, C10 card §1):
 * - project phase  = what the user is doing;
 * - execution state = what the machine is doing;
 * - object confirmation = what the user has actually confirmed.
 * They are combined into one display string by {@link summarizeProjectState}, but never stored
 * as a single field, because collapsing them is exactly how "AI 自主" would get shown as
 * "用户已确认".
 *
 * @module core/project/schema
 */

import { ValidationError } from '../../base/index.js'

/**
 * Versions of the on-disk formats this module writes.
 *
 * A reader compares the stored number against these; a mismatch goes through
 * `core/project/migrations.js`, never through a silent best-effort parse (CT-02 §6).
 */
export const SCHEMA_VERSION = Object.freeze({
  /** `<project>/project.json` */
  project: 1,
  /** `<project>/materials/index.json` */
  materials: 1,
  /** `<project>/decisions/index.json` */
  decisions: 1,
  /** `<project>/versions/index.json` */
  versions: 1,
  /** `<project>/recovery.json` */
  recovery: 1,
  /** `<settings>/preferences.json` */
  preferences: 1,
  /** the root project registry `<projects>/index.json` */
  registry: 1,
})

/** The single schema generation this build can READ without migration. */
export const CURRENT_SCHEMA_GENERATION = 1

/**
 * Project phase: what the user is doing with the project right now.
 *
 * Deliberately not a percentage (CT-03 §2: 阶段说明用户正在做什么，不用百分比代替).
 */
export const ProjectPhase = Object.freeze({
  INTAKE: 'intake',
  ALIGNING: 'aligning',
  READY_FOR_PRODUCTION: 'ready-for-production',
  PRODUCING: 'producing',
  INITIAL_REVIEW: 'initial-review',
  FINALIZING: 'finalizing',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
  RECYCLE_BIN: 'recycle-bin',
})

/** The phases a project may move to from each phase. */
const REVISIT_PHASES = [ProjectPhase.ARCHIVED, ProjectPhase.RECYCLE_BIN]

/** Legal phase transitions. Anything else is refused instead of silently coerced. */
export const PHASE_TRANSITIONS = Object.freeze({
  [ProjectPhase.INTAKE]: [ProjectPhase.ALIGNING, ...REVISIT_PHASES],
  [ProjectPhase.ALIGNING]: [ProjectPhase.READY_FOR_PRODUCTION, ProjectPhase.INTAKE, ...REVISIT_PHASES],
  [ProjectPhase.READY_FOR_PRODUCTION]: [
    ProjectPhase.PRODUCING,
    ProjectPhase.ALIGNING,
    ...REVISIT_PHASES,
  ],
  [ProjectPhase.PRODUCING]: [
    ProjectPhase.INITIAL_REVIEW,
    ProjectPhase.READY_FOR_PRODUCTION,
    ProjectPhase.ALIGNING,
    ...REVISIT_PHASES,
  ],
  [ProjectPhase.INITIAL_REVIEW]: [
    ProjectPhase.FINALIZING,
    ProjectPhase.PRODUCING,
    ProjectPhase.ALIGNING,
    ...REVISIT_PHASES,
  ],
  [ProjectPhase.FINALIZING]: [
    ProjectPhase.COMPLETED,
    ProjectPhase.INITIAL_REVIEW,
    ProjectPhase.PRODUCING,
    ...REVISIT_PHASES,
  ],
  [ProjectPhase.COMPLETED]: [ProjectPhase.FINALIZING, ...REVISIT_PHASES],
  // A finished project may reopen for more work, but only by becoming a new phase, so the
  // already-finalized version is never edited in place (CT-03 §5: 结项后从最终版形成新候选).
  [ProjectPhase.ARCHIVED]: [ProjectPhase.INTAKE, ProjectPhase.COMPLETED, ProjectPhase.RECYCLE_BIN],
  [ProjectPhase.RECYCLE_BIN]: [ProjectPhase.ARCHIVED, ProjectPhase.INTAKE],
})

/**
 * Execution state: what the machine is doing.
 *
 * `unknown` exists because a crash or a lost process leaves the true state unknowable; CT-03 §2
 * requires that it is shown as paused and never auto-retried.
 */
export const ExecutionState = Object.freeze({
  IDLE: 'idle',
  WAITING_USER: 'waiting-user',
  WAITING_AUTHORIZATION: 'waiting-authorization',
  RUNNING: 'running',
  PAUSING: 'pausing',
  PAUSED: 'paused',
  CANCELLING: 'cancelling',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  NEEDS_ATTENTION: 'needs-attention',
})

/** States that mean "no writer may assume the machine is free". */
export const BLOCKING_EXECUTION_STATES = Object.freeze([
  ExecutionState.RUNNING,
  ExecutionState.PAUSING,
  ExecutionState.CANCELLING,
  ExecutionState.UNKNOWN,
  ExecutionState.NEEDS_ATTENTION,
])

/**
 * Object confirmation state (CT-03 §2).
 *
 * `AI_ALLOWED` is kept OUT of the confirmed family on purpose: it records that the user let the
 * AI decide, which is not the user having reviewed the result.
 */
export const ConfirmationState = Object.freeze({
  UNDECIDED: 'undecided',
  PARTIALLY_CONFIRMED: 'partially-confirmed',
  CONFIRMED: 'confirmed',
  CHANGED_AFTER_CONFIRMATION: 'changed-after-confirmation',
  AI_ALLOWED: 'ai-allowed',
})

/** States that may be described to a user as "you confirmed this". */
export const HUMAN_CONFIRMED_STATES = Object.freeze([
  ConfirmationState.PARTIALLY_CONFIRMED,
  ConfirmationState.CONFIRMED,
])

/**
 * Plan item state (CT-03 §2): a plan item can be decided by a human, left open, or delegated.
 * A key item that is `UNDECIDED` blocks full production (see `assertProductionGate`).
 */
export const PlanItemState = Object.freeze({
  UNDECIDED: 'undecided',
  DECIDED: 'decided',
  AI_ALLOWED: 'ai-allowed',
})

/**
 * Plan item kinds that are KEY: production may not start while one is undecided
 * (CT-01 §5.1 "关键项未定不得完整制作"; CT-03 §6).
 */
export const KEY_PLAN_ITEM_KINDS = Object.freeze(['core-goal', 'structure', 'delivery-spec', 'rights'])

/**
 * The three — and only three — user-visible version classes (CT-03 §5).
 *
 * Draft, initial cut, baseline and delivery are STATES of a version, not new classes; the
 * `VersionSubstate` enum below records them without adding a class.
 */
export const VersionClass = Object.freeze({
  CURRENT: 'current',
  CANDIDATE: 'candidate',
  FINAL: 'final',
})

/** Substate inside a version class; none of these is a new class. */
export const VersionSubstate = Object.freeze({
  DRAFT: 'draft',
  INITIAL_CUT: 'initial-cut',
  BASELINE: 'baseline',
  DELIVERED: 'delivered',
})

/** Lifecycle of a candidate version. A stale candidate is never applied silently. */
export const CandidateStatus = Object.freeze({
  OPEN: 'open',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
  NEEDS_RECHECK: 'needs-recheck',
})

/**
 * What a confirmation is about. The list is closed so `aspect` cannot become free text that
 * nobody can query; an unknown aspect is refused.
 */
export const ConfirmAspect = Object.freeze({
  MATERIAL_USE: 'material-use',
  DIRECTION: 'direction',
  PLAN: 'plan',
  UNIT: 'unit',
  INITIAL_CUT: 'initial-cut',
  FINAL_CUT: 'final-cut',
  OBJECT_EDIT: 'object-edit',
  EXPORT: 'export',
  CLEANUP: 'cleanup',
})

/** How far a confirmation reaches. `part` is deliberately narrower than `whole`. */
export const ConfirmScope = Object.freeze({
  OBJECT: 'object',
  RANGE: 'range',
  PART: 'part',
  WHOLE: 'whole',
})

/** Who made a decision. Only `user` may produce a HUMAN confirmation (CT-03 §4). */
export const Actor = Object.freeze({
  USER: 'user',
  AI: 'ai',
  SYSTEM: 'system',
})

/**
 * Material kinds. Only kinds the product actually handles are listed; an unknown kind is
 * stored as `other` so a future format does not silently become a wrong specific claim.
 */
export const MaterialKind = Object.freeze({
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  TEXT: 'text',
  FONT: 'font',
  DOCUMENT: 'document',
  OTHER: 'other',
})

/**
 * Read/observation state of a material (CT-03 §3: 未读、不可读、未观察、未完整观察分别标记).
 * A single boolean would force a lie, so this is an explicit four-way plus "unknown".
 */
export const MaterialObservation = Object.freeze({
  UNREAD: 'unread',
  UNREADABLE: 'unreadable',
  OBSERVED_PARTIAL: 'observed-partial',
  OBSERVED_FULL: 'observed-full',
  UNKNOWN: 'unknown',
})

/** Rights status, kept coarse because the licence comes from C10-independent sources. */
export const RightsStatus = Object.freeze({
  USER_PROVIDED: 'user-provided',
  LICENSED: 'licensed',
  PUBLIC_DOMAIN: 'public-domain',
  UNKNOWN: 'unknown',
  RESTRICTED: 'restricted',
})

/**
 * The five preference groups (CT-03 §7). A sixth group is refused, so "永远允许一切" cannot be
 * sneaked in as a preference.
 */
export const PreferenceGroup = Object.freeze({
  CREATION: 'creation',
  NOTIFICATION: 'notification',
  DATA_AUTHORIZATION: 'data-authorization',
  STORAGE: 'storage',
  WORKSPACE: 'workspace',
})

/**
 * Where a preference value lives. `project` overrides are NOT copied into global preferences,
 * because CT-03 §7 forbids promoting one project's feedback into a long-term default.
 */
export const PreferenceScope = Object.freeze({
  GLOBAL: 'global',
  PROJECT: 'project',
})

/** Reducer of a project's series relationship. */
export const SeriesRelation = Object.freeze({
  STANDALONE: 'standalone',
  EPISODE: 'episode',
  BRANCH: 'branch',
})

/** Why a project exists; preserved on copy and branch (C10 card §1 "保留来源"). */
export const ProjectOrigin = Object.freeze({
  BLANK: 'blank',
  MATERIAL: 'material',
  COPY: 'copy',
  BRANCH: 'branch',
  IMPORT: 'import',
})

/**
 * Everything this module can report as "needs handling" instead of "can continue".
 *
 * The values are stable machine codes so the UI can render a real fix for each one instead of a
 * generic error, and so a test can assert the exact reason.
 */
export const NeedsAttentionCode = Object.freeze({
  MATERIAL_MISSING: 'MATERIAL_MISSING',
  MATERIAL_HASH_MISMATCH: 'MATERIAL_HASH_MISMATCH',
  MATERIAL_UNREADABLE: 'MATERIAL_UNREADABLE',
  PROJECT_DIR_MISSING: 'PROJECT_DIR_MISSING',
  PROJECT_DIR_MOVED: 'PROJECT_DIR_MOVED',
  PROJECT_FILE_CORRUPT: 'PROJECT_FILE_CORRUPT',
  SCHEMA_TOO_NEW: 'SCHEMA_TOO_NEW',
  MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
  LOCK_STALE: 'LOCK_STALE',
  LOCK_HELD: 'LOCK_HELD',
  EXECUTION_UNKNOWN: 'EXECUTION_UNKNOWN',
  EXTERNAL_TOOL_MISSING: 'EXTERNAL_TOOL_MISSING',
  DISK_FULL: 'DISK_FULL',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  FILE_BUSY: 'FILE_BUSY',
  CANDIDATE_NEEDS_RECHECK: 'CANDIDATE_NEEDS_RECHECK',
  PREFERENCES_CORRUPT: 'PREFERENCES_CORRUPT',
})

/**
 * Assert membership in a closed enum.
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
 * Assert a phase transition is legal.
 * @param {string} from
 * @param {string} to
 */
export function assertPhaseTransition(from, to) {
  assertEnum(from, ProjectPhase, 'phase.from')
  assertEnum(to, ProjectPhase, 'phase.to')
  if (from === to) return
  const allowed = PHASE_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new ValidationError(`不允许的阶段转换：${from} → ${to}`, { from, to, allowed })
  }
}

/**
 * Whether a version class may be replaced by a later write.
 * The final version is immutable until the user explicitly reopens the project (CT-03 §5).
 * @param {string} versionClass
 * @returns {boolean}
 */
export function isVersionMutable(versionClass) {
  return versionClass === VersionClass.CURRENT || versionClass === VersionClass.CANDIDATE
}

/**
 * Combine the three axes into the single display string a user sees.
 *
 * This is a DERIVED value. Nothing stores it, so it can never be stale or contradict the axes.
 *
 * @param {{ phase: string, execution: string, confirmations?: { confirmed: number, total: number } }} input
 * @returns {{ phase: string, execution: string, confirmation: string, label: string, needsAttention: boolean }}
 */
export function summarizeProjectState(input) {
  const phase = assertEnum(input.phase, ProjectPhase, 'phase')
  const execution = assertEnum(input.execution, ExecutionState, 'execution')
  const confirmed = Math.max(0, Number(input.confirmations?.confirmed ?? 0))
  const total = Math.max(0, Number(input.confirmations?.total ?? 0))
  // Zero confirmed means UNDECIDED even when items are awaiting review: "nothing has been
  // confirmed yet" and "some things were confirmed" are different statements, and collapsing the
  // first into "partially confirmed" would overstate what the user actually did.
  let confirmation = ConfirmationState.UNDECIDED
  if (total > 0 && confirmed >= total) confirmation = ConfirmationState.CONFIRMED
  else if (confirmed > 0) confirmation = ConfirmationState.PARTIALLY_CONFIRMED
  const needsAttention =
    execution === ExecutionState.NEEDS_ATTENTION ||
    execution === ExecutionState.UNKNOWN ||
    execution === ExecutionState.FAILED
  const label = `${PHASE_LABELS[phase]}｜${EXECUTION_LABELS[execution]}｜${CONFIRMATION_LABELS[confirmation]}`
  return { phase, execution, confirmation, label, needsAttention }
}

/** Chinese labels for phases, so every caller shows the same words. */
export const PHASE_LABELS = Object.freeze({
  [ProjectPhase.INTAKE]: '接收输入',
  [ProjectPhase.ALIGNING]: '对齐方向',
  [ProjectPhase.READY_FOR_PRODUCTION]: '可以开始完整制作',
  [ProjectPhase.PRODUCING]: '制作中',
  [ProjectPhase.INITIAL_REVIEW]: '初版待审',
  [ProjectPhase.FINALIZING]: '定稿处理',
  [ProjectPhase.COMPLETED]: '已完成',
  [ProjectPhase.ARCHIVED]: '已归档',
  [ProjectPhase.RECYCLE_BIN]: '回收区',
})

/** Chinese labels for execution states. */
export const EXECUTION_LABELS = Object.freeze({
  [ExecutionState.IDLE]: '空闲',
  [ExecutionState.WAITING_USER]: '等待你的决定',
  [ExecutionState.WAITING_AUTHORIZATION]: '等待授权',
  [ExecutionState.RUNNING]: '执行中',
  [ExecutionState.PAUSING]: '正在暂停',
  [ExecutionState.PAUSED]: '已暂停',
  [ExecutionState.CANCELLING]: '正在取消',
  [ExecutionState.CANCELLED]: '已取消',
  [ExecutionState.FAILED]: '失败',
  [ExecutionState.UNKNOWN]: '状态未知，先按已暂停处理',
  [ExecutionState.NEEDS_ATTENTION]: '需要处理',
})

/** Chinese labels for confirmation states. `ai-allowed` never reads as "已确认". */
export const CONFIRMATION_LABELS = Object.freeze({
  [ConfirmationState.UNDECIDED]: '未确认',
  [ConfirmationState.PARTIALLY_CONFIRMED]: '部分确认',
  [ConfirmationState.CONFIRMED]: '已确认',
  [ConfirmationState.CHANGED_AFTER_CONFIRMATION]: '确认后有改动，需重核',
  [ConfirmationState.AI_ALLOWED]: '由 AI 自主决定（未经你审阅）',
})

/**
 * Whether a plan item blocks full production.
 * @param {string} kind
 * @param {string} state
 * @returns {boolean}
 */
export function isBlockingPlanItem(kind, state) {
  return KEY_PLAN_ITEM_KINDS.includes(kind) && state === PlanItemState.UNDECIDED
}

/**
 * Assert that full production may start, given the plan items and the locks.
 *
 * Enforced in code rather than documented only, because "关键项未定不得完整制作" is a hard
 * product rule and a UI-only check is bypassed by any other caller.
 *
 * @param {{ items: Array<{ id: string, kind: string, state: string }> }} plan
 * @returns {{ ok: true } | { ok: false, undecided: string[] }}
 */
export function assertProductionGate(plan) {
  const items = plan?.items
  if (!Array.isArray(items)) throw new ValidationError('生产门禁需要方案项列表')
  const undecided = items.filter((item) => isBlockingPlanItem(item.kind, item.state)).map((item) => item.id)
  if (undecided.length > 0) return { ok: false, undecided }
  return { ok: true }
}
