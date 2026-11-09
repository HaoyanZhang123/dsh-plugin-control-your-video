#!/usr/bin/env node
/**
 * C12 round-2 evidence: the three runtimes on one plan, plus the five "partial" items.
 *
 * Assumes the three final renders already exist in the evidence directory (they were produced by
 * this card's adapters; their SHA-256 and probe facts are re-measured here rather than trusted).
 *
 * Usage: node media/dev/round2-evidence.mjs --out <dir> --corpus <dir>
 *
 * @module media/dev/round2-evidence
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Clock, writeJsonAtomic } from '../../base/index.js'
import * as media from '../index.js'
import { buildC12UnitPlan } from '../fixtures/c12-unit.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_ROOT = path.resolve(HERE, '..')

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    out: path.join(MODULE_ROOT, 'evidence'),
    corpus: path.resolve(MODULE_ROOT, '..', '..', 'RENDER-LAB', '01-corpus'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') options.out = path.resolve(argv[index + 1])
    else if (argv[index] === '--corpus') options.corpus = path.resolve(argv[index + 1])
  }
  return options
}

const fontFile = () =>
  process.env.C12_FONT ??
  path.join(process.env.WINDIR ?? process.env.SystemRoot ?? '.', 'Fonts', 'msyh.ttc')

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(options.out)
  fs.mkdirSync(outDir, { recursive: true })
  const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 9, 0, 0, 0) })
  const toolchain = media.resolveToolchain({ allowPathLookup: true })
  const rawPlan = buildC12UnitPlan({ fontFile: fontFile() })
  const plan = media.normalizePlan(rawPlan, { now: () => clock.iso() })
  const report = { startedAt: clock.iso(), toolchain: toolchain.describe(), runtimes: {}, items: {} }

  // 1. Three runtimes, one plan: measure the files rather than trusting the result JSONs.
  const files = {
    ffmpeg: path.join(outDir, 'c12-unit-final-v1.mp4'),
    remotion: path.join(outDir, 'c12-unit-remotion-v1.mp4'),
    hyperframes: path.join(outDir, 'c12-unit-hyperframes-v1.mp4'),
  }
  for (const [runtime, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) {
      report.runtimes[runtime] = { present: false, note: '缺少该运行时的成片' }
      continue
    }
    const probed = media.probeMedia(toolchain.ffprobe.path, file)
    const comparison = media.compareDeclaredToProbed(plan.outputSpec, probed)
    const decoded = media.decodeAllFrames({
      ffmpegPath: toolchain.ffmpeg.path,
      file,
      width: plan.outputSpec.width,
      height: plan.outputSpec.height,
    })
    report.runtimes[runtime] = {
      present: true,
      file: path.basename(file),
      bytes: fs.statSync(file).size,
      sha256: hashFile(file),
      probed: {
        width: probed.video?.width,
        height: probed.video?.height,
        pixelFormat: probed.video?.pixelFormat,
        videoCodec: probed.video?.codec,
        audioCodec: probed.audio?.codec,
        audioSampleRate: probed.audio?.sampleRate,
        audioChannels: probed.audio?.channels,
        nbFrames: probed.video?.nbFrames,
        durationSeconds: probed.format.durationSeconds,
      },
      specMatches: comparison.ok,
      differences: comparison.differences,
      decodedFrames: decoded.frames,
    }
  }

  // 2. Movie-level objects do not fade with the transition (CT-04 v1.1 §2.1 rule 3).
  //    Method: render the plan with and without the object, and measure how much the object
  //    contributes to its own region. A faded object contributes less in the overlap; a movie-level
  //    object must contribute the same amount. Raw brightness would be confounded by what the scene
  //    behind it is doing — this comparison is not.
  const ffmpegAdapter = media.createFfmpegAdapter({
    toolchain,
    workRoot: path.join(outDir, 'work'),
    clock,
    materialRoot: options.corpus,
  })
  const shape = { width: plan.outputSpec.width, height: plan.outputSpec.height }
  const withoutObject = (objectId) => {
    const copy = JSON.parse(JSON.stringify(plan))
    copy.objects = copy.objects.filter((object) => object.id !== objectId)
    copy.tracks = (copy.tracks ?? []).map((track) => ({
      ...track,
      objectIds: track.objectIds.filter((id) => id !== objectId),
    }))
    copy.scenes = copy.scenes.map((scene) => ({
      ...scene,
      objects: (scene.objects ?? []).filter((id) => id !== objectId),
    }))
    return media.normalizePlan(copy, { now: () => clock.iso() })
  }
  const contribution = (objectId, frame) => {
    const withObject = ffmpegAdapter.renderStillRaw(plan, frame)
    const without = ffmpegAdapter.renderStillRaw(withoutObject(objectId), frame)
    const object = plan.objects.find((entry) => entry.id === objectId)
    const diff = media.frameDiff(withObject.rgb24, without.rgb24, { ...shape, region: object.box })
    return { frame, meanAbsolute: diff.meanAbsolute, changedRatio: diff.changedRatio }
  }
  const subtitleBefore = contribution('obj-subtitle-S02', 100)
  const subtitleMid = contribution('obj-subtitle-S02', 135)
  const titleBefore = contribution('obj-sceneA-title', 100)
  const titleMid = contribution('obj-sceneA-title', 135)
  report.items.movieNotFaded = {
    method: '同一计划有/无该对象的编码前帧，在对象自身区域内比较贡献量；贡献量不随转场下降即为未淡出',
    subtitle: {
      before: subtitleBefore,
      mid: subtitleMid,
      ratio: Number((subtitleMid.meanAbsolute / Math.max(0.0001, subtitleBefore.meanAbsolute)).toFixed(3)),
      verdict:
        subtitleMid.meanAbsolute / Math.max(0.0001, subtitleBefore.meanAbsolute) > 0.9
          ? '字幕贡献量不降：影片级字幕未随画面淡出'
          : '字幕贡献量下降，违反 CT-04 §2.1',
    },
    sceneTitle: {
      before: titleBefore,
      mid: titleMid,
      ratio: Number((titleMid.meanAbsolute / Math.max(0.0001, titleBefore.meanAbsolute)).toFixed(3)),
      verdict:
        titleMid.meanAbsolute / Math.max(0.0001, titleBefore.meanAbsolute) < 0.9
          ? '场景标题贡献量下降：确实随转场淡出（对照组成立）'
          : '对照组未下降，方法需要复核',
    },
    participants: media.transitionParticipants(plan, 'obj-transition-crossfade').participants.map((entry) => entry.id),
  }

  // 3. Preview staleness in interface-shaped data.
  const repair = media.createRepairOperation({
    basePlan: plan,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '程序视觉、已有素材与用户音频，在同一条时间线上协作。（修订）' },
  })
  const previewState = media.describePreviewState({ basePlan: plan, currentPlan: repair.plan })
  const previewStatePartial = media.describePreviewState({
    basePlan: plan,
    currentPlan: repair.plan,
    coveredRange: { startFrame: 0, endFrameExclusive: 120 },
  })
  report.items.previewStaleness = { whole: previewState, partial: previewStatePartial }

  // 4. Real interruption: start the real FFmpeg command, kill it mid-encode, prove no half-product.
  const interruption = await runInterruptionTest(ffmpegAdapter, plan, outDir, clock)
  report.items.interruption = interruption

  // 5. Artificial untrusted package drill: hostile paths and resource shapes must be rejected.
  report.items.untrustedPackage = runUntrustedDrill(outDir)

  // 6. Runtime schema enumeration and pre-change state read-back (CT-14 steps 1-2).
  const workspaceRoot =
    process.env.C12_RENDER_WORKSPACE ?? path.join('E:\\DSH', '.dsh', 'tools', 'ai-video-workbench', 'render-workspace')
  const rendererInfo = describeRuntimes({ workspaceRoot, toolchain, outDir, clock, corpus: options.corpus, plan })
  report.items.runtimeProtocol = rendererInfo

  // 7. A playable preview: verify the preview file decodes and produce short visuals for people.
  const preview = path.join(outDir, 'c12-unit-preview-v1.mp4')
  if (fs.existsSync(preview)) {
    const probed = media.probeMedia(toolchain.ffprobe.path, preview)
    const decoded = media.decodeAllFrames({
      ffmpegPath: toolchain.ffmpeg.path,
      file: preview,
      width: probed.video.width,
      height: probed.video.height,
    })
    report.items.playablePreview = {
      file: path.basename(preview),
      width: probed.video.width,
      height: probed.video.height,
      frames: decoded.frames,
      durationSeconds: probed.format.durationSeconds,
      decodes: decoded.frames > 0,
      note: '可解码播放的连续预览（不是静帧），用于看运动与转场',
    }
  }
  makeVisuals(toolchain, outDir)

  report.endedAt = clock.iso()
  writeJsonAtomic(path.join(outDir, 'round2-evidence.json'), report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

/** SHA-256 of a file, computed here so evidence never trusts a recorded value. */
function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Absolute path of the headless shell already present for Remotion. */
function chromeShellPath() {
  return (
    process.env.C12_CHROME_SHELL ??
    path.resolve(
      process.env.C12_RENDER_LAB ?? path.join(moduleRoot(), '..', 'RENDER-LAB'),
      '03-remotion',
      'node_modules',
      '.remotion',
      'chrome-headless-shell',
      'win64',
      'chrome-headless-shell-win64',
      'chrome-headless-shell.exe',
    )
  )
}

