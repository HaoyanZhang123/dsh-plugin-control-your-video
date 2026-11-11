/**
 * Delivery: one final version, several real output specs, one report per spec.
 *
 * The rules this module enforces in code, not in prose:
 * - a delivery is bound to a FINAL version and the user confirmation it was accepted on; an export
 *   is never created from a current/candidate version, because "导出" must not imply "定稿";
 * - a second aspect is produced by a real `AdaptOperation` and its layout/preserved record is stored
 *   next to the file, so "只改编码尺寸" cannot pass as adaptation;
 * - re-exporting never overwrites: a taken name becomes `…-2.mp4` or the item fails with
 *   `NAME_CONFLICT` — there is no overwrite policy at all;
 * - every file is probed after publication and checked for readability, declared spec, duration,
 *   frame count and audio presence; a failure keeps the file and marks the item failed, because
 *   deleting evidence of a real failure is worse than showing it;
 * - export success is NOT publication: the record says so, and no network call exists in this range.
 *
 * @module delivery/delivery
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  ConflictError,
  NotFoundError,
  ValidationError,
  WorkbenchError,
  ErrorCode,
  sha256,
  writeFileAtomic,
} from '../base/index.js'
import {
  PROJECT_LAYOUT,
  fileSha256,
  isReadableFile,
  tryReadDocument,
  writeDocument,
} from '../core/project/index.js'
import { planOfVersion } from '../editing/index.js'
import {
  createAdaptOperation,
  createMediaRuntime,
  probeMedia,
  runFfmpeg,
  compareDeclaredToProbed,
} from '../media/index.js'
import {
  DELIVERY_DOCUMENT,
  DELIVERY_LAYOUT,
  DELIVERY_LIMITS,
  DeliveryFailure,
  DeliveryState,
  ItemKind,
  ItemState,
  SpecBinding,
  assertDeliveryId,
  assertEnumValue,
  assertOptionalText,
  assertText,
  clip,
  copy,
  newDeliveryId,
} from './ids.js'
import {
  ITEM_EXTENSION,
  buildSubtitleDocument,
  checkFreeSpace,
  defaultFileStem,
  describeSpec,
  resolveOutputPath,
  subtitleCues,
} from './specs.js'

/** Frame duration of one frame in seconds at the plan's rate. */
function secondsOf(frames, timebase) {
  return Number((frames * timebase.fpsDenominator) / timebase.fpsNumerator)
}

/**
 * Read the delivery document, or an empty one.
 * @param {any} paths
 * @param {Clock} clock
 * @returns {{ doc: any, revision: string|null }}
 */
function readDeliveryDocument(paths, clock) {
  const stored = tryReadDocument(paths.resolve(DELIVERY_LAYOUT.index), { kind: DELIVERY_DOCUMENT.kind })
  if (stored === null) {
    return {
      doc: {
        kind: DELIVERY_DOCUMENT.kind,
        projectId: paths.projectId,
        deliveries: [],
      },
      revision: null,
    }
  }
  const value = stored.value
  if (value.kind !== DELIVERY_DOCUMENT.kind) {
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, '交付索引 kind 不符', { details: { kind: String(value.kind) } })
  }
  if (value.projectId !== paths.projectId) {
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, '交付索引属于另一个项目', {
      details: { expected: paths.projectId, found: String(value.projectId) },
    })
  }
  return {
    doc: { ...value, deliveries: Array.isArray(value.deliveries) ? value.deliveries : [] },
    revision: stored.revision,
  }
}

/**
 * A durable store for the delivery records of one project.
 *
 * @param {{ paths: any, clock?: any }} input
 * @returns {any}
 */
