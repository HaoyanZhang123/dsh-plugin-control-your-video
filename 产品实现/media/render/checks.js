/**
 * Semantic checks on real results: the things a successful exit code cannot prove.
 *
 * Contract (CT-06 §7, CT-05 §7): the pre-encode frame and the decoded frame are compared separately;
 * a repair is proven by region-level comparison of the pre-encode source frames of both versions; a
 * second aspect is proven to be re-laid-out rather than stretched; and the audio is proven to be the
 * same user audio on the same movie timeline, not merely "a track exists".
 *
 * @module media/render/checks
 */

import { frameSizeOf } from '../objects.js'
import { probeMedia } from '../probe.js'
import {
  audioEnvelope,
  bestEnvelopeLag,
  comparePreEncodeToDecoded,
  decodeFrames,
  extractAudioPcm,
  frameDiff,
  isWithinTolerance,
  sha256,
} from '../verify.js'

/** A region "really changed" when it moves more than this. */
export const REGION_CHANGE_MIN_MEAN_ABS = 3
export const REGION_CHANGE_MIN_RATIO = 0.01

/**
 * Count runs of similar colours along one scan line.
 *
 * Used to prove a cover-fit reframe is a re-crop and not a stretch: an eight-bar chart still shows
 * eight bars when stretched, but only the bars inside the crop window when re-framed.
 *
 * @param {Buffer} rgb24
 * @param {{ width: number, y: number, tolerance?: number }} input
 */
export function countColorRuns(rgb24, input) {
  const tolerance = input.tolerance ?? 28
  const { width, y } = input
  let runs = 0
  let previous = null
  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3
    const pixel = [rgb24[offset], rgb24[offset + 1], rgb24[offset + 2]]
    if (
      previous === null ||
      Math.abs(pixel[0] - previous[0]) > tolerance ||
      Math.abs(pixel[1] - previous[1]) > tolerance ||
      Math.abs(pixel[2] - previous[2]) > tolerance
    ) {
      runs += 1
      previous = pixel
    }
  }
  return runs
}

/**
 * Check a freshly rendered file: frames, spec, first frame against its own pre-encode frame, and
 * audio presence/duration. Every unverifiable item is reported as `not-checked`, never as `ok`.
 *
 * @param {object} input
 * @param {any} input.adapter
 * @param {any} input.plan
 * @param {any} input.result
 * @param {{ frames?: number[], expectsAudio?: boolean }} [input.options]
 */
export function checkRenderedResult(input) {
  const plan = input.plan
  const result = input.result
  const shape = frameSizeOf(plan)
  const adapter = input.adapter
  const probed = probeMedia(adapter.ffprobePath, result.file)
  const frames = input.options?.frames ?? [0, Math.floor(plan.timebase.totalFrames / 2), plan.timebase.totalFrames - 1]
  const checks = []

  checks.push({
    id: 'frame-count',
    status: probed.video?.nbFrames === plan.timebase.totalFrames ? 'ok' : 'failed',
    detail: `${String(probed.video?.nbFrames)} 帧（计划 ${plan.timebase.totalFrames} 帧）`,
  })

  const expectedDuration = Number(
    ((plan.timebase.totalFrames * plan.timebase.fpsDenominator) / plan.timebase.fpsNumerator).toFixed(6),
  )
  const durationOk = Math.abs((probed.format.durationSeconds ?? 0) - expectedDuration) <= 0.05
  checks.push({
    id: 'duration',
    status: durationOk ? 'ok' : 'failed',
    detail: `${String(probed.format.durationSeconds)}s（计划 ${expectedDuration}s，容差 50ms）`,
  })

  // Pre-encode vs decoded, frame by frame.
  const decoded = decodeFrames({
    ffmpegPath: adapter.ffmpegPath,
    file: result.file,
    frames,
    width: shape.width,
    height: shape.height,
  })
  const frameComparisons = []
  for (const frame of frames) {
    const preEncode = adapter.renderStillRaw(plan, frame)
    const comparison = comparePreEncodeToDecoded({
      preEncode: preEncode.rgb24,
      decoded: decoded.get(frame),
      shape,
    })
    frameComparisons.push({ frame, ...comparison, preEncodeSha256: preEncode.sha256 })
  }
  checks.push({
    id: 'pre-encode-vs-decoded',
    status: frameComparisons.every((entry) => entry.withinTolerance) ? 'ok' : 'failed',
    detail: frameComparisons
      .map((entry) => `帧 ${entry.frame}: 均值 ${entry.meanAbsolute} / p95 ${entry.p95Absolute}`)
      .join('；'),
    frames: frameComparisons,
  })

  const hasAudio = probed.audio !== null && probed.audio !== undefined
  const expectsAudio = input.options?.expectsAudio ?? plan.objects.some((object) => object.kind === 'audio-continuous')
  checks.push({
    id: 'audio-presence',
    status: hasAudio === expectsAudio ? 'ok' : 'failed',
    detail: hasAudio ? '存在音频流' : '没有音频流',
  })

  const audio = hasAudio
    ? extractAudioPcm({ ffmpegPath: adapter.ffmpegPath, file: result.file, sampleRate: 48000, channels: 2 })
    : null

  return {
    probed,
    decodedFrames: Object.fromEntries([...decoded.entries()].map(([frame, buffer]) => [frame, sha256(buffer)])),
    frameComparisons,
    audioPcmSha256: audio === null ? null : audio.sha256,
    checks,
    ok: checks.every((check) => check.status === 'ok' || check.status === 'not-checked'),
    failed: checks.filter((check) => check.status === 'failed').map((check) => check.id),
  }
}

