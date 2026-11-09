/**
 * Remotion adapter: renders one CompositionPlan with the managed Remotion runtime.
 *
 * External runtime, not bundled (CT-06 §1, RES-RENDER-WORKSPACE): the CLI and its node_modules live
 * in the managed render workspace; this file only prepares a project, invokes the CLI and records
 * the facts (entry, version, command, exit code, stderr).
 *
 * Object mapping stays in the plugin layer: the plan's object ids are passed through and appear as
 * `data-object-id` in the template, so an inspection can name the same object the user selected.
 *
 * @module media/render/remotion-adapter
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildCacheKey, ConflictError, ExternalError, IoError, sha256File, ValidationError, writeFileAtomic } from '../../base/index.js'
import { planFingerprint } from '../plan.js'
import { probeMedia, compareDeclaredToProbed } from '../probe.js'
import { ADAPTER_INTERFACE_VERSION, defineAdapter, validateCommon } from './adapter.js'

/** Object kinds the template can draw. */
export const REMOTION_OBJECT_KINDS = Object.freeze([
  'solid',
  'text-native',
  'subtitle',
  'image',
  'video-source-with-offset',
  'program-pattern',
  'program-counter',
  'audio-continuous',
])

/** Transitions the template implements with real overlap semantics. */
export const REMOTION_TRANSITIONS = Object.freeze(['cut', 'crossfade', 'wipe'])

/** Motion terms the template evaluates. */
export const REMOTION_MOTIONS = Object.freeze(['fade-in', 'fade-out', 'hold'])

const TEMPLATE_ROOT = path.resolve(import.meta.dirname, '..', 'templates', 'remotion')

/** Copy a directory tree (template is tiny). */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else fs.copyFileSync(source, target)
  }
}

/** Link a material into the project's public folder, falling back to a copy across volumes. */
function linkOrCopy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (fs.existsSync(to)) return to
  try {
    fs.linkSync(from, to)
  } catch {
    fs.copyFileSync(from, to)
  }
  return to
}

/** A file name that is safe for a URL and stable per object. */
function materialName(objectId, sourceFile) {
  const ext = path.extname(sourceFile) || '.bin'
  return `${objectId.replace(/[^a-z0-9_-]/gi, '_')}${ext}`
}

/**
 * Build the render-time copy of the plan.
 *
 * Only presentation paths are added; timing, ids, scopes and editability are untouched so the
 * rendered object cannot drift from the object the plan describes.
 *
 * @param {any} plan
 * @param {{ projectDir: string, materialRoot: string }} input
 */
export function prepareRemotionPlan(plan, input) {
  const publicDir = path.join(input.projectDir, 'public', 'media')
  const objects = plan.objects.map((object) => {
    const sourceFile = object?.authored?.sourceFile
    if (typeof sourceFile !== 'string' || sourceFile.length === 0) return object
    const absolute = path.resolve(input.materialRoot, sourceFile)
    if (!absolute.startsWith(path.resolve(input.materialRoot) + path.sep)) {
      throw new ExternalError('素材路径越出素材根目录', { code: 'PATH_ESCAPE', details: { sourceFile } })
    }
    if (!fs.existsSync(absolute)) {
      throw new IoError('素材不存在', { details: { sourceFile, absolute } })
    }
    const name = materialName(object.id, sourceFile)
    linkOrCopy(absolute, path.join(publicDir, name))
    return { ...object, params: { ...object.params, staticPath: `media/${name}` } }
  })
  return { ...plan, objects }
}

/**
 * @param {object} input
 * @param {string} input.workspaceRoot managed render workspace root
 * @param {string} input.workRoot work directory for generated projects and outputs
 * @param {any} input.clock
 * @param {string} input.materialRoot
 * @param {string} input.browserExecutable absolute path of the existing headless shell
 */
