/**
 * PROJECT-CORE public interface: the ONLY entry point later cards (C11, C13, C14, C15, C16) use.
 *
 * `core/project/index.js` is a facade, following the convention C04 set for `base/index.js`:
 * importing the internal modules directly is acceptable for THIS card's tests but not for product
 * code, so an internal refactor cannot break a caller that only used this surface.
 *
 * The interface is frozen for the version in {@link PROJECT_CORE_INTERFACE_VERSION}. A later card
 * that needs a different shape submits a change request rather than reaching past this file
 * (CT-00 §5.5; C10 card §4.5 "不另建平行事实源").
 *
 * Two shapes are exposed, and the difference matters:
 * - **free functions** for project lifecycle, materials, preferences, recovery and the global
 *   production lock — they take a `ProjectPaths` or (root, id) and hold no state;
 * - **bound stores** (`createDecisionLog`, `createVersionStore`) for confirmations, decisions,
 *   authorizations and versions — they are created once per open project, because those records
 *   are strictly scoped to one project directory and a free function would have to be re-scoped
 *   on every call.
 *
 * @module core/project/index
 */

import { ValidationError } from '../../base/index.js'
import { createRootPaths, ProjectPaths } from './paths.js'
import { assertId } from './ids.js'
import path from 'node:path'
import { Clock } from '../../base/index.js'

// ---- identity, schema and state vocabulary ------------------------------------------------
export { ID_PREFIX, newId, isId, assertId, newUseInstanceId, derivedId } from './ids.js'

export {
  SCHEMA_VERSION,
  CURRENT_SCHEMA_GENERATION,
  ProjectPhase,
  PHASE_TRANSITIONS,
  PHASE_LABELS,
  ExecutionState,
  EXECUTION_LABELS,
  BLOCKING_EXECUTION_STATES,
  ConfirmationState,
  HUMAN_CONFIRMED_STATES,
  CONFIRMATION_LABELS,
  PlanItemState,
  KEY_PLAN_ITEM_KINDS,
  VersionClass,
  VersionSubstate,
  CandidateStatus,
  ConfirmAspect,
  ConfirmScope,
  Actor,
  MaterialKind,
  MaterialObservation,
  RightsStatus,
  PreferenceGroup,
  PreferenceScope,
  SeriesRelation,
  ProjectOrigin,
  NeedsAttentionCode,
  assertEnum,
  assertPhaseTransition,
  isVersionMutable,
  isBlockingPlanItem,
  assertProductionGate,
  summarizeProjectState,
} from './schema.js'

// ---- paths and layout ---------------------------------------------------------------------
export {
  PROJECT_LAYOUT,
  ROOT_LAYOUT,
  PROJECT_SUBDIRS,
  ProjectPaths,
  createRootPaths,
  pathExists,
} from './paths.js'

// ---- durable store -----------------------------------------------------------------------
export {
  readDocument,
  writeDocument,
  tryReadDocument,
  nextRevision,
  revisionCounter,
  stripEnvelope,
  fileSha256,
  fileSize,
  isReadableFile,
  ensureDirectory,
  DURABILITY_LIMITS,
} from './store.js'

export { migrationChain, describeMigrations, hasMigrations } from './migrations.js'

// ---- events ------------------------------------------------------------------------------
export {
  ProjectEventKind,
  MAX_EVENT_PAGE,
  appendEvents,
  readEvents,
  readRecentEvents,
  buildEvent,
  eventLogPath,
  eventLogDigest,
  countEvents,
  verifyAppendOnly,
} from './events.js'

// ---- project lifecycle -------------------------------------------------------------------
export {
  MAX_PROJECT_TITLE,
  validateTitle,
  createProject,
  openProject,
  updateProject,
  setPhase,
  setExecutionState,
  renameProject,
  copyProject,
  setSeriesLink,
  notifySeriesSharedChange,
  listProjects,
  describeState,
  projectEvents,
  readRegistry,
  writeRegistry,
  registerProject,
  registryPath,
} from './project.js'

// ---- per-project write lock and execution state -------------------------------------------
export {
  LOCK_DIR,
  projectEditLockPath,
  inspectProjectWriter,
  describeLockConflict,
  acquireProjectWriter,
  withProjectWriter,
  checkWriterAvailable,
  executionMarkerPath,
  beginExecution,
  endExecution,
  inspectExecution,
} from './write-guard.js'

