/**
 * A self-contained CompositionPlan for C15's own evidence: no external video, no external audio.
 *
 * Why a C15 fixture exists at all: delivery must be proven on a plan whose inputs are CERTAIN, so a
 * failed export cannot be blamed on a missing asset from another card. It uses only generative
 * objects (solid background, a deterministic program pattern, native text) plus two subtitle objects
 * and one declared font file, all of which the FFmpeg adapter really renders.
 *
 * The fixture is deliberately small (640×360 by default) so the whole multi-spec export finishes in
 * seconds; the SPEC PURPOSE is unchanged — an actual encoded file, probed and checked, then adapted
 * to a second aspect and encoded again.
 *
 * @module delivery/fixtures/unit
 */

import { PLAN_SCHEMA_VERSION } from '../../media/index.js'

/** Default size and length of the fixture. */
export const UNIT_DEFAULT = Object.freeze({
  width: 640,
  height: 360,
  frames: 90,
  fpsNumerator: 30,
  fpsDenominator: 1,
})

/**
 * Build the un-normalized fixture plan.
 *
 * @param {object} input
 * @param {string} input.fontFile absolute path of a real font file (the adapter refuses to guess)
 * @param {string} [input.fontFamily]
 * @param {string} [input.projectId]
 * @param {number} [input.width]
 * @param {number} [input.height]
 * @param {number} [input.frames]
 * @returns {any}
 */