/**
 * Prove a repair changed only its target.
 *
 * The comparison uses pre-encode frames of BOTH versions, so codec noise or a different GOP cannot
 * be mistaken for a semantic change (CT-05 §7).
 *
 * @param {object} input
 * @param {any} input.adapter
 * @param {any} input.beforePlan
 * @param {any} input.afterPlan
 * @param {{ targetRegion: any, neighbours?: Array<{ objectId: string, region: any }>, frames: number[] }} input.regions
 * @param {{ beforeSha256?: string, afterSha256?: string, beforeAudioSha256?: string|null, afterAudioSha256?:
 * string|null }} [input.media]
 */
export function checkRepairProtection(input) {
  const shapeBefore = frameSizeOf(input.beforePlan)
  const shapeAfter = frameSizeOf(input.afterPlan)
  if (shapeBefore.width !== shapeAfter.width || shapeBefore.height !== shapeAfter.height) {
    throw new Error('修复前后画幅不同，区域对照不成立')
  }
  const perFrame = []
  for (const frame of input.regions.frames) {
    const before = input.adapter.renderStillRaw(input.beforePlan, frame)
    const after = input.adapter.renderStillRaw(input.afterPlan, frame)
    const target = frameDiff(before.rgb24, after.rgb24, { ...shapeBefore, region: input.regions.targetRegion })
    const neighbours = (input.regions.neighbours ?? []).map((neighbour) => ({
      objectId: neighbour.objectId,
      ...frameDiff(before.rgb24, after.rgb24, { ...shapeBefore, region: neighbour.region }),
    }))
    const targetChanged =
      target.meanAbsolute >= REGION_CHANGE_MIN_MEAN_ABS || target.changedRatio >= REGION_CHANGE_MIN_RATIO
    const neighboursProtected = neighbours.every((entry) => isWithinTolerance(entry))
    perFrame.push({
      frame,
      target: { ...target, changed: targetChanged },
      neighbours: neighbours.map((entry) => ({ ...entry, protected: isWithinTolerance(entry) })),
      neighboursProtected,
      beforeSha256: before.sha256,
      afterSha256: after.sha256,
    })
  }
  const audio =
    input.media?.beforeAudioSha256 === undefined || input.media?.afterAudioSha256 === undefined
      ? { checked: false, note: '没有提供两版音频哈希，未检查音轨保护' }
      : {
          checked: true,
          identical: input.media.beforeAudioSha256 === input.media.afterAudioSha256,
          before: input.media.beforeAudioSha256,
          after: input.media.afterAudioSha256,
        }
  const targetChangedEverywhere = perFrame.every((entry) => entry.target.changed)
  const neighboursProtectedEverywhere = perFrame.every((entry) => entry.neighboursProtected)
  return {
    frames: perFrame,
    targetChangedEverywhere,
    neighboursProtectedEverywhere,
    audio,
    ok: targetChangedEverywhere && neighboursProtectedEverywhere && (audio.checked === false || audio.identical),
    note: '区域级编码前对照；整片哈希不作为是否误伤的判据',
  }
}

/**
 * Check a second-aspect adaptation: spec, duration, audio identity and evidence that the picture was
 * re-laid-out rather than uniformly stretched.
 *
 * @param {object} input
 * @param {any} input.adapter
 * @param {any} input.basePlan
 * @param {any} input.adaptedPlan
 * @param {any} input.result
 * @param {{ frame: number, videoObjectId: string, probed: any, baseAudioPcmSha256?: string|null }} input.options
 */
