/**
 * Publish the creation-domain projection for one project, so the shell can read it from the event
 * stream. Small CLI because the projection is produced by the making side, not by the UI.
 *
 * Usage: node orchestration/dev/publish-projection.mjs --root <projects root> --project <prj_…>
 *
 * @module orchestration/dev/publish-projection
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Clock } from '../../base/index.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { publishCreationProjection } from '../../orchestration/projection.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** @param {string} flag @param {string|null} fallback */
function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const root = arg('--root')
const projectId = arg('--project')
if (root === null || projectId === null) {
  process.stderr.write('需要 --root 与 --project\n')
  process.exit(2)
}

const clock = new Clock({ mode: 'system' })
const paths = new ProjectPaths(path.resolve(root), projectId)
const { projection, event } = publishCreationProjection({ paths, clock, currentPlanVersion: arg('--plan', null) })
process.stdout.write(`published ${event.kind} seq for ${projectId}\n`)
process.stdout.write(`brief: ${JSON.stringify(projection.brief.counts)}\n`)
process.stdout.write(`baseline: v${projection.baseline.version} ok=${projection.baseline.ok}\n`)
process.stdout.write(`units: ${projection.units.complete} complete / ${projection.units.incomplete} incomplete\n`)
process.stdout.write(`vista: ${projection.vista.executed}/${projection.vista.total}\n`)
process.stdout.write(`preview: ${projection.preview === null ? 'none' : `${projection.preview.showing} ${projection.preview.planVersion}`}\n`)
process.stdout.write(`module: ${HERE}\n`)
