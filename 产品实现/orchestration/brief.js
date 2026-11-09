/**
 * Creation brief, authorized research and capability composition.
 *
 * The brief is what the user can edit; it is never a single generated paragraph. Four sources stay
 * visibly separate — the user's own requirements, claims coming from sources, AI inferences and
 * things nobody knows yet — because merging them is how an inference silently becomes a promise
 * (C13 card §4.1, CT-03 §3).
 *
 * This module also takes over the two temporary UI facts C11 had to keep outside the project
 * (§4.12): the brief draft and the queued assistant messages. After a successful migration the
 * project documents below are the only author; the legacy files are kept untouched for audit and
 * are reported read-only, never deleted and never silently re-read as truth.
 *
 * @module orchestration/brief
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

/** Where a brief line came from. Four values, because a fifth would blur two of them. */
export const BriefSource = Object.freeze({
  USER: 'user-requirement',
  SOURCE: 'source-claim',
  AI: 'ai-inference',
  UNKNOWN: 'unknown',
})

/** How trustworthy one brief line currently is. */
export const BriefStatus = Object.freeze({
  STATED: 'stated',
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',
  REJECTED: 'rejected',
  REMOVED: 'removed',
})

/** Research may only happen inside a scope the user actually granted. */
export const ResearchAuthorization = Object.freeze({
  GRANTED: 'granted',
  WITHDRAWN: 'withdrawn',
})

/** What one capability need can be satisfied by. */
export const CapabilityKind = Object.freeze({
  SKILL: 'skill',
  METHOD: 'method',
  ASSET: 'asset',
  TOOL: 'tool',
  TEMPLATE: 'template',
})

/** A capability gap is a proposal until the user authorizes a concrete option. */
export const GapStatus = Object.freeze({
  PROPOSED: 'proposed',
  AUTHORIZED: 'authorized',
  REJECTED: 'rejected',
})

/** What the brief interface can and cannot claim. */
export const BRIEF_CAPABILITIES = Object.freeze({
  briefing: {
    supported: ['四类来源分行保存', '每条可编辑并保留历史', '未知项单独列出'],
    limits: ['AI 写入的条目永远是推断，不会变成用户要求', '删除是软删除，历史保留用于追溯'],
  },
  research: {
    supported: ['只在用户授予的范围记录来源与观察', '未验证项与来源主张分开'],
    limits: ['记录来源不等于已读取全文', '没有联网权限时不会产生任何来源'],
  },
  capability: {
    supported: ['按任务组合已有能力', '工具不足列出首选／备选／最小验证'],
    limits: ['缺口只提出，不自动采用、不安装、不联网', '采用需要用户对具体选项的授权记录'],
  },
  legacyMigration: {
    supported: ['读取 C11 的 ui-state 简报与助手消息写入项目事实', '原文件保留并标记只读'],
    limits: ['不修改 ui/ 代码，UI 是否只读由界面后续接入', '损坏的原文件不会被猜测性修复'],
  },
})

/** Bounded sizes: a brief is a human-editable document, not an archive. */
export const BRIEF_LIMITS = Object.freeze({
  maxEntries: 400,
  maxTextLength: 4000,
  maxHistoryPerEntry: 40,
  maxMessages: 2000,
})

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Empty brief document for one project.
 * @param {string} projectId
 * @returns {any}
 */
function emptyBrief(projectId) {
  return {
    kind: ORCH_DOCUMENT.brief.kind,
    version: 1,
    projectId,
    objective: null,
    entries: [],
    updatedAt: null,
  }
}

/**
 * Normalize one stored entry, refusing shapes this module never writes.
 * @param {any} value
 * @returns {any}
 */