export function checkAdaptedResult(input) {
  const adapted = input.adaptedPlan
  const base = input.basePlan
  const probed = input.options.probed
  const checks = []
  checks.push({
    id: 'frame-size',
    status:
      probed.video?.width === adapted.outputSpec.width && probed.video?.height === adapted.outputSpec.height
        ? 'ok'
        : 'failed',
    detail: `${String(probed.video?.width)}×${String(probed.video?.height)}（目标 ${adapted.outputSpec.width}×${adapted.outputSpec.height}）`,
  })
  checks.push({
    id: 'duration-preserved',
    status: probeMedia(input.adapter.ffprobePath, input.result.file).format.durationSeconds === null
      ? 'not-checked'
      : Math.abs(
          probed.format.durationSeconds -
            (base.timebase.totalFrames * base.timebase.fpsDenominator) / base.timebase.fpsNumerator,
        ) <= 0.05
        ? 'ok'
        : 'failed',
    detail: `${String(probed.format.durationSeconds)}s（原 ${base.timebase.totalFrames} 帧）`,
  })
  const adaptedAudio = extractAudioPcm({
    ffmpegPath: input.adapter.ffmpegPath,
    file: input.result.file,
    sampleRate: 48000,
    channels: 2,
  })
  const audioIdentical =
    input.options.baseAudioPcmSha256 === undefined || input.options.baseAudioPcmSha256 === null
      ? null
      : adaptedAudio.sha256 === input.options.baseAudioPcmSha256
  checks.push({
    id: 'audio-identity',
    status: audioIdentical === null ? 'not-checked' : audioIdentical ? 'ok' : 'failed',
    detail: audioIdentical === null ? '没有原版音频哈希' : audioIdentical ? '音频与横版逐字节一致' : '音频发生变化，适配不应改声音',
  })

  // Re-crop evidence: the source is eight colour bars; a cover reframe shows fewer bars than a stretch.
  const still = input.adapter.renderStillRaw(adapted, input.options.frame)
  const shape = frameSizeOf(adapted)
  const video = adapted.objects.find((object) => object.id === input.options.videoObjectId)
  // Sample a row inside the video but away from titles/subtitles: the 15% band of the video box.
  const sampleY = video?.box === undefined
    ? Math.floor(shape.height / 2)
    : Math.min(shape.height - 1, Math.max(0, Math.round(video.box.y + video.box.height * 0.15)))
  const runs = countColorRuns(still.rgb24, { width: shape.width, y: Math.min(shape.height - 1, sampleY) })
  const baseRuns = 8
  checks.push({
    id: 'reframe-not-stretch',
    status: runs < baseRuns ? 'ok' : 'failed',
    detail: `适配后扫描线颜色段 ${runs} 段（原始色条 ${baseRuns} 段）；段数减少说明是重新取景裁切，而不是横向拉伸`,
  })

  return {
    probed,
    adaptedAudioPcmSha256: adaptedAudio.sha256,
    colorRuns: runs,
    checks,
    ok: checks.every((check) => check.status === 'ok' || check.status === 'not-checked'),
    failed: checks.filter((check) => check.status === 'failed').map((check) => check.id),
  }
}

/**
 * Estimate the dominant frequency of one window by counting zero crossings.
 *
 * For the C02 corpus this is exact enough to find the deliberate 440 → 880 → 1320 Hz events, which
 * is what makes a sync check discriminating: an RMS envelope of a steady tone is flat, so envelope
 * lag alone would report a confident but meaningless number (measured: -50 ms on a flat envelope).
 *
 * @param {Buffer} pcm s16le interleaved
 * @param {{ sampleRate?: number, channels?: number, windowMs?: number }} [options]
 */
export function zeroCrossingFrequencies(pcm, options = {}) {
  const sampleRate = options.sampleRate ?? 48000
  const channels = options.channels ?? 2
  const windowMs = options.windowMs ?? 10
  const windowSamples = Math.max(2, Math.round((sampleRate * windowMs) / 1000))
  const totalFrames = Math.floor(pcm.length / (2 * channels))
  const windows = Math.floor(totalFrames / windowSamples)
  const frequencies = []
  for (let w = 0; w < windows; w += 1) {
    let crossings = 0
    let previous = 0
    for (let i = 0; i < windowSamples; i += 1) {
      const sample = pcm.readInt16LE((w * windowSamples + i) * 2 * channels)
      if (i > 0 && (sample >= 0) !== (previous >= 0)) crossings += 1
      previous = sample
    }
    frequencies.push((crossings / (windowSamples / sampleRate)) / 2)
  }
  return { frequencies, windowMs, windows }
}

/**
 * Detect deliberate frequency changes (the corpus' 3 s and 6 s events) as edges in the series.
 * @param {number[]} frequencies
 * @param {{ relativeJump?: number }} [options]
 */
