/**
 * HyperFrames adapter: renders one CompositionPlan as an HTML composition.
 *
 * External runtime (Apache-2.0), installed in the managed render workspace; the plugin generates the
 * composition document from the plan and invokes the CLI. Nothing from the runtime is bundled.
 *
 * Contract notes (CT-04 §3, CT-06 §4):
 * - a scene's start is computed explicitly (B.start = A.start + A.duration − overlap); HyperFrames
 *   has no transition primitive, so the cross-dissolve is expressed as two CSS animations over the
 *   same overlap window;
 * - movie-level objects are NOT part of either scene: they never fade with the picture (CT-04 §2.1);
 * - `<video>` is a stage-level direct child with a stable id and `data-media-start` for the source
 *   in-point (not a wrapper), as the runtime requires.
 *
 * @module media/render/hyperframes-adapter
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ConflictError, ExternalError, IoError, ValidationError, sha256File, writeFileAtomic } from '../../base/index.js'
import { planFingerprint } from '../plan.js'
import { probeMedia, compareDeclaredToProbed } from '../probe.js'
import { ADAPTER_INTERFACE_VERSION, defineAdapter, validateCommon } from './adapter.js'

/** Object kinds the generated HTML implements. */
export const HYPERFRAMES_OBJECT_KINDS = Object.freeze([
  'solid',
  'text-native',
  'subtitle',
  'image',
  'video-source-with-offset',
  'program-pattern',
  'program-counter',
  'audio-continuous',
])

/** Transitions implemented as overlapped CSS animations. */
export const HYPERFRAMES_TRANSITIONS = Object.freeze(['cut', 'crossfade', 'wipe'])

/** Motion terms evaluated by inline script. */
export const HYPERFRAMES_MOTIONS = Object.freeze(['fade-in', 'fade-out', 'hold'])

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const seconds = (frames, num, den) => Number(((frames * den) / num).toFixed(6))

/**
 * Generate the composition document for one plan.
 *
 * @param {any} plan
 * @param {{ materialRoot: string, projectDir: string, runtimeVersion: string }} input
 * @returns {{ html: string, assets: Array<{ id: string, file: string, target: string }> }}
 */
