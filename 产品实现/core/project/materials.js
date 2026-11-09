/**
 * Materials: the bytes the user supplied, the rights that apply, and what the user said they may
 * be used for.
 *
 * Why this module exists (CT-03 §3, C10 card §4.1):
 * - A material is a RECORDED FACT about real bytes: content hash, byte size, kind, rights and
 *   observation state. The original filename is metadata and is NEVER used as a path, so a name
 *   such as `..\..\win.ini` cannot influence where bytes land.
 * - A use is the user's own sentence, stored VERBATIM, plus exclusions and limited scopes.
 *   There is deliberately NO pre-approval form: an unrestricted use is legal and defaults to
 *   "may use for this project's goals, must be disclosed in brief, plan or result". A later
 *   restriction only rewrites the CURRENT state and appends history, so the earlier recorded
 *   fact stays readable (CT-03 §3 "程序只作用新范围并保留历史").
 * - Rights and observation are recorded facts, never claims. Nothing here infers
 *   `observed-full` from a successful read: "程序读过文件" and "AI 看过内容" are different
 *   product facts, and a single boolean would force a lie.
 * - Persistence goes through `core/project/store.js`, so every write states the revision it was
 *   based on; a concurrent writer is refused with `VERSION_CONFLICT` instead of silently
 *   overwriting a newer result (CT-02 §3).
 *
 * @module core/project/materials
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  ConflictError,
  ErrorCode,
  IoError,
  NotFoundError,
  ValidationError,
  WorkbenchError,
  deleteIfHashMatches,
  sha256,
  stableStringify,
  writeFileAtomic,
} from '../../base/index.js'
import {
  Actor,
  MaterialKind,
  MaterialObservation,
  NeedsAttentionCode,
  RightsStatus,
  assertEnum,
} from './schema.js'
import { assertId, derivedId, newId, newUseInstanceId } from './ids.js'
import { PROJECT_LAYOUT, pathExists } from './paths.js'
import { fileSha256, fileSize, isReadableFile, tryReadDocument, writeDocument } from './store.js'
import { ProjectEventKind, appendEvents, buildEvent } from './events.js'

/** Document kind used in error messages AND as the migration-chain key (store.js). */
export const MATERIALS_KIND = 'materials'

/** `kind` of the materials catalog document itself. */
export const MATERIALS_CATALOG_KIND = 'materials-catalog'

/** Where a material came from. A closed set, so "source" cannot become unqueryable free text. */
export const MaterialSource = Object.freeze({
  UPLOAD: 'upload',
  PROJECT_IMPORT: 'project-import',
  GENERATED: 'generated',
  REFERENCE: 'reference',
  OTHER: 'other',
})

/** What a recorded exclusion addresses. */
export const ExclusionKind = Object.freeze({
  RANGE: 'range',
  SEGMENT: 'segment',
  ALL: 'all',
})

/** Unit of an excluded range. Only units the product can actually compare are accepted. */
export const ExclusionUnit = Object.freeze({
  SECONDS: 'seconds',
  FRAMES: 'frames',
})

/**
 * Stable reason codes for a permission query, so the UI renders a real explanation instead of a
 * generic refusal. These are NOT a parallel fact source: each one is derived from the stored use.
 */
export const PermissionCode = Object.freeze({
  DEFAULT_PROJECT_USE: 'DEFAULT_PROJECT_USE',
  RECORDED_USE: 'RECORDED_USE',
  MATERIAL_NOT_RECORDED: 'MATERIAL_NOT_RECORDED',
  RIGHTS_RESTRICTED: 'RIGHTS_RESTRICTED',
  RIGHTS_UNKNOWN: 'RIGHTS_UNKNOWN',
  MATERIAL_NOT_OBSERVED: 'MATERIAL_NOT_OBSERVED',
  EXCLUDED_RANGE: 'EXCLUDED_RANGE',
  EXCLUDED_PARTIAL: 'EXCLUDED_PARTIAL',
  OUTSIDE_LIMITED_SCOPE: 'OUTSIDE_LIMITED_SCOPE',
  SCOPE_UNCONFIRMED: 'SCOPE_UNCONFIRMED',
  PURPOSE_NOT_ALLOWED: 'PURPOSE_NOT_ALLOWED',
  PURPOSE_UNCONFIRMED: 'PURPOSE_UNCONFIRMED',
})

/**
 * The permission an unrestricted use records (CT-03 §3: 无特别限制时可按项目目标使用，并在简报、
 * 方案或结果中说明). This is the DEFAULT, never a pre-approval gate.
 */
export const DEFAULT_USE_PERMISSION = Object.freeze({
  mayUseForProjectGoals: true,
  mustDiscloseIn: Object.freeze(['brief', 'plan', 'result']),
  // CT-03 §3 requires a SEPARATE authorization for each of these, so no use record can grant it.
  requiresAuthorizationFor: Object.freeze([
    'external-service',
    'data-destination',
    'registration',
    'payment',
    'download',
    'install',
    'environment-change',
  ]),
})

/** In-memory byte ceiling. CT-02 §3.3 requires a controlled stream for large media; that path does
 * not exist yet, so a larger file is REFUSED instead of being read whole and pretending success. */
export const MAX_IN_MEMORY_MATERIAL_BYTES = 64 * 1024 * 1024

/** User statements are resource-limited input (CT-12 §3). */
export const MAX_USER_TEXT_LENGTH = 20000

/** Notes are short annotations, not a second statement. */
export const MAX_NOTE_LENGTH = 2000

/** Limits for a single list field. */
export const MAX_LIST_ITEMS = 100
export const MAX_LIST_ITEM_LENGTH = 500

/** Exact permission value accepted by `query.segment.unit`. */
const PERMISSION_CHECK = Object.freeze({
  OK: 'ok',
  PARTIAL: 'partial',
  BLOCKED: 'blocked',
  WARNING: 'warning',
})

/**
 * Absolute path of the materials catalog.
 * @param {import('./paths.js').ProjectPaths} projectPaths
 * @returns {string}
 */
export function materialsIndexPath(projectPaths) {
  return assertProjectPaths(projectPaths).resolve(PROJECT_LAYOUT.materialsIndex)
}

/**
 * Project-relative path that holds ONE material's bytes.
 *
 * The path is derived from the material ID plus a strictly validated extension, never from the
 * original filename. Because the ID has already been validated, the traversal risk is confined to
 * the extension characters, which are checked against `^.[A-Za-z0-9]{1,10}$`.
 *
 * @param {string} materialId
 * @param {string} [originalFilename] metadata only; only a safe extension is taken from it
 * @returns {string} posix relative path, e.g. `materials/files/mat_.../content.jpg`
 */
export function materialStorageRelativePath(materialId, originalFilename) {
  const id = assertId(materialId, 'material', 'materialId')
  const extension = safeExtension(originalFilename)
  return `${PROJECT_LAYOUT.materialsFilesDir}/${id}/content${extension}`
}

