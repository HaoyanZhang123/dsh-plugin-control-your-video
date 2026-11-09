/**
 * TimeRemapSpec: speed keys, holds, inverse lookup and the audio rule.
 * @module media/tests/remap.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTimeRemap, assertAudioKeepsMovieTime, describeAudioTimeTruth } from '../remap.js'
import { buildC12UnitPlan } from '../fixtures/c12-unit.js'
import { fontFile } from './helpers.mjs'
import { normalizePlan } from '../plan.js'

const constantOne = () =>
  createTimeRemap({ id: 'remap-1', mode: 'constant', speedKeys: [{ atSceneFrame: 0, speed: 1 }], sceneFrames: 300 })

test('speed 1 leaves movie time equal to scene time', () => {
  const remap = constantOne()
  assert.equal(remap.movieFramesAt(0), 0)
  assert.equal(remap.movieFramesAt(120), 120)
  assert.equal(remap.movieFramesAt(300), 300)
  assert.equal(remap.sceneFramesAt(120), 120)
  assert.equal(remap.totalMovieFrames, 300)
})

test('a linear ramp integrates the trapezoid, not the endpoint speed', () => {
  const remap = createTimeRemap({
    id: 'remap-ramp',
    mode: 'continuous',
    speedKeys: [
      { atSceneFrame: 0, speed: 1, interpolation: 'linear' },
      { atSceneFrame: 100, speed: 2, interpolation: 'linear' },
    ],
    sceneFrames: 100,
  })
  // Average speed over the ramp is 1.5, so 100 scene frames become 150 movie frames.
  assert.equal(remap.movieFramesAt(100), 150)
  assert.equal(remap.speedAt(50), 1.5)
  assert.equal(remap.movieFramesAt(50), 62.5)
})

test('a step key holds its speed until the next key', () => {
  const remap = createTimeRemap({
    id: 'remap-step',
    mode: 'constant',
    speedKeys: [
      { atSceneFrame: 0, speed: 0.5, interpolation: 'step' },
      { atSceneFrame: 100, speed: 1, interpolation: 'step' },
    ],
    sceneFrames: 200,
  })
  assert.equal(remap.movieFramesAt(100), 50)
  assert.equal(remap.movieFramesAt(200), 150)
  assert.equal(remap.speedAt(99), 0.5)
  assert.equal(remap.speedAt(100), 1)
})

test('speed 0 is a real hold, and the movie clock stops advancing', () => {
  const remap = createTimeRemap({
    id: 'remap-hold',
    mode: 'hold',
    speedKeys: [
      { atSceneFrame: 0, speed: 1, interpolation: 'step' },
      { atSceneFrame: 60, speed: 0, interpolation: 'step' },
      { atSceneFrame: 90, speed: 1, interpolation: 'step' },
    ],
    sceneFrames: 150,
  })
  assert.equal(remap.movieFramesAt(60), 60)
  assert.equal(remap.movieFramesAt(75), 60, '保持期间影片时间不前进')
  assert.equal(remap.movieFramesAt(90), 60)
  assert.equal(remap.movieFramesAt(150), 120)
  assert.equal(remap.isHoldAt(75), true)
  assert.equal(remap.isHoldAt(30), false)
  assert.deepEqual(remap.describe().holdsAt, [60])
})

test('the inverse map finds the scene frame shown at a movie frame', () => {
  const remap = createTimeRemap({
    id: 'remap-inverse',
    mode: 'continuous',
    speedKeys: [
      { atSceneFrame: 0, speed: 1, interpolation: 'linear' },
      { atSceneFrame: 60, speed: 2, interpolation: 'linear' },
      { atSceneFrame: 120, speed: 1, interpolation: 'linear' },
    ],
    sceneFrames: 120,
  })
  for (const sceneFrame of [0, 30, 60, 90, 120]) {
    const movieFrame = remap.movieFrameAt(sceneFrame)
    const back = remap.sceneFrameAt(movieFrame)
    assert.ok(Math.abs(back - sceneFrame) <= 1, `场景帧 ${sceneFrame} 反查得到 ${back}`)
  }
})

test('named scene events resolve to movie frames with the speed at that point', () => {
  const remap = createTimeRemap({
    id: 'remap-events',
    mode: 'continuous',
    speedKeys: [
      { atSceneFrame: 0, speed: 1, interpolation: 'linear' },
      { atSceneFrame: 60, speed: 2, interpolation: 'linear' },
    ],
    sceneFrames: 60,
  })
  const events = remap.resolveEvents([
    { label: '频率突变 1', sceneFrame: 30 },
    { label: '频率突变 2', sceneFrame: 60 },
  ])
  assert.deepEqual(events.map((event) => event.movieFrame), [37, 90])
  assert.equal(events[0].speed, 1.5)
})

test('reverse is refused unless the runtime really supports it', () => {
  assert.throws(
    () => createTimeRemap({ id: 'rev', mode: 'reverse', speedKeys: [{ atSceneFrame: 0, speed: -1 }], sceneFrames: 10 }),
    /不支持反向/,
  )
  // Even when the caller claims support, a negative map is still refused downstream: this runtime
  // has no reverse implementation, and pretending otherwise would produce nonsense frame lookups.
  assert.throws(
    () =>
      createTimeRemap({
        id: 'rev-claimed',
        mode: 'reverse',
        supportsReverse: true,
        speedKeys: [{ atSceneFrame: 0, speed: -1 }],
        sceneFrames: 60,
      }),
    /负的影片时长/,
  )
})

test('a speed profile that makes movie time run backwards is refused', () => {
  // Total is negative: the plan would ask for a movie that ends before it starts.
  assert.throws(
    () =>
      createTimeRemap({
        id: 'bad-negative',
        mode: 'continuous',
        speedKeys: [
          { atSceneFrame: 0, speed: 1, interpolation: 'linear' },
          { atSceneFrame: 30, speed: -1, interpolation: 'linear' },
        ],
        sceneFrames: 60,
      }),
    /负的影片时长/,
  )
  // Total is zero but the mapping is non-monotone: an inverse lookup would be ambiguous.
  assert.throws(
    () =>
      createTimeRemap({
        id: 'bad-nonmonotone',
        mode: 'continuous',
        speedKeys: [
          { atSceneFrame: 0, speed: 2, interpolation: 'linear' },
          { atSceneFrame: 30, speed: -1, interpolation: 'linear' },
          { atSceneFrame: 60, speed: 0, interpolation: 'linear' },
        ],
        sceneFrames: 60,
      }),
    /倒退/,
  )
})

test('a first key that does not start at scene frame 0 is refused', () => {
  assert.throws(
    () => createTimeRemap({ id: 'late', mode: 'constant', speedKeys: [{ atSceneFrame: 10, speed: 1 }], sceneFrames: 60 }),
    /第一个速度键/,
  )
})

test('time remapping may not touch the audio track', () => {
  const plan = normalizePlan(buildC12UnitPlan({ fontFile: fontFile() }), { now: () => 'x' })
  assert.throws(() => assertAudioKeepsMovieTime(plan, { targetObjectRef: 'obj-audio-main' }), /音轨/)
  const ok = assertAudioKeepsMovieTime(plan, { targetObjectRef: 'obj-existing-video' })
  assert.equal(ok.untouched, true)
  assert.deepEqual(ok.audioObjects, ['obj-audio-main'])
  const truth = describeAudioTimeTruth(plan.soundManifest)
  assert.equal(truth.wordLevel, false)
  assert.equal(truth.granularity, 'segment')
})
