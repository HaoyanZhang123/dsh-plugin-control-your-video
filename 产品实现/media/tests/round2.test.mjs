/**
 * Round-2 additions: movie scope, preview freshness, untrusted screening, runtime schema,
 * interruption safety and the two browser-runtime adapters' declared surface.
 * @module media/tests/round2
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildC12UnitPlan } from '../fixtures/c12-unit.js'
import { normalizePlan, diffPlans } from '../plan.js'
import { transitionParticipants, isVisibleAt } from '../timeline.js'
import { editScopeOf } from '../objects.js'
import { describePreviewState } from '../preview.js'
import { screenUntrustedPackage, screenEntryPath } from '../safety.js'
import { createRepairOperation } from '../ops/repair.js'
import { createTaskStore } from '../render/adapter.js'
import { createFfmpegAdapter } from '../render/ffmpeg-adapter.js'
import { createRemotionAdapter } from '../render/remotion-adapter.js'
import { createHyperframesAdapter } from '../render/hyperframes-adapter.js'
import { corpusRoot, corpusFile, frozenClock, makeTempDir, cleanup, tryToolchain } from './helpers.mjs'

const fontFile = () => path.join(process.env.WINDIR ?? process.env.SystemRoot ?? '.', 'Fonts', 'msyh.ttc')
const plan = () => normalizePlan(buildC12UnitPlan({ fontFile: fontFile() }), { now: () => '2026-11-09T00:00:00.000Z' })

const workspaceRoot = process.env.C12_RENDER_WORKSPACE ?? 'E:/DSH/.dsh/tools/ai-video-workbench/render-workspace'
const chromeShell = path.resolve(
  process.env.C12_RENDER_LAB ?? path.join(corpusRoot(), '..'),
  '03-remotion',
  'node_modules',
  '.remotion',
  'chrome-headless-shell',
  'win64',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
)
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

test('CT-04 §2.1: movie objects are not transition participants but stay visible', () => {
  const base = plan()
  const ids = transitionParticipants(base, 'obj-transition-crossfade').participants.map((entry) => entry.id)
  assert.ok(!ids.includes('obj-subtitle-S02'))
  assert.ok(!ids.includes('obj-audio-main'))
  assert.equal(isVisibleAt(base, 'obj-subtitle-S02', 135), true)
})

test('CT-04 §2.1: a movie edit lists the scenes and scene objects it touches', () => {
  const scope = editScopeOf(plan(), 'obj-subtitle-S02')
  assert.equal(scope.scope, 'movie')
  assert.deepEqual(scope.affectedScenes, ['scene-A', 'scene-B'])
  assert.ok(scope.overlappingSceneObjects.length > 0)
})

test('preview freshness names the stale window after a local edit', () => {
  const base = plan()
  const repair = createRepairOperation({
    basePlan: base,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '改过的字幕' },
  })
  const state = describePreviewState({ basePlan: base, currentPlan: repair.plan })
  assert.equal(state.stale, true)
  assert.deepEqual(state.staleFrames, [{ startFrame: 75, endFrameExclusive: 168 }])
  assert.equal(state.staleSeconds, 3.1)
  assert.ok(state.summary.includes('3.10s'))
  const partial = describePreviewState({
    basePlan: base,
    currentPlan: repair.plan,
    coveredRange: { startFrame: 0, endFrameExclusive: 120 },
  })
  assert.deepEqual(partial.staleFrames, [{ startFrame: 75, endFrameExclusive: 120 }])
})

test('a preview of the same version is not stale', () => {
  const base = plan()
  const state = describePreviewState({ basePlan: base, currentPlan: base })
  assert.equal(state.stale, false)
  assert.equal(state.staleFrames.length, 0)
  assert.equal(diffPlans(base, base).identical, true)
})

test('untrusted package screening rejects every hostile shape without touching disk', () => {
  const root = path.join(makeTempDir('c12-untrusted-'), 'root')
  fs.mkdirSync(root, { recursive: true })
  try {
    const result = screenUntrustedPackage({
      root,
      entries: [
        { path: '../escape.txt' },
        { path: 'C:\\Windows\\win.ini' },
        { path: '\\\\server\\share\\x' },
        { path: '/etc/passwd' },
        { path: 'ok/clip.mp4', bytes: 10 },
        { path: 'link', type: 'link' },
        { path: 'nul.txt' },
        { path: 'bomb.bin', bytes: 9_000_000_000 },
      ],
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.accepted, ['ok/clip.mp4'])
    const reasons = result.rejected.map((entry) => entry.reason).sort()
    assert.ok(reasons.includes('parent-traversal'))
    assert.ok(reasons.includes('drive-letter'))
    assert.ok(reasons.includes('unc-path'))
    assert.ok(reasons.includes('absolute-path'))
    assert.ok(reasons.includes('link-entry'))
    assert.ok(reasons.includes('reserved-name'))
    assert.equal(fs.existsSync(path.join(root, 'ok')), false, '筛查不得创建任何目录')
  } finally {
    cleanup(path.dirname(root))
  }
})

test('a clean entry list passes and still reports that nothing was executed', () => {
  const root = makeTempDir('c12-clean-')
  try {
    const result = screenUntrustedPackage({ root, entries: [{ path: 'a/b.mp4', bytes: 100 }] })
    assert.equal(result.ok, true)
    assert.equal(result.executable, false)
  } finally {
    cleanup(root)
  }
})

test('entry path screening is exact about the reasons', () => {
  assert.equal(screenEntryPath('a/../b').reason, 'parent-traversal')
  assert.equal(screenEntryPath('D:/x').reason, 'drive-letter')
  assert.equal(screenEntryPath('a/b.mp4').ok, true)
  assert.equal(screenEntryPath('').reason, 'empty-path')
})

test('the FFmpeg adapter enumerates its real CLI schema and reads pre-change state', {
  skip: tryToolchain() === null,
}, () => {
  const toolchain = tryToolchain()
  const work = makeTempDir('c12-schema-')
  try {
    const adapter = createFfmpegAdapter({ toolchain, workRoot: work, clock: frozenClock(), materialRoot: corpusRoot() })
    const schema = adapter.describeRuntimeSchema()
    assert.equal(schema.runtime, 'ffmpeg')
    assert.ok(schema.flagsAvailable.length > 100)
    assert.ok(schema.flagsUsed.includes('filter_complex'))
    const state = adapter.readPreChangeState(plan())
    assert.equal(state.objectCount, 11)
    assert.equal(state.totalFrames, 270)
    assert.ok(state.materials.every((material) => material.exists))
  } finally {
    cleanup(work)
  }
})

test('the Remotion adapter registers the real CLI and schema when the workspace exists', {
  skip: !fs.existsSync(path.join(workspaceRoot, 'remotion', 'node_modules', '@remotion', 'cli', 'remotion-cli.js')),
}, () => {
  const work = makeTempDir('c12-remotion-')
  try {
    const adapter = createRemotionAdapter({
      workspaceRoot,
      workRoot: work,
      clock: frozenClock(),
      materialRoot: corpusRoot(),
      ffmpegPath: tryToolchain()?.ffmpeg.path ?? 'ffmpeg',
      ffprobePath: tryToolchain()?.ffprobe.path ?? 'ffprobe',
      browserExecutable: chromeShell,
    })
    const schema = adapter.describeRuntimeSchema()
    assert.ok(schema.flagsAvailable.includes('browser-executable'))
    assert.equal(schema.version, '4.0.541')
    const validated = adapter.validatePlan(plan())
    assert.equal(validated.ok, true, JSON.stringify(validated.problems))
  } finally {
    cleanup(work)
  }
})

test('the HyperFrames adapter registers the real CLI and schema when the workspace exists', {
  skip: !fs.existsSync(path.join(workspaceRoot, 'hyperframes', 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')),
}, () => {
  const work = makeTempDir('c12-hyperframes-')
  try {
    const adapter = createHyperframesAdapter({
      workspaceRoot,
      workRoot: work,
      clock: frozenClock(),
      materialRoot: corpusRoot(),
      ffmpegPath: tryToolchain()?.ffmpeg.path ?? 'ffmpeg',
      ffprobePath: tryToolchain()?.ffprobe.path ?? 'ffprobe',
      chromePath: chrome,
    })
    const schema = adapter.describeRuntimeSchema()
    assert.ok(schema.flagsAvailable.includes('quality'))
    assert.equal(schema.version, '0.9.19')
    assert.equal(adapter.validatePlan(plan()).ok, true)
  } finally {
    cleanup(work)
  }
})

test('killing a real render leaves no published file and no auto-retry', {
  skip: tryToolchain() === null || corpusFile('video', 'src-existing-1280x720-30fps-12s.mp4') === null,
}, async () => {
  const toolchain = tryToolchain()
  const work = makeTempDir('c12-interrupt-')
  try {
    const adapter = createFfmpegAdapter({ toolchain, workRoot: work, clock: frozenClock(), materialRoot: corpusRoot() })
    const target = path.join(work, 'publish.mp4')
    const planned = adapter.planRender(plan(), { outputPath: target })
    const tasks = createTaskStore({ workRoot: work, clock: frozenClock() })
    const task = tasks.create({ id: 'kill-test', adapterId: 'ffmpeg-adapter', tier: 'final', planFingerprint: 'x', totalFrames: 270 })
    task.begin()
    const child = spawn(planned.command.binary, planned.command.args, {
      cwd: planned.command.cwd,
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(fs.existsSync(target), false, '中断后不得发布半成品')
    task.markUnknown('进程被杀')
    assert.throws(() => task.resume({}), /用户确认/)
    assert.equal(task.snapshot().state, 'unknown')
  } finally {
    cleanup(work)
  }
})