function moduleRoot() {
  return MODULE_ROOT
}

/**
 * Kill a real render mid-flight and prove the product does not publish a half-product.
 * @param {any} adapter
 * @param {any} plan
 * @param {string} outDir
 * @param {any} clock
 */
function runInterruptionTest(adapter, plan, outDir, clock) {
  const publishTarget = path.join(outDir, 'interrupted-publish.mp4')
  if (fs.existsSync(publishTarget)) fs.rmSync(publishTarget, { force: true })
  const planRun = adapter.planRender(plan, { outputPath: publishTarget })
  const tasks = media.createTaskStore({ workRoot: path.join(outDir, 'work'), clock })
  const task = tasks.create({
    id: 'interrupt-demo',
    adapterId: 'ffmpeg-adapter',
    tier: 'final',
    planFingerprint: 'interrupt-demo',
    totalFrames: plan.timebase.totalFrames,
  })
  task.begin()
  const child = spawn(planRun.command.binary, planRun.command.args, {
    cwd: planRun.command.cwd,
    stdio: 'ignore',
    windowsHide: true,
  })
  const startedAt = Date.now()
  return new Promise((resolve) => {
    setTimeout(() => {
      child.kill()
      const killedAtMs = Date.now() - startedAt
      setTimeout(() => {
        const published = fs.existsSync(publishTarget)
        const tempExists = fs.existsSync(planRun.tempOutput)
        task.markUnknown('进程在渲染中被强制结束，输出是否完整未知')
        let resumeWithoutAck = 'allowed'
        try {
          task.resume({})
        } catch (error) {
          resumeWithoutAck = `refused: ${error.message}`
        }
        resolve({
          killedAfterMs: killedAtMs,
          publishTargetExists: published,
          tempFileExists: tempExists,
          tempPath: path.relative(outDir, planRun.tempOutput).split(path.sep).join('/'),
          taskState: 'unknown',
          resumeWithoutAck,
          verdict: published
            ? '失败：中断后仍发布了输出'
            : '通过：中断后没有半成品出现在发布路径，状态先按未知处理，未确认不得继续',
        })
      }, 1200)
    }, 1500)
  })
}

