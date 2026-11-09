/**
 * The C12 real unit: one CompositionPlan that exercises every mechanism this card owns.
 *
 * It is deliberately built from C02's accepted unit (same 270-frame two-scene structure, same
 * overlap transition, same source offset of 90 frames, same locked copy and 9 s continuous user
 * audio) so the formal adapter is measured on a plan that already passed human review — not on a
 * synthetic one invented to make the adapter look good.
 *
 * Differences from the C02 plan, and why:
 * - C02's Canvas particle animation cannot be rendered by a filter-graph runtime. The unit keeps
 *   a `canvas-program-animation` object in its `c02SourcePlan` form (used to prove the adapter
 *   refuses instead of pretending), and the renderable form uses `program-pattern` / `program-counter`
 *   objects whose parameters are real, deterministic generators. The swap is an explicit authored
 *   normalization recorded in `normalization`, never a silent fallback.
 * - Subtitles are movie-level track objects so a line that crosses the cut is not clipped.
 *
 * @module media/fixtures/c12-unit
 */

import { PLAN_SCHEMA_VERSION } from '../plan.js'

/** Frame rate of the unit. */
export const UNIT_FPS = Object.freeze({ numerator: 30, denominator: 1 })

/** Scene durations and overlap that reproduce C02's 270-frame total. */
export const UNIT_TIMING = Object.freeze({ sceneFrames: 150, overlapFrames: 30, totalFrames: 270 })

/** Locked copy paragraphs with their real probed durations (from C02's corpus evidence). */
export const UNIT_SEGMENTS = Object.freeze([
  {
    paragraphId: 'S01',
    text: '二〇二六年的视频工作台，不再需要把素材交给云端。',
    audioFile: 'audio/s01.wav',
    actualDurationSeconds: 2.4,
    startFrame: 0,
    durationFrames: 72,
  },
  {
    paragraphId: 'S02',
    text: '程序视觉、已有素材与用户音频，在同一条时间线上协作。',
    audioFile: 'audio/s02.wav',
    actualDurationSeconds: 3.1,
    startFrame: 75,
    durationFrames: 93,
  },
  {
    paragraphId: 'S03',
    text: '每一处修改都可追溯，每一段声音都保持真实时长。',
    audioFile: 'audio/s03.wav',
    actualDurationSeconds: 2.0,
    startFrame: 171,
    durationFrames: 60,
  },
])

/**
 * Build the renderable unit plan.
 *
 * @param {object} input
 * @param {string} input.fontFile absolute path of the CJK font file the renderer must use
 * @param {{ width?: number, height?: number }} [input.output]
 * @returns {any} an un-normalized plan document
 */
