/**
 * Closure: the seven-step sequence from a finalized version to a cleaned-up project.
 *
 * The order is a product rule, not a suggestion: 定稿 → 导出并检查 → 效果处理 → 最终工程检查 →
 * 展示清理范围 → 用户确认 → 清理. This module computes each step from real state, refuses to delete
 * before the scope was confirmed by the user's own words, and deletes ONLY the paths in that scope.
 *
 * Two deliberate limits, stated instead of hidden:
 * - the removed set is computed from work artifacts and rejected/superseded candidate folders; the
 *   candidate RECORDS stay in the C10 versions index because PROJECT-CORE has no controlled
 *   "delete a candidate record" API (a change request is filed). The closure record therefore says
 *   "已删除历史不提供恢复入口" rather than claiming the records were erased;
 * - permanent deletion needs a second, separate user confirmation and is never implied by closure.
 *
 * @module delivery/closure
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  ConflictError,
  NotFoundError,
  ValidationError,
  WorkbenchError,
  ErrorCode,
  sha256,
  writeFileAtomic,
} from '../base/index.js'
import {
  PROJECT_LAYOUT,
  openProject,
  setPhase,
  tryReadDocument,
  writeDocument,
} from '../core/project/index.js'
import { ConfirmAspect, ConfirmScope, ConfirmationState, ProjectPhase, VersionClass } from '../core/project/index.js'
import { planOfVersion, readPlanSnapshot } from '../editing/index.js'
import { screenEntryPath } from '../media/index.js'
import {
  CLOSURE_DOCUMENT,
  CLOSURE_ORDER,
  CleanupKind,
  ClosureStep,
  DELIVERY_LAYOUT,
  DELIVERY_LIMITS,
  DeliveryState,
  EffectState,
  ItemKind,
  ItemState,
  StepStatus,
  assertEnumValue,
  assertOptionalText,
  assertText,
  clip,
  closureIdFor,
  copy,
} from './ids.js'

/** Project-relative folders a cleanup may touch; everything else is protected by construction. */
const CLEANABLE_ROOT_PREFIXES = Object.freeze([
  PROJECT_LAYOUT.workDir,
  DELIVERY_LAYOUT.workDir,
  PROJECT_LAYOUT.candidatesDir,
])

/** Project-relative files/folders that a cleanup must never remove. */
const PROTECTED_PREFIXES = Object.freeze([
  PROJECT_LAYOUT.projectFile,
  PROJECT_LAYOUT.recoveryFile,
  PROJECT_LAYOUT.versionsIndex,
  PROJECT_LAYOUT.decisionsIndex,
  PROJECT_LAYOUT.materialsIndex,
  PROJECT_LAYOUT.materialsFilesDir,
  PROJECT_LAYOUT.plansDir,
  PROJECT_LAYOUT.recipesDir,
  PROJECT_LAYOUT.evidenceDir,
  'editing',
  DELIVERY_LAYOUT.outputsDir,
  DELIVERY_LAYOUT.index,
  DELIVERY_LAYOUT.packagesIndex,
])

/**
 * Recursively measure files under a directory.
 * @param {string} absoluteDir
 * @returns {{ files: number, bytes: number }}
 */
function measure(absoluteDir) {
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) {
        files += 1
        bytes += fs.statSync(absolute).size
      }
    }
  }
  walk(absoluteDir)
  return { files, bytes }
}

/**
 * Compute the cleanup scope of one project from what is actually on disk.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} input.versions C10 version store (to know which candidates ended)
 * @param {any[]} [input.effectReferences] references other projects/effects hold, shown to the user
 * @returns {any} scope
 */
