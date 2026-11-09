/**
 * Directory layout and confinement for TOOL-MANAGEMENT.
 *
 * Three trees are kept strictly apart, because mixing them is a rights and data-loss problem
 * (CT-00 §4, CT-02 §2 "包、缓存、外部工具、插件安装目录不得互相包含"):
 *
 * ```text
 * <pluginRoot>/     plugin code, UI, bundled adapters, bundled MIT content
 * <projectsRoot>/   user projects
 * <toolsRoot>/      the documented place a user MAY put an external tool
 * <stateRoot>/      C06's own records: tool state, tasks, log
 * ```
 *
 * **What this module writes, and what it does not.** With the manual-guidance decision (user,
 * 2026-11-08) the plugin never installs a tool, so it never writes a tool payload anywhere. It writes
 * only its own records under `<stateRoot>`, and — at most — creates an empty, documented folder under
 * `<toolsRoot>` so a user has somewhere obvious to unpack a tool into. An adopted tool may live
 * ANYWHERE the user put it (a WinGet package directory, a hand-unzipped folder, a project-local
 * toolchain); the plugin records that absolute location and reads it, and never moves or deletes it.
 *
 * That asymmetry is the point: a read-only relationship to the user's tool cannot break their install.
 * Every path the plugin DOES write is still resolved through `base/PathGuard` (CT-12 §3).
 *
 * @module tools/paths
 */

import fs from 'node:fs'
import path from 'node:path'
import { PathGuard, ValidationError, isInside, resolveRealPath } from '../base/index.js'

/** Identifiers this module accepts for a tool. Lowercase kebab-case, no separators, no dots. */
const TOOL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Longest accepted tool id, comfortably under the 255-byte segment limit. */
export const MAX_TOOL_ID_LENGTH = 64

/** Relative layout inside the state root — the ONLY tree this module writes to. */
export const STATE_LAYOUT = Object.freeze({
  toolsDir: 'tools',
  tasksDir: 'tasks',
  logFile: 'log.jsonl',
})

/**
 * Assert a tool identifier is usable as a directory segment.
 *
 * A tool id reaches the filesystem (as a state-file name), so it is validated as a closed pattern
 * rather than merely "sanitized": `..`, `a/b`, `a\b`, `C:`, reserved device names and trailing dots are
 * all refused by construction (CT-12 §3).
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function assertToolId(value, field = 'toolId') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field, value: String(value) })
  }
  if (value.length > MAX_TOOL_ID_LENGTH) {
    throw new ValidationError(`${field} 过长`, { field, length: value.length })
  }
  if (!TOOL_ID_PATTERN.test(value)) {
    throw new ValidationError(`${field} 只能是小写字母、数字和单个连字符`, { field, value })
  }
  return value
}

/**
 * Assert a build fingerprint is usable as a directory segment and as a state key.
 *
 * The fingerprint for FFmpeg is `9.0.1-full_build-www.gyan.dev`, so the allowed set is wider than a tool
 * id's, but it still must not contain separators or traversal.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function assertBuildSegment(value, field = 'buildFingerprint') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field, value: String(value) })
  }
  if (value.length > 120) {
    throw new ValidationError(`${field} 过长`, { field, length: value.length })
  }
  if (/[\\/]/.test(value) || value.includes('..') || value.includes(':') || value.includes('\u0000')) {
    throw new ValidationError(`${field} 含路径分隔或上级引用`, { field })
  }
  if (/^[.\s]|[.\s]$/.test(value)) {
    throw new ValidationError(`${field} 不能以点或空白开头结尾`, { field })
  }
  return value
}

/**
 * The four roots TOOL-MANAGEMENT works against.
 *
 * All four are injected: C06 must not invent a user-data location, because CT-00 §4 keeps the default
 * path a product decision and the host half (C11) owns resolving it.
 */
export class ToolPaths {
  /**
   * @param {object} input
   * @param {string} input.toolsRoot absolute root for the documented tool area
   * @param {string} input.stateRoot absolute root for C06 records
   * @param {string} input.pluginRoot absolute root of the plugin package (may not contain tools)
   * @param {string} [input.projectsRoot] absolute root of user projects, when known
   */
  constructor(input) {
    this.toolsRoot = requireAbsolute(input?.toolsRoot, 'toolsRoot')
    this.stateRoot = requireAbsolute(input?.stateRoot, 'stateRoot')
    this.pluginRoot = requireAbsolute(input?.pluginRoot, 'pluginRoot')
    this.projectsRoot =
      input?.projectsRoot === undefined || input.projectsRoot === null
        ? null
        : requireAbsolute(input.projectsRoot, 'projectsRoot')
    this.toolsGuard = new PathGuard(this.toolsRoot, { label: 'tools' })
    this.stateGuard = new PathGuard(this.stateRoot, { label: 'tool-state' })
  }

