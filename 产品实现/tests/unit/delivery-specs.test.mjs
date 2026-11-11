/**
 * Unit tests for the delivery vocabulary and pure derivations.
 *
 * What this layer can prove: value rules, naming/no-overwrite, space-check shape, SRT derivation,
 * closure step statuses from given state, and the cleanup scope's protected paths. It cannot prove
 * encoding, probing or a real import — those live in the integration tests.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EffectState,
  ItemKind,
  SpecBinding,
  StepStatus,
  ClosureStep,
} from '../../delivery/index.js'
import {
  SPEC_PRESETS,
  buildSubtitleDocument,
  checkFreeSpace,
  declareCoverSpec,
  declareSpec,
  declareSubtitleSpec,
  declareUnsupportedSpec,
  defaultFileStem,
  resolveOutputPath,
  srtTimestamp,
} from '../../delivery/specs.js'
import { evaluateClosure } from '../../delivery/closure.js'
import { planCleanupScope } from '../../delivery/closure.js'
import { PROJECT_LAYOUT } from '../../core/project/index.js'
import { buildDeliveryUnitPlan } from '../../delivery/fixtures/unit.js'
import { normalizePlan } from '../../media/index.js'

/** A normalized fixture plan, used where a plan is needed but no render happens. */
function fixturePlan() {
  return normalizePlan(buildDeliveryUnitPlan({ fontFile: path.join('fonts', 'arial.ttf') }), {
    now: () => '2026-11-10T00:00:00.000Z',
  })
}

test('declareSpec requires a real AdaptOperation target for a second aspect', () => {
  const master = declareSpec({ specId: 'master' })
  assert.equal(master.binding, SpecBinding.FINAL_PLAN)
  assert.equal(master.target, null)

  const vertical = declareSpec({
    specId: 'vertical',
    binding: SpecBinding.ADAPT_OPERATION,
    target: { width: 1080, height: 1920 },
  })
  assert.deepEqual(vertical.target, { width: 1080, height: 1920 })

  assert.throws(() => declareSpec({ specId: 'v2', binding: SpecBinding.ADAPT_OPERATION }), /目标/)
  assert.throws(
    () => declareSpec({ specId: 'v3', binding: SpecBinding.ADAPT_OPERATION, target: { width: 1081, height: 1920 } }),
    /偶数/,
  )
  assert.throws(() => declareSpec({ specId: 'v4', target: { width: 100, height: 100 } }), /不应声明目标画幅/)
  assert.throws(() => declareSpec({ specId: 'v5', preset: 'unknown' }), /未知画幅预设/)
  assert.equal(SPEC_PRESETS['vertical-9x16'].height, 1920)
})

test('cover and subtitle specs stay derived from one video and one plan', () => {
  const cover = declareCoverSpec({ specId: 'cover', fromSpecId: 'master', frame: 30 })
  assert.equal(cover.kind, ItemKind.COVER)
  assert.equal(cover.fromSpecId, 'master')
  assert.equal(cover.frame, 30)
  assert.throws(() => declareCoverSpec({ specId: 'cover', fromSpecId: 'master', frame: -1 }), /非负整数/)

  const subtitles = declareSubtitleSpec({})
  assert.equal(subtitles.specId, 'subtitles')
  assert.equal(subtitles.kind, ItemKind.SUBTITLES)

  const audio = declareUnsupportedSpec({})
  assert.equal(audio.kind, ItemKind.AUDIO)
  assert.match(audio.reason, /声音/)
})

