/**
 * Tests for core/project/decisions.js: confirmations, decisions and authorizations.
 *
 * Every rule asserted here is a product rule from CT-03 §4 / C10 §4.2 that must be enforced in
 * code: only the user can confirm, an AI proposal never satisfies a confirmation query, silence
 * reads as undecided, `ai-allowed` never reads as confirmed, superseding keeps history, a `once`
 * authorization refuses a second use, and an undecided key plan item blocks full production.
 *
 * The filesystem is real: the records are written through `store.js` into a managed temp project
 * directory, then re-read from a NEW log instance so persistence is proven, not assumed.
 *
 * @module tests/unit/project-decisions.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createTempDir } from '../../base/tempdir.js'
import { Clock, ConflictError, ValidationError } from '../../base/index.js'
import { newId } from '../../core/project/ids.js'
import { ProjectPaths, PROJECT_LAYOUT } from '../../core/project/paths.js'
import { tryReadDocument, writeDocument } from '../../core/project/store.js'
import { readEvents } from '../../core/project/events.js'
import { assertProductionGate, ConfirmAspect, ConfirmScope, ConfirmationState } from '../../core/project/schema.js'
import { createDecisionLog } from '../../core/project/decisions.js'

const temp = createTempDir({ label: 'decisions' })
test.after(() => {
  temp.dispose()
})

/**
 * A fresh, isolated project inside the managed temp dir.
 * @param {string} label
 * @returns {{ paths: ProjectPaths, log: ReturnType<typeof createDecisionLog>, clock: Clock }}
 */
function newProject(label) {
  const projectId = newId('project')
  const root = temp.dir(`projects-${label}`)
  const clock = new Clock({ mode: 'manual', start: Date.UTC(2026, 0, 1, 0, 0, 0), stepMs: 1000 })
  const paths = new ProjectPaths(root, projectId)
  fs.mkdirSync(paths.dir, { recursive: true })
  const log = createDecisionLog({ paths, clock })
  return { paths, log, clock }
}

/** A fresh log over the same project, to prove persistence instead of in-memory state. */
function reload(paths, clock) {
  return createDecisionLog({ paths, clock })
}

/** A syntactically valid version id for binding a confirmation. */
function versionId() {
  return newId('version')
}

test('decisions: an AI caller cannot create a user confirmation', () => {
  const { log } = newProject('ai-confirm')
  assert.throws(
    () =>
      log.recordConfirmation({
        actor: 'ai',
        objectId: 'object-1',
        aspect: ConfirmAspect.INITIAL_CUT,
        scope: ConfirmScope.WHOLE,
        versionId: versionId(),
        state: ConfirmationState.CONFIRMED,
        humanResponse: 'AI 认为可以',
      }),
    (error) => {
      assert.ok(error instanceof ValidationError)
      assert.equal(error.code, 'VALIDATION_FAILED')
      assert.match(error.message, /只有用户本人的回答/)
      return true
    },
  )
  // Nothing was written, so the object still reads undecided.
  assert.equal(log.listConfirmations().length, 0)
  assert.equal(log.isConfirmed('object-1', ConfirmAspect.INITIAL_CUT), false)
})

test('decisions: a user confirmation is stored with object + aspect + scope + version', () => {
  const { paths, log, clock } = newProject('user-confirm')
  const objectId = 'unit-scene-01'
  const version = versionId()
  const saved = log.recordConfirmation({
    actor: 'user',
    objectId,
    aspect: ConfirmAspect.MATERIAL_USE,
    scope: ConfirmScope.PART,
    versionId: version,
    state: ConfirmationState.CONFIRMED,
    humanResponse: '这张图只用在开场 3 秒，可以。',
    evidenceRefs: ['evidence/approval-01.json'],
  })
  assert.match(saved.confirmationId, /^cnf_/)
  assert.equal(saved.projectId, paths.projectId)
  assert.equal(saved.objectId, objectId)
  assert.equal(saved.aspect, ConfirmAspect.MATERIAL_USE)
  assert.equal(saved.scope, ConfirmScope.PART)
  assert.equal(saved.versionId, version)
  assert.equal(saved.state, ConfirmationState.CONFIRMED)
  assert.equal(saved.humanResponse, '这张图只用在开场 3 秒，可以。')
  assert.deepEqual(saved.evidenceRefs, ['evidence/approval-01.json'])
  assert.equal(typeof saved.respondedAt, 'string')

  // Queryable per object/aspect, and durable across a fresh instance reading from disk.
  const reopened = reload(paths, clock)
  assert.equal(reopened.isConfirmed(objectId, ConfirmAspect.MATERIAL_USE), true)
  assert.equal(reopened.isConfirmed(objectId, ConfirmAspect.PLAN), false)
  assert.equal(reopened.isConfirmed(objectId, ConfirmAspect.MATERIAL_USE, { versionId: version }), true)
  assert.equal(reopened.isConfirmed(objectId, ConfirmAspect.MATERIAL_USE, { versionId: versionId() }), false)
  const confirmed = reopened.listConfirmed({ objectId })
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].confirmationId, saved.confirmationId)
  assert.equal(reopened.confirmationStateOf(objectId, ConfirmAspect.MATERIAL_USE), ConfirmationState.CONFIRMED)
})

