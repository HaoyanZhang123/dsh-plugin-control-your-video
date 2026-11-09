/**
 * Unit tests for the complete field-level protection comparison.
 *
 * These are deliberately adversarial: a neighbour's box, motion, zIndex or derivedFrom is changed
 * WITHOUT touching its text or timeline, which is exactly the case C12's `diffPlans` cannot see.
 * The test proves both sides of the gap — `diffPlans` reports no change, the new field diff reports
 * the field, and the scope assertion refuses the candidate.
 *
 * @module tests/unit/editing-field-diff.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock } from '../../base/index.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { diffPlans, normalizePlan } from '../../media/plan.js'
import { analyzeScope } from '../../editing/scope.js'
import { assertFieldScope, diffPlanFields } from '../../editing/field-diff.js'

const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 10, 0, 0, 0) })
const fontFile = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc')
const skip = fs.existsSync(fontFile) ? false : '需要系统中文字体构建 C12 计划；当前环境缺失，如实跳过'
const base = skip === false
  ? normalizePlan(buildC12UnitPlan({ fontFile }), { now: () => clock.iso() })
  : null

/** Clone a plan and apply a mutation to one object. @param {string} objectId @param {(object: any) => void} mutate */
function withObjectChange(objectId, mutate) {
  const next = JSON.parse(JSON.stringify(base))
  const object = next.objects.find((entry) => entry.id === objectId)
  mutate(object)
  return next
}

/** Clone a plan and mutate a plan-level field. @param {(plan: any) => void} mutate */
function withPlanChange(mutate) {
  const next = JSON.parse(JSON.stringify(base))
  mutate(next)
  return next
}

/** Analyze a next plan against a target. @param {any} next */
function analyze(next, options = {}) {
  return analyzeScope({
    basePlan: base,
    nextPlan: next,
    targetObjectIds: ['obj-subtitle-S02'],
    timingEdit: options.timingEdit === true,
  })
}

test('a neighbour whose box moved is caught even though diffPlans reports no change', { skip }, () => {
  const next = withObjectChange('obj-sceneB-bg', (object) => {
    object.box = { ...object.box, x: object.box.x + 12 }
  })
  const legacy = diffPlans(base, next)
  assert.equal(legacy.changedObjectIds.includes('obj-sceneB-bg'), false, 'C12 diffPlans is blind to box')
  const field = diffPlanFields(base, next)
  assert.deepEqual(field.changedFieldsByObject['obj-sceneB-bg'], ['box'])
  const scope = analyze(next)
  assert.equal(scope.ok, false)
  const violation = scope.violations.find((entry) => entry.detail.includes('obj-sceneB-bg'))
  assert.ok(violation, 'the neighbour must be named')
  assert.ok(violation.detail.includes('box'), `violation must name the field: ${violation.detail}`)
})

test('a neighbour whose motion changed is caught even though diffPlans reports no change', { skip }, () => {
  const next = withObjectChange('obj-sceneA-title', (object) => {
    object.motion = { ...object.motion, enter: { ...object.motion.enter, durationFrames: 15 } }
  })
  const legacy = diffPlans(base, next)
  assert.equal(legacy.changedObjectIds.includes('obj-sceneA-title'), false, 'C12 diffPlans is blind to motion')
  const field = diffPlanFields(base, next)
  assert.deepEqual(field.changedFieldsByObject['obj-sceneA-title'], ['motion'])
  const scope = analyze(next)
  assert.equal(scope.ok, false)
  assert.ok(scope.violations.some((entry) => entry.detail.includes('obj-sceneA-title')))
})

test('a neighbour whose derivedFrom changed is caught', { skip }, () => {
  const next = withObjectChange('obj-subtitle-S01', (object) => {
    object.derivedFrom = { ...object.derivedFrom, audioDurationSeconds: 2.5 }
  })
  const legacy = diffPlans(base, next)
  assert.equal(legacy.changedObjectIds.includes('obj-subtitle-S01'), false, 'C12 diffPlans is blind to derivedFrom')
  const field = diffPlanFields(base, next)
  assert.deepEqual(field.changedFieldsByObject['obj-subtitle-S01'], ['derivedFrom'])
  const scope = analyze(next)
  assert.equal(scope.ok, false)
  assert.ok(scope.violations.some((entry) => entry.detail.includes('obj-subtitle-S01')))
})

test('a neighbour whose zIndex changed is caught', { skip }, () => {
  const next = withObjectChange('obj-sceneA-pattern', (object) => {
    object.zIndex = (object.zIndex ?? 0) + 3
  })
  const legacy = diffPlans(base, next)
  assert.equal(legacy.changedObjectIds.includes('obj-sceneA-pattern'), false, 'C12 diffPlans is blind to zIndex')
  const field = diffPlanFields(base, next)
  assert.deepEqual(field.changedFieldsByObject['obj-sceneA-pattern'], ['zIndex'])
  const scope = analyze(next)
  assert.equal(scope.ok, false)
  assert.ok(scope.violations.some((entry) => entry.detail.includes('obj-sceneA-pattern')))
})

test('a declared target may change its own box, and the field is reported', { skip }, () => {
  const next = withObjectChange('obj-subtitle-S02', (object) => {
    object.box = { ...object.box, y: object.box.y + 8 }
  })
  const scope = analyzeScope({
    basePlan: base,
    nextPlan: next,
    targetObjectIds: ['obj-subtitle-S02'],
  })
  assert.equal(scope.ok, true, JSON.stringify(scope.violations))
  assert.deepEqual(scope.changedFieldsByObject['obj-subtitle-S02'], ['box'])
})

test('a scene field change is refused without a timing declaration and allowed with one', { skip }, () => {
  const next = withPlanChange((plan) => {
    const scene = plan.scenes.find((entry) => entry.id === 'scene-B')
    scene.timeline.startFrame += 5
  })
  const strict = analyzeScope({ basePlan: base, nextPlan: next, targetObjectIds: ['obj-subtitle-S02'] })
  assert.equal(strict.ok, false)
  assert.ok(strict.violations.some((entry) => entry.rule === 'scene-canvas-changed'))
  const declared = analyzeScope({
    basePlan: base,
    nextPlan: next,
    targetObjectIds: ['obj-subtitle-S02'],
    timingEdit: true,
    allowedRippleIds: ['obj-subtitle-S02'],
  })
  assert.equal(declared.ok, true, JSON.stringify(declared.violations))
})

test('a top-level plan field change is refused', { skip }, () => {
  const next = withPlanChange((plan) => {
    plan.kits = [{ id: 'test-kit', sharedComponentRef: 'comp-x', objectIds: [] }]
  })
  const field = diffPlanFields(base, next)
  assert.ok(field.planFieldsChanged.includes('kits'))
  const check = assertFieldScope(field, { targetObjectIds: ['obj-subtitle-S02'] })
  assert.equal(check.ok, false)
  assert.ok(check.violations.some((entry) => entry.rule === 'plan-field-changed'))
})

test('identical plans produce an empty field diff', { skip }, () => {
  const field = diffPlanFields(base, base)
  assert.equal(field.identical, true)
  assert.deepEqual(field.changedObjectIds, [])
  assert.deepEqual(field.changedFieldsByObject, {})
  assert.deepEqual(field.changedFrames, [])
})
