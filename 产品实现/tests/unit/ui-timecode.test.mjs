/**
 * Unit tests for the workbench timecode model.
 *
 * Why these assertions: the UI must never confuse frames with seconds, and a bad timecode must be
 * refused rather than silently moving the playhead somewhere real.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_FPS,
  framesToTimecode,
  timecodeToFrames,
  framesToSeconds,
  formatDuration,
  formatProgress,
  stepFrame,
  percentOf,
  clampFrame,
  normalizeFps,
  SUPPORTED_FPS,
} from '../../ui/client/model/timecode.js'

test('25 fps baseline is the declared default', () => {
  assert.equal(DEFAULT_FPS, 25)
  assert.deepEqual([...SUPPORTED_FPS], [24, 25, 30, 50, 60])
  assert.equal(normalizeFps(0), 25)
  assert.equal(normalizeFps('30'), 30)
  assert.equal(normalizeFps(1000), 25)
})

test('frames render as HH:MM:SS:FF', () => {
  assert.equal(framesToTimecode(0, 25), '00:00:00:00')
  assert.equal(framesToTimecode(25, 25), '00:00:01:00')
  assert.equal(framesToTimecode(25 * 75 + 8, 25), '00:01:15:08')
  assert.equal(framesToTimecode(30 * 3600 + 12, 30), '01:00:00:12')
})

test('timecode parses back to the same frame', () => {
  const samples = [0, 1, 24, 25, 300, 3001, 25 * 45]
  for (const frame of samples) {
    const text = framesToTimecode(frame, 25)
    assert.deepEqual(timecodeToFrames(text, 25), { frame, error: null }, text)
  }
  assert.deepEqual(timecodeToFrames('01:15:08', 25), { frame: 25 * 75 + 8, error: null })
  assert.deepEqual(timecodeToFrames('08:10', 25), { frame: 8 * 25 + 10, error: null })
  assert.deepEqual(timecodeToFrames('12.5s', 25), { frame: 313, error: null })
})

test('invalid timecode is refused with a reason, not guessed', () => {
  assert.equal(timecodeToFrames('', 25).error, '时间码为空')
  assert.match(timecodeToFrames('00:00:00:99', 25).error, /帧需小于 25/)
  assert.match(timecodeToFrames('00:99:00:00', 25).error, /分秒需小于 60/)
  assert.match(timecodeToFrames('abc', 25).error, /格式/)
  assert.equal(timecodeToFrames('abc', 25).frame, 0)
})

test('seconds and duration are labelled as seconds, not timecode', () => {
  assert.equal(framesToSeconds(25, 25), 1)
  assert.equal(formatDuration(80, 25), '3.2s')
  assert.equal(formatProgress(308, 1125, 25), '00:00:12:08 / 00:00:45:00')
})

test('frame stepping clamps at zero and at the end', () => {
  assert.equal(stepFrame(0, -1), 0)
  assert.equal(stepFrame(10, 10, 15), 15)
  assert.equal(stepFrame(10, 2, 100), 12)
  assert.equal(clampFrame(-5), 0)
  assert.equal(clampFrame(4.6), 5)
})

test('percent is bounded and safe on a zero total', () => {
  assert.equal(percentOf(50, 100), 50)
  assert.equal(percentOf(150, 100), 100)
  assert.equal(percentOf(5, 0), 0)
})