test('decisions: silence and an unknown aspect read as undecided', () => {
  const { log } = newProject('silence')
  const state = log.confirmationStateOf('never-discussed', ConfirmAspect.DIRECTION)
  assert.equal(state, ConfirmationState.UNDECIDED)
  assert.equal(log.isConfirmed('never-discussed', ConfirmAspect.DIRECTION), false)
  assert.deepEqual(log.listConfirmed(), [])
  const detail = log.getObjectState('never-discussed', ConfirmAspect.DIRECTION)
  assert.equal(detail.state, ConfirmationState.UNDECIDED)
  assert.equal(detail.confirmationId, null)
})

test('decisions: ai-allowed is a user grant but never reads as confirmed', () => {
  const { paths, log, clock } = newProject('ai-allowed')
  const objectId = 'direction-main'
  const version = versionId()
  const state = log.delegateToAi({
    objectId,
    aspect: ConfirmAspect.DIRECTION,
    scope: ConfirmScope.WHOLE,
    versionId: version,
    humanResponse: '方向你自己定，不用再问我。',
  })
  assert.equal(state.state, ConfirmationState.AI_ALLOWED)
  assert.equal(log.isConfirmed(objectId, ConfirmAspect.DIRECTION), false)
  assert.deepEqual(log.listConfirmed(), [])
  // The record exists as history, it is just not a confirmation.
  assert.equal(log.listConfirmations().length, 1)
  const reopened = reload(paths, clock)
  assert.equal(reopened.isConfirmed(objectId, ConfirmAspect.DIRECTION), false)
  assert.equal(reopened.confirmationStateOf(objectId, ConfirmAspect.DIRECTION), ConfirmationState.AI_ALLOWED)
})

test('decisions: an AI proposal is not a confirmation and cannot satisfy a query', () => {
  const { log } = newProject('proposal')
  const objectId = 'initial-cut-01'
  const version = versionId()
  const proposal = log.proposeConfirmation({
    objectId,
    aspect: ConfirmAspect.INITIAL_CUT,
    scope: ConfirmScope.WHOLE,
    versionId: version,
    proposedState: ConfirmationState.CONFIRMED,
    rationale: '检查项全部通过，建议确认。',
  })
  assert.equal(proposal.kind, 'confirmation-proposal')
  assert.equal(proposal.isProposal, true)
  assert.equal(proposal.isConfirmation, false)
  assert.equal(proposal.proposedBy, 'ai')
  // A proposal id is not a confirmation id, so it cannot be passed where one is required.
  assert.doesNotMatch(proposal.proposalId, /^cnf_/)

  assert.equal(log.isConfirmed(objectId, ConfirmAspect.INITIAL_CUT), false)
  assert.equal(log.confirmationStateOf(objectId, ConfirmAspect.INITIAL_CUT), ConfirmationState.UNDECIDED)
  assert.deepEqual(log.listConfirmations(), [])
  assert.deepEqual(log.listConfirmed(), [])
  assert.equal(log.listProposals({ objectId }).length, 1)

  // And a user cannot use the proposal pathway to fabricate a confirmation either.
  assert.throws(
    () =>
      log.proposeConfirmation({
        actor: 'user',
        objectId,
        aspect: ConfirmAspect.INITIAL_CUT,
        scope: ConfirmScope.WHOLE,
        versionId: version,
        proposedState: ConfirmationState.CONFIRMED,
        rationale: '想直接确认',
      }),
    ValidationError,
  )
})

