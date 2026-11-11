/**
 * Integration tests for real delivery export: encode, probe, check, report per spec.
 *
 * The render tests skip on a machine without FFmpeg/FFprobe or without a usable font, and say so;
 * they never fall back to a fake "exported" record. The rules tested here are the card's own:
 * only a finalized version can be delivered, a second aspect comes from a real AdaptOperation,
 * re-exporting never overwrites, a failed item does not stop the others and is reported as failed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createProject, createDecisionLog, createVersionStore } from '../../core/project/index.js'
import {
  createDeliveryKit,
  declareCoverSpec,
  declareSpec,
  declareSubtitleSpec,
  declareUnsupportedSpec,
  executeDelivery,
  planDelivery,
} from '../../delivery/index.js'
import { availableFont, availableToolchain, createFinalizedProject, fixedClock, makeWorkspace } from '../delivery-test-helpers.mjs'

/** Execute one planned delivery with the project, kit and clock the test already holds. */
function runDelivery(project, kit, planned, clock) {
  return executeDelivery({
    paths: project.paths,
    store: kit.store,
    exporter: kit.exporter,
    deliveryId: planned.deliveryId,
    finalVersion: project.finalVersion,
    clock,
  })
}

test('delivery is refused without a user-finalized version or without a final plan', (t) => {
  const root = makeWorkspace(t, 'export-gate')
  const clock = fixedClock()
  const created = createProject({ projectsRoot: root, title: '未定稿项目', clock })
  const decisions = createDecisionLog({ paths: created.paths, clock })
  const versions = createVersionStore({ paths: created.paths, clock })
  versions.ensureCurrent({ actor: 'system' })
  const current = versions.getCurrent()
  const confirmation = decisions.recordConfirmation({
    actor: 'user',
    objectId: `movie:${created.project.projectId}`,
    aspect: 'initial-cut',
    scope: 'whole',
    versionId: current.versionId,
    state: 'confirmed',
    humanResponse: '测试：只确认了初版',
  })
  void confirmation
  assert.throws(
    () => planDelivery({ paths: created.paths, versions, finalVersion: current, specs: [declareSpec({ specId: 'master' })] }),
    /定稿版本/,
  )

  // A real final version with no plan reference still cannot be delivered.
  const finalVersion = versions.finalize({ actor: 'user', confirmationRef: confirmation.confirmationId })
  assert.throws(
    () => planDelivery({ paths: created.paths, versions, finalVersion, specs: [declareSpec({ specId: 'master' })] }),
    /没有关联的 CompositionPlan/,
  )
})

