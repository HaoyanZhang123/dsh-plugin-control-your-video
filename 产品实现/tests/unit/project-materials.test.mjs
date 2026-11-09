/**
 * Unit tests for core/project/materials.js.
 *
 * Every assertion here is a contract claim from CT-03 §3 / CT-02 §3, not a smoke test:
 * the hash comes from the bytes actually on disk, the user's sentence is stored verbatim,
 * an amendment keeps the previous state, an exclusion really blocks a matching range, a deleted
 * or mutated file is reported as "需要处理", the four observation states stay distinct, the event
 * log records what happened, and a second writer on a stale revision is refused.
 *
 * Real temp directories and real files are used throughout: a mocked filesystem could not prove
 * that the recorded hash matches published bytes.
 *
 * @module tests/unit/project-materials.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, createTempDir, sha256 } from '../../base/index.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { MaterialObservation, NeedsAttentionCode, RightsStatus } from '../../core/project/schema.js'
import { newId } from '../../core/project/ids.js'
import { ProjectEventKind, readEvents } from '../../core/project/events.js'
import { fileSha256 } from '../../core/project/store.js'
import {
  addMaterial,
  amendUse,
  describeEffectivePermission,
  emptyMaterialsCatalog,
  excludeFromUse,
  findMaterial,
  isAllowedForUse,
  latestUseForMaterial,
  materialStorageRelativePath,
  materialsIndexPath,
  readMaterialsCatalog,
  recordUse,
  usesForMaterial,
  verifyAvailability,
  writeMaterialsCatalog,
  PermissionCode,
  MAX_IN_MEMORY_MATERIAL_BYTES,
} from '../../core/project/materials.js'

const temp = createTempDir({ label: 'project-materials' })
test.after(() => temp.dispose())

/** A frozen clock, so recorded timestamps and revisions are comparable across runs. */
const frozenClock = () => new Clock({ mode: 'frozen', start: 1_700_000_000_000 })

/**
 * Create a fresh project directory inside the managed temp dir and return its paths.
 * @param {string} label
 * @returns {import('../../core/project/paths.js').ProjectPaths}
 */
function freshProject(label) {
  const root = temp.dir(`projects-${label}`)
  const paths = new ProjectPaths(root, newId('project'))
  fs.mkdirSync(paths.dir, { recursive: true })
  return paths
}

/**
 * Add one small material from real bytes.
 * @param {import('../../core/project/paths.js').ProjectPaths} paths
 * @param {string} content
 * @param {object} [overrides]
 * @returns {object} the addMaterial result
 */
function addSample(paths, content, overrides = {}) {
  return addMaterial({
    projectPaths: paths,
    bytes: Buffer.from(content, 'utf8'),
    originalFilename: 'sample.png',
    kind: 'image',
    clock: frozenClock(),
    ...overrides,
  })
}

test('addMaterial: hash and size are computed from the bytes actually on disk', () => {
  const paths = freshProject('hash')
  const content = '真实的素材内容，不是占位符。'
  const added = addSample(paths, content)

  const absolute = paths.resolve(added.material.storedRelativePath)
  assert.ok(fs.existsSync(absolute), '材料文件必须真实落盘')

  const onDisk = fs.readFileSync(absolute)
  assert.equal(sha256(onDisk), added.material.contentSha256, '记录的哈希必须等于磁盘字节的哈希')
  assert.equal(sha256(Buffer.from(content, 'utf8')), added.material.contentSha256)
  assert.equal(added.material.byteSize, onDisk.length)
  assert.notEqual(added.material.byteSize, 0)
  assert.match(added.material.materialId, /^mat_[0-9A-HJKMNP-TV-Z]{16}$/)
})

test('addMaterial: the original filename is metadata, never a path', () => {
  const paths = freshProject('filename')
  const added = addSample(paths, 'x', { originalFilename: '我的 截图 01.png' })

  assert.equal(added.material.originalFilename, '我的 截图 01.png')
  assert.equal(
    added.material.storedRelativePath,
    `materials/files/${added.material.materialId}/content.png`,
    '存储路径只能由材料 ID 与安全扩展名组成',
  )
  assert.ok(!added.material.storedRelativePath.includes('我的'), '存储路径不得包含原始文件名')
  assert.equal(paths.resolve(added.material.storedRelativePath).startsWith(paths.dir), true)
})

