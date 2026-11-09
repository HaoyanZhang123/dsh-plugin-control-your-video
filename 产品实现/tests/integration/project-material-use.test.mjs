/**
 * Integration: the material-use lifecycle through the REAL store.
 *
 * The unit tests prove each module's behaviour; this file proves the thing a user actually depends
 * on — that after the workbench is closed and re-opened, the material bytes, the rights, the
 * recorded use, the exclusions and the event trail are still on disk and still agree.
 *
 * "Fresh read" is enforced structurally: every read after a write builds a NEW `ProjectPaths`
 * instance from the same root and re-parses `materials/index.json` from the filesystem. Nothing is
 * carried over in memory, so a value that only existed in a returned object could not pass.
 *
 * @module tests/integration/project-material-use.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, createTempDir, sha256 } from '../../base/index.js'
import { ProjectPaths, PROJECT_LAYOUT } from '../../core/project/paths.js'
import { NeedsAttentionCode } from '../../core/project/schema.js'
import { newId } from '../../core/project/ids.js'
import { ProjectEventKind, readEvents } from '../../core/project/events.js'
import { PROJECT_PREFERENCES_PATH } from '../../core/project/preferences.js'
import {
  PermissionCode,
  addMaterial,
  amendUse,
  describeEffectivePermission,
  excludeFromUse,
  readMaterialsCatalog,
  recordUse,
  verifyAvailability,
} from '../../core/project/materials.js'

const temp = createTempDir({ label: 'project-material-use' })
test.after(() => temp.dispose())

/** One frozen clock shared by a test, so timestamps are comparable but still injected. */
const frozenClock = () => new Clock({ mode: 'frozen', start: 1_700_000_000_000 })

/**
 * A project root that survives across "sessions" inside one test.
 * @param {string} label
 * @returns {{ root: string, projectId: string, open: () => ProjectPaths, dir: string }}
 */
function openProjectSpace(label) {
  const root = temp.dir(`root-${label}`)
  const projectId = newId('project')
  const first = new ProjectPaths(root, projectId)
  fs.mkdirSync(first.dir, { recursive: true })
  return {
    root,
    projectId,
    dir: first.dir,
    // A brand-new object per call: nothing can be inherited from a previous write's result.
    open: () => new ProjectPaths(root, projectId),
  }
}

/**
 * Create a real binary file on disk to feed `addMaterial` by path.
 * @param {string} name
 * @param {Buffer} bytes
 * @returns {string} absolute path
 */
function realSourceFile(name, bytes) {
  const target = temp.file(name)
  fs.writeFileSync(target, bytes)
  return target
}

