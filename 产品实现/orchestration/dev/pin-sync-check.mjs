/**
 * Re-run the pin synchronisation against the FIXED C06 validator, with a real C10 project id.
 *
 * This is the check C13 was asked to repeat after CR-13-2: before the fix, `advanceProjectPin` could
 * not accept `prj_<BASE32>` and every real call failed. Here the kernel is the real C06 kernel, the
 * project id is a real project created by C10, and the tool is the real FFmpeg entry from the
 * catalog. Any anomaly is printed unchanged instead of being worked around.
 *
 * Usage: node orchestration/dev/pin-sync-check.mjs
 *
 * @module orchestration/dev/pin-sync-check
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createToolKernel } from '../../tools/index.js'
import { PinSync } from '../../orchestration/pins.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = path.resolve(HERE, '../..')

function main() {
  const clock = new Clock({ mode: 'frozen', start: 1_780_000_200_000 })
  const temp = createTempDir({ label: 'c13-pin-sync' })
  const projectsRoot = temp.dir('projects')
  const toolsRoot = temp.dir('tools')
  const stateRoot = temp.dir('tools-state')
  fs.mkdirSync(toolsRoot, { recursive: true })

  const created = createProject({ projectsRoot, title: 'C13 pin 复核', clock })
  const projectId = created.project.projectId
  const paths = new ProjectPaths(projectsRoot, projectId)

  const kernel = createToolKernel({
    toolsRoot,
    stateRoot,
    pluginRoot: PRODUCT_ROOT,
    projectsRoot,
  })
  const pinSource = {
    recordPin: (input) => kernel.pinForProject(input),
    advanceProjectPin: (toolId, input) => kernel.advanceProjectPin({ toolId, ...input }),
    recheckProjectPin: (toolId, input) => kernel.recheckProjectPin({ toolId, ...input }),
  }

  const report = { projectId, projectIdShape: /^prj_[A-Za-z0-9]{8,32}$/.test(projectId), steps: [] }
  const step = (name, run) => {
    try {
      const value = run()
      report.steps.push({ step: name, status: 'ok', value })
      return value
    } catch (error) {
      report.steps.push({ step: name, status: 'failed', error: String(error?.message ?? error) })
      throw error
    }
  }

  step('pinForProject(rev-1)', () =>
    pinSource.recordPin({ toolId: 'ffmpeg', projectId, projectVersion: 'rev-1', version: '9.0.1', note: 'C13 复核起点' }),
  )
  const advanced = step('advanceProjectPin(rev-1→rev-2)', () =>
    pinSource.advanceProjectPin('ffmpeg', { projectId, fromProjectVersion: 'rev-1', toProjectVersion: 'rev-2', version: '9.0.1' }),
  )
  const rechecked = step('recheckProjectPin(rev-2)', () =>
    pinSource.recheckProjectPin('ffmpeg', { projectId, currentProjectVersion: 'rev-2' }),
  )

  // The C13 layer on top of the same kernel: it must now advance without the needs-handling detour.
  const sync = new PinSync({ paths, clock, pinSource })
  const viaLayer = step('PinSync.advance(rev-2→rev-3)', () =>
    sync.advance({ toolId: 'ffmpeg', fromProjectVersion: 'rev-2', toProjectVersion: 'rev-3', toolVersion: '9.0.1' }),
  )
  const viaRecheck = step('PinSync.recheck(rev-3)', () => sync.recheck({ currentProjectVersion: 'rev-3', toolIds: ['ffmpeg'] }))

  report.summary = {
    advanceStatus: viaLayer.status,
    advanceNeedsHandling: viaLayer.needsHandling,
    issue: viaLayer.issue ?? null,
    recheckOk: viaRecheck.ok,
    recheckStatus: viaRecheck.results?.[0]?.status ?? null,
    kernelRecheck: rechecked?.check ?? null,
    pinsAfter: (advanced?.pins ?? []).length,
  }
  fs.writeFileSync(path.join(PRODUCT_ROOT, 'evidence', 'c13-pin-sync.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`)
  temp.dispose()
}

main()
