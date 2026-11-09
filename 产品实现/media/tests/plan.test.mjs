/**
 * CompositionPlan: schema, derived timing and semantic diff.
 * @module media/tests/plan.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildC12UnitPlan, buildC02SourceVariant } from '../fixtures/c12-unit.js'
import { collectPlanProblems, normalizePlan, deriveLayout, diffPlans, assertRepairScope, planFingerprint } from '../plan.js'
import { frozenClock, fontFile } from './helpers.mjs'

const plan = () => buildC12UnitPlan({ fontFile: fontFile() })

test('a valid C12 unit derives 270 frames and 9.000 s from 150+150−30', () => {
  const raw = plan()
  assert.deepEqual(collectPlanProblems(raw), [])
  const normalized = normalizePlan(raw, { now: () => '2026-11-09T00:00:00.000Z' })
  assert.equal(normalized.timebase.totalFrames, 270)
  assert.equal(normalized.timebase.totalSeconds, 9)
  assert.equal(normalized.timebase.totalRational, '9/1')
  assert.deepEqual(
    normalized.scenes.map((scene) => [scene.id, scene.timeline.startFrame, scene.timeline.endFrameExclusive]),
    [['scene-A', 0, 150], ['scene-B', 120, 270]],
  )
})

test('a hand-edited total that disagrees with the scenes is rejected, not accepted', () => {
  const raw = plan()
  raw.timebase.totalFrames = 300
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'total-frames'))
})

test('a scene start that does not follow the overlap rule is rejected', () => {
  const raw = plan()
  raw.scenes[1].timeline.startFrame = 100
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'scene-start'))
})

test('duplicate object ids are rejected', () => {
  const raw = plan()
  raw.objects.push({ ...raw.objects[0] })
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'object-id-duplicate'))
})

test('a scene-scoped object may not stretch beyond its scene', () => {
  const raw = plan()
  raw.objects.find((object) => object.id === 'obj-sceneA-title').timeline.durationFrames = 200
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'object-outside-scene'))
})

test('a movie-level subtitle must be on a track', () => {
  const raw = plan()
  raw.tracks = raw.tracks.filter((track) => track.id !== 'track-subtitles')
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'movie-object-untracked'))
})

test('a subtitle without text is rejected', () => {
  const raw = plan()
  raw.objects.find((object) => object.id === 'obj-subtitle-S01').params.text = '   '
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'subtitle-text'))
})

test('a word-level claim without word data is rejected', () => {
  const raw = plan()
  raw.soundManifest.segments[0].wordLevel = [{ text: '二〇二六', start: 0 }]
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'sound-word-level'))
})

test('object kind and hit mode must agree (a canvas object cannot claim DOM text hit)', () => {
  const raw = plan()
  raw.objects.find((object) => object.id === 'obj-sceneA-pattern').hitTest = 'text-box'
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'object-hit-mode'))
})

test('the semantic diff names the changed object and its frame window', () => {
  const base = normalizePlan(plan(), { now: () => '2026-11-09T00:00:00.000Z' })
  const next = JSON.parse(JSON.stringify(base))
  next.planVersion = '1.0.1'
  next.objects.find((object) => object.id === 'obj-subtitle-S02').params.text = '改过的字幕'
  const diff = diffPlans(base, next)
  assert.deepEqual(diff.changedObjectIds, ['obj-subtitle-S02'])
  assert.deepEqual(diff.changedFrames[0], { startFrame: 75, endFrameExclusive: 168, reason: '对象 obj-subtitle-S02 变更：params' })
  assert.ok(!diff.timebaseChanged)
  assert.ok(!diff.soundChanged)
})

test('the repair scope assertion rejects an undeclared object change', () => {
  const base = normalizePlan(plan(), { now: () => 'x' })
  const next = JSON.parse(JSON.stringify(base))
  next.objects.find((object) => object.id === 'obj-sceneA-title').params.text = '改了标题'
  const diff = diffPlans(base, next)
  const verdict = assertRepairScope(diff, { targetObjectIds: ['obj-subtitle-S02'] })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.violations[0].rule, 'changed-outside-target')
})

test('the plan fingerprint ignores bookkeeping fields but not content', () => {
  const base = normalizePlan(plan(), { now: () => 'x' })
  const same = normalizePlan(plan(), { now: () => 'y' })
  const changed = JSON.parse(JSON.stringify(base))
  changed.objects[0].params.color = '#ffffff'
  assert.equal(planFingerprint(base), planFingerprint(same))
  assert.notEqual(planFingerprint(base), planFingerprint(changed))
})

test('the C02 Canvas variant is structurally valid but carries the unsupported kind', () => {
  const variant = buildC02SourceVariant(plan())
  assert.deepEqual(collectPlanProblems(variant), [])
  assert.ok(variant.objects.some((object) => object.kind === 'canvas-program-animation'))
  const layout = deriveLayout(variant)
  assert.equal(layout.totalFrames, 270)
})

test('CT-04 §2.1: an object must declare its scope explicitly', () => {
  const raw = plan()
  delete raw.objects.find((object) => object.id === 'obj-sceneA-title').scope
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'object-scope-missing'))
})

test('CT-04 §2.1: a movie object may not be placed inside a scene list', () => {
  const raw = plan()
  raw.scenes[0].objects.push('obj-subtitle-S01')
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'scene-object-movie-scope'))
})

test('CT-04 §2.1: a scene scope on a subtitle kind is refused as a scope/kind mismatch', () => {
  const raw = plan()
  raw.objects.find((object) => object.id === 'obj-subtitle-S01').scope = 'scene'
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'object-scope-kind'))
})

test('CT-04 §2.1: a scene object crossing its own scene window is refused', () => {
  const raw = plan()
  const title = raw.objects.find((object) => object.id === 'obj-sceneB-title')
  title.timeline.startFrame = 100
  const problems = collectPlanProblems(raw)
  assert.ok(problems.some((problem) => problem.code === 'object-outside-scene'))
})
