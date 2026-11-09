/**
 * Preferences: documented defaults, one GLOBAL settings file, and per-project overrides.
 *
 * Rules this module enforces rather than documents (CT-03 §7, C10 card §4.1):
 * - Exactly FIVE groups exist — creation, notification, data-authorization, storage, workspace.
 *   A sixth or unknown group is refused, so "永远允许一切" cannot be smuggled in as a preference
 *   name (schema.js already calls that out).
 * - GLOBAL and PROJECT values live in SEPARATE files. The project file stores only overrides, so
 *   "仅本项目" is a fact about where the value is, not a label a UI invents. A project override is
 *   never copied into the global file: one project's feedback must not become a long-term default.
 * - Every resolution says which scope won (`project-override` | `global` | `default`), so the UI can
 *   honestly label "仅本项目" instead of guessing.
 * - There is deliberately NO blanket-authorization preference. A key or value that would mean
 *   "always allow everything" is refused with an explicit explanation, because CT-12 §5 requires a
 *   separate authorization per service, destination and data type.
 * - A corrupt file is REPORTED with `PREFERENCES_CORRUPT` and left on disk untouched. Resetting it
 *   to `{}` would silently discard the user's settings, and deleting it would destroy user data
 *   (CT-12 §7 "插件升级或卸载不默认删除").
 *
 * The caller supplies the absolute global settings path (CT-00 names the default location, and
 * C10 must not invent a root). Project values are read through {@link ProjectPaths}.
 *
 * @module core/project/preferences
 */

import path from 'node:path'
import { Clock, ErrorCode, ValidationError, WorkbenchError } from '../../base/index.js'
import {
  Actor,
  NeedsAttentionCode,
  PreferenceGroup,
  PreferenceScope,
  assertEnum,
} from './schema.js'
import { pathExists } from './paths.js'
import { tryReadDocument, writeDocument } from './store.js'
import { ProjectEventKind, appendEvents, buildEvent } from './events.js'

/** Document kind used in error messages and as the migration-chain key (store.js). */
export const PREFERENCES_KIND = 'preferences'

/** `kind` field of the global settings document. */
export const GLOBAL_PREFERENCES_KIND = 'global-preferences'

/** `kind` field of a project's override document. */
export const PROJECT_PREFERENCES_KIND = 'project-preferences'

/**
 * Project-relative path of the override file.
 *
 * Lives inside the project directory so moving/copying a project carries its own overrides, while
 * the global file stays outside it. `paths.js` is frozen and has no entry for this, so the name is
 * declared here and always resolved through {@link ProjectPaths.resolve}, which re-confines it.
 */
export const PROJECT_PREFERENCES_PATH = 'preferences/preferences.json'

/** File name of the global settings document inside a caller-chosen settings directory. */
export const GLOBAL_PREFERENCES_FILE_NAME = 'preferences.json'

/** Chinese label for each scope, so every caller shows the same words. */
export const SCOPE_LABELS = Object.freeze({
  'project-override': '仅本项目',
  global: '全局默认',
  default: '内置默认',
})

/** Which scope a resolved value came from. Not a parallel enum: it extends the frozen two scopes. */
export const ResolvedPreferenceSource = Object.freeze({
  PROJECT_OVERRIDE: 'project-override',
  GLOBAL: 'global',
  DEFAULT: 'default',
})

/**
 * Tokens that would mean "unrestricted" if they were ever accepted as a preference value.
 * Matched case-insensitively and only as a whole value, so a legitimate string that merely
 * contains the word "all" is not refused.
 */
export const BLANKET_AUTHORIZATION_VALUES = Object.freeze([
  '*',
  'all',
  'any',
  'always',
  'always-allow',
  'allow-all',
  'unrestricted',
  'everything',
  'no-limit',
  'any-service',
  'any-destination',
])

/** Fragments that must never appear in a preference KEY: a wildcard or blanket intent. */
export const BLANKET_AUTHORIZATION_KEY_PATTERN = /(?:^|[.-])(?:all|any|everything|unrestricted|wildcard)(?:$|[.-])|[*]/

/** The one refusal message used for every blanket-authorization attempt. */
export const BLANKET_AUTHORIZATION_REFUSAL =
  '不存在“永远允许一切”的偏好：每个外部服务、数据去向和数据类型都必须单独授权'

/**
 * Preference keys and their groups. The key format is `<group>.<name>`; the group is part of the
 * key so a value can never be stored without stating which of the five groups owns it.
 */