/**
 * An empty catalog, matching what a project without `materials/index.json` means.
 * @param {string} projectId
 * @returns {{ projectId: string, materials: object[], uses: object[] }}
 */
export function emptyMaterialsCatalog(projectId) {
  return { projectId, materials: [], uses: [] }
}

/**
 * Read the catalog from disk.
 *
 * A missing file is a normal answer (`exists: false`, empty lists), never an error: a fresh
 * project has no materials yet. A PRESENT but unreadable file throws, because starting from `{}`
 * would destroy the user's material record (CT-11 §5 "不用同样错误结果冒充").
 *
 * @param {import('./paths.js').ProjectPaths} projectPaths
 * @param {{ clock?: Clock }} [options]
 * @returns {{
 *   projectId: string, materials: object[], uses: object[],
 *   revision: string, exists: boolean, sha256: string, bytes: number,
 * }}
 */
export function readMaterialsCatalog(projectPaths, options = {}) {
  const paths = assertProjectPaths(projectPaths)
  const filePath = materialsIndexPath(paths)
  const stored = tryReadDocument(filePath, { kind: MATERIALS_KIND })
  if (stored === null) {
    return {
      projectId: paths.projectId,
      materials: [],
      uses: [],
      revision: '',
      exists: false,
      sha256: '',
      bytes: 0,
    }
  }

  const document = stored.value
  if (document.kind !== undefined && document.kind !== MATERIALS_CATALOG_KIND) {
    throw corruptCatalog('材料清单类型字段不正确')
  }
  if (typeof document.projectId === 'string' && document.projectId !== paths.projectId) {
    // One project's catalog must never be read as another project's, or a copy would silently
    // inherit the source project's material identities.
    throw corruptCatalog('材料清单属于另一个项目，拒绝按当前项目读写')
  }
  const materials = assertRecordList(document.materials, 'materials')
  const uses = assertRecordList(document.uses, 'uses')
  for (const material of materials) {
    if (typeof material.materialId !== 'string') throw corruptCatalog('材料条目缺少 materialId')
  }
  for (const use of uses) {
    if (typeof use.useId !== 'string' || typeof use.materialId !== 'string') {
      throw corruptCatalog('用途条目缺少 useId 或 materialId')
    }
  }
  return {
    projectId: paths.projectId,
    materials,
    uses,
    revision: stored.revision,
    exists: true,
    sha256: stored.sha256,
    bytes: stored.bytes,
  }
}

/**
 * Write the catalog through the versioned store.
 *
 * `expectedRevision` is REQUIRED when the file exists: silently overwriting another writer's
 * newer catalog is exactly the double-write C10 §6.6 forbids. A stale revision surfaces as
 * `VERSION_CONFLICT` (stable code), with the real revisions in `details` for the recovery path.
 *
 * @param {import('./paths.js').ProjectPaths} projectPaths
 * @param {{ materials: object[], uses: object[] }} catalog
 * @param {{ expectedRevision?: string, clock?: Clock }} [options]
 * @returns {{ revision: string, sha256: string, bytes: number, filePath: string }}
 */
export function writeMaterialsCatalog(projectPaths, catalog, options = {}) {
  const paths = assertProjectPaths(projectPaths)
  const clock = options.clock ?? new Clock()
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new ValidationError('材料清单必须是对象', { field: 'catalog' })
  }
  const materials = assertRecordList(catalog.materials, 'materials')
  const uses = assertRecordList(catalog.uses, 'uses')
  const filePath = materialsIndexPath(paths)
  const exists = pathExists(filePath)
  const expectedRevision = options.expectedRevision

  if (exists && (expectedRevision === undefined || expectedRevision === null)) {
    throw new ValidationError('写入材料清单必须声明基于的修订', { field: 'expectedRevision' })
  }
  if (!exists && typeof expectedRevision === 'string' && expectedRevision.length > 0) {
    throw materialsVersionConflict(paths.projectId, expectedRevision, '')
  }

  const body = {
    kind: MATERIALS_CATALOG_KIND,
    projectId: paths.projectId,
    materials: materials.map((record) => structuredClone(record)),
    uses: uses.map((record) => structuredClone(record)),
  }

  let written
  try {
    written = writeDocument(filePath, body, {
      kind: MATERIALS_KIND,
      schemaKey: MATERIALS_KIND,
      clock,
      ...(exists ? { expectedRevision } : { createOnly: true }),
    })
  } catch (error) {
    if (error instanceof ConflictError) {
      throw materialsVersionConflict(
        paths.projectId,
        expectedRevision ?? null,
        error.details?.actualRevision ?? null,
      )
    }
    throw error
  }
  return { revision: written.revision, sha256: written.sha256, bytes: written.bytes, filePath }
}

/**
 * Register one material: copy its bytes into the project, hash the REAL bytes, append a record.
 *
 * Ordering is deliberate: read the catalog (so a base-revision mismatch is refused before any
 * bytes are written), write the bytes atomically with a pre-declared hash, hash the published
 * file again, then publish the record. If the catalog write conflicts, the just-written,
 * provably-ours file is removed so a failed attempt does not leak an unreferenced copy.
 *
 * @param {object} options
 * @param {import('./paths.js').ProjectPaths} options.projectPaths
 * @param {Buffer|Uint8Array|string} [options.bytes] the content, in memory
 * @param {string} [options.sourceFile] absolute path to copy the content from
 * @param {string} [options.originalFilename] required with `bytes`
 * @param {string} options.kind a {@link MaterialKind} value
 * @param {string} [options.source] a {@link MaterialSource} value, default `upload`
 * @param {string} [options.sourceLabel] human description of where it came from
 * @param {string} [options.rightsStatus] a {@link RightsStatus} value, default `unknown`
 * @param {string} [options.observation] a {@link MaterialObservation} value, default `unread`
 * @param {string} [options.note]
 * @param {string} [options.author] an {@link Actor} value, default `user`
 * @param {string} [options.baseRevision] catalog revision this change is based on
 * @param {Clock} [options.clock]
 * @returns {{ material: object, revision: string, previousRevision: string, event: object }}
 */
