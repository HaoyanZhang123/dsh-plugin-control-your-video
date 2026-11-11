/**
 * Delivery specifications: what a user actually exports, and the small derivations around them.
 *
 * A "规格" is deliberately NOT an arbitrary number pair. It either IS the composition plan's own
 * output spec, or it comes from a real {@link import('../media/index.js') AdaptOperation} — the card
 * forbids "only changing the encoding size and calling it adapted". Subtitle and cover items are
 * derived from the same plan and the produced video, so every delivered file can be traced back to
 * one final version.
 *
 * This module owns no clock and no state: given a plan, a spec and a directory it answers "what
 * file, what content, does it fit". The exporter in `delivery.js` performs the work.
 *
 * @module delivery/specs
 */

import fs from 'node:fs'
import path from 'node:path'
import { ValidationError } from '../base/index.js'
import {
  ItemKind,
  SpecBinding,
  assertEnumValue,
  assertOptionalText,
  assertPositiveInt,
  assertText,
  clip,
} from './ids.js'

/**
 * Known aspect presets, used to label a spec the user chose.
 *
 * The numbers are a LABEL source only: the authoritative size always comes from the plan or from
 * the requested AdaptOperation target, so a preset can never silently override the plan.
 */
export const SPEC_PRESETS = Object.freeze({
  'master-16x9': { label: '成片 16:9', width: 1920, height: 1080 },
  'review-1280x720': { label: '审阅代理 16:9', width: 1280, height: 720 },
  'vertical-9x16': { label: '第二画幅 9:16', width: 1080, height: 1920 },
  'square-1x1': { label: '方版 1:1', width: 1080, height: 1080 },
})

/** Names used by a delivery plan; kept here so a renamed item cannot silently change meaning. */
export const ITEM_LABELS = Object.freeze({
  video: '成片',
  cover: '封面',
  subtitles: '字幕',
  audio: '声音',
})

/**
 * Declare one video spec.
 *
 * `binding: 'final-plan'` exports the plan as authored. `binding: 'adapt-operation'` requires a
 * `target` and computes a real AdaptOperation at export time; the record then carries the adapted
 * plan, its layout moves/resizes/rewraps and the preserved-duration/audio result.
 *
 * @param {object} input
 * @param {string} input.specId stable id used in names and reports, e.g. `master`
 * @param {string} [input.label]
 * @param {string} [input.preset] one of {@link SPEC_PRESETS}
 * @param {string} [input.binding] one of `SpecBinding`; defaults to `final-plan`
 * @param {{ width: number, height: number }} [input.target] required for `adapt-operation`
 * @param {string} [input.audioNote] what the user must know about this spec's sound
 * @returns {any}
 */
export function declareSpec(input = {}) {
  const specId = assertText(input.specId, 'spec.specId', 64)
  const binding = assertEnumValue(input.binding ?? SpecBinding.FINAL_PLAN, SpecBinding, 'spec.binding')
  const preset = input.preset === undefined ? null : assertText(input.preset, 'spec.preset', 64)
  const presetEntry = preset === null ? null : SPEC_PRESETS[preset] ?? null
  if (preset !== null && presetEntry === null) {
    throw new ValidationError('未知画幅预设', { field: 'spec.preset', received: preset, allowed: Object.keys(SPEC_PRESETS) })
  }
  /** @type {{ width: number, height: number }|null} */
  let target = null
  if (binding === SpecBinding.ADAPT_OPERATION) {
    if (input.target === undefined || input.target === null) {
      throw new ValidationError('跨画幅规格必须声明 AdaptOperation 目标', { field: 'spec.target' })
    }
    target = {
      width: assertPositiveInt(input.target.width, 'spec.target.width'),
      height: assertPositiveInt(input.target.height, 'spec.target.height'),
    }
    if (target.width % 2 !== 0 || target.height % 2 !== 0) {
      throw new ValidationError('跨画幅目标的宽高必须是偶数（编码要求 yuv420p）', {
        field: 'spec.target',
        target,
      })
    }
  } else if (input.target !== undefined && input.target !== null) {
    throw new ValidationError('未使用 AdaptOperation 的规格不应声明目标画幅', { field: 'spec.target' })
  }
  return {
    specId,
    label: input.label === undefined
      ? (presetEntry === null ? specId : presetEntry.label)
      : assertText(input.label, 'spec.label', 120),
    preset,
    binding,
    target,
    kind: ItemKind.VIDEO,
    audioNote: assertOptionalText(input.audioNote, 'spec.audioNote', 400),
  }
}

/**
 * Derive a cover spec from a video spec: one frame of that video, written as a PNG.
 * @param {object} input
 * @param {string} input.specId
 * @param {string} input.fromSpecId the video spec whose output is used
 * @param {number} [input.frame] zero-based frame inside that video
 * @param {string} [input.label]
 * @returns {any}
 */