test('decisions: superseding keeps the old record and marks changed-after-confirmation', () => {
  const { paths, log, clock } = newProject('supersede')
  const objectId = 'unit-02'
  const firstVersion = versionId()
  const secondVersion = versionId()
  const first = log.recordConfirmation({
    actor: 'user',
    objectId,
    aspect: ConfirmAspect.UNIT,
    scope: ConfirmScope.OBJECT,
    versionId: firstVersion,
    state: ConfirmationState.CONFIRMED,
    humanResponse: '这个单元可以。',
  })
  const second = log.recordConfirmation({
    actor: 'user',
    objectId,
    aspect: ConfirmAspect.UNIT,
    scope: ConfirmScope.OBJECT,
    versionId: secondVersion,
    state: ConfirmationState.CONFIRMED,
    humanResponse: '改过之后再确认一次，这个版本可以。',
    supersedes: first.confirmationId,
  })

  // Both records survive: history is never deleted.
  const all = log.listConfirmations({ objectId })
  assert.equal(all.length, 2)
  const oldRecord = all.find((record) => record.confirmationId === first.confirmationId)
  const newRecord = all.find((record) => record.confirmationId === second.confirmationId)
  assert.ok(oldRecord)
  assert.ok(newRecord)
  assert.equal(oldRecord.supersededBy, second.confirmationId)
  assert.equal(typeof oldRecord.supersededAt, 'string')
  assert.equal(newRecord.supersedes, first.confirmationId)

  // Only the superseding record still counts as confirmed.
  const confirmed = log.listConfirmed({ objectId })
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].confirmationId, second.confirmationId)
  assert.equal(log.isConfirmed(objectId, ConfirmAspect.UNIT), true)
  assert.equal(log.isConfirmed(objectId, ConfirmAspect.UNIT, { versionId: firstVersion }), false)

  // The prior basis is explicitly marked changed-after-confirmation.
  const state = log.getObjectState(objectId, ConfirmAspect.UNIT)
  assert.equal(state.changedAfterConfirmation.confirmationId, first.confirmationId)
  assert.equal(state.changedAfterConfirmation.reason, 'superseded-by-new-confirmation')
  assert.equal(state.history.length, 1)

  const reopened = reload(paths, clock)
  assert.equal(reopened.listConfirmations({ objectId }).length, 2)
  assert.equal(reopened.listConfirmed({ objectId }).length, 1)

  // A second supersede of an already replaced record is refused, not silently applied.
  assert.throws(
    () =>
      reopened.recordConfirmation({
        actor: 'user',
        objectId,
        aspect: ConfirmAspect.UNIT,
        scope: ConfirmScope.OBJECT,
        versionId: versionId(),
        state: ConfirmationState.CONFIRMED,
        humanResponse: '再改一次',
        supersedes: first.confirmationId,
      }),
    ConflictError,
  )
})

test('decisions: content changed after confirmation needs re-confirmation', () => {
  const { log } = newProject('changed')
  const objectId = 'unit-03'
  const version = versionId()
  log.recordConfirmation({
    actor: 'user',
    objectId,
    aspect: ConfirmAspect.OBJECT_EDIT,
    scope: ConfirmScope.OBJECT,
    versionId: version,
    state: ConfirmationState.CONFIRMED,
    humanResponse: '这个改法可以。',
  })
  assert.equal(log.isConfirmed(objectId, ConfirmAspect.OBJECT_EDIT), true)
  const changedVersion = versionId()
  const marked = log.markChangedAfterConfirmation({
    objectId,
    aspect: ConfirmAspect.OBJECT_EDIT,
    versionId: changedVersion,
    reason: '替换了背景素材',
  })
  assert.ok(marked)
  assert.equal(marked.state, ConfirmationState.CHANGED_AFTER_CONFIRMATION)
  assert.equal(log.isConfirmed(objectId, ConfirmAspect.OBJECT_EDIT), false)
  assert.deepEqual(log.listConfirmed(), [])
  // The old confirmation record is still there.
  assert.equal(log.listConfirmations({ objectId }).length, 1)
})