test('lifecycle: material → use → amend → exclude survives a fresh read from disk', () => {
  const space = openProjectSpace('lifecycle')
  const clock = frozenClock()
  const videoBytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 1, 2, 3, 250, 251])

  // --- session 1: import the file, record the user's sentence, then restrict it ---
  const paths1 = space.open()
  const sourceFile = realSourceFile('clip.mov', videoBytes)
  const added = addMaterial({
    projectPaths: paths1,
    sourceFile,
    kind: 'video',
    source: 'upload',
    sourceLabel: '用户拖入的原始片段',
    rightsStatus: 'user-provided',
    observation: 'unread',
    clock,
  })
  assert.equal(added.material.contentSha256, sha256(videoBytes), '哈希必须来自真实文件字节')
  assert.equal(added.material.byteSize, videoBytes.length)

  const userText = '这段 8 秒素材只用在预告片的第 2 幕；片头片尾不要用，也不要发给任何外部服务。'
  const recorded = recordUse({
    projectPaths: paths1,
    materialId: added.material.materialId,
    userText,
    allowedUses: ['预告片'],
    limitedScopes: ['预告片第 2 幕'],
    projectVersion: 'v1',
    clock,
  })
  amendUse({
    projectPaths: paths1,
    useId: recorded.use.useId,
    exclusions: [{ kind: 'range', start: 0, end: 2, unit: 'seconds', label: '片头两秒' }],
    projectVersion: 'v2',
    note: '用户补充：片头两秒不用',
    clock,
  })
  excludeFromUse({
    projectPaths: paths1,
    useId: recorded.use.useId,
    exclusions: [{ kind: 'segment', label: '片尾字幕段' }],
    projectVersion: 'v2',
    clock,
  })
  const session1Revision = readMaterialsCatalog(paths1).revision

  // --- the index file itself is on disk where the contract says it is ---
  const indexPath = path.join(space.dir, PROJECT_LAYOUT.materialsIndex)
  assert.ok(fs.existsSync(indexPath), `材料清单必须在 ${PROJECT_LAYOUT.materialsIndex}`)
  const indexText = fs.readFileSync(indexPath, 'utf8')
  const indexDocument = JSON.parse(indexText)
  assert.equal(indexDocument.kind, 'materials-catalog')
  assert.equal(indexDocument.projectId, space.projectId)
  assert.equal(indexDocument.schemaVersion, 1)
  assert.equal(indexDocument.schemaGeneration, 1)
  assert.equal(indexDocument.revision, session1Revision)
  assert.equal(indexDocument.materials.length, 1)
  assert.equal(indexDocument.uses.length, 1)
  assert.ok(indexText.endsWith('\n'), '清单必须以单个换行结束')
  assert.ok(!indexText.endsWith('\n\n'), '清单不得有多余结尾空行')

  // --- session 2: a completely fresh instance re-reads everything from disk ---
  const paths2 = space.open()
  const catalog = readMaterialsCatalog(paths2)
  assert.equal(catalog.exists, true)
  assert.equal(catalog.revision, session1Revision, '同一份文件必须给出同一个修订')
  assert.equal(catalog.sha256, sha256(Buffer.from(indexText, 'utf8')))

  const material = catalog.materials[0]
  assert.equal(material.materialId, added.material.materialId)
  assert.equal(material.originalFilename, 'clip.mov')
  assert.equal(material.rightsStatus, 'user-provided')
  assert.equal(material.observation, 'unread')
  assert.equal(material.source, 'upload')
  assert.equal(material.sourceLabel, '用户拖入的原始片段')
  assert.equal(material.contentSha256, sha256(videoBytes))
  assert.equal(material.byteSize, videoBytes.length)
  assert.equal(material.addedAt, clock.iso())

  // The bytes themselves are still readable at the recorded relative path.
  const materialPath = paths2.resolve(material.storedRelativePath)
  assert.ok(fs.existsSync(materialPath))
  assert.deepEqual(fs.readFileSync(materialPath), videoBytes, '落盘字节必须与来源字节完全一致')
  assert.equal(material.storedRelativePath, `materials/files/${material.materialId}/content.mov`)

  const use = catalog.uses[0]
  assert.equal(use.useId, recorded.use.useId)
  assert.equal(use.userText, userText, '用户原文必须逐字跨会话保留')
  assert.deepEqual(use.allowedUses, ['预告片'])
  assert.deepEqual(use.limitedScopes, ['预告片第 2 幕'])
  assert.equal(use.exclusions.length, 2)
  assert.equal(use.exclusions[0].kind, 'range')
  assert.equal(use.exclusions[1].kind, 'segment')
  assert.equal(use.amendments.length, 2)
  assert.equal(use.amendments[0].previous.exclusions.length, 0)
  assert.deepEqual(use.amendments[0].changes.exclusions[0], {
    kind: 'range',
    start: 0,
    end: 2,
    unit: 'seconds',
    label: '片头两秒',
  })
  assert.equal(use.projectVersion, 'v1', '原始记录的版本不被修订覆盖')
  assert.equal(use.amendments[1].projectVersion, 'v2')

  // Permission queries read the SAME persisted exclusions.
  const blockedByRead = describeEffectivePermission(catalog, {
    materialId: material.materialId,
    purpose: '预告片',
    scope: '预告片第 2 幕',
    segment: { start: 0.5, end: 1.5 },
  })
  assert.equal(blockedByRead.allowed, false)
  assert.equal(blockedByRead.code, PermissionCode.EXCLUDED_RANGE)

  const blockedBySegmentName = describeEffectivePermission(catalog, {
    materialId: material.materialId,
    purpose: '预告片',
    scope: '预告片第 2 幕',
    segment: { start: 3, end: 5 },
    segmentLabel: '片尾字幕段',
  })
  assert.equal(blockedBySegmentName.allowed, false)
  assert.equal(blockedBySegmentName.code, PermissionCode.EXCLUDED_RANGE)

  // This use carries BOTH a numeric range exclusion AND a named segment exclusion. A numeric-only
  // query cannot prove it avoids a named segment the module has no coordinates for, so the honest
  // answer is "cannot confirm" — reporting `allowed` there is the exact failure mode that lets an
  // excluded segment be used.
  const undecidable = describeEffectivePermission(catalog, {
    materialId: material.materialId,
    purpose: '预告片',
    scope: '预告片第 2 幕',
    segment: { start: 3, end: 5 },
  })
  assert.equal(undecidable.allowed, false, '无法判定时不得报告可使用')
  assert.equal(undecidable.partial, true)
  assert.equal(undecidable.code, PermissionCode.EXCLUDED_PARTIAL)
  assert.deepEqual(
    undecidable.checks.filter((check) => check.status === 'partial').map((check) => check.aspect),
    ['exclusions'],
  )

  // Naming the segment as well makes BOTH exclusion dimensions decidable, and this range is
  // outside both of them, so the recorded use really does permit it.
  const allowed = describeEffectivePermission(catalog, {
    materialId: material.materialId,
    purpose: '预告片',
    scope: '预告片第 2 幕',
    segment: { start: 3, end: 5 },
    segmentLabel: '中间正片段',
  })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.partial, false)
  assert.equal(allowed.code, PermissionCode.RECORDED_USE)

  const wrongPurpose = describeEffectivePermission(catalog, {
    materialId: material.materialId,
    purpose: '正片',
    segment: { start: 3, end: 5 },
  })
  assert.equal(wrongPurpose.allowed, false)
  assert.equal(wrongPurpose.code, PermissionCode.PURPOSE_NOT_ALLOWED)

  // --- the event trail is on disk and ordered ---
  const { events, skipped } = readEvents(space.dir, { limit: 100 })
  assert.deepEqual(skipped, [])
  // Both restriction paths emit an amendment AND an exclusion event: adding an excluded range is
  // itself a material fact (MATERIAL_EXCLUDED), not merely a diff inside another event.
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      ProjectEventKind.MATERIAL_ADDED,
      ProjectEventKind.MATERIAL_USE_RECORDED,
      ProjectEventKind.MATERIAL_USE_AMENDED,
      ProjectEventKind.MATERIAL_EXCLUDED,
      ProjectEventKind.MATERIAL_USE_AMENDED,
      ProjectEventKind.MATERIAL_EXCLUDED,
    ],
  )
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6],
  )
  assert.equal(events[1].detail.userText, userText)
  assert.equal(events[3].detail.exclusions[0].label, '片头两秒')
  assert.equal(events[5].detail.exclusions[0].label, '片尾字幕段')

  // --- availability agrees with the real files ---
  const availability = verifyAvailability({ projectPaths: space.open() })
  assert.equal(availability.ok, true)
  assert.equal(availability.items[0].available, true)
  assert.equal(availability.items[0].actualSha256, material.contentSha256)
})