export function buildHyperframesDocument(plan, input) {
  const fpsNum = plan.timebase.fpsNumerator
  const fpsDen = plan.timebase.fpsDenominator
  const fps = fpsNum / fpsDen
  const assetsDir = path.join(input.projectDir, 'assets')
  const assets = []
  const ensureAsset = (object) => {
    const sourceFile = object?.authored?.sourceFile
    if (typeof sourceFile !== 'string' || sourceFile.length === 0) return null
    const absolute = path.resolve(input.materialRoot, sourceFile)
    if (!absolute.startsWith(path.resolve(input.materialRoot) + path.sep)) {
      throw new ExternalError('素材路径越出素材根目录', { code: 'PATH_ESCAPE', details: { sourceFile } })
    }
    if (!fs.existsSync(absolute)) throw new IoError('素材不存在', { details: { sourceFile } })
    const name = `${object.id.replace(/[^a-z0-9_-]/gi, '_')}${path.extname(sourceFile) || '.bin'}`
    const target = path.join(assetsDir, name)
    fs.mkdirSync(assetsDir, { recursive: true })
    if (!fs.existsSync(target)) {
      try {
        fs.linkSync(absolute, target)
      } catch {
        fs.copyFileSync(absolute, target)
      }
    }
    assets.push({ id: object.id, file: sourceFile, target: name })
    return `assets/${name}`
  }

  const overlapOf = (sceneId) => {
    const transition = (plan.transitions ?? []).find((entry) => entry.toScene === sceneId)
    if (transition === undefined || transition.kind === 'cut') return null
    const from = plan.scenes.find((scene) => scene.id === transition.fromScene)
    const to = plan.scenes.find((scene) => scene.id === transition.toScene)
    return {
      kind: transition.kind,
      frames: transition.overlapFrames,
      fromScene: from,
      toScene: to,
      startFrame: to.timeline.startFrame,
    }
  }

  const styleLines = []
  const bodyLines = []
  let trackIndex = 0
  const nextTrack = () => {
    trackIndex += 1
    return trackIndex
  }

  // Scene backgrounds and objects.
  for (const scene of plan.scenes) {
    const sceneStart = seconds(scene.timeline.startFrame, fpsNum, fpsDen)
    const sceneDuration = seconds(scene.timeline.durationFrames, fpsNum, fpsDen)
    const sceneObjects = plan.objects
      .filter((object) => object.scope === 'scene' && object.sceneId === scene.id)
      .sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0))
    const background = sceneObjects.find((object) => object.kind === 'solid')
    if (background !== undefined) {
      const id = background.id.replace(/[^a-z0-9_-]/gi, '_')
      styleLines.push(
        `#${id} { position: absolute; inset: 0; z-index: 1; background: ${background.params?.color ?? '#000'}; }`,
      )
      bodyLines.push(
        `      <div id="${id}" class="clip" data-object-id="${escapeHtml(background.id)}" data-start="${sceneStart}" data-duration="${sceneDuration}" data-track-index="${nextTrack()}"></div>`,
      )
    }
    for (const object of sceneObjects) {
      if (object.kind === 'solid') continue
      const id = object.id.replace(/[^a-z0-9_-]/gi, '_')
      const start = seconds(object.timeline.startFrame, fpsNum, fpsDen)
      const duration = seconds(object.timeline.durationFrames, fpsNum, fpsDen)
      if (object.kind === 'video-source-with-offset') {
        const src = ensureAsset(object)
        const offset = seconds(object.authored?.sourceOffsetFrames ?? 0, fpsNum, fpsDen)
        styleLines.push(
          `#${id} { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: ${object.params?.fit ?? 'cover'}; opacity: ${object.params?.opacity ?? 1}; z-index: ${2 + (object.zIndex ?? 0)}; }`,
        )
        // Stage-level direct child with a stable id — HyperFrames refuses a video inside a wrapper.
        bodyLines.push(
          `      <video id="${id}" class="clip" data-object-id="${escapeHtml(object.id)}" src="${src}" data-media-start="${offset}" data-start="${start}" data-duration="${duration}" data-track-index="${nextTrack()}" data-has-audio="false" muted preload="auto" playsinline></video>`,
        )
        continue
      }
      if (object.kind === 'image') {
        const src = ensureAsset(object)
        styleLines.push(
          `#${id} { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: ${object.params?.fit ?? 'contain'}; opacity: ${object.params?.opacity ?? 1}; z-index: ${2 + (object.zIndex ?? 0)}; }`,
        )
        bodyLines.push(
          `      <img id="${id}" class="clip" data-object-id="${escapeHtml(object.id)}" src="${src}" data-start="${start}" data-duration="${duration}" data-track-index="${nextTrack()}" />`,
        )
        continue
      }
      if (object.kind === 'program-pattern') {
        const box = object.box ?? { x: 0, y: 0, width: 400, height: 240 }
        styleLines.push(
          `#${id} { position: absolute; left: ${box.x}px; top: ${box.y}px; width: ${box.width}px; height: ${box.height}px; z-index: ${2 + (object.zIndex ?? 0)}; }`,
        )
        bodyLines.push(
          `      <canvas id="${id}" class="clip" data-object-id="${escapeHtml(object.id)}"` +
            ` width="${box.width}" height="${box.height}" data-start="${start}" data-duration="${duration}"` +
            ` data-track-index="${nextTrack()}" data-pattern='${escapeHtml(
            JSON.stringify(object.params ?? {}),
          )}'></canvas>`,
        )
        continue
      }
      if (object.kind === 'program-counter') {
        const params = object.params ?? {}
        // One element per frame on its OWN track: the page clock is wall time, and CSS keyframes are
        // not seeked with the composition, so the number comes from the same clip timeline as
        // everything else. Each clip lasts exactly one frame.
        for (let offset = 0; offset < object.timeline.durationFrames; offset += 1) {
          const frameStart = seconds(object.timeline.startFrame + offset, fpsNum, fpsDen)
          const oneFrame = seconds(1, fpsNum, fpsDen)
          const frameId = `${id}-${offset}`
          styleLines.push(
            `#${frameId} { position: absolute; left: ${params.x ?? 0}px; top: ${params.y ?? 0}px; font-family: ${params.fontFamily ?? 'Microsoft YaHei'}; font-size: ${params.fontSize ?? 32}px; color: ${params.color ?? '#fff'}; z-index: ${2 + (object.zIndex ?? 0)}; }`,
          )
          bodyLines.push(
            `      <div id="${frameId}" class="clip" data-object-id="${escapeHtml(object.id)}" data-start="${frameStart}" data-duration="${oneFrame}" data-track-index="${nextTrack()}">${String(scene.timeline.startFrame + offset).padStart(3, '0')}</div>`,
          )
        }
        continue
      }
      if (object.kind === 'text-native') {
        const params = object.params ?? {}
        const anchor = params.anchor ?? 'top-left'
        const position =
          anchor === 'center'
            ? `left: 50%; top: ${params.y ?? 0}px; transform: translate(-50%, -50%);`
            : anchor === 'bottom-center'
              ? `left: 50%; bottom: ${params.safeArea?.bottomPx ?? 72}px; transform: translateX(-50%);`
              : `left: ${params.x ?? 0}px; top: ${params.y ?? 0}px;`
        styleLines.push(
          `#${id} { position: absolute; ${position} font-family: ${params.fontFamily ?? 'Microsoft YaHei'}; font-size: ${params.fontSize ?? 32}px; font-weight: ${params.fontWeight ?? 400}; color: ${params.color ?? '#fff'}; white-space: pre; z-index: ${2 + (object.zIndex ?? 0)}; }`,
        )
        bodyLines.push(
          `      <div id="${id}" class="clip" data-object-id="${escapeHtml(object.id)}" data-start="${start}" data-duration="${duration}" data-track-index="${nextTrack()}">${escapeHtml(params.text ?? '')}</div>`,
        )
      }
    }
  }

  // Movie-level objects: never inside a scene, never faded by a transition.
  for (const object of plan.objects.filter((entry) => entry.scope === 'movie')) {
    const id = object.id.replace(/[^a-z0-9_-]/gi, '_')
    const start = seconds(object.timeline.startFrame, fpsNum, fpsDen)
    const duration = seconds(object.timeline.durationFrames, fpsNum, fpsDen)
    if (object.kind === 'audio-continuous') {
      const src = ensureAsset(object)
      const offset = seconds(object.authored?.sourceOffsetFrames ?? 0, fpsNum, fpsDen)
      bodyLines.push(
        `      <audio id="${id}" data-object-id="${escapeHtml(object.id)}" src="${src}" data-start="${start}" data-duration="${duration}" data-media-start="${offset}" data-volume="${object.params?.volume ?? 1}" data-track-index="${nextTrack()}"></audio>`,
      )
      continue
    }
    if (object.kind === 'subtitle' || object.kind === 'text-native') {
      const params = object.params ?? {}
      styleLines.push(
        `#${id} { position: absolute; left: 50%; bottom: ${params.safeArea?.bottomPx ?? 72}px; transform: translateX(-50%); max-width: ${params.safeArea?.maxWidthPx ?? 1080}px; padding: 10px 18px; border-radius: 8px; background: ${params.backgroundColor ?? 'rgba(0,0,0,0.62)'}; color: ${params.color ?? '#fff'}; font-family: ${params.fontFamily ?? 'Microsoft YaHei'}; font-size: ${params.fontSize ?? 30}px; line-height: 1.4; text-align: center; white-space: pre; z-index: 20; }`,
      )
      bodyLines.push(
        `      <div id="${id}" class="clip" data-object-id="${escapeHtml(object.id)}" data-start="${start}" data-duration="${duration}" data-track-index="${nextTrack()}">${escapeHtml(params.text ?? '')}</div>`,
      )
    }
  }

  // Cross-dissolve: each participating element fades over exactly the overlap window. Actors are
  // derived from the plan (scene-scoped, visible in the window), never hand-listed.
  for (const scene of plan.scenes.slice(1)) {
    const overlap = overlapOf(scene.id)
    if (overlap === null) continue
    const fadeStart = seconds(overlap.startFrame, fpsNum, fpsDen)
    const fadeSeconds = seconds(overlap.frames, fpsNum, fpsDen)
    const outgoing = plan.objects.filter(
      (object) =>
        object.scope === 'scene' &&
        object.sceneId === overlap.fromScene.id &&
        object.timeline.startFrame < scene.timeline.startFrame + overlap.frames,
    )
    const incoming = plan.objects.filter(
      (object) =>
        object.scope === 'scene' &&
        object.sceneId === overlap.toScene.id &&
        object.timeline.startFrame < scene.timeline.startFrame + overlap.frames,
    )
    for (const object of outgoing) {
      const id = object.id.replace(/[^a-z0-9_-]/gi, '_')
      styleLines.push(
        `@keyframes c12-out-${id} { from { opacity: ${object.kind === 'video-source-with-offset' ? object.params?.opacity ?? 1 : 1}; } to { opacity: 0; } }`,
      )
      styleLines.push(`#${id} { animation: c12-out-${id} ${fadeSeconds}s linear ${fadeStart}s forwards; }`)
    }
    for (const object of incoming) {
      const id = object.id.replace(/[^a-z0-9_-]/gi, '_')
      styleLines.push(
        `@keyframes c12-in-${id} { from { opacity: 0; } to { opacity: ${object.kind === 'video-source-with-offset' ? object.params?.opacity ?? 1 : 1}; } }`,
      )
      styleLines.push(`#${id} { animation: c12-in-${id} ${fadeSeconds}s linear ${fadeStart}s forwards; }`)
    }
  }

  const overlapScenes = []
  for (const scene of plan.scenes.slice(1)) {
    const overlap = overlapOf(scene.id)
    if (overlap === null) continue
    overlapScenes.push({ scene, overlap })
  }
  const firstOverlap = overlapScenes[0] ?? null
  const visualKinds = new Set([
    'solid',
    'video-source-with-offset',
    'image',
    'program-pattern',
    'program-counter',
    'text-native',
  ])
  const baseOpacity = (object) => (object.kind === 'video-source-with-offset' ? object.params?.opacity ?? 1 : 1)
  const timelineData = {
    overlapStartSeconds: firstOverlap === null ? 0 : seconds(firstOverlap.overlap.startFrame, fpsNum, fpsDen),
    overlapSeconds: firstOverlap === null ? 0 : seconds(firstOverlap.overlap.frames, fpsNum, fpsDen),
    totalSeconds: seconds(plan.timebase.totalFrames, fpsNum, fpsDen),
    fadeOut:
      firstOverlap === null
        ? []
        : plan.objects
            .filter((object) => object.scope === 'scene' && object.sceneId === firstOverlap.overlap.fromScene.id)
            .filter((object) => visualKinds.has(object.kind))
            .filter(
              (object) => object.timeline.startFrame < firstOverlap.overlap.startFrame + firstOverlap.overlap.frames,
            )
            .map((object) => ({ id: object.id, base: baseOpacity(object) })),
    fadeIn:
      firstOverlap === null
        ? []
        : plan.objects
            .filter((object) => object.scope === 'scene' && object.sceneId === firstOverlap.overlap.toScene.id)
            .filter((object) => visualKinds.has(object.kind))
            .filter(
              (object) => object.timeline.startFrame < firstOverlap.overlap.startFrame + firstOverlap.overlap.frames,
            )
            .map((object) => ({ id: object.id, base: baseOpacity(object) })),
  }

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${plan.outputSpec.width}, height=${plan.outputSpec.height}" />
    <title>${escapeHtml(plan.planId)} ${escapeHtml(plan.planVersion)}</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${plan.outputSpec.width}px; height: ${plan.outputSpec.height}px; overflow: hidden;
        background: #000; }
      .clip { position: absolute; }
