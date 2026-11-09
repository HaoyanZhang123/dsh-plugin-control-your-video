/**
 * Real-render evidence for C13: a genuine early unit, a genuine repair round and a genuine full cut.
 *
 * C13 does not own the renderer; it owns the making process. This runner therefore uses C12's real
 * FFmpeg adapter and C02's accepted corpus so the unit a reviewer sees is produced by the same code
 * path C12 evidence used, not by a stand-in. It creates a throwaway C10 project, renders into it,
 * probes what came back, and writes an index with file hashes, frame counts and the exact commands'
 * results so the observation step can cite real versions.
 *
 * Usage: node orchestration/dev/render-evidence.mjs --out <dir> [--keep]
 *
 * @module orchestration/dev/render-evidence
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Clock, createTempDir, sha256File } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'
import { createFfmpegAdapter } from '../../media/render/ffmpeg-adapter.js'
import { createRepairOperation } from '../../media/ops/repair.js'
import { createAdaptOperation } from '../../media/ops/adapt.js'
import { resolveToolchain } from '../../media/toolchain.js'
import { probeMedia, frameCountOf } from '../../media/probe.js'
import { checkRenderedResult } from '../../media/render/checks.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = path.resolve(HERE, '../..')
const CORPUS = path.resolve(PRODUCT_ROOT, '..', 'RENDER-LAB', '01-corpus')

/** @param {string} flag @param {string|null} fallback */
function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : fallback
}

/** The CJK font the renderer must use; a missing font is a loud failure, not a silent fallback. */
function fontFile() {
  const windir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
  const file = path.join(windir, 'Fonts', 'msyh.ttc')
  if (!fs.existsSync(file)) throw new Error('缺少中文字体，无法真实渲染')
  return file
}