test('addMaterial: a filename that smuggles path syntax is refused', () => {
  const paths = freshProject('badname')
  for (const name of ['../escape.png', '..\\escape.png', 'a/b.png', '.', '..']) {
    assert.throws(
      () => addSample(paths, 'x', { originalFilename: name }),
      (error) => error.code === 'VALIDATION_FAILED',
      `应拒绝文件名: ${name}`,
    )
  }
  assert.equal(readMaterialsCatalog(paths).materials.length, 0, '被拒绝的登记不得留下记录')
})

test('addMaterial: rights and observation are recorded as given, not inferred', () => {
  const paths = freshProject('observation')
  const explicit = addSample(paths, 'a', {
    observation: MaterialObservation.OBSERVED_FULL,
    rightsStatus: RightsStatus.LICENSED,
  })
  assert.equal(explicit.material.observation, MaterialObservation.OBSERVED_FULL)
  assert.equal(explicit.material.rightsStatus, RightsStatus.LICENSED)

  // A successful read is NOT evidence that anyone looked at the content: the default must stay
  // `unread` so no caller can claim "AI 已看过" from a file copy alone.
  const implicit = addSample(paths, 'b')
  assert.equal(implicit.material.observation, MaterialObservation.UNREAD)
  assert.equal(implicit.material.rightsStatus, RightsStatus.UNKNOWN)

  const distinct = new Set(Object.values(MaterialObservation))
  assert.equal(distinct.size, 5, '观察状态必须是离散取值，不能塌缩成一个布尔值')
  assert.ok(distinct.has(MaterialObservation.UNREADABLE))
  assert.ok(distinct.has(MaterialObservation.OBSERVED_PARTIAL))
})

test('addMaterial: every observation state is storable and stays distinct on re-read', () => {
  const paths = freshProject('observation-states')
  for (const observation of [
    MaterialObservation.UNREAD,
    MaterialObservation.UNREADABLE,
    MaterialObservation.OBSERVED_PARTIAL,
    MaterialObservation.OBSERVED_FULL,
  ]) {
    addSample(paths, `content-${observation}`, { observation })
  }
  const catalog = readMaterialsCatalog(paths)
  assert.deepEqual(
    catalog.materials.map((material) => material.observation),
    [
      MaterialObservation.UNREAD,
      MaterialObservation.UNREADABLE,
      MaterialObservation.OBSERVED_PARTIAL,
      MaterialObservation.OBSERVED_FULL,
    ],
  )
})

test('addMaterial: an unknown kind or observation is refused instead of coerced', () => {
  const paths = freshProject('enums')
  assert.throws(() => addSample(paths, 'x', { kind: 'hologram' }), { code: 'VALIDATION_FAILED' })
  assert.throws(() => addSample(paths, 'x', { observation: 'seen' }), { code: 'VALIDATION_FAILED' })
  assert.throws(() => addSample(paths, 'x', { rightsStatus: 'mine' }), { code: 'VALIDATION_FAILED' })
})

test('addMaterial: an oversized in-memory material is refused, not silently truncated', () => {
  const paths = freshProject('oversize')
  assert.throws(
    () =>
      addMaterial({
        projectPaths: paths,
        bytes: Buffer.alloc(MAX_IN_MEMORY_MATERIAL_BYTES + 1, 7),
        originalFilename: 'big.bin',
        kind: 'other',
        clock: frozenClock(),
      }),
    { code: 'RESOURCE_LIMIT' },
  )
  assert.equal(readMaterialsCatalog(paths).materials.length, 0)
})