// ---- global production lock ---------------------------------------------------------------
export {
  PRODUCTION_LOCK_KIND,
  PRODUCTION_LOCK_SCOPE,
  STALE_PRODUCTION_ACTION,
  globalProductionLockPath,
  inspectProduction,
  describeProductionBlocker,
  acquireProduction,
  releaseProduction,
  withProduction,
} from './production-lock.js'

// ---- materials and natural-language use ---------------------------------------------------
export {
  DEFAULT_USE_PERMISSION,
  ExclusionKind,
  ExclusionUnit,
  MaterialSource,
  PermissionCode,
  MAX_USER_TEXT_LENGTH,
  MATERIALS_CATALOG_KIND,
  addMaterial,
  amendUse,
  excludeFromUse,
  recordUse,
  readMaterialsCatalog,
  writeMaterialsCatalog,
  findMaterial,
  usesForMaterial,
  latestUseForMaterial,
  isAllowedForUse,
  describeEffectivePermission,
  buildUsePermission,
  verifyAvailability,
  materialStorageRelativePath,
  materialsIndexPath,
  emptyMaterialsCatalog,
} from './materials.js'

// ---- preferences --------------------------------------------------------------------------
export {
  PREFERENCE_KEYS,
  PREFERENCE_SPEC,
  PreferenceKey,
  ResolvedPreferenceSource,
  SCOPE_LABELS,
  DEFAULT_PREFERENCES,
  PREFERENCES_KIND,
  GLOBAL_PREFERENCES_KIND,
  PROJECT_PREFERENCES_KIND,
  GLOBAL_PREFERENCES_FILE_NAME,
  PROJECT_PREFERENCES_PATH,
  BLANKET_AUTHORIZATION_KEY_PATTERN,
  BLANKET_AUTHORIZATION_VALUES,
  BLANKET_AUTHORIZATION_REFUSAL,
  assertPreferenceKey,
  assertPreferenceValue,
  preferenceGroupOf,
  globalPreferencesPath,
  projectPreferencesPath,
  readGlobalPreferences,
  readProjectPreferences,
  setGlobalPreference,
  setProjectPreference,
  clearProjectOverride,
  resolvePreference,
  resolveAllPreferences,
  describePreferencesHealth,
} from './preferences.js'

// ---- save / continue ----------------------------------------------------------------------
export {
  RECOVERY_VERDICTS,
  WORK_POSITION_FIELDS,
  saveWorkPosition,
  readWorkPosition,
  markCleanPause,
  inspectRecovery,
  unknownExecutionResult,
} from './recovery.js'

// ---- bound stores: confirmations, decisions, authorizations, versions ----------------------
export { createDecisionLog, ProposalKind, AuthorizationStatus, VALID_FOR_ONCE, DECISIONS_DOCUMENT } from './decisions.js'
export {
  createVersionStore,
  VERSIONS_DOCUMENT,
  LIVE_CANDIDATE_STATUSES,
  MAX_REFERENCE_LENGTH,
  MAX_SCOPE_ITEMS,
} from './versions.js'

/**
 * Version of the frozen public interface.
 *
 * A change to this string means at least one exported shape changed and dependent cards must be
 * re-checked. It is deliberately separate from the on-disk schema generation.
 */
export const PROJECT_CORE_INTERFACE_VERSION = '1.0.0'

/**
 * What this module can honestly claim, and where each claim stops.
 *
 * Data rather than prose, so a receipt, a test or a later card reads it instead of trusting a
 * comment. Every capability lists its limits, because "supported" without a boundary is the kind
 * of claim this project forbids.
 */
export const PROJECT_CORE_CAPABILITIES = Object.freeze({
  projectLifecycle: {
    supported: ['create', 'open', 'copy', 'branch', 'rename', 'list', 'archive', 'recycle-bin'],
    limits: [
      '永久删除只提供阶段与引用检查接口；实际删除由 C15 在用户确认后执行',
      '项目目录被移动后需要重新检查引用，不会静默改路径',
    ],
  },
  materials: {
    supported: ['real content hash from bytes', 'natural-language use stored verbatim', 'amend/exclude', 'availability verify'],
    limits: ['可读性检查只证明文件可读，不等于 AI 已观察内容', '参考素材不因记录而变成可复制或可分发'],
  },
  confirmations: {
    supported: ['human confirmation bound to object+aspect+scope+version', 'AI proposal that is not a confirmation'],
    limits: ['AI 不能创建用户确认；这是代码级拒绝，不是提示', '沉默与未回复不产生任何确认记录'],
  },
  versions: {
    supported: ['current', 'candidate with base version', 'final', 'candidate staleness', 'creative-history revert'],
    limits: ['不新增第四类版本', '不承诺找回结项时已删除的历史', '不承诺原帧续跑'],
  },
  locks: {
    supported: ['single project writer', 'single project in full production', 'stale reported not deleted'],
    limits: ['锁只证明声明的写入权，不证明外部进程已停止', '跨机器与多进程真实竞争未验证'],
  },
  saveContinue: {
    supported: ['autosave position', 'recovery verdict', 'unknown execution stays paused'],
    limits: ['外部动作状态未知时不会自动重试', '恢复只走一条保存继续流程，不提供第二套恢复系统'],
  },
  preferences: {
    supported: ['five groups', 'global default with project override', 'corrupt file reported'],
    limits: ['没有“永远允许一切”式偏好', '一次项目反馈不会自动升级为长期偏好'],
  },
})

