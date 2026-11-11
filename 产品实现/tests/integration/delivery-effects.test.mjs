/**
 * Integration tests for the pure effect library and its empty-project reproduction gate.
 *
 * A visual effect is really re-rendered from its own package source; a sound effect is really probed
 * from its own audio input; a broken package is NOT adopted and keeps its reason. The update and
 * reference rules are checked so an old project cannot be silently pointed at a new version.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createProject } from '../../core/project/index.js'
import {
  createEffectLibrary,
  planCleanupScope,
} from '../../delivery/index.js'
import { createClosureStore } from '../../delivery/closure.js'
import { buildDeliveryUnitPlan } from '../../delivery/fixtures/unit.js'
import { availableFont, availableToolchain, fixedClock, makeWorkspace } from '../delivery-test-helpers.mjs'

/** Build a 16-bit mono PCM WAV sine tone so the sound kind has a real input. */
function buildWav({ seconds = 1, sampleRate = 48000, frequency = 440 } = {}) {
  const samples = Math.round(seconds * sampleRate)
  const dataBytes = samples * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 12000), 44 + index * 2)
  }
  return buffer
}

/**
 * A library plus one source project.
 * @param {import('node:test').TestContext} t
 */
function setup(t) {
  const root = makeWorkspace(t, 'effects')
  const clock = fixedClock()
  const project = createProject({ projectsRoot: path.join(root, 'projects'), title: '效果来源', clock })
  const library = createEffectLibrary({ effectsRoot: path.join(root, 'effects'), clock })
  return { root, clock, project, library }
}

test('visual effect: record a candidate, reproduce it in an empty project, only then adopt', (t) => {
  const toolchain = availableToolchain()
  const fontFile = availableFont()
  if (toolchain === null || fontFile === null) {
    t.skip('本机没有可用的 FFmpeg/字体，视觉效果复现测试跳过')
    return
  }
  const { root, clock, project, library } = setup(t)
  const plan = buildDeliveryUnitPlan({ fontFile, projectId: project.project.projectId, width: 320, height: 180 })
  const candidate = library.addCandidate({
    projectId: project.project.projectId,
    name: 'Program pattern 320',
    kind: 'visual',
    version: '1.0.0',
    sourcePlan: plan,
    params: { seed: 20261110 },
    output: { width: 320, height: 180, frames: 90, durationSeconds: 3 },
    rights: { declaration: 'self-authored' },
  })
  assert.equal(candidate.state, 'candidate')
  assert.equal(fs.existsSync(path.join(library.root, ...candidate.packageDir.split('/'), 'source', 'plan.json')), true)
  assert.equal(fs.existsSync(path.join(library.root, ...candidate.packageDir.split('/'), 'effect.json')), true)

  assert.throws(
    () => library.reference({ effectId: candidate.effectId, projectId: 'prj_other' }),
    /正式收录/,
  )

  const emptyDir = path.join(root, 'empty-project')
  const reproduced = library.reproduce({ effectId: candidate.effectId, emptyProjectDir: emptyDir, toolchain })
  assert.equal(reproduced.state, 'adopted')
  assert.equal(reproduced.reproduction.ok, true)
  const attempt = reproduced.reproduction.attempts.at(-1)
  assert.equal(attempt.checks.every((check) => check.status !== 'failed'), true)
  assert.equal(attempt.observed.width, 320)
  assert.equal(attempt.observed.height, 180)
  assert.equal(attempt.observed.nbFrames, 90)
  assert.equal(attempt.toolchain.ffmpeg.version, toolchain.ffmpeg.version)
  assert.equal(fs.existsSync(path.join(emptyDir, 'effect-output.mp4')), true, '空项目里真的产生了效果文件')

  const reference = library.reference({ effectId: candidate.effectId, version: '1.0.0', projectId: 'prj_other' })
  assert.equal(reference.version, '1.0.0')
  assert.equal(library.listReferences({ effectId: candidate.effectId }).length, 1)
})

test('sound effect: probed from its own audio input, with listening recorded as not-checked', (t) => {
  const toolchain = availableToolchain()
  if (toolchain === null) {
    t.skip('本机没有可用的 FFprobe，声音效果复现测试跳过')
    return
  }
  const { root, clock, project, library } = setup(t)
  const wavPath = path.join(root, 'tone.wav')
  fs.writeFileSync(wavPath, buildWav({ seconds: 1 }))
  const candidate = library.addCandidate({
    projectId: project.project.projectId,
    name: 'Tone 440',
    kind: 'sound',
    version: '1.0.0',
    inputs: [{ name: 'tone.wav', sourcePath: wavPath }],
    params: { frequency: 440 },
    output: { sampleRate: 48000, channels: 1, durationSeconds: 1 },
    rights: { declaration: 'self-authored' },
  })
  const reproduced = library.reproduce({ effectId: candidate.effectId, emptyProjectDir: path.join(root, 'empty-sound'), toolchain })
  assert.equal(reproduced.state, 'adopted')
  const checks = reproduced.reproduction.attempts.at(-1).checks
  assert.equal(checks.find((check) => check.id === 'audio-stream').status, 'ok')
  assert.equal(checks.find((check) => check.id === 'audio-spec').status, 'ok')
  assert.equal(checks.find((check) => check.id === 'listen').status, 'not-checked')
})