test('addMaterial: bytes or sourceFile is required exactly once', () => {
  const paths = freshProject('source')
  assert.throws(() => addMaterial({ projectPaths: paths, kind: 'image', clock: frozenClock() }), {
    code: 'VALIDATION_FAILED',
  })

  const sourceFile = temp.file('source-input.txt')
  fs.writeFileSync(sourceFile, 'from a real file', 'utf8')
  const added = addMaterial({
    projectPaths: paths,
    sourceFile,
    kind: 'text',
    clock: frozenClock(),
  })
  assert.equal(added.material.originalFilename, 'source-input.txt')
  assert.equal(added.material.contentSha256, sha256(Buffer.from('from a real file', 'utf8')))
})

test('recordUse: the user statement is stored verbatim, with no approval gate', () => {
  const paths = freshProject('verbatim')
  const added = addSample(paths, 'x')
  const userText = '  这张图只用在前 5 秒的片头，\n结尾不要出现；不要上传到任何外部服务。  '

  const recorded = recordUse({
    projectPaths: paths,
    materialId: added.material.materialId,
    userText,
    projectVersion: 'v3',
    clock: frozenClock(),
  })

  assert.equal(recorded.use.userText, userText, '用户原文必须逐字保存，不能 trim 或改写')
  assert.equal(recorded.use.projectVersion, 'v3')
  assert.match(recorded.use.useId, /^usi_[0-9A-HJKMNP-TV-Z]{16}$/)
  assert.equal(recorded.use.recordedAt, frozenClock().iso())
  assert.deepEqual(recorded.use.allowedUses, [])
  assert.deepEqual(recorded.use.exclusions, [])
  assert.deepEqual(recorded.use.limitedScopes, [])
  assert.deepEqual(recorded.use.amendments, [])

  // No restriction stated => legal by default, and the disclosure duty is recorded with it.
  assert.equal(recorded.use.permission.mayUseForProjectGoals, true)
  assert.equal(recorded.use.permission.restricted, false)
  assert.deepEqual(recorded.use.permission.mustDiscloseIn, ['brief', 'plan', 'result'])
  assert.ok(
    recorded.use.permission.requiresAuthorizationFor.includes('external-service'),
    '外部服务仍需单独授权，不能由用途记录代替',
  )
})

test('recordUse: an empty statement, a missing version and an unknown material are refused', () => {
  const paths = freshProject('use-guards')
  const added = addSample(paths, 'x')
  const materialId = added.material.materialId

  assert.throws(
    () =>
      recordUse({
        projectPaths: paths,
        materialId,
        userText: '   ',
        projectVersion: 'v1',
        clock: frozenClock(),
      }),
    { code: 'VALIDATION_FAILED' },
  )
  assert.throws(
    () => recordUse({ projectPaths: paths, materialId, userText: '可用', clock: frozenClock() }),
    { code: 'VALIDATION_FAILED' },
    '项目版本是用途记录的一部分，不能凭空编造',
  )
  assert.throws(
    () =>
      recordUse({
        projectPaths: paths,
        materialId: newId('material'),
        userText: '可用',
        projectVersion: 'v1',
        clock: frozenClock(),
      }),
    { code: 'NOT_FOUND' },
  )
  assert.equal(readMaterialsCatalog(paths).uses.length, 0)
})

