/**
 * Timeline queries: geometry, transition participants and source mapping.
 * @module media/tests/timeline.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildC12UnitPlan } from '../fixtures/c12-unit.js'
import { fontFile } from './helpers.mjs'
import { normalizePlan } from '../plan.js'
import {
  activeObjectsAt,
  checkTransitionCoverage,
  formatTimecode,
  mapMovieFrameToSource,
  mergeFrameRanges,
  objectWindow,
  scenesAt,
  sourceRangeOf,
  transitionAt,
  transitionParticipants,
  uncoveredFrameRanges,
  isVisibleAt,
} from '../timeline.js'

const normalize = (mutate) => {
  const raw = buildC12UnitPlan({ fontFile: fontFile() })
  if (mutate) mutate(raw)
  return normalizePlan(raw, { now: () => '2026-11-09T00:00:00.000Z' })
}
const plan = normalize()

test('the overlap window is [120, 150) and two scenes are visible there', () => {
  const cover = transitionAt(plan, 130)
  assert.equal(cover.id, 'obj-transition-crossfade')
  assert.equal(cover.startFrame, 120)
  assert.equal(cover.endFrameExclusive, 150)
  assert.deepEqual(scenesAt(plan, 130).map((scene) => scene.id), ['scene-A', 'scene-B'])
  assert.deepEqual(scenesAt(plan, 100).map((scene) => scene.id), ['scene-A'])
  assert.equal(transitionAt(plan, 100), null)
})

test('movie-level objects never join transition participants (CT-04 v1.1 §2.1)', () => {
  const participants = transitionParticipants(plan, 'obj-transition-crossfade')
  const ids = participants.participants.map((entry) => entry.id)
  assert.ok(!ids.includes('obj-subtitle-S02'), '跨切点字幕是影片级对象，不参与转场淡出')
  assert.ok(!ids.includes('obj-audio-main'), '连续音轨不参与转场淡出')
  for (const entry of participants.participants) assert.equal(entry.side.startsWith('scene'), true)
  // It is still visible inside the overlap; not fading is the point, not invisibility.
  assert.equal(isVisibleAt(plan, 'obj-subtitle-S02', 130), true)
  assert.equal(isVisibleAt(plan, 'obj-audio-main', 130), true)
})

test('adding a scene object inside the overlap automatically joins the participant set', () => {
  const mutated = normalize((raw) => {
    raw.objects.push({
      id: 'obj-sceneA-sticker',
      kind: 'text-native',
      semanticRole: '新增场景内标记',
      scope: 'scene',
      sceneId: 'scene-A',
      timeline: { startFrame: 100, durationFrames: 40 },
      params: { text: '新增标记', fontSize: 28 },
      editableProps: ['text', 'fontSize'],
      hitTest: 'text-box',
      box: { x: 100, y: 100, width: 300, height: 60 },
      modificationScope: '仅该标记',
    })
    raw.scenes[0].objects.push('obj-sceneA-sticker')
  })
  const participants = transitionParticipants(mutated, 'obj-transition-crossfade').participants.map(
    (entry) => entry.id,
  )
  assert.ok(participants.includes('obj-sceneA-sticker'))
  assert.deepEqual(checkTransitionCoverage(mutated), [])
})

test('a movie subtitle added inside the overlap stays out of the participant set', () => {
  const mutated = normalize((raw) => {
    raw.objects.push({
      id: 'obj-subtitle-cross',
      kind: 'subtitle',
      semanticRole: '新增跨切点字幕',
      scope: 'movie',
      timeline: { startFrame: 140, durationFrames: 40 },
      derivedFrom: { lockedCopy: 'locked-lines-v1.json#S09', audio: 'audio/s01.wav' },
      params: { text: '临时新增的影片级字幕' },
      editableProps: ['text'],
      hitTest: 'text-box',
      box: { x: 100, y: 590, width: 1080, height: 76 },
      modificationScope: '仅该字幕',
    })
    raw.tracks.find((track) => track.id === 'track-subtitles').objectIds.push('obj-subtitle-cross')
  })
  const participants = transitionParticipants(mutated, 'obj-transition-crossfade').participants.map(
    (entry) => entry.id,
  )
  assert.ok(!participants.includes('obj-subtitle-cross'))
  assert.deepEqual(checkTransitionCoverage(mutated), [])
})

test('an under-declared participant list is reported as missing coverage', () => {
  const mutated = normalize((raw) => {
    raw.transitions[0].participants = ['obj-sceneA-bg', 'obj-sceneB-bg']
  })
  const problems = checkTransitionCoverage(mutated)
  assert.ok(problems.some((problem) => problem.code === 'participant-missing'))
  assert.ok(problems.some((problem) => problem.code === 'participant-extra') === false)
})

test('movie frame 200 maps to source frame 170 with a 90-frame in-point', () => {
  const mapped = mapMovieFrameToSource(plan, 'obj-existing-video', 200)
  assert.equal(mapped.inObjectFrames, 80)
  assert.equal(mapped.sourceFrame, 170)
  assert.equal(mapped.sourceSeconds, 5.666667)
  const atStart = mapMovieFrameToSource(plan, 'obj-existing-video', 120)
  assert.equal(atStart.sourceFrame, 90)
  assert.deepEqual(sourceRangeOf(plan, 'obj-existing-video'), {
    startSeconds: 3,
    durationSeconds: 5,
    endSeconds: 8,
  })
})

test('a frame before the object start has no source frame and is refused', () => {
  assert.throws(() => mapMovieFrameToSource(plan, 'obj-existing-video', 100), /早于对象起点/)
})

test('the same movie frame maps to a different source frame at 23.976 fps', () => {
  const mapped = mapMovieFrameToSource(plan, 'obj-existing-video', 200, { fpsNumerator: 24000, fpsDenominator: 1001 })
  // 3 s in-point + 80 plan frames at 30 fps = 17/3 s; at 23.976 fps that is 135.8641…, i.e. source frame 135.
  assert.ok(Math.abs(mapped.sourceFrameExact - (17 / 3) * (24000 / 1001)) < 1e-6, '用精确有理数换算，不用四舍五入后的秒数')
  assert.equal(mapped.sourceFrame, 135)
})

test('visibility is half-open: a 1-frame object is gone on the next frame', () => {
  assert.equal(isVisibleAt(plan, 'obj-subtitle-S01', 0), true)
  assert.equal(isVisibleAt(plan, 'obj-subtitle-S01', 72), false)
  assert.deepEqual(objectWindow(plan, 'obj-subtitle-S01'), { startFrame: 0, endFrameExclusive: 72 })
})

test('draw order puts movie-level subtitles above scene content', () => {
  const ids = activeObjectsAt(plan, 130).map((object) => object.id)
  assert.ok(ids.indexOf('obj-subtitle-S02') > ids.indexOf('obj-existing-video'))
  assert.ok(ids.indexOf('obj-audio-main') > ids.indexOf('obj-subtitle-S02'))
})

test('timecode formatting is frame accurate at 30 fps', () => {
  assert.equal(formatTimecode(0, 30, 1), '00:00:00:00')
  assert.equal(formatTimecode(269, 30, 1), '00:00:08:29')
  assert.equal(formatTimecode(150, 30, 1), '00:00:05:00')
})

test('frame ranges merge and the uncovered range is the exact complement', () => {
  const merged = mergeFrameRanges(plan, [
    { startFrame: 10, endFrameExclusive: 20 },
    { startFrame: 15, endFrameExclusive: 30 },
    { startFrame: 100, endFrameExclusive: 400 },
  ])
  assert.deepEqual(merged, [
    { startFrame: 10, endFrameExclusive: 30 },
    { startFrame: 100, endFrameExclusive: 270 },
  ])
  assert.deepEqual(uncoveredFrameRanges(plan, merged), [
    { startFrame: 0, endFrameExclusive: 10 },
    { startFrame: 30, endFrameExclusive: 100 },
  ])
})