export function planCleanupScope(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('清理范围需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const candidates = typeof input.versions?.listCandidates === 'function' ? input.versions.listCandidates() : []
  /** @type {Array<{ kind: string, path: string, bytes: number, files: number, reason: string }>} */
  const remove = []
  /** @type {Array<{ path: string, reason: string }>} */
  const keep = []

  const addDirectory = (relative, kind, reason) => {
    const absolute = paths.resolve(relative)
    if (!fs.existsSync(absolute)) return
    if (PROTECTED_PREFIXES.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) {
      keep.push({ path: relative, reason: '受保护路径，不进入清理范围' })
      return
    }
    const measured = measure(absolute)
    remove.push({ kind, path: relative, bytes: measured.bytes, files: measured.files, reason })
  }

  addDirectory(PROJECT_LAYOUT.workDir, CleanupKind.REBUILDABLE_CACHE, '可重建的工作缓存与中间文件')
  addDirectory(DELIVERY_LAYOUT.workDir, CleanupKind.EXPORT_WORK, '导出的工作目录（滤镜图与临时编码结果）')
  for (const candidate of candidates) {
    if (!['rejected', 'superseded'].includes(String(candidate?.status ?? ''))) continue
    const relative = `${PROJECT_LAYOUT.candidatesDir}/${candidate.candidateId}`
    addDirectory(relative, CleanupKind.REJECTED_CANDIDATE, `未采用候选（${String(candidate.status)}）的预览与差异文件`)
  }

  const measuredTotal = remove.reduce((sum, entry) => sum + entry.bytes, 0)
  if (remove.length > DELIVERY_LIMITS.maxCleanupEntries) {
    throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '清理条目过多，拒绝生成范围', {
      details: { entries: remove.length, limit: DELIVERY_LIMITS.maxCleanupEntries },
    })
  }
  const keepList = [
    { path: PROJECT_LAYOUT.projectFile, reason: '项目事实文档' },
    { path: PROJECT_LAYOUT.versionsIndex, reason: '当前／候选／定稿三类版本记录' },
    { path: PROJECT_LAYOUT.decisionsIndex, reason: '用户确认与授权记录' },
    { path: PROJECT_LAYOUT.materialsIndex, reason: '材料索引' },
    { path: PROJECT_LAYOUT.materialsFilesDir, reason: '采用素材本体' },
    { path: PROJECT_LAYOUT.plansDir, reason: '简报、方向与计划基线' },
    { path: 'editing/plans', reason: '计划快照（继续编辑必需）' },
    { path: PROJECT_LAYOUT.recipesDir, reason: '制作配方' },
    { path: DELIVERY_LAYOUT.outputsDir, reason: '已导出的交付物' },
    { path: DELIVERY_LAYOUT.dir, reason: '交付、包与结项记录' },
    { path: PROJECT_LAYOUT.evidenceDir, reason: '证据（未证明可重建，保留）' },
    ...keep,
  ]
  const effectRefs = Array.isArray(input.effectReferences) ? input.effectReferences : []
  const payload = {
    remove: remove.map((entry) => `${entry.kind}:${entry.path}`).sort(),
    keep: keepList.map((entry) => entry.path).sort(),
    effectRefs: effectRefs.map((entry) => `${String(entry.effectId)}@${String(entry.version)}`).sort(),
  }
  const digest = sha256(JSON.stringify(payload))
  return {
    scopeId: `sco_${digest.slice(0, 16)}`,
    digest,
    createdAt: (input.clock ?? new Clock()).iso(),
    remove,
    keep: keepList,
    totalBytes: measuredTotal,
    totalFiles: remove.reduce((sum, entry) => sum + entry.files, 0),
    sharedReferences: effectRefs.map((entry) => ({
      effectId: String(entry.effectId),
      version: String(entry.version),
      projectId: String(entry.projectId ?? ''),
      note: '正式效果在项目之外保存，清理本项目不会破坏它',
    })),
    honest: {
      deletesCandidateRecords: false,
      note: '只删除工作缓存与未采用候选的预览/差异文件；候选记录仍留在版本索引里，但清理后不提供恢复入口',
    },
  }
}

