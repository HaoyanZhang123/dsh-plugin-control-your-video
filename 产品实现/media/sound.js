/**
 * Sound relationships: locked copy → paragraph → segment audio → real duration → subtitle window.
 *
 * Contract (CT-04 §5): the copy and its paragraph ids are fixed BEFORE the audio is recorded;
 * the actual duration comes from FFprobe, never from a character count; subtitles, scenes and
 * audio share one CompositionPlan; without ASR there is no word-level control, and a silent piece
 * is a legitimate work rather than a missing track.
 *
 * @module media/sound
 */

import { ValidationError, roundDeterministic } from '../base/index.js'

/** Rounding rule used when a probed duration becomes a frame count. */
export const DURATION_TO_FRAMES_RULE = 'round-half-up at plan fps, recorded with the probe value'

/**
 * Convert seconds to frames with the declared rounding rule and return the rule with it.
 * @param {number} seconds
 * @param {number} fpsNumerator
 * @param {number} fpsDenominator
 */
export function secondsToFrames(seconds, fpsNumerator, fpsDenominator) {
  if (!(seconds >= 0)) throw new ValidationError('时长必须是非负数', { seconds: String(seconds) })
  const exact = (seconds * fpsNumerator) / fpsDenominator
  return {
    frames: Math.round(exact),
    exact,
    rule: DURATION_TO_FRAMES_RULE,
  }
}

/**
 * Build a SoundManifest from locked copy plus real probe results.
 *
 * @param {object} input
 * @param {string} input.copyId
 * @param {string} input.copyVersion
 * @param {Array<{ paragraphId: string, text: string, audioPath: string, order?: number, gapsBeforeFrames?: number }>}
 * input.segments
 * @param {(filePath: string) => Promise<number>} input.probeDurationSeconds
 * @param {{ fpsNumerator: number, fpsDenominator: number, gapFrames?: number }} input.rate
 * @returns {Promise<any>}
 */
export async function buildSoundManifest(input) {
  const { fpsNumerator, fpsDenominator, gapFrames = 0 } = input.rate ?? {}
  if (
    !Number.isInteger(fpsNumerator) ||
    !Number.isInteger(fpsDenominator) ||
    fpsNumerator <= 0 ||
    fpsDenominator <= 0
  ) {
    throw new ValidationError('构建声音清单需要合法的帧率')
  }
  const segments = []
  let cursor = 0
  for (const [index, segment] of (input.segments ?? []).entries()) {
    const probedSeconds = await input.probeDurationSeconds(segment.audioPath)
    if (!(probedSeconds > 0)) {
      throw new ValidationError('分段音频 probe 时长无效，不能按字数估算', {
        paragraphId: segment.paragraphId,
        seconds: String(probedSeconds),
      })
    }
    const conversion = secondsToFrames(probedSeconds, fpsNumerator, fpsDenominator)
    const gaps = index === 0 ? 0 : segment.gapsBeforeFrames ?? gapFrames
    if (index > 0) cursor += gaps
    segments.push({
      paragraphId: segment.paragraphId,
      text: segment.text,
      audioEvidenceRef: segment.audioPath,
      actualDurationSeconds: probedSeconds,
      actualDurationFrames: conversion.frames,
      exactFrames: Number(conversion.exact.toFixed(6)),
      conversionRule: conversion.rule,
      order: segment.order ?? index + 1,
      gapsBeforeFrames: gaps,
      authoredStartFrame: cursor,
      authoredDurationFrames: conversion.frames,
      sourceOffsetFrames: 0,
      wordLevel: null,
      wordLevelReason: '只有整段实际时长；本产品不做 ASR，不提供虚假逐字控制',
    })
    cursor += conversion.frames
  }
  return {
    copyId: input.copyId,
    copyVersion: input.copyVersion,
    segments,
    derivedTotalFrames: cursor,
    truth: describeSoundTruth({ segments }),
  }
}

/**
 * Refuse any claim of word-level timing that has no real word data behind it.
 * @param {any} manifest
 */
export function assertNoWordLevel(manifest) {
  for (const segment of manifest?.segments ?? []) {
    if (segment.wordLevel !== undefined && segment.wordLevel !== null) {
      throw new ValidationError('没有真实词级时间，不得声明 wordLevel', {
        paragraphId: segment.paragraphId,
      })
    }
    if (Array.isArray(segment.words) && segment.words.length > 0) {
      throw new ValidationError('没有真实词级时间，不得提供词数组', {
        paragraphId: segment.paragraphId,
      })
    }
  }
  return true
}

/**
 * Audio truth statement used by receipts, so "segment timing" can never be sold as "word timing".
 * @param {any} manifest
 */
export function describeSoundTruth(manifest) {
  const segments = manifest?.segments ?? []
  return {
    granularity: 'segment',
    wordLevel: false,
    reason: '整段实际时长来自 probe；无 ASR，不提供逐字控制',
    gapsDeclared: segments.filter((segment) => (segment.gapsBeforeFrames ?? 0) > 0).length,
    totalFrames: segments.reduce((sum, segment) => sum + (segment.authoredDurationFrames ?? 0), 0),
    silentWork: segments.length === 0,
  }
}

/**
 * Derive the subtitle window of every paragraph from the manifest.
 * @param {any} manifest
 */
export function subtitleWindows(manifest) {
  return (manifest?.segments ?? []).map((segment) => ({
    paragraphId: segment.paragraphId,
    startFrame: segment.authoredStartFrame,
    durationFrames: segment.authoredDurationFrames,
    endFrameExclusive: segment.authoredStartFrame + segment.authoredDurationFrames,
    text: segment.text,
  }))
}