export function buildC12UnitPlan(input) {
  const width = input.output?.width ?? 1280
  const height = input.output?.height ?? 720
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: 'c12-unit-001',
    planVersion: '1.0.0',
    projectId: 'project-c12-evidence',
    baseVersionId: null,
    profile: 'TemporalMotionUnit',
    operation: 'CreateOperation',
    lockedAt: '2026-11-09T00:00:00.000Z',
    timebase: {
      unit: 'frame',
      fpsNumerator: UNIT_FPS.numerator,
      fpsDenominator: UNIT_FPS.denominator,
      sampleRate: 48000,
      totalFrames: UNIT_TIMING.totalFrames,
    },
    outputSpec: {
      width,
      height,
      fpsNumerator: UNIT_FPS.numerator,
      fpsDenominator: UNIT_FPS.denominator,
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
    productionRecipeRef: 'recipe://c12/unit-001/v1',
    fonts: [{ family: 'Microsoft YaHei', file: input.fontFile, weight: 400 }],
    materials: [
      {
        id: 'mat-source-video',
        file: 'video/src-existing-1280x720-30fps-12s.mp4',
        kind: 'video',
        sha256: '326fd160dc03796ac0c68fd9f7201a08478ad80c28f33c8faa14c83c2085048c',
        bytes: 7451907,
        rights: 'C02 固定语料，自建、权利可追踪',
      },
      {
        id: 'mat-user-audio',
        file: 'audio/user-audio-continuous-9s-48k-stereo.wav',
        kind: 'audio',
        sha256: '7fa60ea5eca4a70ffef6766c9406b63ad9d9791d7adfdc4aa3e8abd9b0de6dfd',
        bytes: 1728078,
        rights: 'C02 固定语料，自建、权利可追踪',
      },
    ],
    scenes: [
      {
        id: 'scene-A',
        label: '场景 A｜程序视觉与文字',
        timeline: { startFrame: 0, durationFrames: UNIT_TIMING.sceneFrames },
        objects: ['obj-sceneA-bg', 'obj-sceneA-pattern', 'obj-sceneA-title'],
      },
      {
        id: 'scene-B',
        label: '场景 B｜已有视频与程序计数',
        timeline: { startFrame: 120, durationFrames: UNIT_TIMING.sceneFrames },
        objects: ['obj-sceneB-bg', 'obj-existing-video', 'obj-sceneB-counter', 'obj-sceneB-title'],
      },
    ],
    transitions: [
      {
        id: 'obj-transition-crossfade',
        kind: 'crossfade',
        fromScene: 'scene-A',
        toScene: 'scene-B',
        overlapFrames: UNIT_TIMING.overlapFrames,
        shortensTotalDuration: true,
        declaredRule: '总时长 = Σ场景(150+150) − Σ重叠(30) = 270 帧 = 9.000s',
      },
    ],
    tracks: [
      {
        id: 'track-subtitles',
        kind: 'subtitle',
        objectIds: ['obj-subtitle-S01', 'obj-subtitle-S02', 'obj-subtitle-S03'],
      },
      { id: 'track-audio', kind: 'audio', objectIds: ['obj-audio-main'] },
    ],
    objects: [
      {
        id: 'obj-sceneA-bg',
        kind: 'solid',
        semanticRole: '场景 A 背景板',
        sceneId: 'scene-A',
        timeline: { startFrame: 0, durationFrames: 150 },
        params: { color: '#0b1220', opacity: 1 },
        editableProps: ['color', 'opacity'],
        hitTest: 'rect',
        box: { x: 0, y: 0, width: 1280, height: 720 },
        modificationScope: '仅影响场景 A 时间范围内的画面底色',
      },
      {
        id: 'obj-sceneA-pattern',
        kind: 'program-pattern',
        semanticRole: '确定性程序图案（细胞自动机）',
        sceneId: 'scene-A',
        timeline: { startFrame: 0, durationFrames: 150 },
        params: {
          pattern: 'life',
          seed: 20261107,
          mold: 10,
          ratio: 0.12,
          lifeColor: '#38bdf8',
          deathColor: '#0b1220',
        },
        editableProps: ['pattern', 'seed', 'rule', 'hue', 'amplitude'],
        hitTest: 'rect',
        box: { x: 800, y: 90, width: 400, height: 240 },
        modificationScope: '仅该程序图案实例的参数；不触碰文字、字幕、视频与音轨',
      },
      {
        id: 'obj-sceneA-title',
        kind: 'text-native',
        semanticRole: '场景 A 原生标题文字',
        sceneId: 'scene-A',
        timeline: { startFrame: 15, durationFrames: 120 },
        params: {
          text: '同一条时间线',
          fontSize: 64,
          fontFamily: 'Microsoft YaHei',
          color: '#e2e8f0',
          x: 640,
          y: 300,
          anchor: 'center',
        },
        editableProps: ['text', 'fontSize', 'fontFamily', 'color', 'x', 'y', 'fontWeight'],
        hitTest: 'text-box',
        box: { x: 320, y: 250, width: 640, height: 100 },
        motion: {
          term: 'fade-in',
          enter: { durationFrames: 12, easing: 'easeOutQuad' },
          hold: { durationFrames: 90 },
          exit: { durationFrames: 9, easing: 'easeInQuad' },
          reason: '标题在场景 A 前半段淡入，结尾淡出；保持段是有意的静止，不是漏做动作',
        },
        modificationScope: '仅该文字对象；不改变背景、图形、字幕与音轨',
      },
      {
        id: 'obj-sceneB-bg',
        kind: 'solid',
        semanticRole: '场景 B 背景板',
        sceneId: 'scene-B',
        timeline: { startFrame: 120, durationFrames: 150 },
        params: { color: '#111827', opacity: 1 },
        editableProps: ['color', 'opacity'],
        hitTest: 'rect',
        box: { x: 0, y: 0, width: 1280, height: 720 },
        modificationScope: '仅影响场景 B 时间范围内的画面底色',
      },
      {
        id: 'obj-existing-video',
        kind: 'video-source-with-offset',
        semanticRole: '已有视频素材（带 authored source offset）',
        sceneId: 'scene-B',
        timeline: { startFrame: 120, durationFrames: 150 },
        authored: {
          materialId: 'mat-source-video',
          sourceFile: 'video/src-existing-1280x720-30fps-12s.mp4',
          sourceOffsetFrames: 90,
          sourceOffsetSeconds: 3.0,
          sourceTotalFrames: 360,
          sourceTotalSeconds: 12.0,
        },
        params: { opacity: 0.55, scale: 1.0, fit: 'cover' },
        editableProps: ['sourceOffsetFrames', 'startFrame', 'durationFrames', 'opacity', 'scale'],
        hitTest: 'rect',
        box: { x: 0, y: 0, width: 1280, height: 720 },
        modificationScope: '仅该视频实例的入点／时长／源偏移；不改动源文件字节',
      },
      {
        id: 'obj-sceneB-counter',
        kind: 'program-counter',
        semanticRole: '程序计数文字（帧号实时表达式）',
        sceneId: 'scene-B',
        timeline: { startFrame: 120, durationFrames: 150 },
        params: { fontSize: 34, color: '#38bdf8', x: 80, y: 60, style: 'frame-number' },
        editableProps: ['fontSize', 'color', 'x', 'y', 'style'],
        hitTest: 'text-box',
        box: { x: 80, y: 60, width: 220, height: 46 },
        modificationScope: '仅该计数文字对象',
      },
      {
        id: 'obj-sceneB-title',
        kind: 'text-native',
        semanticRole: '场景 B 原生标题文字',
        sceneId: 'scene-B',
        timeline: { startFrame: 135, durationFrames: 120 },
        params: {
          text: '可追溯的每一次修改',
          fontSize: 52,
          fontFamily: 'Microsoft YaHei',
          color: '#f1f5f9',
          x: 640,
          y: 220,
          anchor: 'center',
        },
        editableProps: ['text', 'fontSize', 'fontFamily', 'color', 'x', 'y', 'fontWeight'],
        hitTest: 'text-box',
        box: { x: 320, y: 180, width: 640, height: 82 },
        modificationScope: '仅该文字对象',
      },
      ...UNIT_SEGMENTS.map((segment) => ({
        id: `obj-subtitle-${segment.paragraphId}`,
        kind: 'subtitle',
        semanticRole: `字幕 ${segment.paragraphId}（来自锁定文案 v1）`,
        timeline: { startFrame: segment.startFrame, durationFrames: segment.durationFrames },
        derivedFrom: {
          lockedCopy: `locked-lines-v1.json#${segment.paragraphId}`,
          audio: segment.audioFile,
          audioDurationSeconds: segment.actualDurationSeconds,
        },
        params: {
          text: segment.text,
          fontSize: 30,
          fontFamily: 'Microsoft YaHei',
          color: '#ffffff',
          backgroundColor: '#000000',
          backgroundOpacity: 0.62,
          safeArea: { bottomPx: 72, maxWidthPx: 1080 },
          x: 640,
          y: 620,
          anchor: 'bottom-center',
        },
        editableProps: ['text', 'startFrame', 'durationFrames', 'color', 'backgroundColor', 'fontSize'],
        hitTest: 'text-box',
        // The declared box covers the drawn text box (font size + drawtext border), so a picture hit
        // and a region check both land on real pixels.
        box: { x: 100, y: 590, width: 1080, height: 76 },
        modificationScope: `仅字幕 ${segment.paragraphId} 及其时间范围`,
      })),
      {
        id: 'obj-audio-main',
        kind: 'audio-continuous',
        semanticRole: '跨镜头连续用户音频',
        timeline: { startFrame: 0, durationFrames: 270 },
        authored: {
          materialId: 'mat-user-audio',
          sourceFile: 'audio/user-audio-continuous-9s-48k-stereo.wav',
          sourceOffsetFrames: 0,
          sourceTotalSeconds: 9.0,
          audioEvents: [
            { atSeconds: 0.0, freqHz: 440 },
            { atSeconds: 3.0, freqHz: 880 },
            { atSeconds: 6.0, freqHz: 1320 },
          ],
        },
        params: { volume: 1.0 },
        editableProps: ['volume', 'startFrame', 'durationFrames'],
        hitTest: 'timeline-track',
        modificationScope: '仅音轨属性；字幕或图形修改不得触碰此轨',
      },
    ],
    soundManifest: {
      copyId: 'locked-lines-v1',
      copyVersion: 'v1',
      audioEvidenceRoot: 'audio',
      segments: UNIT_SEGMENTS.map((segment, index) => ({
        paragraphId: segment.paragraphId,
        text: segment.text,
        audioEvidenceRef: segment.audioFile,
        actualDurationSeconds: segment.actualDurationSeconds,
        order: index + 1,
        gapsBeforeFrames: index === 0 ? 0 : 3,
        authoredStartFrame: segment.startFrame,
        authoredDurationFrames: segment.durationFrames,
        sourceOffsetFrames: 0,
        wordLevel: null,
      })),
      mix: { targetLufs: -16, note: '本卡不做响度归一化，只记录用户音频原样进入混音' },
    },
    lockedCopy: {
      file: 'text/locked-lines-v1.json',
      version: 'v1',
      rule: '字幕时间来自分段音频真实时长 + 声明的 3 帧间隔；不按字数估算，不做 ASR 对齐',
    },
    registeredRisks: [
      { id: 'R1', risk: '文字裁切', check: '中文长句在 1280×720 与 1080×1920 下完整可读' },
      { id: 'R2', risk: '运动连续', check: '程序图案与计数文字连续，不出现跳帧' },
      { id: 'R3', risk: '转场', check: '120–149 帧重叠区两场景同时可见，总时长 270 帧不被破坏' },
      { id: 'R4', risk: '音画同步', check: '3.0s 与 6.0s 频率突变落在正确画面位置' },
      { id: 'R5', risk: '局部保护', check: '只改字幕 S02 时，S01/S03、图形、视频源偏移、音轨均不变' },
    ],
    normalization: null,
  }
  // CT-04 v1.1 §2.1: scope is part of the plan data, not a renderer default. Subtitles and the
  // continuous audio are movie-level (they may cross a cut); everything else belongs to a scene.
  plan.objects = plan.objects.map((object) => ({
    ...object,
    scope: object.kind === 'subtitle' || object.kind === 'audio-continuous' ? 'movie' : 'scene',
  }))
  return plan
}