export function addMaterial(options = {}) {
  const paths = assertProjectPaths(options.projectPaths)
  const clock = options.clock ?? new Clock()
  const kind = assertEnum(options.kind, MaterialKind, 'material.kind')
  const source = assertEnum(options.source ?? MaterialSource.UPLOAD, MaterialSource, 'material.source')
  const rightsStatus = assertEnum(
    options.rightsStatus ?? RightsStatus.UNKNOWN,
    RightsStatus,
    'material.rightsStatus',
  )
  // The observation is taken from the caller ONLY. The successful read below is not evidence the
  // user or the AI ever looked at the content, so it must never upgrade this value.
  const observation = assertEnum(
    options.observation ?? MaterialObservation.UNREAD,
    MaterialObservation,
    'material.observation',
  )
  const author = assertEnum(options.author ?? Actor.USER, Actor, 'material.author')
  const sourceLabel = optionalText(options.sourceLabel, 'sourceLabel', 200)
  const note = optionalText(options.note, 'note', MAX_NOTE_LENGTH)
  const { bytes, originalFilename } = resolveMaterialBytes(options)

  const catalog = readMaterialsCatalog(paths, { clock })
  guardBaseRevision(options.baseRevision, catalog.revision, paths.projectId)

  const materialId = newId('material')
  const storedRelativePath = materialStorageRelativePath(materialId, originalFilename)
  const absolutePath = paths.resolve(storedRelativePath)
  const expectedSha256 = sha256(bytes)
  writeFileAtomic(absolutePath, bytes, { expectedSha256 })

  // Hash and size are read back from the PUBLISHED file, so the record describes bytes that
  // actually exist on disk rather than the buffer we hoped we wrote.
  const contentSha256 = fileSha256(absolutePath)
  if (contentSha256 !== expectedSha256) {
    throw new IoError('材料写入后内容哈希与预期不一致', {
      details: { stage: 'material-write', expected: expectedSha256, actual: contentSha256 },
    })
  }
  const byteSize = fileSize(absolutePath)
  if (byteSize !== bytes.length) {
    throw new IoError('材料写入后字节数不一致', {
      details: { stage: 'material-write', expected: bytes.length, actual: byteSize },
    })
  }

  const material = {
    materialId,
    projectId: paths.projectId,
    kind,
    source,
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
    rightsStatus,
    observation,
    originalFilename,
    storedRelativePath,
    contentSha256,
    byteSize,
    addedAt: clock.iso(),
    addedBy: author,
    ...(note === undefined ? {} : { note }),
  }

  let written
  try {
    written = writeMaterialsCatalog(
      paths,
      { ...catalog, materials: [...catalog.materials, material] },
      { expectedRevision: catalog.revision, clock },
    )
  } catch (error) {
    // Only remove a file we just created and can prove by hash; never touch anything else.
    removeOwnMaterialFile(absolutePath, expectedSha256)
    throw error
  }

  const event = buildEvent({
    kind: ProjectEventKind.MATERIAL_ADDED,
    projectId: paths.projectId,
    actor: author,
    objectId: materialId,
    detail: {
      kind,
      source,
      rightsStatus,
      observation,
      originalFilename,
      storedRelativePath,
      contentSha256,
      byteSize,
    },
  })
  appendEvents(paths.dir, [event], { clock })

  return {
    material: structuredClone(material),
    revision: written.revision,
    previousRevision: catalog.revision,
    event: structuredClone(event),
  }
}

/**
 * Record the user's natural-language use of one material, VERBATIM.
 *
 * No approval gate is modelled: a use with no stated restriction is legal and its recorded
 * permission defaults to "may use for this project's goals, must disclose in brief/plan/result"
 * (CT-03 §3). Only the separate authorizations listed in `requiresAuthorizationFor` still need
 * their own record; that is a different fact, not a precondition for reading this one.
 *
 * @param {object} options
 * @param {import('./paths.js').ProjectPaths} options.projectPaths
 * @param {string} options.materialId
 * @param {string} options.userText the user's own words, stored verbatim
 * @param {string[]} [options.allowedUses] stated allowed purposes; empty means unrestricted
 * @param {object[]} [options.exclusions] excluded ranges or segments
 * @param {string[]} [options.limitedScopes] stated scopes the use is limited to
 * @param {string} options.projectVersion project version this statement belongs to
 * @param {string} [options.author] an {@link Actor} value, default `user`
 * @param {string} [options.note]
 * @param {string} [options.baseRevision]
 * @param {Clock} [options.clock]
 * @returns {{ use: object, revision: string, previousRevision: string, event: object }}
 */
export function recordUse(options = {}) {
  const paths = assertProjectPaths(options.projectPaths)
  const clock = options.clock ?? new Clock()
  const materialId = assertId(options.materialId, 'material', 'materialId')
  const userText = assertVerbatimText(options.userText, 'userText')
  const projectVersion = assertProjectVersion(options.projectVersion)
  const author = assertEnum(options.author ?? Actor.USER, Actor, 'use.author')
  const note = optionalText(options.note, 'note', MAX_NOTE_LENGTH)
  const allowedUses = normalizeStringList(options.allowedUses, 'allowedUses')
  const limitedScopes = normalizeStringList(options.limitedScopes, 'limitedScopes')
  const exclusions = normalizeExclusions(options.exclusions)

  const catalog = readMaterialsCatalog(paths, { clock })
  if (!catalog.materials.some((material) => material.materialId === materialId)) {
    throw new NotFoundError('未找到该材料记录，不能记录用途', { materialId })
  }
  guardBaseRevision(options.baseRevision, catalog.revision, paths.projectId)

  const use = {
    useId: newUseInstanceId(),
    projectId: paths.projectId,
    materialId,
    userText,
    allowedUses,
    exclusions,
    limitedScopes,
    permission: buildUsePermission({ allowedUses, exclusions, limitedScopes }),
    recordedAt: clock.iso(),
    projectVersion,
    author,
    amendments: [],
    ...(note === undefined ? {} : { note }),
  }

  const written = writeMaterialsCatalog(
    paths,
    { ...catalog, uses: [...catalog.uses, use] },
    { expectedRevision: catalog.revision, clock },
  )

  const event = buildEvent({
    kind: ProjectEventKind.MATERIAL_USE_RECORDED,
    projectId: paths.projectId,
    actor: author,
    objectId: use.useId,
    detail: {
      materialId,
      projectVersion,
      userText,
      allowedUses,
      exclusions,
      limitedScopes,
      permission: structuredClone(use.permission),
    },
  })
  appendEvents(paths.dir, [event], { clock })

  return {
    use: structuredClone(use),
    revision: written.revision,
    previousRevision: catalog.revision,
    event: structuredClone(event),
  }
}

/**
 * Amend one recorded use. The CURRENT state changes; history is appended, never rewritten.
 *
 * Omitted fields keep their current value, so a caller restricting one dimension cannot
 * accidentally clear another. Passing an empty array explicitly clears that dimension, which is
 * also a user right ("用户可随时改变用途或排除内容", CT-03 §3); the previous state is still kept.
 *
 * @param {object} options
 * @param {import('./paths.js').ProjectPaths} options.projectPaths
 * @param {string} options.useId
 * @param {string} [options.materialId] cross-check: refuse an amendment aimed at another material
 * @param {string[]} [options.allowedUses] replacement list
 * @param {object[]} [options.exclusions] replacement list
 * @param {string[]} [options.limitedScopes] replacement list
 * @param {string} [options.userText] a NEW statement, stored verbatim in the amendment
 * @param {string} options.projectVersion
 * @param {string} [options.author]
 * @param {string} [options.note]
 * @param {string} [options.baseRevision]
 * @param {Clock} [options.clock]
 * @returns {{ previous: object, current: object, amendment: object, revision: string, events: object[] }}
 */
export function amendUse(options = {}) {
  return applyUseChange(options, 'amend')
}