export function declareCoverSpec(input = {}) {
  const frame = input.frame === undefined ? 0 : input.frame
  if (!Number.isInteger(frame) || frame < 0) {
    throw new ValidationError('封面帧号必须是非负整数', { field: 'cover.frame', received: String(frame) })
  }
  return {
    specId: assertText(input.specId, 'spec.specId', 64),
    label: input.label === undefined ? ITEM_LABELS.cover : assertText(input.label, 'spec.label', 120),
    kind: ItemKind.COVER,
    fromSpecId: assertText(input.fromSpecId, 'spec.fromSpecId', 64),
    frame,
  }
}

/**
 * Derive a subtitle spec from the final plan's subtitle objects.
 * @param {object} input
 * @param {string} [input.specId]
 * @param {string} [input.label]
 * @returns {any}
 */
export function declareSubtitleSpec(input = {}) {
  return {
    specId: input.specId === undefined ? 'subtitles' : assertText(input.specId, 'spec.specId', 64),
    label: input.label === undefined ? ITEM_LABELS.subtitles : assertText(input.label, 'spec.label', 120),
    kind: ItemKind.SUBTITLES,
  }
}

/**
 * Declare an agreed material the product cannot yet produce.
 *
 * This exists so "声音单独导出" is visible as a declared gap in the delivery list instead of silently
 * missing: the item is reported as `not-implemented` with a reason, and it never counts as delivered.
 * @param {object} input
 * @param {string} input.specId
 * @param {string} [input.label]
 * @param {string} [input.reason]
 * @returns {any}
 */
export function declareUnsupportedSpec(input = {}) {
  return {
    specId: input.specId === undefined ? 'audio' : assertText(input.specId, 'spec.specId', 64),
    label: input.label === undefined ? ITEM_LABELS.audio : assertText(input.label, 'spec.label', 120),
    kind: ItemKind.AUDIO,
    reason: assertOptionalText(input.reason, 'spec.reason', 400)
      ?? '本卡没有单独的声音导出口：声音随成片复用，单独音频交付需要另一次真实实现与验证',
  }
}

/**
 * The plan's subtitle objects, in timeline order.
 * @param {any} plan
 * @returns {Array<{ objectId: string, startFrame: number, durationFrames: number, text: string }>}
 */
export function subtitleCues(plan) {
  const objects = Array.isArray(plan?.objects) ? plan.objects : []
  const fpsNumerator = Number(plan?.timebase?.fpsNumerator)
  const fpsDenominator = Number(plan?.timebase?.fpsDenominator)
  if (!(fpsNumerator > 0) || !(fpsDenominator > 0)) {
    throw new ValidationError('计划缺少可用的帧率，无法生成字幕时间', { field: 'plan.timebase' })
  }
  return objects
    .filter((object) => object?.kind === 'subtitle')
    .map((object) => ({
      objectId: String(object.id),
      startFrame: Number(object?.timeline?.startFrame ?? 0),
      durationFrames: Number(object?.timeline?.durationFrames ?? 0),
      text: typeof object?.params?.text === 'string' ? object.params.text : '',
    }))
    .filter((cue) => cue.durationFrames > 0 && cue.text.trim().length > 0)
    .sort((left, right) => left.startFrame - right.startFrame)
}

/**
 * Format one frame index as an SRT timestamp (`HH:MM:SS,mmm`).
 * @param {number} frame
 * @param {{ fpsNumerator: number, fpsDenominator: number }} timebase
 * @returns {string}
 */