export function createDeliveryStore(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('交付记录需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()

  /**
   * Persist the document with the revision this call read.
   * @param {any} doc
   * @param {string|null} revision
   */
  function save(doc, revision) {
    paths.ensureDir(DELIVERY_LAYOUT.dir)
    writeDocument(paths.resolve(DELIVERY_LAYOUT.index), doc, {
      kind: DELIVERY_DOCUMENT.kind,
      schemaKey: DELIVERY_DOCUMENT.schemaKey,
      expectedRevision: revision,
      clock,
    })
  }

  return {
    clock,
    projectId: paths.projectId,
    /** The bound project paths, so a caller holding only the store can still resolve plan snapshots. */
    paths,
    /** Every recorded delivery, oldest first. */
    list() {
      return readDeliveryDocument(paths, clock).doc.deliveries.map((entry) => copy(entry))
    },
    /** @param {string} deliveryId */
    get(deliveryId) {
      const id = assertDeliveryId(deliveryId, 'deliveryId')
      const doc = readDeliveryDocument(paths, clock).doc
      const found = doc.deliveries.find((entry) => entry.deliveryId === id)
      return found === undefined ? null : copy(found)
    },
    /**
     * Insert one delivery record, refusing a duplicate id.
     * @param {any} record
     * @returns {any}
     */
    insert(record) {
      const { doc, revision } = readDeliveryDocument(paths, clock)
      if (doc.deliveries.some((entry) => entry.deliveryId === record.deliveryId)) {
        throw new ConflictError('交付记录已存在', { deliveryId: String(record.deliveryId) })
      }
      if (doc.deliveries.length >= DELIVERY_LIMITS.maxDeliveries) {
        throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '交付记录数量达到上限', {
          details: { limit: DELIVERY_LIMITS.maxDeliveries },
        })
      }
      doc.deliveries.push(record)
      save(doc, revision)
      return copy(record)
    },
    /**
     * Replace one delivery record by id.
     * @param {string} deliveryId
     * @param {(current: any) => any} update
     * @returns {any}
     */
    update(deliveryId, update) {
      const id = assertDeliveryId(deliveryId, 'deliveryId')
      const { doc, revision } = readDeliveryDocument(paths, clock)
      const index = doc.deliveries.findIndex((entry) => entry.deliveryId === id)
      if (index === -1) throw new NotFoundError('交付记录不存在', { deliveryId: id })
      const next = update(copy(doc.deliveries[index]))
      if (next === null || typeof next !== 'object') {
        throw new ValidationError('交付记录更新必须返回对象', { deliveryId: id })
      }
      next.deliveryId = id
      next.updatedAt = clock.iso()
      doc.deliveries[index] = next
      save(doc, revision)
      return copy(next)
    },
    /** Counts a closure step can quote without reading every record again. */
    describe() {
      const deliveries = readDeliveryDocument(paths, clock).doc.deliveries
      return {
        deliveries: deliveries.length,
        complete: deliveries.filter((entry) => entry.state === DeliveryState.COMPLETE).length,
        partial: deliveries.filter((entry) => entry.state === DeliveryState.PARTIAL).length,
        failed: deliveries.filter((entry) => entry.state === DeliveryState.FAILED).length,
        exportedFiles: deliveries.reduce(
          (sum, entry) => sum + (entry.items ?? []).filter((item) => item.state === ItemState.EXPORTED).length,
          0,
        ),
      }
    },
  }
}

/**
 * Build the exporter: it owns the media runtime, the real adapters and the file checks.
 *
 * The runtime is created once per kit so a render does not re-resolve binaries per item; the tool
 * facts it resolved are recorded in every item, because "same machine last time" is not evidence.
 *
 * @param {{ paths: any, clock?: any, toolchain: any, renderWorkspace?: any }} input
 * @returns {any}
 */
