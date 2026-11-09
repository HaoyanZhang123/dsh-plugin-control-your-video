/**
 * Decoding real bytes back out of a rendered file, and comparing them with what was authored.
 *
 * Contract (CT-06 §7, CT-05 §7): pre-encode source frames and post-encode decoded frames are
 * checked separately; a whole-file hash or a whole-frame PSNR is not accepted as proof that the
 * right object changed, because codec noise moves those numbers without any semantic change.
 *
 * Everything here works on raw RGB24 / s16le bytes read from FFmpeg's stdout, so there is no
 * image library and no chance of a PNG decoder quietly changing the pixels being compared.
 *
 * @module media/verify
 */

import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { ExternalError, ValidationError } from '../base/index.js'

/** Default tolerance for "the encoded frame still shows the authored frame". */
export const ENCODE_COMPARE_DEFAULTS = Object.freeze({
  meanAbsoluteTolerance: 6,
  p95AbsoluteTolerance: 18,
  changedPixelThreshold: 10,
})

/**
 * Run an FFmpeg command without a shell and return everything a receipt needs.
 *
 * @param {object} input
 * @param {string} input.ffmpegPath
 * @param {string[]} input.args
 * @param {number} [input.timeoutMs]
 * @param {string} [input.cwd]
 * @param {boolean} [input.allowNonZero]
 * @returns {{ ok: boolean, status: number|null, stderr: string, stdout: Buffer, command: { binary: string, args:
 * string[], cwd: string|null }, timeMs: number }}
 */
export function runFfmpeg(input) {
  const started = process.hrtime.bigint()
  const result = spawnSync(input.ffmpegPath, input.args, {
    cwd: input.cwd,
    timeout: input.timeoutMs ?? 600000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  const timeMs = Number(process.hrtime.bigint() - started) / 1e6
  const stderr = String(result.stderr ?? '')
  const ok = result.status === 0
  if (!ok && input.allowNonZero !== true) {
    throw new ExternalError('FFmpeg 执行失败', {
      code: 'FFMPEG_FAILED',
      details: {
        status: result.status,
        stderrTail: stderr.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-12).join(' | '),
      },
    })
  }
  return {
    ok,
    status: result.status ?? null,
    stderr,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ''),
    command: { binary: input.ffmpegPath, args: [...input.args], cwd: input.cwd ?? null },
    timeMs: Number(timeMs.toFixed(1)),
  }
}

/**
 * Decode selected frames to raw RGB24.
 *
 * One process per frame keeps the seek explicit: asking for frame N twice, in any order, must give
 * the same bytes — that is the "random access" property, and it is meaningless if a previous seek
 * changed the state.
 *
 * @param {object} input
 * @param {string} input.ffmpegPath
 * @param {string} input.file
 * @param {number[]} input.frames
 * @param {number} input.width
 * @param {number} input.height
 * @returns {Map<number, Buffer>}
 */