/**
 * Compute the seven closure steps from real state.
 *
 * @param {object} input
 * @param {any} input.finalVersion C10 final version or null
 * @param {any} input.plan the final version's plan snapshot result or null
 * @param {{ materials: Array<{ file: string, exists: boolean }>,
 *   fonts: Array<{ family: string }> }} [input.projectFiles]
 * @param {any} input.delivery the newest delivery record or null
 * @param {(item: any) => { ok: boolean, reason: string|null }} [input.verifyItem] re-read a delivered file
 * @param {any[]} [input.effects] effects attributed to this project
 * @param {any[]} [input.effectDecisions] `{ effectId, decision }` recorded for this project
 * @param {any} [input.scope]
 * @param {any} [input.confirmation]
 * @param {any} [input.cleanup]
 * @returns {{ steps: any[], readyToClean: boolean, nextStep: string, blocked: any[], counts: any }}
 */
export function evaluateClosure(input = {}) {
  /** @type {any[]} */
  const steps = []
  const add = (id, status, detail, evidence = null) => steps.push({ id, status, detail, evidence })

  const finalVersion = input.finalVersion ?? null
  const hasFinal = finalVersion !== null && finalVersion.class === VersionClass.FINAL
  add(
    ClosureStep.FINALIZED,
    hasFinal && typeof finalVersion?.confirmationRef === 'string' && finalVersion.confirmationRef.length > 0
      ? StepStatus.PASSED
      : StepStatus.BLOCKED,
    hasFinal
      ? `定稿 ${String(finalVersion.versionId)}（验收引用 ${String(finalVersion.confirmationRef)}）`
      : '还没有用户验收的定稿版本；导出与清理都不能开始',
    hasFinal ? { finalVersionId: finalVersion.versionId, confirmationRef: finalVersion.confirmationRef } : null,
  )

  const delivery = input.delivery ?? null
  const items = Array.isArray(delivery?.items) ? delivery.items : []
  const failedItems = items.filter((item) => item.state === ItemState.FAILED)
  const exportedVideos = items.filter((item) => item.kind === ItemKind.VIDEO && item.state === ItemState.EXPORTED)
  const declaredGaps = items.filter((item) => item.state === ItemState.NOT_IMPLEMENTED)
  let deliveryVerification = null
  if (typeof input.verifyItem === 'function' && delivery !== null) {
    deliveryVerification = exportedVideos.map((item) => ({
      itemId: item.itemId,
      kind: item.kind,
      ...input.verifyItem(item),
    }))
  }
  const unreadable = (deliveryVerification ?? []).filter((entry) => entry.ok !== true)
  const deliveryOk =
    delivery !== null &&
    delivery.state === DeliveryState.COMPLETE &&
    failedItems.length === 0 &&
    exportedVideos.length > 0 &&
    unreadable.length === 0
  add(
    ClosureStep.DELIVERED,
    deliveryOk ? StepStatus.PASSED : StepStatus.BLOCKED,
    deliveryOk
      ? `交付 ${String(delivery.deliveryId)}：${exportedVideos.length} 个成片规格逐条检查通过` +
        (declaredGaps.length > 0 ? `；${declaredGaps.length} 项声明为不可用（不计入交付）` : '')
      : delivery === null
        ? '还没有交付记录'
        : delivery.state !== DeliveryState.COMPLETE
          ? `交付状态为 ${String(delivery.state)}，不是全部完成`
          : failedItems.length > 0
            ? `有 ${failedItems.length} 项导出或检查失败`
            : unreadable.length > 0
              ? `有 ${unreadable.length} 个已导出文件现在不可读：${unreadable.map((entry) => entry.reason ?? entry.itemId).join('；')}`
              : '没有成功导出的成片规格',
    delivery === null
      ? null
      : { deliveryId: delivery.deliveryId, state: delivery.state, verification: deliveryVerification },
  )

  const decisions = Array.isArray(input.effectDecisions) ? input.effectDecisions : []
  const effects = Array.isArray(input.effects) ? input.effects : []
  const decidedIds = new Set(decisions.map((entry) => String(entry.effectId)))
  const pending = effects.filter(
    (effect) =>
      [EffectState.CANDIDATE, EffectState.REPRODUCE_FAILED].includes(effect.state) && !decidedIds.has(effect.effectId),
  )
  add(
    ClosureStep.EFFECTS_DECIDED,
    pending.length === 0 ? StepStatus.PASSED : StepStatus.WAITING_USER,
    pending.length === 0
      ? `本项目的效果选择已完成（记录 ${decisions.length} 条决定，正式收录 ${effects.filter((effect) => effect.state === EffectState.ADOPTED).length} 个）`
      : `还有 ${pending.length} 个效果候选需要你选择：${pending.map((effect) => clip(effect.name, 40)).join('、')}`,
    { pendingEffectIds: pending.map((effect) => effect.effectId), decisions },
  )

  const plan = input.plan ?? null
  const materials = Array.isArray(input.projectFiles?.materials) ? input.projectFiles.materials : []
  const missingMaterials = materials.filter((entry) => entry.exists !== true)
  const finalProjectOk = plan !== null && missingMaterials.length === 0 && hasFinal
  add(
    ClosureStep.FINAL_PROJECT,
    finalProjectOk ? StepStatus.PASSED : StepStatus.BLOCKED,
    finalProjectOk
      ? `最终可编辑工程可读：计划 ${String(plan.planVersion)}、必要素材 ${materials.length} 个齐全`
      : plan === null
        ? '定稿版本的计划快照缺失或不可读'
        : missingMaterials.length > 0
          ? `有 ${missingMaterials.length} 个必要素材文件缺失：${missingMaterials.map((entry) => entry.file).join('、')}`
          : '最终工程检查未通过',
    { materials, fonts: input.projectFiles?.fonts ?? [] },
  )

  const scope = input.scope ?? null
  add(
    ClosureStep.SCOPE_SHOWN,
    scope === null ? StepStatus.PENDING : StepStatus.PASSED,
    scope === null
      ? '还没有生成清理范围'
      : `待清理 ${scope.remove.length} 项、约 ${String(scope.totalBytes)} 字节；保留 ${scope.keep.length} 类`,
    scope === null ? null : { scopeId: scope.scopeId, digest: scope.digest },
  )

  const confirmation = input.confirmation ?? null
  const confirmedMatches = confirmation !== null && scope !== null && confirmation.scopeDigest === scope.digest
  add(
    ClosureStep.SCOPE_CONFIRMED,
    confirmedMatches ? StepStatus.PASSED : StepStatus.WAITING_USER,
    confirmedMatches
      ? `用户已确认该范围（${String(confirmation.humanResponse ?? '').slice(0, 60)}）`
      : confirmation === null
        ? '需要用户明确确认这个清理范围；没有回复就不删除任何历史'
        : '确认绑定的是另一个范围（范围已变化），需要重新确认',
    confirmation === null ? null : { confirmationId: confirmation.confirmationId },
  )

  add(
    ClosureStep.CLEANED,
    input.cleanup === null || input.cleanup === undefined ? StepStatus.PENDING : StepStatus.PASSED,
    input.cleanup === null || input.cleanup === undefined
      ? '尚未执行清理'
      : `已删除 ${String(input.cleanup.deleted?.length ?? 0)} 项，释放 ${String(input.cleanup.bytesFreed ?? 0)} 字节`,
    input.cleanup ?? null,
  )

  const firstFive = steps.slice(0, 4)
  const readyToClean = firstFive.every((step) => step.status === StepStatus.PASSED)
  const blockedSteps = steps.filter((step) => step.status === StepStatus.BLOCKED)
  const nextStep = CLOSURE_ORDER.find(
    (id) => steps.find((step) => step.id === id)?.status !== StepStatus.PASSED,
  ) ?? null
  return {
    steps,
    readyToClean,
    nextStep,
    blocked: blockedSteps.map((step) => ({ id: step.id, detail: step.detail })),
    counts: {
      exportedVideos: exportedVideos.length,
      declaredGaps: declaredGaps.length,
      pendingEffects: pending.length,
      removable: scope === null ? 0 : scope.remove.length,
    },
  }
}

