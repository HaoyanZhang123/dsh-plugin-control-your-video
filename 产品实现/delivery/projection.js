/**
 * A read-only `delivery.projection` published into the project's own event stream.
 *
 * The shell can already read `/projects/events`, and C15 may not add a host route (that surface
 * belongs to C11). So the delivery/effects surface gets the same mechanism C13 and C14 used: ONE
 * bounded projection event rebuilt from the real documents, carrying the revisions it was built from.
 *
 * It contains file NAMES and sizes, not absolute paths, and never a token or a private note: a
 * projection is a cache with provenance, and a path that nobody needs is a path that should not be
 * copied. The surface is read-only; no export, confirmation or cleanup is triggered by reading it.
 *
 * @module delivery/projection
 */

import { Clock, ValidationError } from '../base/index.js'
import { appendEvents, buildEvent, tryReadDocument, PROJECT_LAYOUT } from '../core/project/index.js'
import { DELIVERY_LAYOUT, DELIVERY_LIMITS, DeliveryState, ItemKind, ItemState, clip } from './ids.js'

/** Event kind the client bundle matches. Stable because the client compares it. */
export const DELIVERY_PROJECTION_KIND = 'delivery.projection'

/** Version of the projection payload shape. */
export const DELIVERY_PROJECTION_VERSION = 1

/** Bounded sizes: a projection summarises, it does not copy the project. */
export const DELIVERY_PROJECTION_LIMITS = Object.freeze({
  deliveries: 4,
  itemsPerDelivery: 12,
  packages: 4,
  effects: 8,
  references: 8,
})

/** @param {unknown} value @param {number} [length] */
function line(value, length = 160) {
  return clip(value, length)
}

/** @param {unknown} value @returns {number|null} */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Build the projection from the documents as they are on disk right now.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.finalVersion] C10 final version (the projection shows it, it does not create it)
 * @param {any[]} [input.deliveries] delivery records, newest first
 * @param {any[]} [input.packages] package records
 * @param {any} [input.closure] newest closure record or null
 * @param {any} [input.closureSteps] result of `evaluateClosure` when the caller computed it
 * @param {any} [input.effects] effect library snapshot (bounded, read-only)
 * @param {any} [input.clock]
 * @returns {any}
 */