export function createRemotionAdapter(input) {
  const workspaceRoot = path.resolve(input.workspaceRoot)
  const remotionRoot = path.join(workspaceRoot, 'remotion')
  const cliPath = path.join(remotionRoot, 'node_modules', '@remotion', 'cli', 'remotion-cli.js')
  const nodeModules = path.join(remotionRoot, 'node_modules')
  const workRoot = path.resolve(input.workRoot)
  const clock = input.clock
  const browserExecutable = input.browserExecutable
  const runtimeVersion = input.runtimeVersion ?? '4.0.541'

  const caps = {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    runtimeId: 'remotion',
    runtimeVersion,
    objectKinds: [...REMOTION_OBJECT_KINDS],
    transitions: [...REMOTION_TRANSITIONS],
    motions: [...REMOTION_MOTIONS],
    tiers: {
      preview: { scale: 0.5, note: '同模板低分辨率预览' },
      final: { note: '正式输出' },
    },
    pixelFormats: ['yuv420p'],
    containers: ['mp4'],
    audio: { codecs: ['aac'], sampleRates: [48000], channels: [2] },
    determinism: {
      singleThread: true,
      note: '同一计划两次渲染的帧内容应一致；文件字节一致性未承诺（浏览器渲染管线）',
    },
    resume: { supported: false, note: '不支持原帧续渲' },
    progress: { frames: true, phases: ['prepare', 'render', 'verify'] },
    limits: {
      maxFrameSize: { width: 1920, height: 1920 },
      unsupported: ['任意第三方 React 组件库', '透明输出（当前 MP4 路径）'],
    },
    externalTools: [
      {
        toolId: 'remotion',
        version: runtimeVersion,
        kind: 'workspace-runtime',
        required: true,
        note: '装在受管渲染工作区，未走 C06 采纳流程；不随插件分发',
      },
    ],
  }

  /** Prepare a project directory for one plan. */
  const prepareProject = (plan, options) => {
    const fingerprint = planFingerprint(plan)
    const projectDir = path.join(workRoot, 'remotion-projects', `${plan.planId}-${fingerprint.slice(0, 10)}`)
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.mkdirSync(projectDir, { recursive: true })
    copyTree(TEMPLATE_ROOT, projectDir)
    const renderPlan = prepareRemotionPlan(plan, { projectDir, materialRoot: input.materialRoot })
    if (options.scale !== 1) {
      renderPlan.outputSpec = {
        ...renderPlan.outputSpec,
        width: Math.round(plan.outputSpec.width * options.scale / 2) * 2,
        height: Math.round(plan.outputSpec.height * options.scale / 2) * 2,
      }
    }
    writeFileAtomic(path.join(projectDir, 'src', 'plan.json'), JSON.stringify(renderPlan, null, 2))
    // The CLI resolves packages from the workspace through a directory junction, so the template
    // never carries its own dependency tree (and no install happens).
    const link = path.join(projectDir, 'node_modules')
    if (!fs.existsSync(link)) fs.symlinkSync(nodeModules, link, 'junction')
    return { projectDir, renderPlan }
  }

  /** Run the CLI once and capture facts. */
  const runCli = (projectDir, args) => {
    const started = clock.iso()
    const startMs = Date.now()
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: input.timeoutMs ?? 900000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      // A first run may try to fetch a headless shell. It is already supplied via
      // --browser-executable; a failing proxy makes any accidental download fail fast instead of
      // silently pulling ~200 MB.
      env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' },
    })
    const stdout = String(result.stdout ?? '')
    const stderr = String(result.stderr ?? '')
    return {
      startedAt: started,
      endedAt: clock.iso(),
      durationMs: Date.now() - startMs,
      exitCode: result.status,
      command: { binary: process.execPath, args: [cliPath, ...args], cwd: projectDir },
      stdoutTail: stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-12).join('\n'),
      stderrTail: stderr.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-12).join('\n'),
      attemptedDownload: /download|Downloading/i.test(stdout) || /download|Downloading/i.test(stderr),
    }
  }

  const validatePlanImpl = (plan) => {
    const common = validateCommon(plan, caps, {
      materialExists: (file) => fs.existsSync(path.resolve(input.materialRoot, file)),
      fontExists: () => true,
    })
    const problems = [...common.problems]
    if (!fs.existsSync(cliPath)) {
      problems.push({
        code: 'runtime-missing',
        detail: `Remotion CLI 不在 ${cliPath}`,
        remedy: '检查受管渲染工作区是否就位',
      })
    }
    if (!fs.existsSync(browserExecutable)) {
      problems.push({
        code: 'browser-missing',
        detail: `无头浏览器不存在：${browserExecutable}`,
        remedy: '先确认渲染工作区自带的 headless shell；不要触发下载',
      })
    }
    return { ok: problems.length === 0, problems, capabilities: caps }
  }

  const render = (plan, request) => {
    const validated = validatePlanImpl(plan)
    if (!validated.ok) {
      throw new ValidationError('计划未通过 Remotion 适配器校验', { details: { problems: validated.problems } })
    }
    const scale = request.tier === 'preview' ? 0.5 : 1
    const { projectDir, renderPlan } = prepareProject(plan, { scale })
    const outputPath = path.resolve(request.outputPath)
    if (fs.existsSync(outputPath) && request.allowOverwrite !== true) {
      throw new ConflictError('输出已存在；不覆盖旧结果', { outputPath })
    }
    const args = [
      'render',
      'src/index.jsx',
      'C12Unit',
      request.tier === 'preview' ? `--scale=${scale}` : null,
      `--browser-executable=${browserExecutable}`,
      '--concurrency=1',
      '--pixel-format=yuv420p',
      '--image-format=png',
      '--codec=h264',
      '--overwrite',
      outputPath,
    ].filter((value) => value !== null)
    const run = runCli(projectDir, args)
    if (run.attemptedDownload) {
      throw new ExternalError('Remotion 尝试下载浏览器，按授权边界已中止', {
        code: 'DOWNLOAD_ATTEMPTED',
        details: { stdoutTail: run.stdoutTail, stderrTail: run.stderrTail },
      })
    }
    if (run.exitCode !== 0 || !fs.existsSync(outputPath)) {
      throw new ExternalError('Remotion 渲染失败', {
        code: 'RENDER_FAILED',
        details: { exitCode: run.exitCode, stderrTail: run.stderrTail, stdoutTail: run.stdoutTail },
      })
    }
    const probed = probeMedia(input.ffprobePath, outputPath)
    const declared = renderPlan.outputSpec
    const comparison = compareDeclaredToProbed(declared, probed)
    const cache = buildCacheKey({
      plan: planFingerprint(plan),
      tier: request.tier,
      runtime: `remotion-${runtimeVersion}`,
      template: 'c12-remotion-template-v1',
    })
    return {
      runtimeId: 'remotion',
      runtimeVersion,
      adapterId: 'remotion-adapter',
      tier: request.tier,
      file: outputPath,
      bytes: fs.statSync(outputPath).size,
      sha256: sha256File(outputPath),
      planId: plan.planId,
      planVersion: plan.planVersion,
      planFingerprint: planFingerprint(plan),
      declaredSpec: declared,
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
      specComparison: comparison,
      execution: {
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        cache: 'cold',
        exitCode: run.exitCode,
        cacheKey: cache.key,
      },
      command: run.command,
      externalEngineering: {
        projectDir,
        entry: 'src/index.jsx',
        composition: 'C12Unit',
        browserExecutable,
        files: ['src/index.jsx', 'src/Root.jsx', 'src/Unit.jsx', 'src/plan.json'],
      },
      stdoutTail: run.stdoutTail,
      stderrTail: run.stderrTail,
      checks: {
        frameCount: probed.video?.nbFrames === plan.timebase.totalFrames ? 'ok' : 'failed',
        spec: comparison.ok ? 'ok' : 'failed',
      },
      knownDifferences: comparison.differences.map(
        (entry) => `${entry.field}: 声明 ${String(entry.declared)} / 实测 ${String(entry.probed)}`,
      ),
    }
  }

  const adapter = {
    id: 'remotion-adapter',
    version: ADAPTER_INTERFACE_VERSION,
    ffmpegPath: input.ffmpegPath,
    ffprobePath: input.ffprobePath,
    capabilities: () => caps,
    validatePlan: validatePlanImpl,
    renderFinal: (plan, outputSpec, context) => {
      if (JSON.stringify(outputSpec) !== JSON.stringify(plan.outputSpec)) {
        throw new ValidationError('正式输出规格必须与计划一致')
      }
      return render(plan, { tier: 'final', outputPath: context.outputPath, allowOverwrite: context.allowOverwrite })
    },
    renderPreview: (plan, range, quality, context) =>
      render(plan, { tier: 'preview', outputPath: context.outputPath, allowOverwrite: context.allowOverwrite }),
    readProgress: () => ({ supported: false, note: 'CLI 输出不提供逐帧进度；本卡不伪造进度' }),
    pause: () => ({ supported: false, note: '不支持在进程内暂停' }),
    cancel: () => ({ supported: false, note: '取消以结束进程为准' }),
    resumeFromSavedWork: () => ({ supported: false, note: '不支持原帧续渲' }),
    probeResult: (resultRef) => probeMedia(input.ffprobePath, typeof resultRef === 'string' ? resultRef : resultRef.file),
    snapshotExternalEngineering: (plan) => ({
      kind: 'remotion-project',
      template: 'media/templates/remotion',
      planId: plan.planId,
      planVersion: plan.planVersion,
    }),
    describe: () => ({
      adapterId: 'remotion-adapter',
      interfaceVersion: ADAPTER_INTERFACE_VERSION,
      runtime: { id: 'remotion', version: runtimeVersion },
      capabilities: caps,
      workspaceRoot,
      cliPath,
      browserExecutable,
    }),
    /** Enumerate the real CLI surface the adapter uses (tool schema read-back, CT-14). */
    describeRuntimeSchema() {
      const help = spawnSync(process.execPath, [cliPath, 'render', '--help'], {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      })
      const text = `${String(help.stdout ?? '')}\n${String(help.stderr ?? '')}`
      const flags = [...text.matchAll(/--([a-z0-9-]+)/g)].map((match) => match[1])
      return {
        runtime: 'remotion',
        version: runtimeVersion,
        entry: cliPath,
        composition: 'C12Unit',
        flagsUsed: ['props', 'browser-executable', 'concurrency', 'pixel-format', 'image-format', 'codec', 'overwrite', 'scale'],
        flagsAvailable: [...new Set(flags)].sort(),
        probedAt: clock.iso(),
      }
    },
    /** Pre-change state read back before rendering (CT-14 step 2). */
    readPreChangeState(plan) {
      return {
        planId: plan.planId,
        planVersion: plan.planVersion,
        fingerprint: planFingerprint(plan),
        totalFrames: plan.timebase.totalFrames,
        objectCount: plan.objects.length,
        outputSpec: plan.outputSpec,
        materials: (plan.materials ?? []).map((material) => {
          const absolute = path.resolve(input.materialRoot, material.file)
          const exists = fs.existsSync(absolute)
          return { id: material.id, exists, bytes: exists ? fs.statSync(absolute).size : null }
        }),
        readAt: clock.iso(),
      }
    },
  }
  return defineAdapter(adapter)
}