test('amendUse: a later restriction keeps the previous state and appends history', () => {
  const paths = freshProject('amend')
  const added = addSample(paths, 'x')
  const originalText = '先按项目目标使用即可'
  const recorded = recordUse({
    projectPaths: paths,
    materialId: added.material.materialId,
    userText: originalText,
    projectVersion: 'v1',
    clock: frozenClock(),
  })

  const amended = amendUse({
    projectPaths: paths,
    useId: recorded.use.useId,
    allowedUses: ['片头'],
    limitedScopes: ['预告片'],
    projectVersion: 'v2',
    note: '用户收紧了范围',
    clock: frozenClock(),
  })

  assert.deepEqual(amended.previous.allowedUses, [], '必须返回变更前的状态，供界面显示“改了什么”')
  assert.equal(amended.previous.userText, originalText)
  assert.deepEqual(amended.current.allowedUses, ['片头'])
  assert.deepEqual(amended.current.limitedScopes, ['预告片'])
  assert.equal(amended.current.userText, originalText, '未改动的字段不能被清空')
  assert.equal(amended.current.amendments.length, 1)
  assert.equal(amended.amendment.changes.allowedUses[0], '片头')
  assert.deepEqual(amended.amendment.previous.allowedUses, [])
  assert.equal(amended.current.permission.restricted, true)

  const catalog = readMaterialsCatalog(paths)
  assert.equal(catalog.uses.length, 1, '修订不得新增一条用途记录')
  assert.equal(catalog.uses[0].amendments.length, 1, '历史必须留在同一条用途记录上')

  // A second amendment stacks; the first one is still readable verbatim.
  const second = amendUse({
    projectPaths: paths,
    useId: recorded.use.useId,
    exclusions: [{ kind: 'segment', label: '结尾 3 秒' }],
    projectVersion: 'v3',
    clock: frozenClock(),
  })
  assert.equal(second.current.amendments.length, 2)
  assert.equal(second.current.amendments[0].changes.allowedUses[0], '片头')
  assert.notEqual(second.current.amendments[0].amendmentId, second.current.amendments[1].amendmentId)
})

test('amendUse: an amendment with no change, or for another material, is refused', () => {
  const paths = freshProject('amend-guards')
  const first = addSample(paths, 'first')
  const second = addSample(paths, 'second')
  const recorded = recordUse({
    projectPaths: paths,
    materialId: first.material.materialId,
    userText: '可用',
    projectVersion: 'v1',
    clock: frozenClock(),
  })

  assert.throws(
    () => amendUse({ projectPaths: paths, useId: recorded.use.useId, projectVersion: 'v2' }),
    { code: 'VALIDATION_FAILED' },
  )
  assert.throws(
    () =>
      amendUse({
        projectPaths: paths,
        useId: recorded.use.useId,
        materialId: second.material.materialId,
        allowedUses: ['片尾'],
        projectVersion: 'v2',
      }),
    { code: 'VALIDATION_FAILED' },
  )
  assert.throws(
    () =>
      amendUse({
        projectPaths: paths,
        useId: 'usi_0123456789ABCDEF',
        allowedUses: ['片尾'],
        projectVersion: 'v2',
      }),
    { code: 'NOT_FOUND' },
  )
})

test('exclusions are honoured: a covered range is blocked, another range is allowed', () => {
  const paths = freshProject('exclude')
  const added = addSample(paths, 'x')
  const recorded = recordUse({
    projectPaths: paths,
    materialId: added.material.materialId,
    userText: '5 到 10 秒不要用',
    projectVersion: 'v1',
    clock: frozenClock(),
  })
  const excluded = excludeFromUse({
    projectPaths: paths,
    useId: recorded.use.useId,
    exclusions: [{ kind: 'range', start: 5, end: 10, unit: 'seconds', label: '中间段' }],
    projectVersion: 'v2',
    clock: frozenClock(),
  })
  assert.equal(excluded.current.exclusions.length, 1)
  assert.equal(excluded.previous.exclusions.length, 0)
  assert.equal(excluded.current.permission.restricted, true)

  const catalog = readMaterialsCatalog(paths)
  const blocked = describeEffectivePermission(catalog, {
    materialId: added.material.materialId,
    segment: { start: 6, end: 8 },
  })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.code, PermissionCode.EXCLUDED_RANGE)
  assert.equal(blocked.matchedExclusion.start, 5)
  assert.match(blocked.reason, /排除/)

  const allowed = describeEffectivePermission(catalog, {
    materialId: added.material.materialId,
    segment: { start: 1, end: 2 },
  })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.code, PermissionCode.RECORDED_USE)

  // Touching the boundary is an overlap, not "almost outside".
  const boundary = describeEffectivePermission(catalog, {
    materialId: added.material.materialId,
    segment: { start: 9.5, end: 10.5 },
  })
  assert.equal(boundary.allowed, false)

  // Without a requested range the module must say "cannot confirm", never "allowed".
  const unstated = describeEffectivePermission(catalog, { materialId: added.material.materialId })
  assert.equal(unstated.allowed, false, '无法判定时不得报告可使用')
  assert.equal(unstated.partial, true)
  assert.equal(unstated.code, PermissionCode.EXCLUDED_PARTIAL)
})

