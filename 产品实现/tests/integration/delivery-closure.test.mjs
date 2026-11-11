/**
 * Integration tests for closure, cleanup, archiving and permanent deletion.
 *
 * The rule under test is that nothing is deleted before the user answered, and that a failed export
 * or a missing material stops the whole cleanup — not just a message in the log. The success path
 * runs a real export first, then deletes only the confirmed scope.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openProject, PROJECT_LAYOUT } from '../../core/project/index.js'
import {
  createDeliveryKit,
  declareSpec,
  evaluateClosure,
  executeDelivery,
  planCleanupScope,
  planDelivery,
  permanentlyDeleteProject,
} from '../../delivery/index.js'
import { availableFont, availableToolchain, createFinalizedProject, fixedClock, makeWorkspace } from '../delivery-test-helpers.mjs'

/**
 * Build the closure evaluation for a project with an optional delivery.
 * @param {any} project from `createFinalizedProject`
 * @param {any} delivery executed delivery record or null
 * @param {any} extra
 */
function evaluate(project, delivery, extra = {}) {
  return evaluateClosure({
    finalVersion: project.finalVersion,
    plan: project.plan,
    projectFiles: { materials: [], fonts: [] },
    delivery,
    effects: [],
    effectDecisions: [],
    scope: null,
    confirmation: null,
    cleanup: null,
    ...extra,
  })
}

test('a failed export blocks delivery and cleanup: no scope can even be generated', (t) => {
  const root = makeWorkspace(t, 'closure-block')
  const clock = fixedClock()
  const project = createFinalizedProject({ root, fontFile: availableFont() ?? path.join('fonts', 'arial.ttf'), clock })
  const kit = createDeliveryKit({ paths: project.paths, clock })
  const failedDelivery = {
    deliveryId: 'dlv_failed',
    state: 'failed',
    items: [
      { itemId: 'itm_master', kind: 'video', specId: 'master', state: 'failed', failure: { code: 'RENDER_FAILED' } },
    ],
  }
  const evaluation = evaluate(project, failedDelivery)
  assert.equal(evaluation.steps.find((step) => step.id === 'finalized').status, 'passed')
  assert.equal(evaluation.steps.find((step) => step.id === 'delivered').status, 'blocked')
  assert.equal(evaluation.readyToClean, false)

  kit.closure.open({ finalVersionId: project.finalVersion.versionId, deliveryId: failedDelivery.deliveryId })
  const scope = planCleanupScope({ paths: project.paths, versions: project.versions, clock })
  assert.throws(
    () => kit.closure.setScope(scope),
    /前四步尚未全部通过/,
    '导出失败时不得生成可执行的清理范围',
  )
  assert.throws(() => kit.closure.executeCleanup({ decisions: project.decisions }), /不能执行清理/)
})

