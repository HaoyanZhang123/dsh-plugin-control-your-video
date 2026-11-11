#!/usr/bin/env node
/**
 * C15 self-check: prove the real delivery path in an isolated workspace, end to end.
 *
 * What it does, in order, with real files and a real FFmpeg build:
 * 1. create an isolated projects root and a project (C10);
 * 2. normalize the C15 fixture plan and write it as a plan snapshot (C14), then bind it to the
 *    current version (C10);
 * 3. record a USER confirmation and finalize that version (C10 refuses an AI finalize);
 * 4. plan a delivery with 16:9, 9:16 AdaptOperation, cover, subtitles and one declared-gap audio
 *    item, then execute it: every item is rendered/probed/checked separately;
 * 5. KEEP the produced files: they are written into `实施交接/证据/C15-证据/export/<deliveryId>/`
 *    (or the directory passed as `--export-dir`), never into the throwaway workspace, so the
 *    bytes and hashes quoted in the evidence can be re-opened and re-probed by 总控. Re-running
 *    therefore ADDS a new run directory and never deletes an earlier one;
 * 6. export an editable project package into `<export>/packages/`, inspect it, import it into the
 *    isolated root, and open the imported project to prove it is editable;
 * 7. run the closure steps (scope → user confirmation → cleanup) and archive the project.
 *
 * Usage: node delivery/dev/self-check.mjs [--keep] [--export-dir <dir>]
 *
 * @module delivery/dev/self-check
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock } from '../../base/index.js'
import {
  createDecisionLog,
  createProject,
  createVersionStore,
  fileSha256,
  openProject,
  openSession,
} from '../../core/project/index.js'
import { normalizePlan, resolveToolchain } from '../../media/index.js'
import { writePlanSnapshot } from '../../editing/index.js'
import {
  createDeliveryKit,
  declareCoverSpec,
  declareSpec,
  declareSubtitleSpec,
  declareUnsupportedSpec,
  evaluateClosure,
  executeDelivery,
  exportProjectPackage,
  importProjectPackage,
  inspectProjectPackage,
  newDeliveryId,
  planCleanupScope,
  planDelivery,
  publishDeliveryProjection,
} from '../index.js'
import { buildDeliveryUnitPlan } from '../fixtures/unit.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FONT = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', 'arial.ttf')

/** Where the produced files stay, relative to this checkout: the C15 evidence directory. */
const DEFAULT_EXPORT_DIR = path.resolve(HERE, '..', '..', '..', '实施交接', '证据', 'C15-证据', 'export')

/**
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

/** @param {string} label @param {unknown} value */
function show(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
}

/**
 * Build the manifest that lets 总控 re-open and re-probe every produced file.
 *
 * The probe facts come from the SAME adapter that produced the file, so the manifest is evidence
 * about this run, not about "a file that once existed somewhere".
 *
 * @param {{ delivery: any, packageRecord: any, runDir: string, toolchain: any, exporter: any }} input
 * @returns {any}
 */