/**
 * Add exclusions to an existing use without disturbing its other recorded dimensions.
 *
 * Kept as a named action because "排除某段内容" is what the product offers directly; it appends
 * the same amendment record plus a dedicated `MATERIAL_EXCLUDED` event.
 *
 * @param {object} options same shape as {@link amendUse}, with `exclusions` required
 * @returns {{ previous: object, current: object, amendment: object, revision: string, events: object[] }}
 */
export function excludeFromUse(options = {}) {
  return applyUseChange(options, 'exclude')
}

/**
 * The material record for an id, or `null`.
 * @param {{ materials?: object[] }} catalog
 * @param {string} materialId
 * @returns {object | null}
 */
export function findMaterial(catalog, materialId) {
  const id = assertId(materialId, 'material', 'materialId')
  const materials = Array.isArray(catalog?.materials) ? catalog.materials : []
  return materials.find((material) => material.materialId === id) ?? null
}

/**
 * Every recorded use of a material, in the order they were recorded.
 * @param {{ uses?: object[] }} catalog
 * @param {string} materialId
 * @returns {object[]}
 */
export function usesForMaterial(catalog, materialId) {
  const id = assertId(materialId, 'material', 'materialId')
  const uses = Array.isArray(catalog?.uses) ? catalog.uses : []
  return uses.filter((use) => use.materialId === id)
}

/**
 * The most recently recorded use of a material, or `null`.
 * @param {{ uses?: object[] }} catalog
 * @param {string} materialId
 * @returns {object | null}
 */
export function latestUseForMaterial(catalog, materialId) {
  const uses = usesForMaterial(catalog, materialId)
  return uses.length === 0 ? null : uses[uses.length - 1]
}

/**
 * Describe what the recorded facts allow for one material, as a queryable result.
 *
 * This is the ONE place a later card asks "may I use this, and what must I disclose?" instead of
 * re-implementing exclusion/scope logic. It answers three distinct states — allowed, PARTIAL
 * (a dimension could not be evaluated because the caller did not state a segment/scope/purpose)
 * and blocked — because collapsing "I cannot check" into "allowed" is how an excluded segment
 * would get used.
 *
 * IMPORTANT: `allowed` means "you may proceed now", so it is false whenever any dimension is
 * merely undecidable. `partial` then says why. A caller that treats `allowed` as
 * "not blocked" would act on an unverifiable request, which is the failure this split prevents.
 *
 * @param {{ materials: object[], uses: object[] }} catalog
 * @param {object} query
 * @param {string} query.materialId
 * @param {string} [query.purpose] what the caller wants to do with it
 * @param {{ start: number, end: number, unit?: string }} [query.segment] the requested range
 * @param {string} [query.segmentLabel] a named segment, matched against `kind: 'segment'`
 * @param {string} [query.scope] the stated scope, matched against `limitedScopes`
 * @returns {object} a permission description with `allowed`, `partial`, `code` and `checks`
 */
export function describeEffectivePermission(catalog, query = {}) {
  if (
    catalog === null ||
    typeof catalog !== 'object' ||
    !Array.isArray(catalog.materials) ||
    !Array.isArray(catalog.uses)
  ) {
    throw new ValidationError('查询材料用途需要材料清单', { field: 'catalog' })
  }
  const materialId = assertId(query.materialId, 'material', 'materialId')
  const material = catalog.materials.find((item) => item.materialId === materialId)
  if (material === undefined) {
    return {
      materialId,
      materialKind: null,
      rightsStatus: null,
      observation: null,
      useId: null,
      source: 'default',
      allowed: false,
      partial: false,
      code: PermissionCode.MATERIAL_NOT_RECORDED,
      reason: '没有该材料的登记记录，不能按项目目标使用',
      mustDiscloseIn: [...DEFAULT_USE_PERMISSION.mustDiscloseIn],
      requiresAuthorizationFor: [...DEFAULT_USE_PERMISSION.requiresAuthorizationFor],
      allowedUses: [],
      exclusions: [],
      limitedScopes: [],
      matchedExclusion: null,
      warnings: [],
      checks: [
        {
          aspect: 'record',
          status: PERMISSION_CHECK.BLOCKED,
          code: PermissionCode.MATERIAL_NOT_RECORDED,
          detail: '材料未登记',
        },
      ],
    }
  }

  const uses = catalog.uses.filter((use) => use.materialId === materialId)
  const use = uses.length === 0 ? null : uses[uses.length - 1]
  const checks = []

  if (material.rightsStatus === RightsStatus.RESTRICTED) {
    checks.push({
      aspect: 'rights',
      status: PERMISSION_CHECK.BLOCKED,
      code: PermissionCode.RIGHTS_RESTRICTED,
      detail: '材料权利状态为受限，需先记录明确的授权范围',
    })
  } else if (material.rightsStatus === RightsStatus.UNKNOWN) {
    checks.push({
      aspect: 'rights',
      status: PERMISSION_CHECK.WARNING,
      code: PermissionCode.RIGHTS_UNKNOWN,
      detail: '权利状态未知：只能参考，不得当作可复制或可分发',
    })
  } else {
    checks.push({
      aspect: 'rights',
      status: PERMISSION_CHECK.OK,
      code: null,
      detail: String(material.rightsStatus),
    })
  }

  const observation = material.observation ?? MaterialObservation.UNKNOWN
  const notObserved =
    observation === MaterialObservation.UNREAD || observation === MaterialObservation.UNREADABLE
  checks.push({
    aspect: 'observation',
    status: notObserved ? PERMISSION_CHECK.WARNING : PERMISSION_CHECK.OK,
    code: notObserved ? PermissionCode.MATERIAL_NOT_OBSERVED : null,
    detail: notObserved ? '程序尚未观察材料内容；不得声称看过内容' : String(observation),
  })

  const allowedUses = use === null ? [] : [...(use.allowedUses ?? [])]
  const exclusions = use === null ? [] : structuredClone(use.exclusions ?? [])
  const limitedScopes = use === null ? [] : [...(use.limitedScopes ?? [])]
  const purpose = nonEmptyText(query.purpose)

  if (allowedUses.length === 0) {
    checks.push({
      aspect: 'allowed-uses',
      status: PERMISSION_CHECK.OK,
      code: null,
      detail: '未声明用途限制：可按项目目标使用',
    })
  } else if (purpose === undefined) {
    checks.push({
      aspect: 'allowed-uses',
      status: PERMISSION_CHECK.PARTIAL,
      code: PermissionCode.PURPOSE_UNCONFIRMED,
      detail: '记录声明了允许用途；调用方需要说明 purpose 才能确认',
    })
  } else if (allowedUses.includes(purpose)) {
    checks.push({ aspect: 'allowed-uses', status: PERMISSION_CHECK.OK, code: null, detail: purpose })
  } else {
    checks.push({
      aspect: 'allowed-uses',
      status: PERMISSION_CHECK.BLOCKED,
      code: PermissionCode.PURPOSE_NOT_ALLOWED,
      detail: `用户记录的允许用途不包含「${purpose}」`,
    })
  }

  if (exclusions.length === 0) {
    checks.push({
      aspect: 'exclusions',
      status: PERMISSION_CHECK.OK,
      code: null,
      detail: '未声明排除内容',
    })
  } else {
    const segment = normalizeQuerySegment(query.segment)
    const segmentLabel = nonEmptyText(query.segmentLabel)
    const matched = findMatchingExclusion(exclusions, segment, segmentLabel)
    if (matched === 'indeterminate') {
      checks.push({
        aspect: 'exclusions',
        status: PERMISSION_CHECK.PARTIAL,
        code: PermissionCode.EXCLUDED_PARTIAL,
        detail: '已记录排除内容；调用方需要给出 segment 或 segmentLabel 才能确认',
        exclusion: null,
      })
    } else if (matched === null) {
      checks.push({
        aspect: 'exclusions',
        status: PERMISSION_CHECK.OK,
        code: null,
        detail: '请求范围与已排除内容不重叠',
        exclusion: null,
      })
    } else {
      checks.push({
        aspect: 'exclusions',
        status: PERMISSION_CHECK.BLOCKED,
        code: PermissionCode.EXCLUDED_RANGE,
        detail: `请求落在已排除内容内：${matched.label ?? matched.kind}`,
        exclusion: structuredClone(matched),
      })
    }
  }

  if (limitedScopes.length === 0) {
    checks.push({
      aspect: 'limited-scopes',
      status: PERMISSION_CHECK.OK,
      code: null,
      detail: '未声明限定范围',
    })
  } else {
    const scope = nonEmptyText(query.scope)
    if (scope === undefined) {
      checks.push({
        aspect: 'limited-scopes',
        status: PERMISSION_CHECK.PARTIAL,
        code: PermissionCode.SCOPE_UNCONFIRMED,
        detail: '记录声明了限定范围；调用方需要说明 scope 才能确认',
      })
    } else if (limitedScopes.includes(scope)) {
      checks.push({
        aspect: 'limited-scopes',
        status: PERMISSION_CHECK.OK,
        code: null,
        detail: scope,
      })
    } else {
      checks.push({
        aspect: 'limited-scopes',
        status: PERMISSION_CHECK.BLOCKED,
        code: PermissionCode.OUTSIDE_LIMITED_SCOPE,
        detail: `请求范围不在用户限定范围内：${scope}`,
      })
    }
  }

  const blocked = checks.find((check) => check.status === PERMISSION_CHECK.BLOCKED)
  const partial = checks.find((check) => check.status === PERMISSION_CHECK.PARTIAL)
  const warnings = checks
    .filter((check) => check.status === PERMISSION_CHECK.WARNING)
    .map((check) => ({ code: check.code, message: check.detail }))
  const matchedCheck = checks.find(
    (check) => check.aspect === 'exclusions' && check.status === PERMISSION_CHECK.BLOCKED,
  )
  const fallbackCode =
    use === null ? PermissionCode.DEFAULT_PROJECT_USE : PermissionCode.RECORDED_USE
  const fallbackReason =
    use === null
      ? '未声明限制：可按项目目标使用，并需在简报、方案或结果中说明'
      : '按用户记录的用途使用，并需按记录说明'

  return {
    materialId,
    materialKind: material.kind,
    rightsStatus: material.rightsStatus,
    observation,
    useId: use === null ? null : use.useId,
    source: use === null ? 'default' : 'recorded-use',
    // "May proceed now" — undecidable is NOT allowed.
    allowed: blocked === undefined && partial === undefined,
    partial: partial !== undefined,
    code: blocked?.code ?? partial?.code ?? fallbackCode,
    reason: blocked?.detail ?? partial?.detail ?? fallbackReason,
    mustDiscloseIn: [...DEFAULT_USE_PERMISSION.mustDiscloseIn],
    requiresAuthorizationFor: [...DEFAULT_USE_PERMISSION.requiresAuthorizationFor],
    allowedUses,
    exclusions,
    limitedScopes,
    matchedExclusion: matchedCheck?.exclusion ?? null,
    warnings,
    checks,
  }
}

