/**
 * Directions, plan baseline, and the boundaries around templates, series and reference work.
 *
 * Key rule this module enforces: presenting directions, plan items and early units together is a
 * layout decision, never a confirmation decision. Each of them keeps its own object, its own
 * version and its own confirmation scope, and "I like this whole block" may only narrow to the
 * parts the user actually named (C13 card §4.2, CT-03 §4).
 *
 * A plan item's three states are C10's, not a second enum: `undecided`, `decided`, `ai-allowed`.
 * Only the user can decide; AI may be granted autonomy for a named scope, and autonomy is not a
 * confirmation of how the work looks.
 *
 * @module orchestration/direction
 */

import { Clock, ConflictError, ValidationError } from '../base/index.js'
import { PlanItemState, assertProductionGate } from '../core/project/schema.js'
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

/** Live state of one direction proposal. Superseded versions stay readable. */
export const DirectionState = Object.freeze({
  OPEN: 'open',
  CHOSEN: 'chosen',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
})

/** Plan item kinds. `KEY_PLAN_ITEM_KINDS` (C10) marks the ones that block full production. */
export const PlanItemKind = Object.freeze({
  CORE_GOAL: 'core-goal',
  STRUCTURE: 'structure',
  DELIVERY_SPEC: 'delivery-spec',
  RIGHTS: 'rights',
  CONTENT: 'content',
  COPY: 'copy',
  SHOT: 'shot',
  VISUAL: 'visual',
  SOUND: 'sound',
  MATERIAL: 'material',
  TOOL: 'tool',
  CHECK: 'check',
  AUTHORIZATION: 'authorization',
})

/** Kinds that must be decided (or explicitly delegated) before full production (§4.2). */
export const BLOCKING_PLAN_ITEM_KINDS = Object.freeze(['core-goal', 'structure', 'delivery-spec', 'rights', 'authorization'])

/** Who may change what. AI decisions are recorded as proposals unless autonomy was granted. */
export const ChangeActor = Object.freeze({ USER: 'user', AI: 'ai', SYSTEM: 'system' })

/** Who declared a template's fixed/variable boundary. */
export const TemplateDeclaredBy = Object.freeze({ USER: 'user', DEVELOPER: 'developer' })

/** Where a series update stands. It is never applied on its own. */
export const SeriesUpdateStatus = Object.freeze({
  PENDING: 'pending-user-adoption',
  ADOPTED: 'adopted',
  DISMISSED: 'dismissed',
})

/** Aspects a reference remake may copy. Anything outside the named set is out of scope. */
export const ReferenceAspect = Object.freeze({
  CONTENT: 'content',
  NARRATIVE: 'narrative',
  VISUAL: 'visual',
  SHOT: 'shot',
  SOUND: 'sound',
  MATERIAL: 'material',
})

/** What this module can and cannot claim. */
export const DIRECTION_CAPABILITIES = Object.freeze({
  directions: {
    supported: ['实质路线／体验／精彩点／取舍／证据／未知', '改版保留旧版本', '组合形成带新元素的新候选'],
    limits: ['组合不会把多个未检查结果拼成一个确认', 'AI 提议不会被记成用户选择'],
  },
  baseline: {
    supported: ['方案项三态门禁', '基线变化保留旧确认并给出重核范围'],
    limits: ['只有用户能决定方案项', 'AI 自主只作用于明确范围，不等于外观确认'],
  },
  template: {
    supported: ['固定／可变边界由用户或开发者声明', '适配生成候选单元'],
    limits: ['适配结果是候选，应用不等于效果确认', '固定槽位不允许 AI 改写'],
  },
  series: {
    supported: ['共享更新形成新版本并等待采用', '按项目与范围选择采用'],
    limits: ['不静默覆盖单集', '采用记录不修改其他项目的文件'],
  },
  referenceScope: {
    supported: ['按内容／叙事／视觉／镜头／声音／素材分别授权', '排除项与权利单独记录'],
    limits: ['授权不等于可复制或可分发', '范围外分析会被拒绝，而不是尽量靠拢'],
  },
})

/**
 * @param {any} value
 * @returns {any}
 */
function emptyDirections(projectId) {
  return { kind: ORCH_DOCUMENT.direction.kind, version: 1, projectId, directions: [], journal: [] }
}

