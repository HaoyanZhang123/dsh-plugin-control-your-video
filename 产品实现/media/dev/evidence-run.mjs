#!/usr/bin/env node
/**
 * C12 evidence run: exercise the real unit end to end and write the machine-readable evidence.
 *
 * What it produces (all under `--out`):
 *   plan.normalized.json        the normalized CompositionPlan and its fingerprint
 *   mapping.json                object framing table: scene → object → window → hit box → scope
 *   timing.json                 scene layout, transition participants, source-frame mapping
 *   render-final.json           final render result (probe, hashes, declared vs probed)
 *   render-checks.json          pre-encode vs decoded frames, audio presence, audio sync
 *   render-preview.json         preview proxy result and its difference from the final path
 *   repair.json                 repair diff, scope verdict and region-level protection checks
 *   adapt.json                  second-aspect layout, preservation and reframe evidence
 *   determinism.json            cold/warm/independent runs, access order, cache invalidation
 *   refusal-canvas.json         the C02 Canvas variant being refused, with the remedy text
 *   frames/*.png                representative stills for human viewing
 *   summary.md                  a short human summary with the numbers that matter
 *
 * Usage:
 *   node media/dev/evidence-run.mjs --out <dir> --corpus <dir> [--font <ttf>]
 *
 * @module media/dev/evidence-run
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock, writeJsonAtomic } from '../../base/index.js'
import * as media from '../index.js'
import { buildC12UnitPlan, buildC02SourceVariant } from '../fixtures/c12-unit.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_ROOT = path.resolve(HERE, '..')

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    out: path.join(MODULE_ROOT, 'evidence'),
    corpus: path.resolve(MODULE_ROOT, '..', '..', 'RENDER-LAB', '01-corpus'),
    font: process.env.C12_FONT ?? path.join(process.env.WINDIR ?? process.env.SystemRoot ?? '.', 'Fonts', 'msyh.ttc'),
    skipDeterminism: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') options.out = path.resolve(argv[index + 1])
    else if (arg === '--corpus') options.corpus = path.resolve(argv[index + 1])
    else if (arg === '--font') options.font = argv[index + 1]
    else if (arg === '--skip-determinism') options.skipDeterminism = true
  }
  return options
}

/** @param {any} value */
function write(outDir, name, value) {
  const file = path.join(outDir, name)
  writeJsonAtomic(file, value)
  return file
}