/**
 * Check that plan subtitles match the manifest that produced them.
 *
 * A subtitle that was hand-nudged away from its audio duration is reported, not auto-fixed: the
 * user may have done it on purpose, but then the difference is a decision, not a drift.
 *
 * @param {any} plan
 * @returns {{ ok: boolean, problems: Array<{ code: string, paragraphId?: string, detail: string }>, windows: any[] }}
 */
export function checkSubtitleAudioRelation(plan) {
  const manifest = plan.soundManifest
  /** @type {Array<{ code: string, paragraphId?: string, detail: string }>} */
  const problems = []
  if (manifest === undefined || manifest === null) {
    const subtitles = plan.objects.filter((object) => object.kind === 'subtitle')
    if (subtitles.length > 0) {
      problems.push({ code: 'sound-manifest-missing', detail: '存在字幕对象但没有 SoundManifest' })
    }
    return { ok: problems.length === 0, problems, windows: [] }
  }
  const windows = subtitleWindows(manifest)
  for (const window of windows) {
    const object = plan.objects.find((entry) => entry.kind === 'subtitle' && entry.derivedFrom?.lockedCopy?.endsWith(`#${window.paragraphId}`))
    if (object === undefined) {
      problems.push({
        code: 'subtitle-missing',
        paragraphId: window.paragraphId,
        detail: `声音清单有段落 ${window.paragraphId}，计划中没有对应字幕对象`,
      })
      continue
    }
    if (object.timeline.startFrame !== window.startFrame) {
      problems.push({
        code: 'subtitle-start-drift',
        paragraphId: window.paragraphId,
        detail: `字幕起点 ${object.timeline.startFrame} 与由真实时长推导的 ${window.startFrame} 不一致`,
      })
    }
    if (object.timeline.durationFrames !== window.durationFrames) {
      problems.push({
        code: 'subtitle-duration-drift',
        paragraphId: window.paragraphId,
        detail: `字幕时长 ${object.timeline.durationFrames} 与 probe 时长 ${window.durationFrames} 帧不一致`,
      })
    }
  }
  const declaredIds = new Set(windows.map((window) => window.paragraphId))
  for (const object of plan.objects.filter((entry) => entry.kind === 'subtitle')) {
    const paragraph = object.derivedFrom?.lockedCopy?.split('#')[1]
    if (paragraph !== undefined && !declaredIds.has(paragraph)) {
      problems.push({
        code: 'subtitle-undeclared',
        paragraphId: paragraph,
        detail: `字幕 ${object.id} 引用了声音清单里不存在的段落 ${paragraph}`,
      })
    }
  }
  return { ok: problems.length === 0, problems, windows }
}

/**
 * Describe how the audio covers the movie: total coverage, gaps and intentional silence.
 *
 * Gaps are measured, and a silent piece is reported as its own state rather than "missing audio"
 * (CT-04 §5 "无声音作品不强配音轨；有意的静默需记录创作意图").
 *
 * @param {any} plan
 */
export function describeAudioCoverage(plan) {
  const totalFrames = plan.timebase.totalFrames
  const audioObjects = plan.objects.filter((object) => object.kind === 'audio-continuous')
  if (audioObjects.length === 0) {
    const intentional = plan.soundIntent === 'silent' || plan.soundManifest === null
    return {
      totalFrames,
      audioTracks: 0,
      coveredFrames: 0,
      gaps: [{ startFrame: 0, endFrameExclusive: totalFrames }],
      silentByIntent: intentional,
      note: intentional ? '作品声明为无声；不强配音轨' : '没有音轨且未声明有意静默，需要处理',
    }
  }
  const covered = new Array(Math.max(0, totalFrames)).fill(false)
  for (const object of audioObjects) {
    const start = Math.max(0, object.timeline.startFrame)
    const end = Math.min(totalFrames, object.timeline.startFrame + object.timeline.durationFrames)
    for (let frame = start; frame < end; frame += 1) covered[frame] = true
  }
  const gaps = []
  let gapStart = null
  for (let frame = 0; frame < totalFrames; frame += 1) {
    if (!covered[frame] && gapStart === null) gapStart = frame
    if (covered[frame] && gapStart !== null) {
      gaps.push({ startFrame: gapStart, endFrameExclusive: frame })
      gapStart = null
    }
  }
  if (gapStart !== null) gaps.push({ startFrame: gapStart, endFrameExclusive: totalFrames })
  const coveredFrames = totalFrames - gaps.reduce((sum, gap) => sum + (gap.endFrameExclusive - gap.startFrame), 0)
  return {
    totalFrames,
    audioTracks: audioObjects.length,
    coveredFrames,
    coverageRatio: roundDeterministic(totalFrames === 0 ? 0 : coveredFrames / totalFrames, 6),
    gaps,
    silentByIntent: false,
    note: gaps.length === 0 ? '音轨覆盖全片' : '存在未覆盖区间，需确认是有意留白还是缺口',
  }
}

/**
 * Compare the audio identity of two plan versions: a repair that only touches a subtitle must leave
 * the audio objects byte-for-byte semantically identical.
 *
 * @param {any} before
 * @param {any} after
 */
export function compareAudioIdentity(before, after) {
  const pick = (plan) =>
    plan.objects
      .filter((object) => object.kind === 'audio-continuous')
      .map((object) => ({
        id: object.id,
        timeline: object.timeline,
        authored: object.authored,
        params: object.params,
      }))
  const summary = (entries) => JSON.stringify(entries)
  return {
    identical: summary(pick(before)) === summary(pick(after)),
    before: pick(before),
    after: pick(after),
  }
}