export function decodeFrames(input) {
  const expectedBytes = input.width * input.height * 3
  const frames = new Map()
  for (const frame of input.frames) {
    if (!Number.isInteger(frame) || frame < 0) throw new ValidationError('帧号必须是非负整数', { frame })
    const result = runFfmpeg({
      ffmpegPath: input.ffmpegPath,
      args: [
        '-v',
        'error',
        '-i',
        input.file,
        '-vf',
        `select=eq(n\\,${frame})`,
        // FFmpeg 9 removed `-vsync`; `-fps_mode passthrough` keeps one output frame per selected frame.
        '-fps_mode',
        'passthrough',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
    })
    if (result.stdout.length !== expectedBytes) {
      throw new ExternalError('解码帧大小与画幅不符', {
        code: 'FRAME_SIZE_MISMATCH',
        details: { frame, expectedBytes, actualBytes: result.stdout.length, width: input.width, height: input.height },
      })
    }
    frames.set(frame, result.stdout)
  }
  return frames
}

/**
 * Decode every frame and take its per-frame checksum, without piping hundreds of megabytes through
 * stdout. `framemd5` emits one line per decoded frame, so the line count is the real frame count and
 * the digest list is a frame-level fingerprint of the decoded picture.
 *
 * @param {object} input
 * @param {string} input.ffmpegPath
 * @param {string} input.file
 * @param {number} [input.width]
 * @param {number} [input.height]
 */
export function decodeAllFrames(input) {
  const result = runFfmpeg({
    ffmpegPath: input.ffmpegPath,
    args: ['-v', 'error', '-i', input.file, '-map', '0:v:0', '-f', 'framemd5', 'pipe:1'],
    timeoutMs: 900000,
  })
  const lines = result.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#') && !line.startsWith('ffmpeg'))
  const digests = lines.filter((line) => line.includes(','))
  return {
    frames: digests.length,
    bytes: digests.length === 0 ? 0 : Number(input.width ?? 0) * Number(input.height ?? 0) * 3 * digests.length,
    digest: sha256(Buffer.from(digests.join('\n'), 'utf8')),
    firstFrames: digests.slice(0, 3),
    lastFrame: digests.length === 0 ? null : digests[digests.length - 1],
  }
}

/**
 * Extract the audio track as s16le PCM.
 *
 * @param {object} input
 * @param {string} input.ffmpegPath
 * @param {string} input.file
 * @param {number} [input.sampleRate]
 * @param {number} [input.channels]
 * @param {number} [input.startSeconds]
 * @param {number} [input.durationSeconds]
 */
export function extractAudioPcm(input) {
  const sampleRate = input.sampleRate ?? 48000
  const channels = input.channels ?? 2
  const args = ['-v', 'error']
  if (input.startSeconds !== undefined) args.push('-ss', String(input.startSeconds))
  args.push('-i', input.file, '-vn')
  if (input.durationSeconds !== undefined) args.push('-t', String(input.durationSeconds))
  args.push('-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(sampleRate), '-ac', String(channels), 'pipe:1')
  const result = runFfmpeg({ ffmpegPath: input.ffmpegPath, args })
  return {
    pcm: result.stdout,
    sampleRate,
    channels,
    frames: result.stdout.length / (2 * channels),
    sha256: sha256(result.stdout),
  }
}

/** SHA-256 of a buffer. @param {Buffer} buffer */
export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Mean/p95 absolute difference between two RGB24 frames, optionally inside one region.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {{ width: number, height: number, region?: { x: number, y: number, width: number, height: number } }} shape
 */
export function frameDiff(a, b, shape) {
  const { width, height } = shape
  if (a.length !== b.length) throw new ValidationError('两帧字节数不同')
  if (a.length !== width * height * 3) throw new ValidationError('帧字节数与画幅不符')
  const region = shape.region ?? { x: 0, y: 0, width, height }
  let sum = 0
  let count = 0
  let changed = 0
  const diffs = []
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const offset = (y * width + x) * 3
      const d = Math.max(
        Math.abs(a[offset] - b[offset]),
        Math.abs(a[offset + 1] - b[offset + 1]),
        Math.abs(a[offset + 2] - b[offset + 2]),
      )
      sum += d
      count += 1
      if (d > ENCODE_COMPARE_DEFAULTS.changedPixelThreshold) changed += 1
      diffs.push(d)
    }
  }
  diffs.sort((left, right) => left - right)
  const p95 = diffs.length === 0 ? 0 : diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * 0.95))]
  return {
    region,
    pixels: count,
    meanAbsolute: count === 0 ? 0 : Number((sum / count).toFixed(4)),
    p95Absolute: p95,
    changedPixels: changed,
    changedRatio: count === 0 ? 0 : Number((changed / count).toFixed(6)),
    maxAbsolute: diffs.length === 0 ? 0 : diffs[diffs.length - 1],
  }
}

/**
 * Whether two frames are the same picture within the documented tolerance.
 * @param {ReturnType<typeof frameDiff>} diff
 * @param {{ meanAbsoluteTolerance?: number, p95AbsoluteTolerance?: number }} [tolerance]
 */
export function isWithinTolerance(diff, tolerance = {}) {
  const meanTolerance = tolerance.meanAbsoluteTolerance ?? ENCODE_COMPARE_DEFAULTS.meanAbsoluteTolerance
  const p95Tolerance = tolerance.p95AbsoluteTolerance ?? ENCODE_COMPARE_DEFAULTS.p95AbsoluteTolerance
  return diff.meanAbsolute <= meanTolerance && diff.p95Absolute <= p95Tolerance
}

/**
 * RMS envelope of PCM, used to compare audio without a spectral library.
 *
 * @param {Buffer} pcm s16le interleaved
 * @param {{ sampleRate?: number, channels?: number, windowMs?: number }} [options]
 */
