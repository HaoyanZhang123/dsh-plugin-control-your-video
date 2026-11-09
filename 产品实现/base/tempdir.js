/**
 * Managed temporary directories.
 *
 * Every temp area must be created inside a declared, writable root and be removable as a
 * unit. This matters because:
 * - C02 showed the default Windows TEMP may be unwritable under Defender policies;
 * - CT-06 requires temp cleanup to touch only registered, rebuildable paths;
 * - tests that consume untrusted input must run in an isolated directory (CT-11 §3).
 *
 * @module base/tempdir
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { IoError, ValidationError } from './errors.js'
import { assertSafeRelativePath } from './paths.js'

/** Marker file written into every managed temp directory. */
export const MARKER_FILE = '.workbench-temp.json'

/** Prefix shared by all managed temp directories, so stray ones are identifiable. */
export const TEMP_PREFIX = 'dsh-avw-'

/**
 * Pick a candidate parent for temporary data, in priority order.
 * A candidate is accepted only if we can actually create and remove a directory in it.
 *
 * @param {{ preferred?: string[] }} [options]
 * @returns {{ root: string, checked: Array<{ candidate: string, ok: boolean, reason?: string }> }}
 */
export function resolveTempRoot(options = {}) {
  const candidates = [
    ...(options.preferred ?? []),
    path.join(os.tmpdir()),
    path.join(os.homedir(), '.cache'),
  ]
  const checked = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    try {
      fs.mkdirSync(candidate, { recursive: true })
      const probe = path.join(candidate, `${TEMP_PREFIX}probe-${crypto.randomBytes(4).toString('hex')}`)
      fs.mkdirSync(probe)
      fs.writeFileSync(path.join(probe, 'probe.txt'), 'ok')
      fs.rmSync(probe, { recursive: true, force: true })
      checked.push({ candidate, ok: true })
      return { root: candidate, checked }
    } catch (error) {
      checked.push({ candidate, ok: false, reason: error?.code ?? String(error) })
    }
  }
  throw new IoError('没有可写的临时目录候选', { details: { checked } })
}

/**
 * A temporary directory that cleans itself up.
 *
 * Follows CT-01 lifecycle rules: cleanup must be callable from a `ctx.effect` disposer and
 * must be idempotent, because Host dispose gives roughly 5 seconds and may be skipped on
 * a hard exit.
 */