export const PreferenceKey = Object.freeze({
  CREATION_ASPECT_RATIO: 'creation.aspect-ratio',
  CREATION_FRAME_RATE: 'creation.frame-rate',
  CREATION_STYLE_PRESET: 'creation.style-preset',
  NOTIFICATION_ON_COMPLETION: 'notification.on-completion',
  NOTIFICATION_NEEDS_ATTENTION: 'notification.needs-attention',
  NOTIFICATION_VERBOSITY: 'notification.verbosity',
  DATA_AUTHORIZATION_DEFAULT: 'data-authorization.default',
  DATA_AUTHORIZATION_EXTERNAL_SERVICE: 'data-authorization.external-service',
  DATA_AUTHORIZATION_UPLOAD_MATERIALS: 'data-authorization.upload-materials',
  STORAGE_PROJECTS_ROOT: 'storage.projects-root',
  STORAGE_CACHE_RETENTION_DAYS: 'storage.cache-retention-days',
  WORKSPACE_SHOW_ADVANCED_PANELS: 'workspace.show-advanced-panels',
  WORKSPACE_CONFIRM_BEFORE_DESTRUCTIVE: 'workspace.confirm-before-destructive',
})

/**
 * The canonical preference table: group, value kind, allowed values and DEFAULT.
 *
 * The defaults here are the product's documented answers to "what happens before the user has
 * chosen anything", so no caller needs its own fallback table:
 * - creation: 16:9 at 30 fps and no style preset — the neutral landscape baseline;
 * - notification: tell the user when work finishes OR needs handling, in brief form, because a
 *   silent workbench would make "状态未知" indistinguishable from "still running";
 * - data-authorization: every external service / data destination starts at `ask-each-time`.
 *   `deny` is available, `always-allow` is NOT — that would be blanket authorization (CT-12 §5);
 * - storage: no project root override (the caller's root wins until the user changes it) and a
 *   short cache retention, because caches are rebuildable and never a source of truth;
 * - workspace: advanced panels hidden and destructive actions confirmed, so a first run is safe.
 *
 * @type {Record<string, { group: string, kind: string, default: any, values?: any[],
 *   min?: number, max?: number, maxLength?: number }>}
 */
export const PREFERENCE_SPEC = Object.freeze({
  [PreferenceKey.CREATION_ASPECT_RATIO]: {
    group: PreferenceGroup.CREATION,
    kind: 'enum',
    values: ['16:9', '9:16', '1:1', '4:5', '21:9'],
    default: '16:9',
  },
  [PreferenceKey.CREATION_FRAME_RATE]: {
    group: PreferenceGroup.CREATION,
    kind: 'enum',
    values: [24, 25, 30, 50, 60],
    default: 30,
  },
  [PreferenceKey.CREATION_STYLE_PRESET]: {
    group: PreferenceGroup.CREATION,
    kind: 'text',
    default: '',
    maxLength: 200,
  },
  [PreferenceKey.NOTIFICATION_ON_COMPLETION]: {
    group: PreferenceGroup.NOTIFICATION,
    kind: 'boolean',
    default: true,
  },
  [PreferenceKey.NOTIFICATION_NEEDS_ATTENTION]: {
    group: PreferenceGroup.NOTIFICATION,
    kind: 'boolean',
    // Always on and NOT overridable to false: "需要处理" must never be silenced.
    default: true,
    locked: true,
  },
  [PreferenceKey.NOTIFICATION_VERBOSITY]: {
    group: PreferenceGroup.NOTIFICATION,
    kind: 'enum',
    values: ['silent', 'brief', 'detailed'],
    default: 'brief',
  },
  [PreferenceKey.DATA_AUTHORIZATION_DEFAULT]: {
    group: PreferenceGroup.DATA_AUTHORIZATION,
    kind: 'enum',
    values: ['ask-each-time', 'deny'],
    default: 'ask-each-time',
  },
  [PreferenceKey.DATA_AUTHORIZATION_EXTERNAL_SERVICE]: {
    group: PreferenceGroup.DATA_AUTHORIZATION,
    kind: 'enum',
    values: ['ask-each-time', 'deny'],
    default: 'ask-each-time',
  },
  [PreferenceKey.DATA_AUTHORIZATION_UPLOAD_MATERIALS]: {
    group: PreferenceGroup.DATA_AUTHORIZATION,
    kind: 'enum',
    values: ['ask-each-time', 'deny'],
    default: 'ask-each-time',
  },
  [PreferenceKey.STORAGE_PROJECTS_ROOT]: {
    group: PreferenceGroup.STORAGE,
    kind: 'absolute-path',
    default: null,
  },
  [PreferenceKey.STORAGE_CACHE_RETENTION_DAYS]: {
    group: PreferenceGroup.STORAGE,
    kind: 'integer',
    default: 14,
    min: 0,
    max: 3650,
  },
  [PreferenceKey.WORKSPACE_SHOW_ADVANCED_PANELS]: {
    group: PreferenceGroup.WORKSPACE,
    kind: 'boolean',
    default: false,
  },
  [PreferenceKey.WORKSPACE_CONFIRM_BEFORE_DESTRUCTIVE]: {
    group: PreferenceGroup.WORKSPACE,
    kind: 'boolean',
    default: true,
  },
})