test('exclusions: a named segment and an all-exclusion are honoured', () => {
  const paths = freshProject('exclude-segment')
  const added = addSample(paths, 'x')
  const recorded = recordUse({
    projectPaths: paths,
    materialId: added.material.materialId,
    userText: '结尾那段不要用，另外整体不要发给外部',
    projectVersion: 'v1',
    clock: frozenClock(),
  })
  excludeFromUse({
    projectPaths: paths,
    useId: recorded.use.useId,
    exclusions: [{ kind: 'segment', label: '结尾 3 秒' }, { kind: 'segment', label: '片头 logo' }],
    projectVersion: 'v2',
    clock: frozenClock(),
  })
  const catalog = readMaterialsCatalog(paths)

  const named = isAllowedForUse(catalog, {
    materialId: added.material.materialId,
    segmentLabel: '结尾 3 秒',
  })
  assert.equal(named.allowed, false)
  assert.equal(named.code, PermissionCode.EXCLUDED_RANGE)

  const other = isAllowedForUse(catalog, {
    materialId: added.material.materialId,
    segmentLabel: '中间逐格',
  })
  assert.equal(other.allowed, true, '明确指向另一个具名片段时可以使用')

  const all = addSample(paths, 'y')
  const useAll = recordUse({
    projectPaths: paths,
    materialId: all.material.materialId,
    userText: '整个都不要用',
    projectVersion: 'v1',
    clock: frozenClock(),
  })
  excludeFromUse({
    projectPaths: paths,
    useId: useAll.use.useId,
    exclusions: [{ kind: 'all', label: '整体排除' }],
    projectVersion: 'v2',
    clock: frozenClock(),
  })
  const catalog2 = readMaterialsCatalog(paths)
  assert.equal(
    isAllowedForUse(catalog2, { materialId: all.material.materialId }).allowed,
    false,
    '整体排除不依赖调用方声明的范围',
  )
})

test('describeEffectivePermission: restricted rights, unknown rights and limited scopes are distinct', () => {
  const paths = freshProject('permission')
  const restricted = addSample(paths, 'r', { rightsStatus: RightsStatus.RESTRICTED })
  const unknown = addSample(paths, 'u')
  const catalog = readMaterialsCatalog(paths)

  const restrictedResult = describeEffectivePermission(catalog, {
    materialId: restricted.material.materialId,
  })
  assert.equal(restrictedResult.allowed, false)
  assert.equal(restrictedResult.code, PermissionCode.RIGHTS_RESTRICTED)

  const unknownResult = describeEffectivePermission(catalog, { materialId: unknown.material.materialId })
  assert.equal(unknownResult.allowed, true, '权利未知只警告，不阻断使用')
  assert.equal(unknownResult.code, PermissionCode.DEFAULT_PROJECT_USE)
  assert.ok(
    unknownResult.warnings.some((warning) => warning.code === PermissionCode.RIGHTS_UNKNOWN),
    '权利未知必须作为警告暴露出来',
  )
  assert.ok(
    unknownResult.warnings.some((warning) => warning.code === PermissionCode.MATERIAL_NOT_OBSERVED),
    '未观察材料必须警告，不能声称看过内容',
  )

  const scoped = recordUse({
    projectPaths: paths,
    materialId: unknown.material.materialId,
    userText: '只在这个项目的预告片里用',
    limitedScopes: ['预告片'],
    projectVersion: 'v1',
    clock: frozenClock(),
  })
  const catalog2 = readMaterialsCatalog(paths)
  const outside = describeEffectivePermission(catalog2, {
    materialId: unknown.material.materialId,
    scope: '正片',
  })
  assert.equal(outside.allowed, false)
  assert.equal(outside.code, PermissionCode.OUTSIDE_LIMITED_SCOPE)

  const inside = describeEffectivePermission(catalog2, {
    materialId: unknown.material.materialId,
    scope: '预告片',
  })
  assert.equal(inside.allowed, true)
  assert.equal(inside.useId, scoped.use.useId)

  const noScope = describeEffectivePermission(catalog2, { materialId: unknown.material.materialId })
  assert.equal(noScope.partial, true, '限定范围未声明时必须报告“无法确认”')
  assert.equal(noScope.allowed, false, '无法确认限定范围时不得报告可使用')
})

