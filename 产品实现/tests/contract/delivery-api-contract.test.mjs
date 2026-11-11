/**
 * Contract tests for the DELIVERY-EFFECTS public surface.
 *
 * What this layer can prove: the exported names and versions a dependent card may rely on, the
 * declared capability limits, the projection's bounded payload and its honesty flags, and the stable
 * error codes. It does not prove behaviour; the integration tests do that.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import * as delivery from '../../delivery/index.js'
import { createProject, pathsFor } from '../../core/project/index.js'
import { buildDeliveryProjection, latestDeliveryProjection, DELIVERY_PROJECTION_KIND } from '../../delivery/projection.js'
import { availableFont, fixedClock, makeWorkspace } from '../delivery-test-helpers.mjs'

test('the public surface declares its version, capabilities and limits', () => {
  assert.equal(delivery.DELIVERY_INTERFACE_VERSION, '1.0.0')
  const names = Object.keys(delivery)
  for (const required of [
    'createDeliveryKit', 'createDeliveryStore', 'createDeliveryExporter', 'planDelivery', 'executeDelivery',
    'declareSpec', 'declareCoverSpec', 'declareSubtitleSpec', 'declareUnsupportedSpec',
    'exportProjectPackage', 'inspectProjectPackage', 'importProjectPackage', 'listPackageRecords',
    'createEffectLibrary', 'createClosureStore', 'evaluateClosure', 'planCleanupScope', 'permanentlyDeleteProject',
    'publishDeliveryProjection', 'latestDeliveryProjection',
  ]) {
    assert.ok(names.includes(required), `缺少公开接口 ${required}`)
  }
  const capabilityKeys = Object.keys(delivery.DELIVERY_CAPABILITIES)
  assert.deepEqual(capabilityKeys.sort(), ['closure', 'effects', 'export', 'finalize', 'projectPackage', 'projection'])
  for (const [key, capability] of Object.entries(delivery.DELIVERY_CAPABILITIES)) {
    assert.ok(Array.isArray(capability.supported) && capability.supported.length > 0, `${key} 必须声明已支持内容`)
    assert.ok(Array.isArray(capability.limits) && capability.limits.length > 0, `${key} 必须声明边界`)
  }
  assert.equal(delivery.DELIVERY_LIMITS.maxSpecs > 0, true)
  assert.equal(delivery.DELIVERY_LIMITS.maxPackageFiles > 0, true)
  assert.equal(Object.values(delivery.ClosureStep).length, 7)
  assert.equal(Object.values(delivery.DeliveryState).length, 5)
  assert.equal(Object.values(delivery.ItemState).length, 5)
  assert.equal(Object.values(delivery.EffectKind).length, 2)
})

test('a kit without a toolchain still records and evaluates, and never fakes an exporter', (t) => {
  const root = makeWorkspace(t, 'contract-kit')
  const clock = fixedClock()
  const created = createProject({ projectsRoot: root, title: '契约项目', clock })
  const kit = delivery.createDeliveryKit({ paths: created.paths, clock })
  assert.equal(kit.interfaceVersion, delivery.DELIVERY_INTERFACE_VERSION)
  assert.equal(kit.exporter, null, '没有工具链就不能有导出器')
  assert.equal(kit.effects, null, '没有效果库根目录就不能有库')
  assert.equal(typeof kit.store.list, 'function')
  assert.equal(typeof kit.store.get, 'function')
  assert.equal(typeof kit.closure.open, 'function')
  assert.equal(kit.store.paths.projectId, created.project.projectId)

  const withEffects = delivery.createDeliveryKit({ paths: created.paths, clock, effectsRoot: path.join(root, 'effects') })
  assert.equal(withEffects.effects !== null, true)
  assert.equal(withEffects.effects.describe().effects, 0)
})

test('delivery ids use PROJECT-CORE’s reserved prefix and never a made-up shape', () => {
  const id = delivery.newDeliveryId()
  assert.match(id, /^dlv_[0-9A-HJKMNP-TV-Z]{16}$/)
  assert.throws(() => delivery.assertDeliveryId('dlv-1', 'deliveryId'), /不是合法的交付标识/)
  const effect = delivery.effectIdFor({ projectId: 'prj_A', slug: 'tone', createdAt: '2026-11-10T00:00:00.000Z' })
  assert.match(effect, /^efx_[0-9a-f]{32}$/)
  assert.equal(effect, delivery.effectIdFor({ projectId: 'prj_A', slug: 'tone', createdAt: '2026-11-10T00:00:00.000Z' }))
})

test('the projection is bounded, read-only and carries no absolute path', (t) => {
  const root = makeWorkspace(t, 'contract-projection')
  const clock = fixedClock()
  const created = createProject({ projectsRoot: root, title: '投影项目', clock })
  const paths = pathsFor({ projectsRoot: root, projectId: created.project.projectId })
  const manyItems = Array.from({ length: 20 }, (_, index) => ({
    itemId: `itm_${index}`,
    specId: `s${index}`,
    kind: 'video',
    label: `规格 ${index}`,
    state: 'exported',
    file: { path: path.join(root, 'out', `file-${index}.mp4`), relative: `delivery/outputs/file-${index}.mp4`, bytes: 1000, sha256: 'a'.repeat(64) },
    spec: { width: 640, height: 360 },
    checks: [],
    checksOk: true,
    failure: null,
    adaptation: null,
    notes: [],
  }))
  const deliveries = Array.from({ length: 9 }, (_, index) => ({
    deliveryId: `dlv_X${index}`,
    state: 'complete',
    createdAt: `2026-11-10T00:00:0${index}.000Z`,
    finalVersionId: 'ver_x',
    items: manyItems,
    counts: { total: 20, exported: 20 },
  }))
  const projection = buildDeliveryProjection({
    paths,
    clock,
    finalVersion: { versionId: 'ver_x', label: '定稿', createdAt: '2026-11-10T00:00:00.000Z', confirmationRef: 'cnf_x' },
    deliveries,
    packages: [],
    closure: null,
    effects: { effects: [], references: [], honest: { listeningChannel: false } },
  })
  assert.equal(projection.deliveries.length, delivery.DELIVERY_PROJECTION_LIMITS.deliveries)
  assert.equal(projection.deliveries[0].items.length, delivery.DELIVERY_PROJECTION_LIMITS.itemsPerDelivery)
  assert.equal(projection.honest.readOnly, true)
  assert.equal(projection.honest.exportIsNotPublication, true)
  assert.equal(projection.honest.noNetworkAction, true)
  const serialised = JSON.stringify(projection)
  assert.equal(serialised.includes(root), false, '投影不能复制绝对路径')
  assert.equal(projection.deliveries[0].items[0].fileName, 'file-0.mp4')
  assert.equal(projection.commitment, undefined)
})

test('publishing a projection appends one event and the newest wins by sequence, not position', (t) => {
  const root = makeWorkspace(t, 'contract-publish')
  const clock = fixedClock()
  const created = createProject({ projectsRoot: root, title: '发布项目', clock })
  const paths = pathsFor({ projectsRoot: root, projectId: created.project.projectId })
  const first = delivery.publishDeliveryProjection({ paths, clock, deliveries: [] })
  const second = delivery.publishDeliveryProjection({ paths, clock, deliveries: [] })
  assert.equal(first.event.kind, DELIVERY_PROJECTION_KIND)
  assert.equal(second.event.sequence > first.event.sequence, true)
  const events = [
    { kind: DELIVERY_PROJECTION_KIND, sequence: second.event.sequence, detail: { marker: 'newer' } },
    { kind: DELIVERY_PROJECTION_KIND, sequence: first.event.sequence, detail: { marker: 'older' } },
  ]
  assert.equal(latestDeliveryProjection(events).marker, 'newer')
  assert.equal(latestDeliveryProjection([{ kind: 'other' }]), null)
  assert.equal(latestDeliveryProjection('not-an-array'), null)
})

test('refusals use stable error codes, not prose matching', (t) => {
  const root = makeWorkspace(t, 'contract-errors')
  const clock = fixedClock()
  const created = createProject({ projectsRoot: root, title: '错误项目', clock })
  const fontFile = availableFont() ?? path.join('fonts', 'arial.ttf')
  void fontFile
  try {
    delivery.planDelivery({ paths: created.paths, versions: null, finalVersion: null, specs: [] })
    assert.fail('应该抛出')
  } catch (error) {
    assert.equal(error.code, 'VALIDATION_FAILED')
    assert.equal(error.details.field, 'finalVersion')
  }
  assert.throws(() => delivery.inspectProjectPackage({ packageDir: 'relative/path' }), /绝对目录/)
  assert.throws(
    () => delivery.planDelivery({
      paths: created.paths,
      versions: null,
      finalVersion: { class: 'final', confirmationRef: 'cnf_x' },
      specs: [delivery.declareSpec({ specId: 'a' })],
    }),
    /没有关联的 CompositionPlan/,
  )
  void clock
})