test('lifecycle: two sessions, a second material and an amended restriction keep one use each', () => {
  const space = openProjectSpace('multi')
  const clock = frozenClock()

  const paths1 = space.open()
  const image = addMaterial({
    projectPaths: paths1,
    bytes: Buffer.from('image-bytes', 'utf8'),
    originalFilename: 'cover.png',
    kind: 'image',
    clock,
  })
  const audio = addMaterial({
    projectPaths: paths1,
    bytes: Buffer.from('audio-bytes', 'utf8'),
    originalFilename: 'theme.mp3',
    kind: 'audio',
    clock,
  })
  const imageUse = recordUse({
    projectPaths: paths1,
    materialId: image.material.materialId,
    userText: '封面图可以用在标题卡',
    projectVersion: 'v1',
    clock,
  })
  recordUse({
    projectPaths: paths1,
    materialId: audio.material.materialId,
    userText: '主题曲只做背景音乐，不要外发',
    allowedUses: ['背景音乐'],
    projectVersion: 'v1',
    clock,
  })

  // --- reopen: amend only the image use, in a fresh instance ---
  const paths2 = space.open()
  const before = readMaterialsCatalog(paths2)
  assert.equal(before.materials.length, 2)
  assert.equal(before.uses.length, 2)

  const amended = amendUse({
    projectPaths: paths2,
    useId: imageUse.use.useId,
    exclusions: [{ kind: 'all', label: '标题卡以外的用途全部排除' }],
    projectVersion: 'v2',
    clock,
  })
  assert.equal(amended.revision.startsWith('r'), true)

  const paths3 = space.open()
  const after = readMaterialsCatalog(paths3)
  assert.equal(after.materials.length, 2, '修订用途不得新增材料')
  assert.equal(after.uses.length, 2, '修订用途不得新增用途记录')
  const imageUseAfter = after.uses.find((use) => use.useId === imageUse.use.useId)
  const audioUseAfter = after.uses.find((use) => use.materialId === audio.material.materialId)
  assert.equal(imageUseAfter.exclusions[0].kind, 'all')
  assert.equal(imageUseAfter.amendments.length, 1)
  assert.equal(audioUseAfter.amendments.length, 0, '另一条用途记录不得被改动')
  assert.equal(audioUseAfter.userText, '主题曲只做背景音乐，不要外发')

  assert.equal(
    describeEffectivePermission(after, { materialId: image.material.materialId }).allowed,
    false,
    '整体排除在重新读取后依然生效',
  )
  assert.equal(
    describeEffectivePermission(after, {
      materialId: audio.material.materialId,
      purpose: '背景音乐',
    }).allowed,
    true,
  )
})