function normalizeEntry(value) {
  const source = requireOneOf(value?.source, BriefSource, 'entry.source')
  const status = requireOneOf(value?.status ?? BriefStatus.STATED, BriefStatus, 'entry.status')
  return {
    entryId: requireText(value?.entryId, 'entry.entryId', 120),
    source,
    status,
    text: requireText(value?.text, 'entry.text', BRIEF_LIMITS.maxTextLength),
    author: optionalText(value?.author, 'entry.author', 120) ?? 'unknown',
    createdAt: requireText(value?.createdAt, 'entry.createdAt', 60),
    updatedAt: optionalText(value?.updatedAt, 'entry.updatedAt', 60),
    evidenceRefs: requireTextList(value?.evidenceRefs, 'entry.evidenceRefs'),
    provenance: value?.provenance ?? null,
    history: Array.isArray(value?.history) ? value.history.slice(-BRIEF_LIMITS.maxHistoryPerEntry) : [],
  }
}

/**
 * The creation brief of one project.
 */
export class CreationBrief {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.brief, clock: this.clock })
    this.projectId = input.paths.projectId
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => emptyBrief(this.projectId))
  }

  /** @returns {any} the stored document (empty when absent) */
  read() {
    return this.load().value
  }

  /**
   * Add one line to the brief.
   *
   * `source` is required: an unlabelled line would be indistinguishable from a user requirement,
   * which is exactly the confusion this module exists to prevent.
   *
   * @param {object} input
   * @param {string} input.source one of {@link BriefSource}
   * @param {string} input.text
   * @param {string} [input.author]
   * @param {string[]} [input.evidenceRefs]
   * @param {string} [input.status]
   * @param {object} [input.provenance]
   * @returns {{ entry: any, revision: string }}
   */
  addEntry(input = {}) {
    const source = requireOneOf(input.source, BriefSource, 'source')
    const text = requireText(input.text, 'text', BRIEF_LIMITS.maxTextLength)
    const status =
      input.status === undefined
        ? source === BriefSource.UNKNOWN
          ? BriefStatus.UNVERIFIED
          : BriefStatus.STATED
        : requireOneOf(input.status, BriefStatus, 'status')
    if (status === BriefStatus.REMOVED) throw new ValidationError('新条目不能直接标记为删除', { field: 'status' })
    const { value, revision } = this.load()
    if (value.entries.length >= BRIEF_LIMITS.maxEntries) {
      throw new ConflictError('简报条目已达上限，请先合并或删除', { max: BRIEF_LIMITS.maxEntries })
    }
    const now = this.clock.iso()
    const entry = {
      entryId: orchestrationId('briefEntry', `${this.projectId}:${value.entries.length}:${sha256(`${source}\u0000${text}`)}`),
      source,
      status,
      text,
      author: optionalText(input.author, 'author', 120) ?? (source === BriefSource.AI ? 'ai' : 'user'),
      createdAt: now,
      updatedAt: null,
      evidenceRefs: requireTextList(input.evidenceRefs, 'evidenceRefs'),
      provenance: input.provenance ?? null,
      history: [],
    }
    value.entries.push(entry)
    value.updatedAt = now
    const written = this.document.write(value, revision)
    return { entry: copy(entry), revision: written.revision }
  }

  /**
   * Edit one line, keeping the previous version in the entry's history.
   * @param {object} input
   * @param {string} input.entryId
   * @param {string} input.text
   * @param {string} [input.actor]
   * @param {string} [input.reason]
   * @returns {{ entry: any, revision: string }}
   */
  editEntry(input = {}) {
    const entryId = requireText(input.entryId, 'entryId', 120)
    const text = requireText(input.text, 'text', BRIEF_LIMITS.maxTextLength)
    const { value, revision } = this.load()
    const entry = value.entries.find((item) => item.entryId === entryId)
    if (entry === undefined) throw new ValidationError('简报条目不存在', { field: 'entryId', entryId })
    if (entry.status === BriefStatus.REMOVED) {
      throw new ConflictError('已删除的简报条目不能再编辑，请新增一条', { entryId })
    }
    const now = this.clock.iso()
    entry.history = [
      ...entry.history,
      { at: now, text: entry.text, status: entry.status, actor: optionalText(input.actor, 'actor', 120) ?? 'user' },
    ].slice(-BRIEF_LIMITS.maxHistoryPerEntry)
    entry.text = text
    entry.updatedAt = now
    // A human edit of an AI inference does not turn it into a user requirement: the source stays,
    // and only the status records that the line was touched.
    value.updatedAt = now
    const written = this.document.write(value, revision)
    return { entry: copy(normalizeEntry(entry)), revision: written.revision }
  }

  /**
   * Remove one line without losing its history (soft delete).
   * @param {object} input
   * @param {string} input.entryId
   * @param {string} [input.reason]
   * @returns {{ entry: any, revision: string }}
   */
  removeEntry(input = {}) {
    const entryId = requireText(input.entryId, 'entryId', 120)
    const { value, revision } = this.load()
    const entry = value.entries.find((item) => item.entryId === entryId)
    if (entry === undefined) throw new ValidationError('简报条目不存在', { field: 'entryId', entryId })
    const now = this.clock.iso()
    entry.status = BriefStatus.REMOVED
    entry.updatedAt = now
    entry.history = [
      ...entry.history,
      { at: now, text: entry.text, status: 'removed', reason: optionalText(input.reason, 'reason', 500) ?? null },
    ].slice(-BRIEF_LIMITS.maxHistoryPerEntry)
    value.updatedAt = now
    const written = this.document.write(value, revision)
    return { entry: copy(entry), revision: written.revision }
  }

  /**
   * The brief as four separate lists plus real counts, for the creation surface and the receipt.
   * @returns {any}
   */
  summary() {
    const value = this.read()
    const live = value.entries.filter((entry) => entry.status !== BriefStatus.REMOVED)
    /** @param {string} source */
    const of = (source) => live.filter((entry) => entry.source === source).map((entry) => copy(entry))
    return {
      projectId: this.projectId,
      objective: value.objective,
      userRequirements: of(BriefSource.USER),
      sourceClaims: of(BriefSource.SOURCE),
      aiInferences: of(BriefSource.AI),
      unknowns: of(BriefSource.UNKNOWN),
      counts: {
        user: of(BriefSource.USER).length,
        source: of(BriefSource.SOURCE).length,
        ai: of(BriefSource.AI).length,
        unknown: of(BriefSource.UNKNOWN).length,
        removed: value.entries.length - live.length,
      },
      updatedAt: value.updatedAt,
    }
  }

  /**
   * Every unknown that nobody has answered yet. Production may not treat one as decided.
   * @returns {any[]}
   */
  openUnknowns() {
    return this.read().entries.filter(
      (entry) =>
        entry.source === BriefSource.UNKNOWN &&
        entry.status !== BriefStatus.REMOVED &&
        entry.status !== BriefStatus.VERIFIED,
    )
  }
}

