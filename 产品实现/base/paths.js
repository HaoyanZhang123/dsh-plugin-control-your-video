/**
 * Path confinement: the only way product code may turn an untrusted string into a file path.
 *
 * Contract (CT-12 §3, CT-02 §2). An untrusted path is accepted only when it is
 * relative, normalized, and — after resolving links — still inside a declared root:
 * - reject `..`, absolute paths, drive letters, UNC paths and link escapes;
 * - resolve the REAL path before the final check, so a junction/symlink cannot tunnel out;
 * - keep the check independent of the host OS sandbox, because Host plugin code runs
 *   inside the Host process and is NOT protected by the workspace sandbox (CT-01 §5).
 *
 * Verified platform behaviour this module is built on (Windows 24.22.1, measured in C04):
 * - `fs.realpathSync` on a missing path throws ENOENT, so "does not exist yet" is handled
 *   by resolving the deepest existing ancestor and re-appending the remainder;
 * - directory `fsync` throws EPERM, so durability for directories is not claimed;
 * - `path.relative(root, outside)` starts with `..` only after `resolve`;
 * - file names differing by case ARE the same file on this volume.
 *
 * @module base/paths
 */

import fs from 'node:fs'
import path from 'node:path'
import { ErrorCode, SecurityError, ValidationError } from './errors.js'

/** Reserved Windows device names, checked on the basename without extension. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/** Longest path segment accepted, to stay well inside Windows MAX_PATH handling. */
export const MAX_SEGMENT_LENGTH = 255

/** Longest relative path accepted by default. */
export const DEFAULT_MAX_PATH_LENGTH = 32000

/**
 * Bidirectional formatting controls (Trojan-Source style display spoofing).
 * Covers LRM/RLM, LRE/RLE/PDF/LRO/RLO and the LRI/RLI/FSI/PDI isolates.
 */
const BIDI_CONTROL_PATTERN = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/

/**
 * Reject strings that cannot be a safe relative path on any supported platform.
 * This is a *syntactic* gate; it runs before touching the filesystem.
 *
 * @param {unknown} candidate
 * @param {{ allowEmpty?: boolean, maxLength?: number }} [options]
 * @returns {string} the accepted relative path (separators normalized to `/`)
 */
export function assertSafeRelativePath(candidate, options = {}) {
  if (typeof candidate !== 'string') {
    throw new SecurityError(ErrorCode.PATH_INVALID, '路径必须是字符串', { received: typeof candidate })
  }
  const raw = candidate
  if (raw.length === 0) {
    if (options.allowEmpty === true) return ''
    throw new SecurityError(ErrorCode.PATH_INVALID, '路径不能为空')
  }
  const maxLength = options.maxLength ?? DEFAULT_MAX_PATH_LENGTH
  if (raw.length > maxLength) {
    throw new SecurityError(ErrorCode.PATH_INVALID, `路径过长（${raw.length} > ${maxLength}）`)
  }
  // Null bytes truncate paths at the syscall boundary; never allow them through.
  if (raw.includes('\u0000')) {
    throw new SecurityError(ErrorCode.PATH_INVALID, '路径包含空字符')
  }
  // Bidirectional control characters let a name DISPLAY differently from what it is
  // (e.g. "innocent\u202Ecod.exe" renders as "innocentexe.doc"). A file list must not lie,
  // so any bidi override/embedding/isolate is rejected outright.
  if (BIDI_CONTROL_PATTERN.test(raw)) {
    throw new SecurityError(ErrorCode.PATH_INVALID, '路径包含双向控制字符（可伪造显示顺序）')
  }
  // Absolute, drive-relative and UNC forms are rejected outright.
  if (path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) {
    throw new SecurityError(ErrorCode.PATH_ABSOLUTE, '不允许绝对路径', { value: sanitizeForMessage(raw) })
  }
  if (/^[a-zA-Z]:/.test(raw)) {
    throw new SecurityError(ErrorCode.PATH_ABSOLUTE, '不允许驱动器前缀路径', { value: sanitizeForMessage(raw) })
  }
  if (/^\\\\[?.]\\/.test(raw) || raw.startsWith('//?/') || raw.startsWith('//./')) {
    throw new SecurityError(ErrorCode.PATH_ABSOLUTE, '不允许设备或 UNC 路径', { value: sanitizeForMessage(raw) })
  }
  const segments = raw.split(/[\\/]+/)
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new SecurityError(ErrorCode.PATH_ESCAPE, '路径不允许包含 ..', { value: sanitizeForMessage(raw) })
    }
    // Classic traversal bypasses: a segment like `..;`, `....` or `..%00` does not escape the
    // LOCAL filesystem, but it does escape naive path normalization and web/URL decoding.
    // Refusing them keeps the guard correct regardless of what a caller does later.
    if (isTraversalDisguise(segment)) {
      throw new SecurityError(ErrorCode.PATH_ESCAPE, '路径片段是伪装的上级目录引用', {
        segment: sanitizeForMessage(segment),
      })
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new SecurityError(ErrorCode.PATH_INVALID, '路径片段过长', { segmentLength: segment.length })
    }
    const trimmed = segment.trimEnd()
    if (trimmed !== segment) {
      // "a.txt " and "a.txt" name the same file on Windows; refusing is the only honest option.
      throw new SecurityError(ErrorCode.PATH_INVALID, '路径片段不允许尾随空格', { segment: sanitizeForMessage(segment) })
    }
    if (/^\s/.test(segment)) {
      // A leading space is legal on disk but is invisible in listings and escapes the
      // trailing-space rule, so it is rejected to keep names unambiguous.
      throw new SecurityError(ErrorCode.PATH_INVALID, '路径片段不允许前导空白', {
        segment: sanitizeForMessage(segment),
      })
    }
    if (segment.endsWith('.')) {
      throw new SecurityError(ErrorCode.PATH_INVALID, '路径片段不允许尾随点号', { segment: sanitizeForMessage(segment) })
    }
    if (segment.includes(':')) {
      // NTFS alternate data streams hide content outside the visible file.
      throw new SecurityError(ErrorCode.PATH_INVALID, '路径片段不允许包含冒号（备用数据流）', {
        segment: sanitizeForMessage(segment),
      })
    }
    const baseName = segment.split('.')[0].toLowerCase()
    if (RESERVED_NAMES.has(baseName)) {
      throw new SecurityError(ErrorCode.PATH_INVALID, '路径片段是系统保留名', { segment: sanitizeForMessage(segment) })
    }
  }
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/')
}