test('the full sequence deletes only the confirmed scope and keeps the editable engineering', async (t) => {
  const toolchain = availableToolchain()
  const fontFile = availableFont()
  if (toolchain === null || fontFile === null) {
    t.skip('本机没有可用的 FFmpeg/字体，完整结项测试跳过')
    return
  }
  const root = makeWorkspace(t, 'closure-full')
  const clock = fixedClock()
  const project = createFinalizedProject({ root, fontFile, clock })
  const kit = createDeliveryKit({ paths: project.paths, clock, toolchain })
  const planned = planDelivery({
    paths: project.paths,
    versions: project.versions,
    finalVersion: project.finalVersion,
    specs: [declareSpec({ specId: 'master' })],
    store: kit.store,
    clock,
  })
  const delivered = executeDelivery({
    paths: project.paths,
    store: kit.store,
    exporter: kit.exporter,
    deliveryId: planned.deliveryId,
    finalVersion: project.finalVersion,
    clock,
  })
  assert.equal(delivered.state, 'complete')

  // Work caches that a cleanup may remove.
  fs.mkdirSync(path.join(project.paths.dir, 'work', 'scratch'), { recursive: true })
  fs.writeFileSync(path.join(project.paths.dir, 'work', 'scratch', 'intermediate.bin'), 'x'.repeat(1024))

  const scope = planCleanupScope({ paths: project.paths, versions: project.versions, clock, effectReferences: [] })
  assert.ok(scope.remove.some((entry) => entry.path === 'work'))
  const evaluation = evaluate(project, delivered, {
    verifyItem: (item) => kit.exporter.verifyDeliveredItem(item),
    scope,
  })
  assert.equal(evaluation.readyToClean, true)

  kit.closure.open({ finalVersionId: project.finalVersion.versionId, deliveryId: delivered.deliveryId })
  assert.throws(() => kit.closure.executeCleanup({ decisions: project.decisions }), /不能执行清理/)
  kit.closure.setScope(scope, { readyToClean: evaluation.readyToClean })
  assert.throws(() => kit.closure.executeCleanup({ decisions: project.decisions }), /还没有得到用户明确确认/)
  assert.throws(() => kit.closure.confirmScope({ decisions: project.decisions, humanResponse: '   ' }), /不能为空/)
  const closure = kit.closure.confirmScope({ decisions: project.decisions, humanResponse: '按这个范围清理：只删 work 缓存' })
  assert.equal(typeof closure.confirmation.confirmationId, 'string')
  assert.equal(closure.confirmation.scopeDigest, scope.digest)

  const cleanup = kit.closure.executeCleanup({ decisions: project.decisions })
  assert.equal(cleanup.failures.length, 0)
  assert.ok(cleanup.deleted.length >= 1)
  assert.equal(cleanup.noRecoveryEntry, true)
  assert.equal(fs.existsSync(path.join(project.paths.dir, 'work')), false)
  // Protected things survive.
  for (const relative of [PROJECT_LAYOUT.projectFile, PROJECT_LAYOUT.versionsIndex, 'editing/plans', PROJECT_LAYOUT.recipesDir]) {
    assert.equal(fs.existsSync(project.paths.resolve(relative)), true, `${relative} 必须保留`)
  }
  assert.equal(fs.existsSync(project.paths.resolve(`delivery/outputs`)), true, '交付物必须保留')
  assert.equal(kit.store.list().length, 1, '交付记录必须保留')

  // A changed scope invalidates the earlier confirmation.
  const scopeAgain = planCleanupScope({ paths: project.paths, versions: project.versions, clock })
  kit.closure.setScope(scopeAgain, { readyToClean: true })
  assert.equal(kit.closure.active().confirmation, null)
  assert.throws(() => kit.closure.executeCleanup({ decisions: project.decisions }), /还没有得到用户明确确认/)

  // Closing the sequence: archive, then recycle bin, then restore.
  const current = openProject({ projectsRoot: root, projectId: project.paths.projectId, clock })
  const archived = kit.closure.changePhase({ projectsRoot: root, to: 'archived', expectedRevision: current.revision })
  assert.equal(archived.to, 'archived')
  const reread = openProject({ projectsRoot: root, projectId: project.paths.projectId, clock })
  const trashed = kit.closure.changePhase({ projectsRoot: root, to: 'recycle-bin', expectedRevision: reread.revision })
  assert.equal(trashed.to, 'recycle-bin')
  assert.equal(reread.project.phase, 'archived')
  const trashedProject = openProject({ projectsRoot: root, projectId: project.paths.projectId, clock })
  assert.equal(trashedProject.project.phase, 'recycle-bin')
  const restored = kit.closure.restore({ projectsRoot: root, expectedRevision: trashedProject.revision })
  assert.equal(restored.project.phase, 'archived', '回收区可恢复，不删除内容')
})