/**
 * The closure store of one project: one active closure record plus its history.
 *
 * @param {{ paths: any, clock?: any }} input
 * @returns {any}
 */
export function createClosureStore(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('结项记录需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()

  /** @returns {{ doc: any, revision: string|null }} */
  function read() {
    const stored = tryReadDocument(paths.resolve(DELIVERY_LAYOUT.closureIndex), { kind: CLOSURE_DOCUMENT.kind })
    if (stored === null) {
      return {
        doc: { kind: CLOSURE_DOCUMENT.kind, projectId: paths.projectId, activeClosureId: null, closures: [] },
        revision: null,
      }
    }
    const value = stored.value
    if (value.kind !== CLOSURE_DOCUMENT.kind) {
      throw new WorkbenchError(ErrorCode.CORRUPT_DATA, '结项记录 kind 不符', { details: { kind: String(value.kind) } })
    }
    return {
      doc: {
        ...value,
        closures: Array.isArray(value.closures) ? value.closures : [],
      },
      revision: stored.revision,
    }
  }

  /** @param {any} doc @param {string|null} revision */
  function save(doc, revision) {
    paths.ensureDir(DELIVERY_LAYOUT.dir)
    writeDocument(paths.resolve(DELIVERY_LAYOUT.closureIndex), doc, {
      kind: CLOSURE_DOCUMENT.kind,
      schemaKey: CLOSURE_DOCUMENT.schemaKey,
      expectedRevision: revision,
      clock,
    })
  }

  /** @param {any} doc */
  function activeClosure(doc) {
    const found = doc.closures.find((entry) => entry.closureId === doc.activeClosureId)
    return found === undefined ? null : found
  }

  /**
   * Start (or return) the active closure for one final version.
   * @param {{ finalVersionId: string, deliveryId?: string|null }} request
   */
  function openClosure(request = {}) {
    const { doc, revision } = read()
    const finalVersionId = assertText(request.finalVersionId, 'finalVersionId', 120)
    const existing = activeClosure(doc)
    if (existing !== null && existing.finalVersionId === finalVersionId) return copy(existing)
    const startedAt = clock.iso()
    const closure = {
      closureId: closureIdFor({ projectId: paths.projectId, startedAt }),
      projectId: paths.projectId,
      startedAt,
      updatedAt: startedAt,
      finalVersionId,
      deliveryId: typeof request.deliveryId === 'string' ? request.deliveryId : null,
      scope: null,
      readyToClean: false,
      confirmation: null,
      cleanup: null,
      effectDecisions: [],
      archive: null,
    }
    doc.closures.push(closure)
    doc.activeClosureId = closure.closureId
    save(doc, revision)
    return copy(closure)
  }

  /**
   * Store the computed cleanup scope on the active closure.
   *
   * Refuses when the first four steps did not pass: a scope computed while an export failed or while
   * the final project is missing a material must not become "the range to delete".
   *
   * @param {any} scope
   * @param {{ readyToClean: boolean }} [options]
   */
  function setScope(scope, options = {}) {
    const { doc, revision } = read()
    const closure = activeClosure(doc)
    if (closure === null) throw new ConflictError('还没有打开的结项流程', { action: '先 openClosure' })
    if (options?.readyToClean !== true) {
      throw new ConflictError('结项前四步尚未全部通过，不能生成可执行的清理范围', {
        action: '先完成定稿、导出检查、效果处理与最终工程检查',
      })
    }
    closure.scope = copy(scope)
    closure.readyToClean = true
    // A new scope invalidates an earlier confirmation: confirming a range that then changed is not a confirmation.
    closure.confirmation = null
    closure.updatedAt = clock.iso()
    save(doc, revision)
    return copy(closure)
  }

  /**
   * Record the user's answer about the exact scope.
   *
   * The confirmation goes through C10's decision log, which refuses any actor other than `user`:
   * this method cannot invent approval, and a caller that passes an AI actor is refused upstream.
   *
   * @param {object} request
   * @param {any} request.decisions C10 decision log
   * @param {string} request.humanResponse the user's own words
   * @param {string} [request.evidenceRef]
   */
  function confirmScope(request = {}) {
    const { doc, revision } = read()
    const closure = activeClosure(doc)
    if (closure === null) throw new ConflictError('还没有打开的结项流程', { action: '先 openClosure 并展示范围' })
    if (closure.scope === null) throw new ConflictError('还没有清理范围可以确认', { action: '先生成并展示范围' })
    if (typeof request.decisions?.recordConfirmation !== 'function') {
      throw new ValidationError('确认需要 C10 决策记录（createDecisionLog）', { field: 'decisions' })
    }
    const humanResponse = assertText(request.humanResponse, 'humanResponse', DELIVERY_LIMITS.maxResponseLength)
    const recorded = request.decisions.recordConfirmation({
      actor: 'user',
      objectId: `closure:${closure.closureId}`,
      aspect: ConfirmAspect.CLEANUP,
      scope: ConfirmScope.PART,
      versionId: closure.finalVersionId,
      state: ConfirmationState.CONFIRMED,
      humanResponse,
      evidenceRefs: request.evidenceRef === undefined ? [] : [request.evidenceRef],
    })
    closure.confirmation = {
      confirmationId: recorded.confirmationId,
      humanResponse,
      at: recorded.respondedAt ?? clock.iso(),
      scopeDigest: closure.scope.digest,
      scopeId: closure.scope.scopeId,
    }
    closure.updatedAt = clock.iso()
    save(doc, revision)
    return copy(closure)
  }

  /**
   * Record a project-scoped effect decision (`adopted`, `not-collected`, `later`).
   * @param {{ effectId: string, decision: string, reason?: string }} request
   */
  function recordEffectDecision(request = {}) {
    const effectId = assertText(request.effectId, 'effectId', 120)
    const decision = assertEnumValue(request.decision, { ADOPTED: 'adopted', NOT_COLLECTED: 'not-collected', LATER: 'later' }, 'decision')
    const { doc, revision } = read()
    const closure = activeClosure(doc)
    const target = closure ?? doc.closures.at(-1)
    if (target === undefined || target === null) throw new ConflictError('还没有打开的结项流程', { action: '先 openClosure' })
    const decisions = Array.isArray(target.effectDecisions) ? target.effectDecisions : []
    const existingIndex = decisions.findIndex((entry) => entry.effectId === effectId)
    const entry = {
      effectId,
      decision,
      reason: assertOptionalText(request.reason, 'reason', 400),
      at: clock.iso(),
    }
    if (existingIndex === -1) decisions.push(entry)
    else decisions[existingIndex] = entry
    target.effectDecisions = decisions
    target.updatedAt = clock.iso()
    save(doc, revision)
    return copy(entry)
  }

  /**
   * Execute the confirmed cleanup. Deletes ONLY the listed paths.
   *
   * @param {{ decisions: any, closureId?: string }} request
   * @returns {any}
   */
  function executeCleanup(request = {}) {
    const { doc, revision } = read()
    const closure = activeClosure(doc)
    if (closure === null) throw new ConflictError('还没有打开的结项流程', {})
    if (closure.readyToClean !== true) {
      throw new ConflictError('结项前四步尚未全部通过，不能执行清理', {
        action: '导出失败或最终工程缺件时不得清理任何历史',
      })
    }
    if (closure.scope === null) throw new ConflictError('没有清理范围', { action: '先生成并展示范围' })
    if (closure.confirmation === null) {
      throw new ConflictError('清理范围还没有得到用户明确确认；未回复不删除任何历史', {
        scopeId: closure.scope.scopeId,
      })
    }
    if (closure.confirmation.scopeDigest !== closure.scope.digest) {
      throw new ConflictError('确认绑定的范围与当前范围不一致，需要重新确认', { scopeId: closure.scope.scopeId })
    }
    /** @type {Array<{ path: string, kind: string, bytes: number, ok: boolean, reason: string|null }>} */
    const deleted = []
    let bytesFreed = 0
    for (const entry of closure.scope.remove) {
      const screening = screenEntryPath(entry.path)
      if (screening.ok === false) {
        deleted.push({ path: entry.path, kind: entry.kind, bytes: 0, ok: false, reason: `不安全的路径：${screening.reason}` })
        continue
      }
      if (!CLEANABLE_ROOT_PREFIXES.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`))) {
        deleted.push({ path: entry.path, kind: entry.kind, bytes: 0, ok: false, reason: '不在允许清理的目录内' })
        continue
      }
      if (PROTECTED_PREFIXES.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`))) {
        deleted.push({ path: entry.path, kind: entry.kind, bytes: 0, ok: false, reason: '受保护路径，拒绝删除' })
        continue
      }
      const absolute = paths.resolve(entry.path)
      if (!absolute.startsWith(`${paths.dir}${path.sep}`)) {
        deleted.push({ path: entry.path, kind: entry.kind, bytes: 0, ok: false, reason: '解析后位于项目目录之外' })
        continue
      }
      if (!fs.existsSync(absolute)) {
        deleted.push({ path: entry.path, kind: entry.kind, bytes: 0, ok: false, reason: '路径已不存在（可能已被移走）' })
        continue
      }
      const measured = measure(absolute)
      try {
        fs.rmSync(absolute, { recursive: true, force: false })
        bytesFreed += measured.bytes
        deleted.push({ path: entry.path, kind: entry.kind, bytes: measured.bytes, ok: true, reason: null })
      } catch (error) {
        deleted.push({
          path: entry.path,
          kind: entry.kind,
          bytes: measured.bytes,
          ok: false,
          reason: `删除失败：${String(error?.code ?? error?.message ?? error)}`,
        })
      }
    }
    closure.cleanup = {
      at: clock.iso(),
      deleted,
      bytesFreed,
      failures: deleted.filter((entry) => entry.ok === false),
      noRecoveryEntry: true,
      note: '已删除历史不提供恢复入口；本模块不承诺找回',
    }
    closure.updatedAt = clock.iso()
    save(doc, revision)
    return copy(closure.cleanup)
  }

  return {
    clock,
    /** @returns {any|null} */
    active() {
      const { doc } = read()
      const found = activeClosure(doc)
      return found === null ? null : copy(found)
    },
    /** All closure records, oldest first. */
    list() {
      return read().doc.closures.map((entry) => copy(entry))
    },
    open: openClosure,
    setScope,
    confirmScope,
    recordEffectDecision,
    executeCleanup,
    /**
     * Move the project to archived or recycle-bin, through C10's phase transition table.
     * @param {{ projectsRoot: string, to: string, expectedRevision: string }} request
     */
    changePhase(request = {}) {
      const to = assertEnumValue(
        request.to,
        { ARCHIVED: ProjectPhase.ARCHIVED, RECYCLE_BIN: ProjectPhase.RECYCLE_BIN },
        'to',
      )
      return setPhase({
        projectsRoot: request.projectsRoot,
        projectId: paths.projectId,
        to,
        expectedRevision: request.expectedRevision,
        clock,
      })
    },
    /**
     * Restore a project out of the recycle bin.
     * @param {{ projectsRoot: string, expectedRevision: string }} request
     */
    restore(request = {}) {
      return setPhase({
        projectsRoot: request.projectsRoot,
        projectId: paths.projectId,
        to: ProjectPhase.ARCHIVED,
        expectedRevision: request.expectedRevision,
        clock,
      })
    },
  }
}