/**
 * @param {any} value
 * @returns {any}
 */
function emptyBaseline(projectId) {
  return {
    kind: ORCH_DOCUMENT.plan.kind,
    version: 1,
    projectId,
    baselineVersion: 0,
    items: [],
    revisions: [],
    templateId: null,
    journal: [],
  }
}

/**
 * Direction proposals for one project.
 */
export class DirectionSet {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.direction, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => emptyDirections(this.projectId))
  }

  /** @returns {any[]} live directions, newest version of each, superseded versions excluded */
  list() {
    return copy(this.load().value.directions)
  }

  /**
   * Add one substantive proposal.
   *
   * `route` and `experience` are required because a direction without a route is a mood, and the
   * card forbids selling a mood as a plan (C13 §4.2 "实质路线、体验、精彩点、取舍、证据和未知").
   *
   * @param {object} input
   * @param {string} input.title
   * @param {string} input.route
   * @param {string} input.experience
   * @param {string[]} [input.highlights]
   * @param {string[]} [input.tradeoffs]
   * @param {string[]} [input.evidenceRefs]
   * @param {string[]} [input.unknowns]
   * @param {string} [input.proposedBy]
   * @returns {{ direction: any, revision: string }}
   */
  addProposal(input = {}) {
    const title = requireText(input.title, 'title', 200)
    const route = requireText(input.route, 'route', 4000)
    const experience = requireText(input.experience, 'experience', 2000)
    const { value, revision } = this.load()
    const now = this.clock.iso()
    const direction = {
      directionId: orchestrationId('direction', `${this.projectId}:${value.directions.length}:${title}`),
      version: 1,
      state: DirectionState.OPEN,
      title,
      route,
      experience,
      highlights: requireTextList(input.highlights, 'highlights', 16),
      tradeoffs: requireTextList(input.tradeoffs, 'tradeoffs', 16),
      evidenceRefs: requireTextList(input.evidenceRefs, 'evidenceRefs', 32),
      unknowns: requireTextList(input.unknowns, 'unknowns', 32),
      proposedBy: optionalText(input.proposedBy, 'proposedBy', 60) ?? 'ai',
      createdAt: now,
      updatedAt: now,
      history: [],
      combination: null,
      supersededBy: null,
    }
    value.directions.push(direction)
    value.journal = appendJournal(value.journal, { action: 'direction-added', directionId: direction.directionId, at: now })
    const written = this.document.write(value, revision)
    return { direction: copy(direction), revision: written.revision }
  }

  /**
   * Revise a direction into its next version. The previous version stays in `history`.
   * @param {object} input
   * @param {string} input.directionId
   * @param {object} input.patch fields to replace (title/route/experience/highlights/tradeoffs/unknowns)
   * @param {string} input.reason why the direction changed
   * @returns {{ direction: any, revision: string }}
   */
  revise(input = {}) {
    const directionId = requireText(input.directionId, 'directionId', 120)
    const reason = requireText(input.reason, 'reason', 500)
    const { value, revision } = this.load()
    const direction = value.directions.find((item) => item.directionId === directionId)
    if (direction === undefined) throw new ValidationError('方向不存在', { field: 'directionId', directionId })
    if (direction.state === DirectionState.SUPERSEDED) {
      throw new ConflictError('已被替代的方向不能再改，请基于最新方向改版', { directionId })
    }
    const now = this.clock.iso()
    direction.history = [
      ...direction.history,
      {
        version: direction.version,
        at: now,
        title: direction.title,
        route: direction.route,
        experience: direction.experience,
        highlights: direction.highlights,
        tradeoffs: direction.tradeoffs,
        unknowns: direction.unknowns,
        reason,
      },
    ]
    if (input.patch?.title !== undefined) direction.title = requireText(input.patch.title, 'title', 200)
    if (input.patch?.route !== undefined) direction.route = requireText(input.patch.route, 'route', 4000)
    if (input.patch?.experience !== undefined) direction.experience = requireText(input.patch.experience, 'experience', 2000)
    if (input.patch?.highlights !== undefined) direction.highlights = requireTextList(input.patch.highlights, 'highlights', 16)
    if (input.patch?.tradeoffs !== undefined) direction.tradeoffs = requireTextList(input.patch.tradeoffs, 'tradeoffs', 16)
    if (input.patch?.unknowns !== undefined) direction.unknowns = requireTextList(input.patch.unknowns, 'unknowns', 32)
    direction.version += 1
    direction.updatedAt = now
    value.journal = appendJournal(value.journal, { action: 'direction-revised', directionId, version: direction.version, at: now })
    const written = this.document.write(value, revision)
    return { direction: copy(direction), revision: written.revision }
  }

  /**
   * Combine several directions into ONE new candidate.
   *
   * A concatenated list of names is refused: the combination must name what is genuinely new
   * about it, and it must say which parts were actually reviewed. That is the difference between
   * a real candidate and a menu of old ones with a new title (C13 §4.2).
   *
   * @param {object} input
   * @param {string[]} input.directionIds
   * @param {string} input.title
   * @param {string} input.route
   * @param {string} input.experience
   * @param {string[]} input.newElements what this combination adds that no source had
   * @param {string[]} [input.reviewedParts] which source parts were actually checked
   * @returns {{ direction: any, revision: string }}
   */
  combine(input = {}) {
    const directionIds = requireTextList(input.directionIds, 'directionIds', 8)
    if (directionIds.length < 2) throw new ValidationError('组合至少需要两个方向', { field: 'directionIds' })
    const newElements = requireTextList(input.newElements, 'newElements', 16)
    if (newElements.length === 0) {
      throw new ValidationError('组合必须说明真实新增的元素，不能只拼接名称', {
        field: 'newElements',
        action: '写出组合后确实新出现的路线、体验或取舍',
      })
    }
    const reviewedParts = requireTextList(input.reviewedParts, 'reviewedParts', 16)
    const { value, revision } = this.load()
    const sources = []
    for (const id of directionIds) {
      const source = value.directions.find((item) => item.directionId === id)
      if (source === undefined) throw new ValidationError('组合引用的方向不存在', { field: 'directionIds', directionId: id })
      sources.push(source)
    }
    const title = requireText(input.title, 'title', 200)
    const now = this.clock.iso()
    const direction = {
      directionId: orchestrationId('direction', `${this.projectId}:${value.directions.length}:${title}`),
      version: 1,
      state: DirectionState.OPEN,
      title,
      route: requireText(input.route, 'route', 4000),
      experience: requireText(input.experience, 'experience', 2000),
      highlights: requireTextList(input.highlights, 'highlights', 16),
      tradeoffs: requireTextList(input.tradeoffs, 'tradeoffs', 16),
      evidenceRefs: [],
      unknowns: requireTextList(input.unknowns, 'unknowns', 32),
      proposedBy: optionalText(input.proposedBy, 'proposedBy', 60) ?? 'ai',
      createdAt: now,
      updatedAt: now,
      history: [],
      // The source versions are pinned, so a later revision of a source does not silently change
      // what this candidate was built from.
      combination: {
        sources: sources.map((source) => ({
          directionId: source.directionId,
          version: source.version,
          title: source.title,
        })),
        newElements,
        reviewedParts,
      },
      supersededBy: null,
    }
    value.directions.push(direction)
    value.journal = appendJournal(value.journal, {
      action: 'direction-combined',
      directionId: direction.directionId,
      sources: directionIds,
      at: now,
    })
    const written = this.document.write(value, revision)
    return { direction: copy(direction), revision: written.revision }
  }

  /**
   * Record that the user chose one direction. The choice itself is a C10 confirmation record;
   * this only moves the local state so the surface can show what is live.
   * @param {object} input
   * @param {string} input.directionId
   * @param {string} [input.confirmationRef]
   * @returns {{ direction: any, revision: string }}
   */
  markChosen(input = {}) {
    const directionId = requireText(input.directionId, 'directionId', 120)
    const confirmationRef = requireText(input.confirmationRef, 'confirmationRef', 120)
    const { value, revision } = this.load()
    const direction = value.directions.find((item) => item.directionId === directionId)
    if (direction === undefined) throw new ValidationError('方向不存在', { field: 'directionId', directionId })
    const now = this.clock.iso()
    for (const other of value.directions) {
      if (other.directionId !== directionId && other.state === DirectionState.CHOSEN) {
        other.state = DirectionState.SUPERSEDED
        other.supersededBy = directionId
      }
    }
    direction.state = DirectionState.CHOSEN
    direction.chosenBy = confirmationRef
    direction.updatedAt = now
    value.journal = appendJournal(value.journal, { action: 'direction-chosen', directionId, confirmationRef, at: now })
    const written = this.document.write(value, revision)
    return { direction: copy(direction), revision: written.revision }
  }

  /**
   * Propose a direction confirmation through C10's decision log.
   *
   * The proposal is not a confirmation: C10 refuses to store "user confirmed" from any actor but
   * the user, and that refusal is the point.
   *
   * @param {object} input
   * @param {any} input.decisionLog C10 decision log
   * @param {string} input.directionId
   * @param {string} input.versionId a real C10 version id
   * @param {string} [input.rationale]
   * @returns {any} the stored proposal
   */
  proposeConfirmation(input = {}) {
    const directionId = requireText(input.directionId, 'directionId', 120)
    const direction = this.load().value.directions.find((item) => item.directionId === directionId)
    if (direction === undefined) throw new ValidationError('方向不存在', { field: 'directionId', directionId })
    return input.decisionLog.proposeConfirmation({
      actor: 'ai',
      objectId: directionId,
      aspect: 'direction',
      scope: 'part',
      versionId: input.versionId,
      proposedState: 'confirmed',
      rationale: optionalText(input.rationale, 'rationale', 1000) ?? `方向「${direction.title}」等待你确认`,
    })
  }
}

