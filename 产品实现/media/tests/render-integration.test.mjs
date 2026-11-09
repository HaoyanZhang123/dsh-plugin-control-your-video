/**
 * Integration: the real unit goes through the real adapter with real FFmpeg.
 *
 * These tests are the ones that can fail because the product is wrong, not because a mock disagrees
 * with itself. They skip (with a reason) when FFmpeg or the C02 corpus is absent, and never pretend
 * a skipped check passed.
 *
 * @module media/tests/render-integration
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildC12UnitPlan, buildC02SourceVariant } from '../fixtures/c12-unit.js'
import { normalizePlan, diffPlans } from '../plan.js'
import { createFfmpegAdapter } from '../render/ffmpeg-adapter.js'
import { probeMedia, frameCountOf } from '../probe.js'
import { checkRepairProtection, checkAudioSync } from '../render/checks.js'
import { extractAudioPcm } from '../verify.js'
import { createRepairOperation, repairRegionPlan } from '../ops/repair.js'
import { createAdaptOperation } from '../ops/adapt.js'
import { checkSubtitleAudioRelation } from '../sound.js'
import { corpusRoot, corpusFile, fontFile, tryToolchain, frozenClock, makeTempDir, cleanup } from './helpers.mjs'

const toolchain = tryToolchain()
const videoMaterial = corpusFile('video', 'src-existing-1280x720-30fps-12s.mp4')
const audioMaterial = corpusFile('audio', 'user-audio-continuous-9s-48k-stereo.wav')
const available = toolchain !== null && videoMaterial !== null && audioMaterial !== null && fs.existsSync(fontFile())
const skip = available ? false : '需要 FFmpeg 与 C02 固定语料；当前环境缺失，本测试如实跳过而不是假装通过'

const workRoot = available ? makeTempDir('c12-integration-') : null
const clock = frozenClock()
const rawPlan = available ? buildC12UnitPlan({ fontFile: fontFile() }) : null
const plan = available ? normalizePlan(rawPlan, { now: () => clock.iso() }) : null
const adapter = available
  ? createFfmpegAdapter({ toolchain, workRoot, clock, materialRoot: corpusRoot() })
  : null
const outDir = available ? path.join(workRoot, 'out') : null
if (outDir !== null) fs.mkdirSync(outDir, { recursive: true })

test.after(() => {
  if (workRoot !== null) cleanup(workRoot)
})

test('the unit validates against the adapter capabilities', { skip }, () => {
  const validated = adapter.validatePlan(plan)
  assert.equal(validated.ok, true, JSON.stringify(validated.problems))
  assert.ok(validated.capabilities.objectKinds.includes('program-pattern'))
  assert.ok(!validated.capabilities.objectKinds.includes('canvas-program-animation'))
})

test('the C02 Canvas object is refused with a nameable reason and a remedy', { skip }, () => {
  const variant = buildC02SourceVariant(rawPlan)
  const validated = adapter.validatePlan(variant)
  assert.equal(validated.ok, false)
  const problem = validated.problems.find((entry) => entry.code === 'object-kind-unsupported')
  assert.ok(problem, '必须报告不支持的对象类型')
  assert.match(problem.detail, /canvas-program-animation/)
  assert.ok(problem.remedy.length > 0)
})

test('a real render produces 270 frames, 9 s and the declared pixel format', { skip }, () => {
  const result = adapter.renderFinal(plan, plan.outputSpec, { outputPath: path.join(outDir, 'final.mp4') })
  assert.equal(result.specComparison.ok, true, JSON.stringify(result.specComparison.differences))
  const probed = probeMedia(toolchain.ffprobe.path, result.file)
  assert.equal(probed.video.width, 1280)
  assert.equal(probed.video.height, 720)
  assert.equal(probed.video.pixelFormat, 'yuv420p')
  assert.equal(frameCountOf(probed), 270)
  assert.ok(Math.abs(probed.format.durationSeconds - 9) < 0.05)
  assert.equal(probed.audio.sampleRate, 48000)
  assert.equal(probed.audio.channels, 2)
  assert.ok(result.sha256.length === 64)
})

test('the same plan rendered again is byte identical and reuses the cache', { skip }, () => {
  const first = adapter.renderFinal(plan, plan.outputSpec, { outputPath: path.join(outDir, 'det-a.mp4') })
  const second = adapter.renderFinal(plan, plan.outputSpec, { outputPath: path.join(outDir, 'det-b.mp4') })
  assert.equal(first.sha256, second.sha256)
  assert.equal(second.execution.cache, 'warm')
})

test('an existing output is never silently overwritten', { skip }, () => {
  const target = path.join(outDir, 'det-a.mp4')
  assert.throws(() => adapter.renderFinal(plan, plan.outputSpec, { outputPath: target }), /不覆盖旧结果/)
})

test('the audio in the finished file still carries the 3 s and 6 s events in place', { skip }, () => {
  const result = adapter.renderFinal(plan, plan.outputSpec, { outputPath: path.join(outDir, 'audio-check.mp4') })
  const sync = checkAudioSync({
    adapter,
    plan,
    result,
    sourceAudioFile: audioMaterial,
    expectedEventSeconds: [3.0, 6.0],
  })
  assert.equal(sync.mode, 'frequency-events')
  assert.equal(sync.events.length, 2)
  assert.ok(sync.maxDeltaMs <= 34, `频率事件偏移 ${sync.maxDeltaMs} ms 超过一帧`)
  assert.equal(sync.ok, true)
})

test('a subtitle repair changes only its own region and keeps the audio bytes', { skip }, () => {
  const base = adapter.renderFinal(plan, plan.outputSpec, { outputPath: path.join(outDir, 'repair-base.mp4') })
  const { operation, plan: repaired } = createRepairOperation({
    basePlan: plan,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '程序视觉、已有素材与用户音频，在同一条时间线上协作。（修订）' },
  })
  assert.deepEqual(operation.diff.changedObjectIds, ['obj-subtitle-S02'])
  assert.equal(operation.verdict.ok, true)
  assert.deepEqual(checkSubtitleAudioRelation(repaired).problems, [])

  const changed = adapter.renderFinal(repaired, repaired.outputSpec, { outputPath: path.join(outDir, 'repair-changed.mp4') })
  const baseAudio = extractAudioPcm({ ffmpegPath: adapter.ffmpegPath, file: base.file, sampleRate: 48000, channels: 2 })
  const changedAudio = extractAudioPcm({
    ffmpegPath: adapter.ffmpegPath,
    file: changed.file,
    sampleRate: 48000,
    channels: 2,
  })
  assert.equal(baseAudio.sha256, changedAudio.sha256, '字幕修复不得改变音轨')

  const regions = repairRegionPlan(plan, repaired, { targetObjectId: 'obj-subtitle-S02', frame: 100 })
  const protection = checkRepairProtection({
    adapter,
    beforePlan: plan,
    afterPlan: repaired,
    regions: { ...regions, frames: [100] },
    media: { beforeAudioSha256: baseAudio.sha256, afterAudioSha256: changedAudio.sha256 },
  })
  assert.equal(protection.targetChangedEverywhere, true)
  assert.equal(protection.neighboursProtectedEverywhere, true)
  assert.equal(protection.audio.identical, true)
})

test('a second aspect re-lays out the unit and preserves duration, source offset and audio', { skip }, () => {
  const { plan: adapted, layout, preserved } = createAdaptOperation({
    basePlan: plan,
    target: { width: 1080, height: 1920 },
  })
  assert.equal(adapted.outputSpec.width, 1080)
  assert.equal(adapted.outputSpec.height, 1920)
  const title = adapted.objects.find((object) => object.id === 'obj-sceneB-title')
  assert.equal(title.params.fontSize, 44, '字号按短边缩放，不是按宽度拉伸')
  assert.equal(adapted.adaptation.scaleX, 0.84375)
  assert.equal(adapted.adaptation.scaleY, 2.666667)
  assert.equal(preserved.durationFrames.identical, true)
  assert.equal(preserved.audio.identical, true)
  assert.ok(preserved.sourceOffsets.every((entry) => entry.identical))
  assert.ok(layout.moves.length > 0)

  const result = adapter.renderFinal(adapted, adapted.outputSpec, { outputPath: path.join(outDir, 'adapt.mp4') })
  const probed = probeMedia(toolchain.ffprobe.path, result.file)
  assert.equal(probed.video.width, 1080)
  assert.equal(probed.video.height, 1920)
  assert.equal(frameCountOf(probed), 270)
})

test('a source offset that runs past the source is refused by validation, not silently truncated', { skip }, () => {
  const broken = JSON.parse(JSON.stringify(plan))
  broken.planVersion = '9.9.9'
  broken.objects.find((object) => object.id === 'obj-existing-video').authored.sourceOffsetFrames = 340
  const normalized = normalizePlan(broken, { now: () => clock.iso() })
  const validated = adapter.validatePlan(normalized)
  assert.equal(validated.ok, false)
  const problem = validated.problems.find((entry) => entry.code === 'source-range-exceeded')
  assert.ok(problem, '必须报告源范围越界')
  assert.match(problem.detail, /源文件只有 12\.000s/)
  assert.throws(
    () => adapter.renderFinal(normalized, normalized.outputSpec, { outputPath: path.join(outDir, 'broken.mp4') }),
    /未通过本适配器校验/,
  )
})