${styleLines.map((line) => `      ${line}`).join('\n')}
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${seconds(plan.timebase.totalFrames, fpsNum, fpsDen)}"
      data-fps="${fps}"
      data-width="${plan.outputSpec.width}"
      data-height="${plan.outputSpec.height}"
    >
${bodyLines.join('\n')}
    </div>
    <script src="assets/gsap.min.js"></script>
    <script>
      // HyperFrames seeks the timeline registered on window.__timelines[compositionId]. GSAP is the
      // runtime's own dependency (external tool), linked into the project at render time — it is not
      // shipped with the plugin.
      const C12 = ${JSON.stringify(timelineData)};
      const patterns = Array.from(document.querySelectorAll('canvas[data-pattern]'));
      const drawPatternAt = (timeSeconds) => {
        for (const canvas of patterns) {
          const context = canvas.getContext('2d');
          if (!context) continue;
          const params = JSON.parse(canvas.getAttribute('data-pattern') || '{}');
          const width = canvas.width;
          const height = canvas.height;
          context.clearRect(0, 0, width, height);
          let seed = (params.seed ?? 1) >>> 0;
          const next = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
          };
          const count = params.count ?? 90;
          for (let index = 0; index < count; index += 1) {
            const baseX = next() * width;
            const baseY = next() * height;
            const phase = next() * Math.PI * 2;
            const speed = 0.4 + next() * 0.8;
            const x = (baseX + Math.cos(phase + timeSeconds * speed) * 6 + width) % width;
            const y = (baseY + Math.sin(phase + timeSeconds * speed) * 4 + height) % height;
            context.fillStyle = params.hue ? 'hsl(' + params.hue + ' 90% 65% / 0.9)' : '#38bdf8';
            context.fillRect(Math.round(x), Math.round(y), 3, 3);
          }
        }
      };
      const timeline = gsap.timeline({ paused: true });
      for (const entry of C12.fadeOut) {
        timeline.fromTo(
          '[data-object-id="' + entry.id + '"]',
          { opacity: entry.base },
          { opacity: 0, duration: C12.overlapSeconds, ease: 'none' },
          C12.overlapStartSeconds,
        );
      }
      for (const entry of C12.fadeIn) {
        timeline.fromTo(
          '[data-object-id="' + entry.id + '"]',
          { opacity: 0 },
          { opacity: entry.base, duration: C12.overlapSeconds, ease: 'none' },
          C12.overlapStartSeconds,
        );
      }
      const proxy = { t: 0 };
      timeline.to(
        proxy,
        {
          t: C12.totalSeconds,
          duration: C12.totalSeconds,
          ease: 'none',
          onUpdate: () => drawPatternAt(proxy.t),
        },
        0,
      );
      window.__timelines = window.__timelines || {};
      window.__timelines['main'] = timeline;
      timeline.seek(0);
      drawPatternAt(0);
    </script>
  </body>
