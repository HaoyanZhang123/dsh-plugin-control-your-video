/**
 * Unit tests for object/range annotations: version binding, aspect honesty and old-reference
 * traceability.
 *
 * Each test writes into a real project directory through C10's document store, because the point is
 * that an annotation can be re-read after the plan moves on — not that a mock remembers it.
 *
 * @module tests/unit/editing-annotations.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createVersionStore } from '../../core/project/versions.js'
import { buildC12UnitPlan, buildC02SourceVariant } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'
import { createAnnotationStore } from '../../editing/annotations.js'
import { writePlanSnapshot } from '../../editing/ids.js'
import { applyDirectIntent } from '../../editing/scope.js'

const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 10, 0, 0, 0) })
const fontFile = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc')
const skip = fs.existsSync(fontFile) ? false : '需要系统中文字体构建 C12 计划；当前环境缺失，如实跳过'
const temp = createTempDir({ label: 'c14-annotations' })
test.after(() => temp.dispose())

/** @returns {object} */
function makeFixture() {
  const projectsRoot = temp.dir('projects')
  const created = createProject({ projectsRoot, title: '批注测试', clock })
  const paths = new ProjectPaths(projectsRoot, created.project.projectId)
  const versions = createVersionStore({ paths, clock })
  const raw = buildC12UnitPlan({ fontFile })
  const base = normalizePlan(raw, { now: () => clock.iso() })
  const current = versions.ensureCurrent({ actor: 'user' })
  const snapshot = writePlanSnapshot({ paths, ownerId: 'annotation-base', plan: base, clock })
  versions.updateCurrentContent({ content: { planRef: snapshot.planRef } }, { actor: 'system' })
  const annotations = createAnnotationStore({ paths, clock })
  return { paths, versions, current, base, annotations, raw }
}

test('an annotation binds object, aspect, range, version and verification', { skip }, () => {
  const fixture = makeFixture()
  const { annotations, base, current } = fixture
  const annotation = annotations.addAnnotation({
    versionId: current.versionId,
    plan: base,
    objectId: 'obj-subtitle-S02',
    aspect: 'text',
    body: '这一句字幕太长，改成两行',
    author: '用户',
  })
  assert.equal(annotation.anchorKind, 'object')
  assert.equal(annotation.objectId, 'obj-subtitle-S02')
  assert.equal(annotation.aspect, 'text')
  assert.equal(annotation.scope, 'object')
  assert.equal(annotation.versionRef.planVerified, true)
  assert.equal(annotation.versionRef.versionId, current.versionId)
  assert.deepEqual(annotation.range, { startFrame: 75, endFrameExclusive: 168 })
  assert.equal(annotation.status, 'open')
})

test('an old annotation still relocates the object it referred to and reports the change', { skip }, () => {
  const fixture = makeFixture()
  const { annotations, base } = fixture
  const annotation = annotations.addAnnotation({
    versionId: fixture.current.versionId,
    plan: base,
    objectId: 'obj-subtitle-S02',
    aspect: 'text',
    body: '先记下这一版',
    author: '用户',
  })
  const edited = applyDirectIntent({
    plan: base,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '改过的字幕' },
  }).plan
  const reopened = annotations.reopenReference(annotation.annotationId, edited)
  assert.equal(reopened.objectPresent, true)
  assert.equal(reopened.stillMatches, false)
  assert.ok(reopened.fieldsChanged.includes('params'))
  assert.equal(reopened.historicalVersionId, annotation.versionId)
})

test('a time range beyond the film is refused, not clamped', { skip }, () => {
  const fixture = makeFixture()
  assert.throws(
    () => fixture.annotations.addAnnotation({
      versionId: fixture.current.versionId,
      plan: fixture.base,
      objectId: 'obj-subtitle-S02',
      aspect: 'timing',
      range: { startFrame: 0, endFrameExclusive: fixture.base.timebase.totalFrames + 10 },
      body: '超出整片',
      author: '用户',
    }),
    /超出整片/,
  )
})

test('a plan that is not the version snapshot cannot be annotated as that version', { skip }, () => {
  const fixture = makeFixture()
  const other = applyDirectIntent({
    plan: fixture.base,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S01', text: '另一版' },
  }).plan
  assert.throws(
    () => fixture.annotations.addAnnotation({
      versionId: fixture.current.versionId,
      plan: other,
      objectId: 'obj-subtitle-S02',
      aspect: 'text',
      body: '拿错版本',
      author: '用户',
    }),
    /不是该版本的快照/,
  )
})

test('a whole-film note uses the movie anchor and still records a range', { skip }, () => {
  const fixture = makeFixture()
  const annotation = fixture.annotations.addAnnotation({
    versionId: fixture.current.versionId,
    plan: fixture.base,
    objectId: 'movie',
    aspect: 'whole-film',
    scope: 'whole',
    range: { startFrame: 0, endFrameExclusive: fixture.base.timebase.totalFrames },
    body: '整片节奏偏慢',
    author: '用户',
  })
  assert.equal(annotation.anchorKind, 'movie')
  assert.equal(annotation.scope, 'whole')
  assert.equal(annotation.range.startFrame, 0)
})

