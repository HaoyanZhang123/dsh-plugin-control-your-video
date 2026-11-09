/**
 * AdaptOperation: derive a second aspect ratio by re-laying-out the composition.
 *
 * Contract (CT-05 §8): a cross-aspect adaptation must really re-arrange composition, layout, type
 * sizes, subtitle safe area, motion and video fit, while protecting neighbours, unselected objects,
 * source offsets, the audio track and the total duration. Stretching or cropping the finished file
 * and calling it adapted is explicitly refused — so this module moves objects, re-wraps text and
 * re-fits media, and says which numbers it changed.
 *
 * @module media/ops/adapt
 */

import { ValidationError } from '../../base/index.js'
import { normalizePlan } from '../plan.js'
import { bumpVersion } from '../motion.js'
import { compareAudioIdentity } from '../sound.js'

/** Width of one CJK glyph as a fraction of the font size; ASCII is narrower. */
const GLYPH_WIDTH_RATIO = Object.freeze({ cjk: 1, latin: 0.55 })

/** @param {string} text @param {{ maxWidthPx: number, fontSize: number }} input */
export function estimateTextWidth(text, input) {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    const isCjk = code >= 0x2e80
    width += input.fontSize * (isCjk ? GLYPH_WIDTH_RATIO.cjk : GLYPH_WIDTH_RATIO.latin)
  }
  return width
}

/**
 * Wrap text into lines that fit a pixel width, using the documented glyph-advance estimate.
 *
 * The estimate is not a font measurement; it is declared as an estimate in the operation record so
 * nobody can mistake it for measured typesetting. The rendered result is still checked by looking
 * at the actual frame.
 *
 * @param {string} text
 * @param {{ maxWidthPx: number, fontSize: number, maxLines?: number }} input
 * @returns {{ text: string, lines: string[], method: string, fitsInLines: boolean }}
 */
export function wrapText(text, input) {
  if (!(input.maxWidthPx > 0) || !(input.fontSize > 0)) {
    throw new ValidationError('换行需要正的字号与最大宽度')
  }
  const lines = []
  let current = ''
  for (const char of String(text)) {
    const candidate = current + char
    if (estimateTextWidth(candidate, input) > input.maxWidthPx && current.length > 0) {
      lines.push(current)
      current = char
    } else {
      current = candidate
    }
  }
  if (current.length > 0) lines.push(current)
  const maxLines = input.maxLines ?? 3
  return {
    text: lines.join('\n'),
    lines,
    method: 'glyph-advance-estimate（CJK 1.0×字号、西文 0.55×字号，不是字体测量）',
    fitsInLines: lines.length <= maxLines,
  }
}

/**
 * Build the adapted plan.
 *
 * @param {object} input
 * @param {any} input.basePlan normalized plan
 * @param {{ width: number, height: number }} input.target
 * @param {{ preserveAudio?: boolean, videoFit?: 'cover'|'contain' }} [input.options]
 * @param {any} [input.clock]
 * @returns {{ plan: any, layout: any, preserved: any }}
 */