test('a failed reproduction keeps the candidate and the concrete reason; nothing becomes formal', (t) => {
  const toolchain = availableToolchain()
  if (toolchain === null) {
    t.skip('本机没有可用的 FFprobe，复现失败测试跳过')
    return
  }
  const { root, project, library } = setup(t)
  const candidate = library.addCandidate({
    projectId: project.project.projectId,
    name: 'Broken input',
    kind: 'sound',
    version: '0.1.0',
    inputs: [{ name: 'tone.wav', content: 'not a wav file' }],
    params: {},
    output: { durationSeconds: 1 },
    rights: { declaration: 'self-authored' },
  })
  const failed = library.reproduce({ effectId: candidate.effectId, emptyProjectDir: path.join(root, 'empty-bad'), toolchain })
  assert.equal(failed.state, 'reproduce-failed')
  assert.equal(failed.reproduction.ok, false)
  assert.match(failed.reproduction.reason, /检查未通过|失败/)
  assert.equal(library.describe().adopted, 0)
  assert.equal(library.describe().reproduceFailed, 1)
})

test('updating an effect creates a new version while every old reference keeps its version', (t) => {
  const toolchain = availableToolchain()
  if (toolchain === null) {
    t.skip('本机没有可用的 FFprobe，效果更新测试跳过')
    return
  }
  const { root, clock, project, library } = setup(t)
  const wavPath = path.join(root, 'tone.wav')
  fs.writeFileSync(wavPath, buildWav({ seconds: 1 }))
  const candidate = library.addCandidate({
    projectId: project.project.projectId,
    name: 'Tone 440',
    kind: 'sound',
    version: '1.0.0',
    inputs: [{ name: 'tone.wav', sourcePath: wavPath }],
    params: { frequency: 440 },
    output: { sampleRate: 48000, channels: 1, durationSeconds: 1 },
    rights: { declaration: 'self-authored' },
  })
  library.reproduce({ effectId: candidate.effectId, emptyProjectDir: path.join(root, 'empty-1'), toolchain })
  const other = createProject({ projectsRoot: path.join(root, 'projects'), title: '引用项目', clock })
  library.reference({ effectId: candidate.effectId, version: '1.0.0', projectId: other.project.projectId })

  const updated = library.update({ effectId: candidate.effectId, version: '1.1.0', params: { frequency: 880 } })
  assert.equal(updated.effect.version, '1.1.0')
  assert.equal(updated.effect.state, 'candidate', '新版本必须重新复现')
  assert.equal(updated.effect.versions.length, 2)
  assert.deepEqual(updated.referencesKeepingOldVersion, [{ projectId: other.project.projectId, version: '1.0.0' }])
  assert.deepEqual(library.listReferences({ effectId: candidate.effectId }).map((entry) => entry.version), ['1.0.0'])
  assert.equal(
    fs.existsSync(path.join(library.root, ...candidate.packageDir.split('/'), 'effect.json')),
    true,
    '旧版本包文件必须保留',
  )
  assert.throws(() => library.withdraw({ effectId: candidate.effectId }), /仍被项目引用/)
  assert.throws(
    () => library.reference({ effectId: candidate.effectId, version: '1.1.0', projectId: other.project.projectId }),
    /正式收录/,
  )
  void clock
})

test('project cleanup never reaches the effect library, and its scope lists shared references', (t) => {
  const toolchain = availableToolchain()
  if (toolchain === null) {
    t.skip('本机没有可用的 FFprobe，清理保护测试跳过')
    return
  }
  const { root, clock, project, library } = setup(t)
  const wavPath = path.join(root, 'tone.wav')
  fs.writeFileSync(wavPath, buildWav({ seconds: 1 }))
  const candidate = library.addCandidate({
    projectId: project.project.projectId,
    name: 'Tone 440',
    kind: 'sound',
    version: '1.0.0',
    inputs: [{ name: 'tone.wav', sourcePath: wavPath }],
    params: { frequency: 440 },
    output: { sampleRate: 48000, channels: 1, durationSeconds: 1 },
    rights: { declaration: 'self-authored' },
  })
  library.reproduce({ effectId: candidate.effectId, emptyProjectDir: path.join(root, 'empty'), toolchain })
  library.reference({ effectId: candidate.effectId, version: '1.0.0', projectId: project.project.projectId })
  fs.mkdirSync(path.join(project.paths.dir, 'work', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(project.paths.dir, 'work', 'nested', 'scratch.bin'), 'x')
  const scope = planCleanupScope({
    paths: project.paths,
    versions: { listCandidates: () => [] },
    clock,
    effectReferences: library.listReferences({ projectId: project.project.projectId }),
  })
  assert.equal(scope.remove.some((entry) => entry.path.includes('effects')), false, '清理范围里不能出现效果库')
  assert.equal(scope.sharedReferences.length, 1)
  assert.equal(scope.sharedReferences[0].effectId, candidate.effectId)
  const store = createClosureStore({ paths: project.paths, clock })
  assert.equal(typeof store.executeCleanup, 'function')
  // The effect package files live outside the project directory, so deleting project work cannot remove them.
  const packageJson = path.join(library.root, ...candidate.packageDir.split('/'), 'effect.json')
  fs.rmSync(path.join(project.paths.dir, 'work'), { recursive: true, force: true })
  assert.equal(fs.existsSync(packageJson), true)
})