/**
 * Authorized research log: sources, observations and what could not be verified.
 */
export class ResearchLog {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.clock = input.clock ?? new Clock()
    this.projectId = input.paths.projectId
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.research, clock: this.clock })
  }

  /** @returns {any} */
  read() {
    const stored = this.document.tryRead()
    if (stored !== null) return stored.value
    return {
      kind: ORCH_DOCUMENT.research.kind,
      version: 1,
      projectId: this.projectId,
      authorizations: [],
      sources: [],
      observations: [],
      unknown: [],
    }
  }

  /**
   * Record the user's research authorization. C13 cannot grant this to itself.
   * @param {object} input
   * @param {string} input.scope what may be researched
   * @param {string} input.humanResponse the user's own words
   * @param {string[]} [input.evidenceRefs]
   * @returns {{ authorization: any }}
   */
  recordAuthorization(input = {}) {
    const scope = requireText(input.scope, 'scope', 1000)
    const humanResponse = requireText(input.humanResponse, 'humanResponse', 2000)
    if (optionalText(input.grantedBy, 'grantedBy', 60) !== 'user') {
      throw new ValidationError('研究范围只能由用户授予', { field: 'grantedBy', action: '需要用户本人的明确回答' })
    }
    const { value, revision } = this.document.readOrCreate(() => this.read())
    const now = this.clock.iso()
    const authorization = {
      authorizationRef: orchestrationId('research', `${this.projectId}:${value.authorizations.length}:${sha256(scope)}`),
      scope,
      state: ResearchAuthorization.GRANTED,
      humanResponse,
      grantedAt: now,
      evidenceRefs: requireTextList(input.evidenceRefs, 'evidenceRefs'),
    }
    value.authorizations.push(authorization)
    const written = this.document.write(value, revision)
    return { authorization: copy(authorization), revision: written.revision }
  }

  /** @returns {any|null} the newest grant, or `null` */
  currentAuthorization() {
    const value = this.read()
    const active = value.authorizations.filter((item) => item.state === ResearchAuthorization.GRANTED)
    return active.length === 0 ? null : copy(active[active.length - 1])
  }

  /**
   * Record one source that was actually consulted, inside the granted scope.
   * @param {object} input
   * @param {string} input.title
   * @param {string} input.location how it was reached (URL, file, conversation)
   * @param {string} input.claim what the source says, in the finder's words
   * @param {string} [input.license]
   * @param {string} [input.observedAt]
   * @returns {{ source: any }}
   */
  recordSource(input = {}) {
    const authorization = this.currentAuthorization()
    if (authorization === null) {
      throw new ConflictError('没有用户授予的研究范围，不能记录来源', { action: '先取得研究授权' })
    }
    const title = requireText(input.title, 'title', 300)
    const location = requireText(input.location, 'location', 1000)
    const claim = requireText(input.claim, 'claim', 2000)
    const { value, revision } = this.document.readOrCreate(() => this.read())
    const source = {
      sourceId: orchestrationId('source', `${this.projectId}:${value.sources.length}:${location}`),
      title,
      location,
      claim,
      license: optionalText(input.license, 'license', 300),
      observedAt: optionalText(input.observedAt, 'observedAt', 60) ?? this.clock.iso(),
      authorizationRef: authorization.authorizationRef,
      inScope: true,
      // Seeding the claim into the brief as a SOURCE line is what makes "source says" visible;
      // it is never recorded as a user requirement.
      mediaObserved: false,
    }
    value.sources.push(source)
    const written = this.document.write(value, revision)
    return { source: copy(source), revision: written.revision }
  }

  /**
   * Record what was actually observed in one source, including what could not be observed.
   * @param {object} input
   * @param {string} input.sourceId
   * @param {string} input.view which view/portion was actually looked at
   * @param {string} [input.note]
   * @param {string[]} [input.unverified]
   * @returns {{ observation: any, revision: string }}
   */
  recordObservation(input = {}) {
    const sourceId = requireText(input.sourceId, 'sourceId', 120)
    const view = requireText(input.view, 'view', 500)
    const { value, revision } = this.document.readOrCreate(() => this.read())
    const source = value.sources.find((item) => item.sourceId === sourceId)
    if (source === undefined) throw new ValidationError('来源不存在', { field: 'sourceId', sourceId })
    const unverified = requireTextList(input.unverified, 'unverified', 32)
    const observation = {
      observationId: orchestrationId('research', `${sourceId}:${value.observations.length}:${view}`),
      sourceId,
      view,
      note: optionalText(input.note, 'note', 2000),
      unverified,
      at: this.clock.iso(),
    }
    value.observations.push(observation)
    for (const item of unverified) {
      value.unknown.push({ at: observation.at, sourceId, text: item })
    }
    source.mediaObserved = true
    const written = this.document.write(value, revision)
    return { observation: copy(observation), revision: written.revision }
  }

  /** @returns {any} counts plus the unverified list, for the brief and the receipt */
  summary() {
    const value = this.read()
    return {
      authorizations: value.authorizations.length,
      scope: this.currentAuthorization()?.scope ?? null,
      sources: value.sources.length,
      observations: value.observations.length,
      unknown: copy(value.unknown),
    }
  }
}

