/**
 * The confirmation-authority tests: AI may propose, only a human may confirm.
 *
 * This is the single most consequential rule in the card (CT-03 §4; 01-边界 §5.1 "未回复不确认").
 * A system that lets the AI write "the user confirmed this" converts the product into one where
 * nothing the user sees can be trusted. These assertions run against the PUBLIC facade and cover
 * the ways an AI could accidentally acquire user authority.
 *
 * C10 card §6.3 ("未回复不确认、AI 自主不等于确认、未定不制作") and §6.4 (局部确认不扩展).
 *
 * @module tests/integration/project-confirmation-authority.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTempDir, Clock } from '../../base/index.js'
import * as core from '../../core/project/index.js'

const temp = createTempDir({ label: 'authority' })
const projectsRoot = temp.dir('projects')
const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
test.after(() => temp.dispose())

/** Ids of the right shape, minted with the product's own generator. */
const VERSION_ONLY = (() => {
  const id = core.newId('version')
  return id
})()

/** Create a project and return its bound stores. */
async function project(title) {
  const created = core.createProject({ projectsRoot, title, clock })
  const session = await core.openSession({ projectsRoot, projectId: created.project.projectId, clock })
  return { created, session }
}

test('authority: an AI actor cannot create a human confirmation', async () => {
  const { session } = await project('AI 冒充确认')
  for (const actor of [core.Actor.AI, core.Actor.SYSTEM]) {
    assert.throws(
      () =>
        session.decisions.recordConfirmation({
          objectId: 'obj_scene_1',
          aspect: core.ConfirmAspect.DIRECTION,
          scope: core.ConfirmScope.WHOLE,
          versionId: VERSION_ONLY,
          state: core.ConfirmationState.CONFIRMED,
          humanResponse: '用户说可以',
          actor,
        }),
      (error) => error.code === 'VALIDATION_FAILED',
      `${actor} 不得写作用户确认`,
    )
  }
})

test('authority: an AI proposal is not a confirmation and satisfies no confirmation query', async () => {
  const { session } = await project('AI 提议')
  const proposal = session.decisions.proposeConfirmation({
    objectId: 'obj_scene_1',
    aspect: core.ConfirmAspect.DIRECTION,
    scope: core.ConfirmScope.WHOLE,
    versionId: VERSION_ONLY,
    proposedState: core.ConfirmationState.CONFIRMED,
    rationale: '方向看起来符合简报',
  })
  // A proposal must be structurally distinguishable from a confirmation.
  assert.equal(proposal.isConfirmation, false)
  assert.match(String(proposal.kind), /proposal/)
  assert.equal(session.decisions.isConfirmed('obj_scene_1', core.ConfirmAspect.DIRECTION), false)
  assert.deepEqual(session.decisions.listConfirmed(), [])
  assert.equal(
    session.decisions.confirmationStateOf('obj_scene_1', core.ConfirmAspect.DIRECTION),
    core.ConfirmationState.UNDECIDED,
  )
})

test('authority: silence is never read as confirmation', async () => {
  const { session } = await project('沉默')
  // No record at all — the most common real case, because the user simply has not answered.
  assert.equal(session.decisions.isConfirmed('obj_unknown', core.ConfirmAspect.PLAN), false)
  assert.equal(
    session.decisions.confirmationStateOf('obj_unknown', core.ConfirmAspect.PLAN),
    core.ConfirmationState.UNDECIDED,
  )
  assert.deepEqual(session.decisions.listConfirmed(), [])
})

test('authority: ai-allowed is recorded but never reads as user-confirmed', async () => {
  const { session } = await project('AI 自主')
  const state = session.decisions.delegateToAi({
    objectId: 'obj_style',
    aspect: core.ConfirmAspect.PLAN,
    scope: core.ConfirmScope.WHOLE,
    versionId: VERSION_ONLY,
    humanResponse: '样式你定就行',
  })
  // `delegateToAi` returns the resulting object-confirmation state record.
  assert.equal(state.state, core.ConfirmationState.AI_ALLOWED)
  assert.equal(state.objectId, 'obj_style')
  // Even though the USER granted the delegation, the resulting state is outside the confirmed
  // family: the user authorized the AI to decide, they did not review the result.
  assert.equal(
    session.decisions.confirmationStateOf('obj_style', core.ConfirmAspect.PLAN),
    core.ConfirmationState.AI_ALLOWED,
  )
  assert.equal(session.decisions.isConfirmed('obj_style', core.ConfirmAspect.PLAN), false)
  assert.equal(core.HUMAN_CONFIRMED_STATES.includes(core.ConfirmationState.AI_ALLOWED), false)
  assert.deepEqual(session.decisions.listConfirmed(), [])
})