/** Every known preference key, in declaration order. */
export const PREFERENCE_KEYS = Object.freeze(Object.keys(PREFERENCE_SPEC))

/** Canonical defaults, derived from {@link PREFERENCE_SPEC} so the two cannot drift. */
export const DEFAULT_PREFERENCES = Object.freeze(
  Object.fromEntries(PREFERENCE_KEYS.map((key) => [key, PREFERENCE_SPEC[key].default])),
)

/**
 * Absolute path of the global settings file inside a caller-chosen settings directory.
 * @param {string} settingsDir absolute directory; C10 does not choose it (CT-00 §2)
 * @returns {string}
 */
export function globalPreferencesPath(settingsDir) {
  if (typeof settingsDir !== 'string' || !path.isAbsolute(settingsDir)) {
    throw new ValidationError('全局偏好目录必须是绝对路径', { field: 'settingsDir' })
  }
  return path.join(path.resolve(settingsDir), GLOBAL_PREFERENCES_FILE_NAME)
}

/**
 * Absolute path of a project's override file.
 * @param {import('./paths.js').ProjectPaths} projectPaths
 * @returns {string}
 */
export function projectPreferencesPath(projectPaths) {
  return assertProjectPaths(projectPaths).resolve(PROJECT_PREFERENCES_PATH)
}

/**
 * The group a preference key belongs to, validated against the frozen five.
 *
 * This is where a sixth group dies: `assertEnum` refuses anything not in
 * {@link PreferenceGroup}, so `blanket.unrestricted` fails loudly instead of being stored.
 *
 * @param {unknown} key
 * @returns {string} a {@link PreferenceGroup} value
 */
export function preferenceGroupOf(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new ValidationError('偏好键不能为空', { field: 'key' })
  }
  const separator = key.indexOf('.')
  if (separator <= 0) {
    throw new ValidationError('偏好键必须是“组.名称”的形式', { field: 'key' })
  }
  const group = key.slice(0, separator)
  return assertEnum(group, PreferenceGroup, 'key.group')
}

/**
 * Validate a preference key: known group, known name, no wildcard.
 * @param {unknown} key
 * @returns {string} the accepted key
 */
export function assertPreferenceKey(key) {
  preferenceGroupOf(key)
  const accepted = /** @type {string} */ (key)
  if (BLANKET_AUTHORIZATION_KEY_PATTERN.test(accepted)) {
    throw new ValidationError(BLANKET_AUTHORIZATION_REFUSAL, {
      field: 'key',
      value: accepted,
      reason: 'blanket-authorization-forbidden',
    })
  }
  if (PREFERENCE_SPEC[accepted] === undefined) {
    throw new ValidationError('未知的偏好键', {
      field: 'key',
      value: accepted,
      known: PREFERENCE_KEYS,
    })
  }
  return accepted
}

/**
 * Validate a preference value against its specification, and refuse blanket authorization.
 *
 * Refusing at the VALUE level as well as the key level matters because
 * `data-authorization.external-service = 'always-allow'` is a real blanket grant even though the
 * key is legitimate; that value is not in the enum, so it fails instead of opening the door.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {any} the normalized value
 */