/**
 * Plan baseline: the item set, its three states, and what a change forces to be re-checked.
 */
export class PlanBaseline {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.plan, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => emptyBaseline(this.projectId))
  }

  /** @returns {any} */
  read() {
    return this.load().value
  }

  /**
   * Add one plan item.
   * @param {object} input
   * @param {string} input.kind one of {@link PlanItemKind}
   * @param {string} input.title
   * @param {string} [input.detail]
   * @param {string} [input.state] one of C10 `PlanItemState`
   * @returns {{ item: any, revision: string }}
   */
  addItem(input = {}) {
    const kind = requireOneOf(input.kind, PlanItemKind, 'kind')
    const title = requireText(input.title, 'title', 300)
    const state = input.state === undefined ? PlanItemState.UNDECIDED : requireOneOf(input.state, PlanItemState, 'state')
    if (state === PlanItemState.DECIDED) {
      throw new ValidationError('方案项不能以“已定”状态新建；已定只能来自用户回答', { field: 'state' })
    }
    const { value, revision } = this.load()
    const now = this.clock.iso()
    const item = {
      itemId: orchestrationId('planItem', `${this.projectId}:${value.items.length}:${kind}:${title}`),
      kind,
      title,
      detail: optionalText(input.detail, 'detail', 4000),
      state,
      blocking: BLOCKING_PLAN_ITEM_KINDS.includes(kind),
      createdAt: now,
      updatedAt: now,
      stateHistory: [],
      autonomy: null,
    }
    value.items.push(item)
    value.journal = appendJournal(value.journal, { action: 'plan-item-added', itemId: item.itemId, kind, at: now })
    const written = this.document.write(value, revision)
    return { item: copy(item), revision: written.revision }
  }

  /**
   * Change one item's state. Only the user may decide; AI autonomy needs an explicit grant.
   * @param {object} input
   * @param {string} input.itemId
   * @param {string} input.state
   * @param {string} input.actor one of {@link ChangeActor}
   * @param {string} [input.reason]
   * @param {string} [input.authorizationRef] required when AI sets `ai-allowed`
   * @returns {{ item: any, revision: string }}
   */
  setItemState(input = {}) {
    const itemId = requireText(input.itemId, 'itemId', 120)
    const state = requireOneOf(input.state, PlanItemState, 'state')
    const actor = requireOneOf(input.actor, ChangeActor, 'actor')
    if (state === PlanItemState.DECIDED && actor !== ChangeActor.USER) {
      throw new ValidationError('只有用户能决定方案项；AI 请改为 ai-allowed 或等待回答', {
        field: 'actor',
        action: 'AI 不能生成用户已定状态',
      })
    }
    const { value, revision } = this.load()
    const item = value.items.find((entry) => entry.itemId === itemId)
    if (item === undefined) throw new ValidationError('方案项不存在', { field: 'itemId', itemId })
    if (state === PlanItemState.AI_ALLOWED) {
      const authorizationRef = requireText(input.authorizationRef, 'authorizationRef', 120)
      item.autonomy = {
        authorizationRef,
        grantedAt: this.clock.iso(),
        reason: optionalText(input.reason, 'reason', 500),
      }
    }
    const now = this.clock.iso()
    item.stateHistory = [
      ...item.stateHistory,
      { at: now, state: item.state, actor, reason: optionalText(input.reason, 'reason', 500) },
    ].slice(-20)
    item.state = state
    item.updatedAt = now
    value.journal = appendJournal(value.journal, { action: 'plan-item-state', itemId, state, actor, at: now })
    const written = this.document.write(value, revision)
    return { item: copy(item), revision: written.revision }
  }

  /**
   * The full-production gate: key items decided or delegated, plus a real authorization item.
   * @returns {{ ok: boolean, blockers: any[], gate: any }}
   */
  gate() {
    const value = this.read()
    const blockers = []
    for (const item of value.items) {
      if (item.blocking && item.state === PlanItemState.UNDECIDED) {
        blockers.push({ itemId: item.itemId, kind: item.kind, title: item.title, reason: '关键项未定' })
      }
      if (item.kind === PlanItemKind.AUTHORIZATION && item.state === PlanItemState.UNDECIDED) {
        blockers.push({ itemId: item.itemId, kind: item.kind, title: item.title, reason: '制作授权未定' })
      }
    }
    const hasAuthorization = value.items.some((item) => item.kind === PlanItemKind.AUTHORIZATION)
    if (!hasAuthorization) blockers.push({ itemId: null, kind: PlanItemKind.AUTHORIZATION, title: '制作授权', reason: '方案缺少授权项' })
    // C10's gate runs too, on the shape it was written for, so C13 cannot drift from C10.
    const c10 = assertProductionGate({
      items: value.items.map((item) => ({ id: item.itemId, kind: item.kind, state: item.state })),
    })
    for (const id of c10.undecided ?? []) {
      if (!blockers.some((blocker) => blocker.itemId === id)) {
        blockers.push({ itemId: id, kind: null, title: null, reason: 'C10 制作门判定未定' })
      }
    }
    return { ok: blockers.length === 0, blockers, gate: c10 }
  }

  /**
   * Revise the baseline. Old confirmations are kept and the changed scope is declared stale.
   *
   * @param {object} input
   * @param {Array<{itemId: string, patch: object}>} input.changes
   * @param {string} input.reason
   * @param {any} [input.decisionLog] C10 decision log, to mark old confirmations as changed
   * @param {string[]} [input.confirmedAspects] which C10 aspects previously confirmed
   * @returns {{ baselineVersion: number, recheckScope: string[], keptConfirmations: number }}
   */
  revise(input = {}) {
    const changes = Array.isArray(input.changes) ? input.changes : []
    if (changes.length === 0) throw new ValidationError('基线变化需要至少一项改动', { field: 'changes' })
    const reason = requireText(input.reason, 'reason', 1000)
    const { value, revision } = this.load()
    const now = this.clock.iso()
    const recheckScope = []
    for (const change of changes) {
      const itemId = requireText(change?.itemId, 'changes[].itemId', 120)
      const item = value.items.find((entry) => entry.itemId === itemId)
      if (item === undefined) throw new ValidationError('基线变化引用了不存在的方案项', { field: 'itemId', itemId })
      const before = { title: item.title, detail: item.detail, state: item.state }
      if (change.patch?.title !== undefined) item.title = requireText(change.patch.title, 'title', 300)
      if (change.patch?.detail !== undefined) item.detail = optionalText(change.patch.detail, 'detail', 4000)
      if (change.patch?.state !== undefined) {
        const next = requireOneOf(change.patch.state, PlanItemState, 'state')
        if (next === PlanItemState.DECIDED && change.actor !== ChangeActor.USER) {
          throw new ValidationError('基线变化不能代替用户决定方案项', { field: 'changes[].state', itemId })
        }
        item.state = next
      }
      item.updatedAt = now
      // A DECIDED item that changed content no longer matches the user's answer.
      if (before.state === PlanItemState.DECIDED && (item.title !== before.title || item.detail !== before.detail)) {
        item.state = PlanItemState.UNDECIDED
        item.stateHistory = [
          ...item.stateHistory,
          {
            at: now,
            state: PlanItemState.UNDECIDED,
            actor: ChangeActor.SYSTEM,
            reason: '基线变化后需要重新确认',
          },
        ]
      }
      recheckScope.push(itemId)
    }
    value.baselineVersion += 1
    value.revisions = [
      ...value.revisions,
      { baselineVersion: value.baselineVersion, at: now, reason, changedItemIds: recheckScope },
    ].slice(-40)
    value.journal = appendJournal(value.journal, {
      action: 'baseline-revised',
      baselineVersion: value.baselineVersion,
      changedItemIds: recheckScope,
      at: now,
    })
    const written = this.document.write(value, revision)

    // Old confirmations stay in C10's log; what changes is their standing. Marking is best-effort
    // per aspect because a caller may not know which aspects were confirmed.
    let keptConfirmations = 0
    if (input.decisionLog !== undefined && Array.isArray(input.confirmedAspects)) {
      for (const aspect of input.confirmedAspects) {
        for (const itemId of recheckScope) {
          const changed = input.decisionLog.markChangedAfterConfirmation({
            objectId: itemId,
            aspect,
            reason: `基线第 ${value.baselineVersion} 版修改了该方案项`,
          })
          if (changed !== null) keptConfirmations += 1
        }
      }
    }
    return {
      baselineVersion: value.baselineVersion,
      recheckScope,
      keptConfirmations,
      revision: written.revision,
    }
  }

  /**
   * Bind a template whose fixed/variable boundary the user or the developer declared.
   * @param {object} input
   * @param {string} input.templateId
   * @param {string} input.declaredBy one of {@link TemplateDeclaredBy}
   * @param {string[]} input.fixedSlots
   * @param {string[]} input.variableSlots
   * @param {string} [input.source]
   * @returns {{ template: any, revision: string }}
   */
  bindTemplate(input = {}) {
    const templateId = requireText(input.templateId, 'templateId', 120)
    const declaredBy = requireOneOf(input.declaredBy, TemplateDeclaredBy, 'declaredBy')
    const fixedSlots = requireTextList(input.fixedSlots, 'fixedSlots', 64)
    const variableSlots = requireTextList(input.variableSlots, 'variableSlots', 64)
    if (fixedSlots.length === 0) throw new ValidationError('模板必须声明至少一个固定槽位', { field: 'fixedSlots' })
    const overlap = fixedSlots.filter((slot) => variableSlots.includes(slot))
    if (overlap.length > 0) {
      throw new ValidationError('同一槽位不能既固定又可变', { field: 'fixedSlots', overlap })
    }
    const { value, revision } = this.load()
    const now = this.clock.iso()
    value.templateId = templateId
    value.template = {
      templateId,
      declaredBy,
      fixedSlots,
      variableSlots,
      source: optionalText(input.source, 'source', 500),
      boundAt: now,
      // Inheriting a template adapts this episode; it is not evidence the result looks right.
      appliedAsCandidate: true,
    }
    value.journal = appendJournal(value.journal, { action: 'template-bound', templateId, declaredBy, at: now })
    const written = this.document.write(value, revision)
    return { template: copy(value.template), revision: written.revision }
  }

  /**
   * Adapt the bound template. Fixed slots are refused, and the result is a candidate.
   * @param {object} input
   * @param {Array<{slot: string, value: string}>} input.adaptations
   * @returns {{ adapted: any[], templateId: string, confirmed: boolean }}
   */
  adaptTemplate(input = {}) {
    const value = this.read()
    if (value.template === undefined || value.template === null) {
      throw new ConflictError('没有已绑定模板，不能适配', { action: '先绑定模板与固定／可变边界' })
    }
    const adaptations = Array.isArray(input.adaptations) ? input.adaptations : []
    if (adaptations.length === 0) throw new ValidationError('模板适配需要至少一项实际适配', { field: 'adaptations' })
    const fixed = new Set(value.template.fixedSlots)
    const adapted = []
    for (const entry of adaptations) {
      const slot = requireText(entry?.slot, 'adaptations[].slot', 200)
      if (fixed.has(slot)) {
        throw new ValidationError('固定槽位不允许适配', { field: 'slot', slot, action: '固定内容由模板声明者决定' })
      }
      if (!value.template.variableSlots.includes(slot)) {
        throw new ValidationError('槽位不在模板声明的可变范围内', { field: 'slot', slot })
      }
      adapted.push({ slot, value: requireText(entry?.value, 'adaptations[].value', 2000) })
    }
    return {
      templateId: value.template.templateId,
      adapted,
      // Two honest flags: the episode really was adapted, and nobody has confirmed the look.
      adaptedThisEpisode: true,
      appliedAsCandidate: true,
      confirmed: false,
    }
  }
}

