/**
 * Unit tests for the deterministic UnitProfile and the early-unit gate.
 *
 * What these tests prove: the required slots and evidence are derived from base type, operation and
 * conditions — not from a model's opinion — and that a unit with a missing part, a missing file, a
 * wrong hash, an unexecuted check, a placeholder or a stale profile version is reported incomplete
 * with the reason named. They also prove the three internal views keep their exclusions.
 *
 * @module tests/unit/orchestration-profiles.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { Clock, createTempDir, sha256 } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import {
  UNIT_PARTS,
  UnitBase,
  UnitCondition,
  UnitOperation,
  describeUnitProfileMatrix,
  humanResultView,
  productionView,
  recoveryView,
  resolveUnitProfile,
  validateUnit,
} from '../../orchestration/units.js'

const temp = createTempDir({ label: 'orchestration-profiles' })
test.after(() => temp.dispose())

const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
let counter = 0

/** A real project directory, because file existence and hashes are part of the gate. */
function makeProject() {
  counter += 1
  const root = temp.dir(`root-${counter}`)
  const created = createProject({ projectsRoot: root, title: `单元门禁 ${counter}`, clock })
  return { paths: new ProjectPaths(root, created.project.projectId) }
}

/**
 * A complete unit for the given profile, with one real file on disk.
 * @param {any} profile
 * @param {any} paths
 * @param {object} [overrides]
 */
function makeUnit(profile, paths, overrides = {}) {
  const relative = `media/unit-${counter}-${profile.base}.mp4`
  const bytes = `unit-bytes-${profile.profileId}`
  const absolute = paths.resolve(relative)
  fs.mkdirSync(absolute.substring(0, absolute.lastIndexOf('\\')) || paths.dir, { recursive: true })
  fs.writeFileSync(absolute, bytes, 'utf8')
  const evidence = profile.requiredEvidence.map((kind) => ({
    kind,
    ref: `evd:${kind}`,
    executed: true,
    observationState: 'observed',
  }))
  const unit = {
    unitManifest: {
      unitId: `unit-${counter}-${profile.base}-${profile.operation}`,
      projectId: paths.projectId,
      base: profile.base,
      operation: profile.operation,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      target: '开场静态细节',
      spec: { aspect: '16:9', frames: 48 },
      status: 'produced',
      source: 'C13 测试',
    },
    unitOutput: {
      files: [{ role: 'master', path: relative, sha256: sha256(bytes) }],
      readableWhole: true,
      evidence,
      checks: [{ name: '整片可解码', executed: true, passed: true }],
    },
    productionRecipe: {
      authorizedInputs: ['素材 A'],
      methods: ['mth-water-ink'],
      tools: ['ffmpeg@9.0.1'],
      parameters: { fps: 25 },
      execution: { executed: true, taskId: 'task-1' },
      fixed: ['画幅'],
      variable: ['时长'],
    },
    humanResultPack: {
      slots: [{ name: '成片', value: relative }],
      knownIssues: [],
      unverified: [],
      choices: [{ id: 'accept', label: '可以' }],
    },
    continuationContract: {
      directReuse: '可直接复用的构图',
      adaptByContent: '换主体时按内容适配',
      recreate: '换媒介时重做',
      reverify: '换引擎后重新验证',
      dependsOn: ['素材 A'],
      invalidWhen: ['画幅改变'],
    },
  }
  return { unit: mergeDeep(unit, overrides), relative }
}

/**
 * Minimal deep merge for test overrides.
 * @param {any} base
 * @param {any} patch
 */
function mergeDeep(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = mergeDeep(base?.[key], value)
  }
  return out
}