export function srtTimestamp(frame, timebase) {
  const totalMs = Math.round((frame * timebase.fpsDenominator * 1000) / timebase.fpsNumerator)
  const hours = Math.floor(totalMs / 3600000)
  const minutes = Math.floor((totalMs % 3600000) / 60000)
  const seconds = Math.floor((totalMs % 60000) / 1000)
  const millis = totalMs % 1000
  const pad = (value, width) => String(value).padStart(width, '0')
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`
}

/**
 * Render the plan's subtitles as an SRT document.
 *
 * The file is generated from the plan alone, so its timing is the plan's timing — not an ASR guess
 * and not a subtitle editor's rounding.
 * @param {any} plan
 * @returns {{ content: string, cues: number, firstStartFrame: number|null, lastEndFrame: number|null }}
 */
export function buildSubtitleDocument(plan) {
  const timebase = {
    fpsNumerator: Number(plan.timebase.fpsNumerator),
    fpsDenominator: Number(plan.timebase.fpsDenominator),
  }
  const cues = subtitleCues(plan)
  if (cues.length === 0) {
    return { content: '', cues: 0, firstStartFrame: null, lastEndFrame: null }
  }
  const blocks = cues.map((cue, index) => {
    const start = srtTimestamp(cue.startFrame, timebase)
    const end = srtTimestamp(cue.startFrame + cue.durationFrames, timebase)
    return `${index + 1}\n${start} --> ${end}\n${cue.text.replace(/\r\n?/g, '\n')}\n`
  })
  return {
    content: `${blocks.join('\n')}`,
    cues: cues.length,
    firstStartFrame: cues[0].startFrame,
    lastEndFrame: cues[cues.length - 1].startFrame + cues[cues.length - 1].durationFrames,
  }
}

/**
 * A base file name for one item, without extension.
 *
 * The project title is not used (it is display text that may contain anything); the delivery id and
 * the spec id are stable and safe, and the label is attached in the report instead.
 * @param {{ deliveryId: string, specId: string, kind: string }} input
 * @returns {string}
 */
export function defaultFileStem(input) {
  const delivery = String(input.deliveryId).replace(/[^0-9A-Za-z_-]/g, '')
  const spec = String(input.specId).replace(/[^0-9A-Za-z_-]/g, '')
  return `${delivery}-${spec}`
}

/** Extension per item kind. */
export const ITEM_EXTENSION = Object.freeze({
  video: '.mp4',
  cover: '.png',
  subtitles: '.srt',
  audio: '.m4a',
})

/**
 * Resolve an output path without ever overwriting an existing file.
 *
 * Two policies exist and neither of them overwrites: `refuse` reports the conflict and stops that
 * item; `rename` picks the first free `name-2`, `name-3`, … A re-export therefore always creates
 * `…-2.mp4` and the earlier delivery keeps its file — "重导出不静默覆盖旧文件" is enforced here, at
 * the only place that chooses a name.
 *
 * @param {object} input
 * @param {string} input.dir absolute output directory
 * @param {string} input.stem base name without extension
 * @param {string} input.extension including the dot
 * @param {'refuse'|'rename'} [input.policy]
 * @returns {{ ok: true, file: string, renamed: boolean } | { ok: false, reason: string, existing: string }}
 */
export function resolveOutputPath(input) {
  const dir = input.dir
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new ValidationError('输出目录必须是绝对路径', { field: 'dir' })
  }
  const policy = input.policy ?? 'rename'
  if (!['refuse', 'rename'].includes(policy)) {
    throw new ValidationError('未知同名处理策略', { field: 'policy', received: String(policy) })
  }
  const extension = input.extension.startsWith('.') ? input.extension : `.${input.extension}`
  const candidate = path.join(dir, `${input.stem}${extension}`)
  if (!fs.existsSync(candidate)) return { ok: true, file: candidate, renamed: false }
  if (policy === 'refuse') return { ok: false, reason: 'NAME_CONFLICT', existing: candidate }
  for (let index = 2; index <= 400; index += 1) {
    const next = path.join(dir, `${input.stem}-${index}${extension}`)
    if (!fs.existsSync(next)) return { ok: true, file: next, renamed: true }
  }
  return { ok: false, reason: 'NAME_CONFLICT', existing: candidate }
}

/**
 * Free-space check before an export writes anything.
 *
 * A missing `statfs` is reported as `checked: false` — that is honestly weaker than "space is fine",
 * so a receipt quoting this must not read it as a guarantee.
 * @param {string} dir absolute directory that must exist
 * @param {number} neededBytes bytes this export will write (a real estimate, not a constant)
 * @returns {{ checked: boolean, ok: boolean, freeBytes: number|null, neededBytes: number, reason: string|null }}
 */
export function checkFreeSpace(dir, neededBytes) {
  if (!Number.isInteger(neededBytes) || neededBytes < 0) {
    throw new ValidationError('需要的空间必须是非负整数', { field: 'neededBytes' })
  }
  let stats
  try {
    if (typeof fs.statfsSync !== 'function') {
      return { checked: false, ok: true, freeBytes: null, neededBytes, reason: '当前运行环境不提供可用空间查询' }
    }
    stats = fs.statfsSync(dir)
  } catch (error) {
    return {
      checked: false,
      ok: true,
      freeBytes: null,
      neededBytes,
      reason: `可用空间无法查询：${String(error?.code ?? error?.message ?? error)}`,
    }
  }
  const freeBytes = Number(stats.bavail) * Number(stats.bsize)
  if (!Number.isFinite(freeBytes)) {
    return { checked: false, ok: true, freeBytes: null, neededBytes, reason: '可用空间结果不是有限数值' }
  }
  return {
    checked: true,
    ok: freeBytes >= neededBytes,
    freeBytes,
    neededBytes,
    reason: freeBytes >= neededBytes ? null : '可用空间不足以完成本次导出',
  }
}

/**
 * One human-readable line describing a spec, used in reports and in the delivery list.
 * @param {any} spec
 * @returns {string}
 */
export function describeSpec(spec) {
  const size = spec.kind === ItemKind.VIDEO
    ? spec.binding === SpecBinding.ADAPT_OPERATION
      ? `${spec.target.width}×${spec.target.height}（AdaptOperation）`
      : '按定稿计划规格'
    : spec.kind === ItemKind.COVER
      ? `第 ${spec.frame} 帧`
      : spec.kind === ItemKind.SUBTITLES
        ? '按计划字幕'
        : '不可用'
  return `${ITEM_LABELS[spec.kind] ?? spec.kind}｜${clip(spec.label, 60) ?? ''}｜${size}`
}
