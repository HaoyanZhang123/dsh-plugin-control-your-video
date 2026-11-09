/**
 * Temp-directory disposition helper for the evidence scripts.
 *
 * Why this exists: `process.exit()` inside a `try` block skips the `finally`, so a managed
 * temp directory was leaked on every `failure-lab` and `verify-clean` run even though both
 * scripts looked like they cleaned up. The fix is to dispose FIRST, record the outcome, and
 * only then exit — and to fail the script when disposal did not actually succeed, so a leak
 * becomes a visible defect instead of silent disk usage.
 *
 * @module scripts/lib/temp-disposition
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')

/**
 * @typedef {object} Disposition
 * @property {string} script
 * @property {boolean} removed
 * @property {string} [reason]
 * @property {string} [path]
 */

/**
 * Dispose a TempDir and record the truth about what happened.
 * @param {{ dispose: () => object }} temp
 * @param {string} script
 * @returns {Disposition}
 */
export function disposeTemp(temp, script) {
  const result = /** @type {{ removed: boolean, reason?: string, path?: string }} */ (temp.dispose())
  return { script, ...result }
}

/**
 * Whether every disposition actually removed its directory.
 * @param {Disposition[]} dispositions
 * @returns {boolean}
 */
export function disposedCleanly(dispositions) {
  return dispositions.every((item) => item.removed === true)
}

/**
 * Persist dispositions for evidence and report leftovers.
 * @param {Disposition[]} dispositions
 */
export function recordDispositions(dispositions) {
  const evidenceDir = path.join(ROOT, 'evidence')
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.writeFileSync(
    path.join(evidenceDir, 'temp-disposition.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), dispositions }, null, 2)}\n`,
    'utf8',
  )
}

/**
 * Report any pre-existing managed temp directories that no live process owns.
 *
 * This does NOT delete them: a stale temp dir must be an explicit, attributable action
 * (CT-12 §7), and another Workbench instance may own it. It only surfaces them so the leak
 * is visible to whoever runs the gate.
 *
 * @param {string} parent
 * @returns {{ total: number, stale: Array<{ name: string, pid: number, ownerAlive: boolean }> }}
 */
export function surveyTempParents(parent) {
  /** @type {Array<{ name: string, pid: number, ownerAlive: boolean }>} */
  const stale = []
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return { total: 0, stale }
  }
  const managed = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('dsh-avw-'))
  for (const entry of managed) {
    const full = path.join(parent, entry.name)
    let marker = null
    try {
      marker = JSON.parse(fs.readFileSync(path.join(full, '.workbench-temp.json'), 'utf8'))
    } catch {
      marker = null
    }
    const pid = Number(marker?.pid)
    const alive = Number.isFinite(pid) && pid > 0 ? isAlive(pid) : false
    stale.push({ name: entry.name, pid: Number.isFinite(pid) ? pid : -1, ownerAlive: alive })
  }
  return { total: managed.length, stale: stale.filter((item) => !item.ownerAlive) }
}

/** @param {number} pid @returns {boolean} */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}