test('authority: a real user confirmation is stored, queryable, and bound to its version', async () => {
  const { session } = await project('真实确认')
  const record = session.decisions.recordConfirmation({
    objectId: 'obj_scene_2',
    aspect: core.ConfirmAspect.DIRECTION,
    scope: core.ConfirmScope.PART,
    versionId: VERSION_ONLY,
    state: core.ConfirmationState.CONFIRMED,
    humanResponse: '这个方向可以，就用它',
    actor: core.Actor.USER,
  })

  assert.equal(session.decisions.isConfirmed('obj_scene_2', core.ConfirmAspect.DIRECTION), true)
  const confirmed = session.decisions.listConfirmed()
  assert.equal(confirmed.length, 1)
  // The binding is the whole point: object + aspect + scope + version, plus the user's own words.
  assert.equal(record.objectId, 'obj_scene_2')
  assert.equal(record.aspect, core.ConfirmAspect.DIRECTION)
  assert.equal(record.scope, core.ConfirmScope.PART)
  assert.equal(record.versionId, VERSION_ONLY)
  assert.equal(record.humanResponse, '这个方向可以，就用它')
  // The stored confirmation is the human one: its presence in `listConfirmed` (which excludes AI
  // proposals and ai-allowed delegations) is what makes it authoritative.
  assert.equal(confirmed[0].confirmationId, record.confirmationId)
})

test('authority: a partial confirmation is recorded as partial, not as whole', async () => {
  const { session } = await project('局部确认')
  session.decisions.recordConfirmation({
    objectId: 'obj_titles',
    aspect: core.ConfirmAspect.OBJECT_EDIT,
    scope: core.ConfirmScope.PART,
    versionId: VERSION_ONLY,
    state: core.ConfirmationState.PARTIALLY_CONFIRMED,
    humanResponse: '只有第一条标题可以',
    actor: core.Actor.USER,
  })
  // A PART confirmation must never be readable as a WHOLE confirmation (C10 §6.4 局部确认不扩展).
  assert.equal(
    session.decisions.confirmationStateOf('obj_titles', core.ConfirmAspect.OBJECT_EDIT),
    core.ConfirmationState.PARTIALLY_CONFIRMED,
  )
  // And a partial state deliberately maps to `undecided` for the production gate, so a key item
  // cannot pass on a technicality.
  assert.equal(session.decisions.getPlanItemState('obj_titles', core.ConfirmAspect.OBJECT_EDIT), core.PlanItemState.UNDECIDED)
})

test('authority: a key plan item that is undecided blocks full production', async () => {
  const { session } = await project('关键项未定')
  const before = core.assertProductionGate({
    items: [
      { id: 'goal', kind: 'core-goal', state: session.decisions.getPlanItemState('goal', core.ConfirmAspect.PLAN) },
      { id: 'structure', kind: 'structure', state: session.decisions.getPlanItemState('structure', core.ConfirmAspect.PLAN) },
    ],
  })
  assert.equal(before.ok, false)

  // A DECIDED key item unblocks its own slot; the other still blocks, so the gate stays closed.
  session.decisions.recordDecision({
    objectId: 'goal',
    aspect: core.ConfirmAspect.PLAN,
    scope: core.ConfirmScope.WHOLE,
    versionId: VERSION_ONLY,
    reason: '用户明确要三秒开场',
    actor: core.Actor.USER,
  })
  const after = core.assertProductionGate({
    items: [
      { id: 'goal', kind: 'core-goal', state: session.decisions.getPlanItemState('goal', core.ConfirmAspect.PLAN) },
      { id: 'structure', kind: 'structure', state: session.decisions.getPlanItemState('structure', core.ConfirmAspect.PLAN) },
    ],
  })
  assert.equal(after.ok, false)
  assert.deepEqual(after.undecided, ['structure'])
})