test('profile: base type drives the minimum evidence (static vs temporal)', () => {
  const staticProfile = resolveUnitProfile({ base: UnitBase.STATIC_DETAIL, operation: UnitOperation.CREATE })
  const temporalProfile = resolveUnitProfile({ base: UnitBase.TEMPORAL_MOTION, operation: UnitOperation.CREATE })
  assert.deepEqual(staticProfile.requiredEvidence, ['full-frame', 'detail-region', 'original-ratio'])
  assert.equal(temporalProfile.requiredEvidence.includes('full-playback'), true)
  assert.equal(temporalProfile.requiredEvidence.includes('mid-frame'), true)
  assert.equal(staticProfile.requiredEvidence.includes('full-playback'), false)
  assert.deepEqual([...staticProfile.requiredParts], [...UNIT_PARTS])
})

test('profile: operation and conditions add mandatory evidence deterministically', () => {
  const plain = resolveUnitProfile({ base: UnitBase.STATIC_DETAIL, operation: UnitOperation.CREATE })
  const repair = resolveUnitProfile({ base: UnitBase.STATIC_DETAIL, operation: UnitOperation.REPAIR })
  assert.equal(repair.requiredEvidence.includes('before-after'), true)
  assert.equal(repair.requiredEvidence.includes('unselected-scope'), true)

  const withSound = resolveUnitProfile({
    base: UnitBase.STATIC_DETAIL,
    operation: UnitOperation.CREATE,
    conditions: [UnitCondition.SOUND],
  })
  assert.equal(withSound.requiredEvidence.includes('complete-audio-track'), true)
  assert.equal(withSound.requiredEvidence.includes('continuous-audio-video'), true)
  assert.equal(withSound.triggers.length, 1)
  assert.equal(withSound.triggers[0].condition, UnitCondition.SOUND)

  // Same inputs → same profile id; different inputs → different profile id.
  const sameAgain = resolveUnitProfile({ base: UnitBase.STATIC_DETAIL, operation: UnitOperation.CREATE })
  assert.equal(plain.profileId, sameAgain.profileId)
  assert.notEqual(plain.profileId, repair.profileId)
  assert.notEqual(plain.profileId, withSound.profileId)
})

test('profile: the model may fill slots but cannot remove requirements', () => {
  const profile = resolveUnitProfile({ base: UnitBase.TEMPORAL_MOTION, operation: UnitOperation.REPAIR })
  assert.equal(profile.modelForbidden.includes('remove a required part'), true)
  assert.equal(profile.modelForbidden.includes('remove required evidence'), true)
  assert.equal(profile.modelForbidden.includes('declare a unit complete'), true)
  assert.deepEqual(profile.modelEditable, ['slot content', 'evidence files', 'checks results'])
  // Mutating the returned profile must not change the next resolution.
  assert.throws(() => {
    // @ts-expect-error frozen on purpose
    profile.requiredEvidence.push('invented-evidence')
  })
})

test('matrix: every base × operation combination has a profile and condition extras', () => {
  const rows = describeUnitProfileMatrix()
  assert.equal(rows.length, Object.values(UnitBase).length * Object.values(UnitOperation).length)
  for (const row of rows) {
    assert.equal(row.minimumEvidence.length > 0, true)
    assert.equal(row.conditionEvidence[UnitCondition.SOUND].includes('complete-audio-track'), true)
    assert.equal(Array.isArray(row.conditionEvidence[UnitCondition.COMPARE]), true)
  }
})

test('validate: a complete unit passes and reports its unobserved evidence honestly', () => {
  const { paths } = makeProject()
  const profile = resolveUnitProfile({
    base: UnitBase.STATIC_DETAIL,
    operation: UnitOperation.CREATE,
    conditions: [UnitCondition.SOUND],
  })
  const { unit } = makeUnit(profile, paths)
  const result = validateUnit({ unit, profile, paths })
  assert.equal(result.ok, true, JSON.stringify(result.missing))
  assert.deepEqual(result.unobserved, [])

  // Same unit, but the AI honestly says it did not look at the detail region.
  const honest = structuredClone(unit)
  const detail = honest.unitOutput.evidence.find((entry) => entry.kind === 'detail-region')
  detail.observationState = 'not-observed'
  const honestResult = validateUnit({ unit: honest, profile, paths })
  assert.equal(honestResult.ok, true, '未看并不等于单元未完成，它是如实记录')
  assert.deepEqual(honestResult.unobserved, ['detail-region'])
})

