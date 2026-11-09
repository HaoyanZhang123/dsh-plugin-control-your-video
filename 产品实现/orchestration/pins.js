/**
 * Tool-pin synchronisation with project versions, as the C06 CR-6 hand-over requires.
 *
 * Three boundaries decide the design:
 * - C06 owns pins and their history; C13 only tells C06 "this project moved from version A to B".
 *   C13 never advances a project version and never copies project facts into a pin.
 * - A stale pin must be visible, never repaired by guessing. If the stored pin does not match the
 *   project version the project is actually at, the result is `needs-handling`, not a silent rebind.
 * - Project open and recovery re-check explicitly, because an event listener can miss events while the
 *   app was closed. Event-driven advance alone is therefore not enough (C13 card §4.10 1–2).
 *
 * A measured interface fact is recorded here instead of being worked around: C10 project ids look
 * like `prj_<BASE32>` while C06's `assertProjectId` accepts `^[a-z]+-[A-Za-z0-9]+$`, so a raw C10 id
 * is refused by C06. C13 does not invent a translation. It reports the mismatch as `needs-handling`
 * and accepts an explicit, attributable reference decision when one exists.
 *
 * @module orchestration/pins
 */

import { Clock, ConflictError, ValidationError } from '../base/index.js'
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

/** Stable codes for the problems this layer can report to the user. */
export const PinSyncIssue = Object.freeze({
  REFERENCE_MISMATCH: 'pin-reference-format-mismatch',
  STALE: 'pin-stale',
  MISSING: 'pin-missing',
  AHEAD: 'pin-ahead',
  FROM_VERSION_NOT_PINNED: 'pin-from-version-absent',
  C06_REFUSED: 'pin-source-refused',
  TOOL_UNKNOWN: 'pin-tool-unavailable',
})

/** What this layer can and cannot claim. */
export const PIN_SYNC_CAPABILITIES = Object.freeze({
  advance: {
    supported: ['监听项目版本变化并调用 C06 advanceProjectPin', '同版本重复推进是幂等的'],
    limits: ['C06 仍持有 pin 与历史；C13 不复制项目事实', '不自行推进 projectVersion'],
  },
  recheck: {
    supported: ['项目打开与恢复时显式复核', 'stale／missing／ahead 都作为需要处理上报'],
    limits: ['不自动猜测修复', '复核是只读的，不写 pin'],
  },
  reference: {
    supported: ['C10 与 C06 的项目引用格式不一致时如实报告', '可记录一次明确的引用决定'],
    limits: ['引用决定不是自动翻译，必须由人或总控写下依据', '不修改 C06 的校验规则'],
  },
})

/**
 * @param {string} projectId
 * @returns {any}
 */
function emptyLedger(projectId) {
  return {
    kind: ORCH_DOCUMENT.pinSync.kind,
    projectId,
    version: 1,
    c06ProjectRef: null,
    referenceDecision: null,
    events: [],
    issues: [],
    journal: [],
  }
}

/**
 * Turn one C06 result into a user-facing standing, without softening it.
 * @param {any} result
 * @returns {{ status: string, needsHandling: boolean, message: string }}
 */
function describeCheck(result) {
  if (result === null || typeof result !== 'object') {
    return { status: 'needs-handling', needsHandling: true, message: 'C06 没有返回复核结果' }
  }
  if (result.check === 'current') {
    return { status: 'current', needsHandling: false, message: 'pin 与项目当前版本一致' }
  }
  if (result.check === 'stale') {
    return {
      status: 'needs-handling',
      needsHandling: true,
      message: `pin 只覆盖旧版本（${(result.staleVersions ?? []).join('、') || '未知'}），当前版本 ${result.currentProjectVersion} 尚未同步`,
    }
  }
  if (result.check === 'missing') {
    return { status: 'no-pin', needsHandling: false, message: '该项目还没有任何工具 pin，不是过期，而是未建立' }
  }
  if (result.check === 'ahead') {
    return { status: 'needs-handling', needsHandling: true, message: 'pin 指向比项目更晚的版本，可能是乱序同步，需要人工核对' }
  }
  return { status: 'needs-handling', needsHandling: true, message: `未知的 pin 复核结果：${String(result.check)}` }
}

/**
 * The C13 side of pin synchronisation.
 */