export function assertPreferenceValue(key, value) {
  const accepted = assertPreferenceKey(key)
  assertNotBlanketAuthorization(accepted, value)
  const spec = PREFERENCE_SPEC[accepted]

  if (value === undefined) {
    throw new ValidationError('偏好值不能是 undefined', { field: 'value', key: accepted })
  }
  if (spec.locked === true && value !== spec.default) {
    // A locked preference protects a fact the product must never stop telling the user about,
    // for example "需要处理" notifications. Refusing is honest; silently ignoring would not be.
    throw new ValidationError('该偏好不可关闭，始终以默认值生效', {
      field: 'value',
      key: accepted,
      lockedValue: spec.default,
    })
  }
  if (value === null) {
    if (spec.kind === 'absolute-path') return null
    throw new ValidationError('该偏好不接受空值', { field: 'value', key: accepted })
  }

  switch (spec.kind) {
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new ValidationError('该偏好只接受布尔值', { field: 'value', key: accepted })
      }
      return value
    }
    case 'integer': {
      if (!Number.isInteger(value)) {
        throw new ValidationError('该偏好只接受整数', { field: 'value', key: accepted })
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new ValidationError(`该偏好不得小于 ${spec.min}`, { field: 'value', key: accepted })
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new ValidationError(`该偏好不得大于 ${spec.max}`, { field: 'value', key: accepted })
      }
      return value
    }
    case 'enum': {
      if (!Array.isArray(spec.values) || !spec.values.includes(value)) {
        throw new ValidationError('该偏好的取值不在允许范围内', {
          field: 'value',
          key: accepted,
          allowed: spec.values,
        })
      }
      return value
    }
    case 'text': {
      if (typeof value !== 'string') {
        throw new ValidationError('该偏好只接受文本', { field: 'value', key: accepted })
      }
      if (value.length > (spec.maxLength ?? 200)) {
        throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '偏好文本过长', {
          details: { field: 'value', key: accepted, limit: spec.maxLength ?? 200 },
        })
      }
      return value
    }
    case 'absolute-path': {
      if (typeof value !== 'string' || !path.isAbsolute(value)) {
        throw new ValidationError('该偏好需要一个绝对路径', { field: 'value', key: accepted })
      }
      return path.resolve(value)
    }
    default: {
      throw new WorkbenchError(ErrorCode.INTERNAL, '未知的偏好值类型', { details: { key: accepted } })
    }
  }
}

/**
 * Refuse any value that would mean "unrestricted".
 * @param {string} key
 * @param {unknown} value
 */
function assertNotBlanketAuthorization(key, value) {
  if (typeof value !== 'string') return
  const normalized = value.trim().toLowerCase()
  if (BLANKET_AUTHORIZATION_VALUES.includes(normalized)) {
    throw new ValidationError(BLANKET_AUTHORIZATION_REFUSAL, {
      field: 'value',
      key,
      value: normalized,
      reason: 'blanket-authorization-forbidden',
    })
  }
}

/**
 * Read the global settings document.
 *
 * A missing file is a normal answer. A PRESENT but corrupt file is reported as
 * `{ ok: false, corrupt: true, code: PREFERENCES_CORRUPT }` and is NOT modified or deleted: the
 * caller must show "需要处理" and let the user decide what to do with it.
 *
 * @param {string} globalPath absolute path from {@link globalPreferencesPath}
 * @returns {{
 *   ok: boolean, exists: boolean, corrupt: boolean, code: string | null, reason: string,
 *   values: Record<string, any>, revision: string, filePath: string,
 * }}
 */
export function readGlobalPreferences(globalPath) {
  return readPreferencesFile(globalPath, {
    label: '全局偏好',
    expectedKind: GLOBAL_PREFERENCES_KIND,
    projectId: null,
  })
}

/**
 * Read a project's override document.
 * @param {import('./paths.js').ProjectPaths} projectPaths
 * @returns {{
 *   ok: boolean, exists: boolean, corrupt: boolean, code: string | null, reason: string,
 *   values: Record<string, any>, revision: string, filePath: string,
 * }}
 */
export function readProjectPreferences(projectPaths) {
  const paths = assertProjectPaths(projectPaths)
  return readPreferencesFile(projectPreferencesPath(paths), {
    label: '项目偏好',
    expectedKind: PROJECT_PREFERENCES_KIND,
    projectId: paths.projectId,
  })
}

/**
 * Read one preferences file with corruption as a diagnosable RESULT, never a silent reset.
 * @param {string} filePath
 * @param {{ label: string, expectedKind: string, projectId: string | null }} options
 * @returns {object}
 */