/**
 * A narrow convenience wrapper over {@link describeEffectivePermission}.
 * @param {{ materials: object[], uses: object[] }} catalog
 * @param {object} query
 * @returns {{ allowed: boolean, partial: boolean, code: string, reason: string, permission: object }}
 */
export function isAllowedForUse(catalog, query = {}) {
  const permission = describeEffectivePermission(catalog, query)
  return {
    allowed: permission.allowed,
    partial: permission.partial,
    code: permission.code,
    reason: permission.reason,
    permission,
  }
}

/**
 * Check that each recorded material is still really available, for the "需要处理" path.
 *
 * Three distinct failures are reported with stable codes, because the user fixes them
 * differently: a deleted file, bytes that changed underneath the record, and a path that exists
 * but cannot be read. A successful check never "repairs" the record; it only reports facts.
 *
 * @param {object} options
 * @param {import('./paths.js').ProjectPaths} options.projectPaths
 * @param {{ materials: object[] }} [options.catalog] skip the disk read when already loaded
 * @param {boolean} [options.record] append a MATERIAL_MISSING event for each real problem
 * @param {string} [options.author]
 * @param {Clock} [options.clock]
 * @returns {{
 *   ok: boolean, checked: number, needsAttention: string[],
 *   items: Array<{ materialId: string, available: boolean, code: string | null,
 *     reason: string, expectedSha256: string, actualSha256: string | null,
 *     byteSize: number | null, storedRelativePath: string }>,
 * }}
 */
export function verifyAvailability(options = {}) {
  const paths = assertProjectPaths(options.projectPaths)
  const catalog = options.catalog ?? readMaterialsCatalog(paths)
  const materials = assertRecordList(catalog.materials, 'materials')
  const items = materials.map((material) => checkMaterialAvailability(paths, material))
  const needsAttention = items.filter((item) => !item.available).map((item) => item.code)
  const result = {
    ok: needsAttention.length === 0,
    checked: items.length,
    needsAttention,
    items,
  }

  if (options.record === true && needsAttention.length > 0) {
    const clock = options.clock ?? new Clock()
    const author = assertEnum(options.author ?? Actor.SYSTEM, Actor, 'availability.author')
    const events = items
      .filter((item) => !item.available)
      .map((item) =>
        buildEvent({
          kind: ProjectEventKind.MATERIAL_MISSING,
          projectId: paths.projectId,
          actor: author,
          objectId: item.materialId,
          detail: {
            code: item.code,
            reason: item.reason,
            expectedSha256: item.expectedSha256,
            actualSha256: item.actualSha256,
            storedRelativePath: item.storedRelativePath,
          },
        }),
      )
    appendEvents(paths.dir, events, { clock })
  }
  return result
}

/**
 * The permission a use records. Exported so a later card can render the same defaults instead of
 * writing its own copy.
 * @param {{ allowedUses?: string[], exclusions?: object[], limitedScopes?: string[] }} [state]
 * @returns {{ mayUseForProjectGoals: boolean, scope: string, mustDiscloseIn: string[],
 *   requiresAuthorizationFor: string[], restricted: boolean }}
 */
