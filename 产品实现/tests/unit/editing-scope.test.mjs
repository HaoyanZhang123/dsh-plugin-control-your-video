/**
 * Unit tests for editing scope, timing ripple and protection analysis.
 *
 * These are pure-plan checks: no renderer, no files. They prove the rules the card names — only the
 * target (and declared ripple) may change, neighbours, output and sound manifest may not, and a
 * timing edit says out loud how the rest of the film moves.
 *
 * @module tests/unit/editing-scope.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock } from '../../base/index.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan, diffPlans } from '../../media/plan.js'
import {
  UNOBSERVED_PROPERTIES,
  analyzeScope,
  applyDirectIntent,
  describeEditScope,
  describeTimingImpact,
} from '../../editing/scope.js'

const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 10, 0, 0, 0) })
const fontFile = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc')
const skip = fs.existsSync(fontFile) ? false : '需要系统中文字体构建 C12 计划；当前环境缺失，如实跳过'
const base = skip === false
  ? normalizePlan(buildC12UnitPlan({ fontFile }), { now: () => clock.iso() })
  : null

/** Apply one intent and analyze it against the base plan. @param {any} intent */
function edit(intent) {
  const result = applyDirectIntent({ plan: base, intent })
  const scope = analyzeScope({
    basePlan: base,
    nextPlan: result.plan,
    targetObjectIds: [intent.objectId ?? intent.transitionId ?? intent.sceneId],
    allowedRippleIds: result.ripple?.objectIds ?? [],
    timingEdit: result.ripple?.timebaseChanged === true,
    transitionEdit: intent.kind === 'set-transition-overlap',
  })
  return { result, scope }
}

test('only the target object changes; neighbours, output and sound manifest stay identical', { skip }, () => {
  const { result, scope } = edit({
    kind: 'replace-text',
    objectId: 'obj-subtitle-S02',
    text: '只改这一条字幕（测试）',
  })
  assert.deepEqual(scope.changedObjectIds, ['obj-subtitle-S02'])
  assert.equal(scope.ok, true)
  assert.equal(scope.audioProtected, true)
  assert.equal(scope.outputProtected, true)
  assert.ok(scope.protectedObjectIds.includes('obj-subtitle-S01'))
  assert.ok(scope.protectedObjectIds.includes('obj-audio-main'))
  assert.equal(result.plan.timebase.totalFrames, base.timebase.totalFrames)
  assert.equal(diffPlans(base, result.plan).soundChanged, false)
})

test('an undeclared change to another object is a violation, not a warning', { skip }, () => {
  const result = applyDirectIntent({
    plan: base,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '改了 S02' },
  })
  const changed = applyDirectIntent({
    plan: result.plan,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text: '顺手也改了 S01' },
  })
  const scope = analyzeScope({
    basePlan: base,
    nextPlan: changed.plan,
    targetObjectIds: ['obj-subtitle-S02'],
  })
  assert.equal(scope.ok, false)
  assert.ok(scope.violations.some((entry) => entry.rule === 'changed-outside-target'))
})

test('a declared preserve item that changed is refused', { skip }, () => {
  const result = applyDirectIntent({
    plan: base,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '改 S02，但声明保留它' },
  })
  const scope = analyzeScope({
    basePlan: base,
    nextPlan: result.plan,
    targetObjectIds: ['obj-subtitle-S02'],
    preserveObjectIds: ['obj-subtitle-S02'],
  })
  assert.equal(scope.ok, false)
  assert.ok(scope.violations.some((entry) => entry.rule === 'preserved-item-changed'))
})

test('an editable property the runtime does not read is reported, not hidden', { skip }, () => {
  const { result } = edit({ kind: 'set-property', objectId: 'obj-sceneA-title', prop: 'fontFamily', value: 'Arial' })
  const known = UNOBSERVED_PROPERTIES.find((entry) => entry.prop === 'fontFamily')
  assert.ok(known, 'fontFamily is a known unobserved property')
  assert.ok(result.warnings.some((warning) => warning.includes('fontFamily')))
  assert.equal(result.plan.objects.find((entry) => entry.id === 'obj-sceneA-title').params.fontFamily, 'Arial')
})

