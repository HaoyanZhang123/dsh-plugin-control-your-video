/**
 * A read-only projection of the creation domain, published into the project's own event stream.
 *
 * Why this exists: the workbench shell can already read `/projects/events`, and nothing else that
 * looks like C13 facts. Rather than adding a second fact source or a new host route, C13 summarises
 * its own documents into ONE bounded event (`creation.projection`) whenever something meaningful
 * changed. The summary carries the source revisions it was built from, so a stale projection is
 * detectable instead of silently authoritative — it is a cache with provenance, never the truth.
 *
 * @module orchestration/projection
 */

import { Clock, ValidationError } from '../base/index.js'
import { appendEvents, buildEvent } from '../core/project/events.js'
import { ORCH_DOCUMENT, OrchestrationDocument } from './ids.js'
import { CreationBrief } from './brief.js'
import { DirectionSet, PlanBaseline } from './direction.js'
import { UnitRegistry } from './units.js'
import { PreviewSurface } from './preview.js'
import { VistaLedger } from './vista.js'

/** Event kind C13 publishes for the shell to read. Stable: the client matches on it. */
export const CREATION_PROJECTION_KIND = 'creation.projection'

/** Version of the projection payload shape. */
export const CREATION_PROJECTION_VERSION = 1

/** Bounded sizes: a projection is a summary, not a copy of the project. */
export const PROJECTION_LIMITS = Object.freeze({
  entriesPerBucket: 3,
  directions: 5,
  units: 6,
  items: 10,
  staleRanges: 4,
})

/**
 * Build the projection from the documents as they are on disk right now.
 *
 * Every section is optional: a project that has no direction yet says so, rather than showing an
 * empty card that looks like a failure.
 *
 * @param {object} input
 * @param {any} input.paths C10 `ProjectPaths`
 * @param {any} [input.clock]
 * @param {string} [input.currentPlanVersion] the plan the surface is looking at, when known
 * @returns {any}
 */
export function buildCreationProjection(input = {}) {
  const paths = input.paths
  if (paths === null || typeof paths !== 'object' || typeof paths.resolve !== 'function') {
    throw new ValidationError('投影需要项目路径（ProjectPaths）', { field: 'paths' })
  }
  const clock = input.clock ?? new Clock()
  const revisionOf = (spec) => {
    const document = new OrchestrationDocument({ paths, spec, clock })
    const stored = document.tryRead()
    return stored === null ? null : stored.revision
  }

  const brief = new CreationBrief({ paths, clock }).summary()
  const directions = new DirectionSet({ paths, clock }).list()
  const baseline = new PlanBaseline({ paths, clock })
  const baselineDocument = baseline.read()
  const gate = baseline.gate()
  const units = new UnitRegistry({ paths, clock })
  const partition = units.partition()
  const previews = new PreviewSurface({ paths, clock }).latest()
  const vista = new VistaLedger({ paths, clock }).gate()

  const pick = (list, count) =>
    list.slice(0, count).map((entry) => ({ text: entry.text, status: entry.status ?? null }))
  return {
    projectionVersion: CREATION_PROJECTION_VERSION,
    generatedAt: clock.iso(),
    projectId: paths.projectId,
    brief: {
      counts: brief.counts,
      updatedAt: brief.updatedAt,
      user: pick(brief.userRequirements, PROJECTION_LIMITS.entriesPerBucket),
      source: pick(brief.sourceClaims, PROJECTION_LIMITS.entriesPerBucket),
      ai: pick(brief.aiInferences, PROJECTION_LIMITS.entriesPerBucket),
      unknown: pick(brief.unknowns, PROJECTION_LIMITS.entriesPerBucket),
    },
    directions: directions.slice(0, PROJECTION_LIMITS.directions).map((entry) => ({
      title: entry.title,
      state: entry.state,
      version: entry.version,
      combination: entry.combination === null ? null : entry.combination.newElements.length,
    })),
    baseline: {
      version: baselineDocument.baselineVersion,
      ok: gate.ok,
      blockers: gate.blockers.slice(0, PROJECTION_LIMITS.items).map((blocker) => ({
        kind: blocker.kind,
        reason: blocker.reason,
      })),
      items: baselineDocument.items.slice(0, PROJECTION_LIMITS.items).map((item) => ({
        kind: item.kind,
        title: item.title,
        state: item.state,
        blocking: item.blocking,
      })),
    },
    units: {
      complete: partition.complete.length,
      incomplete: partition.incomplete.length,
      list: [...partition.complete, ...partition.incomplete].slice(0, PROJECTION_LIMITS.units).map((unit) => ({
        unitId: unit.unitId,
        status: unit.status,
        knownIssues: (unit.unit?.humanResultPack?.knownIssues ?? []).slice(0, 3),
        unobserved: (unit.validation?.unobserved ?? []).slice(0, 4),
      })),
    },
    preview:
      previews === null
        ? null
        : {
            planVersion: previews.planVersion,
            currentPlanVersion: input.currentPlanVersion ?? null,
            showing: previews.planVersion === input.currentPlanVersion ? 'current-plan' : 'previous-plan',
            file: previews.file,
            renderedAt: previews.at,
            coveredRange: previews.coveredRange,
          },
    vista: {
      executed: vista.executed,
      total: vista.total,
      gainProven: vista.gainProven,
      mechanisms: vista.mechanisms.map((entry) => ({ mechanism: entry.mechanism, state: entry.state })),
    },
    // What the making agent actually saw and heard, stated once so a surface cannot imply more.
    ai: {
      saw: vista.mechanisms.find((entry) => entry.mechanism === 'real-observation')?.state === 'executed',
      heard: 'not-available',
      note: '宿主没有听辨通道；AI 从未听过音频',
    },
    sources: {
      brief: revisionOf(ORCH_DOCUMENT.brief),
      plan: revisionOf(ORCH_DOCUMENT.plan),
      units: revisionOf(ORCH_DOCUMENT.units),
      vista: revisionOf(ORCH_DOCUMENT.vista),
      preview: revisionOf(ORCH_DOCUMENT.preview),
    },
  }
}

/**
 * Publish the projection into the project's append-only event stream.
 *
 * @param {object} input see {@link buildCreationProjection}
 * @returns {{ projection: any, event: any }}
 */
export function publishCreationProjection(input = {}) {
  const projection = buildCreationProjection(input)
  const clock = input.clock ?? new Clock()
  const event = buildEvent({
    kind: CREATION_PROJECTION_KIND,
    projectId: projection.projectId,
    actor: 'system',
    detail: projection,
  })
  appendEvents(input.paths.dir, [event], { clock })
  return { projection, event }
}

/**
 * The newest projection carried by a list of project events, or `null`.
 *
 * Ordering is by the event log's own sequence: the reader keeps the LAST match, because the log is
 * append-only and an older summary must never win.
 *
 * @param {any[]} events events as returned by `/projects/events`
 * @returns {any|null}
 */
export function latestCreationProjection(events) {
  if (!Array.isArray(events)) return null
  let latest = null
  let latestSequence = -1
  for (const event of events) {
    if (event?.kind !== CREATION_PROJECTION_KIND) continue
    if (event.detail === null || typeof event.detail !== 'object') continue
    // The reader may be given newest-first (`readRecentEvents`) or oldest-first arrays; the
    // sequence decides, so a caller's ordering can never make an older summary win.
    const sequence = Number.isInteger(event.sequence) ? event.sequence : Number.MAX_SAFE_INTEGER
    if (sequence >= latestSequence) {
      latestSequence = sequence
      latest = event.detail
    }
  }
  return latest === null ? null : structuredClone(latest)
}