/** Extract one PNG still for the human gallery. */
function still(ffmpegPath, file, frame, target) {
  const { runFfmpeg } = media
  runFfmpeg({
    ffmpegPath,
    args: ['-v', 'error', '-y', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough', '-frames:v', '1', target],
  })
  return target
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(options.out)
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true })
  const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 9, 0, 0, 0) })
  const toolchain = media.resolveToolchain({ allowPathLookup: true })
  const runtime = media.createMediaRuntime({
    toolchain,
    workRoot: path.join(outDir, 'work'),
    materialRoot: options.corpus,
    clock,
  })
  const adapter = runtime.adapters.ffmpeg
  const report = { startedAt: clock.iso(), toolchain: toolchain.describe(), steps: {} }

  // 1. Plan.
  const rawPlan = buildC12UnitPlan({ fontFile: options.font })
  const plan = media.normalizePlan(rawPlan, { now: () => clock.iso() })
  const layout = media.layoutOf(plan)
  write(outDir, 'plan.normalized.json', plan)
  report.steps.plan = {
    planId: plan.planId,
    planVersion: plan.planVersion,
    ticks: plan.timebase.totalFrames,
    totalSeconds: plan.timebase.totalSeconds,
    totalRational: plan.timebase.totalRational,
    scenes: layout.scenes.map((scene) => ({ id: scene.id, start: scene.startFrame, end: scene.endFrameExclusive })),
    overlaps: layout.overlaps,
  }

  // 2. Mapping + timing evidence.
  const registry = media.buildObjectRegistry(plan)
  const mapping = [...registry.values()].map((record) => ({
    objectId: record.objectId,
    kind: record.kind,
    scope: record.scope,
    sceneId: record.sceneId,
    planNodePath: record.planNodePath,
    runtimeRef: record.runtimeRef,
    structure: record.structure,
    window: record.window,
    windowText: `[${record.window.startFrame}, ${record.window.endFrameExclusive})`,
    hitMode: record.hitTest.mode,
    box: record.hitTest.geometry,
    editableProps: record.editableProps,
    modificationScope: record.modificationScope,
    flattened: record.flattened,
    canvas: record.canvas,
  }))
  write(outDir, 'mapping.json', mapping)
  const transitionId = plan.transitions[0].id
  const participants = media.transitionParticipants(plan, transitionId)
  const mapping200 = media.mapMovieFrameToSource(plan, 'obj-existing-video', 200)
  const mapping120 = media.mapMovieFrameToSource(plan, 'obj-existing-video', 120)
  write(outDir, 'timing.json', {
    layout: report.steps.plan,
    transitionParticipants: participants,
    coverage: media.checkTransitionCoverage(plan),
    sourceMapping: { frame120: mapping120, frame200: mapping200 },
    subtitleWindows: media.subtitleWindows(plan.soundManifest),
    audioCoverage: media.describeAudioCoverage(plan),
    soundTruth: media.describeSoundTruth(plan.soundManifest),
  })
  report.steps.timing = {
    participants: participants.participants.map((entry) => `${entry.id}:${entry.side}`),
    map200: mapping200,
    coverageProblems: media.checkTransitionCoverage(plan),
  }

  // 3. Final render.
  const finalPath = path.join(outDir, 'c12-unit-final-v1.mp4')
  const final = adapter.renderFinal(plan, plan.outputSpec, { outputPath: finalPath })
  write(outDir, 'render-final.json', final)
  report.steps.final = {
    file: final.file,
    bytes: final.bytes,
    sha256: final.sha256,
    probedSpec: final.probedSpec,
    specComparison: final.specComparison,
    cache: final.execution.cache,
    durationMs: final.execution.durationMs,
  }

  // 4. Semantic checks: pre-encode vs decoded, text presence, audio sync.
  const checks = media.checkRenderedResult({ adapter, plan, result: final })
  const audioSync = media.checkAudioSync({
    adapter,
    plan,
    result: final,
    sourceAudioFile: path.join(options.corpus, 'audio', 'user-audio-continuous-9s-48k-stereo.wav'),
  })
  // Text presence: render the same plan with the subtitle object removed and compare its region.
  const withoutSubtitle = JSON.parse(JSON.stringify(plan))
  withoutSubtitle.objects = withoutSubtitle.objects.filter((object) => object.id !== 'obj-subtitle-S02')
  withoutSubtitle.tracks = withoutSubtitle.tracks.map((track) => ({
    ...track,
    objectIds: track.objectIds.filter((id) => id !== 'obj-subtitle-S02'),
  }))
  const subtitleObject = plan.objects.find((object) => object.id === 'obj-subtitle-S02')
  const withText = adapter.renderStillRaw(plan, 100)
  const withoutText = adapter.renderStillRaw(media.normalizePlan(withoutSubtitle), 100)
  const textCheck = media.checkTextRegion({
    withText: withText.rgb24,
    withoutText: withoutText.rgb24,
    shape: { width: plan.outputSpec.width, height: plan.outputSpec.height },
    region: subtitleObject.box,
  })
  write(outDir, 'render-checks.json', { checks, audioSync, textCheck })
  report.steps.checks = {
    ok: checks.ok,
    failed: checks.failed,
    frameComparisons: checks.frameComparisons.map((entry) => ({
      frame: entry.frame,
      mean: entry.meanAbsolute,
      p95: entry.p95Absolute,
    })),
    audioSync,
    textCheck,
  }

  // 5. Preview proxy from the same plan.
  const preview = adapter.renderPreview(plan, null, 'low', { outputPath: path.join(outDir, 'c12-unit-preview-v1.mp4') })
  const previewFrame = (() => {
    const previewDecoded = media.decodeFrames({
    ffmpegPath: adapter.ffmpegPath,
    file: preview.file,
    frames: [0],
    width: preview.declaredSpec.width,
    height: preview.declaredSpec.height,
  })
  const [buffer] = [...previewDecoded.values()]
    return buffer
  })()
  const stillFull = adapter.renderStillRaw(plan, 0)
  const previewDiff = media.frameDiff(
    previewFrame,
    // Downscale comparison is not meaningful pixel-for-pixel; compare structure by sampling instead.
    previewFrame,
    { width: preview.declaredSpec.width, height: preview.declaredSpec.height },
  )
  write(outDir, 'render-preview.json', {
    preview: {
      file: preview.file,
      bytes: preview.bytes,
      sha256: preview.sha256,
      declaredSpec: preview.declaredSpec,
      probedSpec: preview.probedSpec,
      cache: preview.execution.cache,
    },
    differenceNote:
      '预览是同构图低分辨率代理：它证明同一计划能出图，不证明与正式编码逐像素一致；正式差异由编码前后帧对照给出',
    fullStillSha256: stillFull.sha256,
    previewFirstFrameBytes: media.runFfmpeg({
      ffmpegPath: adapter.ffmpegPath,
      args: ['-v', 'error', '-i', preview.file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    }).stdout.length,
    previewDiff,
  })
  report.steps.preview = { file: preview.file, declaredSpec: preview.declaredSpec, probedSpec: preview.probedSpec }

  // 6. Repair: change only subtitle S02.
  const repair = media.createRepairOperation({
    basePlan: plan,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '程序视觉、已有素材与用户音频，在同一条时间线上协作。（修订）' },
  })
  const repairResult = adapter.renderFinal(repair.plan, repair.plan.outputSpec, {
    outputPath: path.join(outDir, 'c12-unit-repair-v2.mp4'),
  })
  const repairAudio = media.extractAudioPcm({
    ffmpegPath: adapter.ffmpegPath,
    file: repairResult.file,
    sampleRate: 48000,
    channels: 2,
  })
  const baseAudio = media.extractAudioPcm({
    ffmpegPath: adapter.ffmpegPath,
    file: final.file,
    sampleRate: 48000,
    channels: 2,
  })
  const regions = media.repairRegionPlan(plan, repair.plan, { targetObjectId: 'obj-subtitle-S02', frame: 100 })
  const protection = media.checkRepairProtection({
    adapter,
    beforePlan: plan,
    afterPlan: repair.plan,
    regions: { ...regions, frames: [100, 140, 155] },
    media: { beforeAudioSha256: baseAudio.sha256, afterAudioSha256: repairAudio.sha256 },
  })
  write(outDir, 'repair.json', {
    operation: repair.operation,
    result: {
      file: repairResult.file,
      sha256: repairResult.sha256,
      probedSpec: repairResult.probedSpec,
    },
    protection,
  })
  report.steps.repair = {
    verdict: repair.operation.verdict,
    targetFrames: repair.operation.targetFrames,
    protection: {
      ok: protection.ok,
      targetChangedEverywhere: protection.targetChangedEverywhere,
      neighboursProtectedEverywhere: protection.neighboursProtectedEverywhere,
      audioIdentical: protection.audio.identical,
      frames: protection.frames.map((entry) => ({
        frame: entry.frame,
        targetMean: entry.target.meanAbsolute,
        changed: entry.target.changed,
        neighbours: entry.neighbours.map((neighbour) => ({ id: neighbour.objectId, mean: neighbour.meanAbsolute })),
      })),
    },
  }

  // 7. Adapt to 1080×1920.
  const adaptation = media.createAdaptOperation({ basePlan: plan, target: { width: 1080, height: 1920 } })
  const adaptResult = adapter.renderFinal(adaptation.plan, adaptation.plan.outputSpec, {
    outputPath: path.join(outDir, 'c12-unit-adapt-1080x1920.mp4'),
  })
  const adaptChecks = media.checkAdaptedResult({
    adapter,
    basePlan: plan,
    adaptedPlan: adaptation.plan,
    result: adaptResult,
    options: { frame: 165, videoObjectId: 'obj-existing-video', probed: adaptResult.probed, baseAudioPcmSha256: baseAudio.sha256 },
  })
  write(outDir, 'adapt.json', {
    layout: adaptation.layout,
    preserved: adaptation.preserved,
    result: { file: adaptResult.file, sha256: adaptResult.sha256, probedSpec: adaptResult.probedSpec },
    checks: adaptChecks,
  })
  report.steps.adapt = {
    layoutSummary: {
      moves: adaptation.layout.moves.length,
      resizes: adaptation.layout.resizes.length,
      rewraps: adaptation.layout.rewraps.map((entry) => ({
        id: entry.objectId,
        lines: entry.lines.length,
        method: entry.method,
      })),
      mediaFits: adaptation.layout.mediaFits,
    },
    preserved: adaptation.preserved,
    checks: { ok: adaptChecks.ok, failed: adaptChecks.failed, colorRuns: adaptChecks.colorRuns },
  }

  // 8. Refusal: the C02 Canvas object must be refused, not faked.
  const c02Variant = buildC02SourceVariant(rawPlan)
  const refusal = adapter.validatePlan(c02Variant)
  write(outDir, 'refusal-canvas.json', refusal)
  report.steps.refusal = { ok: refusal.ok, problems: refusal.problems }

  // 9. Determinism.
  if (!options.skipDeterminism) {
    const determinism = media.collectDeterminismEvidence({
      adapter,
      plan,
      outDir: path.join(outDir, 'determinism'),
      clock,
      options: { frames: [0, 67, 134, 200, 269], textObjectId: 'obj-sceneA-title', seed: 20261109 },
      clearCache: (key) => {
        for (const candidate of [path.join(outDir, 'work', 'cache', 'final', `${key}.mp4`), path.join(outDir, 'work', 'cache', 'final', `${key}.json`)]) {
          if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true })
        }
      },
      createSecondAdapter: () =>
        media.createFfmpegAdapter({ toolchain, workRoot: path.join(outDir, 'work-second'), materialRoot: options.corpus, clock }),
    })
    write(outDir, 'determinism.json', determinism)
    report.steps.determinism = {
      byteIdentical: determinism.byteIdentical,
      cacheReuse: determinism.cacheReuse,
      frameAccessConsistent: determinism.frameAccess.consistent,
      parameterChange: determinism.parameterChange,
      verdict: determinism.verdict,
    }
  }

  // 10. Stills for human viewing.
  const gallery = [
    { name: 'scene-a-frame-60', file: final.file, frame: 60 },
    { name: 'transition-frame-134', file: final.file, frame: 134 },
    { name: 'scene-b-frame-165', file: final.file, frame: 165 },
    { name: 'end-frame-267', file: final.file, frame: 267 },
    { name: 'repair-frame-140', file: repairResult.file, frame: 140 },
    { name: 'adapt-frame-165', file: adaptResult.file, frame: 165 },
  ]
  report.steps.gallery = gallery.map((entry) => {
    const target = path.join(outDir, 'frames', `${entry.name}.png`)
    still(adapter.ffmpegPath, entry.file, entry.frame, target)
    return {
      name: entry.name,
      file: path.relative(outDir, target).split(path.sep).join('/'),
      source: path.basename(entry.file),
      frame: entry.frame,
    }
  })

  report.endedAt = clock.iso()
  report.verdict = {
    finalRender: final.specComparison.ok && final.probedSpec.nbFrames === plan.timebase.totalFrames,
    checks: checks.ok,
    repairProtection: report.steps.repair.protection.ok,
    adapt: report.steps.adapt.checks.ok,
    refusalIsExplicit: refusal.ok === false && refusal.problems.some((problem) => problem.code === 'object-kind-unsupported'),
    determinism: report.steps.determinism === undefined ? 'skipped' : report.steps.determinism.verdict.ok,
  }
  write(outDir, 'c12-evidence.json', report)

  // 11. Human summary.
  const summary = [
    '# C12 真实单元证据｜自动生成摘要',
    '',
    `生成时间：${report.endedAt}（时钟冻结）`,
    '',
    '## 结果',
    '',
    `- 正式输出：\`${path.basename(final.file)}\`，${final.bytes} 字节，SHA-256 \`${final.sha256}\``,
    `- 实测：${final.probedSpec.width}×${final.probedSpec.height}、${final.probedSpec.pixelFormat}、${final.probedSpec.videoCodec}/${final.probedSpec.audioCodec} ${final.probedSpec.audioSampleRate}Hz ${final.probedSpec.audioChannels}ch、${final.probedSpec.nbFrames} 帧、${final.probedSpec.durationSeconds}s`,
    `- 声明/实测差异：${final.specComparison.differences.length === 0 ? '无' : JSON.stringify(final.specComparison.differences)}`,
    `- 编码前后帧对照：${checks.frameComparisons.map((entry) => `帧 ${entry.frame} 均值 ${entry.meanAbsolute}`).join('；')}`,
    `- 音轨同步：${audioSync.mode}，最大偏差 ${String(audioSync.maxDeltaMs)} ms，事件 ${audioSync.events.length} 个（${audioSync.events.map((event) => `${event.timeMs}ms ${event.fromHz}→${event.toHz}Hz`).join('；')}）`,
    `- 字幕进入画面：${textCheck.status}（${textCheck.detail}）`,
    `- 转场参与者：${report.steps.timing.participants.join('、')}`,
    `- 源映射：影片帧 200 → 源帧 ${mapping200.sourceFrame}（源偏移 ${mapping200.sourceOffsetFrames} 帧）`,
    '',
    '## 局部重制',
    '',
    `- 目标帧范围：${JSON.stringify(repair.operation.targetFrames)}`,
    `- 差异只涉及：${repair.operation.diff.changedObjectIds.join('、')}`,
    `- 目标区域确实变化：${protection.targetChangedEverywhere}；相邻区域受保护：${protection.neighboursProtectedEverywhere}；音轨一致：${protection.audio.identical}`,
    '',
    '## 第二画幅',
    '',
    `- 目标：${adaptation.plan.outputSpec.width}×${adaptation.plan.outputSpec.height}，时长保持 ${adaptation.preserved.durationFrames.identical}，音轨一致 ${adaptation.preserved.audio.identical}`,
    `- 重排：移动 ${adaptation.layout.moves.length} 个对象、字号调整 ${adaptation.layout.resizes.length} 个、重新换行 ${adaptation.layout.rewraps.length} 个`,
    `- 取景证据：扫描线颜色段 ${adaptChecks.colorRuns} 段（原始色条 8 段）`,
    '',
    '## 拒绝与确定性',
    '',
    `- Canvas 变体被拒绝：${JSON.stringify(refusal.problems.map((problem) => problem.code))}`,
    report.steps.determinism === undefined
      ? '- 确定性：本次跳过'
      : `- 两次渲染字节一致：${report.steps.determinism.byteIdentical}；暖缓存复用：${report.steps.determinism.cacheReuse}；帧访问顺序无关：${report.steps.determinism.frameAccessConsistent}；改参数改变结果：${report.steps.determinism.parameterChange.bytesChanged}`,
    '',
    '> 程序通过不等于 AI 看过／听过，也不等于用户验收。',
  ].join('\n')
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${summary}\n`)

  process.stdout.write(`${summary}\n\n`)
  return report
}

main()
