/**
 * The FFmpeg composition adapter: turns a CompositionPlan into one deterministic filter graph.
 *
 * Why FFmpeg is the first real adapter: C06 has only FFmpeg admitted as a working external tool,
 * and its build can render text, stills, existing video, generated program visuals, crossfades and
 * a continuous audio track — every object kind this unit needs except arbitrary Canvas scripts.
 * The adapter therefore declares exactly that vocabulary and REFUSES anything else, instead of
 * drawing a placeholder and calling it done (CT-06 §1 "禁止静默 fallback").
 *
 * Determinism: the whole graph is derived from the plan, the encoder runs single-threaded with a
 * fixed x264 configuration, so two runs of the same plan produce byte-identical files (measured).
 *
 * @module media/render/ffmpeg-adapter
 */

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  buildCacheKey,
  contentHash,
  ConflictError,
  ExternalError,
  IoError,
  SecurityError,
  ValidationError,
  sha256File,
  writeFileAtomic,
} from '../../base/index.js'
import { planFingerprint } from '../plan.js'
import { layoutOf } from '../timeline.js'
import { probeMedia, compareDeclaredToProbed } from '../probe.js'
import { checkRuntimeVersion } from '../toolchain.js'
import { runFfmpeg, sha256 } from '../verify.js'
import { ADAPTER_INTERFACE_VERSION, TASK_STATES, defineAdapter, validateCommon } from './adapter.js'

/** Object kinds this adapter can actually draw. */
export const FFMPEG_OBJECT_KINDS = Object.freeze([
  'solid',
  'text-native',
  'subtitle',
  'image',
  'video-source-with-offset',
  'program-pattern',
  'program-counter',
  'audio-continuous',
])

/** Transitions this adapter can express with real timeline semantics. */
export const FFMPEG_TRANSITIONS = Object.freeze(['cut', 'crossfade', 'wipe'])

/** Motion terms this adapter can express as filter expressions. */
export const FFMPEG_MOTIONS = Object.freeze(['fade-in', 'fade-out', 'hold'])

/** Program generators with a closed, deterministic parameter set. */
export const FFMPEG_PATTERNS = Object.freeze(['life', 'cellauto', 'mandelbrot'])

const FRAME_RATE_LIMIT = Object.freeze({ width: 1920, height: 1920 })

/**
 * Escape a value for use inside a filter graph: FFmpeg treats `:`, `'` and `\` specially.
 * @param {string} value
 */