/** Keep short evidence of a rejected value without echoing a whole private path. */
function sanitizeForMessage(value) {
  const text = String(value)
  if (text.length <= 120) return text
  return `${text.slice(0, 60)}…(${text.length} chars)`
}

/**
 * Percent-decoding steps attempted when looking for a disguised traversal.
 * Two rounds catch the common double-encoding case.
 * @param {string} value
 * @returns {string}
 */
function percentDecode(value) {
  let out = value
  for (let round = 0; round < 2; round += 1) {
    try {
      const decoded = decodeURIComponent(out)
      if (decoded === out) return out
      out = decoded
    } catch {
      // A stray '%' is not a valid escape; keep the literal form.
      return out
    }
  }
  return out
}

/**
 * Detect a segment that is a traversal attempt in disguise.
 *
 * Rejected forms:
 * - `..` followed only by dots/semicolons/spaces (`..;`, `....`, `.. ;`)
 * - a percent-encoded form that decodes to a traversal (`%2e%2e`, `%2e%2e%2f`)
 * - a percent-encoded NUL (`%00`), which truncates the path in some consumers
 *
 * @param {string} segment
 * @returns {boolean}
 */
function isTraversalDisguise(segment) {
  // Percent-encoded: inspect the decoded form.
  if (segment.includes('%')) {
    const decoded = percentDecode(segment)
    // An encoded NUL truncates at the syscall boundary for some consumers.
    if (decoded.includes('\u0000')) return true
    if (decoded !== segment) {
      for (const part of decoded.split(/[\\/]+/)) {
        if (part === '..' || isTraversalDisguise(part)) return true
      }
      // A decoded value that re-encodes into a separator is equally unsafe.
      if (/[\\/]/.test(decoded)) return true
    }
  }
  // Dot/semicolon padding around a traversal stem.
  if (/^\.+[;.\s]*$/.test(segment) && segment.replace(/[;.\s]/g, '') === '') {
    return segment.startsWith('..')
  }
  return false
}

/**
 * Resolve the real path of `target`, tolerating a not-yet-existing suffix.
 *
 * `fs.realpathSync` throws ENOENT for a path that does not exist. For write targets that
 * is normal, so we resolve the deepest existing ancestor and append the rest verbatim.
 * Link resolution therefore still applies to every existing component.
 *
 * @param {string} target absolute path
 * @returns {{ real: string, existed: boolean }}
 */
export function resolveRealPath(target) {
  const absolute = path.resolve(target)
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(absolute) : fs.realpathSync(absolute)
    return { real, existed: true }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const parent = path.dirname(absolute)
      if (parent === absolute) return { real: absolute, existed: false }
      const resolvedParent = resolveRealPath(parent)
      return {
        real: path.join(resolvedParent.real, path.basename(absolute)),
        existed: false,
      }
    }
    throw error
  }
}