/**
 * Compose the capability set one task actually needs, and propose gaps without adopting them.
 *
 * "任务能力不改变用户流程" (§4.1): this returns data a surface can show, and adopting a proposed
 * option needs the user's authorization for that exact option, recorded elsewhere.
 *
 * @param {object} input
 * @param {string} input.task what the user wants made
 * @param {Array<{need: string, kind: string, candidates?: string[], available?: boolean}>} input.needs
 * @returns {any}
 */
export function composeCapabilities(input = {}) {
  const task = requireText(input.task, 'task', 1000)
  if (!Array.isArray(input.needs) || input.needs.length === 0) {
    throw new ValidationError('能力组合需要至少一项实际需要', { field: 'needs' })
  }
  const composition = []
  const gaps = []
  for (const raw of input.needs) {
    const need = requireText(raw?.need, 'needs[].need', 300)
    const kind = requireOneOf(raw?.kind, CapabilityKind, 'needs[].kind')
    const candidates = requireTextList(raw?.candidates, 'needs[].candidates', 8)
    const available = raw?.available === true
    const row = { need, kind, candidates, available }
    composition.push(row)
    if (!available) {
      gaps.push({
        gapId: orchestrationId('gap', `gap:${task}:${need}:${kind}`),
        need,
        kind,
        preferred: optionalText(raw?.preferred, 'needs[].preferred', 200) ?? candidates[0] ?? null,
        fallback: optionalText(raw?.fallback, 'needs[].fallback', 200) ?? candidates[1] ?? null,
        minimalValidation: optionalText(raw?.minimalValidation, 'needs[].minimalValidation', 500),
        status: GapStatus.PROPOSED,
        autoAdopted: false,
      })
    }
  }
  return {
    task,
    composition,
    gaps,
    // Stated as a field, not a promise in prose: nothing here was installed, downloaded or run.
    adopted: 0,
    requiresAuthorization: gaps.length > 0,
  }
}