/**
 * Permanently delete a project that is ALREADY in the recycle bin, after a second user confirmation.
 *
 * Refused while any effect reference points at this project, because "删除不破坏共享引用" applies
 * to the effect library as much as to another project. The tombstone is written OUTSIDE the projects
 * root (caller-supplied folder) so deleting the project does not also delete the record of it.
 *
 * @param {object} request
 * @param {string} request.projectsRoot
 * @param {string} request.projectId
 * @param {any} request.decisions C10 decision log of that project
 * @param {string} request.confirmationId the SECOND confirmation the user gave
 * @param {string} [request.tombstoneDir] absolute folder for the deletion record
 * @param {any[]} [request.effectReferences] references that must be empty
 * @returns {any}
 */
export function permanentlyDeleteProject(request = {}) {
  if (typeof request.projectsRoot !== 'string' || !path.isAbsolute(request.projectsRoot)) {
    throw new ValidationError('永久删除需要项目的绝对根目录', { field: 'projectsRoot' })
  }
  const opened = openProject({ projectsRoot: request.projectsRoot, projectId: request.projectId })
  if (opened.project.phase !== ProjectPhase.RECYCLE_BIN) {
    throw new ConflictError('只有回收区里的项目才能永久删除；请先移入回收区', {
      projectId: opened.project.projectId,
      phase: opened.project.phase,
    })
  }
  if (typeof request.decisions?.listConfirmations !== 'function') {
    throw new ValidationError('永久删除需要读取用户第二次确认', { field: 'decisions' })
  }
  const wanted = assertText(request.confirmationId, 'confirmationId', 120)
  const confirmation = request.decisions.listConfirmations({}).find((entry) => entry.confirmationId === wanted)
  if (confirmation === null || confirmation === undefined) {
    throw new NotFoundError('找不到这次永久删除的确认记录', { confirmationId: request.confirmationId })
  }
  if (confirmation.objectId !== `project:${opened.project.projectId}:deletion`) {
    throw new ValidationError('确认绑定的对象不是这次永久删除', { objectId: String(confirmation.objectId) })
  }
  if (confirmation.aspect !== ConfirmAspect.CLEANUP || confirmation.scope !== ConfirmScope.WHOLE) {
    throw new ValidationError('永久删除的确认必须绑定 cleanup／whole', {
      aspect: String(confirmation.aspect),
      scope: String(confirmation.scope),
    })
  }
  const references = Array.isArray(request.effectReferences) ? request.effectReferences : []
  if (references.length > 0) {
    throw new ConflictError('该项目仍被正式效果引用；删除会破坏其他项目的共享内容', {
      references,
      action: '先在效果库处理引用，再永久删除',
    })
  }
  const dir = path.resolve(opened.paths.dir)
  if (dir !== path.resolve(request.projectsRoot, opened.project.projectId)) {
    throw new ConflictError('项目目录与项目标识不一致，拒绝删除', { dir })
  }
  const measured = measure(dir)
  fs.rmSync(dir, { recursive: true, force: false })
  const deletedAt = new Clock().iso()
  const tombstoneDir = assertOptionalText(request.tombstoneDir, 'tombstoneDir', 400)
  let tombstone = null
  if (tombstoneDir !== null && path.isAbsolute(tombstoneDir)) {
    fs.mkdirSync(tombstoneDir, { recursive: true })
    tombstone = path.join(tombstoneDir, `${opened.project.projectId}-deleted.json`)
    writeFileAtomic(
      tombstone,
      `${JSON.stringify(
        {
          kind: 'project-deletion-record',
          projectId: opened.project.projectId,
          title: opened.project.title,
          deletedAt,
          confirmationId: confirmation.confirmationId,
          humanResponse: clip(confirmation.humanResponse, 200),
          files: measured.files,
          bytes: measured.bytes,
          note: '永久删除由用户第二次确认后执行；项目目录已删除，记录保留在项目根目录之外',
        },
        null,
        2,
      )}\n`,
    )
  }
  return {
    deleted: true,
    projectId: opened.project.projectId,
    title: opened.project.title,
    files: measured.files,
    bytes: measured.bytes,
    deletedAt,
    tombstone,
  }
}
