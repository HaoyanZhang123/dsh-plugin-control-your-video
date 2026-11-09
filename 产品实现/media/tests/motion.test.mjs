/**
 * MotionSpec compilation, window fitting, coordinate scaling and kit scope.
 * @module media/tests/motion.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compileMotionSpec,
  fitMotionToWindow,
  scaleMotionCoordinates,
  substituteText,
  describeKitScope,
  applyPropertyChange,
  bumpVersion,
  listMotionTerms,
  EASING,
} from '../motion.js'
import { buildC12UnitPlan } from '../fixtures/c12-unit.js'
import { fontFile } from './helpers.mjs'
import { normalizePlan } from '../plan.js'

const plan = () => normalizePlan(buildC12UnitPlan({ fontFile: fontFile() }), { now: () => 'x' })

test('fade-in compiles to a monotone opacity ramp with the declared easing', () => {
  const compiled = compileMotionSpec({
    objectId: 'obj-a',
    term: 'fade-in',
    enter: { durationFrames: 10, easing: 'linear' },
    hold: { durationFrames: 5 },
    exit: { durationFrames: 5, easing: 'linear' },
  })
  assert.equal(compiled.totalFrames, 20)
  assert.equal(compiled.keyframes[0].opacity, 0)
  assert.equal(compiled.keyframes[5].opacity, 0.5)
  assert.equal(compiled.keyframes[10].opacity, 1)
  assert.equal(compiled.keyframes[20].opacity, 0)
})

test('easing functions are pinned at both ends', () => {
  for (const [name, fn] of Object.entries(EASING)) {
    assert.ok(Math.abs(fn(0)) < 1e-9, `${name}(0) 应为 0`)
    assert.ok(Math.abs(fn(1) - 1) < 1e-9, `${name}(1) 应为 1`)
  }
})

test('a pure hold is legal and reports itself as static, not as an error', () => {
  const compiled = compileMotionSpec({ objectId: 'obj-a', term: 'hold', hold: { durationFrames: 30, reason: '有意停住' } })
  assert.equal(compiled.isStatic, true)
  assert.equal(compiled.totalFrames, 30)
  assert.equal(compiled.holdReason, '有意停住')
})

test('a motion that does not fit shrinks the hold first, not the action', () => {
  const spec = {
    objectId: 'obj-a',
    term: 'fade-in',
    enter: { durationFrames: 10 },
    hold: { durationFrames: 60 },
    exit: { durationFrames: 10 },
  }
  const fitted = fitMotionToWindow(spec, 40)
  assert.equal(fitted.adjusted, 'hold-shrunk')
  assert.equal(fitted.spec.enter.durationFrames, 10)
  assert.equal(fitted.spec.exit.durationFrames, 10)
  assert.equal(fitted.spec.hold.durationFrames, 20)
})

test('when even the action does not fit, the stretch is reported instead of hidden', () => {
  const spec = {
    objectId: 'obj-a',
    term: 'fade-in',
    enter: { durationFrames: 30 },
    hold: { durationFrames: 30 },
    exit: { durationFrames: 30 },
  }
  const fitted = fitMotionToWindow(spec, 20)
  assert.equal(fitted.adjusted, 'stretched')
  assert.equal(fitted.spec.enter.durationFrames + fitted.spec.exit.durationFrames, 20)
  assert.match(fitted.note, /降级/)
})

test('coordinate scaling is per axis, so a 16:9 → 9:16 move is not a uniform scale', () => {
  const compiled = compileMotionSpec({
    objectId: 'obj-a',
    term: 'slide-in',
    enter: { durationFrames: 10 },
    path: { axis: 'x', distancePx: 100 },
  })
  const scaled = scaleMotionCoordinates(
    compiled,
    { width: 1280, height: 720 },
    { width: 1080, height: 1920 },
    { fontSize: 64 },
  )
  assert.equal(scaled.coordinates.uniform, false)
  assert.equal(scaled.coordinates.scaleX, 0.84375)
  assert.equal(scaled.coordinates.scaleY, 2.666667)
  assert.equal(scaled.coordinates.fontSize, 54)
})

test('replacing text produces a new plan version and keeps the old value in the record', () => {
  const base = plan()
  const { plan: next, change } = substituteText(base, 'obj-subtitle-S02', '新的一句话')
  assert.equal(change.from, base.objects.find((object) => object.id === 'obj-subtitle-S02').params.text)
  assert.equal(change.to, '新的一句话')
  assert.equal(next.planVersion, bumpVersion(base.planVersion))
  assert.notEqual(next.planVersion, base.planVersion)
})

test('kit scope does not silently change every instance', () => {
  const base = plan()
  const withKit = {
    ...base,
    kits: [{ id: 'kit-title', sharedComponentRef: 'component://title', objectIds: ['obj-sceneA-title', 'obj-sceneB-title'] }],
  }
  const local = applyPropertyChange(withKit, 'obj-sceneA-title', 'fontSize', 72)
  assert.deepEqual(local.applied.targets, ['obj-sceneA-title'])
  assert.equal(local.plan.objects.find((object) => object.id === 'obj-sceneB-title').params.fontSize, 52)
  const shared = applyPropertyChange(withKit, 'obj-sceneA-title', 'fontSize', 72, { propagate: true })
  assert.deepEqual(shared.applied.targets.sort(), ['obj-sceneA-title', 'obj-sceneB-title'])
  assert.equal(shared.plan.objects.find((object) => object.id === 'obj-sceneB-title').params.fontSize, 72)
  assert.equal(describeKitScope(withKit, 'obj-sceneA-title').inKit, true)
  assert.equal(describeKitScope(base, 'obj-sceneA-title').inKit, false)
})

test('the term list states its own evidence status honestly', () => {
  const terms = listMotionTerms()
  assert.ok(terms.length >= 6)
  for (const term of terms) {
    assert.ok(['unit+integration'].includes(term.evidenceStatus))
  }
})