function readPreferencesFile(filePath, options) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new ValidationError(`${options.label}文件必须是绝对路径`, { field: 'filePath' })
  }
  const base = {
    exists: false,
    corrupt: false,
    code: null,
    values: {},
    revision: '',
    filePath,
    reason: '',
  }
  if (!pathExists(filePath)) {
    return { ...base, ok: true, reason: '尚无该偏好文件，使用内置默认或另一作用域' }
  }

  let stored
  try {
    stored = tryReadDocument(filePath, { kind: PREFERENCES_KIND })
  } catch (error) {
    if (isCorruption(error)) {
      return {
        ...base,
        ok: false,
        exists: true,
        corrupt: true,
        code: NeedsAttentionCode.PREFERENCES_CORRUPT,
        reason: `${options.label}文件内容损坏，已保留原文件未覆盖；请在“需要处理”中查看`,
      }
    }
    throw error
  }
  if (stored === null) {
    return { ...base, ok: true, reason: '尚无该偏好文件' }
  }

  const document = stored.value
  const kind = document.kind
  if (kind !== undefined && kind !== options.expectedKind) {
    return {
      ...base,
      ok: false,
      exists: true,
      corrupt: true,
      code: NeedsAttentionCode.PREFERENCES_CORRUPT,
      revision: stored.revision,
      reason: `${options.label}文件类型与预期不符，已保留原文件未覆盖`,
    }
  }
  if (
    options.projectId !== null &&
    typeof document.projectId === 'string' &&
    document.projectId !== options.projectId
  ) {
    return {
      ...base,
      ok: false,
      exists: true,
      corrupt: true,
      code: NeedsAttentionCode.PREFERENCES_CORRUPT,
      revision: stored.revision,
      reason: `${options.label}文件属于另一个项目，拒绝按当前项目读写`,
    }
  }

  let values
  try {
    values = sanitizeStoredValues(document.values, options.label)
  } catch (error) {
    return {
      ...base,
      ok: false,
      exists: true,
      corrupt: true,
      code: NeedsAttentionCode.PREFERENCES_CORRUPT,
      revision: stored.revision,
      reason: `${options.label}文件里的取值不合法：${error instanceof Error ? error.message : '未知原因'}`,
    }
  }

  return {
    ...base,
    ok: true,
    exists: true,
    values,
    revision: stored.revision,
    reason: `${options.label}已读取`,
  }
}

/**
 * Validate stored values WITHOUT throwing away the whole file: an invalid entry is a corrupt
 * document (reported), not an empty preferences set.
 * @param {unknown} values
 * @param {string} label
 * @returns {Record<string, any>}
 */
function sanitizeStoredValues(values, label) {
  if (values === undefined) return {}
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new ValidationError(`${label}的 values 不是对象`)
  }
  const out = {}
  for (const [key, value] of Object.entries(values)) {
    // Throws for an unknown group/key or an illegal value; the caller turns that into CORRUPT.
    assertPreferenceKey(key)
    out[key] = assertPreferenceValue(key, value)
  }
  return out
}

/**
 * Whether an error means "the file content is unusable" (as opposed to an I/O failure).
 * @param {unknown} error
 * @returns {boolean}
 */
function isCorruption(error) {
  return error instanceof WorkbenchError && error.code === ErrorCode.CORRUPT_DATA
}

/**
 * Resolve one preference, stating which scope won.
 *
 * Precedence is project override, then global, then the built-in default. Each step is reported
 * separately, so a UI can show "仅本项目" for the project case and "全局默认" for the global one
 * without re-deriving anything.
 *
 * @param {object} options
 * @param {string} options.key
 * @param {string} options.globalPath absolute global settings file
 * @param {import('./paths.js').ProjectPaths | null} [options.projectPaths] omit for global only
 * @returns {{
 *   key: string, group: string, value: any, source: string, label: string,
 *   projectValue: any, globalValue: any, defaultValue: any,
 *   ok: boolean, corrupt: boolean, code: string | null, reasons: string[],
 * }}
 */
export function resolvePreference(options = {}) {
  const key = assertPreferenceKey(options.key)
  const spec = PREFERENCE_SPEC[key]
  const globalResult = readGlobalPreferences(requireGlobalPath(options.globalPath))
  const projectResult =
    options.projectPaths === undefined || options.projectPaths === null
      ? null
      : readProjectPreferences(/** @type {any} */ (options.projectPaths))

  const reasons = [globalResult.reason]
  if (projectResult !== null) reasons.push(projectResult.reason)

  const overwritten =
    projectResult !== null &&
    Object.prototype.hasOwnProperty.call(projectResult.values, key)
  const fromGlobal = Object.prototype.hasOwnProperty.call(globalResult.values, key)

  let source = ResolvedPreferenceSource.DEFAULT
  let value = spec.default
  if (overwritten) {
    source = ResolvedPreferenceSource.PROJECT_OVERRIDE
    value = projectResult.values[key]
  } else if (fromGlobal) {
    source = ResolvedPreferenceSource.GLOBAL
    value = globalResult.values[key]
  }

  const corrupt = !globalResult.ok || (projectResult !== null && !projectResult.ok)
  return {
    key,
    group: spec.group,
    value,
    source,
    label: SCOPE_LABELS[source],
    projectValue: overwritten ? projectResult.values[key] : undefined,
    globalValue: fromGlobal ? globalResult.values[key] : undefined,
    defaultValue: spec.default,
    ok: !corrupt,
    corrupt,
    code: corrupt
      ? NeedsAttentionCode.PREFERENCES_CORRUPT
      : null,
    reasons,
  }
}