export function buildUsePermission(state = {}) {
  const allowedUses = state.allowedUses ?? []
  const exclusions = state.exclusions ?? []
  const limitedScopes = state.limitedScopes ?? []
  const restricted = allowedUses.length > 0 || exclusions.length > 0 || limitedScopes.length > 0
  return {
    mayUseForProjectGoals: DEFAULT_USE_PERMISSION.mayUseForProjectGoals,
    scope: restricted ? 'stated-restrictions-only' : 'project-goals',
    mustDiscloseIn: [...DEFAULT_USE_PERMISSION.mustDiscloseIn],
    requiresAuthorizationFor: [...DEFAULT_USE_PERMISSION.requiresAuthorizationFor],
    restricted,
  }
}

/**
 * Shared implementation of {@link amendUse} and {@link excludeFromUse}.
 * @param {object} options
 * @param {'amend' | 'exclude'} mode
 * @returns {{ previous: object, current: object, amendment: object, revision: string, events: object[] }}
 */
function applyUseChange(options, mode) {
  const paths = assertProjectPaths(options.projectPaths)
  const clock = options.clock ?? new Clock()
  const useId = assertUseId(options.useId)
  const projectVersion = assertProjectVersion(options.projectVersion)
  const author = assertEnum(options.author ?? Actor.USER, Actor, 'use.author')
  const note = optionalText(options.note, 'note', MAX_NOTE_LENGTH)

  const catalog = readMaterialsCatalog(paths, { clock })
  const index = catalog.uses.findIndex((use) => use.useId === useId)
  if (index < 0) throw new NotFoundError('未找到该用途记录', { useId })
  const use = catalog.uses[index]
  if (options.materialId !== undefined && options.materialId !== use.materialId) {
    throw new ValidationError('该用途记录不属于指定材料', {
      field: 'materialId',
      useId,
    })
  }
  guardBaseRevision(options.baseRevision, catalog.revision, paths.projectId)

  const changes = {}
  if (options.allowedUses !== undefined) {
    changes.allowedUses = normalizeStringList(options.allowedUses, 'allowedUses')
  }
  if (options.exclusions !== undefined) {
    const provided = normalizeExclusions(options.exclusions)
    changes.exclusions = mode === 'exclude' ? mergeExclusions(use.exclusions ?? [], provided) : provided
  }
  if (options.limitedScopes !== undefined) {
    changes.limitedScopes = normalizeStringList(options.limitedScopes, 'limitedScopes')
  }
  if (options.userText !== undefined) changes.userText = assertVerbatimText(options.userText, 'userText')
  if (Object.keys(changes).length === 0) {
    throw new ValidationError('用途变更没有任何修改内容', { field: 'changes', useId })
  }

  const existingExclusions = Array.isArray(use.exclusions) ? use.exclusions : []
  const nextState = {
    allowedUses: changes.allowedUses ?? [...(use.allowedUses ?? [])],
    exclusions: changes.exclusions ?? structuredClone(existingExclusions),
    limitedScopes: changes.limitedScopes ?? [...(use.limitedScopes ?? [])],
  }
  const addedExclusions = nextState.exclusions.filter(
    (candidate) =>
      !existingExclusions.some((known) => exclusionKey(known) === exclusionKey(candidate)),
  )
  if (mode === 'exclude' && addedExclusions.length === 0) {
    throw new ValidationError('排除操作需要新增至少一个尚未排除的范围', { field: 'exclusions', useId })
  }

  const previous = {
    allowedUses: [...(use.allowedUses ?? [])],
    exclusions: structuredClone(existingExclusions),
    limitedScopes: [...(use.limitedScopes ?? [])],
    permission: structuredClone(use.permission ?? buildUsePermission()),
    userText: String(use.userText ?? ''),
  }
  const amendments = Array.isArray(use.amendments) ? use.amendments : []
  const amendment = {
    // Deterministic per use and sequence, so a retried append cannot invent a second identity.
    amendmentId: derivedId('amd', `${useId}:${amendments.length + 1}`),
    at: clock.iso(),
    projectVersion,
    author,
    changes: structuredClone(changes),
    previous: structuredClone(previous),
    ...(note === undefined ? {} : { note }),
  }
  const updated = {
    ...use,
    ...nextState,
    permission: buildUsePermission(nextState),
    amendedAt: amendment.at,
    amendments: [...amendments, amendment],
  }

  const uses = catalog.uses.map((item, itemIndex) => (itemIndex === index ? updated : item))
  const written = writeMaterialsCatalog(paths, { ...catalog, uses }, { expectedRevision: catalog.revision, clock })

  const events = [
    buildEvent({
      kind: ProjectEventKind.MATERIAL_USE_AMENDED,
      projectId: paths.projectId,
      actor: author,
      objectId: useId,
      detail: {
        materialId: use.materialId,
        projectVersion,
        changes: structuredClone(changes),
        previous: structuredClone(previous),
        current: {
          allowedUses: [...nextState.allowedUses],
          exclusions: structuredClone(nextState.exclusions),
          limitedScopes: [...nextState.limitedScopes],
          permission: structuredClone(updated.permission),
        },
        ...(note === undefined ? {} : { note }),
      },
    }),
  ]
  if (addedExclusions.length > 0) {
    events.push(
      buildEvent({
        kind: ProjectEventKind.MATERIAL_EXCLUDED,
        projectId: paths.projectId,
        actor: author,
        objectId: use.materialId,
        detail: {
          useId,
          projectVersion,
          exclusions: structuredClone(addedExclusions),
        },
      }),
    )
  }
  appendEvents(paths.dir, events, { clock })

  return {
    previous,
    current: structuredClone(updated),
    amendment: structuredClone(amendment),
    revision: written.revision,
    events: structuredClone(events),
  }
}

/**
 * Check one material against the bytes on disk.
 * @param {import('./paths.js').ProjectPaths} paths
 * @param {object} material
 * @returns {object}
 */
function checkMaterialAvailability(paths, material) {
  const materialId = String(material.materialId)
  const storedRelativePath = typeof material.storedRelativePath === 'string' ? material.storedRelativePath : ''
  const expectedSha256 = String(material.contentSha256 ?? '')
  const base = {
    materialId,
    expectedSha256,
    actualSha256: null,
    byteSize: null,
    storedRelativePath,
  }

  if (storedRelativePath.length === 0) {
    return {
      ...base,
      available: false,
      code: NeedsAttentionCode.MATERIAL_MISSING,
      reason: '材料记录没有可用的存储路径，需要重新登记',
    }
  }

  let absolutePath
  try {
    absolutePath = paths.resolve(storedRelativePath)
  } catch {
    // A stored path that resolves outside the project is a security problem, not a missing file.
    return {
      ...base,
      available: false,
      code: NeedsAttentionCode.MATERIAL_UNREADABLE,
      reason: '材料存储路径不合法，拒绝按该路径读取',
    }
  }

  if (!pathExists(absolutePath)) {
    return {
      ...base,
      available: false,
      code: NeedsAttentionCode.MATERIAL_MISSING,
      reason: '材料文件已不存在，需要重新放入或重新登记',
    }
  }
  if (!isReadableFile(absolutePath)) {
    return {
      ...base,
      available: false,
      code: NeedsAttentionCode.MATERIAL_UNREADABLE,
      reason: '材料文件存在但无法读取，需要检查权限或文件占用',
    }
  }

  const actualSha256 = fileSha256(absolutePath)
  const byteSize = fileSize(absolutePath)
  if (expectedSha256.length > 0 && actualSha256 !== expectedSha256) {
    return {
      ...base,
      available: false,
      code: NeedsAttentionCode.MATERIAL_HASH_MISMATCH,
      reason: '材料文件内容已被改动，与登记时记录的哈希不一致',
      actualSha256,
      byteSize,
    }
  }
  return {
    ...base,
    available: true,
    code: null,
    reason: '材料文件存在且内容哈希一致',
    actualSha256,
    byteSize,
  }
}

