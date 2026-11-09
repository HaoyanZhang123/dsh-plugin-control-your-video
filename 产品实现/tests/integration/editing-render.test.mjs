/**
 * Integration: a real FFmpeg render of the original and the edited plan, with region-level
 * protection and audio identity checks.
 *
 * This is the test that can fail because the product is wrong, not because a mock disagrees with
 * itself. It skips (with a reason) when FFmpeg or the C02 corpus is absent and never claims a skip
 * passed. It also proves that a real, rendered preview is what the candidate records — not a plan
 * diff presented as a picture.
 *
 * @module tests/integration/editing-render.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createVersionStore } from '../../core/project/versions.js'
import {
  checkRepairProtection,
  checkRenderedResult,
  createFfmpegAdapter,
  extractAudioPcm,
  frameCountOf,
  normalizePlan,
  probeMedia,
  repairRegionPlan,
  resolveToolchain,
} from '../../media/index.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { createEditingKit } from '../../editing/index.js'
import { writePlanSnapshot } from '../../editing/ids.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = path.resolve(HERE, '..', '..')
const CORPUS = path.resolve(PRODUCT_ROOT, '..', 'RENDER-LAB', '01-corpus')
const fontFile = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc')
const videoMaterial = path.join(CORPUS, 'video', 'src-existing-1280x720-30fps-12s.mp4')
const audioMaterial = path.join(CORPUS, 'audio', 'user-audio-continuous-9s-48k-stereo.wav')
let toolchain = null
try {
  toolchain = resolveToolchain({ allowPathLookup: true })
} catch {
  toolchain = null
}
const available =
  toolchain !== null &&
  fs.existsSync(fontFile) &&
  fs.existsSync(videoMaterial) &&
  fs.existsSync(audioMaterial)
const skip = available ? false : '需要 FFmpeg、系统字体与 C02 固定语料；当前环境缺失，如实跳过'

const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 10, 0, 0, 0) })
const temp = createTempDir({ label: 'c14-render' })
test.after(() => temp.dispose())

test('a real subtitle edit changes its region, protects neighbours and keeps the audio bytes', { skip }, () => {
  const projectsRoot = temp.dir('projects')
  const created = createProject({ projectsRoot, title: '真实渲染修改', clock })
  const paths = new ProjectPaths(projectsRoot, created.project.projectId)
  const versions = createVersionStore({ paths, clock })
  const current = versions.ensureCurrent({ actor: 'user' })
  const basePlan = normalizePlan(buildC12UnitPlan({ fontFile }), { now: () => clock.iso() })
  const snapshot = writePlanSnapshot({ paths, ownerId: 'render-base', plan: basePlan, clock })
  versions.updateCurrentContent({ content: { planRef: snapshot.planRef } }, { actor: 'system' })
  const kit = createEditingKit({ paths, clock })
  const workRoot = temp.dir('work')
  const adapter = createFfmpegAdapter({ toolchain, workRoot, clock, materialRoot: CORPUS })

  const baseResult = adapter.renderFinal(basePlan, basePlan.outputSpec, {
    outputPath: path.join(temp.dir('renders'), 'base.mp4'),
  })
  const probedBase = probeMedia(adapter.ffprobePath, baseResult.file)
  assert.equal(frameCountOf(probedBase), 270)
  assert.equal(probedBase.video.width, 1280)
  assert.equal(probedBase.video.height, 720)
  assert.ok(Math.abs(probedBase.format.durationSeconds - 9) < 0.05)

  const session = kit.sessions.beginSession({
    target: '只改 S02 字幕',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: basePlan,
  })
  kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '程序视觉、已有素材与用户音频，在同一条时间线上协作。（修订）' },
  })
  const step = kit.sessions.getSession(session.sessionId).steps[1]
  const editedPlan = kit.sessions.readPlanSnapshotOf(step.planRef).plan
  const editedResult = adapter.renderFinal(editedPlan, editedPlan.outputSpec, {
    outputPath: path.join(temp.dir('renders'), 'edited.mp4'),
  })
  const probedEdited = probeMedia(adapter.ffprobePath, editedResult.file)
  assert.equal(frameCountOf(probedEdited), 270)

  const baseAudio = extractAudioPcm({
    ffmpegPath: adapter.ffmpegPath,
    file: baseResult.file,
    sampleRate: 48000,
    channels: 2,
  })
  const editedAudio = extractAudioPcm({
    ffmpegPath: adapter.ffmpegPath,
    file: editedResult.file,
    sampleRate: 48000,
    channels: 2,
  })
  assert.equal(baseAudio.sha256, editedAudio.sha256, '字幕修改不得改变音轨字节')

  const regions = repairRegionPlan(basePlan, editedPlan, { targetObjectId: 'obj-subtitle-S02', frame: 100 })
  const protection = checkRepairProtection({
    adapter,
    beforePlan: basePlan,
    afterPlan: editedPlan,
    regions: { ...regions, frames: [100, 140] },
    media: { beforeAudioSha256: baseAudio.sha256, afterAudioSha256: editedAudio.sha256 },
  })
  assert.equal(protection.ok, true, JSON.stringify(protection))
  assert.equal(protection.targetChangedEverywhere, true)
  assert.equal(protection.neighboursProtectedEverywhere, true)
  assert.equal(protection.audio.checked, true)
  assert.equal(protection.audio.identical, true)
  assert.equal(protection.note.includes('整片哈希不作为'), true)

  const encoded = checkRenderedResult({ adapter, plan: editedPlan, result: editedResult })
  assert.equal(encoded.ok, true, JSON.stringify(encoded.failed))

  // A real rendered preview is copied into the project and registered against the edited plan.
  const mediaDir = paths.resolve('media')
  fs.mkdirSync(mediaDir, { recursive: true })
  const previewTarget = path.join(mediaDir, 'preview-s02-edited.mp4')
  fs.copyFileSync(editedResult.file, previewTarget)
  kit.sessions.attachPreview({ sessionId: session.sessionId, mediaRef: 'media/preview-s02-edited.mp4' })
  const fresh = kit.sessions.describeSession(session.sessionId)
  assert.equal(fresh.previewState.state, 'fresh')
  assert.equal(fresh.previewState.stale, false)

  // Editing again makes that preview stale; undo restores the previewed draft.
  kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'set-property', objectId: 'obj-subtitle-S02', prop: 'color', value: '#ffd166' },
  })
  const stale = kit.sessions.describeSession(session.sessionId)
  assert.equal(stale.previewState.state, 'stale')
  assert.equal(stale.previewState.stale, true)
  assert.ok(stale.previewState.staleFrames.length > 0)
  kit.sessions.undoEdit({ sessionId: session.sessionId })

  const formed = kit.sessions.formCandidate({ sessionId: session.sessionId })
  assert.equal(formed.comparison.realComparison, true)
  assert.equal(formed.candidate.previewRef, 'media/preview-s02-edited.mp4')
  const accepted = kit.candidates.acceptCandidate({
    candidateId: formed.candidate.candidateId,
    acknowledgeStalePreview: formed.previewStale === true,
  })
  assert.equal(accepted.version.class, 'current')
  const link = kit.candidates.describeCandidate(formed.candidate.candidateId).link
  assert.equal(accepted.version.content.planRef, link.planRef)
  assert.equal(current.versionId !== accepted.version.versionId, true)
})