/**
 * Resolve every known preference at once, for a settings surface.
 * @param {{ globalPath: string, projectPaths?: import('./paths.js').ProjectPaths | null }} options
 * @returns {{
 *   ok: boolean, corrupt: boolean, code: string | null,
 *   values: Record<string, any>, sources: Record<string, string>, items: object[],
 * }}
 */
export function resolveAllPreferences(options = {}) {
  const globalResult = readGlobalPreferences(requireGlobalPath(options.globalPath))
  const projectResult =
    options.projectPaths === undefined || options.projectPaths === null
      ? null
      : readProjectPreferences(/** @type {any} */ (options.projectPaths))
  const corrupt = !globalResult.ok || (projectResult !== null && !projectResult.ok)

  const values = {}
  const sources = {}
  const items = []
  for (const key of PREFERENCE_KEYS) {
    const spec = PREFERENCE_SPEC[key]
    const overwritten =
      projectResult !== null &&
      Object.prototype.hasOwnProperty.call(projectResult.values, key)
    const fromGlobal = Object.prototype.hasOwnProperty.call(globalResult.values, key)
    let source = ResolvedPreferenceSource.DEFAULT
    let value = spec.default
    if (overwritten) {
      source = ResolvedPreferenceSource.PROJECT_OVERRIDE
      value = projectResult.values[key]
    } else if (fromGlobal) {
      source = ResolvedPreferenceSource.GLOBAL
      value = globalResult.values[key]
    }
    values[key] = value
    sources[key] = source
    items.push({
      key,
      group: spec.group,
      value,
      source,
      label: SCOPE_LABELS[source],
      locked: spec.locked === true,
    })
  }
  return {
    ok: !corrupt,
    corrupt,
    code: corrupt ? NeedsAttentionCode.PREFERENCES_CORRUPT : null,
    values,
    sources,
    items,
  }
}

/**
 * Write one preference to the GLOBAL settings file.
 *
 * The file's current revision is read and required, so two settings windows cannot silently
 * overwrite each other; the store turns a stale revision into `VERSION_CONFLICT`. A global change
 * emits NO project event: there is no project to attribute it to (CT-03 §7 keeps the two scopes
 * apart).
 *
 * @param {object} options
 * @param {string} options.key
 * @param {any} options.value
 * @param {string} options.globalPath
 * @param {Clock} [options.clock]
 * @returns {{ key: string, value: any, scope: string, revision: string, previousValue: any,
 *   filePath: string, event: null }}
 */
export function setGlobalPreference(options = {}) {
  const key = assertPreferenceKey(options.key)
  const value = assertPreferenceValue(key, options.value)
  const globalPath = requireGlobalPath(options.globalPath)
  const clock = options.clock ?? new Clock()
  const current = readGlobalPreferences(globalPath)
  assertReadable(current, '全局偏好')

  const previousValue = Object.prototype.hasOwnProperty.call(current.values, key)
    ? current.values[key]
    : undefined
  const values = { ...current.values, [key]: value }
  const written = writePreferencesFile(globalPath, values, {
    kind: GLOBAL_PREFERENCES_KIND,
    projectId: null,
    expectedRevision: current.exists ? current.revision : null,
    createOnly: !current.exists,
    clock,
    label: '全局偏好',
  })
  return {
    key,
    value,
    scope: PreferenceScope.GLOBAL,
    revision: written.revision,
    previousValue,
    filePath: globalPath,
    event: null,
  }
}

/**
 * Write one preference as a PROJECT override.
 *
 * Only overrides are stored here, which is what makes "仅本项目" provable: a value that is absent
 * from this file cannot be a project decision. A `PREFERENCES_CHANGED` event is appended to the
 * project's log so the change is attributable and survives a fresh read.
 *
 * @param {object} options
 * @param {string} options.key
 * @param {any} options.value
 * @param {import('./paths.js').ProjectPaths} options.projectPaths
 * @param {string} [options.projectVersion]
 * @param {string} [options.author] an {@link Actor} value, default `user`
 * @param {string} [options.reason] why the user changed it, recorded in the event
 * @param {Clock} [options.clock]
 * @returns {{ key: string, value: any, scope: string, revision: string, previousValue: any,
 *   filePath: string, event: object }}
 */
