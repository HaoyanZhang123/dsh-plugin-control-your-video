/**
 * Object identity: one id across structure, picture, properties and time.
 * @module media/tests/objects.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildC12UnitPlan } from '../fixtures/c12-unit.js'
import { fontFile } from './helpers.mjs'
import { normalizePlan } from '../plan.js'
import { buildObjectRegistry, describeSelection, hitTest, editScopeOf, assertEditable, describeFlattened } from '../objects.js'

const normalize = (mutate) => {
  const raw = buildC12UnitPlan({ fontFile: fontFile() })
  if (mutate) mutate(raw)
  return normalizePlan(raw, { now: () => '2026-11-09T00:00:00.000Z' })
}
const plan = normalize()

test('every object has a complete identity chain', () => {
  const registry = buildObjectRegistry(plan)
  assert.equal(registry.size, plan.objects.length)
  for (const record of registry.values()) {
    assert.equal(typeof record.objectId, 'string')
    assert.equal(record.runtimeRef.handle, `ffmpeg://object/${record.objectId}`)
    assert.ok(record.planNodePath.startsWith('objects['))
    assert.ok(record.window.endFrameExclusive > record.window.startFrame)
    assert.ok(Array.isArray(record.editableProps))
    assert.equal(typeof record.modificationScope, 'string')
  }
})

test('the movie-level subtitle resolves to a track, not to a scene', () => {
  const registry = buildObjectRegistry(plan)
  const record = registry.get('obj-subtitle-S02')
  assert.equal(record.scope, 'movie')
  assert.equal(record.sceneId, null)
  assert.deepEqual(record.structure.track, { id: 'track-subtitles', kind: 'subtitle' })
})

test('picture hit returns the topmost object at the point', () => {
  const hit = hitTest(plan, 165, { x: 640, y: 620 })
  assert.equal(hit.topmost.objectId, 'obj-subtitle-S02', '字幕画在视频之上，命中应返回字幕')
  assert.ok(hit.hits.some((entry) => entry.objectId === 'obj-existing-video'))
})

test('a point with no registered region falls back to the structure tree', () => {
  // With the full-frame backgrounds removed, the lower-left corner really is empty at frame 60.
  const sparse = normalize((raw) => {
    for (const scene of raw.scenes) {
      scene.objects = scene.objects.filter((id) => id !== 'obj-sceneA-bg' && id !== 'obj-sceneB-bg')
    }
    raw.objects = raw.objects.filter((object) => object.kind !== 'solid')
  })
  const hit = hitTest(sparse, 60, { x: 2, y: 700 })
  assert.equal(hit.topmost, null)
  assert.equal(hit.fallback, '结构树')
})

test('a point outside the frame is not a hit', () => {
  const hit = hitTest(plan, 165, { x: 5000, y: 5000 })
  assert.equal(hit.hits.length, 0)
  assert.equal(hit.fallback, '结构树')
})

test('structure, picture, properties and time describe the same object', () => {
  const selection = describeSelection(plan, { objectId: 'obj-existing-video', frame: 165, point: { x: 640, y: 360 } })
  assert.equal(selection.objectId, 'obj-existing-video')
  assert.equal(selection.structure.scene, 'scene-B')
  assert.equal(selection.picture.topmost, 'obj-existing-video')
  assert.equal(selection.time.insideWindow, true)
  assert.equal(selection.consistent, true)
})

test('moving the playhead does not change which object is selected', () => {
  const a = describeSelection(plan, { objectId: 'obj-sceneA-title', frame: 60 })
  const b = describeSelection(plan, { objectId: 'obj-sceneA-title', frame: 400 })
  assert.equal(a.objectId, b.objectId)
  assert.equal(a.time.insideWindow, true)
  assert.equal(b.time.insideWindow, false, '窗口外应如实报告，而不是移动选择')
})

test('editing scope protects every other object and the audio', () => {
  const scope = editScopeOf(plan, 'obj-subtitle-S02')
  assert.deepEqual(scope.affected, ['obj-subtitle-S02'])
  assert.ok(scope.protected.includes('obj-subtitle-S01'))
  assert.ok(scope.protected.includes('obj-sceneA-title'))
  assert.ok(scope.protected.includes('obj-audio-main'))
  assert.equal(scope.audioProtected, true)
})

test('an editable property is allowed and an undeclared one is refused', () => {
  assert.equal(assertEditable(plan, 'obj-sceneA-title', 'text'), true)
  assert.throws(() => assertEditable(plan, 'obj-sceneA-title', 'rotationDeg'), /可编辑范围/)
})

test('a flattened clip exposes only clip granularity', () => {
  const flattened = normalize((raw) => {
    raw.objects.push({
      id: 'obj-flattened',
      kind: 'flattened-video',
      semanticRole: '外部压平视频',
      scope: 'scene',
      sceneId: 'scene-B',
      timeline: { startFrame: 200, durationFrames: 60 },
      authored: { sourceFile: 'video/src-existing-1280x720-30fps-12s.mp4', sourceOffsetFrames: 0 },
      params: {},
      editableProps: ['startFrame', 'durationFrames'],
      hitTest: 'rect',
      box: { x: 0, y: 0, width: 1280, height: 720 },
      modificationScope: '仅片段与范围',
    })
    raw.scenes[1].objects.push('obj-flattened')
  })
  const description = describeFlattened(flattened, 'obj-flattened')
  assert.equal(description.internalObjects, 0)
  assert.deepEqual(description.notSelectable, ['person', 'text', 'object', 'layer'])
  const hit = hitTest(flattened, 210, { x: 640, y: 360 })
  assert.ok(hit.hits.some((entry) => entry.objectId === 'obj-flattened' && entry.precisionNote.includes('压平')))
})

test('a canvas object is region-only and says so', () => {
  const canvas = normalize((raw) => {
    raw.objects.push({
      id: 'obj-canvas',
      kind: 'canvas-program-animation',
      semanticRole: 'Canvas 动画',
      scope: 'scene',
      sceneId: 'scene-A',
      timeline: { startFrame: 0, durationFrames: 150 },
      params: { particleCount: 10 },
      editableProps: ['particleCount'],
      hitTest: 'canvas-region',
      box: { x: 100, y: 100, width: 200, height: 120 },
      modificationScope: '仅参数',
    })
    raw.scenes[0].objects.push('obj-canvas')
  })
  const registry = buildObjectRegistry(canvas)
  const record = registry.get('obj-canvas')
  assert.equal(record.hitTest.mode, 'canvas-region')
  assert.equal(record.canvas.regionOnly, true)
  const hit = hitTest(canvas, 60, { x: 150, y: 150 })
  assert.ok(hit.hits.some((entry) => entry.objectId === 'obj-canvas'))
  assert.match(hit.hits.find((entry) => entry.objectId === 'obj-canvas').precisionNote, /粒子/)
})

test('editing a movie object lists every scene it touches and the overlapping scene objects', () => {
  const scope = editScopeOf(plan, 'obj-subtitle-S02')
  assert.equal(scope.scope, 'movie')
  // S02 runs 75–168, so it covers scene A entirely and the first 48 frames of scene B.
  assert.deepEqual(scope.affectedScenes, ['scene-A', 'scene-B'])
  assert.ok(scope.overlappingSceneObjects.includes('obj-sceneA-title'))
  assert.ok(scope.overlappingSceneObjects.includes('obj-existing-video'))
  assert.equal(scope.totalDurationFrames, 270)
  assert.equal(scope.audioProtected, true)
  assert.ok(scope.protected.includes('obj-subtitle-S01'))
})

test('editing a scene object names only its own scene', () => {
  const scope = editScopeOf(plan, 'obj-sceneA-title')
  assert.equal(scope.scope, 'scene')
  assert.deepEqual(scope.affectedScenes, ['scene-A'])
  assert.deepEqual(scope.overlappingSceneObjects, [])
})