export function buildDeliveryUnitPlan(input) {
  const width = input.width ?? UNIT_DEFAULT.width
  const height = input.height ?? UNIT_DEFAULT.height
  const frames = input.frames ?? UNIT_DEFAULT.frames
  const fpsNumerator = UNIT_DEFAULT.fpsNumerator
  const fpsDenominator = UNIT_DEFAULT.fpsDenominator
  const fontFile = input.fontFile
  if (typeof fontFile !== 'string' || fontFile.length === 0) {
    throw new Error('构建夹具计划需要显式字体文件路径')
  }
  const fontFamily = input.fontFamily ?? 'Arial'
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: 'c15-delivery-unit',
    planVersion: '1.0.0',
    projectId: input.projectId ?? 'project-c15-evidence',
    baseVersionId: null,
    profile: 'StaticDetailUnit',
    operation: 'CreateOperation',
    lockedAt: '2026-11-10T00:00:00.000Z',
    timebase: {
      unit: 'frame',
      fpsNumerator,
      fpsDenominator,
      sampleRate: 48000,
      totalFrames: frames,
    },
    outputSpec: {
      width,
      height,
      fpsNumerator,
      fpsDenominator,
      pixelFormat: 'yuv420p',
      videoCodec: 'h264',
      audioCodec: 'aac',
      sampleRate: 48000,
      channels: 2,
      container: 'mp4',
      colorSpace: 'bt709',
      aspectRatio: `${width}:${height}`,
    },
    runtimeId: 'ffmpeg',
    runtimeVersion: '9.0.1',
    productionRecipeRef: 'recipe://c15/delivery-unit/v1',
    fonts: [{ family: fontFamily, file: fontFile, weight: 400 }],
    materials: [],
    scenes: [
      {
        id: 'scene-main',
        label: '单一场景｜交付夹具',
        timeline: { startFrame: 0, durationFrames: frames },
        objects: ['obj-background', 'obj-pattern', 'obj-title'],
      },
    ],
    transitions: [],
    tracks: [
      { id: 'track-subtitles', kind: 'subtitle', objectIds: ['obj-subtitle-a', 'obj-subtitle-b'] },
    ],
    objects: [
      {
        id: 'obj-background',
        kind: 'solid',
        semanticRole: '底色板',
        scope: 'scene',
        sceneId: 'scene-main',
        timeline: { startFrame: 0, durationFrames: frames },
        params: { color: '#0b1220', opacity: 1 },
        editableProps: ['color', 'opacity'],
        hitTest: 'rect',
        box: { x: 0, y: 0, width, height },
        modificationScope: '仅影响画面底色',
      },
      {
        id: 'obj-pattern',
        kind: 'program-pattern',
        semanticRole: '确定性程序图案（细胞自动机）',
        scope: 'scene',
        sceneId: 'scene-main',
        timeline: { startFrame: 0, durationFrames: frames },
        params: {
          pattern: 'life',
          seed: 20261110,
          mold: 8,
          ratio: 0.18,
          lifeColor: '#38bdf8',
          deathColor: '#0b1220',
        },
        editableProps: ['pattern', 'seed', 'rule', 'hue', 'amplitude'],
        hitTest: 'rect',
        box: {
          x: Math.round(width * 0.55),
          y: Math.round(height * 0.18),
          width: Math.round(width * 0.38),
          height: Math.round(height * 0.6),
        },
        modificationScope: '仅该程序图案实例的种子与参数',
      },
      {
        id: 'obj-title',
        kind: 'text-native',
        semanticRole: '原生标题文字',
        scope: 'scene',
        sceneId: 'scene-main',
        timeline: { startFrame: 0, durationFrames: frames },
        params: {
          text: 'Delivery Unit',
          fontSize: Math.max(14, Math.round(height * 0.08)),
          fontFamily,
          color: '#e2e8f0',
          x: Math.round(width * 0.5),
          y: Math.round(height * 0.45),
          anchor: 'center',
        },
        editableProps: ['text', 'fontSize', 'fontFamily', 'color', 'x', 'y', 'fontWeight'],
        hitTest: 'text-box',
        box: {
          x: Math.round(width * 0.15),
          y: Math.round(height * 0.38),
          width: Math.round(width * 0.7),
          height: Math.round(height * 0.16),
        },
        modificationScope: '仅该文字对象',
      },
      {
        id: 'obj-subtitle-a',
        kind: 'subtitle',
        semanticRole: '字幕 A',
        scope: 'movie',
        timeline: { startFrame: 6, durationFrames: 30 },
        derivedFrom: { lockedCopy: 'locked-lines-v1.json#S01', audioDurationSeconds: 1.0 },
        params: {
          text: '第一行字幕：交付夹具',
          fontSize: Math.max(11, Math.round(height * 0.05)),
          fontFamily,
          color: '#ffffff',
          backgroundColor: '#000000',
          backgroundOpacity: 0.62,
          safeArea: { bottomPx: Math.round(height * 0.1), maxWidthPx: Math.round(width * 0.86) },
          x: Math.round(width * 0.5),
          y: Math.round(height * 0.86),
          anchor: 'bottom-center',
        },
        editableProps: ['text', 'startFrame', 'durationFrames', 'color', 'backgroundColor', 'fontSize'],
        hitTest: 'text-box',
        box: {
          x: Math.round(width * 0.07),
          y: Math.round(height * 0.78),
          width: Math.round(width * 0.86),
          height: Math.round(height * 0.12),
        },
        modificationScope: '仅字幕 A 及其时间范围',
      },
      {
        id: 'obj-subtitle-b',
        kind: 'subtitle',
        semanticRole: '字幕 B',
        scope: 'movie',
        timeline: { startFrame: 45, durationFrames: 30 },
        derivedFrom: { lockedCopy: 'locked-lines-v1.json#S02', audioDurationSeconds: 1.0 },
        params: {
          text: '第二行字幕：规格与适配',
          fontSize: Math.max(11, Math.round(height * 0.05)),
          fontFamily,
          color: '#ffffff',
          backgroundColor: '#000000',
          backgroundOpacity: 0.62,
          safeArea: { bottomPx: Math.round(height * 0.1), maxWidthPx: Math.round(width * 0.86) },
          x: Math.round(width * 0.5),
          y: Math.round(height * 0.86),
          anchor: 'bottom-center',
        },
        editableProps: ['text', 'startFrame', 'durationFrames', 'color', 'backgroundColor', 'fontSize'],
        hitTest: 'text-box',
        box: {
          x: Math.round(width * 0.07),
          y: Math.round(height * 0.78),
          width: Math.round(width * 0.86),
          height: Math.round(height * 0.12),
        },
        modificationScope: '仅字幕 B 及其时间范围',
      },
    ],
    soundManifest: null,
    lockedCopy: {
      file: 'text/locked-lines-v1.json',
      version: 'v1',
      rule: '夹具字幕时间来自声明时长；本卡不做 ASR 对齐',
    },
    registeredRisks: [
      { id: 'R1', risk: '文字裁切', check: '文字与字幕在 16:9 与 9:16 下都落在安全区内' },
      { id: 'R2', risk: '适配', check: '第二画幅由 AdaptOperation 重排，不是整段拉伸' },
    ],
    normalization: null,
  }
  return plan
}
