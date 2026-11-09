/**
 * Deterministic UnitProfile and the early-production-unit gate.
 *
 * The profile is data, not advice: two base unit types, three operations and a closed set of
 * conditions decide exactly which slots and which evidence a unit must have. A model may fill a
 * slot; it may not delete one, lower the bar or declare a partially produced unit sufficient
 * (C13 card §4.3, CT-07 §2–§3).
 *
 * "Not yet" is a first-class outcome. A missing file, a hash that does not match, an unexecuted
 * check or a placeholder all yield `ok: false` with the reason named, so the surface can say
 * "unit incomplete" instead of showing a screenshot of an empty frame as progress.
 *
 * @module orchestration/units
 */

import fs from 'node:fs'

import { Clock, ConflictError, ValidationError, sha256File } from '../base/index.js'
import {
  ORCH_DOCUMENT,
  OrchestrationDocument,
  appendJournal,
  copy,
  optionalText,
  orchestrationId,
  requireOneOf,
  requireText,
  requireTextList,
} from './ids.js'

/** Version of the profile rules. Stored on every unit; a mismatch is an incomplete unit. */
export const UNIT_PROFILE_VERSION = '1.0.0'

/** The two — and only two — base unit types (CT-07 §3). */
export const UnitBase = Object.freeze({
  STATIC_DETAIL: 'StaticDetailUnit',
  TEMPORAL_MOTION: 'TemporalMotionUnit',
})

/** The three operations a unit can be produced by. */
export const UnitOperation = Object.freeze({
  CREATE: 'CreateOperation',
  REPAIR: 'RepairOperation',
  ADAPT: 'AdaptOperation',
})

/** Conditions that add mandatory evidence when they are true. */
export const UnitCondition = Object.freeze({
  SOUND: 'has-sound',
  SUBTITLE: 'has-subtitle',
  REFERENCE: 'reference-consistency',
  COMPARE: 'comparison',
  HIGH_RISK: 'high-risk',
  TEXT_LAYOUT: 'text-layout',
})

/** The five parts every unit must have, in the order a human reads them. */
export const UNIT_PARTS = Object.freeze([
  'unitManifest',
  'unitOutput',
  'productionRecipe',
  'humanResultPack',
  'continuationContract',
])

/** Evidence every static unit must carry. */
const STATIC_EVIDENCE = Object.freeze(['full-frame', 'detail-region', 'original-ratio'])

/** Evidence every temporal unit must carry: continuous playback, not a lucky frame. */
const TEMPORAL_EVIDENCE = Object.freeze(['full-playback', 'start-frame', 'mid-frame', 'end-frame', 'adjacent-context'])

/** Evidence each operation adds. */
const OPERATION_EVIDENCE = Object.freeze({
  [UnitOperation.CREATE]: [],
  [UnitOperation.REPAIR]: Object.freeze(['before-after', 'target-scope', 'preserved-scope', 'unselected-scope']),
  [UnitOperation.ADAPT]: Object.freeze(['adapted-composition', 'source-offset-check']),
})

/** Evidence each condition adds. */
const CONDITION_EVIDENCE = Object.freeze({
  [UnitCondition.SOUND]: Object.freeze(['complete-audio-track', 'continuous-audio-video']),
  [UnitCondition.SUBTITLE]: Object.freeze(['target-aspect-render', 'text-region-detail']),
  [UnitCondition.TEXT_LAYOUT]: Object.freeze(['target-aspect-render', 'text-region-detail']),
  [UnitCondition.REFERENCE]: Object.freeze(['reference-view', 'registered-features']),
  [UnitCondition.COMPARE]: Object.freeze(['same-content-same-scope', 'same-delivery-conditions']),
  [UnitCondition.HIGH_RISK]: Object.freeze(['pre-registered-risk-item']),
})

/**
 * Evidence kinds that only count when a real input was actually observed.
 *
 * `full-playback` is in this list on purpose: a file that decodes is not a film somebody watched,
 * and the difference has to survive into the unit record (CT-07 §6).
 */
const OBSERVATION_EVIDENCE = Object.freeze([
  'full-frame',
  'detail-region',
  'mid-frame',
  'adjacent-context',
  'reference-view',
  'full-playback',
  'start-frame',
  'end-frame',
  'text-region-detail',
  'target-aspect-render',
])