</html>
`
  return { html, assets }
}

/**
 * @param {object} input
 * @param {string} input.workspaceRoot
 * @param {string} input.workRoot
 * @param {any} input.clock
 * @param {string} input.materialRoot
 * @param {string} input.chromePath absolute path of the system Chrome
 * @param {string} [input.runtimeVersion]
 */
export function createHyperframesAdapter(input) {
  const workspaceRoot = path.resolve(input.workspaceRoot)
  const hyperframesRoot = path.join(workspaceRoot, 'hyperframes')
  const cliPath = path.join(hyperframesRoot, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')
  const workRoot = path.resolve(input.workRoot)
  const clock = input.clock
  const runtimeVersion = input.runtimeVersion ?? '0.9.19'
  const chromePath = input.chromePath

  const caps = {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    runtimeId: 'hyperframes',
    runtimeVersion,
    objectKinds: [...HYPERFRAMES_OBJECT_KINDS],
    transitions: [...HYPERFRAMES_TRANSITIONS],
    motions: [...HYPERFRAMES_MOTIONS],
    tiers: { preview: { quality: 'draft', note: '同项目低质量预览' }, final: { quality: 'looks', note: '正式输出' } },
    pixelFormats: ['yuv420p'],
    containers: ['mp4'],
    audio: { codecs: ['aac'], sampleRates: [48000], channels: [2] },
    determinism: { singleThread: true, note: '同一计划两次渲染帧内容应一致；浏览器捕获不承诺字节一致' },
    resume: { supported: false, note: '不支持原帧续渲' },
    progress: { frames: false, note: 'CLI 不报告逐帧进度' },
    limits: {
      maxFrameSize: { width: 1920, height: 1920 },
      unsupported: ['透明输出（本卡未验证）', '复杂 GSAP 时间线（本模板只用 CSS 动画）'],
    },
    externalTools: [
      {
        toolId: 'hyperframes',
        version: runtimeVersion,
        kind: 'workspace-runtime',
        required: true,
        note: 'Apache-2.0 外部工具，装在受管工作区，不随插件分发',
      },
    ],
  }

  const prepare = (plan) => {
    const fingerprint = planFingerprint(plan)
    const projectDir = path.join(workRoot, 'hyperframes-projects', `${plan.planId}-${fingerprint.slice(0, 10)}`)
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.mkdirSync(projectDir, { recursive: true })
    const { html } = buildHyperframesDocument(plan, { materialRoot: input.materialRoot, projectDir, runtimeVersion })
    writeFileAtomic(path.join(projectDir, 'index.html'), html)
    // GSAP is the runtime's own dependency, linked in at render time; the plugin does not ship it.
    const gsapSource = input.gsapPath ?? path.join(hyperframesRoot, 'node_modules', 'gsap', 'dist', 'gsap.min.js')
    if (fs.existsSync(gsapSource)) {
      const gsapTarget = path.join(projectDir, 'assets', 'gsap.min.js')
      fs.mkdirSync(path.dirname(gsapTarget), { recursive: true })
      if (!fs.existsSync(gsapTarget)) {
        try {
          fs.linkSync(gsapSource, gsapTarget)
        } catch {
          fs.copyFileSync(gsapSource, gsapTarget)
        }
      }
    }
    writeFileAtomic(
      path.join(projectDir, 'hyperframes.json'),
      JSON.stringify({ paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' } }, null, 2),
    )
    writeFileAtomic(path.join(projectDir, 'meta.json'), JSON.stringify({ id: plan.planId, name: plan.planId }, null, 2))
    writeFileAtomic(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: plan.planId, private: true, type: 'module' }, null, 2),
    )
    return { projectDir, html }
  }

  const runCli = (projectDir, args) => {
    const startedAt = clock.iso()
    const startMs = Date.now()
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: input.timeoutMs ?? 900000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        HYPERFRAMES_BROWSER_PATH: chromePath,
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
      },
    })
    const stdout = String(result.stdout ?? '')
    const stderr = String(result.stderr ?? '')
    return {
      startedAt,
      endedAt: clock.iso(),
      durationMs: Date.now() - startMs,
      exitCode: result.status,
      command: { binary: process.execPath, args: [cliPath, ...args], cwd: projectDir },
      stdoutTail: stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-14).join('\n'),
      stderrTail: stderr.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-14).join('\n'),
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
      problems.push({ code: 'runtime-missing', detail: `HyperFrames CLI 不在 ${cliPath}` })
    }
    if (!fs.existsSync(chromePath)) {
      problems.push({ code: 'browser-missing', detail: `系统 Chrome 不存在：${chromePath}` })
    }
    return { ok: problems.length === 0, problems, capabilities: caps }
  }

  const render = (plan, request) => {
    const validated = validatePlanImpl(plan)
    if (!validated.ok) {
      throw new ValidationError('计划未通过 HyperFrames 适配器校验', { details: { problems: validated.problems } })
    }
    const { projectDir } = prepare(plan)
    const outputPath = path.resolve(request.outputPath)
    if (fs.existsSync(outputPath) && request.allowOverwrite !== true) {
      throw new ConflictError('输出已存在；不覆盖旧结果', { outputPath })
    }
    const fps = plan.timebase.fpsNumerator / plan.timebase.fpsDenominator
    const run = runCli(projectDir, [
      'render',
      projectDir,
      '--output',
      outputPath,
      '--format',
      'mp4',
      '--fps',
      String(fps),
      '--quality',
      request.tier === 'preview' ? 'draft' : 'looks',
      '--no-best-effort',
      '--workers',
      '1',
    ])
    if (run.attemptedDownload) {
      throw new ExternalError('HyperFrames 尝试下载浏览器，按授权边界已中止', {
        code: 'DOWNLOAD_ATTEMPTED',
        details: { stdoutTail: run.stdoutTail, stderrTail: run.stderrTail },
      })
    }
    if (run.exitCode !== 0 || !fs.existsSync(outputPath)) {
      throw new ExternalError('HyperFrames 渲染失败', {
        code: 'RENDER_FAILED',
        details: { exitCode: run.exitCode, stderrTail: run.stderrTail, stdoutTail: run.stdoutTail },
      })
    }
    const probed = probeMedia(input.ffprobePath, outputPath)
    const comparison = compareDeclaredToProbed(plan.outputSpec, probed)
    return {
      runtimeId: 'hyperframes',
      runtimeVersion,
      adapterId: 'hyperframes-adapter',
      tier: request.tier,
      file: outputPath,
      bytes: fs.statSync(outputPath).size,
      sha256: sha256File(outputPath),
      planId: plan.planId,
      planVersion: plan.planVersion,
      planFingerprint: planFingerprint(plan),
      declaredSpec: plan.outputSpec,
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
      },
      command: run.command,
      externalEngineering: { projectDir, entry: 'index.html', browser: chromePath },
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
    id: 'hyperframes-adapter',
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
    readProgress: () => ({ supported: false, note: 'CLI 不提供逐帧进度；不伪造进度' }),
    pause: () => ({ supported: false, note: '不支持进程内暂停' }),
    cancel: () => ({ supported: false, note: '取消以结束进程为准' }),
    resumeFromSavedWork: () => ({ supported: false, note: '不支持原帧续渲' }),
    probeResult: (resultRef) => probeMedia(input.ffprobePath, typeof resultRef === 'string' ? resultRef : resultRef.file),
    snapshotExternalEngineering: (plan) => ({
      kind: 'hyperframes-project',
      planId: plan.planId,
      planVersion: plan.planVersion,
      generator: 'media/render/hyperframes-adapter.js',
    }),
    describe: () => ({
      adapterId: 'hyperframes-adapter',
      interfaceVersion: ADAPTER_INTERFACE_VERSION,
      runtime: { id: 'hyperframes', version: runtimeVersion },
      capabilities: caps,
      cliPath,
      chromePath,
    }),
    /** Real CLI schema enumeration (CT-14 step 1). */
    describeRuntimeSchema() {
      const help = spawnSync(process.execPath, [cliPath, 'render', '--help'], {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
        env: { ...process.env, HYPERFRAMES_BROWSER_PATH: chromePath },
      })
      const text = `${String(help.stdout ?? '')}\n${String(help.stderr ?? '')}`
      const flags = [...text.matchAll(/--([a-z0-9-]+)/g)].map((match) => match[1])
      return {
        runtime: 'hyperframes',
        version: runtimeVersion,
        entry: cliPath,
        flagsUsed: ['output', 'format', 'fps', 'quality', 'best-effort', 'workers'],
        flagsAvailable: [...new Set(flags)].sort(),
        probedAt: clock.iso(),
      }
    },
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
          return { id: material.id, exists: fs.existsSync(absolute) }
        }),
        readAt: clock.iso(),
      }
    },
  }
  return defineAdapter(adapter)
}