/**
 * ADOPT one proposed capability option. Only a user authorization reference makes this pass.
 * @param {any} gap a row produced by {@link composeCapabilities}
 * @param {{ option?: string, authorizationRef?: string, authorizationScope?: string }} input
 * @returns {any}
 */
export function adoptCapabilityGap(gap, input = {}) {
  if (gap === null || typeof gap !== 'object' || typeof gap.gapId !== 'string') {
    throw new ValidationError('需要真实的能力缺口记录', { field: 'gap' })
  }
  const option = requireText(input.option ?? gap.preferred, 'option', 200)
  const authorizationRef = requireText(input.authorizationRef, 'authorizationRef', 120)
  const allowed = [gap.preferred, gap.fallback].filter((item) => typeof item === 'string')
  if (allowed.length > 0 && !allowed.includes(option)) {
    throw new ValidationError('只能采用该缺口列出的选项', { field: 'option', allowed })
  }
  return {
    ...copy(gap),
    status: GapStatus.AUTHORIZED,
    adoptedOption: option,
    authorizationRef,
    authorizationScope: optionalText(input.authorizationScope, 'authorizationScope', 500),
    autoAdopted: false,
  }
}

/**
 * Migrate C11's temporary UI state into project facts.
 *
 * What moves: the brief draft (one string or `{user, source, ai}`) and the assistant messages that
 * were stored with `status: queued-for-orchestration`. What does NOT happen: the legacy files are
 * never deleted or rewritten, nothing is guessed out of a broken file, and a second run is a no-op
 * unless new legacy content appeared.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {string} input.dataRoot absolute plugin data root (contains `ui-state/`)
 * @param {any} [input.clock]
 * @param {boolean} [input.dryRun]
 * @returns {any} migration report with `status`, `needsHandling` and the UI read-only verdict
 */