export function createAdaptOperation(input) {
  const base = input.basePlan
  const targetWidth = Number(input.target?.width)
  const targetHeight = Number(input.target?.height)
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) || targetWidth <= 0 || targetHeight <= 0) {
    throw new ValidationError('适配目标必须是正整数画幅', { target: input.target })
  }
  if (targetWidth === base.outputSpec.width && targetHeight === base.outputSpec.height) {
    throw new ValidationError('适配目标与原始画幅相同，不需要 AdaptOperation')
  }
  const sx = targetWidth / base.outputSpec.width
  const sy = targetHeight / base.outputSpec.height
  const typeScale = Math.min(sx, sy)
  const videoFit = input.options?.videoFit ?? 'cover'
  const moves = []
  const resizes = []
  const rewraps = []
  const mediaFits = []

  const objects = base.objects.map((object) => {
    const next = JSON.parse(JSON.stringify(object))
    const box = next.box ?? null
    if (box !== null) {
      const nextBox = {
        x: Math.round(box.x * sx),
        y: Math.round(box.y * sy),
        width: Math.round(box.width * sx),
        height: Math.round(box.height * sy),
      }
      if (object.kind === 'solid') {
        next.box = { x: 0, y: 0, width: targetWidth, height: targetHeight }
      } else {
        next.box = nextBox
      }
      moves.push({ objectId: object.id, from: box, to: next.box })
    }
    if (['text-native', 'subtitle', 'program-counter'].includes(object.kind)) {
      const previousSize = Number(object.params?.fontSize ?? 32)
      const nextSize = Math.max(10, Math.round(previousSize * typeScale))
      next.params = { ...next.params, fontSize: nextSize }
      if (object.params?.anchor === 'center') {
        next.params.x = Math.round(Number(object.params.x ?? 0) * sx)
        next.params.y = Math.round(Number(object.params.y ?? 0) * sy)
      }
      if (object.params?.safeArea !== undefined) {
        next.params.safeArea = {
          bottomPx: Math.round(Number(object.params.safeArea.bottomPx) * sy),
          maxWidthPx: Math.round(Number(object.params.safeArea.maxWidthPx) * sx),
        }
      }
      resizes.push({ objectId: object.id, from: previousSize, to: nextSize })
      if (['text-native', 'subtitle'].includes(object.kind)) {
        const maxWidth = next.params.safeArea?.maxWidthPx ?? Math.round(targetWidth * 0.86)
        const wrapped = wrapText(String(next.params.text ?? ''), { maxWidthPx: maxWidth, fontSize: nextSize })
        next.params.text = wrapped.text
        next.params.lineCount = wrapped.lines.length
        rewraps.push({
          objectId: object.id,
          maxWidthPx: maxWidth,
          lines: wrapped.lines,
          method: wrapped.method,
          fitsInLines: wrapped.fitsInLines,
        })
      }
    }
    if (object.kind === 'video-source-with-offset' || object.kind === 'image') {
      next.params = { ...next.params, fit: videoFit, refit: true }
      mediaFits.push({
        objectId: object.id,
        fit: videoFit,
        fromFrame: { width: base.outputSpec.width, height: base.outputSpec.height },
        toFrame: { width: targetWidth, height: targetHeight },
        note:
          videoFit === 'cover'
            ? '按目标画幅裁切填充：视觉不变形，但裁掉两侧内容；被裁内容不是"重排"，必须让用户知道'
            : '完整保留画面并留边：不变形不裁切，但出现信箱边',
      })
    }
    if (object.motion !== undefined && object.motion !== null) {
      next.motion = {
        ...object.motion,
        coordinates: {
          scaleX: Number(sx.toFixed(6)),
          scaleY: Number(sy.toFixed(6)),
          uniform: Math.abs(sx - sy) < 1e-6,
        },
      }
    }
    return next
  })

  const adapted = {
    ...base,
    planVersion: bumpVersion(base.planVersion),
    operation: 'AdaptOperation',
    outputSpec: {
      ...base.outputSpec,
      width: targetWidth,
      height: targetHeight,
      aspectRatio: `${targetWidth}:${targetHeight}`,
    },
    objects,
    adaptation: {
      from: { width: base.outputSpec.width, height: base.outputSpec.height },
      to: { width: targetWidth, height: targetHeight },
      scaleX: Number(sx.toFixed(6)),
      scaleY: Number(sy.toFixed(6)),
      typeScale: Number(typeScale.toFixed(6)),
      uniform: Math.abs(sx - sy) < 1e-6,
      method: '对象级重排：位置独立按轴缩放、字号按短边缩放、字幕重排到安全区、视频按 fit 重新取景',
      notAStretch: true,
      limits: [
        '文字换行按字形前进估算，不是字体测量；渲染后必须看图确认没有裁切或溢出',
        '视频 cover 取景会裁掉两侧内容，这是取景决定，不是无损失适配',
      ],
    },
  }

  const normalized = normalizePlan(adapted, { now: () => (input.clock ? input.clock.iso() : null) })
  const audio = compareAudioIdentity(base, normalized)
  const preserved = {
    durationFrames: {
      before: base.timebase.totalFrames,
      after: normalized.timebase.totalFrames,
      identical: base.timebase.totalFrames === normalized.timebase.totalFrames,
    },
    audio,
    sourceOffsets: base.objects
      .filter((object) => object.authored?.sourceOffsetFrames !== undefined)
      .map((object) => {
        const after = normalized.objects.find((entry) => entry.id === object.id)
        return {
          objectId: object.id,
          before: object.authored.sourceOffsetFrames,
          after: after?.authored?.sourceOffsetFrames ?? null,
          identical: object.authored.sourceOffsetFrames === after?.authored?.sourceOffsetFrames,
        }
      }),
  }
  preserved.ok =
    preserved.durationFrames.identical &&
    preserved.audio.identical &&
    preserved.sourceOffsets.every((entry) => entry.identical)

  return {
    plan: normalized,
    layout: { moves, resizes, rewraps, mediaFits, adaptation: normalized.adaptation },
    preserved,
  }
}