test('describeEffectivePermission: an unrecorded material is never silently allowed', () => {
  const paths = freshProject('unrecorded')
  const catalog = readMaterialsCatalog(paths)
  const result = describeEffectivePermission(catalog, { materialId: newId('material') })
  assert.equal(result.allowed, false)
  assert.equal(result.code, PermissionCode.MATERIAL_NOT_RECORDED)
  assert.equal(result.source, 'default')
})

test('catalog helpers: findMaterial / usesForMaterial / latestUseForMaterial stay consistent', () => {
  const paths = freshProject('helpers')
  const first = addSample(paths, 'a')
  const second = addSample(paths, 'b')
  recordUse({
    projectPaths: paths,
    materialId: first.material.materialId,
    userText: '第一次说明',
    projectVersion: 'v1',
    clock: frozenClock(),
  })
  recordUse({
    projectPaths: paths,
    materialId: first.material.materialId,
    userText: '第二次说明',
    projectVersion: 'v2',
    clock: frozenClock(),
  })
  const catalog = readMaterialsCatalog(paths)

  assert.equal(findMaterial(catalog, first.material.materialId).materialId, first.material.materialId)
  assert.equal(findMaterial(catalog, newId('material')), null)
  assert.equal(usesForMaterial(catalog, first.material.materialId).length, 2)
  assert.equal(usesForMaterial(catalog, second.material.materialId).length, 0)
  assert.equal(latestUseForMaterial(catalog, first.material.materialId).userText, '第二次说明')
  assert.equal(latestUseForMaterial(catalog, second.material.materialId), null)
  assert.deepEqual(emptyMaterialsCatalog('prj_x'), { projectId: 'prj_x', materials: [], uses: [] })
})

test('verifyAvailability: a deleted file is reported as MATERIAL_MISSING', () => {
  const paths = freshProject('missing')
  const added = addSample(paths, 'will be deleted')
  const absolute = paths.resolve(added.material.storedRelativePath)
  fs.rmSync(absolute)

  const result = verifyAvailability({ projectPaths: paths })
  assert.equal(result.ok, false)
  assert.equal(result.checked, 1)
  assert.deepEqual(result.needsAttention, [NeedsAttentionCode.MATERIAL_MISSING])
  assert.equal(result.items[0].available, false)
  assert.equal(result.items[0].code, NeedsAttentionCode.MATERIAL_MISSING)
  assert.match(result.items[0].reason, /不存在/)
  assert.equal(result.items[0].actualSha256, null)
})

test('verifyAvailability: mutated bytes are reported as MATERIAL_HASH_MISMATCH', () => {
  const paths = freshProject('mutated')
  const added = addSample(paths, 'original content')
  const absolute = paths.resolve(added.material.storedRelativePath)
  fs.writeFileSync(absolute, 'tampered content', 'utf8')

  const result = verifyAvailability({ projectPaths: paths })
  assert.equal(result.ok, false)
  assert.equal(result.items[0].code, NeedsAttentionCode.MATERIAL_HASH_MISMATCH)
  assert.notEqual(result.items[0].actualSha256, result.items[0].expectedSha256)
  assert.equal(result.items[0].actualSha256, fileSha256(absolute))
  assert.match(result.items[0].reason, /哈希/)
})