export class PinSync {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} input.pinSource the C06 tool state (methods `advanceProjectPin`, `recheckProjectPin`)
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.pinSource = input.pinSource ?? null
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.pinSync, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => emptyLedger(this.projectId))
  }

  /** @returns {any} */
  read() {
    return this.load().value
  }

  /**
   * Record an explicit reference decision for C06.
   *
   * This exists because the two modules' id formats currently differ. It is deliberately a separate,
   * attributable act with a reason, so the bridge can never be mistaken for a derived value.
   *
   * @param {object} input
   * @param {string} input.c06ProjectRef the reference C06 accepts
   * @param {string} input.authorizedBy `user` or `orchestrator`
   * @param {string} input.reason why this reference names this project
   * @param {string} [input.authorizationRef]
   * @returns {{ ledger: any, revision: string }}
   */
  setReference(input = {}) {
    const c06ProjectRef = requireText(input.c06ProjectRef, 'c06ProjectRef', 120)
    if (!/^[a-z]+-[A-Za-z0-9]+$/.test(c06ProjectRef)) {
      throw new ValidationError('C06 项目引用格式不符，不能登记', {
        field: 'c06ProjectRef',
        expected: '^[a-z]+-[A-Za-z0-9]+$',
      })
    }
    const authorizedBy = requireOneOf(input.authorizedBy, { USER: 'user', ORCHESTRATOR: 'orchestrator' }, 'authorizedBy')
    const reason = requireText(input.reason, 'reason', 500)
    const { value, revision } = this.load()
    const now = this.clock.iso()
    const ledger = {
      ...value,
      c06ProjectRef,
      referenceDecision: {
        c06ProjectRef,
        authorizedBy,
        reason,
        authorizationRef: optionalText(input.authorizationRef, 'authorizationRef', 120),
        decidedAt: now,
        // C10's id is recorded so the mapping is auditable, not a naming trick.
        c10ProjectId: this.projectId,
      },
      journal: appendJournal(value.journal, { action: 'pin-reference-decided', c06ProjectRef, at: now }),
    }
    const written = this.document.write(ledger, revision)
    return { ledger: copy(ledger), revision: written.revision }
  }

  /**
   * The reference handed to C06: the explicit decision first, then the raw C10 id.
   * @returns {string}
   */
  c06Ref() {
    return this.read().c06ProjectRef ?? this.projectId
  }

  /**
   * Advance the pin of one tool after the project version really changed.
   *
   * @param {object} input
   * @param {string} input.toolId
   * @param {string} input.fromProjectVersion
   * @param {string} input.toProjectVersion
   * @param {string} input.toolVersion the tool version the existing pin recorded
   * @returns {any} `{ status, needsHandling, issue?, event? }`
   */
  advance(input = {}) {
    const toolId = requireText(input.toolId, 'toolId', 120)
    const from = requireText(input.fromProjectVersion, 'fromProjectVersion', 200)
    const to = requireText(input.toProjectVersion, 'toProjectVersion', 200)
    const toolVersion = requireText(input.toolVersion, 'toolVersion', 80)
    if (from === to) {
      throw new ValidationError('版本没有变化，不需要推进 pin', { field: 'toProjectVersion', action: '同版本推进会被误认为真实变化' })
    }
    /** @returns {any} */
    const recordIssue = (code, message, extra = {}) => {
      const { value, revision } = this.load()
      const now = this.clock.iso()
      const issue = { code, message, toolId, fromProjectVersion: from, toProjectVersion: to, at: now, ...extra }
      const ledger = { ...value, issues: [...value.issues, issue].slice(-50) }
      ledger.journal = appendJournal(value.journal, { action: 'pin-issue', code, toolId, at: now })
      const written = this.document.write(ledger, revision)
      return { status: 'needs-handling', needsHandling: true, issue: copy(issue), revision: written.revision }
    }
    if (this.pinSource === null) {
      return recordIssue(PinSyncIssue.TOOL_UNKNOWN, '没有可用的 C06 pin 源，无法推进 pin')
    }
    const ref = this.c06Ref()
    try {
      const result = this.pinSource.advanceProjectPin(toolId, {
        projectId: ref,
        fromProjectVersion: from,
        toProjectVersion: to,
        version: toolVersion,
        reason: 'C13 同步项目版本变化',
      })
      const { value, revision } = this.load()
      const now = this.clock.iso()
      const event = {
        eventId: orchestrationId('pinIssue', `${this.projectId}:${toolId}:${to}:${value.events.length}`),
        toolId,
        fromProjectVersion: from,
        toProjectVersion: to,
        toolVersion,
        ref,
        status: 'advanced',
        at: now,
      }
      const ledger = { ...value, events: [...value.events, event].slice(-200) }
      ledger.journal = appendJournal(value.journal, { action: 'pin-advanced', toolId, to, at: now })
      const written = this.document.write(ledger, revision)
      return { status: 'advanced', needsHandling: false, event: copy(event), c06: result, revision: written.revision }
    } catch (error) {
      const message = String(error?.message ?? error)
      const code = /项目 ID|projectId/.test(message) ? PinSyncIssue.REFERENCE_MISMATCH : PinSyncIssue.C06_REFUSED
      return recordIssue(code, message, {
        action:
          code === PinSyncIssue.REFERENCE_MISMATCH
            ? 'C10 与 C06 的项目引用格式不一致；需要总控修正接口或记录一次明确引用决定，不自动翻译'
            : '按 C06 的拒绝原因处理；不猜测修复，不重复调用',
      })
    }
  }

  /**
   * Re-check pins when a project opens or resumes. Read-only: no pin is written here.
   *
   * @param {object} input
   * @param {string} input.currentProjectVersion
   * @param {string[]} input.toolIds
   * @returns {any} `{ ok, results, needsHandling }`
   */
  recheck(input = {}) {
    const currentProjectVersion = requireText(input.currentProjectVersion, 'currentProjectVersion', 200)
    const toolIds = requireTextList(input.toolIds, 'toolIds', 32)
    if (toolIds.length === 0) throw new ValidationError('复核需要至少一个工具', { field: 'toolIds' })
    const ref = this.c06Ref()
    const results = []
    for (const toolId of toolIds) {
      if (this.pinSource === null) {
        results.push({
          toolId,
          status: 'needs-handling',
          needsHandling: true,
          message: '没有可用的 C06 pin 源',
          code: PinSyncIssue.TOOL_UNKNOWN,
        })
        continue
      }
      try {
        const raw = this.pinSource.recheckProjectPin(toolId, { projectId: ref, currentProjectVersion })
        const described = describeCheck(raw)
        results.push({ toolId, raw, ...described })
      } catch (error) {
        const message = String(error?.message ?? error)
        const code = /项目 ID|projectId/.test(message) ? PinSyncIssue.REFERENCE_MISMATCH : PinSyncIssue.C06_REFUSED
        results.push({
          toolId,
          status: 'needs-handling',
          needsHandling: true,
          message,
          code,
          action:
            code === PinSyncIssue.REFERENCE_MISMATCH
              ? '记录一次明确的 C06 项目引用，或由总控统一两种 ID 形状'
              : '按拒绝原因处理，不自动重试',
        })
      }
    }
    const needsHandling = results.filter((result) => result.needsHandling === true)
    return { ok: needsHandling.length === 0, currentProjectVersion, ref, results, needsHandling }
  }

  /**
   * The surface text for one standing. "需要处理" is a real state, not a warning to ignore.
   * @param {any} standing
   * @returns {{ label: string, tone: string, actionable: boolean }}
   */
  describeStanding(standing) {
    if (standing === null || standing === undefined) return { label: '未知', tone: 'neutral', actionable: true }
    if (standing.needsHandling !== true) return { label: '已同步', tone: 'ok', actionable: false }
    return { label: '需要处理', tone: 'warn', actionable: true }
  }

  /**
   * Record that the user handled a reported issue, with what they actually did.
   * @param {object} input
   * @param {string} input.code
   * @param {string} input.resolution
   * @returns {{ issue: any, revision: string }}
   */
  resolveIssue(input = {}) {
    const code = requireText(input.code, 'code', 80)
    const resolution = requireText(input.resolution, 'resolution', 500)
    const { value, revision } = this.load()
    const index = value.issues.findIndex((issue) => issue.code === code && issue.resolvedAt === undefined)
    if (index === -1) throw new ConflictError('没有待处理的这类问题', { code })
    const now = this.clock.iso()
    const issue = { ...value.issues[index], resolvedAt: now, resolution }
    const issues = [...value.issues]
    issues[index] = issue
    const written = this.document.write({ ...value, issues }, revision)
    return { issue: copy(issue), revision: written.revision }
  }

  /** @returns {any[]} unresolved issues, newest last */
  openIssues() {
    return copy(this.read().issues.filter((issue) => issue.resolvedAt === undefined))
  }
}