test('fresh read: a deleted material is reported as needs-attention with a real event', () => {
  const space = openProjectSpace('missing')
  const clock = frozenClock()
  const paths1 = space.open()
  const added = addMaterial({
    projectPaths: paths1,
    bytes: Buffer.from('temporary', 'utf8'),
    originalFilename: 'temp.txt',
    kind: 'text',
    clock,
  })

  // The user (or another tool) removes the file between sessions.
  fs.rmSync(paths1.resolve(added.material.storedRelativePath))

  const paths2 = space.open()
  const result = verifyAvailability({ projectPaths: paths2, record: true, clock })
  assert.equal(result.ok, false)
  assert.deepEqual(result.needsAttention, [NeedsAttentionCode.MATERIAL_MISSING])

  const { events } = readEvents(space.dir, { kinds: [ProjectEventKind.MATERIAL_MISSING] })
  assert.equal(events.length, 1)
  assert.equal(events[0].detail.code, NeedsAttentionCode.MATERIAL_MISSING)
  assert.equal(events[0].objectId, added.material.materialId)

  // The catalog record itself is untouched: the fact "this material was registered" survives.
  const paths3 = space.open()
  const catalog = readMaterialsCatalog(paths3)
  assert.equal(catalog.materials.length, 1)
  assert.equal(catalog.materials[0].contentSha256, added.material.contentSha256)

  // And a second check reports it again; it does not silently start "fixing" anything.
  const again = verifyAvailability({ projectPaths: paths3 })
  assert.equal(again.ok, false)
  assert.deepEqual(again.needsAttention, [NeedsAttentionCode.MATERIAL_MISSING])
})

test('fresh read: bytes changed outside the workbench are reported as a hash mismatch', () => {
  const space = openProjectSpace('tampered')
  const clock = frozenClock()
  const paths1 = space.open()
  const added = addMaterial({
    projectPaths: paths1,
    bytes: Buffer.from('v1 content', 'utf8'),
    originalFilename: 'note.txt',
    kind: 'text',
    clock,
  })
  const absolute = paths1.resolve(added.material.storedRelativePath)
  fs.writeFileSync(absolute, 'v2 content (edited by another tool)', 'utf8')

  const result = verifyAvailability({ projectPaths: space.open() })
  assert.equal(result.ok, false)
  assert.equal(result.items[0].code, NeedsAttentionCode.MATERIAL_HASH_MISMATCH)
  assert.equal(result.items[0].expectedSha256, sha256(Buffer.from('v1 content', 'utf8')))
  assert.equal(result.items[0].actualSha256, sha256(Buffer.from('v2 content (edited by another tool)', 'utf8')))
})

