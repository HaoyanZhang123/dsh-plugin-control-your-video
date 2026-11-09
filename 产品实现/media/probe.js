/**
 * FFprobe facts and the declared-versus-probed discipline.
 *
 * Contract (CT-04 §7, CT-06 §5): every result carries `declaredSpec` and `probedSpec` side by
 * side. A plan that says yuv420p and a file that is yuvj420p is a difference that must be handled,
 * not an average. Unknown or unreadable media is reported as unknown; nothing here guesses.
 *
 * @module media/probe
 */

import { spawnSync } from 'node:child_process'
import { ExternalError, IoError, ValidationError } from '../base/index.js'

/**
 * Run ffprobe and parse its JSON. Never uses a shell, so a path with spaces is one argument.
 *
 * @param {string} ffprobePath
 * @param {string} file
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ ok: boolean, facts: any|null, stderr: string, status: number|null, command: { binary: string, args:
 * string[] } }}
 */
export function readProbeJson(ffprobePath, file, options = {}) {
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]
  const result = spawnSync(ffprobePath, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  const stderr = String(result.stderr ?? '').trim()
  if (result.status !== 0) {
    return { ok: false, facts: null, stderr, status: result.status ?? null, command: { binary: ffprobePath, args } }
  }
  try {
    return {
      ok: true,
      facts: JSON.parse(String(result.stdout ?? '{}')),
      stderr,
      status: 0,
      command: { binary: ffprobePath, args },
    }
  } catch (error) {
    return {
      ok: false,
      facts: null,
      stderr: `无法解析 ffprobe JSON：${error instanceof Error ? error.message : String(error)}`,
      status: result.status ?? null,
      command: { binary: ffprobePath, args },
    }
  }
}

/** Parse a rational string such as "30000/1001" into numbers. @param {string} value */
function parseRate(value) {
  if (typeof value !== 'string') return null
  const [numerator, denominator] = value.split('/').map((part) => Number(part))
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return null
  }
  return { numerator, denominator, value: numerator / denominator }
}

/**
 * Normalized facts about one media file.
 *
 * @param {string} ffprobePath
 * @param {string} file
 * @param {{ timeoutMs?: number }} [options]
 * @returns {any}
 */
export function probeMedia(ffprobePath, file, options = {}) {
  const probe = readProbeJson(ffprobePath, file, options)
  if (!probe.ok) {
    return {
      file,
      readable: false,
      reason: probe.stderr.length > 0 ? probe.stderr : 'ffprobe 失败',
      status: probe.status,
      command: probe.command,
      needsHandling: true,
    }
  }
  const streams = Array.isArray(probe.facts.streams) ? probe.facts.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video') ?? null
  const audio = streams.find((stream) => stream.codec_type === 'audio') ?? null
  const format = probe.facts.format ?? {}

  const rotation = (() => {
    const side = Array.isArray(video?.side_data_list)
      ? video.side_data_list.find((entry) => entry.rotation !== undefined)
      : null
    if (side !== null && side !== undefined) return Number(side.rotation)
    if (video?.tags?.rotate !== undefined) return Number(video.tags.rotate)
    return 0
  })()

  const avgRate = parseRate(video?.avg_frame_rate)
  const realRate = parseRate(video?.r_frame_rate)
  const nbFrames = video?.nb_frames !== undefined ? Number(video.nb_frames) : null
  const duration = Number(format.duration ?? video?.duration ?? audio?.duration ?? NaN)
  const hasAlpha = Boolean(
    video?.pix_fmt !== undefined &&
      /(a|rgba|bgra|argb|abgr|yuva|ga)/i.test(String(video.pix_fmt)) &&
      !/yuvj?4\d\d(p|$)/.test(String(video.pix_fmt)),
  )

  return {
    file,
    readable: true,
    format: {
      name: format.format_name ?? null,
      durationSeconds: Number.isFinite(duration) ? Number(duration.toFixed(6)) : null,
      sizeBytes: format.size !== undefined ? Number(format.size) : null,
      bitRate: format.bit_rate !== undefined ? Number(format.bit_rate) : null,
    },
    video:
      video === null
        ? null
        : {
            codec: video.codec_name ?? null,
            width: Number(video.width),
            height: Number(video.height),
            pixelFormat: video.pix_fmt ?? null,
            avgRate,
            realRate,
            nbFrames: Number.isFinite(nbFrames) ? nbFrames : null,
            rotation,
            sar: video.sample_aspect_ratio ?? null,
            dar: video.display_aspect_ratio ?? null,
            hasAlpha,
            profile: video.profile ?? null,
            level: video.level ?? null,
          },
    audio:
      audio === null
        ? null
        : {
            codec: audio.codec_name ?? null,
            sampleRate: audio.sample_rate !== undefined ? Number(audio.sample_rate) : null,
            channels: audio.channels !== undefined ? Number(audio.channels) : null,
            channelLayout: audio.channel_layout ?? null,
            durationSeconds: audio.duration !== undefined ? Number(Number(audio.duration).toFixed(6)) : null,
            bitRate: audio.bit_rate !== undefined ? Number(audio.bit_rate) : null,
          },
    streams: streams.map((stream) => ({
      index: stream.index,
      type: stream.codec_type,
      codec: stream.codec_name,
      timeBase: stream.time_base ?? null,
    })),
    needsHandling: false,
    command: probe.command,
  }
}