  /**
   * Assert the trees are disjoint. Called at construction by {@link createToolPaths} so a
   * misconfiguration fails loudly instead of slowly polluting a project or the plugin package.
   *
   * @returns {{ ok: true, checked: string[] }}
   */
  assertIsolated() {
    const pairs = [
      ['toolsRoot', this.toolsRoot, 'pluginRoot', this.pluginRoot],
      ['stateRoot', this.stateRoot, 'pluginRoot', this.pluginRoot],
      ['toolsRoot', this.toolsRoot, 'stateRoot', this.stateRoot],
    ]
    if (this.projectsRoot !== null) {
      pairs.push(['toolsRoot', this.toolsRoot, 'projectsRoot', this.projectsRoot])
      pairs.push(['stateRoot', this.stateRoot, 'projectsRoot', this.projectsRoot])
    }
    const checked = []
    for (const [nameA, rootA, nameB, rootB] of pairs) {
      const realA = resolveRealPath(rootA).real
      const realB = resolveRealPath(rootB).real
      checked.push(`${nameA}<->${nameB}`)
      if (isInside(realA, realB) || isInside(realB, realA)) {
        throw new ValidationError('工具目录与插件／项目／状态目录不得互相包含', {
          pair: `${nameA}<->${nameB}`,
          // Basenames only: a full path in a message ends up in logs (CT-12 §6).
          a: path.basename(realA),
          b: path.basename(realB),
        })
      }
    }
    return { ok: true, checked }
  }

  /**
   * The documented folder a user may unpack a tool into.
   *
   * Creating this empty folder is the ONLY thing this module ever creates under `toolsRoot`; no payload
   * is written there by the plugin. It exists so "where do I put it" has an answer in the tool page.
   *
   * @param {string} toolId
   * @returns {string}
   */
  suggestedToolDir(toolId) {
    return this.toolsGuard.resolve(assertToolId(toolId))
  }

  /** Absolute path of one tool's state document. The only per-tool file this module writes. */
  stateFor(toolId) {
    assertToolId(toolId)
    const dir = this.stateGuard.resolve(STATE_LAYOUT.toolsDir)
    fs.mkdirSync(dir, { recursive: true })
    return this.stateGuard.resolve(`${STATE_LAYOUT.toolsDir}/${toolId}.json`)
  }

  /** Absolute path of one task's record. */
  taskRecordPath(taskId) {
    assertTaskId(taskId)
    const dir = this.stateGuard.resolve(STATE_LAYOUT.tasksDir)
    fs.mkdirSync(dir, { recursive: true })
    return this.stateGuard.resolve(`${STATE_LAYOUT.tasksDir}/${taskId}.json`)
  }

  /** Absolute path of the append-only management log. */
  logPath() {
    return this.stateGuard.resolve(STATE_LAYOUT.logFile)
  }

  /** Create every directory the kernel needs. Returns what was created, for evidence. */
  ensureLayout() {
    const created = []
    for (const dir of [
      this.stateRoot,
      path.join(this.stateRoot, STATE_LAYOUT.toolsDir),
      path.join(this.stateRoot, STATE_LAYOUT.tasksDir),
    ]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        created.push(path.basename(dir))
      }
    }
    return { created }
  }
}

/**
 * Build a `ToolPaths`, refusing a configuration whose trees overlap.
 * @param {object} input see {@link ToolPaths}
 * @returns {ToolPaths}
 */
export function createToolPaths(input) {
  const paths = new ToolPaths(input)
  paths.assertIsolated()
  return paths
}

/** Task ids this module generates: stable, sortable, filesystem-safe. */
const TASK_ID_PATTERN = /^task-[0-9]{8,}-[a-z0-9]{6,16}$/

/**
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function assertTaskId(value, field = 'taskId') {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new ValidationError(`${field} 格式不合法`, { field, value: String(value) })
  }
  return value
}

/**
 * Require an absolute path, naming the field but never echoing the whole private path.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireAbsolute(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`需要 ${field}`, { field })
  }
  if (!path.isAbsolute(value)) {
    throw new ValidationError(`${field} 必须是绝对路径`, { field })
  }
  return path.resolve(value)
}