export function migrateLegacyUiState(input = {}) {
  if (typeof input.dataRoot !== 'string' || !path.isAbsolute(input.dataRoot)) {
    throw new ValidationError('迁移需要绝对的数据目录', { field: 'dataRoot' })
  }
  const clock = input.clock ?? new Clock()
  const paths = input.paths
  const projectId = paths.projectId
  const uiStateDir = path.join(input.dataRoot, 'ui-state')
  const briefFile = path.join(uiStateDir, `${projectId}.json`)
  const assistantFile = path.join(uiStateDir, `${projectId}.assistant.json`)
  const migrationDocument = new OrchestrationDocument({ paths, spec: ORCH_DOCUMENT.migration, clock })
  const existingMigration = migrationDocument.tryRead()

  /**
   * @param {string} file
   * @returns {{ file: string, present: boolean, sha256: string|null, value: any, error: string|null }}
   */
  const readLegacy = (file) => {
    if (!fs.existsSync(file)) {
      return { file: path.basename(file), present: false, sha256: null, value: null, error: null }
    }
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      return { file: path.basename(file), present: true, sha256: null, value: null, error: `读取失败: ${error?.code ?? 'unknown'}` }
    }
    const digest = sha256(text)
    try {
      return { file: path.basename(file), present: true, sha256: digest, value: JSON.parse(text), error: null }
    } catch {
      return { file: path.basename(file), present: true, sha256: digest, value: null, error: '内容不是合法 JSON，保持原样' }
    }
  }

  const legacyBrief = readLegacy(briefFile)
  const legacyAssistant = readLegacy(assistantFile)
  const nothingToMigrate = !legacyBrief.present && !legacyAssistant.present
  if (existingMigration !== null && existingMigration.value.status === 'completed' && nothingToMigrate) {
    return {
      status: 'already-migrated',
      record: copy(existingMigration.value),
      uiReadOnly: true,
      needsHandling: [],
      note: '既有迁移记录有效，本次没有新的旧数据',
    }
  }
  if (nothingToMigrate) {
    return { status: 'nothing-to-migrate', record: null, uiReadOnly: false, needsHandling: [], note: '没有 C11 的旧状态文件' }
  }

  const problems = [legacyBrief, legacyAssistant]
    .filter((entry) => entry.error !== null)
    .map((entry) => ({ code: 'legacy-unreadable', file: entry.file, message: entry.error }))

  /** Brief entries to add, if any. */
  const briefEntries = []
  const briefValue = legacyBrief.value
  if (briefValue !== null && typeof briefValue === 'object' && briefValue.brief !== undefined) {
    const raw = briefValue.brief
    const push = (source, text) => {
      const clean = typeof text === 'string' ? text.trim() : ''
      if (clean.length === 0) return
      briefEntries.push({ source, text: clean })
    }
    if (typeof raw === 'string') {
      // C11 stored a single textarea for the user's requirements.
      push(BriefSource.USER, raw)
    } else if (raw !== null && typeof raw === 'object') {
      push(BriefSource.USER, raw.user)
      push(BriefSource.SOURCE, raw.source)
      push(BriefSource.AI, raw.ai)
    }
  }

  const rawMessages = legacyAssistant.value?.messages
  const messages = Array.isArray(rawMessages) ? rawMessages : []
  if (legacyAssistant.present && legacyAssistant.value !== null && !Array.isArray(rawMessages)) {
    problems.push({ code: 'legacy-shape', file: legacyAssistant.file, message: 'assistant 文件缺少 messages 数组，保持原样' })
  }

  if (input.dryRun === true) {
    return {
      status: problems.length > 0 ? 'needs-handling' : 'dry-run',
      wouldMigrate: { briefEntries: briefEntries.length, messages: messages.length },
      files: [legacyBrief, legacyAssistant].map((entry) => ({
        file: entry.file,
        present: entry.present,
        sha256: entry.sha256,
      })),
      needsHandling: problems,
      uiReadOnly: false,
    }
  }

  const now = clock.iso()
  const history = appendJournal(existingMigration?.value?.history ?? [], {
    action: 'migrate-legacy-ui-state',
    at: now,
    briefEntries: briefEntries.length,
    messages: messages.length,
    problems: problems.length,
  })

  // Messages are written as C13's own thread, with the legacy status replaced by an honest one.
  let messagesWritten = 0
  if (messages.length > 0) {
    const threadDocument = new OrchestrationDocument({ paths, spec: ORCH_DOCUMENT.messages, clock })
    const thread = threadDocument.readOrCreate(() => ({
      kind: ORCH_DOCUMENT.messages.kind,
      version: 1,
      projectId,
      messages: [],
    }))
    const existingIds = new Set(thread.value.messages.map((message) => message.messageId))
    for (let index = 0; index < messages.length; index += 1) {
      const raw = messages[index]
      if (raw === null || typeof raw !== 'object') continue
      const text = typeof raw.text === 'string' ? raw.text.trim() : ''
      if (text.length === 0) continue
      const messageId =
        typeof raw.messageId === 'string' && raw.messageId.length > 0
          ? `legacy-${raw.messageId}`
          : `legacy-msg-${index}-${sha256(`${legacyAssistant.sha256 ?? ''}|${text}`).slice(0, 12)}`
      if (existingIds.has(messageId)) continue
      thread.value.messages.push({
        messageId,
        at: typeof raw.at === 'string' ? raw.at : now,
        author: typeof raw.author === 'string' ? raw.author : 'user',
        text,
        refs: Array.isArray(raw.refs) ? raw.refs.slice(0, 32) : [],
        status: 'received',
        legacyStatus: typeof raw.status === 'string' ? raw.status : null,
        provenance: { origin: 'legacy-ui-state', file: legacyAssistant.file, sha256: legacyAssistant.sha256 },
      })
      existingIds.add(messageId)
      messagesWritten += 1
    }
    // Only write when something was actually new; a re-run must not rewrite the thread.
    if (messagesWritten > 0) threadDocument.write(thread.value, thread.revision)
  }

  let briefWritten = 0
  if (briefEntries.length > 0) {
    const brief = new CreationBrief({ paths, clock })
    const loaded = brief.load()
    const existingKeys = new Set(
      loaded.value.entries.map((entry) => `${entry.provenance?.file ?? ''}|${entry.provenance?.semantic ?? ''}|${entry.text}`),
    )
    for (const entry of briefEntries) {
      const key = `${legacyBrief.file}|${entry.source}|${entry.text}`
      if (existingKeys.has(key)) continue
      loaded.value.entries.push({
        entryId: orchestrationId('briefEntry', `${projectId}:legacy:${sha256(key)}`),
        source: entry.source,
        status: entry.source === BriefSource.UNKNOWN ? BriefStatus.UNVERIFIED : BriefStatus.STATED,
        text: entry.text,
        author: entry.source === BriefSource.AI ? 'ai' : 'user',
        createdAt: now,
        updatedAt: null,
        evidenceRefs: [],
        provenance: { origin: 'legacy-ui-state', file: legacyBrief.file, sha256: legacyBrief.sha256, semantic: entry.source },
        history: [],
      })
      existingKeys.add(key)
      briefWritten += 1
    }
    if (briefWritten > 0) {
      loaded.value.updatedAt = now
      brief.document.write(loaded.value, loaded.revision)
    }
  }

  // Idempotency is proven by "nothing new was written", not by the legacy files disappearing.
  if (
    existingMigration !== null &&
    existingMigration.value.status === 'completed' &&
    briefWritten === 0 &&
    messagesWritten === 0 &&
    problems.length === 0
  ) {
    return {
      status: 'already-migrated',
      record: copy(existingMigration.value),
      uiReadOnly: true,
      needsHandling: [],
      note: '既有迁移已完成且没有新的旧数据',
    }
  }

  const status = problems.length > 0 ? 'needs-handling' : 'completed'
  const record = {
    kind: ORCH_DOCUMENT.migration.kind,
    version: 1,
    projectId,
    status,
    migratedAt: now,
    files: [
      { file: legacyBrief.file, present: legacyBrief.present, sha256: legacyBrief.sha256, error: legacyBrief.error },
      {
        file: legacyAssistant.file,
        present: legacyAssistant.present,
        sha256: legacyAssistant.sha256,
        error: legacyAssistant.error,
      },
    ],
    briefEntriesWritten: briefWritten,
    messagesWritten,
    // The legacy files stay where they are. C13 never deletes user data, and a repair guess would
    // be worse than an honest "needs handling".
    originalsKept: true,
    needsHandling: problems,
    history,
  }
  const written = migrationDocument.write(record, existingMigration?.revision ?? null)
  return {
    status,
    record: { ...copy(record), revision: written.revision },
    uiReadOnly: status === 'completed',
    needsHandling: problems,
  }
}

