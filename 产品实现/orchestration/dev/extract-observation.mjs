/**
 * Extract the frames and regions the making agent will actually look at.
 *
 * This step is deliberately separate from rendering and from looking: it produces DETERMINISTIC
 * derivatives (a frame at a known index, an original-ratio crop of a known box, a contact sheet of
 * known frames) with the exact command recorded, so the observation that follows can cite
 * "file + version + frame + region" instead of "the video looked fine".
 *
 * No image is generated here: every pixel comes from a real rendered file.
 *
 * Usage: node orchestration/dev/extract-observation.mjs --render <dir> [--out <dir>]
 *
 * @module orchestration/dev/extract-observation
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { sha256File } from '../../base/index.js'
import { resolveToolchain } from '../../media/toolchain.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = path.resolve(HERE, '../..')

/** @param {string} flag @param {string|null} fallback */
function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : fallback
}

/** The subtitle S02 box inside the 1280×720 unit (from the CompositionPlan object). */
const SUBTITLE_BOX = Object.freeze({ x: 100, y: 590, width: 1080, height: 76 })

function main() {
  const renderDir = path.resolve(arg('--render', path.join(PRODUCT_ROOT, 'evidence', 'c13-render')))
  const out = path.resolve(arg('--out', path.join(renderDir, 'observation')))
  fs.mkdirSync(out, { recursive: true })
  const toolchain = resolveToolchain({ allowPathLookup: true })
  const ffmpeg = toolchain.ffmpeg.path

  /** @type {any[]} */
  const derivatives = []
  /** @param {object} spec */
  const extract = (spec) => {
    const target = path.join(out, spec.name)
    const filter = spec.filter
    // `-vsync` was removed in FFmpeg 9; one frame is requested instead, so no frame-rate mode is needed.
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(renderDir, spec.source), '-vf', filter, '-frames:v', '1', target]
    execFileSync(ffmpeg, args, { stdio: 'pipe' })
    const bytes = fs.readFileSync(target)
    const entry = {
      name: spec.name,
      source: spec.source,
      derivedFrom: spec.source,
      frame: spec.frame ?? null,
      region: spec.region ?? null,
      view: spec.view,
      filter,
      bytes: bytes.length,
      sha256: sha256File(target),
      width: spec.width ?? null,
      height: spec.height ?? null,
      command: `ffmpeg -i ${spec.source} -vf "${filter}" -frames:v 1 ${spec.name}`,
    }
    // PNG header carries the true pixel size; a filter that silently scaled would show up here.
    if (bytes.length > 24 && bytes.toString('ascii', 1, 4) === 'PNG') {
      entry.width = bytes.readUInt32BE(16)
      entry.height = bytes.readUInt32BE(20)
    }
    derivatives.push(entry)
    return entry
  }

  extract({ name: 'unit-f000-overview.png', source: 'unit-001-master.mp4', frame: 0, view: 'unit/full-frame', filter: "select='eq(n\\,0)'" })
  extract({ name: 'unit-f060.png', source: 'unit-001-master.mp4', frame: 60, view: 'unit/full-frame', filter: "select='eq(n\\,60)'" })
  extract({ name: 'unit-f150.png', source: 'unit-001-master.mp4', frame: 150, view: 'unit/full-frame', filter: "select='eq(n\\,150)'" })
  extract({ name: 'unit-f230.png', source: 'unit-001-master.mp4', frame: 230, view: 'unit/full-frame', filter: "select='eq(n\\,230)'" })
  extract({
    name: 'unit-f150-subtitle-region.png',
    source: 'unit-001-master.mp4',
    frame: 150,
    region: SUBTITLE_BOX,
    view: 'unit/original-ratio-region',
    filter: `select='eq(n\\,150)',crop=${SUBTITLE_BOX.width}:${SUBTITLE_BOX.height}:${SUBTITLE_BOX.x}:${SUBTITLE_BOX.y}`,
  })
  extract({ name: 'repair-f150.png', source: 'unit-001-repair-002.mp4', frame: 150, view: 'repair/full-frame', filter: "select='eq(n\\,150)'" })
  extract({
    name: 'repair-f150-subtitle-region.png',
    source: 'unit-001-repair-002.mp4',
    frame: 150,
    region: SUBTITLE_BOX,
    view: 'repair/original-ratio-region',
    filter: `select='eq(n\\,150)',crop=${SUBTITLE_BOX.width}:${SUBTITLE_BOX.height}:${SUBTITLE_BOX.x}:${SUBTITLE_BOX.y}`,
  })
  extract({ name: 'cut-f150.png', source: 'initial-cut-1080p.mp4', frame: 150, view: 'cut/full-frame-delivery-spec', filter: "select='eq(n\\,150)'" })
  extract({
    name: 'unit-contact-sheet.png',
    source: 'unit-001-master.mp4',
    frame: null,
    view: 'unit/multi-frame-overview',
    filter: "select='eq(n\\,0)+eq(n\\,60)+eq(n\\,120)+eq(n\\,180)+eq(n\\,240)',scale=512:-1,tile=5x1",
  })

  const index = {
    schemaVersion: 1,
    kind: 'c13-observation-inputs',
    generatedAt: new Date().toISOString(),
    renderIndex: path.join(renderDir, 'render-index.json'),
    note: '帧号以 30fps 计；区域取 CompositionPlan 中 obj-subtitle-S02 的 box；全部为真实渲染结果的确定性派生',
    subtitleBox: SUBTITLE_BOX,
    derivatives,
  }
  fs.writeFileSync(path.join(out, 'inputs.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  for (const entry of derivatives) {
    process.stdout.write(`${entry.name.padEnd(32)} ${String(entry.width).padStart(4)}x${String(entry.height).padEnd(4)} ${String(entry.bytes).padStart(7)}B\n`)
  }
  process.stdout.write(`inputs: ${path.join(out, 'inputs.json')}\n`)
}

main()
