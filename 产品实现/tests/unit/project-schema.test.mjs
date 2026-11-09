/**
 * Unit tests for the frozen vocabulary in core/project/schema.js.
 *
 * These test the RULES, not the strings: the three axes must stay separate, `ai-allowed` must
 * never read as confirmed, and an illegal phase transition must be refused rather than coerced.
 * CT-03 §2, §6; C10 card §6.3.
 *
 * @module tests/unit/project-schema.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ProjectPhase,
  ExecutionState,
  ConfirmationState,
  PlanItemState,
  VersionClass,
  ConfirmAspect,
  ConfirmScope,
  PreferenceGroup,
  MaterialObservation,
  NeedsAttentionCode,
  HUMAN_CONFIRMED_STATES,
  PHASE_TRANSITIONS,
  assertEnum,
  assertPhaseTransition,
  assertProductionGate,
  isBlockingPlanItem,
  isVersionMutable,
  summarizeProjectState,
} from '../../core/project/schema.js'

test('schema: the three axes are distinct enums, so they cannot be conflated', () => {
  const phaseValues = new Set(Object.values(ProjectPhase))
  for (const value of Object.values(ExecutionState)) {
    assert.equal(phaseValues.has(value), false, `执行状态 ${value} 不得同时是项目阶段`)
  }
  const confirmValues = new Set(Object.values(ConfirmationState))
  for (const value of Object.values(ExecutionState)) {
    assert.equal(confirmValues.has(value), false, `执行状态 ${value} 不得同时是对象确认状态`)
  }
})

test('schema: ai-allowed is NOT in the human-confirmed family', () => {
  // This is the single most important rule in the card: AI autonomy must never be displayed as
  // user review (CT-03 §2 "ai-allowed 只是明确授权 AI 自主，不使用用户已确认外观").
  assert.equal(HUMAN_CONFIRMED_STATES.includes(ConfirmationState.AI_ALLOWED), false)
  assert.deepEqual([...HUMAN_CONFIRMED_STATES], [
    ConfirmationState.PARTIALLY_CONFIRMED,
    ConfirmationState.CONFIRMED,
  ])
})

test('schema: all four material observation states exist separately', () => {
  // One boolean would force a lie; CT-03 §3 requires unread / unreadable / partial / full to be
  // distinguishable.
  const values = Object.values(MaterialObservation)
  for (const required of ['unread', 'unreadable', 'observed-partial', 'observed-full']) {
    assert.ok(values.includes(required), `缺少观察状态 ${required}`)
  }
  assert.equal(new Set(values).size, values.length)
})

test('schema: assertEnum refuses a value outside the closed enum', () => {
  assert.equal(assertEnum('idle', ExecutionState, 'execution'), 'idle')
  assert.throws(() => assertEnum('happily-running', ExecutionState, 'execution'), /不在允许取值内/)
  assert.throws(() => assertEnum(undefined, ExecutionState, 'execution'))
})

test('schema: phase transitions are asymmetric and illegal jumps are refused', () => {
  assertPhaseTransition(ProjectPhase.INTAKE, ProjectPhase.ALIGNING)
  // Starting production while still aligning would skip the plan gate entirely.
  assert.throws(() => assertPhaseTransition(ProjectPhase.INTAKE, ProjectPhase.PRODUCING), /不允许的阶段转换/)
  assert.throws(() => assertPhaseTransition(ProjectPhase.ALIGNING, ProjectPhase.COMPLETED), /不允许的阶段转换/)
  // A same-phase call is a no-op, not an error, so a caller may re-assert idempotently.
  assert.doesNotThrow(() => assertPhaseTransition(ProjectPhase.PRODUCING, ProjectPhase.PRODUCING))
  for (const [from, targets] of Object.entries(PHASE_TRANSITIONS)) {
    for (const to of targets) {
      assert.doesNotThrow(() => assertPhaseTransition(from, to), `${from} -> ${to} 应当是允许的`)
    }
  }
})

test('schema: production gate blocks while a KEY plan item is undecided', () => {
  const blocked = assertProductionGate({
    items: [
      { id: 'i1', kind: 'core-goal', state: PlanItemState.DECIDED },
      { id: 'i2', kind: 'structure', state: PlanItemState.UNDECIDED },
    ],
  })
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.undecided, ['i2'])

  const allowed = assertProductionGate({
    items: [
      { id: 'i1', kind: 'core-goal', state: PlanItemState.DECIDED },
      { id: 'i2', kind: 'structure', state: PlanItemState.AI_ALLOWED },
      // A non-key item may stay open; it does not block the gate.
      { id: 'i3', kind: 'optional-polish', state: PlanItemState.UNDECIDED },
    ],
  })
  assert.equal(allowed.ok, true)
})

test('schema: only key kinds can block; a generic open item does not', () => {
  assert.equal(isBlockingPlanItem('core-goal', PlanItemState.UNDECIDED), true)
  assert.equal(isBlockingPlanItem('structure', PlanItemState.UNDECIDED), true)
  assert.equal(isBlockingPlanItem('delivery-spec', PlanItemState.UNDECIDED), true)
  assert.equal(isBlockingPlanItem('rights', PlanItemState.UNDECIDED), true)
  assert.equal(isBlockingPlanItem('core-goal', PlanItemState.DECIDED), false)
  assert.equal(isBlockingPlanItem('core-goal', PlanItemState.AI_ALLOWED), false)
  assert.equal(isBlockingPlanItem('minor-layout', PlanItemState.UNDECIDED), false)
})

test('schema: only current and candidate versions are mutable; final is not', () => {
  assert.equal(isVersionMutable(VersionClass.CURRENT), true)
  assert.equal(isVersionMutable(VersionClass.CANDIDATE), true)
  assert.equal(isVersionMutable(VersionClass.FINAL), false)
})

test('schema: the version class enum has exactly three members', () => {
  // "不新增复杂用户版本" — a fourth class appearing here would be a product change, so it fails
  // this test loudly instead of being noticed in review.
  assert.deepEqual(Object.values(VersionClass).sort(), ['candidate', 'current', 'final'])
  assert.equal(Object.values(VersionClass).length, 3)
})

test('schema: confirmation aspects and scopes are closed enums', () => {
  // An open aspect field would let any string through and make confirmation unqueryable.
  for (const aspect of Object.values(ConfirmAspect)) {
    assert.equal(assertEnum(aspect, ConfirmAspect, 'aspect'), aspect)
  }
  assert.throws(() => assertEnum('whatever-the-ai-liked', ConfirmAspect, 'aspect'), /不在允许取值内/)
  assert.throws(() => assertEnum('global-ish', ConfirmScope, 'scope'), /不在允许取值内/)
})

test('schema: preference groups are exactly the five allowed groups', () => {
  assert.deepEqual(Object.values(PreferenceGroup).sort(), [
    'creation',
    'data-authorization',
    'notification',
    'storage',
    'workspace',
  ])
})

test('schema: summarizeProjectState keeps the axes separate and derives one label', () => {
  const summary = summarizeProjectState({
    phase: ProjectPhase.PRODUCING,
    execution: ExecutionState.PAUSED,
    confirmations: { confirmed: 1, total: 3 },
  })
  assert.equal(summary.phase, 'producing')
  assert.equal(summary.execution, 'paused')
  assert.equal(summary.confirmation, 'partially-confirmed')
  assert.match(summary.label, /制作中/)
  assert.match(summary.label, /已暂停/)
  assert.equal(summary.needsAttention, false)

  const unknown = summarizeProjectState({
    phase: ProjectPhase.PRODUCING,
    execution: ExecutionState.UNKNOWN,
    confirmations: { confirmed: 0, total: 0 },
  })
  // Unknown must surface as needing attention, not as a comfortable "paused".
  assert.equal(unknown.needsAttention, true)
  assert.match(unknown.label, /状态未知/)
  assert.equal(unknown.confirmation, 'undecided')
})

test('schema: zero confirmed out of many is undecided, NOT partially confirmed', () => {
  // "nothing confirmed yet" must not be reported as "partially confirmed": the second wording
  // tells the user they have already approved something, which they have not.
  const noneConfirmed = summarizeProjectState({
    phase: ProjectPhase.ALIGNING,
    execution: ExecutionState.WAITING_USER,
    confirmations: { confirmed: 0, total: 2 },
  })
  assert.equal(noneConfirmed.confirmation, 'undecided')

  const someConfirmed = summarizeProjectState({
    phase: ProjectPhase.ALIGNING,
    execution: ExecutionState.WAITING_USER,
    confirmations: { confirmed: 1, total: 2 },
  })
  assert.equal(someConfirmed.confirmation, 'partially-confirmed')

  const allConfirmed = summarizeProjectState({
    phase: ProjectPhase.ALIGNING,
    execution: ExecutionState.WAITING_USER,
    confirmations: { confirmed: 2, total: 2 },
  })
  assert.equal(allConfirmed.confirmation, 'confirmed')
})

test('schema: needsAttentionCode covers the real needs-handling situations', () => {
  const required = [
    'MATERIAL_MISSING',
    'MATERIAL_HASH_MISMATCH',
    'PROJECT_DIR_MISSING',
    'PROJECT_FILE_CORRUPT',
    'LOCK_STALE',
    'EXECUTION_UNKNOWN',
    'EXTERNAL_TOOL_MISSING',
    'DISK_FULL',
    'PERMISSION_DENIED',
    'FILE_BUSY',
    'CANDIDATE_NEEDS_RECHECK',
  ]
  const values = Object.values(NeedsAttentionCode)
  for (const code of required) {
    assert.ok(values.includes(code), `缺少需要处理的原因码 ${code}`)
  }
})