test('timing fields through set-property are refused with a remedy', { skip }, () => {
  assert.throws(
    () => applyDirectIntent({
      plan: base,
      intent: { kind: 'set-property', objectId: 'obj-subtitle-S02', prop: 'startFrame', value: 80 },
    }),
    /set-object-timing/i,
  )
})

test('object timing moves the real timeline and keeps total duration', { skip }, () => {
  const { result, scope } = edit({
    kind: 'set-object-timing',
    objectId: 'obj-subtitle-S02',
    startFrame: 78,
  })
  const object = result.plan.objects.find((entry) => entry.id === 'obj-subtitle-S02')
  assert.equal(object.timeline.startFrame, 78)
  assert.equal(result.plan.timebase.totalFrames, base.timebase.totalFrames)
  assert.deepEqual(scope.changedObjectIds, ['obj-subtitle-S02'])
  assert.deepEqual(scope.timing.objectWindowChanges, [
    { objectId: 'obj-subtitle-S02', startDeltaFrames: 3, durationDeltaFrames: 0 },
  ])
})

test('a scene duration change shifts later scenes and objects, and says so', { skip }, () => {
  const { result, scope } = edit({ kind: 'set-scene-duration', sceneId: 'scene-A', durationFrames: 160 })
  assert.equal(result.plan.timebase.totalFrames, base.timebase.totalFrames + 10)
  const sceneB = result.plan.scenes.find((entry) => entry.id === 'scene-B')
  assert.equal(sceneB.timeline.startFrame, 130)
  const video = result.plan.objects.find((entry) => entry.id === 'obj-existing-video')
  assert.equal(video.timeline.startFrame, 130)
  assert.ok(scope.timing.sceneChanges.some((entry) => entry.sceneId === 'scene-B' && entry.startDeltaFrames === 10))
  assert.equal(scope.timing.requiresWholeFilmWatch, true)
  assert.equal(scope.timing.totalFrames.deltaFrames, 10)
  assert.equal(scope.ok, true)
})

test('a transition overlap change shifts the target scene and its objects', { skip }, () => {
  const { result, scope } = edit({
    kind: 'set-transition-overlap',
    transitionId: 'obj-transition-crossfade',
    overlapFrames: 20,
  })
  assert.equal(result.plan.timebase.totalFrames, base.timebase.totalFrames + 10)
  const sceneB = result.plan.scenes.find((entry) => entry.id === 'scene-B')
  assert.equal(sceneB.timeline.startFrame, 130)
  assert.equal(scope.ok, true, JSON.stringify(scope.violations))
  assert.ok(scope.timing.transitionChanges.some((entry) => entry.transitionId === 'obj-transition-crossfade'))
})

test('an audio duration change keeps the sound manifest and is listed as a window change', { skip }, () => {
  const { result, scope } = edit({
    kind: 'set-object-timing',
    objectId: 'obj-audio-main',
    durationFrames: 250,
  })
  assert.equal(diffPlans(base, result.plan).soundChanged, false)
  assert.equal(scope.audioProtected, true)
  assert.ok(scope.timing.objectWindowChanges.some((entry) => entry.objectId === 'obj-audio-main'))
})

test('describeEditScope names the protected set and the movie-level watch requirement', { skip }, () => {
  const scope = describeEditScope({ plan: base, targetObjectIds: ['obj-subtitle-S02'] })
  assert.ok(scope.preserve.includes('obj-subtitle-S01'))
  assert.ok(scope.preserve.includes('obj-audio-main'))
  assert.equal(scope.requiresWholeFilmWatch, true)
  assert.equal(scope.targets[0].scope, 'movie')
})
