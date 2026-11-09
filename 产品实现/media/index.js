/**
 * MEDIA-RUNTIME public entry surface.
 *
 * This is the only supported import path for the media module. Later cards (C13, C14, C15) call
 * `createMediaRuntime` and use the adapter, plan, object, sound and repair APIs; they must not
 * import `media/*.js` internals, so an internal refactor cannot break them silently.
 *
 * @module media
 */

import path from 'node:path'
import { Clock } from '../base/index.js'
import { createFfmpegAdapter } from './render/ffmpeg-adapter.js'
import { createRemotionAdapter } from './render/remotion-adapter.js'
import { createHyperframesAdapter } from './render/hyperframes-adapter.js'
import fs from 'node:fs'
import { createTaskStore } from './render/adapter.js'
import { createEvidenceRegistry } from './evidence.js'
import { probeMedia } from './probe.js'

export {
  PLAN_SCHEMA_VERSION,
  UNIT_PROFILES,
  PLAN_OPERATIONS,
  OBJECT_KINDS,
  TRANSITION_KINDS,
  deriveLayout,
  collectPlanProblems,
  normalizePlan,
  planFingerprint,
  diffPlans,
  assertRepairScope,
  frameDurationSeconds,
} from './plan.js'
export {
  layoutOf,
  activeObjectsAt,
  scenesAt,
  transitionAt,
  transitionParticipants,
  checkTransitionCoverage,
  objectWindow,
  isVisibleAt,
  mapMovieFrameToSource,
  sourceRangeOf,
  formatTimecode,
  mergeFrameRanges,
  uncoveredFrameRanges,
  fpsOf,
} from './timeline.js'
export {
  buildObjectRegistry,
  hitTest,
  describeSelection,
  editScopeOf,
  assertEditable,
  describeFlattened,
  geometryOf,
  frameSizeOf,
  FLATTENED_GRANULARITY,
} from './objects.js'
export { createTimeRemap, assertAudioKeepsMovieTime, describeAudioTimeTruth, REMAP_MODES } from './remap.js'
export {
  MOTION_TERMS,
  EASING,
  listMotionTerms,
  compileMotionSpec,
  fitMotionToWindow,
  scaleMotionCoordinates,
  substituteText,
  bumpVersion,
  describeKitScope,
  applyPropertyChange,
} from './motion.js'
export {
  buildSoundManifest,
  subtitleWindows,
  checkSubtitleAudioRelation,
  describeAudioCoverage,
  describeSoundTruth,
  compareAudioIdentity,
  secondsToFrames,
  assertNoWordLevel,
} from './sound.js'
export { resolveToolchain, probeBinaryVersion, readAdoptedToolLocation, findOnPath, checkRuntimeVersion } from './toolchain.js'
export {
  probeMedia,
  compareDeclaredToProbed,
  classifyCompatibility,
  requireReadableMedia,
  frameCountOf,
  assertSpecMatch,
} from './probe.js'
export {
  runFfmpeg,
  decodeFrames,
  decodeAllFrames,
  extractAudioPcm,
  frameDiff,
  isWithinTolerance,
  audioEnvelope,
  bestEnvelopeLag,
  comparePreEncodeToDecoded,
  checkEncodedResult,
  checkLoopFrames,
  checkTextRegion,
  ENCODE_COMPARE_DEFAULTS,
} from './verify.js'
export {
  ADAPTER_INTERFACE_VERSION,
  TASK_STATES,
  NO_AUTO_RETRY_STATES,
  RenderTask,
  createTaskStore,
  defineAdapter,
  validateCommon,
} from './render/adapter.js'
export {
  createHyperframesAdapter,
  buildHyperframesDocument,
  HYPERFRAMES_OBJECT_KINDS,
  HYPERFRAMES_TRANSITIONS,
  HYPERFRAMES_MOTIONS,
} from './render/hyperframes-adapter.js'
export {
  createRemotionAdapter,
  prepareRemotionPlan,
  REMOTION_OBJECT_KINDS,
  REMOTION_TRANSITIONS,
  REMOTION_MOTIONS,
} from './render/remotion-adapter.js'
export {
  createFfmpegAdapter,
  buildCompositionGraph,
  FFMPEG_OBJECT_KINDS,
  FFMPEG_TRANSITIONS,
  FFMPEG_MOTIONS,
  FFMPEG_PATTERNS,
} from './render/ffmpeg-adapter.js'
export { countColorRuns, checkRenderedResult, checkRepairProtection, checkAdaptedResult, checkAudioSync } from './render/checks.js'
export { collectDeterminismEvidence, shuffleDeterministic } from './render/determinism.js'
export { createRepairOperation, repairRegionPlan } from './ops/repair.js'
export { describePreviewState } from './preview.js'
export {
  screenUntrustedPackage,
  screenEntryPath,
  checkNoLinkEscape,
  UNTRUSTED_LIMITS,
} from './safety.js'
export { createAdaptOperation, wrapText, estimateTextWidth } from './ops/adapt.js'
export { createEvidenceRegistry, describeEvidenceTruth, EVIDENCE_ROLES } from './evidence.js'

/** Interface version; a change means C13/C14/C15 must re-check their integration. */
export const MEDIA_RUNTIME_INTERFACE_VERSION = '1.0.0'

/**
 * What this module can honestly claim, and where each claim stops.
 * Data, not prose, so a receipt reads it instead of trusting a comment.
 */