function buildExportManifest(input) {
  const files = []
  for (const item of input.delivery.items) {
    if (item.state !== 'exported' || item.file === null) continue
    const entry = {
      kind: item.kind,
      specId: item.specId,
      label: item.label,
      path: item.file.path,
      relativePath: path.relative(input.runDir, item.file.path).split(path.sep).join('/'),
      bytes: item.file.bytes,
      sha256: fileSha256(item.file.path),
      checks: (item.checks ?? []).map((check) => ({ id: check.id, status: check.status, detail: check.detail })),
    }
    if (item.kind !== 'subtitles') {
      const probed = input.exporter.adapter.probeResult(item.file.path)
      entry.ffprobe = {
        width: probed.video?.width ?? null,
        height: probed.video?.height ?? null,
        pixelFormat: probed.video?.pixelFormat ?? null,
        codec: probed.video?.codec ?? null,
        avgRate: probed.video?.avgRate ?? null,
        nbFrames: probed.video?.nbFrames ?? null,
        durationSeconds: probed.format?.durationSeconds ?? null,
        audioCodec: probed.audio?.codec ?? null,
      }
    } else {
      entry.ffprobe = null
      entry.text = {
        bytes: item.file.bytes,
        encoding: 'UTF-8',
        note: 'SRT 是文本交付物，ffprobe 不适用；内容检查见 checks',
      }
    }
    files.push(entry)
  }
  const packageManifestPath = path.join(input.packageRecord.packageDir, 'manifest.json')
  const packageFiles = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) {
        packageFiles.push({
          path: absolute,
          relativePath: path.relative(input.packageRecord.packageDir, absolute).split(path.sep).join('/'),
          bytes: fs.statSync(absolute).size,
          sha256: fileSha256(absolute),
        })
      }
    }
  }
  walk(input.packageRecord.packageDir)
  return {
    kind: 'c15-export-manifest',
    generatedAt: new Date().toISOString(),
    deliveryId: input.delivery.deliveryId,
    projectId: input.delivery.projectId,
    finalVersionId: input.delivery.finalVersionId,
    confirmationRef: input.delivery.confirmationRef,
    toolchain: {
      ffmpeg: { version: input.toolchain.ffmpeg.version, build: input.toolchain.ffmpeg.build },
      ffprobe: { version: input.toolchain.ffprobe.version },
    },
    files,
    package: {
      packageId: input.packageRecord.packageId,
      dir: input.packageRecord.packageDir,
      manifestPath: packageManifestPath,
      manifestSha256: fileSha256(packageManifestPath),
      files: packageFiles.length,
      bytes: packageFiles.reduce((sum, entry) => sum + entry.bytes, 0),
      fileList: packageFiles,
    },
    honest: {
      keptOutsideWorkspace: true,
      overwritePolicy: 'rename',
      note: '产物写在证据目录并保留；同名重跑另存新名字，不覆盖旧文件',
    },
  }
}