test('verifyAvailability: an intact material is available, and a real check changes nothing', () => {
  const paths = freshProject('available')
  const added = addSample(paths, 'intact bytes')
  const before = readMaterialsCatalog(paths)
  const result = verifyAvailability({ projectPaths: paths })
  const after = readMaterialsCatalog(paths)

  assert.equal(result.ok, true)
  assert.equal(result.items[0].available, true)
  assert.equal(result.items[0].code, null)
  assert.equal(result.items[0].actualSha256, added.material.contentSha256)
  assert.equal(after.revision, before.revision, '只读检查不得改写材料清单')
  assert.equal(after.materials[0].observation, MaterialObservation.UNREAD, '检查不得升级观察状态')
})

test('verifyAvailability: a record with an unusable path is reported, not crashed on', () => {
  const paths = freshProject('unreadable')
  const added = addSample(paths, 'x')
  const catalog = {
    materials: [{ ...added.material, storedRelativePath: '' }],
    uses: [],
  }
  const result = verifyAvailability({ projectPaths: paths, catalog })
  assert.equal(result.items[0].available, false)
  assert.equal(result.items[0].code, NeedsAttentionCode.MATERIAL_MISSING)
})

test('verifyAvailability: record:true appends MATERIAL_MISSING events, once per problem', () => {
  const paths = freshProject('record-missing')
  const added = addSample(paths, 'gone')
  fs.rmSync(paths.resolve(added.material.storedRelativePath))

  const result = verifyAvailability({ projectPaths: paths, record: true, clock: frozenClock() })
  assert.equal(result.ok, false)
  const { events } = readEvents(paths.dir, { kinds: [ProjectEventKind.MATERIAL_MISSING] })
  assert.equal(events.length, 1)
  assert.equal(events[0].objectId, added.material.materialId)
  assert.equal(events[0].detail.code, NeedsAttentionCode.MATERIAL_MISSING)
})

test('event log: adding, recording, amending and excluding each leave a real entry', () => {
  const paths = freshProject('events')
  const added = addSample(paths, 'x')
  const recorded = recordUse({
    projectPaths: paths,
    materialId: added.material.materialId,
    userText: '只用于片头',
    projectVersion: 'v1',
    clock: frozenClock(),
  })
  amendUse({
    projectPaths: paths,
    useId: recorded.use.useId,
    allowedUses: ['片头'],
    projectVersion: 'v2',
    clock: frozenClock(),
  })
  excludeFromUse({
    projectPaths: paths,
    useId: recorded.use.useId,
    exclusions: [{ kind: 'range', start: 0, end: 2 }],
    projectVersion: 'v3',
    clock: frozenClock(),
  })

  const { events, skipped } = readEvents(paths.dir, { limit: 100 })
  assert.deepEqual(skipped, [], '事件日志不得出现无法解析的行')
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      ProjectEventKind.MATERIAL_ADDED,
      ProjectEventKind.MATERIAL_USE_RECORDED,
      ProjectEventKind.MATERIAL_USE_AMENDED,
      ProjectEventKind.MATERIAL_USE_AMENDED,
      ProjectEventKind.MATERIAL_EXCLUDED,
    ],
  )
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4, 5],
    '事件序列必须单调递增，append-only 才可追溯',
  )
  for (const event of events) {
    assert.equal(event.projectId, paths.projectId)
    assert.equal(event.actor, 'user')
    assert.equal(typeof event.at, 'string')
    assert.ok(event.at.length > 0)
  }
  assert.equal(events[0].objectId, added.material.materialId)
  assert.equal(events[1].objectId, recorded.use.useId)
  assert.equal(events[1].detail.userText, '只用于片头', '事件里也要留下用户原文')
})

test('concurrent write: a second writer on a stale revision is refused', () => {
  const paths = freshProject('conflict')
  const first = addSample(paths, 'first')
  const readA = readMaterialsCatalog(paths)
  assert.equal(readA.materials.length, 1)

  // Writer B publishes based on the revision both readers saw.
  const written = writeMaterialsCatalog(
    paths,
    {
      materials: readA.materials.map((material) =>
        material.materialId === first.material.materialId
          ? { ...material, note: 'B 的修改' }
          : material,
      ),
      uses: readA.uses,
    },
    { expectedRevision: readA.revision, clock: frozenClock() },
  )
  assert.notEqual(written.revision, readA.revision)

  // Writer A still holds the OLD revision; it must be refused, not allowed to overwrite B.
  assert.throws(
    () =>
      writeMaterialsCatalog(
        paths,
        { materials: [], uses: [] },
        { expectedRevision: readA.revision, clock: frozenClock() },
      ),
    { code: 'VERSION_CONFLICT' },
  )

  const after = readMaterialsCatalog(paths)
  assert.equal(after.revision, written.revision, '被拒绝的写入不得改变磁盘上的清单')
  assert.equal(after.materials.length, 1)
  assert.equal(after.materials[0].note, 'B 的修改', 'B 的结果必须保留')
})