test('real export: 16:9 + 9:16 AdaptOperation + cover + subtitles, one report per spec', async (t) => {
  const fontFile = availableFont()
  const toolchain = availableToolchain()
  if (fontFile === null || toolchain === null) {
    t.skip('本机没有可用的 FFmpeg/字体，真实导出测试跳过（不伪造结果）')
    return
  }
  const root = makeWorkspace(t, 'export-real')
  const clock = fixedClock()
  const project = createFinalizedProject({ root, fontFile, clock, title: '真实交付项目' })
  const kit = createDeliveryKit({ paths: project.paths, clock, toolchain })
  const specs = [
    declareSpec({ specId: 'master', label: '主版 16:9' }),
    declareSpec({ specId: 'vertical', label: '第二画幅 9:16', binding: 'adapt-operation', target: { width: 360, height: 640 } }),
    declareCoverSpec({ specId: 'cover', fromSpecId: 'master', frame: 30 }),
    declareSubtitleSpec({}),
    declareUnsupportedSpec({}),
  ]
  const planned = planDelivery({
    paths: project.paths,
    versions: project.versions,
    finalVersion: project.finalVersion,
    specs,
    store: kit.store,
    clock,
  })
  assert.equal(planned.state, 'planned')
  assert.equal(planned.items.length, 5)
  assert.ok(planned.items.every((item) => item.state === 'planned'))

  const executed = executeDelivery({
    paths: project.paths,
    store: kit.store,
    exporter: kit.exporter,
    deliveryId: planned.deliveryId,
    finalVersion: project.finalVersion,
    clock,
  })
  assert.equal(executed.state, 'complete')
  assert.deepEqual(executed.counts, { total: 5, exported: 4, failed: 0, notImplemented: 1 })

  const master = executed.items.find((item) => item.specId === 'master')
  assert.equal(master.state, 'exported')
  assert.equal(master.spec.probed.width, 640)
  assert.equal(master.spec.probed.height, 360)
  assert.equal(master.spec.probed.nbFrames, 90)
  assert.ok(master.file.bytes > 100000, '真实编码文件应有实际大小')
  assert.equal(master.checks.find((check) => check.id === 'spec').status, 'ok')
  assert.equal(master.checks.find((check) => check.id === 'duration').status, 'ok')

  const vertical = executed.items.find((item) => item.specId === 'vertical')
  assert.equal(vertical.state, 'exported')
  assert.equal(vertical.spec.probed.width, 360)
  assert.equal(vertical.spec.probed.height, 640)
  assert.equal(vertical.adaptation.binding === undefined ? true : false, true)
  assert.equal(vertical.adaptation.notAStretch, true)
  assert.equal(vertical.adaptation.uniform, false)
  assert.ok(vertical.adaptation.layout.moves > 0)
  assert.ok(vertical.adaptation.layout.resizes > 0)
  assert.equal(vertical.adaptation.preserved.durationFrames.identical, true)
  assert.equal(vertical.adaptationRef === null, false, '必须留下 AdaptOperation 记录')
  assert.equal(fs.existsSync(project.paths.resolve(vertical.adaptationRef)), true)
  assert.equal(vertical.checks.find((check) => check.id === 'object-level-relayout').status, 'ok')
  assert.equal(vertical.checks.find((check) => check.id === 'pixel-reframe').status, 'not-checked')

  const cover = executed.items.find((item) => item.specId === 'cover')
  assert.equal(cover.state, 'exported')
  assert.equal(cover.spec.width, 640)
  assert.deepEqual(cover.spec.width, master.spec.probed.width)

  const subtitles = executed.items.find((item) => item.specId === 'subtitles')
  assert.equal(subtitles.state, 'exported')
  assert.equal(subtitles.spec.cues, 2)
  const srt = fs.readFileSync(subtitles.file.path, 'utf8')
  assert.match(srt, /00:00:00,200 --> 00:00:01,200/)

  const audio = executed.items.find((item) => item.specId === 'audio')
  assert.equal(audio.state, 'not-implemented')
  assert.match(audio.failure.message, /声音/)

  // The record is bound to the final version and never changes the project version.
  assert.equal(executed.finalVersionId, project.finalVersion.versionId)
  assert.equal(executed.confirmationRef, project.finalVersion.confirmationRef)
  assert.equal(project.versions.getFinal().versionId, project.finalVersion.versionId)
})

test('re-export never silently overwrites: the same delivery run twice keeps the first file', async (t) => {
  const fontFile = availableFont()
  const toolchain = availableToolchain()
  if (fontFile === null || toolchain === null) {
    t.skip('本机没有可用的 FFmpeg/字体，重导出测试跳过')
    return
  }
  const root = makeWorkspace(t, 'export-rename')
  const clock = fixedClock()
  const project = createFinalizedProject({ root, fontFile, clock })
  const kit = createDeliveryKit({ paths: project.paths, clock, toolchain })
  const planned = planDelivery({
    paths: project.paths,
    versions: project.versions,
    finalVersion: project.finalVersion,
    specs: [declareSpec({ specId: 'master' })],
    store: kit.store,
    clock,
  })
  const first = runDelivery(project, kit, planned, clock)
  const firstItem = first.items[0]
  const firstHash = firstItem.file.sha256
  assert.equal(fs.existsSync(firstItem.file.path), true)

  const second = runDelivery(project, kit, planned, clock)
  const secondItem = second.items[0]
  assert.equal(secondItem.state, 'exported')
  assert.notEqual(secondItem.file.path, firstItem.file.path, '重导出必须另存，不能覆盖')
  assert.match(secondItem.file.path, /-2\.mp4$/)
  assert.equal(fs.readFileSync(firstItem.file.path, 'utf8').length > 0, true)
  const { fileSha256 } = await import('../../core/project/index.js')
  assert.equal(fileSha256(firstItem.file.path), firstHash, '旧交付文件保持原样')
})