export function buildDeliveryProjection(input = {}) {
  const paths = input?.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('交付投影需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const deliveries = Array.isArray(input.deliveries) ? [...input.deliveries] : []
  deliveries.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
  const packages = Array.isArray(input.packages) ? [...input.packages] : []
  packages.sort((left, right) => String(right.exportedAt ?? right.importedAt ?? '')
    .localeCompare(String(left.exportedAt ?? left.importedAt ?? '')))
  const finalVersion = input.finalVersion ?? null
  const closure = input.closure ?? null
  const effects = input.effects ?? null

  const revisionOf = (relative, kind) => {
    const stored = tryReadDocument(paths.resolve(relative), { kind })
    return stored === null ? null : stored.revision
  }

  const itemView = (item) => ({
    itemId: item.itemId,
    specId: item.specId,
    kind: item.kind,
    label: line(item.label, 80),
    state: item.state,
    fileName: typeof item.file?.path === 'string' ? item.file.path.split(/[\\/]/).slice(-1)[0] : null,
    // Absolute directories are not copied into the event log; the UI asks the user for the folder.
    location: typeof item.file?.relative === 'string' ? item.file.relative : null,
    external: typeof item.file?.relative !== 'string' && typeof item.file?.path === 'string',
    bytes: num(item.file?.bytes),
    sha256: typeof item.file?.sha256 === 'string' ? item.file.sha256 : null,
    width: num(item.spec?.width) ?? num(item.spec?.probed?.width),
    height: num(item.spec?.height) ?? num(item.spec?.probed?.height),
    durationSeconds: num(item.spec?.probed?.durationSeconds),
    fps: item.spec?.fps ?? null,
    checks: Array.isArray(item.checks)
      ? item.checks.map((check) => ({ id: check.id, status: check.status, detail: line(check.detail, 140) }))
      : [],
    checksOk: item.checksOk === true,
    failure: item.failure === null || item.failure === undefined
      ? null
      : { code: item.failure.code, message: line(item.failure.message, 160) },
    adaptation: item.adaptation === null || item.adaptation === undefined
      ? null
      : {
          from: item.adaptation.from,
          to: item.adaptation.to,
          uniform: item.adaptation.uniform === true,
          notAStretch: item.adaptation.notAStretch === true,
          moves: num(item.adaptation.layout?.moves),
          resizes: num(item.adaptation.layout?.resizes),
          rewraps: num(item.adaptation.layout?.rewraps),
          preservedDuration: item.adaptation.preserved?.durationFrames?.identical === true,
          preservedAudio: item.adaptation.preserved?.audio?.identical === true,
        },
    notes: Array.isArray(item.notes) ? item.notes.slice(0, 3).map((note) => line(note, 140)) : [],
  })

  return {
    projectionVersion: DELIVERY_PROJECTION_VERSION,
    generatedAt: clock.iso(),
    projectId: paths.projectId,
    finalVersion: finalVersion === null
      ? null
      : {
          versionId: finalVersion.versionId,
          label: line(finalVersion.label, 80),
          createdAt: finalVersion.createdAt,
          confirmationRef: finalVersion.confirmationRef ?? null,
        },
    deliveries: deliveries.slice(0, DELIVERY_PROJECTION_LIMITS.deliveries).map((delivery) => ({
      deliveryId: delivery.deliveryId,
      state: delivery.state,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt ?? null,
      finalVersionId: delivery.finalVersionId ?? null,
      policy: delivery.policy ?? null,
      counts: delivery.counts ?? null,
      items: (Array.isArray(delivery.items) ? delivery.items : [])
        .slice(0, DELIVERY_PROJECTION_LIMITS.itemsPerDelivery)
        .map(itemView),
    })),
    packages: packages.slice(0, DELIVERY_PROJECTION_LIMITS.packages).map((record) => ({
      packageId: record.packageId,
      direction: record.direction,
      state: record.state,
      formatVersion: record.packageFormatVersion ?? null,
      files: Array.isArray(record.files) ? record.files.length : num(record.files),
      bytes: num(record.totals?.bytes),
      folder: typeof record.packageDir === 'string' ? record.packageDir.split(/[\\/]/).slice(-1)[0] : null,
      at: record.exportedAt ?? record.importedAt ?? null,
    })),
    closure: closure === null
      ? null
      : {
          closureId: closure.closureId,
          status: closure.cleanup !== null ? 'cleaned' : closure.confirmation !== null ? 'confirmed' : 'open',
          steps: Array.isArray(input.closureSteps?.steps)
            ? input.closureSteps.steps.map((step) => ({
                id: step.id,
                status: step.status,
                detail: line(step.detail, 160),
              }))
            : [],
          readyToClean: input.closureSteps?.readyToClean === true,
          nextStep: input.closureSteps?.nextStep ?? null,
          scope: closure.scope === null || closure.scope === undefined
            ? null
            : {
                scopeId: closure.scope.scopeId,
                digest: closure.scope.digest,
                remove: Array.isArray(closure.scope.remove) ? closure.scope.remove.length : 0,
                keep: Array.isArray(closure.scope.keep) ? closure.scope.keep.length : 0,
                totalBytes: num(closure.scope.totalBytes) ?? 0,
                entries: (closure.scope.remove ?? []).slice(0, 12).map((entry) => ({
                  kind: entry.kind,
                  path: line(entry.path, 120),
                  bytes: num(entry.bytes) ?? 0,
                })),
                sharedReferences: (closure.scope.sharedReferences ?? []).slice(0, 6).map((entry) => ({
                  effectId: entry.effectId,
                  version: entry.version,
                  note: line(entry.note, 120),
                })),
              },
          confirmation: closure.confirmation === null || closure.confirmation === undefined
            ? null
            : {
                confirmationId: closure.confirmation.confirmationId,
                humanResponse: line(closure.confirmation.humanResponse, 120),
                at: closure.confirmation.at,
              },
          cleanup: closure.cleanup === null || closure.cleanup === undefined
            ? null
            : {
                at: closure.cleanup.at,
                deleted: Array.isArray(closure.cleanup.deleted) ? closure.cleanup.deleted.length : 0,
                bytesFreed: num(closure.cleanup.bytesFreed) ?? 0,
                failures: Array.isArray(closure.cleanup.failures) ? closure.cleanup.failures.length : 0,
              },
        },
    effects: effects === null
      ? null
      : {
          effects: (effects.effects ?? []).slice(-DELIVERY_PROJECTION_LIMITS.effects).map((effect) => ({
            effectId: effect.effectId,
            name: line(effect.name, 60),
            kind: effect.kind,
            version: effect.version,
            state: effect.state,
            references: num(effect.references) ?? 0,
            reproducedAt: effect.reproducedAt ?? null,
          })),
          references: (effects.references ?? []).slice(-DELIVERY_PROJECTION_LIMITS.references),
          honest: effects.honest ?? null,
        },
    summary: {
      deliveries: deliveries.length,
      complete: deliveries.filter((delivery) => delivery.state === DeliveryState.COMPLETE).length,
      partial: deliveries.filter((delivery) => delivery.state === DeliveryState.PARTIAL).length,
      failed: deliveries.filter((delivery) => delivery.state === DeliveryState.FAILED).length,
      exportedItems: deliveries.reduce(
        (sum, delivery) => sum + (delivery.items ?? []).filter((item) => item.state === ItemState.EXPORTED).length,
        0,
      ),
      videoItems: deliveries.reduce(
        (sum, delivery) => sum + (delivery.items ?? []).filter((item) => item.kind === ItemKind.VIDEO).length,
        0,
      ),
      packages: packages.length,
      closureSteps: closure === null ? 0 : 7,
    },
    honest: {
      readOnly: true,
      interactiveControls: false,
      exportIsNotPublication: true,
      noNetworkAction: true,
      cleanupNeedsUserConfirmation: true,
      note: '只读投影：交付、包、效果与结项数据来自项目事实；导出成功不等于发布，清理必须由用户确认范围后执行',
    },
    aiObservation: {
      viewed: false,
      listened: false,
      note: '本模块不观看也不听辨媒体；程序检查不等于用户验收',
    },
    sources: {
      deliveries: revisionOf(DELIVERY_LAYOUT.index, 'delivery'),
      packages: revisionOf(DELIVERY_LAYOUT.packagesIndex, 'delivery-packages'),
      closure: revisionOf(DELIVERY_LAYOUT.closureIndex, 'delivery-closure'),
      versions: revisionOf(PROJECT_LAYOUT.versionsIndex, 'versions'),
      limits: DELIVERY_LIMITS,
    },
  }
}

/**
 * Publish the projection into the project's append-only event stream.
 * @param {object} input see {@link buildDeliveryProjection}
 * @returns {{ projection: any, event: any }}
 */
export function publishDeliveryProjection(input = {}) {
  const projection = buildDeliveryProjection(input)
  const clock = input.clock ?? new Clock()
  const event = buildEvent({
    kind: DELIVERY_PROJECTION_KIND,
    projectId: projection.projectId,
    actor: 'system',
    detail: projection,
  })
  const appended = appendEvents(input.paths.dir, [event], { clock })
  // The log assigns the sequence; returning the input object without it would leave a caller guessing.
  return { projection, event: { ...event, sequence: appended.lastSequence } }
}

/**
 * The newest projection carried by a list of project events, or `null`.
 * The append-only log's `sequence` decides, never array position.
 * @param {any[]} events
 * @returns {any|null}
 */
export function latestDeliveryProjection(events) {
  if (!Array.isArray(events)) return null
  let latest = null
  let latestSequence = -1
  for (const event of events) {
    if (event?.kind !== DELIVERY_PROJECTION_KIND) continue
    if (event.detail === null || typeof event.detail !== 'object') continue
    const sequence = Number.isInteger(event.sequence) ? event.sequence : Number.MAX_SAFE_INTEGER
    if (sequence >= latestSequence) {
      latestSequence = sequence
      latest = event.detail
    }
  }
  return latest === null ? null : structuredClone(latest)
}