/**
 * Compare what the plan declared with what the file actually is.
 *
 * @param {any} outputSpec declared output specification from the plan
 * @param {any} probed result of {@link probeMedia}
 * @returns {{ ok: boolean, differences: Array<{ field: string, declared: any, probed: any, severity: 'fatal'|'report'|'info' }> }}
 */
export function compareDeclaredToProbed(outputSpec, probed) {
  /** @type {Array<{ field: string, declared: any, probed: any, severity: 'fatal'|'report'|'info' }>} */
  const differences = []
  if (probed?.readable !== true) {
    return {
      ok: false,
      differences: [{ field: 'readable', declared: true, probed: false, severity: 'fatal' }],
    }
  }
  const video = probed.video
  const audio = probed.audio

  const check = (field, declared, actual, severity) => {
    if (declared === undefined || declared === null) return
    if (String(declared) === String(actual)) return
    differences.push({ field, declared, probed: actual, severity })
  }

  check('width', outputSpec?.width, video?.width, 'fatal')
  check('height', outputSpec?.height, video?.height, 'fatal')
  check('pixelFormat', outputSpec?.pixelFormat, video?.pixelFormat, 'fatal')
  check('videoCodec', outputSpec?.videoCodec, video?.codec, 'fatal')
  if (outputSpec?.audioCodec !== undefined) {
    check('audioCodec', outputSpec?.audioCodec, audio?.codec, 'fatal')
    check('audioSampleRate', outputSpec?.sampleRate, audio?.sampleRate, 'report')
    check('audioChannels', outputSpec?.channels, audio?.channels, 'report')
  }
  if (outputSpec?.fpsNumerator !== undefined && video?.avgRate !== null && video?.avgRate !== undefined) {
    const declaredRate = outputSpec.fpsNumerator / outputSpec.fpsDenominator
    const actualRate = video.avgRate.value
    if (Math.abs(declaredRate - actualRate) > 0.001) {
      differences.push({
        field: 'fps',
        declared: `${outputSpec.fpsNumerator}/${outputSpec.fpsDenominator}`,
        probed: `${video.avgRate.numerator}/${video.avgRate.denominator}`,
        severity: 'fatal',
      })
    }
  }
  if (video?.pixelFormat === 'yuvj420p' && outputSpec?.pixelFormat === 'yuv420p') {
    // C02 measured this exact trap: a full-range JPEG pixel format is not the declared one.
    differences.push({
      field: 'pixelFormat-range',
      declared: 'yuv420p (limited range)',
      probed: 'yuvj420p (full range)',
      severity: 'fatal',
    })
  }
  return {
    ok: differences.filter((entry) => entry.severity === 'fatal').length === 0,
    differences,
  }
}

/**
 * Media compatibility classification for the C02 corpus boundaries.
 *
 * Statuses follow CT-11 §4 exactly: direct / needs-normalization / unsupported / unknown.
 *
 * @param {any} probed
 * @param {{ targetFpsNumerator?: number, targetFpsDenominator?: number }} [context]
 * @returns {Array<{ item: string, status: string, detail: string }>}
 */