/** What a unit profile gate can and cannot claim. */
export const UNIT_CAPABILITIES = Object.freeze({
  profile: {
    supported: ['两种基础单元 × 三种操作 × 六类条件确定性推导必需要项', '模型无法删项或临场降低要求'],
    limits: ['配置完整不等于画面好看', '条件由调用方如实声明，谎报条件会掩盖缺失证据'],
  },
  validation: {
    supported: ['五件套递归检查', '文件存在性与 SHA-256 复核', '占位、未执行检查、版本不一致一律未完成'],
    limits: ['只证明结构、文件与已执行检查，不证明审美或观众体验', '真实 AI 观察与否单独记录，不冒充已看'],
  },
  storage: {
    supported: ['单元清单与门禁结果保存在项目内', '同一单元重复登记返回同一身份'],
    limits: ['不删除既有单元的历史', '不代替配方与项目版本'],
  },
})

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values)]
}

/**
 * Resolve the deterministic profile for one unit.
 *
 * @param {object} input
 * @param {string} input.base one of {@link UnitBase}
 * @param {string} input.operation one of {@link UnitOperation}
 * @param {string[]} [input.conditions] subset of {@link UnitCondition}
 * @returns {any} frozen profile
 */
export function resolveUnitProfile(input = {}) {
  const base = requireOneOf(input.base, UnitBase, 'base')
  const operation = requireOneOf(input.operation, UnitOperation, 'operation')
  const conditions = requireTextList(input.conditions, 'conditions', 8)
  for (const condition of conditions) requireOneOf(condition, UnitCondition, 'conditions[]')
  const triggers = []
  const evidence = [
    ...(base === UnitBase.TEMPORAL_MOTION ? TEMPORAL_EVIDENCE : STATIC_EVIDENCE),
    ...OPERATION_EVIDENCE[operation],
  ]
  for (const condition of conditions) {
    const added = CONDITION_EVIDENCE[condition]
    if (added === undefined) continue
    evidence.push(...added)
    triggers.push({ condition, addedEvidence: [...added] })
  }
  return Object.freeze({
    profileVersion: UNIT_PROFILE_VERSION,
    profileId: orchestrationId('unit', `profile:${base}:${operation}:${[...conditions].sort().join('|')}`),
    base,
    operation,
    conditions: Object.freeze([...conditions]),
    requiredParts: UNIT_PARTS,
    requiredEvidence: Object.freeze(unique(evidence)),
    observationRequiredEvidence: Object.freeze(unique(evidence).filter((kind) => OBSERVATION_EVIDENCE.includes(kind))),
    triggers: Object.freeze(triggers),
    // The rule that a model cannot edit, stated as data so a test can assert it.
    modelEditable: Object.freeze(['slot content', 'evidence files', 'checks results']),
    modelForbidden: Object.freeze(['remove a required part', 'remove required evidence', 'declare a unit complete']),
  })
}

/**
 * The full matrix, for a receipt or a surface that must show what the gate actually demands.
 * @returns {any[]}
 */