test('a flattened video exposes clip/range/region only, never internal native objects', { skip }, () => {
  const fixture = makeFixture()
  const flattened = JSON.parse(JSON.stringify(fixture.base))
  const object = flattened.objects.find((entry) => entry.id === 'obj-existing-video')
  object.kind = 'flattened-video'
  object.editableProps = ['startFrame', 'durationFrames']
  object.params = {}
  object.hitTest = 'rect'
  const plan = normalizePlan(flattened, { now: () => clock.iso() })
  const snapshot = writePlanSnapshot({ paths: fixture.paths, ownerId: 'flattened-plan', plan, clock })
  fixture.versions.updateCurrentContent({ content: { planRef: snapshot.planRef } }, { actor: 'system' })
  const versionId = fixture.versions.getCurrent().versionId
  assert.throws(
    () => fixture.annotations.addAnnotation({
      versionId,
      plan,
      objectId: 'obj-existing-video',
      aspect: 'text',
      body: '这一段人物表情不好',
      author: '用户',
    }),
    /不能这样批注/,
  )
  assert.throws(
    () => fixture.annotations.addAnnotation({
      versionId,
      plan,
      objectId: 'obj-existing-video',
      aspect: 'flattened-clip',
      range: { startFrame: 130, endFrameExclusive: 200 },
      body: '这一段',
      author: '用户',
    }),
    /需要明确的画面区域/,
  )
  const annotation = fixture.annotations.addAnnotation({
    versionId,
    plan,
    objectId: 'obj-existing-video',
    aspect: 'flattened-clip',
    range: { startFrame: 130, endFrameExclusive: 200 },
    region: { x: 100, y: 100, width: 400, height: 300 },
    body: '这一段的区域颜色偏灰',
    author: '用户',
  })
  assert.equal(annotation.anchorKind, 'flattened-clip')
  assert.equal(annotation.flattened.internalObjects, 0)
  assert.deepEqual(annotation.flattened.selectable, ['clip', 'time-range', 'region'])
  assert.equal(annotation.region.width, 400)
})

test('a Canvas object is region-addressable only, and a region is required', { skip }, () => {
  const fixture = makeFixture()
  const canvasPlan = normalizePlan(buildC02SourceVariant(fixture.raw), { now: () => clock.iso() })
  const snapshot = writePlanSnapshot({ paths: fixture.paths, ownerId: 'canvas-plan', plan: canvasPlan, clock })
  fixture.versions.updateCurrentContent({ content: { planRef: snapshot.planRef } }, { actor: 'system' })
  const versionId = fixture.versions.getCurrent().versionId
  assert.throws(
    () => fixture.annotations.addAnnotation({
      versionId,
      plan: canvasPlan,
      objectId: 'obj-canvas-motion',
      aspect: 'text',
      body: '逐字改',
      author: '用户',
    }),
    /不能这样批注/,
  )
  assert.throws(
    () => fixture.annotations.addAnnotation({
      versionId,
      plan: canvasPlan,
      objectId: 'obj-canvas-motion',
      aspect: 'canvas-region',
      range: { startFrame: 10, endFrameExclusive: 50 },
      body: '区域太亮',
      author: '用户',
    }),
    /需要明确的画面区域/,
  )
  const annotation = fixture.annotations.addAnnotation({
    versionId,
    plan: canvasPlan,
    objectId: 'obj-canvas-motion',
    aspect: 'canvas-region',
    range: { startFrame: 10, endFrameExclusive: 50 },
    region: { x: 820, y: 100, width: 300, height: 200 },
    body: '区域太亮',
    author: '用户',
  })
  assert.equal(annotation.anchorKind, 'canvas-region')
})

test('reply and status are discussion state, not confirmation', { skip }, () => {
  const fixture = makeFixture()
  const annotation = fixture.annotations.addAnnotation({
    versionId: fixture.current.versionId,
    plan: fixture.base,
    objectId: 'obj-sceneA-title',
    aspect: 'text',
    body: '标题换一句',
    author: '用户',
  })
  const replied = fixture.annotations.addReply({
    annotationId: annotation.annotationId,
    text: '改成「同一条时间线」的另一个说法',
    author: '助手',
    actor: 'ai',
  })
  assert.equal(replied.replies.length, 1)
  const resolved = fixture.annotations.setStatus({
    annotationId: annotation.annotationId,
    status: 'resolved',
    note: '已在新候选处理',
    actor: 'user',
  })
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.resolution.by, 'user')
  assert.equal(fixture.annotations.listAnnotations({ status: 'open' }).length, 0)
})