test('authority: an AI decision proposal does not make a plan item decided', async () => {
  const { session } = await project('AI 决定')
  const proposal = session.decisions.proposeDecision({
    objectId: 'structure',
    aspect: core.ConfirmAspect.PLAN,
    scope: core.ConfirmScope.WHOLE,
    versionId: VERSION_ONLY,
    reason: '按简报推断为三段',
    proposedState: core.PlanItemState.DECIDED,
    rationale: '简报提到三个小节',
  })
  assert.equal(proposal.isDecision, false)
  // An AI proposal must not open the production gate.
  assert.notEqual(
    session.decisions.getPlanItemState('structure', core.ConfirmAspect.PLAN),
    core.PlanItemState.DECIDED,
  )
})

test('authority: an authorization must be user-granted and cannot be vague', async () => {
  const { session } = await project('授权')
  // AI may not grant itself an external action.
  assert.throws(
    () =>
      session.decisions.grantAuthorization({
        action: 'download-model',
        target: 'remote',
        scope: 'once',
        projectVersion: 'proj-v1',
        grantedBy: 'AI 认为可以',
        actor: core.Actor.AI,
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )

  // A blanket authorization is refused: external actions are authorized one concrete scope at a
  // time, and "任何都能做" is exactly the blanket the contract forbids.
  assert.throws(
    () =>
      session.decisions.grantAuthorization({
        action: '任何',
        target: '*',
        scope: '*',
        projectVersion: 'proj-v1',
        grantedBy: '用户说随便',
        actor: core.Actor.USER,
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('authority: a once-only authorization cannot be consumed twice', async () => {
  const { session } = await project('一次性授权')
  const granted = session.decisions.grantAuthorization({
    action: 'install-tool',
    target: 'ffmpeg',
    scope: '本次安装 ffmpeg',
    projectVersion: 'proj-v1',
    grantedBy: '可以装 ffmpeg',
    actor: core.Actor.USER,
  })
  assert.ok(granted.authorizationId, '授权必须有标识')
  assert.equal(granted.validFor, core.VALID_FOR_ONCE)

  const first = session.decisions.consumeAuthorization(granted.authorizationId, {
    action: 'install-tool',
    result: 'installed',
  })
  assert.equal(first.ok, true)

  // The second use must be refused; the first did not silently widen into "may install again".
  assert.throws(
    () =>
      session.decisions.consumeAuthorization(granted.authorizationId, {
        action: 'install-tool',
        result: 'installed again',
      }),
    (error) => error.code === 'CONFLICT',
  )
})

test('authority: changing confirmed content marks it changed-after-confirmation, keeping history', async () => {
  const { session } = await project('确认后改动')
  const first = session.decisions.recordConfirmation({
    objectId: 'obj_scene_3',
    aspect: core.ConfirmAspect.INITIAL_CUT,
    scope: core.ConfirmScope.WHOLE,
    versionId: VERSION_ONLY,
    state: core.ConfirmationState.CONFIRMED,
    humanResponse: '初版可以',
    actor: core.Actor.USER,
  })

  session.decisions.markChangedAfterConfirmation({
    objectId: 'obj_scene_3',
    aspect: core.ConfirmAspect.INITIAL_CUT,
    reason: '用户改了字幕',
  })
  assert.equal(
    session.decisions.confirmationStateOf('obj_scene_3', core.ConfirmAspect.INITIAL_CUT),
    core.ConfirmationState.CHANGED_AFTER_CONFIRMATION,
  )
  // A changed item blocks production rather than passing on the old confirmation.
  assert.equal(
    session.decisions.getPlanItemState('obj_scene_3', core.ConfirmAspect.INITIAL_CUT),
    core.PlanItemState.UNDECIDED,
  )

  // The earlier confirmation must still exist in history: the user did confirm it, and that fact
  // is not erased by a later change.
  const history = session.decisions.listConfirmations()
  assert.ok(history.length >= 1)
  assert.ok(history.some((record) => record.confirmationId === first.confirmationId))
})