export function describeUnitProfileMatrix() {
  const rows = []
  for (const base of Object.values(UnitBase)) {
    for (const operation of Object.values(UnitOperation)) {
      rows.push({
        base,
        operation,
        minimumEvidence: resolveUnitProfile({ base, operation }).requiredEvidence,
        conditionEvidence: Object.fromEntries(
          Object.values(UnitCondition).map((condition) => [
            condition,
            resolveUnitProfile({ base, operation, conditions: [condition] }).requiredEvidence.filter(
              (kind) => !resolveUnitProfile({ base, operation }).requiredEvidence.includes(kind),
            ),
          ]),
        ),
      })
    }
  }
  return rows
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate one unit against its profile, recursively, without trusting any declaration inside it.
 *
 * @param {object} input
 * @param {any} input.unit the complete unit record
 * @param {any} input.profile result of {@link resolveUnitProfile}
 * @param {any} [input.paths] C10 `ProjectPaths`, needed to prove output files exist and match
 * @param {boolean} [input.checkHashes] default true when `paths` is given
 * @returns {{ ok: boolean, missing: any[], unobserved: string[], checkedParts: string[], profileId: string }}
 */
export function validateUnit(input = {}) {
  const profile = input.profile
  if (!isPlainObject(profile) || !Array.isArray(profile.requiredParts)) {
    throw new ValidationError('校验单元需要确定性 profile', { field: 'profile' })
  }
  const unit = input.unit
  const missing = []
  if (!isPlainObject(unit)) {
    return {
      ok: false,
      missing: profile.requiredParts.map((part) => ({ part, reason: 'unit-not-present' })),
      unobserved: [],
      checkedParts: [],
      profileId: profile.profileId,
    }
  }
  /** @param {string} part @param {string} reason @param {object} [extra] */
  const fail = (part, reason, extra = {}) => missing.push({ part, reason, ...extra })

  // ---- the five parts ---------------------------------------------------------------------
  for (const part of profile.requiredParts) {
    if (!isPlainObject(unit[part])) {
      fail(part, 'part-missing-or-not-object')
    }
  }
  if (missing.length > 0) {
    return { ok: false, missing, unobserved: [], checkedParts: [], profileId: profile.profileId }
  }

  // ---- manifest ---------------------------------------------------------------------------
  const manifest = unit.unitManifest
  for (const field of ['unitId', 'projectId', 'target', 'status', 'source']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0) fail('unitManifest', 'field-missing', { field })
  }
  if (manifest.base !== profile.base) fail('unitManifest', 'base-mismatch', { expected: profile.base, actual: manifest.base ?? null })
  if (manifest.operation !== profile.operation) {
    fail('unitManifest', 'operation-mismatch', { expected: profile.operation, actual: manifest.operation ?? null })
  }
  if (manifest.profileId !== profile.profileId) fail('unitManifest', 'profile-id-mismatch', { field: 'profileId' })
  if (manifest.profileVersion !== profile.profileVersion) {
    fail('unitManifest', 'profile-version-mismatch', { expected: profile.profileVersion, actual: manifest.profileVersion ?? null })
  }
  if (!Array.isArray(manifest.spec) && !isPlainObject(manifest.spec)) fail('unitManifest', 'spec-missing', { field: 'spec' })
  if (manifest.placeholder === true) fail('unitManifest', 'placeholder')

  // ---- output: real files, real hashes, real coverage -------------------------------------
  const output = unit.unitOutput
  const files = Array.isArray(output.files) ? output.files : []
  if (files.length === 0) fail('unitOutput', 'files-empty')
  for (const [index, file] of files.entries()) {
    if (!isPlainObject(file)) {
      fail('unitOutput', 'file-entry-not-object', { index })
      continue
    }
    if (file.placeholder === true) fail('unitOutput', 'placeholder-file', { index })
    const relative = typeof file.path === 'string' ? file.path : ''
    if (relative.length === 0) {
      fail('unitOutput', 'file-path-missing', { index })
      continue
    }
    if (input.paths !== undefined) {
      let absolute = null
      try {
        absolute = input.paths.resolve(relative)
      } catch {
        fail('unitOutput', 'file-path-outside-project', { index, path: relative })
        continue
      }
      if (!fs.existsSync(absolute)) {
        fail('unitOutput', 'file-missing', { index, path: relative })
        continue
      }
      if (input.checkHashes !== false && typeof file.sha256 === 'string') {
        const actual = sha256File(absolute)
        if (actual !== file.sha256) fail('unitOutput', 'file-hash-mismatch', { index, path: relative })
      }
    }
    if (typeof file.role !== 'string' || file.role.length === 0) fail('unitOutput', 'file-role-missing', { index })
  }
  if (output.readableWhole !== true) fail('unitOutput', 'not-readable-whole', { action: '整片或整单元必须可完整读取播放' })

  const evidence = Array.isArray(output.evidence) ? output.evidence : []
  const executedKinds = evidence.filter((entry) => entry?.executed === true).map((entry) => entry.kind)
  const unobserved = []
  for (const kind of profile.requiredEvidence) {
    if (!executedKinds.includes(kind)) {
      fail('unitOutput', 'required-evidence-missing', { kind })
      continue
    }
    const entry = evidence.find((item) => item.kind === kind && item.executed === true)
    if (profile.observationRequiredEvidence.includes(kind)) {
      const state = entry?.observationState
      if (state !== 'observed' && state !== 'partial' && state !== 'not-observed') {
        fail('unitOutput', 'observation-state-missing', { kind, action: '真实看过／没看过都要结构化记录' })
      }
      if (state === 'not-observed' || state === 'partial') unobserved.push(kind)
    }
  }
  if (evidence.length > 0 && executedKinds.length === 0) fail('unitOutput', 'no-executed-evidence')

  const checks = Array.isArray(output.checks) ? output.checks : []
  if (checks.length === 0) fail('unitOutput', 'checks-empty')
  for (const check of checks) {
    if (!isPlainObject(check) || typeof check.name !== 'string' || check.name.length === 0) {
      fail('unitOutput', 'check-name-missing')
      continue
    }
    if (check.executed !== true) fail('unitOutput', 'check-not-executed', { check: check.name })
    else if (check.passed !== true) fail('unitOutput', 'check-failed', { check: check.name })
  }

  // ---- recipe -----------------------------------------------------------------------------
  const recipe = unit.productionRecipe
  if (!Array.isArray(recipe.authorizedInputs) || recipe.authorizedInputs.length === 0) {
    fail('productionRecipe', 'authorized-inputs-missing')
  }
  if (!Array.isArray(recipe.methods) || recipe.methods.length === 0) fail('productionRecipe', 'methods-missing')
  if (!Array.isArray(recipe.tools) || recipe.tools.length === 0) fail('productionRecipe', 'tools-missing')
  if (!isPlainObject(recipe.parameters)) fail('productionRecipe', 'parameters-missing')
  if (!isPlainObject(recipe.execution) || recipe.execution.executed !== true) fail('productionRecipe', 'execution-not-recorded')
  if (!Array.isArray(recipe.fixed) || !Array.isArray(recipe.variable)) fail('productionRecipe', 'fixed-variable-boundary-missing')
  if (recipe.placeholder === true) fail('productionRecipe', 'placeholder')

  // ---- human result pack ------------------------------------------------------------------
  const pack = unit.humanResultPack
  if (!Array.isArray(pack.slots) || pack.slots.length === 0) fail('humanResultPack', 'slots-empty')
  if (!Array.isArray(pack.knownIssues)) fail('humanResultPack', 'known-issues-missing')
  if (!Array.isArray(pack.unverified)) fail('humanResultPack', 'unverified-missing')
  if (!Array.isArray(pack.choices) || pack.choices.length === 0) fail('humanResultPack', 'choices-empty')

  // ---- continuation contract --------------------------------------------------------------
  const continuation = unit.continuationContract
  for (const field of ['directReuse', 'adaptByContent', 'recreate', 'reverify']) {
    if (typeof continuation[field] !== 'string' || continuation[field].trim().length === 0) {
      fail('continuationContract', 'field-missing', { field })
    }
  }
  if (!Array.isArray(continuation.dependsOn)) fail('continuationContract', 'depends-on-missing')
  if (!Array.isArray(continuation.invalidWhen) || continuation.invalidWhen.length === 0) {
    fail('continuationContract', 'invalid-when-missing')
  }

  return {
    ok: missing.length === 0,
    missing,
    unobserved: unique(unobserved),
    checkedParts: profile.requiredParts.filter((part) => isPlainObject(unit[part])),
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
  }
}