test('resolveOutputPath never overwrites: rename and refuse are the only policies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c15-names-'))
  try {
    const first = resolveOutputPath({ dir, stem: 'dlv-spec', extension: '.mp4', policy: 'rename' })
    assert.equal(first.ok, true)
    assert.equal(first.renamed, false)
    fs.writeFileSync(first.file, 'existing')
    const second = resolveOutputPath({ dir, stem: 'dlv-spec', extension: '.mp4', policy: 'rename' })
    assert.equal(second.renamed, true)
    assert.match(path.basename(second.file), /-2\.mp4$/)
    const refused = resolveOutputPath({ dir, stem: 'dlv-spec', extension: '.mp4', policy: 'refuse' })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'NAME_CONFLICT')
    assert.throws(() => resolveOutputPath({ dir, stem: 'x', extension: '.mp4', policy: 'overwrite' }), /未知同名处理策略/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('checkFreeSpace reports its own checked state instead of assuming space is fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c15-space-'))
  try {
    const enough = checkFreeSpace(dir, 1024)
    assert.equal(enough.neededBytes, 1024)
    assert.equal(typeof enough.checked, 'boolean')
    assert.equal(enough.freeBytes === null || typeof enough.freeBytes === 'number', true)
    assert.throws(() => checkFreeSpace(dir, -1), /非负整数/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('subtitle document uses plan frames and keeps the plan text unchanged', () => {
  const plan = fixturePlan()
  const document = buildSubtitleDocument(plan)
  assert.equal(document.cues, 2)
  assert.match(document.content, /1\n00:00:00,200 --> 00:00:01,200\n第一行字幕：交付夹具/)
  assert.match(document.content, /2\n00:00:01,500 --> 00:00:02,500\n第二行字幕：规格与适配/)
  assert.equal(srtTimestamp(0, { fpsNumerator: 30, fpsDenominator: 1 }), '00:00:00,000')
  assert.equal(srtTimestamp(270, { fpsNumerator: 30, fpsDenominator: 1 }), '00:00:09,000')
})

test('file stems are derived ids, not display titles', () => {
  const stem = defaultFileStem({ deliveryId: 'dlv_ABC', specId: 'master', kind: ItemKind.VIDEO })
  assert.equal(stem, 'dlv_ABC-master')
  assert.equal(defaultFileStem({ deliveryId: 'dlv A/../B', specId: 'x' }), 'dlvAB-x')
})

test('closure steps are computed from given state, never assumed', () => {
  const plan = fixturePlan()
  const screenshotFixture = {
    finalVersion: null,
    plan,
    projectFiles: { materials: [], fonts: [] },
    delivery: null,
    effects: [],
    effectDecisions: [],
    scope: null,
    confirmation: null,
    cleanup: null,
  }
  const blocked = evaluateClosure(screenshotFixture)
  const byId = new Map(blocked.steps.map((step) => [step.id, step]))
  assert.equal(byId.get(ClosureStep.FINALIZED).status, StepStatus.BLOCKED)
  assert.equal(byId.get(ClosureStep.DELIVERED).status, StepStatus.BLOCKED)
  assert.equal(byId.get(ClosureStep.SCOPE_CONFIRMED).status, StepStatus.WAITING_USER)
  assert.equal(blocked.readyToClean, false)
  assert.equal(blocked.steps.length, 7)

  const partialDelivery = {
    deliveryId: 'dlv_test',
    state: 'partial',
    items: [
      { itemId: 'a', kind: ItemKind.VIDEO, specId: 'master', state: 'exported', file: { path: 'x' } },
      { itemId: 'b', kind: ItemKind.VIDEO, specId: 'vertical', state: 'failed', failure: { code: 'CHECK_FAILED' } },
      { itemId: 'c', kind: ItemKind.AUDIO, specId: 'audio', state: 'not-implemented' },
    ],
  }
  const partial = evaluateClosure({
    ...screenshotFixture,
    finalVersion: { versionId: 'ver_x', class: 'final', confirmationRef: 'cnf_x' },
    delivery: partialDelivery,
    verifyItem: () => ({ ok: true, reason: null }),
  })
  assert.equal(partial.steps.find((step) => step.id === ClosureStep.DELIVERED).status, StepStatus.BLOCKED)
  assert.equal(partial.counts.pendingEffects, 0)

  const pendingEffects = evaluateClosure({
    ...screenshotFixture,
    finalVersion: { versionId: 'ver_x', class: 'final', confirmationRef: 'cnf_x' },
    effects: [{ effectId: 'efx_a', state: EffectState.REPRODUCE_FAILED, name: 'A' }],
  })
  assert.equal(
    pendingEffects.steps.find((step) => step.id === ClosureStep.EFFECTS_DECIDED).status,
    StepStatus.WAITING_USER,
  )

  const pendingEffectsDecided = evaluateClosure({
    ...screenshotFixture,
    finalVersion: { versionId: 'ver_x', class: 'final', confirmationRef: 'cnf_x' },
    effects: [{ effectId: 'efx_a', state: EffectState.REPRODUCE_FAILED, name: 'A' }],
    effectDecisions: [{ effectId: 'efx_a', decision: 'not-collected' }],
  })
  assert.equal(
    pendingEffectsDecided.steps.find((step) => step.id === ClosureStep.EFFECTS_DECIDED).status,
    StepStatus.PASSED,
  )
})

test('cleanup scope lists only rebuildable work and rejected candidates, and keeps protected paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c15-scope-projects-'))
  try {
    const projectDir = path.join(root, 'prj_test')
    for (const sub of ['work', 'delivery/work', 'versions/candidates/cnd_rejected', 'versions/candidates/cnd_open']) {
      fs.mkdirSync(path.join(projectDir, sub), { recursive: true })
    }
    fs.writeFileSync(path.join(projectDir, 'work', 'scratch.txt'), 'x')
    fs.writeFileSync(path.join(projectDir, 'versions', 'candidates', 'cnd_rejected', 'preview.mp4'), 'yy')
    fs.writeFileSync(path.join(projectDir, 'versions', 'candidates', 'cnd_open', 'diff.json'), '{}')
    const paths = {
      projectId: 'prj_test',
      dir: projectDir,
      resolve(relative) {
        return path.join(projectDir, ...String(relative).split('/'))
      },
    }
    const versions = {
      listCandidates: () => [
        { candidateId: 'cnd_rejected', status: 'rejected' },
        { candidateId: 'cnd_superseded', status: 'superseded' },
        { candidateId: 'cnd_open', status: 'open' },
      ],
    }
    const scope = planCleanupScope({ paths, versions, effectReferences: [{ effectId: 'efx_a', version: '1.0.0', projectId: 'p' }] })
    const removed = scope.remove.map((entry) => entry.path)
    assert.ok(removed.includes('work'))
    assert.ok(removed.includes('delivery/work'))
    assert.ok(removed.includes('versions/candidates/cnd_rejected'))
    assert.equal(removed.includes('versions/candidates/cnd_open'), false, '未结束的候选不能被清理')
    assert.equal(scope.keep.some((entry) => entry.path === 'versions/index.json'), true)
    assert.equal(scope.keep.some((entry) => entry.path === PROJECT_LAYOUT.materialsFilesDir), true)
    assert.equal(scope.sharedReferences.length, 1)
    assert.equal(scope.honest.deletesCandidateRecords, false)
    assert.equal(typeof scope.digest, 'string')
    const second = planCleanupScope({ paths, versions, effectReferences: [{ effectId: 'efx_a', version: '1.0.0', projectId: 'p' }] })
    assert.equal(second.digest, scope.digest, '同一事实的两次范围计算必须得到同一指纹')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
