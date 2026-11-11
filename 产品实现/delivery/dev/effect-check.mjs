#!/usr/bin/env node
/**
 * C15 self-check for the pure effect library: candidate → empty-project reproduction → adoption →
 * cross-project reference → update protection → project cleanup protection.
 *
 * It also exercises the sound kind with a generated PCM WAV: no external asset is needed, and the
 * "no listening channel" limit is recorded as `not-checked` instead of being implied as heard.
 *
 * Usage: node delivery/dev/effect-check.mjs [--keep]
 *
 * @module delivery/dev/effect-check
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Clock } from '../../base/index.js'
import { createProject } from '../../core/project/index.js'
import { resolveToolchain } from '../../media/index.js'
import { createEffectLibrary, EffectState, planCleanupScope, createClosureStore } from '../index.js'
import { buildDeliveryUnitPlan } from '../fixtures/unit.js'

const FONT = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', 'arial.ttf')

/** Build a 16-bit mono PCM WAV of a sine tone, so the sound kind has a real input file. */
function buildWav({ seconds = 1, sampleRate = 48000, frequency = 440 } = {}) {
  const samples = Math.round(seconds * sampleRate)
  const bytes = samples * 2
  const buffer = Buffer.alloc(44 + bytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + bytes, 4)
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
  buffer.writeUInt32LE(bytes, 40)
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 12000)
    buffer.writeInt16LE(value, 44 + index * 2)
  }
  return buffer
}

async function main() {
  const keep = process.argv.includes('--keep')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c15-effects-'))
  const clock = new Clock({ now: () => Date.parse('2026-11-10T00:00:00.000Z') })
  process.stdout.write(`workspace: ${root}\n`)
  const toolchain = resolveToolchain({ allowPathLookup: true })
  const effectsRoot = path.join(root, 'effects')
  const library = createEffectLibrary({ effectsRoot, clock })

  const project = createProject({ projectsRoot: path.join(root, 'projects'), title: '效果来源项目', clock })
  const paths = project.paths

  // ---- visual effect: candidate, then real empty-project reproduction ----
  const plan = buildDeliveryUnitPlan({ fontFile: FONT, projectId: paths.projectId, width: 640, height: 360 })
  const visual = library.addCandidate({
    projectId: paths.projectId,
    name: 'Program pattern title',
    kind: 'visual',
    version: '1.0.0',
    sourcePlan: plan,
    params: { seed: 20261110, fontSize: 28 },
    output: { width: 640, height: 360, frames: 90, durationSeconds: 3, fps: '30/1' },
    fonts: [{ family: 'Arial', file: 'external', note: '字体是外部依赖' }],
    tools: [{ toolId: 'ffmpeg', version: toolchain.ffmpeg.version, build: toolchain.ffmpeg.build }],
    rights: { declaration: 'self-authored', note: 'C15 自建夹具，权利可追踪' },
  })
  process.stdout.write(`visual candidate: ${visual.effectId} ${visual.state}\n`)
  const emptyVisual = path.join(root, 'empty-visual')
  const reproduced = library.reproduce({ effectId: visual.effectId, emptyProjectDir: emptyVisual, toolchain })
  process.stdout.write(`visual reproduced: ${reproduced.state}\n`)
  for (const check of reproduced.reproduction?.attempts?.at(-1)?.checks ?? []) {
    process.stdout.write(`  ${String(check.status).padEnd(12)} ${check.id}: ${check.detail}\n`)
  }

  // ---- sound effect: generated WAV input, probed on reproduction ----
  const wavPath = path.join(root, 'tone-440.wav')
  fs.writeFileSync(wavPath, buildWav({ seconds: 1 }))
  const sound = library.addCandidate({
    projectId: paths.projectId,
    name: 'Tone 440',
    kind: 'sound',
    version: '1.0.0',
    inputs: [{ name: 'tone-440.wav', sourcePath: wavPath }],
    params: { frequency: 440 },
    output: { sampleRate: 48000, channels: 1, durationSeconds: 1 },
    rights: { declaration: 'self-authored' },
  })
  const emptySound = path.join(root, 'empty-sound')
  const soundReproduced = library.reproduce({ effectId: sound.effectId, emptyProjectDir: emptySound, toolchain })
  process.stdout.write(`sound reproduced: ${soundReproduced.state}\n`)
  for (const check of soundReproduced.reproduction?.attempts?.at(-1)?.checks ?? []) {
    process.stdout.write(`  ${String(check.status).padEnd(12)} ${check.id}: ${check.detail}\n`)
  }

  // ---- a failed reproduction keeps the candidate and the reason ----
  const bad = library.addCandidate({
    projectId: paths.projectId,
    name: 'Broken input',
    kind: 'sound',
    version: '0.1.0',
    inputs: [{ name: 'tone.wav', content: 'not wav bytes' }],
    params: {},
    output: { durationSeconds: 1 },
    rights: { declaration: 'self-authored' },
  })
  const failed = library.reproduce({ effectId: bad.effectId, emptyProjectDir: path.join(root, 'empty-bad'), toolchain })
  process.stdout.write(`failed candidate state: ${failed.state} reason: ${failed.reproduction?.reason}\n`)

  // ---- cross-project reference and update protection ----
  const other = createProject({ projectsRoot: path.join(root, 'projects'), title: '使用效果的项目', clock })
  const reference = library.reference({ effectId: visual.effectId, version: '1.0.0', projectId: other.project.projectId })
  process.stdout.write(`reference: ${reference.refId}\n`)
  const updated = library.update({
    effectId: visual.effectId,
    version: '1.1.0',
    params: { seed: 7 },
  })
  process.stdout.write(`update: ${updated.effect.state} current ${updated.effect.version}; old refs keep ${JSON.stringify(updated.referencesKeepingOldVersion)}\n`)
  const stillOld = library.listReferences({ effectId: visual.effectId })
  process.stdout.write(`references: ${JSON.stringify(stillOld.map((entry) => entry.version))}\n`)
  let withdrawError = null
  try {
    library.withdraw({ effectId: visual.effectId, reason: '自检：应被引用保护拒绝' })
  } catch (error) {
    withdrawError = String(error?.message ?? error)
  }
  process.stdout.write(`withdraw while referenced: ${withdrawError}\n`)
  process.stdout.write(`library: ${JSON.stringify(library.describe())}\n`)

  // ---- project cleanup must not touch the effect library ----
  const references = library.listReferences({ projectId: paths.projectId })
  const scope = planCleanupScope({ paths, versions: null, clock, effectReferences: references })
  process.stdout.write(`source project scope: ${JSON.stringify(scope.remove.map((entry) => entry.path))}\n`)
  void createClosureStore
  void EffectState

  if (!keep) {
    fs.rmSync(root, { recursive: true, force: true })
    process.stdout.write('workspace removed\n')
  } else {
    process.stdout.write(`workspace kept: ${root}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`)
  process.exit(1)
})
