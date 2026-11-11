#!/usr/bin/env node
/**
 * Re-probe the files that the evidence run left on disk, with the system FFprobe.
 *
 * Why a separate script: the manifest's probe facts were produced by the adapter during export, and
 * "the exporter says it probed it" is not the same as "the bytes on disk still probe the same way
 * today". This script opens each kept file with the `ffprobe` binary, compares the result against
 * the manifest, and writes `ffprobe-verify.json` next to the runs so 总控 can read both.
 *
 * Usage: node delivery/dev/probe-export.mjs [--dir <export dir>]
 *
 * @module delivery/dev/probe-export
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_EXPORT_DIR = path.resolve(HERE, '..', '..', '..', '实施交接', '证据', 'C15-证据', 'export')

/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

/** Resolve ffprobe from PATH, reporting the exact binary that ran. */
function resolveFfprobe() {
  const candidates = ['ffprobe.exe', 'ffprobe']
  for (const name of candidates) {
    const result = spawnSync(name, ['-version'], { encoding: 'utf8', windowsHide: true })
    if (result.status === 0) return { path: name, banner: String(result.stdout).split(/\r?\n/)[0] }
  }
  return null
}

/**
 * Read one media file with ffprobe and return the facts this evidence cares about.
 * @param {string} binary
 * @param {string} file
 */
function probe(binary, file) {
  const result = spawnSync(binary, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  })
  if (result.status !== 0) {
    return { ok: false, status: result.status, stderr: String(result.stderr ?? '').slice(-400) }
  }
  const parsed = JSON.parse(String(result.stdout))
  const video = (parsed.streams ?? []).find((stream) => stream.codec_type === 'video') ?? null
  const audio = (parsed.streams ?? []).find((stream) => stream.codec_type === 'audio') ?? null
  return {
    ok: true,
    status: result.status,
    facts: {
      width: video?.width ?? null,
      height: video?.height ?? null,
      codec: video?.codec_name ?? null,
      pixelFormat: video?.pix_fmt ?? null,
      nbFrames: Number(video?.nb_frames) > 0 ? Number(video.nb_frames) : null,
      avgFrameRate: video?.avg_frame_rate ?? null,
      durationSeconds: parsed.format?.duration ?? null,
      audioCodec: audio?.codec_name ?? null,
      sizeBytes: Number(parsed.format?.size ?? 0),
    },
  }
}

function main() {
  const exportDir = path.resolve(arg('dir', DEFAULT_EXPORT_DIR))
  const ffprobe = resolveFfprobe()
  if (ffprobe === null) throw new Error('找不到 ffprobe；不能在没有探测的情况下声称复核')
  process.stdout.write(`export dir: ${exportDir}\nffprobe: ${ffprobe.banner}\n`)

  const runs = []
  for (const entry of fs.readdirSync(exportDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('dlv_')) continue
    const manifestPath = path.join(exportDir, entry.name, 'MANIFEST.json')
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const files = []
    for (const fileEntry of manifest.files) {
      if (!fs.existsSync(fileEntry.path)) {
        files.push({
          kind: fileEntry.kind,
          specId: fileEntry.specId,
          path: fileEntry.path,
          present: false,
          error: 'manifest 声明的文件不存在',
        })
        continue
      }
      if (fileEntry.kind === 'subtitles') {
        const text = fs.readFileSync(fileEntry.path, 'utf8')
        const blocks = text.trim().length === 0 ? 0 : text.trim().split(/\n\n+/).length
        files.push({
          kind: fileEntry.kind,
          specId: fileEntry.specId,
          path: fileEntry.path,
          present: true,
          ffprobeApplicable: false,
          bytes: fs.statSync(fileEntry.path).size,
          cues: blocks,
          encoding: 'UTF-8 无 BOM',
          note: 'SRT 是文本交付物；用可读性与字幕段数核对，ffprobe 不适用',
        })
        continue
      }
      const probed = probe(ffprobe.path, fileEntry.path)
      if (!probed.ok) {
        files.push({
          kind: fileEntry.kind,
          specId: fileEntry.specId,
          path: fileEntry.path,
          present: true,
          error: probed.stderr,
        })
        continue
      }
      const declared = fileEntry.ffprobe ?? {}
      const compare = {
        width: probed.facts.width === declared.width,
        height: probed.facts.height === declared.height,
        codec: probed.facts.codec === (declared.codec ?? probed.facts.codec),
        nbFrames:
          declared.nbFrames === null || declared.nbFrames === undefined
            ? true
            : probed.facts.nbFrames === declared.nbFrames,
        durationSeconds:
          declared.durationSeconds === null || declared.durationSeconds === undefined
            ? true
            : Math.abs((probed.facts.durationSeconds ?? 0) - Number(declared.durationSeconds)) <= 0.05,
      }
      files.push({
        kind: fileEntry.kind,
        specId: fileEntry.specId,
        path: fileEntry.path,
        present: true,
        bytes: fs.statSync(fileEntry.path).size,
        sha256: fileEntry.sha256,
        declared: declared,
        probed: probed.facts,
        compare,
        matches: Object.values(compare).every(Boolean),
      })
    }
    runs.push({
      deliveryId: manifest.deliveryId,
      manifestPath,
      generatedAt: manifest.generatedAt,
      package: manifest.package,
      files,
    })
    const allMatch = files.every(
      (file) => file.present === true && (file.matches === true || file.ffprobeApplicable === false),
    )
    process.stdout.write(`${manifest.deliveryId}: ${files.length} files, matches=${allMatch}\n`)
    for (const file of files) {
      if (file.ffprobeApplicable === false) {
        process.stdout.write(`  ${file.kind}/${file.specId} text ok (${file.cues} cues, ${file.bytes}B)\n`)
        continue
      }
      process.stdout.write(
        `  ${file.kind}/${file.specId} ${file.probed?.width ?? '?'}×${file.probed?.height ?? '?'} ` +
          `${file.probed?.codec ?? '?'}/${file.probed?.pixelFormat ?? '?'} ` +
          `${file.probed?.nbFrames ?? '?'}帧 ${file.probed?.durationSeconds ?? '?'}s matches=${file.matches}\n`,
      )
    }
  }

  const report = {
    kind: 'c15-ffprobe-verification',
    generatedAt: new Date().toISOString(),
    ffprobe: { binary: ffprobe.path, banner: ffprobe.banner },
    exportDir,
    runs,
    honest: {
      independentOfExporter: true,
      note: '本文件用系统 ffprobe 重新打开磁盘上的文件，与导出时适配器的探测结果分开记录',
    },
  }
  fs.writeFileSync(path.join(exportDir, 'ffprobe-verify.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`written: ${path.join(exportDir, 'ffprobe-verify.json')}\n`)
  const failed = runs.filter((run) => run.files.some((file) => file.present !== true || file.matches === false))
  if (failed.length > 0) {
    process.stderr.write(`${failed.length} run(s) failed re-probe\n`)
    process.exit(1)
  }
}

main()