/**
 * Assert a unit is complete, naming every reason at once.
 * @param {object} input see {@link validateUnit}
 * @returns {any} the validation result
 */
export function assertUnitComplete(input = {}) {
  const result = validateUnit(input)
  if (!result.ok) {
    throw new ConflictError('生产单元未完成', {
      action: '补齐缺失项并重新检查；不得删除验收项或口头宣布足够',
      missing: result.missing.slice(0, 20),
      profileId: result.profileId,
    })
  }
  return result
}

/**
 * The unit registry of one project: what was produced, by which profile, and how far it got.
 */
export class UnitRegistry {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.units, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => ({
      kind: ORCH_DOCUMENT.units.kind,
      version: 1,
      projectId: this.projectId,
      units: [],
      journal: [],
    }))
  }

  /** @returns {any[]} */
  list() {
    return copy(this.load().value.units)
  }

  /**
   * Register or re-check one unit. The gate runs on every write, so a stored unit is never
   * "complete" only because someone typed that.
   * @param {object} input
   * @param {any} input.unit
   * @param {any} input.profile
   * @returns {{ unitId: string, status: string, validation: any, revision: string }}
   */
  register(input = {}) {
    const profile = input.profile
    const unit = input.unit
    if (!isPlainObject(unit) || !isPlainObject(unit.unitManifest)) {
      throw new ValidationError('登记单元需要 unitManifest', { field: 'unit' })
    }
    const unitId = requireText(unit.unitManifest.unitId, 'unitManifest.unitId', 120)
    const validation = validateUnit({ unit, profile, paths: this.paths })
    const { value, revision } = this.load()
    const now = this.clock.iso()
    const existing = value.units.find((entry) => entry.unitId === unitId)
    const record = {
      unitId,
      base: profile.base,
      operation: profile.operation,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      status: validation.ok ? 'complete' : 'incomplete',
      validation,
      unit: copy(unit),
      firstRegisteredAt: existing?.firstRegisteredAt ?? now,
      updatedAt: now,
      // A unit that regressed keeps the fact that it once passed, so a later edit cannot hide it.
      passedAt: validation.ok ? now : existing?.passedAt ?? null,
      history: existing?.history ?? [],
    }
    record.history = [
      ...record.history,
      { at: now, status: record.status, missing: validation.missing.length },
    ].slice(-20)
    if (existing === undefined) value.units.push(record)
    else value.units[value.units.indexOf(existing)] = record
    value.journal = appendJournal(value.journal, { action: 'unit-registered', unitId, status: record.status, at: now })
    const written = this.document.write(value, revision)
    return { unitId, status: record.status, validation, revision: written.revision }
  }

  /**
   * Units that are complete. Everything else is explicitly incomplete.
   * @returns {{ complete: any[], incomplete: any[] }}
   */
  partition() {
    const units = this.list()
    return {
      complete: units.filter((unit) => unit.status === 'complete'),
      incomplete: units.filter((unit) => unit.status !== 'complete'),
    }
  }

  /**
   * The early-unit gate: at least one real complete unit, and no incomplete unit claimed as done.
   * @returns {{ ok: boolean, blockers: any[], complete: number, incomplete: number }}
   */
  gate() {
    const { complete, incomplete } = this.partition()
    const blockers = []
    if (complete.length === 0) blockers.push({ reason: '没有已完成的早期生产单元', action: '先完成至少一个真实单元' })
    for (const unit of incomplete) {
      blockers.push({ reason: '单元未完成', unitId: unit.unitId, missing: unit.validation.missing.slice(0, 8) })
    }
    return { ok: blockers.length === 0, blockers, complete: complete.length, incomplete: incomplete.length }
  }
}

