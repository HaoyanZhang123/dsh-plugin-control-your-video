/**
 * Sound manifest: real durations, subtitle windows, no word-level control.
 * @module media/tests/sound.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSoundManifest,
  subtitleWindows,
  checkSubtitleAudioRelation,
  describeAudioCoverage,
  describeSoundTruth,
  compareAudioIdentity,
  secondsToFrames,
  assertNoWordLevel,
} from '../sound.js'
import { buildC12UnitPlan } from '../fixtures/c12-unit.js'
import { fontFile } from './helpers.mjs'
import { normalizePlan } from '../plan.js'

const plan = () => normalizePlan(buildC12UnitPlan({ fontFile: fontFile() }), { now: () => 'x' })

test('durations come from the probe and are converted with a recorded rule', async () => {
  const durations = { 'a.wav': 2.4, 'b.wav': 3.1, 'c.wav': 2.0 }
  const manifest = await buildSoundManifest({
    copyId: 'copy',
    copyVersion: 'v1',
    rate: { fpsNumerator: 30, fpsDenominator: 1, gapFrames: 3 },
    segments: [
      { paragraphId: 'S01', text: '一', audioPath: 'a.wav' },
      { paragraphId: 'S02', text: '二', audioPath: 'b.wav' },
      { paragraphId: 'S03', text: '三', audioPath: 'c.wav' },
    ],
    probeDurationSeconds: async (file) => durations[file],
  })
  assert.deepEqual(manifest.segments.map((segment) => segment.actualDurationFrames), [72, 93, 60])
  assert.deepEqual(manifest.segments.map((segment) => segment.authoredStartFrame), [0, 75, 171])
  assert.equal(manifest.segments[0].conversionRule, 'round-half-up at plan fps, recorded with the probe value')
  assert.equal(manifest.truth.wordLevel, false)
})

test('a probe failure refuses to fall back to estimating from text length', async () => {
  await assert.rejects(
    buildSoundManifest({
      copyId: 'copy',
      copyVersion: 'v1',
      rate: { fpsNumerator: 30, fpsDenominator: 1 },
      segments: [{ paragraphId: 'S01', text: '很长的一句话', audioPath: 'missing.wav' }],
      probeDurationSeconds: async () => 0,
    }),
    /不能按字数估算/,
  )
})

test('subtitle windows match the plan and a drift is reported, not auto-fixed', () => {
  const base = plan()
  assert.deepEqual(checkSubtitleAudioRelation(base).problems, [])
  const drifted = JSON.parse(JSON.stringify(base))
  drifted.objects.find((object) => object.id === 'obj-subtitle-S02').timeline.durationFrames = 88
  const problems = checkSubtitleAudioRelation(drifted).problems
  assert.ok(problems.some((problem) => problem.code === 'subtitle-duration-drift'))
})

test('a subtitle for an undeclared paragraph is reported', () => {
  const mutated = plan()
  mutated.objects.find((object) => object.id === 'obj-subtitle-S01').derivedFrom.lockedCopy = 'locked-lines-v1.json#S99'
  const problems = checkSubtitleAudioRelation(mutated).problems
  assert.ok(problems.some((problem) => problem.code === 'subtitle-undeclared'))
})

test('word-level data is refused outright', () => {
  assert.throws(() => assertNoWordLevel({ segments: [{ paragraphId: 'S01', wordLevel: [{ text: 'a' }] }] }), /wordLevel/)
  assert.equal(assertNoWordLevel({ segments: [{ paragraphId: 'S01', wordLevel: null }] }), true)
})

test('audio coverage is complete for the unit and a gap is measured', () => {
  const base = plan()
  const coverage = describeAudioCoverage(base)
  assert.equal(coverage.audioTracks, 1)
  assert.equal(coverage.coveredFrames, 270)
  assert.deepEqual(coverage.gaps, [])
  const gapped = JSON.parse(JSON.stringify(base))
  gapped.objects.find((object) => object.id === 'obj-audio-main').timeline.durationFrames = 240
  const gappedCoverage = describeAudioCoverage(gapped)
  assert.deepEqual(gappedCoverage.gaps, [{ startFrame: 240, endFrameExclusive: 270 }])
})

test('a silent work is reported as intentional, not as missing audio', () => {
  const base = plan()
  const silent = JSON.parse(JSON.stringify(base))
  silent.objects = silent.objects.filter((object) => object.kind !== 'audio-continuous')
  silent.tracks = silent.tracks.filter((track) => track.id !== 'track-audio')
  silent.soundManifest = null
  silent.soundIntent = 'silent'
  const coverage = describeAudioCoverage(silent)
  assert.equal(coverage.silentByIntent, true)
  assert.equal(coverage.audioTracks, 0)
  assert.equal(describeSoundTruth(null).silentWork, true)
})

test('a repair that touches a subtitle leaves the audio identity unchanged', () => {
  const before = plan()
  const after = JSON.parse(JSON.stringify(before))
  after.objects.find((object) => object.id === 'obj-subtitle-S02').params.text = '改过'
  const same = compareAudioIdentity(before, after)
  assert.equal(same.identical, true)
  const resampled = JSON.parse(JSON.stringify(before))
  resampled.objects.find((object) => object.id === 'obj-audio-main').params.volume = 0.5
  assert.equal(compareAudioIdentity(before, resampled).identical, false)
})

test('seconds to frames uses half-up rounding and returns its rule', () => {
  assert.deepEqual(secondsToFrames(2.4, 30, 1), { frames: 72, exact: 72, rule: 'round-half-up at plan fps, recorded with the probe value' })
  assert.equal(secondsToFrames(3.1, 30, 1).frames, 93)
  assert.equal(secondsToFrames(2.0, 30, 1).frames, 60)
})