export function setProjectPreference(options = {}) {
  const paths = assertProjectPaths(options.projectPaths)
  const key = assertPreferenceKey(options.key)
  const value = assertPreferenceValue(key, options.value)
  const clock = options.clock ?? new Clock()
  const author = assertEnum(options.author ?? Actor.USER, Actor, 'preferences.author')
  const current = readProjectPreferences(paths)
  assertReadable(current, '项目偏好')

  const previousValue = Object.prototype.hasOwnProperty.call(current.values, key)
    ? current.values[key]
    : undefined
  const values = { ...current.values, [key]: value }
  const written = writePreferencesFile(projectPreferencesPath(paths), values, {
    kind: PROJECT_PREFERENCES_KIND,
    projectId: paths.projectId,
    expectedRevision: current.exists ? current.revision : null,
    createOnly: !current.exists,
    clock,
    label: '项目偏好',
  })

  const event = buildEvent({
    kind: ProjectEventKind.PREFERENCES_CHANGED,
    projectId: paths.projectId,
    actor: author,
    aspect: 'preferences',
    scope: PreferenceScope.PROJECT,
    detail: {
      key,
      group: PREFERENCE_SPEC[key].group,
      previousValue,
      value,
      ...(typeof options.projectVersion === 'string' ? { projectVersion: options.projectVersion } : {}),
      ...(typeof options.reason === 'string' ? { reason: options.reason } : {}),
    },
  })
  appendEvents(paths.dir, [event], { clock })

  return {
    key,
    value,
    scope: PreferenceScope.PROJECT,
    revision: written.revision,
    previousValue,
    filePath: projectPreferencesPath(paths),
    event: structuredClone(event),
  }
}

/**
 * Remove one project override so the global value (or built-in default) applies again.
 *
 * Refuses when no override exists, because "cleared" and "was never set" are different facts and
 * reporting a successful clear that changed nothing would be a false claim.
 *
 * @param {object} options
 * @param {string} options.key
 * @param {import('./paths.js').ProjectPaths} options.projectPaths
 * @param {string} [options.projectVersion]
 * @param {string} [options.author]
 * @param {Clock} [options.clock]
 * @returns {{ key: string, removed: boolean, previousValue: any, revision: string, event: object }}
 */
export function clearProjectOverride(options = {}) {
  const paths = assertProjectPaths(options.projectPaths)
  const key = assertPreferenceKey(options.key)
  const clock = options.clock ?? new Clock()
  const author = assertEnum(options.author ?? Actor.USER, Actor, 'preferences.author')
  const current = readProjectPreferences(paths)
  assertReadable(current, '项目偏好')

  if (!Object.prototype.hasOwnProperty.call(current.values, key)) {
    throw new WorkbenchError(ErrorCode.NOT_FOUND, '该项目没有设置此项偏好，无需清除', {
      details: { key, scope: PreferenceScope.PROJECT, stage: 'preferences-clear' },
    })
  }
  const previousValue = current.values[key]
  const values = { ...current.values }
  delete values[key]
  const written = writePreferencesFile(projectPreferencesPath(paths), values, {
    kind: PROJECT_PREFERENCES_KIND,
    projectId: paths.projectId,
    expectedRevision: current.exists ? current.revision : null,
    createOnly: !current.exists,
    clock,
    label: '项目偏好',
  })

  const event = buildEvent({
    kind: ProjectEventKind.PREFERENCES_CHANGED,
    projectId: paths.projectId,
    actor: author,
    aspect: 'preferences',
    scope: PreferenceScope.PROJECT,
    detail: {
      key,
      group: PREFERENCE_SPEC[key].group,
      previousValue,
      value: undefined,
      removed: true,
      ...(typeof options.projectVersion === 'string'
        ? { projectVersion: options.projectVersion }
        : {}),
    },
  })
  appendEvents(paths.dir, [event], { clock })

  return {
    key,
    removed: true,
    previousValue,
    revision: written.revision,
    event: structuredClone(event),
  }
}

/**
 * Report preference health for the "需要处理" decision, without mutating anything.
 * @param {{ globalPath: string, projectPaths?: import('./paths.js').ProjectPaths | null }} options
 * @returns {{ ok: boolean, needsAttention: string[], items: object[] }}
 */