export function detectFrequencyChanges(frequencies, options = {}) {
  const relativeJump = options.relativeJump ?? 0.25
  const events = []
  for (let index = 2; index < frequencies.length; index += 1) {
    const before = (frequencies[index - 1] + frequencies[index - 2]) / 2
    const after = frequencies[index]
    if (before <= 20) continue
    if (Math.abs(after - before) / before >= relativeJump) {
      if (events.length > 0 && index - events[events.length - 1].window < 5) continue
      events.push({ window: index, timeMs: index * 10, fromHz: Math.round(before), toHz: Math.round(after) })
    }
  }
  return events
}

/**
 * Prove the audio in the finished file is the user's audio on the movie timeline.
 *
 * Preferred proof: the deliberate frequency events keep their positions within one video frame.
 * Fallback: RMS envelope correlation, but only when the envelope actually discriminates; a flat
 * envelope is reported as `not-checked` instead of producing a confident wrong number.
 *
 * @param {object} input
 * @param {any} input.adapter
 * @param {any} input.plan
 * @param {any} input.result
 * @param {string} input.sourceAudioFile absolute path of the authored audio
 * @param {number[]} [input.expectedEventSeconds] known events from the plan, if declared
 */
export function checkAudioSync(input) {
  const rendered = extractAudioPcm({
    ffmpegPath: input.adapter.ffmpegPath,
    file: input.result.file,
    sampleRate: 48000,
    channels: 2,
  })
  const source = extractAudioPcm({
    ffmpegPath: input.adapter.ffmpegPath,
    file: input.sourceAudioFile,
    sampleRate: 48000,
    channels: 2,
  })
  const renderedFreq = zeroCrossingFrequencies(rendered.pcm)
  const sourceFreq = zeroCrossingFrequencies(source.pcm)
  const renderedEvents = detectFrequencyChanges(renderedFreq.frequencies)
  const sourceEvents = detectFrequencyChanges(sourceFreq.frequencies)
  const expected = input.expectedEventSeconds ?? null

  if (renderedEvents.length > 0 && sourceEvents.length === renderedEvents.length) {
    const deltas = renderedEvents.map((event, index) =>
      Number((event.timeMs - sourceEvents[index].timeMs).toFixed(1)),
    )
    const maxAbs = deltas.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    return {
      mode: 'frequency-events',
      events: renderedEvents.map((event, index) => ({
        timeMs: event.timeMs,
        fromHz: sourceEvents[index].fromHz,
        toHz: event.toHz,
        expectedSeconds: expected === null ? null : expected[index] ?? null,
        deltaMs: deltas[index],
      })),
      maxDeltaMs: maxAbs,
      ok: maxAbs <= 34,
      renderedSeconds: Number((rendered.frames / 48000).toFixed(4)),
      sourceSeconds: Number((source.frames / 48000).toFixed(4)),
      note: '过零率检出频率跳变，与源音频同一事件比对；容差 1 帧（34ms@30fps）',
    }
  }

  const renderedEnvelope = audioEnvelope(rendered.pcm, { sampleRate: 48000, channels: 2, windowMs: 10 })
  const sourceEnvelope = audioEnvelope(source.pcm, { sampleRate: 48000, channels: 2, windowMs: 10 })
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  const deviation = (values) => {
    const average = mean(values)
    return average === 0 ? 0 : Math.sqrt(mean(values.map((value) => (value - average) ** 2))) / average
  }
  const flat = deviation([...sourceEnvelope.envelope]) < 0.02
  if (flat) {
    return {
      mode: 'not-discriminating',
      ok: null,
      maxDeltaMs: null,
      events: [],
      renderedSeconds: Number((rendered.frames / 48000).toFixed(4)),
      sourceSeconds: Number((source.frames / 48000).toFixed(4)),
      note: '源音频包络近似恒定且没有频率事件，滞后测量没有判别力；本项标未检查，不给出假结论',
    }
  }
  const lag = bestEnvelopeLag(renderedEnvelope.envelope, sourceEnvelope.envelope, { windowMs: 10 })
  return {
    mode: 'envelope',
    lagMs: lag.lagMs,
    correlation: lag.correlation,
    maxDeltaMs: Math.abs(lag.lagMs),
    renderedSeconds: Number((rendered.frames / 48000).toFixed(4)),
    sourceSeconds: Number((source.frames / 48000).toFixed(4)),
    ok: Math.abs(lag.lagMs) <= 34 && lag.correlation > 0.9,
    note: 'RMS 包络相关与滞后测量；只回答位置是否对，不等于听辨音质',
  }
}