export const MEDIA_RUNTIME_CAPABILITIES = Object.freeze({
  compositionPlan: {
    supported: ['整数帧时间基＋有理数时长', '场景重叠转场派生总时长', '对象/场景/转场身份校验', '版本语义差异'],
    limits: ['非整数帧率按有理数记录，但 VFR 逐帧精度未验证', '一个计划只锁定一个运行时版本'],
  },
  objectMapping: {
    supported: ['对象→计划节点→运行时引用→结构位→画面命中→属性→修改范围', '压平视频只暴露片段/范围/区域', 'Canvas 只按登记区域命中'],
    limits: ['画面命中基于登记几何，不是 DOM/渲染器原生命中', '遮挡对象从结构树精确选择，画面命中返回栈顶'],
  },
  render: {
    supported: ['FFmpeg 滤镜图真实渲染', '预览代理与正式输出同计划', 'probe 声明/实测并列', '编码前后帧对照'],
    limits: ['Remotion/HyperFrames 适配器只声明能力，未注册工具时不可用', '不支持从原帧续渲（D3）', '真实交互播放未实现'],
  },
  sound: {
    supported: ['锁定文案段落→probe 真实时长→字幕窗口', '连续音轨与影片时间对齐', '音轨身份对比'],
    limits: ['只有整段时长，没有词级时间', '不做 ASR，不做听辨'],
  },
  repair: {
    supported: ['目标/保留/范围锁定', '计划差异与范围断言', '编码前区域级原新对照', '音轨字节一致检查'],
    limits: ['允许整单元重渲，不承诺只重算目标像素'],
  },
  adapt: {
    supported: ['对象级重排、字号/安全区/换行、视频 cover/contain 重取景', '时长、源偏移、音轨保护'],
    limits: ['文字换行为字形前进估算，需看图确认', 'cover 会裁掉画面两侧，属于取景决定'],
  },
  evidence: {
    supported: ['源/结果/派生三类身份', 'SHA-256 与 probe 事实', 'AI 观察范围显式记录'],
    limits: ['没有宿主听辨通道；音频体验需用户实际听'],
  },
})

/**
 * Build the runtime for one workbench instance.
 *
 * @param {object} input
 * @param {any} input.toolchain result of {@link resolveToolchain}
 * @param {string} input.workRoot absolute work directory
 * @param {string} input.materialRoot absolute root for the plan's materials
 * @param {any} [input.clock]
 * @returns {any}
 */
export function createMediaRuntime(input) {
  const clock = input.clock ?? new Clock()
  const workRoot = path.resolve(input.workRoot)
  const materialRoot = path.resolve(input.materialRoot)
  const ffmpeg = createFfmpegAdapter({ toolchain: input.toolchain, workRoot, clock, materialRoot })
  // Browser runtimes are managed external workspaces, not C06-adopted tools. They are registered
  // only when the workspace and its binaries actually exist, and they are labelled as such.
  const adapters = { ffmpeg }
  const availability = {
    ffmpeg: { available: true, kind: 'external-tool', version: input.toolchain.ffmpeg.version },
    remotion: { available: false, kind: 'workspace-runtime', reason: '未提供渲染工作区或 headless shell' },
    hyperframes: { available: false, kind: 'workspace-runtime', reason: '未提供渲染工作区或系统 Chrome' },
  }
  if (input.renderWorkspace !== undefined) {
    const workspaceRoot = path.resolve(input.renderWorkspace.root)
    const browser = input.renderWorkspace.browserExecutable
    if (browser !== undefined && fs.existsSync(browser)) {
      adapters.remotion = createRemotionAdapter({
        workspaceRoot,
        workRoot,
        clock,
        materialRoot,
        ffmpegPath: input.toolchain.ffmpeg.path,
        ffprobePath: input.toolchain.ffprobe.path,
        browserExecutable: input.renderWorkspace.browserExecutable,
      })
      availability.remotion = { available: true, kind: 'workspace-runtime', version: '4.0.541' }
    }
    if (input.renderWorkspace.chromePath !== undefined && fs.existsSync(input.renderWorkspace.chromePath)) {
      adapters.hyperframes = createHyperframesAdapter({
        workspaceRoot,
        workRoot,
        clock,
        materialRoot,
        ffmpegPath: input.toolchain.ffmpeg.path,
        ffprobePath: input.toolchain.ffprobe.path,
        chromePath: input.renderWorkspace.chromePath,
      })
      availability.hyperframes = { available: true, kind: 'workspace-runtime', version: '0.9.19' }
    }
  }
  const tasks = createTaskStore({ workRoot, clock })
  const evidence = createEvidenceRegistry({
    rootDir: path.join(workRoot, 'evidence'),
    clock,
    // Synchronous on purpose: an evidence record must contain facts, not a promise that may fail later.
    probe: (file) => probeMedia(input.toolchain.ffprobe.path, file),
  })

  return {
    interfaceVersion: MEDIA_RUNTIME_INTERFACE_VERSION,
    capabilities: MEDIA_RUNTIME_CAPABILITIES,
    clock,
    workRoot,
    materialRoot,
    runtime: { id: 'ffmpeg', version: input.toolchain.ffmpeg.version, source: input.toolchain.ffmpeg.source },
    adapters,
    availability,
    tasks,
    evidence,
    describe() {
      return {
        interfaceVersion: MEDIA_RUNTIME_INTERFACE_VERSION,
        runtime: { id: 'ffmpeg', version: input.toolchain.ffmpeg.version },
        adapter: ffmpeg.describe().adapterId,
        objectKinds: ffmpeg.describe().capabilities.objectKinds,
        transitions: ffmpeg.describe().capabilities.transitions,
        motions: ffmpeg.describe().capabilities.motions,
        limits: MEDIA_RUNTIME_CAPABILITIES,
      }
    },
  }
}