export function classifyCompatibility(probed, context = {}) {
  /** @type {Array<{ item: string, status: string, detail: string }>} */
  const out = []
  if (probed?.readable !== true) {
    return [{ item: 'readable', status: 'unsupported', detail: probed?.reason ?? '无法读取' }]
  }
  const video = probed.video
  if (video === null) {
    out.push({ item: 'video-stream', status: 'not-applicable', detail: '纯音频文件' })
  } else {
    const rate = video.avgRate?.value ?? null
    const target = context.targetFpsNumerator !== undefined
      ? context.targetFpsNumerator / context.targetFpsDenominator
      : null
    if (rate === null) {
      out.push({ item: 'frame-rate', status: 'unknown', detail: '没有 avg_frame_rate，无法判断' })
    } else if (Number.isInteger(rate)) {
      out.push({
        item: 'frame-rate',
        status: target === null || Math.abs(target - rate) < 1e-9 ? 'direct' : 'needs-normalization',
        detail: `${rate} fps${target === null ? '' : ` → ${target} fps`}`,
      })
    } else {
      out.push({
        item: 'frame-rate',
        status: 'needs-normalization',
        detail: `非整数帧率 ${video.avgRate.numerator}/${video.avgRate.denominator}；按目标帧率重采样，逐帧精度未证`,
      })
    }
    const frameRateGap =
      video.avgRate !== null && video.realRate !== null
        ? Math.abs(video.avgRate.value - video.realRate.value)
        : 0
    out.push({
      item: 'vfr',
      status: frameRateGap > 0.01 ? 'needs-normalization' : 'direct',
      detail:
        frameRateGap > 0.01
          ? `avg ${video.avgRate.value.toFixed(3)} 与 real ${video.realRate.value.toFixed(3)} 不一致，判为可变帧率；规范化后逐帧映射未验证`
          : '恒定帧率',
    })
    out.push({
      item: 'rotation',
      status: video.rotation === 0 ? 'direct' : 'needs-normalization',
      detail: video.rotation === 0 ? '无旋转元数据' : `旋转 ${video.rotation}°，必须在合成前应用`,
    })
    out.push({
      item: 'sar',
      status: video.sar === '1:1' || video.sar === null || video.sar === '0:1' ? 'direct' : 'needs-normalization',
      detail: `SAR ${String(video.sar)}；非方像素需先校正，否则几何会变形`,
    })
    out.push({
      item: 'alpha',
      status: video.hasAlpha ? 'unknown' : 'direct',
      detail: video.hasAlpha
        ? '检测到带 alpha 的像素格式；MP4 容器下 alpha 丢失，透明输出路径未验证'
        : '无 alpha 通道',
    })
  }
  if (probed.audio !== null) {
    out.push({
      item: 'audio-sample-rate',
      status: probed.audio.sampleRate === 48000 ? 'direct' : 'needs-normalization',
      detail: `${String(probed.audio.sampleRate)} Hz → 目标 48000 Hz`,
    })
    out.push({
      item: 'audio-channels',
      status: probed.audio.channels === 2 ? 'direct' : 'needs-normalization',
      detail: `${String(probed.audio.channels)} 声道 → 目标立体声`,
    })
  }
  return out
}

/**
 * Assert a file is readable, with an error that names the remedy instead of "probe failed".
 * @param {string} ffprobePath
 * @param {string} file
 */
export function requireReadableMedia(ffprobePath, file) {
  const probed = probeMedia(ffprobePath, file)
  if (probed.readable !== true) {
    if (probed.reason.includes('No such file')) {
      throw new IoError('媒体文件不存在', { details: { file, reason: probed.reason } })
    }
    throw new ExternalError('媒体文件无法被 FFprobe 读取，可能需要修复或转码', {
      code: 'MEDIA_UNREADABLE',
      details: { file, reason: probed.reason, remedy: '检查文件完整性，或先做规范化转码并保留原文件' },
    })
  }
  return probed
}

/**
 * Frame count from probe facts, preferring the declared container value and falling back to
 * duration × rate only when the container does not count frames.
 * @param {any} probed
 */
export function frameCountOf(probed) {
  const video = probed?.video
  if (video === null || video === undefined) return null
  if (Number.isInteger(video.nbFrames) && video.nbFrames > 0) return video.nbFrames
  const rate = video.avgRate?.value
  const duration = probed.format?.durationSeconds
  if (rate === undefined || rate === null || duration === null || duration === undefined) return null
  return Math.round(rate * duration)
}

/**
 * Assert declared and probed specs agree where agreement is mandatory.
 * @param {any} outputSpec
 * @param {any} probed
 */
export function assertSpecMatch(outputSpec, probed) {
  const comparison = compareDeclaredToProbed(outputSpec, probed)
  if (!comparison.ok) {
    throw new ValidationError('实际输出与声明规格不一致', {
      details: { differences: comparison.differences },
    })
  }
  return comparison
}