function escapeFilterValue(value) {
  return String(value).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/** `#rrggbb` → `0xrrggbb` for FFmpeg colour options. @param {string} color */
function fColor(color) {
  const text = String(color ?? '#000000').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return `0x${text.slice(1)}`
  if (/^#[0-9a-fA-F]{8}$/.test(text)) return `0x${text.slice(1)}`
  if (/^0x[0-9a-fA-F]{6,8}$/.test(text)) return text
  // `rgb()` / `rgba()` are legal CSS and plan authors write them (D4). ffmpeg speaks 0xRRGGBB,
  // so convert instead of refusing: a valid colour is not an error just because it is spelled
  // the way every other layer spells it.
  const rgb = text.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9]*\.?[0-9]+)\s*)?\)$/i)
  if (rgb !== null) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((part) => Number(part))
    if ([r, g, b].every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const hex = [r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')
      const alpha = rgb[4] === undefined ? null : Number(rgb[4])
      if (alpha === null) return `0x${hex}`
      if (alpha >= 0 && alpha <= 1) {
        return `0x${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
      }
    }
  }
  if (/^[a-zA-Z]+$/.test(text)) return text
  throw new ValidationError('无法识别的颜色值', { color: text })
}

/** Seconds string with fixed precision, so two runs produce the same filter graph text. */
function seconds(frames, fpsNumerator, fpsDenominator) {
  return Number(((frames * fpsDenominator) / fpsNumerator).toFixed(6)).toString()
}

/**
 * Build every piece the renderer needs from a plan. Pure: no file writes, no process spawns.
 *
 * @param {any} plan normalized plan
 * @param {{ tier: 'preview'|'final', width?: number, height?: number, range?: { startFrame: number,
 * endFrameExclusive: number }|null }} options
 * @returns {any}
 */
export function buildCompositionGraph(plan, options) {
  const layout = layoutOf(plan)
  const fpsNumerator = plan.timebase.fpsNumerator
  const fpsDenominator = plan.timebase.fpsDenominator
  const fps = `${fpsNumerator}/${fpsDenominator}`
  const tier = options?.tier ?? 'final'
  const width = options?.width ?? plan.outputSpec.width
  const height = options?.height ?? plan.outputSpec.height
  const fontFile = plan.fonts?.[0]?.file
  if (typeof fontFile !== 'string' || fontFile.length === 0) {
    throw new ValidationError('本适配器需要显式字体文件，不能依赖系统默认字体', { field: 'fonts[0].file' })
  }

  /** @type {Array<{ args: string[] }>} */
  const inputs = []
  /** @type {string[]} */
  const chain = []
  /** @type {Array<{ relPath: string, content: string }>} */
  const textFiles = []
  const notes = []

  /** @param {string[]} args */
  const addInput = (args) => {
    inputs.push({ args })
    return inputs.length - 1
  }

  const materialIndex = new Map()
  const materialInput = (materialId, file, extraArgs = []) => {
    if (materialIndex.has(materialId)) return materialIndex.get(materialId)
    const index = addInput([...extraArgs, '-i', file])
    materialIndex.set(materialId, index)
    return index
  }

  /** Text objects need a file, so the CJK text never has to survive filter escaping. */
  const textFileFor = (objectId) => {
    const relPath = `texts/${objectId.replace(/[^a-z0-9-]/gi, '_')}.txt`
    return relPath
  }

  const drawTextFilter = (object, options2 = {}) => {
    const params = object.params ?? {}
    const fontSize = options2.fontSize ?? params.fontSize ?? 32
    const color = fColor(params.color ?? '#ffffff')
    const anchor = params.anchor ?? 'top-left'
    const xExpr = anchor === 'center'
      ? 'x=(w-text_w)/2'
      : anchor === 'bottom-center'
        ? 'x=(w-text_w)/2'
        : `x=${Number(params.x ?? 0)}`
    const yExpr = anchor === 'center'
      ? `y=${Number(params.y ?? 0)}-text_h/2`
      : anchor === 'bottom-center'
        ? `y=h-${Number(params.safeArea?.bottomPx ?? 72)}-text_h`
        : `y=${Number(params.y ?? 0)}`
    const box = options2.box === true || object.kind === 'subtitle'
    const boxColor = fColor(params.backgroundColor ?? '#000000')
    const boxAlpha = Number(params.backgroundOpacity ?? 0.62)
    const parts = [
      `fontfile='${escapeFilterValue(fontFile)}'`,
      `textfile='${textFileFor(object.id)}'`,
      `fontsize=${Math.round(fontSize)}`,
      `fontcolor=${color}`,
      xExpr,
      yExpr,
    ]
    if (box) {
      parts.push('box=1', `boxcolor=${boxColor}@${boxAlpha}`, 'boxborderw=14')
    }
    if (options2.alphaExpression !== undefined) parts.push(`alpha='${options2.alphaExpression}'`)
    if (options2.enableExpression !== undefined) parts.push(`enable='${options2.enableExpression}'`)
    return `drawtext=${parts.join(':')}`
  }

  const counterFilter = (object, sceneStartFrame) => {
    const params = object.params ?? {}
    return `drawtext=fontfile='${escapeFilterValue(fontFile)}':text='%{eif\\:n+${sceneStartFrame}\\:d\\:3}':fontsize=${Math.round(
      Number(params.fontSize ?? 32),
    )}:fontcolor=${fColor(params.color ?? '#ffffff')}:x=${Number(params.x ?? 0)}:y=${Number(params.y ?? 0)}`
  }

  /**
   * Motion → a drawtext alpha expression. Only opacity terms are supported; anything else was
   * already refused by validatePlan, so reaching the fallback here would be a programming error.
   */
  const alphaExpressionFor = (object, sceneStartFrame) => {
    const motion = object.motion
    if (motion === undefined || motion === null) return undefined
    const enter = motion.enter?.durationFrames ?? 0
    const hold = motion.hold?.durationFrames ?? 0
    const exit = motion.exit?.durationFrames ?? 0
    // `t` inside drawtext is the SCENE STREAM's local time: the scene is trimmed and re-based with
    // `setpts=PTS-STARTPTS`, so scene start is t=0. Adding `sceneStartSeconds` here shifted every
    // non-first-scene text by its whole scene offset (D2: s2 text appeared 216 frames late).
    const enterStart = ((object.timeline.startFrame - sceneStartFrame) * fpsDenominator) / fpsNumerator
    const enterEnd = enterStart + (enter * fpsDenominator) / fpsNumerator
    const exitStart = enterEnd + (hold * fpsDenominator) / fpsNumerator
    const exitEnd = exitStart + (exit * fpsDenominator) / fpsNumerator
    const f = (value) => Number(value.toFixed(6))
    if (motion.term === 'fade-in' && enter > 0) {
      return `if(lt(t,${f(enterStart)}),0,if(lt(t,${f(enterEnd)}),(t-${f(enterStart)})/${f(enterEnd - enterStart)},1))`
    }
    if (motion.term === 'fade-out' && exit > 0) {
      return `if(lt(t,${f(exitStart)}),1,if(lt(t,${f(exitEnd)}),(${f(exitEnd)}-t)/${f(exitEnd - exitStart)},0))`
    }
    if (motion.term === 'hold') return undefined
    return `if(lt(t,${f(enterEnd)}),(t-${f(enterStart)})/${f(Math.max(1e-6, enterEnd - enterStart))},if(gt(t,${f(exitStart)}),(${f(exitEnd)}-t)/${f(Math.max(1e-6, exitEnd - exitStart))},1))`
  }

  /** Build one scene into a labelled stream. */
  const sceneChain = (scene) => {
    const duration = seconds(scene.durationFrames, fpsNumerator, fpsDenominator)
    const sceneObjects = plan.objects.filter((object) => object.sceneId === scene.id && (object.scope ?? 'scene') === 'scene')
    const background = sceneObjects.find((object) => object.kind === 'solid')
    const baseColor = fColor(background?.params?.color ?? '#000000')
    let label = `bg_${scene.id.replace(/[^a-z0-9]/gi, '_')}`
    chain.push(`color=c=${baseColor}:s=${width}x${height}:r=${fps}:d=${duration}[${label}]`)

    let counter = 0
    for (const object of sceneObjects) {
      if (object.kind === 'solid') continue
      const out = `${label}_${counter}`
      counter += 1
      if (object.kind === 'program-pattern') {
        const params = object.params ?? {}
        const box = object.box ?? { x: 0, y: 0, width, height }
        const bw = Math.max(2, Math.round(Number(box.width)))
        const bh = Math.max(2, Math.round(Number(box.height)))
        const pattern = params.pattern ?? 'life'
        let source
        if (pattern === 'life') {
          source = `life=s=${bw}x${bh}:r=${fps}:mold=${Number(params.mold ?? 10)}:ratio=${Number(params.ratio ?? 0.1)}:death_color=${fColor(params.deathColor ?? '#000000')}:life_color=${fColor(params.lifeColor ?? '#38bdf8')}:seed=${Number(params.seed ?? 1)}`
        } else if (pattern === 'cellauto') {
          source = `cellauto=s=${bw}x${bh}:r=${fps}:rule=${Number(params.rule ?? 110)}:seed=${Number(params.seed ?? 1)}`
        } else if (pattern === 'mandelbrot') {
          source = `mandelbrot=s=${bw}x${bh}:r=${fps}`
        } else {
          throw new ValidationError('不支持的图案生成器', { pattern: String(pattern) })
        }
        const index = addInput(['-f', 'lavfi', '-i', source])
        chain.push(
          `[${index}:v]trim=duration=${duration},setpts=PTS-STARTPTS,format=rgba[p_${out}]`,
        )
        chain.push(`[${label}][p_${out}]overlay=x=${Number(box.x ?? 0)}:y=${Number(box.y ?? 0)}:shortest=1[${out}]`)
        label = out
        continue
      }
      if (object.kind === 'video-source-with-offset' || object.kind === 'image') {
        const authored = object.authored ?? {}
        const file = authored.resolvedFile ?? authored.sourceFile
        if (typeof file !== 'string' || file.length === 0) throw new ValidationError('视频对象缺少源文件', { objectId: object.id })
        const index = materialInput(
          object.id,
          file,
          object.kind === 'image' ? ['-loop', '1'] : [],
        )
        const offsetFrames = authored.sourceOffsetFrames ?? 0
        const objectDuration = seconds(object.timeline.durationFrames, fpsNumerator, fpsDenominator)
        const offsetSeconds = seconds(offsetFrames, fpsNumerator, fpsDenominator)
        const fit = (object.params?.fit ?? 'cover') === 'cover'
          ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
          : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
        const opacity = Number(object.params?.opacity ?? 1)
        const alpha = opacity >= 1 ? '' : `,colorchannelmixer=aa=${opacity}`
        chain.push(
          `[${index}:v]trim=start=${offsetSeconds}:duration=${objectDuration},setpts=PTS-STARTPTS,${fit},format=rgba${alpha}[v_${out}]`,
        )
        chain.push(`[${label}][v_${out}]overlay=x=0:y=0:shortest=1[${out}]`)
        label = out
        continue
      }
      if (object.kind === 'text-native') {
        textFiles.push({ relPath: textFileFor(object.id), content: String(object.params?.text ?? '') })
        const alpha = alphaExpressionFor(object, scene.startFrame)
        chain.push(`[${label}]${drawTextFilter(object, { alphaExpression: alpha })}[${out}]`)
        label = out
        continue
      }
      if (object.kind === 'program-counter') {
        chain.push(`[${label}]${counterFilter(object, scene.startFrame)}[${out}]`)
        label = out
        continue
      }
      throw new ValidationError('适配器无法绘制该对象类型', { objectId: object.id, kind: object.kind })
    }
    chain.push(`[${label}]format=yuv420p[s_${scene.id.replace(/[^a-z0-9]/gi, '_')}]`)
    return `s_${scene.id.replace(/[^a-z0-9]/gi, '_')}`
  }

  const sceneLabels = layout.scenes.map((scene) => sceneChain(scene))

  // Transitions chain the scene streams together.
  let videoLabel = sceneLabels[0]
  // `xfade`'s offset is measured on the ACCUMULATED stream, not on the incoming scene's own
  // duration. Using the previous scene's local duration happened to be right for exactly one
  // transition and cut every later one short (D3: 1464 declared frames rendered as 696).
  let accumulatedFrames = layout.scenes[0].durationFrames
  for (let index = 1; index < sceneLabels.length; index += 1) {
    const transition = plan.transitions.find(
      (entry) => entry.fromScene === layout.scenes[index - 1].id && entry.toScene === layout.scenes[index].id,
    )
    const out = index === sceneLabels.length - 1 ? 'vjoined' : `vjoined_${index}`
    if (transition === undefined || transition.kind === 'cut') {
      chain.push(`[${videoLabel}][${sceneLabels[index]}]concat=n=2:v=1:a=0[${out}]`)
      accumulatedFrames += layout.scenes[index].durationFrames
    } else {
      const overlapSeconds = seconds(transition.overlapFrames, fpsNumerator, fpsDenominator)
      const offsetSeconds = seconds(
        accumulatedFrames - transition.overlapFrames,
        fpsNumerator,
        fpsDenominator,
      )
      const xfadeTransition = transition.kind === 'wipe' ? 'wipeleft' : 'fade'
      chain.push(
        `[${videoLabel}][${sceneLabels[index]}]xfade=transition=${xfadeTransition}:duration=${overlapSeconds}:offset=${offsetSeconds}[${out}]`,
      )
      // The joined stream now ends at (previous end) + (this scene) - (overlap).
      accumulatedFrames += layout.scenes[index].durationFrames - transition.overlapFrames
    }
    videoLabel = out
  }

  // Movie-level text (subtitles) is drawn above everything, with its real window as `enable`.
  const movieText = plan.objects.filter(
    (object) => (object.scope ?? 'scene') === 'movie' && ['subtitle', 'text-native'].includes(object.kind),
  )
  movieText.forEach((object, index) => {
    textFiles.push({ relPath: textFileFor(object.id), content: String(object.params?.text ?? '') })
    const start = (object.timeline.startFrame * fpsDenominator) / fpsNumerator
    const end = ((object.timeline.startFrame + object.timeline.durationFrames) * fpsDenominator) / fpsNumerator
    const out = `vtext_${index}`
    const filter = drawTextFilter(object, {
      enableExpression: `gte(t,${Number(start.toFixed(6))})*lt(t,${Number(end.toFixed(6))})`,
    })
    chain.push(`[${videoLabel}]${filter}[${out}]`)
    videoLabel = out
  })

  const totalFrames = layout.totalFrames
  const range = options?.range ?? null
  if (range !== null && range !== undefined) {
    const startFrame = Math.max(0, Math.min(totalFrames, range.startFrame))
    const endFrame = Math.max(startFrame + 1, Math.min(totalFrames, range.endFrameExclusive))
    chain.push(`[${videoLabel}]trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[vout]`)
  } else {
    chain.push(`[${videoLabel}]fps=${fps},format=yuv420p,setsar=1[vout]`)
  }

  // Audio: every track is placed on the movie timeline, never on a remapped scene timeline.
  // Stills ask for `includeAudio: false`: an unused audio output would make the filter graph
  // invalid ("output 0 unconnected") rather than simply silent.
  const audioObjects = options?.includeAudio === false
    ? []
    : plan.objects.filter((object) => object.kind === 'audio-continuous')
  const audioChain = []
  audioObjects.forEach((object, index) => {
    const authored = object.authored ?? {}
    const file = authored.resolvedFile ?? authored.sourceFile
    const inputIndex = materialInput(`${object.id}:audio`, file)
    const offsetSeconds = seconds(authored.sourceOffsetFrames ?? 0, fpsNumerator, fpsDenominator)
    const durationSeconds = seconds(object.timeline.durationFrames, fpsNumerator, fpsDenominator)
    const delayMs = Math.round(((object.timeline.startFrame * fpsDenominator) / fpsNumerator) * 1000)
    const volume = Number(object.params?.volume ?? 1)
    const parts = [
      `[${inputIndex}:a]atrim=start=${offsetSeconds}:duration=${durationSeconds}`,
      'asetpts=PTS-STARTPTS',
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
    ]
    if (volume !== 1) parts.push(`volume=${volume}`)
    if (delayMs > 0) parts.push(`adelay=${delayMs}|${delayMs}`)
    audioChain.push(`${parts.join(',')}[a_${index}]`)
  })
  let audioLabel = null
  if (audioChain.length === 1) {
    audioLabel = 'a_0'
  } else if (audioChain.length > 1) {
    audioChain.push(
      `${audioObjects.map((_, index) => `[a_${index}]`).join('')}amix=inputs=${audioChain.length}:normalize=0[aout]`,
    )
    audioLabel = 'aout'
  }
  if (audioLabel !== null) {
    const audioRange = options?.range ?? null
    if (audioRange !== null && audioRange !== undefined) {
      const startSeconds = seconds(Math.max(0, audioRange.startFrame), fpsNumerator, fpsDenominator)
      const endSeconds = seconds(Math.min(totalFrames, audioRange.endFrameExclusive), fpsNumerator, fpsDenominator)
      chain.push(`[${audioLabel}]atrim=start=${startSeconds}:end=${endSeconds},asetpts=PTS-STARTPTS[aout_r]`)
      audioLabel = 'aout_r'
    }
  }

  const graph = [...chain, ...audioChain].join(';\n')
  return {
    graph,
    inputs,
    textFiles,
    videoLabel: 'vout',
    audioLabel,
    width,
    height,
    fps,
    totalFrames,
    range,
    notes,
  }
}

/**
 * Create the adapter.
 *
 * @param {object} input
 * @param {any} input.toolchain result of resolveToolchain
 * @param {string} input.workRoot absolute work directory (tasks, cache, temp)
 * @param {any} input.clock
 * @param {string} input.materialRoot absolute root the plan's materials are relative to
 * @param {{ ffmpegPath?: string }} [input.overrides]
 */
export function createFfmpegAdapter(input) {
  const toolchain = input.toolchain
  const workRoot = path.resolve(input.workRoot)
  const materialRoot = path.resolve(input.materialRoot)
  const clock = input.clock
  const ffmpegPath = input.overrides?.ffmpegPath ?? toolchain.ffmpeg.path
  const ffprobePath = toolchain.ffprobe.path

  const caps = {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    runtimeId: 'ffmpeg',
    runtimeVersion: toolchain.ffmpeg.version,
    objectKinds: [...FFMPEG_OBJECT_KINDS],
    transitions: [...FFMPEG_TRANSITIONS],
    motions: [...FFMPEG_MOTIONS],
    tiers: {
      preview: { widthScale: 0.5, crf: 30, preset: 'ultrafast', sameGraph: true, note: '同构图预览代理，不是交互式播放' },
      final: { crf: 18, preset: 'veryfast', note: '正式输出' },
    },
    pixelFormats: ['yuv420p'],
    containers: ['mp4'],
    audio: { codecs: ['aac'], sampleRates: [48000], channels: [2] },
    determinism: {
      singleThread: true,
      fixedX264Params: true,
      measuredByteIdentical: true,
      note: '同一计划两次渲染字节一致（本机实测，见 C12 证据）；不承诺跨机器一致',
    },
    resume: { supported: false, note: '支持暂停并记录位置；不承诺从原帧续渲（D3 已接受整体重渲）' },
    progress: { frames: true, phases: ['prepare', 'encode', 'verify', 'publish'] },
    limits: {
      maxFrameSize: FRAME_RATE_LIMIT,
      unsupported: [
        '任意 Canvas 脚本（需预渲染帧序列或换运行时）',
        '压缩音频的采样级同步微调',
        '透明输出（MP4 无 alpha）',
        'VFR 逐帧精度（先规范化）',
      ],
    },
    externalTools: [{ toolId: 'ffmpeg', version: toolchain.ffmpeg.version, required: true, license: '外部 GPL 构建，用户自行遵守，不入插件包' }],
  }

  /** Resolve a material path safely inside the material root (CT-12 §3). */
  const resolveMaterial = (relative) => {
    if (typeof relative !== 'string' || relative.length === 0) {
      throw new ValidationError('素材路径必须是非空字符串')
    }
    const normalized = path.normalize(relative).replace(/\\/g, '/')
    if (path.isAbsolute(relative) || normalized.startsWith('..')) {
      throw new SecurityError('素材路径必须相对素材根目录且不能越界', { file: relative })
    }
    const absolute = path.resolve(materialRoot, normalized)
    if (!absolute.startsWith(materialRoot + path.sep) && absolute !== materialRoot) {
      throw new SecurityError('素材解析后越出素材根目录', { file: relative })
    }
    return absolute
  }

  /** Resolve every material reference into an absolute path, once. */
  const materializePlan = (plan) => {
    const objects = plan.objects.map((object) => {
      const file = object?.authored?.sourceFile
      if (file === undefined) return object
      const absolute = resolveMaterial(file)
      if (!fs.existsSync(absolute)) {
        throw new IoError('素材文件不存在', { details: { file, absolute } })
      }
      return { ...object, authored: { ...object.authored, resolvedFile: absolute } }
    })
    return { ...plan, objects }
  }

  /** Probe results by absolute path, so validation does not re-probe the same file per object. */
  const probeCache = new Map()
  const probeCached = (file) => {
    if (!probeCache.has(file)) probeCache.set(file, probeMedia(ffprobePath, file))
    return probeCache.get(file)
  }

  const validatePlanImpl = (plan, context = {}) => {
    const common = validateCommon(plan, caps, {
      materialExists: (file) => {
        try {
          return fs.existsSync(resolveMaterial(file))
        } catch {
          return false
        }
      },
      fontExists: (file) => typeof file === 'string' && fs.existsSync(file),
    })
    const problems = [...common.problems]
    const version = checkRuntimeVersion(toolchain, plan)
    if (!version.matches) {
      problems.push({ code: 'runtime-version-mismatch', detail: version.note })
    }
    for (const object of plan.objects ?? []) {
      if (object.kind === 'program-pattern' && !FFMPEG_PATTERNS.includes(object.params?.pattern ?? 'life')) {
        problems.push({
          code: 'pattern-unsupported',
          detail: `图案生成器 ${String(object.params?.pattern)} 不在本适配器支持清单内`,
          remedy: `可用：${FFMPEG_PATTERNS.join('、')}`,
        })
      }
      if (object.kind === 'video-source-with-offset') {
        const authored = object.authored ?? {}
        if (!Number.isInteger(authored.sourceOffsetFrames)) {
          problems.push({ code: 'source-offset-missing', detail: `视频对象 ${object.id} 缺少源偏移` })
          continue
        }
        // The source range must exist in the real file. Without this check FFmpeg quietly emits a
        // shorter clip and the composition loses frames while every exit code stays zero.
        try {
          const file = resolveMaterial(authored.sourceFile)
          const probed = probeCached(file)
          if (probed.readable !== true) {
            problems.push({
              code: 'source-unreadable',
              detail: `素材无法读取：${authored.sourceFile}`,
              remedy: '先修复或规范化素材，再重新生成计划版本',
            })
          } else {
            const offsetSeconds =
          (authored.sourceOffsetFrames * plan.timebase.fpsDenominator) / plan.timebase.fpsNumerator
            const durationSeconds =
          (object.timeline.durationFrames * plan.timebase.fpsDenominator) / plan.timebase.fpsNumerator
            const sourceSeconds = probed.format.durationSeconds
            if (sourceSeconds !== null && offsetSeconds + durationSeconds > sourceSeconds + 0.001) {
              problems.push({
                code: 'source-range-exceeded',
                detail:
                  `对象 ${object.id} 需要源 ${offsetSeconds.toFixed(3)}s–${(offsetSeconds + durationSeconds).toFixed(3)}s，` +
                  `但源文件只有 ${sourceSeconds.toFixed(3)}s`,
                remedy: '缩短该实例、减小源偏移，或换用更长的素材；不得让渲染器静默截断',
              })
            }
          }
        } catch (error) {
          problems.push({ code: 'source-path-refused', detail: `素材路径被拒绝：${String(error.message)}` })
        }
      }
    }
    return { ok: problems.length === 0, problems, capabilities: caps, context: { materialRoot } }
  }

  /** Cache key includes every dependency that can change a pixel. */
  const cacheKeyFor = (plan, options) => {
    const fonts = (plan.fonts ?? []).map((font) => ({
      family: font.family,
      sha256: fs.existsSync(font.file) ? sha256File(font.file) : null,
    }))
    const materials = (plan.materials ?? []).map((material) => ({ id: material.id, sha256: material.sha256 ?? null }))
    return buildCacheKey({
      plan: planFingerprint(plan),
      tier: options.tier,
      width: options.width,
      height: options.height,
      range: options.range ?? null,
      adapter: { id: 'ffmpeg-adapter', version: ADAPTER_INTERFACE_VERSION },
      tool: { ffmpeg: toolchain.ffmpeg.version },
      fonts,
      materials,
      graph: contentHash(buildCompositionGraph(plan, options).graph),
    })
  }

  /**
   * Render one plan into a real MP4.
   * @param {any} plan
   * @param {{ tier: 'preview'|'final', range?: any, outputPath: string, taskId?: string, allowOverwrite?: boolean }} request
   */
  const render = (plan, request) => {
    const validated = validatePlanImpl(plan)
    if (!validated.ok) {
      throw new ValidationError('计划未通过本适配器校验', { details: { problems: validated.problems } })
    }
    const tier = request.tier
    const tierSpec = tier === 'preview' ? caps.tiers.preview : caps.tiers.final
    const width = tier === 'preview' ? Math.max(
      2,
      Math.round(plan.outputSpec.width * tierSpec.widthScale / 2) * 2,
    ) : plan.outputSpec.width
    const height = tier === 'preview' ? Math.max(
      2,
      Math.round(plan.outputSpec.height * tierSpec.widthScale / 2) * 2,
    ) : plan.outputSpec.height
    const options = { tier, width, height, range: request.range ?? null }
    const executable = materializePlan(plan)
    const graph = buildCompositionGraph(executable, options)
    const cache = cacheKeyFor(plan, options)

    const startedAt = clock.iso()
    const token = request.taskId ?? `render-${cache.key.slice(0, 12)}`
    const runDir = path.join(workRoot, 'runs', token)
    fs.mkdirSync(path.join(runDir, 'texts'), { recursive: true })
    fs.mkdirSync(path.join(runDir, 'inputs'), { recursive: true })
    for (const textFile of graph.textFiles) {
      writeFileAtomic(path.join(runDir, textFile.relPath), textFile.content)
    }
    const graphPath = path.join(runDir, 'filtergraph.txt')
    writeFileAtomic(graphPath, graph.graph)

    const cacheDir = path.join(workRoot, 'cache', tier)
    fs.mkdirSync(cacheDir, { recursive: true })
    const cachePath = path.join(cacheDir, `${cache.key}.mp4`)
    const cacheMetaPath = path.join(cacheDir, `${cache.key}.json`)
    const outputPath = path.resolve(request.outputPath)
    if (fs.existsSync(outputPath) && request.allowOverwrite !== true) {
      throw new ConflictError('输出已存在；不覆盖旧结果，请新建版本', {
        outputPath,
        remedy: '为本次渲染创建新的版本目录，或显式确认覆盖',
      })
    }

    const framesExpected = graph.range === null
      ? graph.totalFrames
      : Math.max(1, Math.min(graph.totalFrames, graph.range.endFrameExclusive) - Math.max(0, graph.range.startFrame))
    const outputSeconds = Number(
      ((framesExpected + 0.5) * plan.timebase.fpsDenominator / plan.timebase.fpsNumerator).toFixed(6),
    ).toString()

    /** @type {'warm'|'cold'} */
    let cacheState = 'cold'
    let producedPath = null
    let executionMs = 0
    let command = null
    let stderrTail = ''

    if (fs.existsSync(cachePath) && fs.existsSync(cacheMetaPath)) {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPath, 'utf8'))
      const actual = sha256File(cachePath)
      if (meta.sha256 === actual) {
        cacheState = 'warm'
        producedPath = cachePath
      } else {
        fs.rmSync(cachePath, { force: true })
      }
    }

    if (producedPath === null) {
      const tempPath = path.join(runDir, `${tier}.mp4`)
      const args = ['-v', 'error', '-y']
      for (const inputSpec of graph.inputs) args.push(...inputSpec.args)
      args.push('-/filter_complex', graphPath)
      args.push('-map', `[${graph.videoLabel}]`)
      if (graph.audioLabel !== null) args.push('-map', `[${graph.audioLabel}]`)
      args.push(
        '-c:v', 'libx264',
        '-preset', tierSpec.preset,
        '-crf', String(tierSpec.crf),
        '-pix_fmt', 'yuv420p',
        '-threads', '1',
        '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:bframes=2:ref=1',
        // `-frames:v` alone stops the muxer while the filter graph keeps pulling from an infinite
        // generator, which piles up buffers until FFmpeg fails with ENOMEM. `-t` bounds production
        // at the source, and `-frames:v` then fixes the exact frame count.
        '-t', outputSeconds,
        '-frames:v', String(framesExpected),
      )
      if (graph.audioLabel !== null) {
        args.push('-c:a', 'aac', '-b:a', tier === 'preview' ? '128k' : '192k', '-ar', '48000', '-ac', '2')
      } else {
        args.push('-an')
      }
      args.push('-movflags', '+faststart', '-f', 'mp4', tempPath)
      const run = runFfmpeg({ ffmpegPath, args, cwd: runDir, timeoutMs: 900000 })
      executionMs = run.timeMs
      command = { binary: ffmpegPath, args, cwd: runDir, graphPath }
      stderrTail = run.stderr.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-8).join(' | ')
      if (!fs.existsSync(tempPath)) {
        throw new ExternalError('FFmpeg 报告成功但没有生成文件', { code: 'OUTPUT_MISSING', details: { tempPath, stderrTail } })
      }
      writeFileAtomic(cachePath, fs.readFileSync(tempPath))
      const meta = {
        key: cache.key,
        components: cache.components,
        sha256: sha256File(cachePath),
        bytes: fs.statSync(cachePath).size,
        planId: plan.planId,
        planVersion: plan.planVersion,
        tier,
        createdAt: clock.iso(),
        toolchain: { ffmpeg: toolchain.ffmpeg.version },
      }
      writeFileAtomic(cacheMetaPath, JSON.stringify(meta, null, 2))
      producedPath = cachePath
    }

    const probed = probeMedia(ffprobePath, producedPath)
    const specComparison = compareDeclaredToProbed(
      tier === 'preview' ? { ...plan.outputSpec, width, height, pixelFormat: 'yuv420p' } : plan.outputSpec,
      probed,
    )
    const sha = sha256File(producedPath)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    if (fs.existsSync(outputPath)) {
      throw new ConflictError('输出在渲染期间被其他写入者占用', { outputPath })
    }
    fs.copyFileSync(producedPath, outputPath)
    const publishedSha = sha256File(outputPath)
    if (publishedSha !== sha) {
      fs.rmSync(outputPath, { force: true })
      throw new IoError('发布后的文件哈希与渲染结果不一致', { details: { expected: sha, actual: publishedSha } })
    }

    const snapshotPath = `${outputPath}.snapshot.json`
    writeFileAtomic(
      snapshotPath,
      JSON.stringify(
        {
          kind: 'ffmpeg-external-engineering-snapshot',
          note: '滤镜图与命令即外部工程快照；它不是第二项目事实源，权威仍是 CompositionPlan 版本',
          runtime: { id: 'ffmpeg', version: toolchain.ffmpeg.version },
          plan: { id: plan.planId, version: plan.planVersion, fingerprint: planFingerprint(plan) },
          graph,
          command,
          cache: { key: cache.key, state: cacheState },
          createdAt: clock.iso(),
        },
        null,
        2,
      ),
    )

    const result = {
      runtimeId: 'ffmpeg',
      runtimeVersion: toolchain.ffmpeg.version,
      adapterId: 'ffmpeg-adapter',
      tier,
      file: outputPath,
      bytes: fs.statSync(outputPath).size,
      sha256: sha,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planFingerprint: planFingerprint(plan),
      recipeRef: plan.productionRecipeRef ?? null,
      declaredSpec: tier === 'preview' ? { ...plan.outputSpec, width, height } : plan.outputSpec,
      probedSpec: {
        width: probed.video?.width ?? null,
        height: probed.video?.height ?? null,
        pixelFormat: probed.video?.pixelFormat ?? null,
        videoCodec: probed.video?.codec ?? null,
        fps: probed.video?.avgRate ?? null,
        audioCodec: probed.audio?.codec ?? null,
        audioSampleRate: probed.audio?.sampleRate ?? null,
        audioChannels: probed.audio?.channels ?? null,
        durationSeconds: probed.format.durationSeconds,
        nbFrames: probed.video?.nbFrames ?? null,
      },
      specComparison,
      execution: {
        startedAt,
        endedAt: clock.iso(),
        durationMs: Number(executionMs.toFixed(1)),
        frames: framesExpected,
        cache: cacheState,
        taskId: token,
      },
      command,
      graph,
      snapshotPath,
      probed,
      knownDifferences: [
        ...(specComparison.differences ?? []).map((entry) => `${entry.field}: 声明 ${entry.declared} / 实测 ${entry.probed}`),
        ...(probed.audio === null ? ['本结果没有音频流（计划未声明音轨时是正常情况）'] : []),
      ],
      checks: {
        frameCount: probed.video?.nbFrames === framesExpected ? 'ok' : 'failed',
        spec: specComparison.ok ? 'ok' : 'failed',
      },
      programChecks: { structuredToolsUsed: true, note: '渲染由声明式滤镜图完成，没有任意代码执行' },
      aiObservation: { viewed: false, listened: false, range: null },
      humanAcceptance: { accepted: false, note: '程序结果不等于用户验收' },
    }
    return result
  }

  const adapter = {
    id: 'ffmpeg-adapter',
    version: ADAPTER_INTERFACE_VERSION,
    /** Absolute binaries actually used; a receipt must be able to name them. */
    ffmpegPath,
    ffprobePath,
    /** Cache key for a plan+tier, exposed so determinism evidence can prove invalidation. */
    computeCacheKey: (plan, options) => cacheKeyFor(plan, options),
    capabilities: () => caps,
    validatePlan: validatePlanImpl,
    /**
     * @param {any} plan
     * @param {{ startFrame: number, endFrameExclusive: number }|null} range
     * @param {'low'|'medium'} quality
     * @param {{ outputPath: string, taskId?: string }} context
     */
    renderPreview(plan, range, quality, context) {
      if (!['low', 'medium'].includes(quality ?? 'medium')) {
        throw new ValidationError('未知预览质量', { quality: String(quality) })
      }
      return render(plan, {
        tier: 'preview',
        range,
        outputPath: context.outputPath,
        taskId: context.taskId,
        allowOverwrite: context.allowOverwrite,
      })
    },
    /** @param {any} plan @param {any} outputSpec @param {{ outputPath: string, taskId?: string }} context */
    renderFinal(plan, outputSpec, context) {
      if (contentHash(outputSpec) !== contentHash(plan.outputSpec)) {
        throw new ValidationError('正式输出规格必须与计划声明的规格一致', {
          details: { planSpec: plan.outputSpec, requestedSpec: outputSpec },
        })
      }
      return render(plan, {
        tier: 'final',
        outputPath: context.outputPath,
        taskId: context.taskId,
        allowOverwrite: context.allowOverwrite,
      })
    },
    /** @param {string} taskId */
    readProgress(taskId) {
      const recordPath = path.join(workRoot, 'tasks', `${taskId}.json`)
      if (!fs.existsSync(recordPath)) return { taskId, state: 'unknown', reason: '没有任务记录' }
      return JSON.parse(fs.readFileSync(recordPath, 'utf8'))
    },
    /** Pausing a running FFmpeg process is not implemented as a signal; the task record holds the position. */
    pause(taskId, work) {
      return { taskId, supported: false, note: '本适配器不支持在进程内暂停；暂停记录由任务记录承担', work: work ?? null }
    },
    cancel(taskId) {
      return { taskId, supported: false, note: '取消以结束任务记录为准；已发布结果不删除' }
    },
    resumeFromSavedWork(workRef) {
      return { taskId: workRef?.taskId ?? null, supported: false, note: '不承诺从原帧续渲；按整体重渲并保留旧结果' }
    },
    probeResult(resultRef) {
      const file = typeof resultRef === 'string' ? resultRef : resultRef?.file
      return probeMedia(ffprobePath, file)
    },
    snapshotExternalEngineering(plan) {
      return { kind: 'ffmpeg-filter-graph', planId: plan.planId, planVersion: plan.planVersion }
    },
    /** Raw pre-encode pixels, for the encoded-vs-authored comparison. */
    renderStillRaw(plan, frame) {
      const executable = materializePlan(plan)
      const graph = buildCompositionGraph(executable, {
        tier: 'final',
        width: plan.outputSpec.width,
        height: plan.outputSpec.height,
        includeAudio: false,
      })
      const runDir = path.join(workRoot, 'stills', `${plan.planId}-${graph.totalFrames}`)
      fs.mkdirSync(path.join(runDir, 'texts'), { recursive: true })
      for (const textFile of graph.textFiles) writeFileAtomic(path.join(runDir, textFile.relPath), textFile.content)
      const stillLabel = 'vstill'
      const graphText = `${graph.graph};\n[${graph.videoLabel}]select=eq(n\\,${frame})[${stillLabel}]`
      const graphPath = path.join(runDir, `still-${frame}.txt`)
      writeFileAtomic(graphPath, graphText)
      const args = ['-v', 'error', '-y']
      for (const inputSpec of graph.inputs) args.push(...inputSpec.args)
      const stillSeconds = Number(
        (((frame + 1) * plan.timebase.fpsDenominator) / plan.timebase.fpsNumerator + 0.5).toFixed(6),
      ).toString()
      args.push('-/filter_complex', graphPath, '-map', `[${stillLabel}]`, '-t', stillSeconds, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1')
      const run = runFfmpeg({ ffmpegPath, args, cwd: runDir, timeoutMs: 600000 })
      const expected = plan.outputSpec.width * plan.outputSpec.height * 3
      if (run.stdout.length !== expected) {
        throw new ExternalError('静帧渲染字节数与画幅不符', {
          code: 'STILL_SIZE_MISMATCH',
          details: { frame, expected, actual: run.stdout.length },
        })
      }
      return { frame, rgb24: run.stdout, sha256: sha256(run.stdout), command: run.command }
    },
    /**
     * Plan a render without running it: the exact argv, working directory and temp output.
     *
     * This exists so interruption can be tested against the REAL command (kill it mid-encode) rather
     * than against a simulation, and so a receipt can quote the invocation.
     *
     * @param {any} plan
     * @param {{ tier?: 'preview'|'final', outputPath: string, range?: any }} request
     */
    planRender(plan, request) {
      const validated = validatePlanImpl(plan)
      if (!validated.ok) {
        throw new ValidationError('计划未通过本适配器校验', { details: { problems: validated.problems } })
      }
      const tier = request.tier ?? 'final'
      const tierSpec = tier === 'preview' ? caps.tiers.preview : caps.tiers.final
      const width =
        tier === 'preview'
          ? Math.max(2, Math.round((plan.outputSpec.width * tierSpec.widthScale) / 2) * 2)
          : plan.outputSpec.width
      const height =
        tier === 'preview'
          ? Math.max(2, Math.round((plan.outputSpec.height * tierSpec.widthScale) / 2) * 2)
          : plan.outputSpec.height
      const options = { tier, width, height, range: request.range ?? null }
      const executable = materializePlan(plan)
      const graph = buildCompositionGraph(executable, options)
      const token = `plan-${contentHash({ plan: planFingerprint(plan), tier }).slice(0, 12)}`
      const runDir = path.join(workRoot, 'runs', token)
      fs.mkdirSync(path.join(runDir, 'texts'), { recursive: true })
      for (const textFile of graph.textFiles) {
        writeFileAtomic(path.join(runDir, textFile.relPath), textFile.content)
      }
      const graphPath = path.join(runDir, 'filtergraph.txt')
      writeFileAtomic(graphPath, graph.graph)
      const framesExpected =
        graph.range === null
          ? graph.totalFrames
          : Math.max(
              1,
              Math.min(graph.totalFrames, graph.range.endFrameExclusive) - Math.max(0, graph.range.startFrame),
            )
      const outputSeconds = Number(
        ((framesExpected + 0.5) * plan.timebase.fpsDenominator) / plan.timebase.fpsNumerator,
      ).toFixed(6)
      const tempOutput = path.join(runDir, `${tier}.mp4`)
      const args = ['-v', 'error', '-y']
      for (const inputSpec of graph.inputs) args.push(...inputSpec.args)
      args.push('-/filter_complex', graphPath, '-map', `[${graph.videoLabel}]`)
      if (graph.audioLabel !== null) args.push('-map', `[${graph.audioLabel}]`)
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        tierSpec.preset,
        '-crf',
        String(tierSpec.crf),
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '1',
        '-x264-params',
        'keyint=30:min-keyint=30:scenecut=0:bframes=2:ref=1',
        '-t',
        outputSeconds,
        '-frames:v',
        String(framesExpected),
      )
      if (graph.audioLabel !== null) {
        args.push('-c:a', 'aac', '-b:a', tier === 'preview' ? '128k' : '192k', '-ar', '48000', '-ac', '2')
      } else {
        args.push('-an')
      }
      args.push('-movflags', '+faststart', '-f', 'mp4', tempOutput)
      return {
        command: { binary: ffmpegPath, args, cwd: runDir },
        tempOutput,
        publishTarget: path.resolve(request.outputPath),
        framesExpected,
        graphPath,
      }
    },
    /** Real tool schema read-back: the FFmpeg options this adapter actually depends on. */
    describeRuntimeSchema() {
      const help = spawnSync(ffmpegPath, ['-hide_banner', '-h', 'full'], {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      })
      const text = `${String(help.stdout ?? '')}\n${String(help.stderr ?? '')}`
      const flags = [...text.matchAll(/^\s*-([a-z0-9_]+)/gm)].map((match) => match[1])
      return {
        runtime: 'ffmpeg',
        version: toolchain.ffmpeg.version,
        entry: ffmpegPath,
        flagsUsed: ['i', 'filter_complex', 'map', 'c:v', 'c:a', 'pix_fmt', 't', 'frames:v', 'threads', 'x264-params'],
        flagsAvailable: [...new Set(flags)].sort().slice(0, 400),
        probedAt: clock.iso(),
      }
    },
    /** Pre-change state read-back before rendering (CT-14 step 2). */
    readPreChangeState(plan) {
      return {
        planId: plan.planId,
        planVersion: plan.planVersion,
        fingerprint: planFingerprint(plan),
        totalFrames: plan.timebase.totalFrames,
        objectCount: plan.objects.length,
        outputSpec: plan.outputSpec,
        materials: (plan.materials ?? []).map((material) => {
          const absolute = path.resolve(materialRoot, material.file)
          const exists = fs.existsSync(absolute)
          return { id: material.id, exists, bytes: exists ? fs.statSync(absolute).size : null }
        }),
        readAt: clock.iso(),
      }
    },
    describe() {
      return {
        adapterId: 'ffmpeg-adapter',
        interfaceVersion: ADAPTER_INTERFACE_VERSION,
        runtime: { id: 'ffmpeg', version: toolchain.ffmpeg.version },
        capabilities: caps,
        materialRoot,
        workRoot,
        states: TASK_STATES,
      }
    },
  }
  return defineAdapter(adapter)
}