test('validate: missing parts are all reported, not just the first', () => {
  const { paths } = makeProject()
  const profile = resolveUnitProfile({ base: UnitBase.STATIC_DETAIL, operation: UnitOperation.CREATE })
  const { unit } = makeUnit(profile, paths)
  delete unit.unitOutput
  delete unit.humanResultPack
  const result = validateUnit({ unit, profile, paths })
  assert.equal(result.ok, false)
  const parts = result.missing.map((entry) => entry.part)
  assert.deepEqual(parts.sort(), ['humanResultPack', 'unitOutput'])
})

test('validate: placeholder, wrong hash, missing file and unexecuted check all fail', () => {
  const { paths } = makeProject()
  const profile = resolveUnitProfile({ base: UnitBase.STATIC_DETAIL, operation: UnitOperation.CREATE })

  const placeholder = makeUnit(profile, paths, { unitManifest: { placeholder: true } })
  assert.equal(validateUnit({ unit: placeholder.unit, profile, paths }).ok, false)

  const wrongHash = makeUnit(profile, paths, { unitOutput: { files: [{ role: 'master', path: 'media/x.mp4', sha256: 'f'.repeat(64) }] } })
  fs.writeFileSync(paths.resolve('media/x.mp4'), 'other-bytes', 'utf8')
  const wrongHashResult = validateUnit({ unit: wrongHash.unit, profile, paths })
  assert.equal(wrongHashResult.ok, false)
  assert.equal(wrongHashResult.missing.some((entry) => entry.reason === 'file-hash-mismatch'), true)

  const missingFile = makeUnit(profile, paths, { unitOutput: { files: [{ role: 'master', path: 'media/not-there.mp4' }] } })
  const missingFileResult = validateUnit({ unit: missingFile.unit, profile, paths })
  assert.equal(missingFileResult.ok, false)
  assert.equal(missingFileResult.missing.some((entry) => entry.reason === 'file-missing'), true)

  const unexecuted = makeUnit(profile, paths, { unitOutput: { checks: [{ name: '音画同步', executed: false, passed: true }] } })
  const unexecutedResult = validateUnit({ unit: unexecuted.unit, profile, paths })
  assert.equal(unexecutedResult.ok, false)
  assert.equal(unexecutedResult.missing.some((entry) => entry.reason === 'check-not-executed'), true)
})

test('validate: a stale profile version is an incomplete unit, not a warning', () => {
  const { paths } = makeProject()
  const profile = resolveUnitProfile({ base: UnitBase.STATIC_DETAIL, operation: UnitOperation.CREATE })
  const { unit } = makeUnit(profile, paths, { unitManifest: { profileVersion: '0.9.0' } })
  const result = validateUnit({ unit, profile, paths })
  assert.equal(result.ok, false)
  assert.equal(result.missing.some((entry) => entry.reason === 'profile-version-mismatch'), true)
})

test('views: production, human-result and recovery exclude their own forbidden content', () => {
  const { paths } = makeProject()
  const profile = resolveUnitProfile({
    base: UnitBase.TEMPORAL_MOTION,
    operation: UnitOperation.CREATE,
    conditions: [UnitCondition.SOUND],
  })
  const { unit } = makeUnit(profile, paths)

  const production = productionView({ unit, profile, currentAction: '制作第 2 个转场' })
  assert.equal(production.view, 'production')
  assert.equal(production.excluded.includes('全历史聊天'), true)
  assert.equal(production.excluded.includes('所有旧帧'), true)

  const human = humanResultView({ unit })
  assert.deepEqual(human.choices.length, 1)
  assert.equal(human.excluded.includes('内部推理'), true)

  const recovery = recoveryView({
    unit,
    profile,
    workPackage: { workPackageId: 'wpk_1', savedPosition: '第 2 单元' },
    baseline: { ref: 'b1' },
  })
  assert.equal(recovery.workPackage.savedPosition, '第 2 单元')
  assert.equal(recovery.excluded.includes('全部派生图'), true)
})