test('concurrency: a stale writer in another instance cannot overwrite a newer catalog', () => {
  const space = openProjectSpace('concurrent')
  const clock = frozenClock()

  // Writer A and writer B both open the project at the same time.
  const writerA = space.open()
  const writerB = space.open()
  addMaterial({
    projectPaths: writerA,
    bytes: Buffer.from('base', 'utf8'),
    originalFilename: 'base.txt',
    kind: 'text',
    clock,
  })

  const snapshotA = readMaterialsCatalog(writerA)
  const snapshotB = readMaterialsCatalog(writerB)
  assert.equal(snapshotA.revision, snapshotB.revision, '两边读到同一个修订')

  // B publishes first.
  const usage = recordUse({
    projectPaths: writerB,
    materialId: snapshotB.materials[0].materialId,
    userText: 'B 记录的用途',
    projectVersion: 'v1',
    baseRevision: snapshotB.revision,
    clock,
  })
  assert.notEqual(usage.revision, snapshotB.revision)

  // A still holds the old revision: its write must be refused, and B's result must survive.
  assert.throws(
    () =>
      recordUse({
        projectPaths: writerA,
        materialId: snapshotA.materials[0].materialId,
        userText: 'A 记录的用途（应被拒绝）',
        projectVersion: 'v1',
        baseRevision: snapshotA.revision,
        clock,
      }),
    { code: 'VERSION_CONFLICT' },
  )

  const persisted = readMaterialsCatalog(space.open())
  assert.equal(persisted.revision, usage.revision)
  assert.equal(persisted.uses.length, 1)
  assert.equal(persisted.uses[0].userText, 'B 记录的用途')
})

test('isolation: each project keeps its own materials while sharing one root', () => {
  const root = temp.dir('shared-root')
  const clock = frozenClock()
  const first = new ProjectPaths(root, newId('project'))
  const second = new ProjectPaths(root, newId('project'))
  fs.mkdirSync(first.dir, { recursive: true })
  fs.mkdirSync(second.dir, { recursive: true })
  assert.notEqual(first.dir, second.dir)

  const firstMaterial = addMaterial({
    projectPaths: first,
    bytes: Buffer.from('project one data', 'utf8'),
    originalFilename: 'one.txt',
    kind: 'text',
    clock,
  })
  recordUse({
    projectPaths: first,
    materialId: firstMaterial.material.materialId,
    userText: '只在第一个项目用',
    projectVersion: 'v1',
    clock,
  })

  const secondPaths = new ProjectPaths(root, second.projectId)
  const secondCatalog = readMaterialsCatalog(secondPaths)
  assert.equal(secondCatalog.exists, false, '第二个项目不应看到第一个项目的材料清单')
  assert.equal(secondCatalog.materials.length, 0)

  const firstPaths = new ProjectPaths(root, first.projectId)
  const firstCatalog = readMaterialsCatalog(firstPaths)
  assert.equal(firstCatalog.materials.length, 1)
  assert.equal(firstCatalog.projectId, first.projectId)
  assert.equal(
    firstPaths.resolve(firstCatalog.materials[0].storedRelativePath).startsWith(first.dir),
    true,
    '材料字节必须落在本项目目录内',
  )
})

test('coexistence: materials and project preferences share a project directory without collision', () => {
  const space = openProjectSpace('coexist')
  const clock = frozenClock()
  const paths = space.open()
  const added = addMaterial({
    projectPaths: paths,
    bytes: Buffer.from('shared dir', 'utf8'),
    originalFilename: 'shared.txt',
    kind: 'text',
    clock,
  })

  // Preferences are a different module's concern, but both must coexist inside one project dir;
  // writing an unrelated preferences file must not disturb the material catalog.
  const preferencesPath = paths.resolve(PROJECT_PREFERENCES_PATH)
  fs.mkdirSync(path.dirname(preferencesPath), { recursive: true })
  fs.writeFileSync(
    preferencesPath,
    `${JSON.stringify({ kind: 'project-preferences', values: {} }, null, 2)}\n`,
    'utf8',
  )

  const catalog = readMaterialsCatalog(space.open())
  assert.equal(catalog.materials.length, 1)
  assert.equal(catalog.materials[0].materialId, added.material.materialId)
  assert.ok(fs.existsSync(paths.resolve(added.material.storedRelativePath)))
  assert.ok(fs.existsSync(preferencesPath))
})