export function createDeliveryExporter(input) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('交付导出需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  if (input.toolchain === undefined || input.toolchain === null) {
    throw new ValidationError('交付导出需要已解析的外部工具链（FFmpeg/FFprobe）', { field: 'toolchain' })
  }
  const clock = input.clock ?? new Clock()
  const workRoot = paths.resolve(DELIVERY_LAYOUT.workDir)
  fs.mkdirSync(workRoot, { recursive: true })
  const media = createMediaRuntime({
    toolchain: input.toolchain,
    workRoot,
    // Plan materials are project-relative, so the project directory is the material root.
    materialRoot: paths.dir,
    clock,
  })
  const adapter = media.adapters.ffmpeg
  const ffprobePath = adapter.ffprobePath

  /** Per-delivery output directory: a user-chosen absolute directory or the project's own. */
  function outputDir(record) {
    if (typeof record.outputDir === 'string' && path.isAbsolute(record.outputDir)) return record.outputDir
    return paths.resolve(DELIVERY_LAYOUT.outputsDir)
  }

  /**
   * Estimate bytes a spec will produce, so the space check runs before any encoding.
   * @param {any} plan
   * @returns {number}
   */
  function estimateBytes(plan) {
    const spec = plan.outputSpec
    const seconds = secondsOf(plan.timebase.totalFrames, plan.timebase)
    // 0.09 bytes/pixel/frame at the final tier is deliberately generous; it is an ESTIMATE and is
    // labelled as one in the record. A wrong estimate only makes the pre-check conservative.
    return Math.ceil(spec.width * spec.height * 0.09 * Math.max(1, seconds) + 1024 * 1024)
  }

  /**
   * Probe one published file and compare it against the plan it was rendered from.
   * @param {any} plan
   * @param {any} result
   * @param {{ adaptation?: any }} [options]
   * @returns {{ checks: any[], ok: boolean, failed: string[], probed: any }}
   */
  function verifyVideo(plan, result, options = {}) {
    const checks = []
    const probed = adapter.probeResult(result.file)
    checks.push({
      id: 'file-readable',
      status: isReadableFile(result.file) && fs.statSync(result.file).size > 0 ? 'ok' : 'failed',
      detail: `${String(fs.existsSync(result.file) ? fs.statSync(result.file).size : 0)} 字节`,
    })
    const expectsAudio = plan.objects.some((object) => object.kind === 'audio-continuous')
    // A plan may declare an audio spec while containing no audio object; then the render has no
    // audio stream by choice. Comparing the audio fields would report a failure for a deliberate
    // absence, so they are reported as not-checked and the presence check decides instead.
    const compareSpec = expectsAudio
      ? plan.outputSpec
      : {
          width: plan.outputSpec.width,
          height: plan.outputSpec.height,
          pixelFormat: plan.outputSpec.pixelFormat,
          videoCodec: plan.outputSpec.videoCodec,
          fpsNumerator: plan.outputSpec.fpsNumerator,
          fpsDenominator: plan.outputSpec.fpsDenominator,
        }
    const specComparison = compareDeclaredToProbed(compareSpec, probed)
    checks.push({
      id: 'spec',
      status: specComparison.ok ? 'ok' : 'failed',
      detail: specComparison.differences
        .map((entry) => `${entry.field}: 声明 ${String(entry.declared)} / 实测 ${String(entry.probed)}`)
        .join('；') || `实测 ${String(probed.video?.width)}×${String(probed.video?.height)}`,
    })
    if (plan.outputSpec.audioCodec !== undefined && expectsAudio === false) {
      checks.push({
        id: 'declared-audio-not-used',
        status: 'not-checked',
        detail: '计划声明了音频规格但本次成片没有音轨（计划无音轨对象）；音频字段不参与比对',
      })
    }
    const expectedSeconds = secondsOf(plan.timebase.totalFrames, plan.timebase)
    const actualSeconds = probed.format?.durationSeconds
    checks.push({
      id: 'duration',
      status:
        typeof actualSeconds === 'number' && Math.abs(actualSeconds - expectedSeconds) <= 0.05 ? 'ok' : 'failed',
      detail: `${String(actualSeconds)}s（计划 ${expectedSeconds.toFixed(3)}s，容差 50ms）`,
    })
    checks.push({
      id: 'frame-count',
      status: probed.video?.nbFrames === plan.timebase.totalFrames ? 'ok' : 'failed',
      detail: `${String(probed.video?.nbFrames)} 帧（计划 ${plan.timebase.totalFrames} 帧）`,
    })
    const hasAudio = probed.audio !== null && probed.audio !== undefined
    checks.push({
      id: 'audio-presence',
      status: hasAudio === expectsAudio ? 'ok' : 'failed',
      detail: hasAudio ? `存在音频流（${String(probed.audio?.codec)}）` : '没有音频流',
    })
    if (options.adaptation !== undefined && options.adaptation !== null) {
      const layout = options.adaptation.layout
      checks.push({
        id: 'object-level-relayout',
        status:
          layout.adaptation.uniform === false && layout.moves.length > 0 && options.adaptation.preserved.ok === true
            ? 'ok'
            : 'failed',
        detail: `对象移动 ${layout.moves.length} 个、字号调整 ${layout.resizes.length} 个、字幕重排 ${layout.rewraps.length} 个；` +
          `时长${options.adaptation.preserved.durationFrames.identical ? '保持' : '变化'}、` +
          `音轨${options.adaptation.preserved.audio.identical ? '逐字节一致' : '有变化'}`,
      })
      // 第二画幅的"不是拉伸"由计划层的独立轴缩放证明；像素级重取景证明需要 C12 的色条夹具，
      // 本卡不声称已经做到，记录在这里而不是省略。
      checks.push({
        id: 'pixel-reframe',
        status: 'not-checked',
        detail: '没有做像素级重取景对照（需要 C12 色条夹具）；本项只证明对象级重排与规格、时长实测',
      })
    }
    return {
      checks,
      ok: checks.every((check) => check.status === 'ok' || check.status === 'not-checked'),
      failed: checks.filter((check) => check.status === 'failed').map((check) => check.id),
      probed,
      specComparison,
    }
  }

  return {
    clock,
    media,
    adapter,
    /**
     * Render one video spec from the final version's plan.
     * @param {{ finalVersion: any, spec: any, outputDir: string, policy: string }} request
     * @returns {any} item record (never throws for a render failure; the failure is data)
     */
    renderVideoSpec(request) {
      const spec = request.spec
      const record = {
        itemId: `itm_${spec.specId}`,
        specId: spec.specId,
        kind: ItemKind.VIDEO,
        label: spec.label,
        state: ItemState.PLANNED,
        file: null,
        spec: null,
        checks: [],
        checksOk: null,
        failure: null,
        adaptation: null,
        adaptationRef: null,
        notes: [],
      }
      const bound = planOfVersion(paths, request.finalVersion)
      if (bound === null) {
        record.state = ItemState.FAILED
        record.failure = {
          code: DeliveryFailure.NO_FINAL_PLAN,
          message: '定稿版本没有关联的 CompositionPlan，无法导出成片',
        }
        return record
      }
      let plan = bound.plan
      let adaptation = null
      if (spec.binding === SpecBinding.ADAPT_OPERATION) {
        try {
          const adapted = createAdaptOperation({
            basePlan: plan,
            target: spec.target,
            options: { preserveAudio: true, videoFit: 'cover' },
            clock,
          })
          plan = adapted.plan
          adaptation = { plan: adapted.plan, layout: adapted.layout, preserved: adapted.preserved }
        } catch (error) {
          record.state = ItemState.FAILED
          record.failure = {
            code: DeliveryFailure.ADAPT_FAILED,
            message: `AdaptOperation 失败：${String(error?.message ?? error)}`,
            detail: { specId: spec.specId, target: spec.target },
          }
          return record
        }
        record.adaptation = {
          from: adaptation.plan.adaptation.from,
          to: adaptation.plan.adaptation.to,
          method: adaptation.plan.adaptation.method,
          uniform: adaptation.plan.adaptation.uniform,
          notAStretch: adaptation.plan.adaptation.notAStretch,
          layout: {
            moves: adaptation.layout.moves.length,
            resizes: adaptation.layout.resizes.length,
            rewraps: adaptation.layout.rewraps.length,
            mediaFits: adaptation.layout.mediaFits.length,
          },
          preserved: adaptation.preserved,
        }
      }
      record.spec = {
        width: plan.outputSpec.width,
        height: plan.outputSpec.height,
        aspectRatio: plan.outputSpec.aspectRatio ?? `${plan.outputSpec.width}:${plan.outputSpec.height}`,
        fps: `${plan.timebase.fpsNumerator}/${plan.timebase.fpsDenominator}`,
        pixelFormat: plan.outputSpec.pixelFormat,
        videoCodec: plan.outputSpec.videoCodec,
        audioCodec: plan.outputSpec.audioCodec ?? null,
        container: plan.outputSpec.container ?? 'mp4',
        planVersion: plan.planVersion,
        planRef: bound.planRef,
        binding: spec.binding,
      }
      const dir = request.outputDir
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (error) {
        record.state = ItemState.FAILED
        record.failure = { code: DeliveryFailure.UNSAFE_PATH, message: `输出目录不可用：${String(error?.code ?? error)}` }
        return record
      }
      const name = resolveOutputPath({
        dir,
        stem: defaultFileStem({ deliveryId: request.deliveryId, specId: spec.specId }),
        extension: ITEM_EXTENSION.video,
        policy: request.policy,
      })
      if (name.ok === false) {
        record.state = ItemState.FAILED
        record.failure = {
          code: DeliveryFailure.NAME_CONFLICT,
          message: '同名文件已存在，按“不覆盖”策略停止这一项',
          detail: { existing: name.existing, policy: request.policy },
        }
        return record
      }
      const estimate = estimateBytes(plan)
      const space = checkFreeSpace(dir, estimate)
      if (space.ok === false) {
        record.state = ItemState.FAILED
        record.failure = {
          code: DeliveryFailure.DISK_SPACE,
          message: '可用空间不足，未开始编码',
          detail: { freeBytes: space.freeBytes, neededBytes: estimate },
        }
        return record
      }
      record.notes.push(`空间检查：${space.checked ? `${String(space.freeBytes)} 字节可用 / 估计 ${String(estimate)} 字节` : space.reason}`)
      try {
        const result = adapter.renderFinal(plan, plan.outputSpec, { outputPath: name.file })
        record.file = {
          path: name.file,
          relative: path.isAbsolute(name.file) && name.file.startsWith(paths.dir)
            ? path.relative(paths.dir, name.file).split(path.sep).join('/')
            : null,
          bytes: result.bytes,
          sha256: result.sha256,
          renamed: name.renamed,
        }
        if (name.renamed) record.notes.push('同名文件已存在：本次另存为新名字，旧文件保持不动')
        const verified = verifyVideo(plan, result, adaptation === null ? {} : { adaptation })
        record.checks = verified.checks
        record.checksOk = verified.ok
        record.spec.probed = {
          width: verified.probed.video?.width ?? null,
          height: verified.probed.video?.height ?? null,
          pixelFormat: verified.probed.video?.pixelFormat ?? null,
          fps: verified.probed.video?.avgRate ?? null,
          nbFrames: verified.probed.video?.nbFrames ?? null,
          durationSeconds: verified.probed.format?.durationSeconds ?? null,
          audioCodec: verified.probed.audio?.codec ?? null,
        }
        record.state = verified.ok ? ItemState.EXPORTED : ItemState.FAILED
        if (!verified.ok) {
          record.failure = {
            code: DeliveryFailure.CHECK_FAILED,
            message: `导出后检查未通过：${verified.failed.join('、')}`,
            detail: { preservedFile: name.file, note: '文件已生成但检查未通过，不计入交付' },
          }
        }
        if (adaptation !== null) {
          const relative = `${DELIVERY_LAYOUT.dir}/adaptations/${request.deliveryId}-${spec.specId}-${plan.planVersion}.json`
          const absolute = paths.resolve(relative)
          fs.mkdirSync(path.dirname(absolute), { recursive: true })
          writeFileAtomic(absolute, `${JSON.stringify({
            kind: 'delivery-adaptation',
            projectId: paths.projectId,
            deliveryId: request.deliveryId,
            specId: spec.specId,
            operation: 'AdaptOperation',
            basePlanRef: bound.planRef,
            basePlanVersion: bound.planVersion,
            adaptedPlanVersion: plan.planVersion,
            adaptation: plan.adaptation,
            preserved: adaptation.preserved,
            recordedAt: clock.iso(),
          }, null, 2)}\n`)
          record.adaptationRef = relative
        }
        return record
      } catch (error) {
        record.state = ItemState.FAILED
        record.failure = {
          code: DeliveryFailure.RENDER_FAILED,
          message: `渲染失败：${String(error?.message ?? error)}`,
          detail: { tool: { ffmpeg: input.toolchain.ffmpeg.version }, output: name.file },
        }
        return record
      }
    },
    /**
     * Extract one PNG cover from an already exported video item.
     * @param {{ sourceFile: string, frame: number, outputDir: string, deliveryId: string,
     *   spec: any, policy: string }} request
     * @returns {any}
     */
    exportCover(request) {
      const record = {
        itemId: `itm_${request.spec.specId}`,
        specId: request.spec.specId,
        kind: ItemKind.COVER,
        label: request.spec.label,
        state: ItemState.PLANNED,
        file: null,
        spec: null,
        checks: [],
        checksOk: null,
        failure: null,
        adaptation: null,
        adaptationRef: null,
        notes: [],
      }
      if (!isReadableFile(request.sourceFile)) {
        record.state = ItemState.FAILED
        record.failure = { code: DeliveryFailure.CHECK_FAILED, message: '封面来源成片不存在或不可读' }
        return record
      }
      const dir = request.outputDir
      fs.mkdirSync(dir, { recursive: true })
      const name = resolveOutputPath({
        dir,
        stem: defaultFileStem({ deliveryId: request.deliveryId, specId: request.spec.specId }),
        extension: ITEM_EXTENSION.cover,
        policy: request.policy,
      })
      if (name.ok === false) {
        record.state = ItemState.FAILED
        record.failure = { code: DeliveryFailure.NAME_CONFLICT, message: '同名封面已存在，按“不覆盖”策略停止', detail: { existing: name.existing } }
        return record
      }
      try {
        const sourceProbed = adapter.probeResult(request.sourceFile)
        const seconds = secondsOf(request.frame, {
          fpsNumerator: Number(sourceProbed.video?.avgRate?.numerator ?? 30),
          fpsDenominator: Number(sourceProbed.video?.avgRate?.denominator ?? 1),
        })
        const run = runFfmpeg({
          ffmpegPath: adapter.ffmpegPath,
          args: ['-v', 'error', '-y', '-ss', String(seconds), '-i', request.sourceFile, '-frames:v', '1', '-f', 'image2', name.file],
          cwd: dir,
          timeoutMs: 120000,
        })
        if (!fs.existsSync(name.file)) {
          record.state = ItemState.FAILED
          record.failure = {
            code: DeliveryFailure.RENDER_FAILED,
            message: 'FFmpeg 报告成功但没有生成封面文件',
            detail: { stderr: run.stderr.slice(-400) },
          }
          return record
        }
        const probed = probeMedia(ffprobePath, name.file)
        record.file = {
          path: name.file,
          bytes: fs.statSync(name.file).size,
          sha256: fileSha256(name.file),
          renamed: name.renamed,
        }
        record.spec = {
          width: probed.video?.width ?? null,
          height: probed.video?.height ?? null,
          sourceWidth: sourceProbed.video?.width ?? null,
          sourceHeight: sourceProbed.video?.height ?? null,
          frame: request.frame,
        }
        record.checks = [
          {
            id: 'file-readable',
            status: isReadableFile(name.file) ? 'ok' : 'failed',
            detail: `${String(record.file.bytes)} 字节`,
          },
          {
            id: 'spec',
            status:
              probed.video?.width === sourceProbed.video?.width && probed.video?.height === sourceProbed.video?.height
                ? 'ok'
                : 'failed',
            detail: `${String(probed.video?.width)}×${String(probed.video?.height)}（来源 ${String(sourceProbed.video?.width)}×${String(sourceProbed.video?.height)}）`,
          },
        ]
        record.checksOk = record.checks.every((check) => check.status === 'ok')
        record.state = record.checksOk ? ItemState.EXPORTED : ItemState.FAILED
        if (!record.checksOk) {
          record.failure = { code: DeliveryFailure.CHECK_FAILED, message: '封面尺寸与来源成片不一致' }
        }
        return record
      } catch (error) {
        record.state = ItemState.FAILED
        record.failure = { code: DeliveryFailure.RENDER_FAILED, message: `封面抽取失败：${String(error?.message ?? error)}` }
        return record
      }
    },
    /**
     * Write the plan's subtitles as an SRT beside the exports.
     * @param {{ plan: any, outputDir: string, deliveryId: string, spec: any, policy: string }} request
     * @returns {any}
     */
    exportSubtitles(request) {
      const record = {
        itemId: `itm_${request.spec.specId}`,
        specId: request.spec.specId,
        kind: ItemKind.SUBTITLES,
        label: request.spec.label,
        state: ItemState.PLANNED,
        file: null,
        spec: null,
        checks: [],
        checksOk: null,
        failure: null,
        adaptation: null,
        adaptationRef: null,
        notes: [],
      }
      const document = buildSubtitleDocument(request.plan)
      if (document.cues === 0) {
        record.state = ItemState.NOT_IMPLEMENTED
        record.failure = {
          code: DeliveryFailure.SPEC_INVALID,
          message: '定稿计划里没有字幕对象，本条不适用（不是失败）',
        }
        return record
      }
      const dir = request.outputDir
      fs.mkdirSync(dir, { recursive: true })
      const name = resolveOutputPath({
        dir,
        stem: defaultFileStem({ deliveryId: request.deliveryId, specId: request.spec.specId }),
        extension: ITEM_EXTENSION.subtitles,
        policy: request.policy,
      })
      if (name.ok === false) {
        record.state = ItemState.FAILED
        record.failure = { code: DeliveryFailure.NAME_CONFLICT, message: '同名字幕已存在，按“不覆盖”策略停止', detail: { existing: name.existing } }
        return record
      }
      try {
        writeFileAtomic(name.file, document.content)
        const text = fs.readFileSync(name.file, 'utf8')
        const blocks = text.trim().length === 0 ? [] : text.trim().split(/\n\n+/)
        const timestampPattern = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/
        record.file = {
          path: name.file,
          bytes: fs.statSync(name.file).size,
          sha256: fileSha256(name.file),
          renamed: name.renamed,
        }
        record.spec = {
          cues: document.cues,
          firstStartFrame: document.firstStartFrame,
          lastEndFrame: document.lastEndFrame,
          fileCues: blocks.length,
        }
        record.checks = [
          { id: 'file-readable', status: isReadableFile(name.file) ? 'ok' : 'failed', detail: `${String(record.file.bytes)} 字节` },
          {
            id: 'cue-count',
            status: blocks.length === document.cues ? 'ok' : 'failed',
            detail: `${blocks.length} 段（计划 ${document.cues} 个字幕对象）`,
          },
          {
            id: 'timestamp-format',
            status:
              blocks.every((block) => {
                const lines = block.split('\n')
                return lines.length >= 3 && timestampPattern.test(lines[1])
              })
                ? 'ok'
                : 'failed',
            detail: '每个字幕块都有序号、SRT 时间码与文字',
          },
          {
            id: 'text-matches-plan',
            status: blocks.every((block, index) => {
              const cue = subtitleCues(request.plan)[index]
              return cue !== undefined && block.split('\n').slice(2).join('\n').trim() === cue.text.trim()
            })
              ? 'ok'
              : 'failed',
            detail: '字幕文字与计划中的字幕对象逐条一致（未做 ASR、未改写）',
          },
        ]
        record.checksOk = record.checks.every((check) => check.status === 'ok')
        record.state = record.checksOk ? ItemState.EXPORTED : ItemState.FAILED
        if (!record.checksOk) record.failure = { code: DeliveryFailure.CHECK_FAILED, message: '字幕检查未通过' }
        return record
      } catch (error) {
        record.state = ItemState.FAILED
        record.failure = { code: DeliveryFailure.RENDER_FAILED, message: `字幕写入失败：${String(error?.message ?? error)}` }
        return record
      }
    },
    /**
     * Re-probe a previously delivered file, so closure step 2 rests on a real read today.
     * @param {any} item
     * @returns {{ ok: boolean, checks: any[], reason: string|null }}
     */
    verifyDeliveredItem(item) {
      if (item?.file === null || typeof item.file?.path !== 'string') {
        return { ok: false, checks: [], reason: '交付记录没有文件路径' }
      }
      if (!isReadableFile(item.file.path)) {
        return { ok: false, checks: [], reason: '交付文件已不存在或不可读' }
      }
      if (item.kind === ItemKind.SUBTITLES) {
        return { ok: true, checks: [{ id: 'file-readable', status: 'ok', detail: '字幕文件可读' }], reason: null }
      }
      if (item.kind === ItemKind.COVER) {
        const probed = probeMedia(ffprobePath, item.file.path)
        const ok = probed.video?.width === item.spec?.width && probed.video?.height === item.spec?.height
        return {
          ok,
          checks: [{ id: 'spec', status: ok ? 'ok' : 'failed', detail: `${String(probed.video?.width)}×${String(probed.video?.height)}` }],
          reason: ok ? null : '封面尺寸与交付记录不一致',
        }
      }
      const probed = probeMedia(ffprobePath, item.file.path)
      const recordedSeconds = item.spec?.probed?.durationSeconds
      const durationOk =
        typeof probed.format?.durationSeconds === 'number' &&
        (typeof recordedSeconds !== 'number' || Math.abs(probed.format.durationSeconds - recordedSeconds) <= 0.05)
      const specOk = probed.video?.width === item.spec?.width && probed.video?.height === item.spec?.height
      const ok = specOk && durationOk
      return {
        ok,
        checks: [
          { id: 'file-readable', status: 'ok', detail: `${String(item.file.bytes)} 字节` },
          {
            id: 'spec',
            status: specOk ? 'ok' : 'failed',
            detail: `${String(probed.video?.width)}×${String(probed.video?.height)}（记录 ${String(item.spec?.width)}×${String(item.spec?.height)}）`,
          },
          {
            id: 'duration',
            status: durationOk ? 'ok' : 'failed',
            detail: `${String(probed.format?.durationSeconds)}s（记录 ${String(recordedSeconds)}s，容差 50ms）`,
          },
        ],
        reason: ok ? null : '文件实测与交付记录不一致',
      }
    },
    /** Tool facts that must appear in the record instead of being assumed. */
    describeTooling() {
      return {
        ffmpeg: {
          version: input.toolchain.ffmpeg.version,
          build: input.toolchain.ffmpeg.build,
          source: input.toolchain.ffmpeg.source,
        },
        ffprobe: { version: input.toolchain.ffprobe.version, source: input.toolchain.ffprobe.source },
        adapter: adapter.describe().adapterId,
        workRoot: workRoot,
      }
    },
  }
}