/**
 * True when `child` is `parent` or inside it, comparing case-insensitively on Windows.
 * @param {string} parent absolute, already real
 * @param {string} child absolute, already real
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const rel = path.relative(parent, child)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !rel.startsWith(`..${path.posix.sep}`) && rel !== '..'
}

/**
 * A confined directory. Every method re-validates, so a caller that stores a
 * `PathGuard` in an object cannot be tricked later by a mutated root.
 */
export class PathGuard {
  /**
   * @param {string} root absolute path of the allowed directory
   * @param {{ label?: string, create?: boolean }} [options]
   */
  constructor(root, options = {}) {
    if (typeof root !== 'string' || root.length === 0) {
      throw new ValidationError('PathGuard 需要一个目录根')
    }
    if (options.create === true) fs.mkdirSync(root, { recursive: true })
    if (!path.isAbsolute(root)) {
      throw new ValidationError('PathGuard 的根必须是绝对路径')
    }
    /** @type {string} */
    this.root = path.resolve(root)
    this.label = options.label ?? 'root'
  }

  /** Real path of the root (resolves links in the root itself exactly once). */
  realRoot() {
    return resolveRealPath(this.root).real
  }

  /**
   * Turn a relative path into a confined absolute path.
   *
   * @param {string} relative untrusted relative path
   * @param {{ mustExist?: boolean, kind?: 'file' | 'directory' }} [options]
   * @returns {string} absolute path proven to be inside the root
   */
  resolve(relative, options = {}) {
    const safe = assertSafeRelativePath(relative)
    const absolute = path.resolve(this.root, safe)
    const realRoot = this.realRoot()
    const { real } = resolveRealPath(absolute)
    if (!isInside(realRoot, real)) {
      throw new SecurityError(ErrorCode.LINK_ESCAPE, '路径经链接解析后离开了允许目录', {
        root: this.label,
        relative: safe,
      })
    }
    if (options.mustExist === true) {
      let stat
      try {
        stat = fs.statSync(real)
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          throw new SecurityError(ErrorCode.PATH_INVALID, '目标不存在', { relative: safe })
        }
        throw error
      }
      if (options.kind === 'file' && !stat.isFile()) {
        throw new SecurityError(ErrorCode.PATH_INVALID, '目标不是普通文件', { relative: safe })
      }
      if (options.kind === 'directory' && !stat.isDirectory()) {
        throw new SecurityError(ErrorCode.PATH_INVALID, '目标不是目录', { relative: safe })
      }
      // Re-check after stat: a swapped link could have changed the target.
      const recheck = resolveRealPath(absolute).real
      if (!isInside(realRoot, recheck)) {
        throw new SecurityError(ErrorCode.LINK_ESCAPE, '目标在检查后被替换为目录外链接', { relative: safe })
      }
      return absolute
    }
    return absolute
  }

  /** Convert an absolute path back to a root-relative posix path. */
  relativeTo(absolutePath) {
    const realRoot = this.realRoot()
    const { real } = resolveRealPath(absolutePath)
    if (!isInside(realRoot, real)) {
      throw new SecurityError(ErrorCode.PATH_ESCAPE, '路径不在允许目录内', { root: this.label })
    }
    return path.relative(realRoot, real).split(path.sep).join('/')
  }

  /** True when the relative path resolves inside the root, without throwing. */
  contains(relative) {
    try {
      this.resolve(relative)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Ensure a directory exists, creating parents inside a guard only.
 * @param {PathGuard} guard
 * @param {string} relative
 * @returns {string} absolute directory path
 */
export function ensureDir(guard, relative) {
  const absolute = guard.resolve(relative)
  fs.mkdirSync(absolute, { recursive: true })
  return absolute
}

/**
 * Guard against a path that is a link pointing outside, before writing through it.
 *
 * Writing through a link would modify a file the product never declared. We refuse
 * writing to any existing symlink/junction and let the caller choose a real path.
 *
 * @param {string} absolute
 * @param {{ allowLink?: boolean }} [options]
 */
export function assertNotLink(absolute, options = {}) {
  let stat
  try {
    stat = fs.lstatSync(absolute)
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink() && options.allowLink !== true) {
    throw new SecurityError(ErrorCode.LINK_ESCAPE, '拒绝写入符号链接或 junction 目标', {})
  }
}

/** Exposed for tests and for callers that must render a path in a message. */
export { sanitizeForMessage }