/**
 * What the creation surface may still show from the legacy UI state, and whether it is read-only.
 *
 * The flag exists so a surface cannot keep writing the second copy after migration; it does not
 * itself change the UI, which belongs to another card.
 *
 * @param {object} input
 * @param {any} input.paths
 * @param {any} [input.clock]
 * @returns {{ migrated: boolean, readOnly: boolean, status: string|null, needsHandling: any[] }}
 */
export function legacyUiStateStanding(input) {
  const document = new OrchestrationDocument({
    paths: input.paths,
    spec: ORCH_DOCUMENT.migration,
    clock: input.clock ?? new Clock(),
  })
  const stored = document.tryRead()
  if (stored === null) return { migrated: false, readOnly: false, status: null, needsHandling: [] }
  return {
    migrated: stored.value.status === 'completed',
    readOnly: stored.value.status === 'completed',
    status: stored.value.status,
    needsHandling: Array.isArray(stored.value.needsHandling) ? copy(stored.value.needsHandling) : [],
  }
}

/**
 * The assistant thread C13 owns after migration.
 * @param {object} input
 * @param {any} input.paths
 * @param {any} [input.clock]
 * @returns {{ messages: any[], nextSeq: number }}
 */
export function readAssistantThread(input) {
  const document = new OrchestrationDocument({
    paths: input.paths,
    spec: ORCH_DOCUMENT.messages,
    clock: input.clock ?? new Clock(),
  })
  const stored = document.tryRead()
  if (stored === null) return { messages: [], nextSeq: 1 }
  return { messages: copy(stored.value.messages ?? []), nextSeq: (stored.value.messages?.length ?? 0) + 1 }
}