test('permanent deletion needs the recycle bin, a second user confirmation and no shared effect reference', (t) => {
  const root = makeWorkspace(t, 'delete-permanent')
  const clock = fixedClock()
  const project = createFinalizedProject({ root, fontFile: availableFont() ?? path.join('fonts', 'arial.ttf'), clock })
  const kit = createDeliveryKit({ paths: project.paths, clock })
  const tombstoneDir = path.join(root, 'tombstones')

  assert.throws(
    () => permanentlyDeleteProject({
      projectsRoot: root,
      projectId: project.paths.projectId,
      decisions: project.decisions,
      confirmationId: project.confirmation.confirmationId,
    }),
    /回收区/,
  )

  const revision = openProject({ projectsRoot: root, projectId: project.paths.projectId, clock }).revision
  kit.closure.changePhase({ projectsRoot: root, to: 'recycle-bin', expectedRevision: revision })
  assert.equal(openProject({ projectsRoot: root, projectId: project.paths.projectId, clock }).project.phase, 'recycle-bin')

  // The finalize confirmation is not a deletion confirmation: wrong object id.
  assert.throws(
    () => permanentlyDeleteProject({
      projectsRoot: root,
      projectId: project.paths.projectId,
      decisions: project.decisions,
      confirmationId: project.confirmation.confirmationId,
    }),
    /不是这次永久删除/,
  )

  const deletionConfirmation = project.decisions.recordConfirmation({
    actor: 'user',
    objectId: `project:${project.paths.projectId}:deletion`,
    aspect: 'cleanup',
    scope: 'whole',
    versionId: project.finalVersion.versionId,
    state: 'confirmed',
    humanResponse: '用户第二次确认：永久删除这个隔离测试项目',
  })

  assert.throws(
    () => permanentlyDeleteProject({
      projectsRoot: root,
      projectId: project.paths.projectId,
      decisions: project.decisions,
      confirmationId: deletionConfirmation.confirmationId,
      effectReferences: [{ effectId: 'efx_shared', version: '1.0.0' }],
      tombstoneDir,
    }),
    /仍被正式效果引用/,
  )

  const result = permanentlyDeleteProject({
    projectsRoot: root,
    projectId: project.paths.projectId,
    decisions: project.decisions,
    confirmationId: deletionConfirmation.confirmationId,
    effectReferences: [],
    tombstoneDir,
  })
  assert.equal(result.deleted, true)
  assert.equal(fs.existsSync(project.paths.dir), false, '项目目录已删除')
  assert.equal(typeof result.tombstone, 'string')
  assert.equal(fs.existsSync(result.tombstone), true, '删除记录写在项目根目录之外')
  const tombstone = JSON.parse(fs.readFileSync(result.tombstone, 'utf8'))
  assert.equal(tombstone.confirmationId, deletionConfirmation.confirmationId)
  assert.equal(tombstone.projectId, project.paths.projectId)
  assert.match(tombstone.note, /第二次确认/)
})

test('missing final engineering blocks the closure before any scope exists', (t) => {
  const root = makeWorkspace(t, 'closure-missing')
  const clock = fixedClock()
  const project = createFinalizedProject({ root, fontFile: availableFont() ?? path.join('fonts', 'arial.ttf'), clock })
  const kit = createDeliveryKit({ paths: project.paths, clock })
  const delivery = {
    deliveryId: 'dlv_ok',
    state: 'complete',
    items: [{
      itemId: 'itm_master',
      kind: 'video',
      specId: 'master',
      state: 'exported',
      file: { path: path.join(root, 'x.mp4') },
      spec: { width: 640, height: 360 },
    }],
  }
  const missingMaterial = evaluate(project, delivery, {
    projectFiles: { materials: [{ file: 'materials/files/mat_x/photo.png', exists: false }], fonts: [] },
    verifyItem: () => ({ ok: true, reason: null }),
  })
  assert.equal(missingMaterial.steps.find((step) => step.id === 'final-project').status, 'blocked')
  assert.equal(missingMaterial.readyToClean, false)
  kit.closure.open({ finalVersionId: project.finalVersion.versionId, deliveryId: delivery.deliveryId })
  assert.throws(
    () => kit.closure.setScope(
      planCleanupScope({ paths: project.paths, versions: project.versions, clock }),
      { readyToClean: missingMaterial.readyToClean },
    ),
    /前四步/,
  )
})