export function audioEnvelope(pcm, options = {}) {
  const sampleRate = options.sampleRate ?? 48000
  const channels = options.channels ?? 2
  const windowMs = options.windowMs ?? 10
  const windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000))
  const totalFrames = Math.floor(pcm.length / (2 * channels))
  const windows = Math.floor(totalFrames / windowSamples)
  const envelope = new Float64Array(windows)
  for (let w = 0; w < windows; w += 1) {
    let sum = 0
    for (let i = 0; i < windowSamples; i += 1) {
      const frameIndex = w * windowSamples + i
      const sample = pcm.readInt16LE(frameIndex * 2 * channels)
      sum += (sample / 32768) ** 2
    }
    envelope[w] = Math.sqrt(sum / windowSamples)
  }
  return { envelope, windowMs, windows }
}

/**
 * Best lag between two envelopes, in milliseconds, with a normalized correlation score.
 *
 * This answers "is the user's audio still in the right place", including the case where a repair
 * touched the picture and accidentally shifted the sound.
 *
 * @param {Float64Array} a
 * @param {Float64Array} b
 * @param {{ windowMs?: number, maxLagWindows?: number }} [options]
 */
export function bestEnvelopeLag(a, b, options = {}) {
  const windowMs = options.windowMs ?? 10
  const maxLag = options.maxLagWindows ?? Math.round(500 / windowMs)
  let best = { lagWindows: 0, lagMs: 0, correlation: -Infinity }
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let sumA = 0
    let sumB = 0
    let sumAB = 0
    let count = 0
    for (let i = 0; i < a.length; i += 1) {
      const j = i + lag
      if (j < 0 || j >= b.length) continue
      sumA += a[i] * a[i]
      sumB += b[j] * b[j]
      sumAB += a[i] * b[j]
      count += 1
    }
    if (count < a.length * 0.5) continue
    const denominator = Math.sqrt(sumA * sumB)
    const correlation = denominator === 0 ? 0 : sumAB / denominator
    if (correlation > best.correlation) {
      best = {
        lagWindows: lag,
        lagMs: Number((lag * windowMs).toFixed(3)),
        correlation: Number(correlation.toFixed(6)),
      }
    }
  }
  return best
}

/**
 * Compare the encoded decode with the pre-encode source frame.
 *
 * @param {object} input
 * @param {Buffer} input.preEncode raw RGB24 rendered from the composition, before encoding
 * @param {Buffer} input.decoded raw RGB24 decoded from the encoded file
 * @param {{ width: number, height: number }} input.shape
 * @param {{ meanAbsoluteTolerance?: number, p95AbsoluteTolerance?: number }} [input.tolerance]
 */
export function comparePreEncodeToDecoded(input) {
  const diff = frameDiff(input.preEncode, input.decoded, input.shape)
  return {
    ...diff,
    withinTolerance: isWithinTolerance(diff, input.tolerance),
    note: '编码有损，逐帧像素不会完全相同；比对按声明的均值/p95 容差判断，并同时用区域对照判断语义变化',
  }
}

/**
 * The full post-encode check set for one result: frames, duration, first frame, audio and sync.
 *
 * Nothing here may report "passed" when the tool could not check it: an unavailable comparison is
 * reported as `not-checked`, which is a distinct state from `ok`.
 *
 * @param {object} input
 * @param {any} input.declaredSpec
 * @param {any} input.probed
 * @param {number} input.expectedFrames
 * @param {Buffer|null} input.preEncodeFirstFrame
 * @param {Buffer|null} input.decodedFirstFrame
 * @param {{ width: number, height: number }} input.shape
 * @param {{ expectedDurationSeconds?: number, hasAudio?: boolean }} [input.expectations]
 */