test('decisions: a decision is bound to object + version, and AI may only propose', () => {
  const { paths, log, clock } = newProject('decisions')
  const objectId = 'structure-main'
  const version = versionId()
  assert.throws(
    () =>
      log.recordDecision({
        actor: 'ai',
        objectId,
        aspect: ConfirmAspect.PLAN,
        scope: ConfirmScope.WHOLE,
        versionId: version,
        reason: 'AI 决定采用三幕结构',
      }),
    ValidationError,
  )
  const decision = log.recordDecision({
    actor: 'user',
    objectId,
    aspect: ConfirmAspect.PLAN,
    scope: ConfirmScope.WHOLE,
    versionId: version,
    reason: '三幕结构更清楚',
  })
  assert.match(decision.decisionId, /^dec_/)
  assert.equal(decision.actor, 'user')
  assert.equal(decision.versionId, version)
  assert.equal(decision.state, 'decided')

  const aiProposal = log.proposeDecision({
    objectId,
    aspect: ConfirmAspect.PLAN,
    scope: ConfirmScope.WHOLE,
    versionId: version,
    reason: '建议改成两幕',
    proposedState: 'decided',
  })
  assert.equal(aiProposal.kind, 'decision-proposal')
  assert.equal(aiProposal.isDecision, false)

  const reopened = reload(paths, clock)
  const decisions = reopened.listDecisions({ objectId })
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].decisionId, decision.decisionId)
  // The AI proposal is not among the recorded decisions, and it never becomes one.
  assert.ok(decisions.every((record) => record.decisionId !== aiProposal.proposalId))
})

test('decisions: an undecided key plan item blocks full production', () => {
  const { log } = newProject('gate')
  const version = versionId()
  const buildPlan = () => ({
    items: [
      { id: 'core-goal', kind: 'core-goal', state: log.getPlanItemState('core-goal', ConfirmAspect.PLAN) },
      { id: 'structure', kind: 'structure', state: log.getPlanItemState('structure', ConfirmAspect.PLAN) },
      { id: 'extra-note', kind: 'extra-note', state: log.getPlanItemState('extra-note', ConfirmAspect.PLAN) },
    ],
  })
  // Silence blocks: an undecided key item stops full production.
  assert.deepEqual(assertProductionGate(buildPlan()), { ok: false, undecided: ['core-goal', 'structure'] })

  // A partially confirmed item still blocks: a part is not the whole.
  log.recordConfirmation({
    actor: 'user',
    objectId: 'core-goal',
    aspect: ConfirmAspect.PLAN,
    scope: ConfirmScope.PART,
    versionId: version,
    state: ConfirmationState.PARTIALLY_CONFIRMED,
    humanResponse: '目标方向对，细节再定。',
  })
  assert.equal(log.getPlanItemState('core-goal', ConfirmAspect.PLAN), 'undecided')
  assert.deepEqual(assertProductionGate(buildPlan()), { ok: false, undecided: ['core-goal', 'structure'] })

  // The user deciding both key items opens the gate.
  log.recordDecision({
    actor: 'user',
    objectId: 'core-goal',
    aspect: ConfirmAspect.PLAN,
    scope: ConfirmScope.WHOLE,
    versionId: version,
    reason: '目标确定',
  })
  log.recordDecision({
    actor: 'user',
    objectId: 'structure',
    aspect: ConfirmAspect.PLAN,
    scope: ConfirmScope.WHOLE,
    versionId: version,
    reason: '结构确定',
  })
  assert.deepEqual(assertProductionGate(buildPlan()), { ok: true })

  // Delegating one key item to the AI also opens it, and is reported as ai-allowed, not as decided.
  const delegated = newProject('gate-ai')
  const delegatedVersion = versionId()
  delegated.log.delegateToAi({
    objectId: 'delivery-spec',
    aspect: ConfirmAspect.PLAN,
    scope: ConfirmScope.WHOLE,
    versionId: delegatedVersion,
    humanResponse: '交付规格你来定。',
  })
  assert.equal(delegated.log.getPlanItemState('delivery-spec', ConfirmAspect.PLAN), 'ai-allowed')
  const delegatedPlan = { items: [{ id: 'delivery-spec', kind: 'delivery-spec', state: 'ai-allowed' }] }
  assert.deepEqual(assertProductionGate(delegatedPlan), { ok: true })
})