test('a policy of "refuse" stops the conflicting item before encoding, other items still run', async (t) => {
  const fontFile = availableFont()
  const toolchain = availableToolchain()
  if (fontFile === null || toolchain === null) {
    t.skip('本机没有可用的 FFmpeg/字体，同名拒绝测试跳过')
    return
  }
  const root = makeWorkspace(t, 'export-refuse')
  const clock = fixedClock()
  const project = createFinalizedProject({ root, fontFile, clock })
  const kit = createDeliveryKit({ paths: project.paths, clock, toolchain })
  const specs = [declareSpec({ specId: 'master' }), declareSubtitleSpec({})]
  const planned = planDelivery({
    paths: project.paths,
    versions: project.versions,
    finalVersion: project.finalVersion,
    specs,
    store: kit.store,
    policy: 'refuse',
    clock,
  })
  const plannedMaster = planned.items.find((item) => item.specId === 'master')
  const occupiedPath = plannedMaster.plannedFile
  assert.equal(typeof occupiedPath, 'string', '计划里必须给出真实文件名')
  fs.mkdirSync(path.dirname(occupiedPath), { recursive: true })
  fs.writeFileSync(occupiedPath, 'occupied')
  const executed = runDelivery(project, kit, planned, clock)
  const master = executed.items.find((item) => item.specId === 'master')
  assert.equal(master.state, 'failed')
  assert.equal(master.failure.code, 'NAME_CONFLICT')
  assert.equal(fs.readFileSync(occupiedPath, 'utf8'), 'occupied', '被占用的文件不能被改写')
  const subtitles = executed.items.find((item) => item.specId === 'subtitles')
  assert.equal(subtitles.state, 'exported', '一个规格的同名冲突不能阻止其他规格')
  assert.equal(executed.state, 'partial')
  assert.equal(executed.honest.perSpecReport, true)
})

test('an AdaptOperation failure is recorded as a failed item, not thrown away', async (t) => {
  const fontFile = availableFont()
  const toolchain = availableToolchain()
  if (fontFile === null || toolchain === null) {
    t.skip('本机没有可用的 FFmpeg/字体，适配失败测试跳过')
    return
  }
  const root = makeWorkspace(t, 'export-adapt-fail')
  const clock = fixedClock()
  const project = createFinalizedProject({ root, fontFile, clock })
  const kit = createDeliveryKit({ paths: project.paths, clock, toolchain })
  const planned = planDelivery({
    paths: project.paths,
    versions: project.versions,
    finalVersion: project.finalVersion,
    // The fixture plan is 640×360; asking to "adapt" to the same size is the case AdaptOperation refuses.
    specs: [
      declareSpec({ specId: 'same-size', binding: 'adapt-operation', target: { width: 640, height: 360 } }),
      declareSpec({ specId: 'master' }),
    ],
    store: kit.store,
    clock,
  })
  const executed = runDelivery(project, kit, planned, clock)
  const adapted = executed.items.find((item) => item.specId === 'same-size')
  assert.equal(adapted.state, 'failed')
  assert.equal(adapted.failure.code, 'ADAPT_FAILED')
  assert.match(adapted.failure.message, /画幅相同/)
  assert.equal(executed.items.find((item) => item.specId === 'master').state, 'exported')
  assert.equal(executed.state, 'partial')
})