export function describePreferencesHealth(options = {}) {
  const globalResult = readGlobalPreferences(requireGlobalPath(options.globalPath))
  const items = [
    {
      scope: PreferenceScope.GLOBAL,
      filePath: globalResult.filePath,
      exists: globalResult.exists,
      ok: globalResult.ok,
      code: globalResult.code,
      reason: globalResult.reason,
    },
  ]
  if (options.projectPaths !== undefined && options.projectPaths !== null) {
    const projectResult = readProjectPreferences(/** @type {any} */ (options.projectPaths))
    items.push({
      scope: PreferenceScope.PROJECT,
      filePath: projectResult.filePath,
      exists: projectResult.exists,
      ok: projectResult.ok,
      code: projectResult.code,
      reason: projectResult.reason,
    })
  }
  const needsAttention = items.filter((item) => !item.ok).map((item) => String(item.code))
  return { ok: needsAttention.length === 0, needsAttention, items }
}

/**
 * Short name for {@link resolvePreference}, matching the wording of the C10 card ("resolve(key)").
 *
 * Both names exist deliberately: the long one states what it resolves, and the short one is what
 * the card and a settings surface refer to. There is exactly one implementation, so they cannot
 * drift into two behaviours.
 */
export const resolve = resolvePreference

/** Short name for {@link setGlobalPreference} (C10 card: "setGlobal"). */
export const setGlobal = setGlobalPreference

/** Short name for {@link setProjectPreference} (C10 card: "setProject"). */
export const setProject = setProjectPreference

/**
 * Write one preferences document through the versioned store.
 * @param {string} filePath absolute
 * @param {Record<string, any>} values
 * @param {object} options
 * @returns {{ revision: string, sha256: string, bytes: number }}
 */
function writePreferencesFile(filePath, values, options) {
  const body = {
    kind: options.kind,
    ...(options.projectId === null ? {} : { projectId: options.projectId }),
    values,
  }
  const writeOptions = {
    kind: PREFERENCES_KIND,
    schemaKey: PREFERENCES_KIND,
    clock: options.clock,
  }
  if (options.createOnly === true) {
    writeOptions.createOnly = true
  } else {
    writeOptions.expectedRevision = options.expectedRevision ?? ''
  }
  try {
    return writeDocument(filePath, body, writeOptions)
  } catch (error) {
    if (error instanceof WorkbenchError && error.code === ErrorCode.CONFLICT) {
      throw new WorkbenchError(ErrorCode.VERSION_CONFLICT, '偏好已被其他窗口更新，本次修改未写入', {
        details: {
          label: options.label,
          stage: 'preferences-revision',
          expectedRevision: writeOptions.expectedRevision ?? null,
          actualRevision: error.details?.actualRevision ?? null,
          action: '重新读取偏好后基于最新修订重做，不要覆盖他人新结果',
        },
        cause: error,
      })
    }
    throw error
  }
}

/**
 * Refuse to write over a corrupt or unreadable preferences file: the user must handle it first.
 * @param {{ ok: boolean, corrupt: boolean, code: string | null, reason: string }} result
 * @param {string} label
 */
function assertReadable(result, label) {
  if (result.ok) return
  throw new WorkbenchError(ErrorCode.CORRUPT_DATA, `${label}文件已损坏，本次修改未执行`, {
    details: {
      label,
      needsAttention: NeedsAttentionCode.PREFERENCES_CORRUPT,
      action: '保留原文件，由用户在“需要处理”中决定如何修复；程序不覆盖、不删除',
    },
  })
}

/**
 * Require an absolute global settings path, named clearly when it is missing.
 * @param {unknown} value
 * @returns {string}
 */
function requireGlobalPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('需要传入全局偏好文件的绝对路径', { field: 'globalPath' })
  }
  if (!path.isAbsolute(value)) {
    throw new ValidationError('全局偏好文件必须是绝对路径', { field: 'globalPath' })
  }
  return path.resolve(value)
}

/**
 * Assert a real {@link import('./paths.js').ProjectPaths} instance without importing its class.
 * @param {unknown} value
 * @returns {import('./paths.js').ProjectPaths}
 */
function assertProjectPaths(value) {
  const candidate = /** @type {any} */ (value)
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.resolve !== 'function' ||
    typeof candidate.projectId !== 'string' ||
    typeof candidate.dir !== 'string'
  ) {
    throw new ValidationError('偏好操作需要一个 ProjectPaths 实例', { field: 'projectPaths' })
  }
  return candidate
}
