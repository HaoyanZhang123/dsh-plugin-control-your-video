/**
 * Probe facts and the declared-versus-probed discipline.
 * @module media/tests/probe.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { compareDeclaredToProbed, classifyCompatibility, frameCountOf, probeMedia } from '../probe.js'
import { tryToolchain, corpusFile } from './helpers.mjs'

const toolchain = tryToolchain()

test('yuvj420p is reported as a fatal difference from a declared yuv420p', () => {
  const comparison = compareDeclaredToProbed(
    { width: 1280, height: 720, pixelFormat: 'yuv420p', videoCodec: 'h264', fpsNumerator: 30, fpsDenominator: 1 },
    {
      readable: true,
      video: {
        width: 1280,
        height: 720,
        pixelFormat: 'yuvj420p',
        codec: 'h264',
        avgRate: { numerator: 30, denominator: 1, value: 30 },
      },
      audio: null,
      format: { durationSeconds: 9 },
    },
  )
  assert.equal(comparison.ok, false)
  assert.ok(comparison.differences.some((entry) => entry.field === 'pixelFormat'))
  assert.ok(comparison.differences.some((entry) => entry.field === 'pixelFormat-range'))
})

test('a matching result has no fatal differences', () => {
  const comparison = compareDeclaredToProbed(
    {
      width: 1280,
      height: 720,
      pixelFormat: 'yuv420p',
      videoCodec: 'h264',
      fpsNumerator: 30,
      fpsDenominator: 1,
      audioCodec: 'aac',
      sampleRate: 48000,
      channels: 2,
    },
    {
      readable: true,
      video: {
        width: 1280,
        height: 720,
        pixelFormat: 'yuv420p',
        codec: 'h264',
        avgRate: { numerator: 30, denominator: 1, value: 30 },
      },
      audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
      format: { durationSeconds: 9 },
    },
  )
  assert.deepEqual(comparison.differences, [])
  assert.equal(comparison.ok, true)
})

test('the compatibility matrix classifies VFR, rotation, SAR and mono honestly', () => {
  const matrix = classifyCompatibility(
    {
      readable: true,
      video: {
        avgRate: { numerator: 24000, denominator: 1001, value: 23.976 },
        realRate: { numerator: 30000, denominator: 1001, value: 29.97 },
        rotation: 90,
        sar: '4:3',
        hasAlpha: true,
      },
      audio: { sampleRate: 44100, channels: 1 },
    },
    { targetFpsNumerator: 30, targetFpsDenominator: 1 },
  )
  const byItem = Object.fromEntries(matrix.map((entry) => [entry.item, entry.status]))
  assert.equal(byItem['frame-rate'], 'needs-normalization')
  assert.equal(byItem.vfr, 'needs-normalization')
  assert.equal(byItem.rotation, 'needs-normalization')
  assert.equal(byItem.sar, 'needs-normalization')
  assert.equal(byItem.alpha, 'unknown')
  assert.equal(byItem['audio-sample-rate'], 'needs-normalization')
  assert.equal(byItem['audio-channels'], 'needs-normalization')
})

test('an unreadable file yields unsupported instead of a guessed classification', () => {
  const matrix = classifyCompatibility({ readable: false, reason: 'moov atom not found' })
  assert.equal(matrix[0].status, 'unsupported')
})

test('frame count prefers the container value and falls back to rate × duration', () => {
  assert.equal(frameCountOf({ video: { nbFrames: 270, avgRate: { value: 30 } }, format: { durationSeconds: 9 } }), 270)
  assert.equal(frameCountOf({ video: { nbFrames: null, avgRate: { value: 30 } }, format: { durationSeconds: 9 } }), 270)
})

test('probe reads the real corpus video', { skip: toolchain === null || corpusFile('video', 'src-existing-1280x720-30fps-12s.mp4') === null }, () => {
  const probed = probeMedia(toolchain.ffprobe.path, corpusFile('video', 'src-existing-1280x720-30fps-12s.mp4'))
  assert.equal(probed.readable, true)
  assert.equal(probed.video.width, 1280)
  assert.equal(probed.video.height, 720)
  assert.equal(probed.video.avgRate.value, 30)
  assert.equal(frameCountOf(probed), 360)
})