/**
 * One production view of a unit: what the making agent needs right now, and nothing else.
 *
 * The three views are projections of the same stored facts; they are not three copies, so a view
 * cannot disagree with the project (C13 §4.4, CT-07 §4).
 *
 * @param {object} input
 * @param {any} input.unit
 * @param {any} input.profile
 * @param {string} [input.currentAction]
 * @returns {any}
 */
export function productionView(input = {}) {
  const unit = input.unit ?? {}
  const profile = input.profile
  return {
    view: 'production',
    profileId: profile?.profileId ?? null,
    currentAction: optionalText(input.currentAction, 'currentAction', 500),
    manifest: {
      unitId: unit.unitManifest?.unitId ?? null,
      base: unit.unitManifest?.base ?? null,
      operation: unit.unitManifest?.operation ?? null,
      target: unit.unitManifest?.target ?? null,
    },
    recipe: unit.productionRecipe ?? null,
    riskItems: profile?.requiredEvidence?.filter((kind) => OBSERVATION_EVIDENCE.includes(kind)) ?? [],
    evidenceRefs: (unit.unitOutput?.evidence ?? []).map((entry) => ({ kind: entry.kind, ref: entry.ref ?? null })),
    // Deliberately absent: full chat history, every candidate, every old frame.
    excluded: ['全历史聊天', '无关候选', '所有旧帧', '其他单元的内部细节'],
  }
}

/**
 * Human-result view: the fixed pack plus the choices, with technical noise kept out.
 * @param {object} input
 * @param {any} input.unit
 * @returns {any}
 */
export function humanResultView(input = {}) {
  const unit = input.unit ?? {}
  const pack = unit.humanResultPack ?? {}
  return {
    view: 'human-result',
    unitId: unit.unitManifest?.unitId ?? null,
    target: unit.unitManifest?.target ?? null,
    slots: pack.slots ?? [],
    knownIssues: pack.knownIssues ?? [],
    unverified: pack.unverified ?? [],
    choices: pack.choices ?? [],
    excluded: ['内部推理', '无关日志', '技术噪声', '其他单元'],
  }
}

/**
 * Recovery/extended view: enough to continue, and nothing that would silently re-do work.
 * @param {object} input
 * @param {any} input.unit
 * @param {any} input.profile
 * @param {any} [input.workPackage]
 * @param {any} [input.baseline]
 * @returns {any}
 */
export function recoveryView(input = {}) {
  const unit = input.unit ?? {}
  const work = input.workPackage ?? {}
  return {
    view: 'recovery',
    profileId: input.profile?.profileId ?? null,
    baseline: input.baseline ?? null,
    recipe: unit.productionRecipe ?? null,
    resultRefs: (unit.unitOutput?.files ?? []).map((file) => ({
      role: file.role,
      path: file.path,
      sha256: file.sha256,
    })),
    continuation: unit.continuationContract ?? null,
    workPackage: {
      workPackageId: work.workPackageId ?? null,
      version: work.version ?? null,
      currentUnit: work.currentUnit ?? null,
      currentObject: work.currentObject ?? null,
      nextAction: work.nextAction ?? null,
      savedPosition: work.savedPosition ?? null,
      openQuestions: work.openQuestions ?? [],
      inFlightActions: work.inFlightActions ?? [],
    },
    // Default recovery does not restore every derived image or invalid context.
    excluded: ['全部派生图', '缓存', '失效上下文'],
  }
}