test('decisions: an authorization must name a concrete action and scope', () => {
  const { log } = newProject('auth-shape')
  const base = {
    actor: 'user',
    target: '模型权重文件',
    projectVersion: 'v1',
    grantedBy: '可以下载这个模型。',
  }
  assert.throws(() => log.grantAuthorization({ ...base, action: '', scope: '一次下载' }), ValidationError)
  assert.throws(() => log.grantAuthorization({ ...base, action: '所有操作', scope: '一次下载' }), ValidationError)
  assert.throws(() => log.grantAuthorization({ ...base, action: '*', scope: '一次下载' }), ValidationError)
  assert.throws(() => log.grantAuthorization({ ...base, action: 'download', scope: '任何' }), ValidationError)
  assert.throws(
    () => log.grantAuthorization({ ...base, action: 'download', scope: '一次下载', grantedBy: '  ' }),
    ValidationError,
  )
  assert.deepEqual(log.listAuthorizations(), [])

  const granted = log.grantAuthorization({
    ...base,
    action: 'download-model-weights',
    scope: '一次下载，仅 1.2GB 主模型',
    dataDestination: '本机磁盘',
    fees: { amount: 0, currency: 'CNY' },
    environmentImpact: '新增约 1.2GB 磁盘占用',
  })
  assert.match(granted.authorizationId, /^aut_/)
  assert.equal(granted.validFor, 'once')
  assert.equal(granted.status, 'granted')
  assert.equal(granted.grantedBy, '可以下载这个模型。')
  assert.deepEqual(granted.fees, { amount: 0, currency: 'CNY', description: null })
})

test('decisions: AI cannot grant an authorization', () => {
  const { paths, log, clock } = newProject('auth-ai')
  assert.throws(
    () =>
      log.grantAuthorization({
        actor: 'ai',
        action: 'install-tool',
        target: 'ffmpeg',
        scope: '本机安装',
        projectVersion: 'v1',
        grantedBy: 'AI 认为需要安装',
      }),
    ValidationError,
  )
  const proposal = log.proposeAuthorization({
    action: 'install-tool',
    target: 'ffmpeg',
    scope: '本机安装',
    projectVersion: 'v1',
    rationale: '缺少编码工具',
  })
  assert.equal(proposal.kind, 'authorization-proposal')
  assert.equal(proposal.isAuthorization, false)
  // A proposal authorizes nothing: there is no usable authorization record anywhere.
  assert.deepEqual(log.listAuthorizations(), [])
  assert.equal(reload(paths, clock).listAuthorizations().length, 0)
  assert.throws(() => log.consumeAuthorization(proposal.proposalId, { action: 'install-tool' }), /授权记录不存在/)
})

test('decisions: a once authorization refuses a second use and records the refusal', () => {
  const { paths, log, clock } = newProject('auth-once')
  const granted = log.grantAuthorization({
    actor: 'user',
    action: 'upload-package',
    target: '外部服务 A',
    scope: '一次上传，仅交付包',
    projectVersion: 'v1',
    dataDestination: '外部服务 A',
    fees: { amount: 0, currency: 'CNY' },
    environmentImpact: '无',
    grantedBy: '可以上传一次。',
  })
  const first = log.consumeAuthorization(granted.authorizationId, {
    action: 'upload-package',
    actor: 'user',
    result: { ok: true, bytes: 1024 },
  })
  assert.equal(first.ok, true)
  assert.equal(first.authorization.status, 'used')
  assert.equal(first.authorization.uses.length, 1)
  assert.equal(first.authorization.actualAction, 'upload-package')

  assert.throws(
    () => log.consumeAuthorization(granted.authorizationId, { action: 'upload-package' }),
    (error) => {
      assert.ok(error instanceof ConflictError)
      assert.match(error.message, /一次性授权/)
      return true
    },
  )
  const reloaded = reload(paths, clock)
  const afterRefusal = reloaded.listAuthorizations()[0]
  assert.equal(afterRefusal.uses.length, 1, '被拒绝的第二次使用不能算一次真实使用')
  assert.equal(afterRefusal.refusedAttempts.length, 1)
  assert.equal(afterRefusal.refusedAttempts[0].reason, 'once-already-used')

  // A different action is refused too, even before the authorization is used.
  const fresh = reloaded.grantAuthorization({
    actor: 'user',
    action: 'download-file',
    target: '模型',
    scope: '一次下载',
    projectVersion: 'v1',
    grantedBy: '可以下载。',
  })
  assert.throws(
    () => reloaded.consumeAuthorization(fresh.authorizationId, { action: 'delete-file' }),
    (error) => {
      assert.ok(error instanceof ValidationError)
      assert.match(error.message, /实际动作与授权动作不一致/)
      return true
    },
  )
  const refused = reloaded.getAuthorization(fresh.authorizationId)
  assert.equal(refused.uses.length, 0)
  assert.equal(refused.refusedAttempts[0].reason, 'action-mismatch')
})