test('concurrent write: baseRevision on addMaterial refuses a stale snapshot', () => {
  const paths = freshProject('base-revision')
  const added = addSample(paths, 'first')
  const stale = readMaterialsCatalog(paths).revision
  assert.equal(stale.length > 0, true)

  addSample(paths, 'second')

  assert.throws(() => addSample(paths, 'third', { baseRevision: stale }), {
    code: 'VERSION_CONFLICT',
  })
  // The refused attempt left no phantom material behind.
  const catalog = readMaterialsCatalog(paths)
  assert.equal(catalog.materials.length, 2)
  assert.ok(catalog.materials.some((material) => material.materialId === added.material.materialId))
})

test('writeMaterialsCatalog: writing an existing catalog without a revision is refused', () => {
  const paths = freshProject('require-revision')
  addSample(paths, 'x')
  assert.throws(
    () => writeMaterialsCatalog(paths, { materials: [], uses: [] }),
    { code: 'VALIDATION_FAILED' },
    '覆盖既有清单必须声明基于的修订',
  )
  assert.equal(readMaterialsCatalog(paths).materials.length, 1)
})

test('project isolation: a catalog copied into another project is not read as that project', () => {
  const first = freshProject('isolate-a')
  const second = freshProject('isolate-b')
  addSample(first, 'x')
  const source = materialsIndexPath(first)
  const target = materialsIndexPath(second)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)

  assert.throws(() => readMaterialsCatalog(second), { code: 'CORRUPT_DATA' })
})

test('materialStorageRelativePath: the id is validated before it can reach the filesystem', () => {
  assert.equal(
    materialStorageRelativePath('mat_0123456789ABCDEF', 'a.PNG'),
    'materials/files/mat_0123456789ABCDEF/content.png',
  )
  assert.equal(materialStorageRelativePath('mat_0123456789ABCDEF', 'no-extension'), 'materials/files/mat_0123456789ABCDEF/content')
  assert.equal(materialStorageRelativePath('mat_0123456789ABCDEF', 'x.evil-name'), 'materials/files/mat_0123456789ABCDEF/content')
  assert.throws(() => materialStorageRelativePath('../../etc/passwd', 'a.png'), {
    code: 'VALIDATION_FAILED',
  })
})

test('empty catalog: a project with no index file reads as empty, not as an error', () => {
  const paths = freshProject('empty')
  const catalog = readMaterialsCatalog(paths)
  assert.equal(catalog.exists, false)
  assert.deepEqual(catalog.materials, [])
  assert.deepEqual(catalog.uses, [])
  assert.equal(catalog.revision, '')
  assert.equal(fs.existsSync(materialsIndexPath(paths)), false, '只读不得创建清单文件')
})

test('original filename metadata survives a fresh read from disk', () => {
  const paths = freshProject('fresh-read')
  const added = addSample(paths, 'persisted', { originalFilename: '镜头 A 原图.jpg', kind: 'image' })
  const catalog = readMaterialsCatalog(paths)

  assert.equal(catalog.materials.length, 1)
  assert.equal(catalog.materials[0].materialId, added.material.materialId)
  assert.equal(catalog.materials[0].originalFilename, '镜头 A 原图.jpg')
  assert.equal(catalog.materials[0].contentSha256, added.material.contentSha256)
  assert.equal(catalog.materials[0].byteSize, added.material.byteSize)
  assert.equal(catalog.materials[0].addedAt, frozenClock().iso())
})