export function checkEncodedResult(input) {
  const checks = []
  const probed = input.probed
  const video = probed?.video ?? null
  const frames = video?.nbFrames ?? null
  checks.push({
    id: 'frame-count',
    status: frames === null ? 'not-checked' : frames === input.expectedFrames ? 'ok' : 'failed',
    detail: frames === null ? '容器未提供帧数' : `${frames} 帧（期望 ${input.expectedFrames}）`,
  })
  const duration = probed?.format?.durationSeconds ?? null
  const expectedDuration = input.expectations?.expectedDurationSeconds
  if (duration === null || expectedDuration === undefined) {
    checks.push({ id: 'duration', status: 'not-checked', detail: '缺少可比较的时长' })
  } else {
    const ok = Math.abs(duration - expectedDuration) <= 0.05
    checks.push({
      id: 'duration',
      status: ok ? 'ok' : 'failed',
      detail: `${duration}s（期望 ${expectedDuration}s，容差 50ms）`,
    })
  }
  if (input.preEncodeFirstFrame === null || input.decodedFirstFrame === null) {
    checks.push({ id: 'first-frame', status: 'not-checked', detail: '没有编码前首帧或解码首帧' })
  } else {
    const comparison = comparePreEncodeToDecoded({
      preEncode: input.preEncodeFirstFrame,
      decoded: input.decodedFirstFrame,
      shape: input.shape,
    })
    checks.push({
      id: 'first-frame',
      status: comparison.withinTolerance ? 'ok' : 'failed',
      detail: `编码前/后首帧差别：均值 ${comparison.meanAbsolute}、p95 ${comparison.p95Absolute}`,
      comparison,
    })
  }
  const hasAudio = probed?.audio !== null && probed?.audio !== undefined
  if (input.expectations?.hasAudio === undefined) {
    checks.push({ id: 'audio-presence', status: 'not-checked', detail: '未声明是否需要音轨' })
  } else if (input.expectations.hasAudio && !hasAudio) {
    checks.push({ id: 'audio-presence', status: 'failed', detail: '声明有音轨但结果没有音频流' })
  } else if (!input.expectations.hasAudio && hasAudio) {
    checks.push({ id: 'audio-presence', status: 'failed', detail: '声明无声却出现了音频流' })
  } else {
    checks.push({ id: 'audio-presence', status: 'ok', detail: hasAudio ? '存在音频流' : '按声明无音频流' })
  }
  if (probed?.audio !== null && probed?.audio !== undefined && duration !== null) {
    const audioDuration = probed.audio.durationSeconds ?? null
    const ok = audioDuration === null ? null : Math.abs(audioDuration - duration) <= 0.08
    checks.push({
      id: 'audio-duration',
      status: ok === null ? 'not-checked' : ok ? 'ok' : 'failed',
      detail: ok === null ? '没有音频时长' : `音频 ${audioDuration}s / 视频 ${duration}s（容差 80ms）`,
    })
  }
  return {
    checks,
    ok: checks.every((check) => check.status === 'ok' || check.status === 'not-checked'),
    failed: checks.filter((check) => check.status === 'failed').map((check) => check.id),
    notChecked: checks.filter((check) => check.status === 'not-checked').map((check) => check.id),
  }
}

/**
 * Loop check: for a declared loop, the first and last frames must be the same picture.
 * A non-looping piece reports `not-applicable` rather than a fake pass.
 * @param {{ loopDeclared: boolean, firstFrame: Buffer|null, lastFrame: Buffer|null, shape: { width: number, height:
 * number } }} input
 */
export function checkLoopFrames(input) {
  if (!input.loopDeclared) {
    return { status: 'not-applicable', detail: '本作品没有声明循环，不做首尾帧一致性判断' }
  }
  if (input.firstFrame === null || input.lastFrame === null) {
    return { status: 'not-checked', detail: '缺少首帧或尾帧' }
  }
  const diff = frameDiff(input.firstFrame, input.lastFrame, input.shape)
  return {
    status: isWithinTolerance(diff) ? 'ok' : 'failed',
    detail: `首尾帧差别：均值 ${diff.meanAbsolute}、p95 ${diff.p95Absolute}`,
    comparison: diff,
  }
}

/**
 * Text presence by measurement, not by OCR.
 *
 * A subtitle/text region is checked by comparing it with the same region on a plan version where
 * the text object is absent: a real difference proves the text reached the picture; identical
 * pixels prove it did not. This is a program check, not a claim that the model read the text.
 *
 * @param {{ withText: Buffer, withoutText: Buffer, shape: { width: number, height: number }, region?: any }} input
 */
export function checkTextRegion(input) {
  const diff = frameDiff(input.withText, input.withoutText, { ...input.shape, region: input.region })
  const reachedPicture = diff.meanAbsolute > 2 || diff.changedRatio > 0.02
  return {
    status: reachedPicture ? 'ok' : 'failed',
    detail: reachedPicture
      ? `文字区域与无文字版本不同（均值 ${diff.meanAbsolute}，变化像素 ${(diff.changedRatio * 100).toFixed(1)}%），证明文字进入画面`
      : '文字区域与无文字版本相同，文字没有进入画面',
    comparison: diff,
    limitation: '这是像素存在性检查，不是 OCR，也不证明文字内容或断行正确',
  }
}