test('decisions: events are appended for the facts that were recorded', () => {
  const { paths, log } = newProject('events')
  const version = versionId()
  log.recordConfirmation({
    actor: 'user',
    objectId: 'object-events',
    aspect: ConfirmAspect.EXPORT,
    scope: ConfirmScope.WHOLE,
    versionId: version,
    state: ConfirmationState.CONFIRMED,
    humanResponse: '可以导出。',
  })
  log.recordDecision({
    actor: 'user',
    objectId: 'object-events',
    aspect: ConfirmAspect.EXPORT,
    scope: ConfirmScope.WHOLE,
    versionId: version,
    reason: '导出规格确认',
  })
  log.grantAuthorization({
    actor: 'user',
    action: 'export-file',
    target: '输出目录',
    scope: '一次导出',
    projectVersion: version,
    grantedBy: '可以导出一次。',
  })
  const { events } = readEvents(paths.dir, { limit: 100 })
  const kinds = events.map((event) => event.kind)
  assert.ok(kinds.includes('confirmation.recorded'))
  assert.ok(kinds.includes('decision.recorded'))
  assert.ok(kinds.includes('authorization.recorded'))
  const confirmationEvent = events.find((event) => event.kind === 'confirmation.recorded')
  assert.equal(confirmationEvent.actor, 'user')
  assert.equal(confirmationEvent.objectId, 'object-events')
  assert.equal(confirmationEvent.versionId, version)
})

test('decisions: the index enforces the stored revision, so a stale write conflicts', () => {
  const { paths, log } = newProject('revision')
  log.recordConfirmation({
    actor: 'user',
    objectId: 'object-rev',
    aspect: ConfirmAspect.CLEANUP,
    scope: ConfirmScope.WHOLE,
    versionId: versionId(),
    state: ConfirmationState.CONFIRMED,
    humanResponse: '可以清理缓存。',
  })
  const file = paths.resolve(PROJECT_LAYOUT.decisionsIndex)
  const stored = tryReadDocument(file, { kind: 'decisions' })
  assert.ok(stored)
  assert.equal(stored.value.projectId, paths.projectId)
  assert.equal(stored.value.schemaVersion, 1)
  assert.equal(stored.value.schemaGeneration, 1)
  assert.match(stored.revision, /^r\d{12}-[0-9a-f]{8}$/)
  assert.throws(
    () =>
      writeDocument(
        file,
        { ...stored.value, confirmations: [] },
        { kind: 'decisions', expectedRevision: 'r000000000001-00000000' },
      ),
    (error) => {
      assert.ok(error instanceof ConflictError)
      assert.equal(error.code, 'CONFLICT')
      return true
    },
  )
})

test('decisions: describe() reports real counts, not a rounded claim', () => {
  const { log } = newProject('describe')
  const version = versionId()
  assert.deepEqual(log.describe(), {
    projectId: log.projectId,
    confirmations: 0,
    confirmed: 0,
    total: 0,
    decisions: 0,
    proposals: 0,
    authorizations: 0,
    confirmationProgress: { confirmed: 0, total: 0 },
  })
  log.recordConfirmation({
    actor: 'user',
    objectId: 'a',
    aspect: ConfirmAspect.MATERIAL_USE,
    scope: ConfirmScope.OBJECT,
    versionId: version,
    state: ConfirmationState.CONFIRMED,
    humanResponse: '可以。',
  })
  log.recordConfirmation({
    actor: 'user',
    objectId: 'b',
    aspect: ConfirmAspect.MATERIAL_USE,
    scope: ConfirmScope.OBJECT,
    versionId: version,
    state: ConfirmationState.PARTIALLY_CONFIRMED,
    humanResponse: '部分可以。',
  })
  log.proposeConfirmation({
    objectId: 'c',
    aspect: ConfirmAspect.MATERIAL_USE,
    scope: ConfirmScope.OBJECT,
    versionId: version,
    proposedState: ConfirmationState.CONFIRMED,
    rationale: '建议确认',
  })
  const summary = log.describe()
  assert.equal(summary.confirmations, 2)
  assert.equal(summary.confirmed, 2)
  assert.equal(summary.total, 2)
  assert.equal(summary.proposals, 1)
  assert.deepEqual(summary.confirmationProgress, { confirmed: 2, total: 2 })
})