export class TempDir {
  /**
   * @param {string} parent an existing, writable directory
   * @param {{ label?: string, keep?: boolean }} [options]
   */
  constructor(parent, options = {}) {
    if (typeof parent !== 'string' || !path.isAbsolute(parent)) {
      throw new ValidationError('TempDir 需要一个绝对父目录')
    }
    fs.mkdirSync(parent, { recursive: true })
    const label = typeof options.label === 'string' && options.label.length > 0
      ? assertSafeRelativePath(options.label)
      : 'tmp'
    const name = `${TEMP_PREFIX}${label.replace(/\//g, '-')}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    /** @type {string} */
    this.path = path.join(parent, name)
    fs.mkdirSync(this.path, { recursive: false })
    this.parent = path.resolve(parent)
    this.label = label
    this.keep = options.keep === true
    this.disposed = false
    // Filesystem metadata for stale-directory reporting, not a deterministic render value.
    this.createdAt = new Date().toISOString() // dsh-allow S2: filesystem metadata, not render input
    fs.writeFileSync(
      path.join(this.path, MARKER_FILE),
      `${JSON.stringify({ label, pid: process.pid, createdAt: this.createdAt }, null, 2)}\n`,
      'utf8',
    )
  }

  /**
   * Create a child directory inside the temp dir from a validated relative path.
   * @param {string} relative
   * @returns {string}
   */
  dir(relative) {
    this.#assertLive()
    const safe = assertSafeRelativePath(relative)
    const target = path.join(this.path, safe)
    const resolved = path.resolve(target)
    if (!resolved.startsWith(path.resolve(this.path))) {
      throw new ValidationError('临时子目录越界')
    }
    fs.mkdirSync(resolved, { recursive: true })
    return resolved
  }

  /**
   * Path for a file inside the temp dir; parent directories are created on demand.
   * @param {string} relative
   * @returns {string}
   */
  file(relative) {
    this.#assertLive()
    const safe = assertSafeRelativePath(relative)
    const target = path.resolve(this.path, safe)
    if (!target.startsWith(path.resolve(this.path))) {
      throw new ValidationError('临时文件越界')
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    return target
  }

  /** Total size in bytes of everything currently inside. */
  sizeBytes() {
    let total = 0
    const walk = (dir) => {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        try {
          if (entry.isDirectory()) walk(full)
          else if (entry.isFile()) total += fs.statSync(full).size
        } catch {
          // A file may disappear concurrently; ignore and keep measuring.
        }
      }
    }
    walk(this.path)
    return total
  }

  /** List relative file paths currently present. */
  list() {
    const out = []
    const walk = (dir) => {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) out.push(path.relative(this.path, full).split(path.sep).join('/'))
      }
    }
    walk(this.path)
    return out.sort()
  }

  /** Remove the directory. Idempotent: a second call is a no-op. */
  dispose() {
    if (this.disposed) return { removed: false, reason: 'already-disposed' }
    this.disposed = true
    if (this.keep) return { removed: false, reason: 'keep-requested', path: this.path }
    try {
      fs.rmSync(this.path, { recursive: true, force: true, maxRetries: 3 })
      return { removed: true, path: this.path }
    } catch (error) {
      return { removed: false, reason: error?.code ?? String(error), path: this.path }
    }
  }

  #assertLive() {
    if (this.disposed) {
      throw new ValidationError('临时目录已释放')
    }
    if (!fs.existsSync(this.path)) {
      throw new IoError('临时目录已被外部删除', { details: { label: this.label } })
    }
  }
}

/**
 * Create a managed TempDir under a root, preferring an explicitly allowed root.
 * @param {{ preferred?: string[], label?: string, keep?: boolean }} [options]
 * @returns {TempDir & { rootChecked: Array<{ candidate: string, ok: boolean, reason?: string }> }}
 */
export function createTempDir(options = {}) {
  const { root, checked } = resolveTempRoot({ preferred: options.preferred })
  const temp = new TempDir(root, { label: options.label, keep: options.keep })
  // The resource-checked candidates are evidence for receipts; keep them with the instance.
  Object.defineProperty(temp, 'rootChecked', { value: checked, enumerable: false })
  return /** @type {any} */ (temp)
}

/**
 * Find managed temp directories left behind by dead processes.
 *
 * A stale temp dir is reported, never deleted by this function: cleanup must be an explicit,
 * attributable action (CT-12 §7), and another live Workbench may own it.
 *
 * @param {string} parent
 * @returns {Array<{ path: string, label: string, pid: number, createdAt: string, ownerAlive: boolean }>}
 */
export function findStaleTempDirs(parent) {
  const results = []
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue
    const full = path.join(parent, entry.name)
    let meta = null
    try {
      meta = JSON.parse(fs.readFileSync(path.join(full, MARKER_FILE), 'utf8'))
    } catch {
      // A directory without a marker is not provably ours; report it as unknown.
    }
    const pid = Number(meta?.pid)
    results.push({
      path: full,
      label: typeof meta?.label === 'string' ? meta.label : 'unknown',
      pid: Number.isFinite(pid) ? pid : -1,
      createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : 'unknown',
      ownerAlive: Number.isFinite(pid) && pid > 0 ? isProcessAlive(pid) : false,
    })
  }
  return results.sort((a, b) => a.path.localeCompare(b.path))
}

/** Whether a PID is currently running. On Windows, signal 0 is not portable. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we may not signal it.
    return error?.code === 'EPERM'
  }
}