/**
 * The C02-shaped variant that keeps the Canvas object.
 *
 * Used only to prove the filter-graph adapter REFUSES the object kind it cannot honour, and that
 * the refusal names the reason and the remedy instead of rendering a black rectangle.
 *
 * @param {any} renderablePlan a plan from {@link buildC12UnitPlan}
 * @returns {any}
 */
export function buildC02SourceVariant(renderablePlan) {
  const plan = JSON.parse(JSON.stringify(renderablePlan))
  plan.planId = 'c12-unit-c02-source'
  plan.planVersion = '1.0.0-source'
  const index = plan.objects.findIndex((object) => object.id === 'obj-sceneA-pattern')
  plan.objects[index] = {
    id: 'obj-canvas-motion',
    kind: 'canvas-program-animation',
    semanticRole: 'HTML/Canvas 程序动画（C02 原对象）',
    scope: 'scene',
    sceneId: 'scene-A',
    timeline: { startFrame: 0, durationFrames: 150 },
    params: {
      renderer: 'canvas2d',
      particleCount: 24,
      speed: 1.0,
      amplitude: 42,
      hue: 198,
      trailLength: 16,
      deterministic: true,
      seed: 20261107,
    },
    editableProps: ['particleCount', 'speed', 'amplitude', 'hue', 'trailLength'],
    hitTest: 'canvas-region',
    box: { x: 800, y: 90, width: 400, height: 240 },
    modificationScope: '仅该 Canvas 实例的参数；不能声称逐粒子可选中',
  }
  plan.scenes[0].objects = plan.scenes[0].objects.map((id) =>
    id === 'obj-sceneA-pattern' ? 'obj-canvas-motion' : id,
  )
  plan.normalization = {
    from: 'obj-canvas-motion',
    kind: 'canvas-program-animation',
    reason: '滤镜图运行时不能执行任意 Canvas 脚本；需要预渲染帧序列或改用支持 Canvas 的运行时',
  }
  return plan
}