/**
 * Normalize a caller-supplied projects root into an absolute path this module accepts.
 *
 * A relative root is refused rather than resolved against the process cwd: the cwd belongs to
 * whoever launched the host, and user project data must not land somewhere nobody chose
 * (CT-02 §2 "不静默换路径").
 *
 * @param {string} root
 * @returns {string}
 */
export function requireAbsoluteRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new ValidationError('需要项目根目录', { field: 'projectsRoot' })
  }
  if (!path.isAbsolute(root)) {
    throw new ValidationError('项目根目录必须是绝对路径', { field: 'projectsRoot' })
  }
  return path.resolve(root)
}

/**
 * Resolve `{ projectsRoot, projectId }` into the `ProjectPaths` the module functions expect.
 *
 * This is the single conversion point, so a caller cannot invent a differently-shaped paths
 * object and write outside its project.
 *
 * @param {{ projectsRoot: string, projectId: string }} input
 * @returns {ProjectPaths}
 */
export function pathsFor(input) {
  const root = requireAbsoluteRoot(input?.projectsRoot)
  const projectId = assertId(input?.projectId, 'project', 'projectId')
  return new ProjectPaths(root, projectId)
}

/**
 * Open one project as a ready-to-use session: document, paths, the revision that was read, and a
 * bound decision log and version store.
 *
 * Handing back the revision is what makes a later write safe: a caller passes it to a mutation, and
 * a concurrent writer gets `VERSION_CONFLICT` instead of silently losing data (CT-02 §3).
 *
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {Clock} [options.clock]
 * @returns {Promise<{
 *   project: object, paths: ProjectPaths, revision: string, clock: Clock,
 *   decisions: object, versions: object,
 * }>}
 */
export async function openSession(options) {
  const [projectModule, decisionsModule, versionsModule] = await Promise.all([
    import('./project.js'),
    import('./decisions.js'),
    import('./versions.js'),
  ])
  const clock = options.clock ?? new Clock()
  const opened = projectModule.openProject({ ...options, clock })
  return {
    project: opened.project,
    paths: opened.paths,
    revision: opened.revision,
    clock,
    decisions: decisionsModule.createDecisionLog({ paths: opened.paths, projectId: opened.project.projectId, clock }),
    versions: versionsModule.createVersionStore({ paths: opened.paths, projectId: opened.project.projectId, clock }),
  }
}

/**
 * Create a bound decision log for an existing project.
 * @param {{ projectsRoot: string, projectId: string, clock?: Clock }} options
 * @returns {Promise<object>}
 */
export async function decisionLogFor(options) {
  const module = await import('./decisions.js')
  const paths = pathsFor(options)
  return module.createDecisionLog({ paths, projectId: paths.projectId, clock: options.clock })
}

/**
 * Create a bound version store for an existing project.
 * @param {{ projectsRoot: string, projectId: string, clock?: Clock }} options
 * @returns {Promise<object>}
 */
export async function versionStoreFor(options) {
  const module = await import('./versions.js')
  const paths = pathsFor(options)
  return module.createVersionStore({ paths, projectId: paths.projectId, clock: options.clock })
}

/**
 * The three axes plus the derived single line a surface can render.
 * @param {object} options
 * @param {string} options.projectsRoot
 * @param {string} options.projectId
 * @param {{ confirmed: number, total: number }} [options.confirmations]
 * @returns {Promise<object>}
 */
export async function describeProjectState(options) {
  const module = await import('./project.js')
  return module.describeState(options)
}

/**
 * Root paths helper, re-exported as a function so callers need not construct it themselves.
 * @param {string} projectsRoot
 */
export function projectRootPaths(projectsRoot) {
  return createRootPaths(requireAbsoluteRoot(projectsRoot))
}