/**
 * Append one assistant message. After migration this is the ONLY writer of that thread.
 * @param {object} input
 * @param {any} input.paths
 * @param {string} input.text
 * @param {string} [input.author]
 * @param {any[]} [input.refs]
 * @param {string} [input.status]
 * @param {any} [input.clock]
 * @returns {{ message: any, revision: string }}
 */
export function appendAssistantMessage(input = {}) {
  const clock = input.clock ?? new Clock()
  const document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.messages, clock })
  const stored = document.readOrCreate(() => ({
    kind: ORCH_DOCUMENT.messages.kind,
    version: 1,
    projectId: input.paths.projectId,
    messages: [],
  }))
  const messages = stored.value.messages ?? []
  if (messages.length >= BRIEF_LIMITS.maxMessages) {
    throw new ConflictError('助手消息已达上限', { max: BRIEF_LIMITS.maxMessages })
  }
  const message = {
    messageId: orchestrationId('briefEntry', `${input.paths.projectId}:msg:${messages.length}:${sha256(input.text ?? '')}`),
    at: clock.iso(),
    author: optionalText(input.author, 'author', 60) ?? 'user',
    text: requireText(input.text, 'text', BRIEF_LIMITS.maxTextLength),
    refs: Array.isArray(input.refs) ? input.refs.slice(0, 32) : [],
    status: optionalText(input.status, 'status', 60) ?? 'received',
  }
  messages.push(message)
  const written = document.write({ ...stored.value, messages }, stored.revision)
  return { message: copy(message), revision: written.revision }
}