/**
 * Resolve the bytes and the original filename for {@link addMaterial}.
 * @param {object} options
 * @returns {{ bytes: Buffer, originalFilename: string }}
 */
function resolveMaterialBytes(options) {
  const hasBytes = options.bytes !== undefined
  const hasFile = typeof options.sourceFile === 'string' && options.sourceFile.length > 0
  if (hasBytes === hasFile) {
    throw new ValidationError('材料内容必须且只能提供 bytes 或 sourceFile 之一', {
      field: hasBytes ? 'sourceFile' : 'bytes',
    })
  }

  if (hasBytes) {
    let bytes
    if (Buffer.isBuffer(options.bytes)) bytes = Buffer.from(options.bytes)
    else if (options.bytes instanceof Uint8Array) bytes = Buffer.from(options.bytes)
    else if (typeof options.bytes === 'string') bytes = Buffer.from(options.bytes, 'utf8')
    else {
      throw new ValidationError('材料内容类型只支持 Buffer、Uint8Array 或字符串', {
        field: 'bytes',
      })
    }
    assertMaterialSize(bytes.length)
    const originalFilename = assertBareFilename(options.originalFilename)
    return { bytes, originalFilename }
  }

  if (!path.isAbsolute(options.sourceFile)) {
    throw new ValidationError('sourceFile 必须是绝对路径', { field: 'sourceFile' })
  }
  const size = fileSize(options.sourceFile)
  if (size < 0) {
    throw new IoError('材料来源文件无法读取', {
      details: { stage: 'material-source', reason: 'unreadable' },
    })
  }
  assertMaterialSize(size)
  const bytes = fs.readFileSync(options.sourceFile)
  const originalFilename = assertBareFilename(
    options.originalFilename ?? path.basename(options.sourceFile),
  )
  return { bytes, originalFilename }
}

/**
 * Refuse an oversized in-memory material instead of pretending the streaming path exists.
 * @param {number} size
 */
function assertMaterialSize(size) {
  if (!Number.isInteger(size) || size < 0) {
    throw new ValidationError('材料大小非法', { field: 'bytes' })
  }
  if (size > MAX_IN_MEMORY_MATERIAL_BYTES) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '单个材料超过当前内存写入上限', {
      details: {
        limit: MAX_IN_MEMORY_MATERIAL_BYTES,
        actual: size,
        action: '大文件需要受控二进制流写入（尚未接入），不得整文件读入内存后声称成功',
      },
    })
  }
}

/**
 * A material filename is DISPLAY metadata only; it may not smuggle path syntax.
 * @param {unknown} value
 * @returns {string}
 */
function assertBareFilename(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError('原始文件名不能为空', { field: 'originalFilename' })
  }
  if (value.length > 255) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '原始文件名过长', {
      details: { field: 'originalFilename', limit: 255 },
    })
  }
  if (/[\\/\u0000-\u001f]/.test(value)) {
    throw new ValidationError('原始文件名不能包含路径分隔符或控制字符', {
      field: 'originalFilename',
    })
  }
  if (value === '.' || value === '..') {
    throw new ValidationError('原始文件名不合法', { field: 'originalFilename' })
  }
  return value
}

/**
 * A strictly validated extension, used only to keep the stored bytes openable by external tools.
 * @param {unknown} filename
 * @returns {string}
 */
function safeExtension(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return ''
  const base = path.basename(filename)
  const extension = path.extname(base)
  return /^\.[A-Za-z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : ''
}

/**
 * The user's statement, stored exactly as given: no trim, no normalization, no truncation.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function assertVerbatimText(value, field) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} 必须是用户原文文本`, { field })
  }
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} 不能为空`, { field })
  }
  if (value.length > MAX_USER_TEXT_LENGTH) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, `${field} 过长`, {
      details: { field, limit: MAX_USER_TEXT_LENGTH },
    })
  }
  return value
}

/**
 * An optional short text field.
 * @param {unknown} value
 * @param {string} field
 * @param {number} limit
 * @returns {string | undefined}
 */
function optionalText(value, field, limit) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} 必须是文本`, { field })
  }
  if (value.length > limit) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, `${field} 过长`, { details: { field, limit } })
  }
  return value
}

/**
 * A non-empty text list, preserving the user's order and wording.
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
function normalizeStringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} 必须是文本列表`, { field })
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, `${field} 条目过多`, {
      details: { field, limit: MAX_LIST_ITEMS },
    })
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ValidationError(`${field} 的每一项都必须是非空文本`, {
        field: `${field}[${index}]`,
      })
    }
    if (item.length > MAX_LIST_ITEM_LENGTH) {
      throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, `${field} 的条目过长`, {
        details: { field: `${field}[${index}]`, limit: MAX_LIST_ITEM_LENGTH },
      })
    }
    return item
  })
}

/**
 * Validate and normalize recorded exclusions.
 * @param {unknown} value
 * @returns {object[]}
 */
function normalizeExclusions(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ValidationError('exclusions 必须是排除条目列表', { field: 'exclusions' })
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, 'exclusions 条目过多', {
      details: { field: 'exclusions', limit: MAX_LIST_ITEMS },
    })
  }
  return value.map((item, index) => normalizeExclusionItem(item, index))
}

/**
 * Validate one exclusion entry.
 * @param {unknown} item
 * @param {number} index
 * @returns {object}
 */
function normalizeExclusionItem(item, index) {
  const field = `exclusions[${index}]`
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new ValidationError(`${field} 必须是对象`, { field })
  }
  const kind = assertEnum(item.kind ?? ExclusionKind.SEGMENT, ExclusionKind, `${field}.kind`)
  const label = optionalText(item.label, `${field}.label`, 200)

  if (kind === ExclusionKind.RANGE) {
    const start = Number(item.start)
    const end = Number(item.end)
    if (!Number.isFinite(start) || start < 0) {
      throw new ValidationError(`${field}.start 必须是非负数值`, { field: `${field}.start` })
    }
    if (!Number.isFinite(end) || end <= start) {
      throw new ValidationError(`${field}.end 必须大于 start`, { field: `${field}.end` })
    }
    const unit =
      item.unit === undefined
        ? ExclusionUnit.SECONDS
        : assertEnum(item.unit, ExclusionUnit, `${field}.unit`)
    return { kind, start, end, unit, ...(label === undefined ? {} : { label }) }
  }
  if (kind === ExclusionKind.SEGMENT) {
    if (label === undefined) {
      throw new ValidationError(`${field} 需要说明被排除的片段`, { field: `${field}.label` })
    }
    return { kind, label }
  }
  return { kind: ExclusionKind.ALL, ...(label === undefined ? {} : { label }) }
}