/** Hostile entry list: nothing here may crash the screen, and nothing may be accepted. */
function runUntrustedDrill(outDir) {
  const root = path.join(outDir, 'untrusted-root')
  fs.mkdirSync(root, { recursive: true })
  const entries = [
    { path: '../../escape.txt' },
    { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' },
    { path: '\\\\server\\share\\payload.exe' }, // dsh-allow S4: 恶意样例，必须写成 UNC 形式才能验证拒绝
    { path: '/etc/passwd' },
    { path: 'normal/clip.mp4', bytes: 1024 },
    { path: 'link-to-elsewhere', type: 'link' },
    { path: 'nul.txt' },
    { path: 'deep/' + Array.from({ length: 20 }, (_, index) => `d${index}`).join('/') + '/x.bin' },
    { path: 'bomb.bin', bytes: 5_000_000_000 },
    { path: 'zip-bomb.bin', bytes: 900_000_000, compressedBytes: 1000 },
    { path: 'bad\u0000name.txt' },
  ]
  const screened = media.screenUntrustedPackage({ root, entries })
  return {
    totalEntries: entries.length,
    accepted: screened.accepted,
    rejected: screened.rejected,
    reasonCodes: [...new Set(screened.rejected.map((entry) => entry.reason))].sort(),
    executable: screened.executable,
    ok: screened.ok === false && screened.accepted.length === 1,
  }
}

/** Schema enumeration + pre-change state for the runtimes actually installed. */
function describeRuntimes(input) {
  const result = {}
  const make = (name, module, extra) => {
    try {
      const adapter = module()
      result[name] = {
        available: true,
        schema: adapter.describeRuntimeSchema ? adapter.describeRuntimeSchema() : { supported: false },
        preChangeState: adapter.readPreChangeState ? adapter.readPreChangeState(input.plan) : { supported: false },
        capabilities: extra ?? adapter.capabilities().objectKinds,
      }
    } catch (error) {
      result[name] = { available: false, reason: error.message }
    }
  }
  make('ffmpeg', () =>
    media.createFfmpegAdapter({
      toolchain: input.toolchain,
      workRoot: path.join(input.outDir, 'work'),
      clock: input.clock,
      materialRoot: input.corpus,
    }),
  )
  make('remotion', () =>
    media.createRemotionAdapter({
      workspaceRoot: input.workspaceRoot,
      workRoot: path.join(input.outDir, 'work'),
      clock: input.clock,
      materialRoot: input.corpus,
      ffmpegPath: input.toolchain.ffmpeg.path,
      ffprobePath: input.toolchain.ffprobe.path,
      browserExecutable: chromeShellPath(),
    }),
  )
  make('hyperframes', () =>
    media.createHyperframesAdapter({
      workspaceRoot: input.workspaceRoot,
      workRoot: path.join(input.outDir, 'work'),
      clock: input.clock,
      materialRoot: input.corpus,
      ffmpegPath: input.toolchain.ffmpeg.path,
      ffprobePath: input.toolchain.ffprobe.path,
      chromePath: input.chromePath ?? path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    }),
  )
  return result
}

/** Short GIFs so a person can see motion in the conversation without opening the mp4. */
function makeVisuals(toolchain, outDir) {
  const shots = [
    { name: 'transition.gif', file: 'c12-unit-final-v1.mp4', start: 3.4, seconds: 2.0 },
    { name: 'remotion-transition.gif', file: 'c12-unit-remotion-v1.mp4', start: 3.4, seconds: 2.0 },
    { name: 'hyperframes-transition.gif', file: 'c12-unit-hyperframes-v1.mp4', start: 3.4, seconds: 2.0 },
  ]
  for (const shot of shots) {
    const source = path.join(outDir, shot.file)
    if (!fs.existsSync(source)) continue
    media.runFfmpeg({
      ffmpegPath: toolchain.ffmpeg.path,
      args: [
        '-v', 'error', '-y',
        '-ss', String(shot.start),
        '-t', String(shot.seconds),
        '-i', source,
        '-vf', 'fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
        path.join(outDir, 'frames', shot.name),
      ],
    })
  }
}

main()