/**
 * Series sharing: a shared change becomes a version that each episode adopts explicitly.
 */
export class SeriesShares {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths` of the episode that proposes the change
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.series, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => ({
      kind: ORCH_DOCUMENT.series.kind,
      version: 1,
      projectId: this.projectId,
      seriesId: null,
      updates: [],
    }))
  }

  /**
   * Propose a shared update. It never applies itself to any episode.
   * @param {object} input
   * @param {string} input.seriesId
   * @param {string} input.summary
   * @param {string[]} input.changes
   * @returns {{ update: any, revision: string }}
   */
  proposeUpdate(input = {}) {
    const seriesId = requireText(input.seriesId, 'seriesId', 120)
    const summary = requireText(input.summary, 'summary', 1000)
    const changes = requireTextList(input.changes, 'changes', 32)
    if (changes.length === 0) throw new ValidationError('系列更新需要至少一项变化', { field: 'changes' })
    const { value, revision } = this.load()
    const now = this.clock.iso()
    const update = {
      updateId: orchestrationId('seriesUpdate', `${seriesId}:${value.updates.length}:${summary}`),
      seriesId,
      version: value.updates.filter((entry) => entry.seriesId === seriesId).length + 1,
      summary,
      changes,
      status: SeriesUpdateStatus.PENDING,
      proposedAt: now,
      proposedByProject: this.projectId,
      adoptions: [],
      // Explicit: nothing was written into another project.
      appliedAutomatically: false,
    }
    value.updates.push(update)
    value.seriesId = seriesId
    const written = this.document.write(value, revision)
    return { update: copy(update), revision: written.revision }
  }

  /**
   * Record the user's adoption of one update for named projects and a named scope.
   * @param {object} input
   * @param {string} input.updateId
   * @param {string[]} input.projectIds
   * @param {string} input.scope
   * @param {string} input.authorizationRef
   * @returns {{ update: any, revision: string }}
   */
  adoptUpdate(input = {}) {
    const updateId = requireText(input.updateId, 'updateId', 120)
    const projectIds = requireTextList(input.projectIds, 'projectIds', 32)
    const scope = requireText(input.scope, 'scope', 500)
    const authorizationRef = requireText(input.authorizationRef, 'authorizationRef', 120)
    if (projectIds.length === 0) throw new ValidationError('采用系列更新需要明确项目范围', { field: 'projectIds' })
    const { value, revision } = this.load()
    const update = value.updates.find((entry) => entry.updateId === updateId)
    if (update === undefined) throw new ValidationError('系列更新不存在', { field: 'updateId', updateId })
    update.adoptions.push({
      projectIds,
      scope,
      authorizationRef,
      at: this.clock.iso(),
      adoptedBy: 'user',
    })
    update.status = SeriesUpdateStatus.ADOPTED
    const written = this.document.write(value, revision)
    return { update: copy(update), revision: written.revision }
  }

  /**
   * Guard used before any series change reaches an episode: adoption must exist for that project.
   * @param {string} updateId
   * @param {string} projectId
   * @returns {any} the matching adoption
   */
  assertAdopted(updateId, projectId) {
    const update = this.load().value.updates.find((entry) => entry.updateId === updateId)
    if (update === undefined) throw new ValidationError('系列更新不存在', { field: 'updateId', updateId })
    const adoption = update.adoptions.find((entry) => entry.projectIds.includes(projectId))
    if (adoption === undefined) {
      throw new ConflictError('该集没有采用这次系列更新，不能静默套用', { updateId, projectId })
    }
    return copy(adoption)
  }
}

/**
 * Reference remake scope: what may be copied, from which source, under which rights.
 */
export class ReferenceScopes {
  /**
   * @param {object} input
   * @param {any} input.paths C10 `ProjectPaths`
   * @param {any} [input.clock]
   */
  constructor(input) {
    this.paths = input.paths
    this.projectId = input.paths.projectId
    this.clock = input.clock ?? new Clock()
    this.document = new OrchestrationDocument({ paths: input.paths, spec: ORCH_DOCUMENT.reference, clock: this.clock })
  }

  /** @returns {{ value: any, revision: string|null }} */
  load() {
    return this.document.readOrCreate(() => ({
      kind: ORCH_DOCUMENT.reference.kind,
      version: 1,
      projectId: this.projectId,
      scopes: [],
    }))
  }

  /**
   * Declare one reference and the aspects the user asked to reproduce.
   * @param {object} input
   * @param {string} input.source how the reference is identified
   * @param {string} input.rights what may be done with it
   * @param {string[]} input.aspects subset of {@link ReferenceAspect}
   * @param {string[]} [input.excluded] aspects explicitly excluded
   * @returns {{ scope: any, revision: string }}
   */
  defineScope(input = {}) {
    const source = requireText(input.source, 'source', 1000)
    const rights = requireText(input.rights, 'rights', 1000)
    const aspects = requireTextList(input.aspects, 'aspects', 8)
    if (aspects.length === 0) throw new ValidationError('参考复刻需要明确复刻范围', { field: 'aspects' })
    for (const aspect of aspects) requireOneOf(aspect, ReferenceAspect, 'aspects[]')
    const excluded = requireTextList(input.excluded, 'excluded', 8)
    const overlap = aspects.filter((aspect) => excluded.includes(aspect))
    if (overlap.length > 0) throw new ValidationError('同一方面不能既在范围内又被排除', { field: 'excluded', overlap })
    const { value, revision } = this.load()
    const scope = {
      scopeId: orchestrationId('referenceScope', `${this.projectId}:${value.scopes.length}:${source}`),
      source,
      rights,
      aspects,
      excluded,
      createdBy: optionalText(input.createdBy, 'createdBy', 60) ?? 'user',
      createdAt: this.clock.iso(),
      // Analysis must exist before production; this flag records that it does not yet.
      analysisRequired: true,
      analysisRef: null,
      outOfScopeUsed: false,
    }
    value.scopes.push(scope)
    const written = this.document.write(value, revision)
    return { scope: copy(scope), revision: written.revision }
  }

  /**
   * Whether one aspect may be used. Out-of-scope use is refused, not merely warned about.
   * @param {string} scopeId
   * @param {string} aspect
   * @returns {boolean}
   */
  allows(scopeId, aspect) {
    requireOneOf(aspect, ReferenceAspect, 'aspect')
    const scope = this.load().value.scopes.find((entry) => entry.scopeId === scopeId)
    if (scope === undefined) throw new ValidationError('参考范围不存在', { field: 'scopeId', scopeId })
    return scope.aspects.includes(aspect) && !scope.excluded.includes(aspect)
  }

  /**
   * Assert one aspect is inside the declared scope.
   * @param {string} scopeId
   * @param {string} aspect
   * @returns {any} the scope
   */
  assertAllows(scopeId, aspect) {
    if (!this.allows(scopeId, aspect)) {
      throw new ConflictError('该方面不在用户授权的参考复刻范围内', {
        scopeId,
        aspect,
        action: '需要用户明确扩大范围，不能自动外推',
      })
    }
    return copy(this.load().value.scopes.find((entry) => entry.scopeId === scopeId))
  }

  /**
   * Attach the reference analysis to a scope, which unblocks production for it.
   * @param {string} scopeId
   * @param {string} analysisRef
   * @returns {{ scope: any, revision: string }}
   */
  attachAnalysis(scopeId, analysisRef) {
    const reference = requireText(analysisRef, 'analysisRef', 120)
    const { value, revision } = this.load()
    const scope = value.scopes.find((entry) => entry.scopeId === scopeId)
    if (scope === undefined) throw new ValidationError('参考范围不存在', { field: 'scopeId', scopeId })
    scope.analysisRef = reference
    scope.analysisRequired = false
    const written = this.document.write(value, revision)
    return { scope: copy(scope), revision: written.revision }
  }
}