async function main() {
  const keep = process.argv.includes('--keep')
  const exportDir = path.resolve(arg('export-dir', DEFAULT_EXPORT_DIR))
  fs.mkdirSync(exportDir, { recursive: true })
  process.stdout.write(`export dir: ${exportDir}\n`)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c15-selfcheck-'))
  const clock = new Clock({ now: () => Date.parse('2026-11-10T00:00:00.000Z') })
  process.stdout.write(`workspace: ${root}\n`)
  show('font', fs.existsSync(FONT))

  const toolchain = resolveToolchain({ allowPathLookup: true })
  show('toolchain', { ffmpeg: toolchain.ffmpeg.version, ffprobe: toolchain.ffprobe.version })

  const created = createProject({ projectsRoot: root, title: 'C15 自检项目', origin: 'blank', clock })
  const paths = created.paths
  const decisions = createDecisionLog({ paths, clock })
  const versions = createVersionStore({ paths, clock })

  const plan = normalizePlan(buildDeliveryUnitPlan({ fontFile: FONT, projectId: created.project.projectId }), {
    now: () => clock.iso(),
  })
  const snapshot = writePlanSnapshot({ paths, ownerId: 'c15-selfcheck', plan, clock })
  versions.ensureCurrent({ actor: 'system', label: '自检当前版本' })
  versions.updateCurrentContent({ content: { planRef: snapshot.planRef, planVersion: plan.planVersion } })

  const confirmation = decisions.recordConfirmation({
    actor: 'user',
    objectId: `movie:${created.project.projectId}`,
    aspect: 'final-cut',
    scope: 'whole',
    versionId: versions.getCurrent().versionId,
    state: 'confirmed',
    humanResponse: '自检里模拟用户“可以定稿”的回答；真实使用时这句话必须来自用户本人',
  })
  const finalVersion = versions.finalize({ actor: 'user', confirmationRef: confirmation.confirmationId, label: '自检定稿' })
  show('finalVersion', { versionId: finalVersion.versionId, immutable: finalVersion.immutable })

  const kit = createDeliveryKit({ paths, clock, toolchain, effectsRoot: path.join(root, 'effects') })
  show('kit', { exporter: kit.exporter !== null, effects: kit.effects !== null })

  const specs = [
    declareSpec({ specId: 'master', label: '成片 640×360', preset: 'master-16x9' }),
    declareSpec({ specId: 'vertical', label: '第二画幅 360×640', binding: 'adapt-operation', target: { width: 360, height: 640 } }),
    declareCoverSpec({ specId: 'cover', fromSpecId: 'master', frame: 30 }),
    declareSubtitleSpec({}),
    declareUnsupportedSpec({}),
  ]
  const deliveryId = newDeliveryId()
  const runDir = path.join(exportDir, deliveryId)
  fs.mkdirSync(runDir, { recursive: true })
  const planned = planDelivery({
    paths,
    versions,
    finalVersion,
    specs,
    store: kit.store,
    deliveryId,
    outputDir: runDir,
    clock,
  })
  show('planned', {
    deliveryId: planned.deliveryId,
    state: planned.state,
    items: planned.items.map((item) => `${item.kind}/${item.specId}:${item.state}`),
  })

  const executed = executeDelivery({
    paths,
    store: kit.store,
    exporter: kit.exporter,
    deliveryId: planned.deliveryId,
    finalVersion,
    clock,
  })
  show('executed', { state: executed.state, counts: executed.counts })
  for (const item of executed.items) {
    process.stdout.write(
      `  - ${item.kind}/${item.specId}: ${item.state} ${item.file === null ? '' : `${item.file.bytes}B ${String(item.file.sha256).slice(0, 12)}`}` +
        `${item.failure === null ? '' : ` failure=${item.failure.code}`}\n`,
    )
    for (const check of item.checks ?? []) process.stdout.write(`      ${check.status.padEnd(12)} ${check.id}: ${check.detail}\n`)
  }

  const pkg = exportProjectPackage({
    paths,
    finalVersion,
    destinationDir: path.join(exportDir, 'packages'),
    toolchainInfo: {
      version: toolchain.ffmpeg.version,
      build: toolchain.ffmpeg.build,
      source: toolchain.ffmpeg.source,
    },
    clock,
  })
  const inspection = inspectProjectPackage({
    packageDir: pkg.packageDir,
    projectsRoot: root,
    toolchain: { version: toolchain.ffmpeg.version },
    clock,
  })
  show('package inspection', { ok: inspection.ok, verdict: inspection.verdict, problems: inspection.problems })
  const imported = importProjectPackage({
    projectsRoot: root,
    packageDir: pkg.packageDir,
    inspection,
    title: 'C15 自检项目（导入）',
    clock,
  })
  const openedImported = await openSession({ projectsRoot: root, projectId: imported.projectId, clock })
  const importedFinal = openedImported.versions.getFinal()
  show('imported', {
    projectId: imported.projectId,
    editable: imported.editable,
    finalVersionId: importedFinal?.versionId ?? null,
    planReadable: imported.editable.planReadable,
  })

  // ---- keep the produced files and write a manifest that lets 总控 re-open and re-probe them ----
  const manifest = buildExportManifest({
    delivery: executed,
    packageRecord: pkg,
    runDir,
    toolchain,
    exporter: kit.exporter,
  })
  const manifestPath = path.join(runDir, 'MANIFEST.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const indexPath = path.join(exportDir, 'index.json')
  /** @type {any} */
  let index = { kind: 'c15-export-index', runs: [] }
  if (fs.existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      if (Array.isArray(parsed?.runs)) index = parsed
    } catch {
      // A broken index is replaced by a fresh one; the per-run manifests remain the facts.
    }
  }
  index.runs.push({
    deliveryId: executed.deliveryId,
    at: manifest.generatedAt,
    runDir,
    manifestPath,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, entry) => sum + entry.bytes, 0),
    packageId: manifest.package.packageId,
  })
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  process.stdout.write(`export manifest: ${manifestPath}\n`)
  for (const entry of manifest.files) {
    process.stdout.write(
      `KEPT ${entry.kind}/${entry.specId} ${entry.bytes}B sha256=${entry.sha256} ${entry.path}\n`,
    )
    if (entry.ffprobe !== null) {
      process.stdout.write(
        `  ffprobe ${entry.ffprobe.width}×${entry.ffprobe.height} ${entry.ffprobe.codec}/` +
          `${entry.ffprobe.pixelFormat} ${entry.ffprobe.nbFrames}帧 ${entry.ffprobe.durationSeconds}s\n`,
      )
    }
  }
  process.stdout.write(
    `KEPT package ${manifest.package.packageId} ${manifest.package.files} files ` +
      `${manifest.package.bytes}B manifestSha256=${manifest.package.manifestSha256} ${manifest.package.dir}\n`,
  )

  const scope = planCleanupScope({ paths, versions, clock, effectReferences: [] })
  show('cleanup scope', {
    scopeId: scope.scopeId,
    remove: scope.remove.map((entry) => `${entry.kind}:${entry.path} (${entry.bytes}B)`),
    totalBytes: scope.totalBytes,
  })
  kit.closure.open({ finalVersionId: finalVersion.versionId, deliveryId: planned.deliveryId })
  const preClean = evaluateClosure({
    finalVersion,
    plan: snapshot,
    projectFiles: { materials: [], fonts: [{ family: 'Arial' }] },
    delivery: executed,
    verifyItem: (item) => kit.exporter.verifyDeliveredItem(item),
    effects: [],
    effectDecisions: [],
    scope,
    confirmation: null,
    cleanup: null,
  })
  show('ready to clean', preClean.readyToClean)
  kit.closure.setScope(scope, { readyToClean: preClean.readyToClean })
  kit.closure.confirmScope({ decisions, humanResponse: '自检模拟用户“按这个范围清理”的回答' })
  const cleanup = kit.closure.executeCleanup({ decisions })
  show('cleanup', { deleted: cleanup.deleted.length, bytesFreed: cleanup.bytesFreed, failures: cleanup.failures.length })

  const evaluation = evaluateClosure({
    finalVersion,
    plan: snapshot,
    projectFiles: { materials: [], fonts: [{ family: 'Arial' }] },
    delivery: executed,
    verifyItem: (item) => kit.exporter.verifyDeliveredItem(item),
    effects: [],
    effectDecisions: [],
    scope,
    confirmation: kit.closure.active()?.confirmation ?? null,
    cleanup,
  })
  show('closure steps', evaluation.steps.map((step) => `${step.id}:${step.status}`))

  const { projection } = publishDeliveryProjection({
    paths,
    clock,
    finalVersion,
    deliveries: kit.store.list(),
    packages: [],
    closure: kit.closure.active(),
    closureSteps: evaluation,
    effects: kit.effects.snapshot(),
  })
  show('projection', {
    deliveries: projection.deliveries.length,
    items: projection.deliveries[0]?.items?.length ?? 0,
    nextStep: projection.closure?.nextStep,
  })

  const originalNow = openProject({ projectsRoot: root, projectId: paths.projectId, clock })
  const phase = kit.closure.changePhase({
    projectsRoot: root,
    to: 'archived',
    expectedRevision: originalNow.revision,
  })
  void phase
  const archived = await openSession({ projectsRoot: root, projectId: paths.projectId, clock })
  show('archive', archived.project.phase)

  if (!keep) {
    // Only the throwaway PROJECT workspace is removed. The export directory is evidence and is
    // deliberately kept: deleting it would make every quoted byte and hash unverifiable.
    fs.rmSync(root, { recursive: true, force: true })
    process.stdout.write('temp project workspace removed\n')
  } else {
    process.stdout.write(`temp project workspace kept: ${root}\n`)
  }
  process.stdout.write(`export artifacts kept: ${exportDir}\n`)
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`)
  process.exit(1)
})