/**
 * Merge new exclusions into the known ones, ignoring exact duplicates.
 * @param {object[]} existing
 * @param {object[]} additions
 * @returns {object[]}
 */
function mergeExclusions(existing, additions) {
  const out = structuredClone(existing)
  for (const addition of additions) {
    const key = exclusionKey(addition)
    if (!out.some((known) => exclusionKey(known) === key)) out.push(structuredClone(addition))
  }
  return out
}

/**
 * A stable identity for one exclusion value, used only for de-duplication.
 * @param {object} exclusion
 * @returns {string}
 */
function exclusionKey(exclusion) {
  return stableStringify(exclusion)
}

/**
 * Normalize the caller's requested segment.
 * @param {unknown} segment
 * @returns {{ start: number, end: number, unit: string } | null}
 */
function normalizeQuerySegment(segment) {
  if (segment === undefined || segment === null) return null
  if (typeof segment !== 'object' || Array.isArray(segment)) {
    throw new ValidationError('查询片段必须是对象', { field: 'query.segment' })
  }
  const start = Number(segment.start)
  const end = Number(segment.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new ValidationError('查询片段需要合法的起止', { field: 'query.segment' })
  }
  const unit =
    segment.unit === undefined
      ? ExclusionUnit.SECONDS
      : assertEnum(segment.unit, ExclusionUnit, 'query.segment.unit')
  return { start, end, unit }
}

/**
 * Find the exclusion that covers the requested range, or report that it cannot be decided.
 *
 * Each exclusion kind is decided by ITS OWN query dimension. A numeric range cannot be compared
 * against a named segment, so a mismatch of dimensions is `indeterminate` (never "no match"):
 * answering "allowed" there is how an excluded segment would get used.
 *
 * @param {object[]} exclusions
 * @param {{ start: number, end: number, unit: string } | null} segment
 * @param {string | undefined} segmentLabel
 * @returns {object | 'indeterminate' | null}
 */
function findMatchingExclusion(exclusions, segment, segmentLabel) {
  let indeterminate = false
  for (const exclusion of exclusions) {
    if (exclusion.kind === ExclusionKind.ALL) return exclusion
    if (exclusion.kind === ExclusionKind.SEGMENT) {
      // A named segment is decidable only when the caller names the segment it wants.
      if (segmentLabel === undefined) {
        indeterminate = true
        continue
      }
      if (exclusion.label === segmentLabel) return exclusion
      // A different name is a real answer: that named segment is not excluded.
      continue
    }
    if (exclusion.kind === ExclusionKind.RANGE) {
      if (segment === null) {
        indeterminate = true
        continue
      }
      const unit = exclusion.unit ?? ExclusionUnit.SECONDS
      if (segment.unit !== unit) {
        indeterminate = true
        continue
      }
      if (segment.start < exclusion.end && exclusion.start < segment.end) return exclusion
      continue
    }
    indeterminate = true
  }
  return indeterminate ? 'indeterminate' : null
}

/**
 * A non-empty string, or undefined.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmptyText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value
}

/**
 * Assert the project version a use statement belongs to. Required, not defaulted: CT-03 §3 makes
 * "项目版本" part of every recorded use, and inventing one would be a false fact.
 * @param {unknown} value
 * @returns {string}
 */
function assertProjectVersion(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError('用途记录必须声明项目版本', { field: 'projectVersion' })
  }
  if (value.length > 200) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '项目版本标识过长', {
      details: { field: 'projectVersion', limit: 200 },
    })
  }
  return value
}

/**
 * Validate a use id. Both `use_` (from `newId('materialUse')`) and `usi_` (from
 * `newUseInstanceId`) are accepted: the frozen `ids.js` regex only knows `use_`, and this module
 * must not edit the frozen spine just to reject the identity helper the spine itself provides.
 * @param {unknown} value
 * @returns {string}
 */
function assertUseId(value) {
  if (typeof value !== 'string' || !/^(?:use|usi)_[0-9A-HJKMNP-TV-Z]{16}$/.test(value)) {
    throw new ValidationError('useId 不是合法的材料用途实例标识', { field: 'useId' })
  }
  return value
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
    throw new ValidationError('材料操作需要一个 ProjectPaths 实例', { field: 'projectPaths' })
  }
  return candidate
}

/**
 * Refuse a change based on a catalog revision that is no longer current.
 * @param {unknown} baseRevision
 * @param {string} actualRevision
 * @param {string} projectId
 */
function guardBaseRevision(baseRevision, actualRevision, projectId) {
  if (baseRevision === undefined || baseRevision === null) return
  if (baseRevision === actualRevision) return
  throw materialsVersionConflict(projectId, /** @type {string} */ (baseRevision), actualRevision)
}

/**
 * The stable conflict a concurrent material writer must see (CT-02 §3).
 * @param {string} projectId
 * @param {string | null} expectedRevision
 * @param {string | null} actualRevision
 * @returns {WorkbenchError}
 */
function materialsVersionConflict(projectId, expectedRevision, actualRevision) {
  return new WorkbenchError(ErrorCode.VERSION_CONFLICT, '材料清单已被其他写入者更新，本次修改未写入', {
    details: {
      projectId,
      stage: 'materials-revision',
      expectedRevision: expectedRevision ?? null,
      actualRevision: actualRevision ?? null,
      action: '重新读取材料清单后基于最新修订重做，不要覆盖他人新结果',
    },
  })
}

/**
 * Remove a material file this call created, and only when its hash proves it is ours.
 * @param {string} absolutePath
 * @param {string} expectedSha256
 */
function removeOwnMaterialFile(absolutePath, expectedSha256) {
  try {
    deleteIfHashMatches(absolutePath, expectedSha256)
  } catch {
    // A leftover unreferenced file is not worth masking the original failure.
  }
}

/**
 * Assert a records array from the catalog document.
 * @param {unknown} value
 * @param {string} field
 * @returns {object[]}
 */
function assertRecordList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw corruptCatalog(`材料清单的 ${field} 不是数组`)
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw corruptCatalog(`材料清单的 ${field} 含非法条目`)
    }
  }
  return value
}

/**
 * A corrupt catalog is reported, never replaced with an empty one (CT-11 §5).
 * @param {string} message
 * @returns {WorkbenchError}
 */
function corruptCatalog(message) {
  return new WorkbenchError(ErrorCode.CORRUPT_DATA, message, {
    details: { stage: 'materials-shape' },
  })
}