function main() {
  const out = path.resolve(arg('--out', path.join(PRODUCT_ROOT, 'evidence', 'c13-render')))
  fs.mkdirSync(out, { recursive: true })
  const clock = new Clock({ mode: 'frozen', start: 1_780_000_000_000 })
  const temp = createTempDir({ label: 'c13-render' })
  const projectsRoot = temp.dir('projects')
  const workRoot = temp.dir('work')
  fs.mkdirSync(workRoot, { recursive: true })

  const created = createProject({ projectsRoot, title: 'C13 真实渲染：雨夜等车', clock })
  const paths = new ProjectPaths(projectsRoot, created.project.projectId)
  const toolchain = resolveToolchain({ allowPathLookup: true })
  const adapter = createFfmpegAdapter({ toolchain, workRoot, clock, materialRoot: CORPUS })

  const rawPlan = buildC12UnitPlan({ fontFile: fontFile() })
  const plan = normalizePlan(rawPlan)
  const createdAt = clock.iso()

  /** Render, copy into the project, probe and record. @param {any} target @param {string} name */
  const renderInto = (target, name) => {
    const staged = path.join(workRoot, `${name}.mp4`)
    const result = adapter.renderFinal(target, target.outputSpec, { outputPath: staged })
    const destination = paths.resolve(`media/${name}.mp4`)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(result.file, destination)
    const probed = probeMedia(toolchain.ffprobe.path, destination)
    const checks = checkRenderedResult({ adapter, plan: target, result: { ...result, file: destination } })
    return {
      name,
      file: `media/${name}.mp4`,
      absolute: destination,
      sha256: sha256File(destination),
      bytes: fs.statSync(destination).size,
      width: probed.video.width,
      height: probed.video.height,
      pixelFormat: probed.video.pixelFormat,
      frames: frameCountOf(probed),
      durationSeconds: probed.format.durationSeconds,
      fps: `${probed.video.fpsNumerator ?? ''}/${probed.video.fpsDenominator ?? ''}`,
      audio: { sampleRate: probed.audio?.sampleRate ?? null, channels: probed.audio?.channels ?? null },
      specComparisonOk: result.specComparison?.ok ?? null,
      checksOk: checks.ok ?? null,
      execution: { cache: result.execution?.cache ?? null, command: result.execution?.command ?? null },
      renderedAt: clock.iso(),
    }
  }

  // 1) The early unit: the accepted C02 structure rendered by the formal adapter.
  const unitRender = renderInto(plan, 'unit-001-master')

  // 2) The repair round: replace one subtitle line, render again, compare audio identity.
  const { operation, plan: repairedPlan } = createRepairOperation({
    basePlan: plan,
    intent: {
      kind: 'replace-text',
      objectId: 'obj-subtitle-S02',
      text: '程序视觉、已有素材与用户音频，在同一条时间线上协作。（修订）',
    },
  })
  const repairRender = renderInto(repairedPlan, 'unit-001-repair-002')

  // 3) The complete initial cut: the same content at the delivery spec.
  const {
    plan: deliveryPlan,
    layout,
  }= createAdaptOperation({ basePlan: repairedPlan, target: { width: 1920, height: 1080 } })
  const cutRender = renderInto(deliveryPlan, 'initial-cut-1080p')

  const index = {
    schemaVersion: 1,
    kind: 'c13-render-evidence',
    generatedAt: createdAt,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    projectId: paths.projectId,
    projectTitle: created.project.title,
    toolchain: {
      ffmpeg: { version: toolchain.ffmpeg.version, source: toolchain.ffmpeg.source },
      ffprobe: { version: toolchain.ffprobe.version },
    },
    corpusRoot: 'RENDER-LAB/01-corpus',
    plan: {
      planId: plan.planId,
      planVersion: plan.planVersion,
      totalFrames: plan.timebase.totalFrames,
      fps: `${plan.timebase.fpsNumerator}/${plan.timebase.fpsDenominator}`,
      scenes: plan.scenes.map((scene) => ({
        id: scene.id,
        start: scene.timeline.startFrame,
        end: scene.timeline.endFrameExclusive,
      })),
      outputSpec: {
        width: plan.outputSpec.width,
        height: plan.outputSpec.height,
        pixelFormat: plan.outputSpec.pixelFormat,
      },
    },
    deliveryPlan: {
      planVersion: deliveryPlan.planVersion,
      outputSpec: { width: deliveryPlan.outputSpec.width, height: deliveryPlan.outputSpec.height },
      layout,
    },
    repair: {
      operationId: operation.operationId ?? null,
      intent: operation.intent ?? null,
      changedObjectIds: operation.diff?.changedObjectIds ?? [],
      verdict: operation.verdict ?? null,
    },
    renders: { unit: unitRender, repair: repairRender, cut: cutRender },
    limits: [
      '画面内容是 C02 已验收单元的结构，经 C12 FFmpeg 适配器真实编码；不是新的生成式画面',
      '9 秒、270 帧、30fps；完整初版是同一内容在 1920×1080 交付规格的真实渲染',
    ],
  }

  fs.writeFileSync(path.join(out, 'render-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')

  // Copy the unit and the cut next to the index so a later observation step has real files to read.
  for (const render of [unitRender, repairRender, cutRender]) {
    fs.copyFileSync(render.absolute, path.join(out, path.basename(render.absolute)))
  }
  const projectCopy = path.join(out, 'project')
  fs.rmSync(projectCopy, { recursive: true, force: true })
  fs.cpSync(paths.dir, projectCopy, { recursive: true })

  process.stdout.write(`rendered unit: ${unitRender.frames} frames, ${unitRender.durationSeconds}s, ${unitRender.width}x${unitRender.height}\n`)
  process.stdout.write(`repaired    : ${repairRender.frames} frames, audio ${repairRender.audio.channels}ch\n`)
  process.stdout.write(`initial cut : ${cutRender.frames} frames, ${cutRender.width}x${cutRender.height}\n`)
  process.stdout.write(`index: ${path.join(out, 'render-index.json')}\n`)

  if (!process.argv.includes('--keep')) temp.dispose()
}

main()
