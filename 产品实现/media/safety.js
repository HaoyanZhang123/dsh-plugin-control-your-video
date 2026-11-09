/**
 * Untrusted project material screening.
 *
 * Contract (CT-12 §3, §8): a project package, an effect package or an imported plan is untrusted.
 * Browsing, importing and indexing must not execute anything, and every path must be relative,
 * normalised inside the target root, free of `..`, drive letters, UNC prefixes and link escapes.
 * A malicious archive is reported as rejected — not as a crash and not as "partially imported".
 *
 * This is deliberately a screen, not an importer: it answers "may this entry be touched at all" so a
 * later importer cannot skip the question.
 *
 * @module media/safety
 */

import fs from 'node:fs'
import path from 'node:path'
import { ValidationError } from '../base/index.js'

/** Default resource ceilings for one untrusted entry list. */
export const UNTRUSTED_LIMITS = Object.freeze({
  maxEntries: 4096,
  maxSingleBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxDepth: 16,
  maxCompressionRatio: 200,
})

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Classify one archive/package entry without touching it.
 *
 * @param {string} entryPath as written in the manifest (may be hostile)
 * @param {{ maxDepth?: number }} [limits]
 * @returns {{ ok: boolean, reason: string|null, normalised: string|null }}
 */
export function screenEntryPath(entryPath, limits = {}) {
  const maxDepth = limits.maxDepth ?? UNTRUSTED_LIMITS.maxDepth
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    return { ok: false, reason: 'empty-path', normalised: null }
  }
  if (entryPath.includes('\0')) return { ok: false, reason: 'nul-byte', normalised: null }
  const unified = entryPath.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(unified)) return { ok: false, reason: 'drive-letter', normalised: null }
  if (unified.startsWith('//') || unified.startsWith('\\\\')) {
    return { ok: false, reason: 'unc-path', normalised: null }
  }
  if (unified.startsWith('/')) return { ok: false, reason: 'absolute-path', normalised: null }
  const segments = unified.split('/')
  if (segments.some((segment) => segment === '..')) return { ok: false, reason: 'parent-traversal', normalised: null }
  if (segments.filter((segment) => segment.length > 0).length > maxDepth) {
    return { ok: false, reason: 'too-deep', normalised: null }
  }
  for (const segment of segments) {
    if (WINDOWS_RESERVED.test(segment)) return { ok: false, reason: 'reserved-name', normalised: null }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return { ok: false, reason: 'trailing-dot-or-space', normalised: null }
    }
  }
  return { ok: true, reason: null, normalised: path.posix.normalize(unified) }
}

/**
 * Screen an untrusted package description (what an importer would receive before extracting).
 *
 * @param {object} input
 * @param {string} input.root absolute destination root
 * @param {Array<{ path: string, bytes?: number, compressedBytes?: number, type?: 'file'|'dir'|'link' }>} input.entries
 * @param {typeof UNTRUSTED_LIMITS} [input.limits]
 * @returns {{
 *   accepted: string[], rejected: Array<{ path: string, reason: string }>,
 *   executable: false, note: string, ok: boolean,
 * }}
 */
export function screenUntrustedPackage(input) {
  if (typeof input?.root !== 'string' || !path.isAbsolute(input.root)) {
    throw new ValidationError('不受信包筛查需要绝对的目标根目录', { field: 'root' })
  }
  const limits = { ...UNTRUSTED_LIMITS, ...(input.limits ?? {}) }
  const root = path.resolve(input.root)
  const entries = Array.isArray(input.entries) ? input.entries : []
  const accepted = []
  const rejected = []
  let total = 0
  if (entries.length > limits.maxEntries) {
    return {
      accepted: [],
      rejected: entries.slice(limits.maxEntries).map((entry) => ({ path: String(entry?.path), reason: 'too-many-entries' })),
      executable: false,
      ok: false,
      note: `条目数 ${entries.length} 超过上限 ${limits.maxEntries}；未做任何解包`,
    }
  }
  for (const entry of entries) {
    const decision = screenEntryPath(entry?.path, limits)
    if (!decision.ok) {
      rejected.push({ path: String(entry?.path), reason: String(decision.reason) })
      continue
    }
    if (entry.type === 'link') {
      // A link inside an untrusted package can point anywhere; resolving it during import is how a
      // "harmless zip" escapes the destination root.
      rejected.push({ path: entry.path, reason: 'link-entry' })
      continue
    }
    const absolute = path.resolve(root, decision.normalised)
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      rejected.push({ path: entry.path, reason: 'escapes-root' })
      continue
    }
    const bytes = Number(entry.bytes ?? 0)
    if (bytes > limits.maxSingleBytes) {
      rejected.push({ path: entry.path, reason: 'entry-too-large' })
      continue
    }
    total += bytes
    if (total > limits.maxTotalBytes) {
      rejected.push({ path: entry.path, reason: 'total-too-large' })
      continue
    }
    const compressed = Number(entry.compressedBytes ?? 0)
    if (compressed > 0 && bytes / compressed > limits.maxCompressionRatio) {
      rejected.push({ path: entry.path, reason: 'compression-ratio' })
      continue
    }
    accepted.push(entry.path)
  }
  return {
    accepted,
    rejected,
    executable: false,
    ok: rejected.length === 0,
    note: '只做路径与资源筛查，不解包、不执行；拒绝项保留原因，失败不会留下半导入目录',
  }
}

/**
 * Verify that no accepted entry resolves through a link out of the root (post-extraction check).
 *
 * @param {string} root
 * @param {string[]} entries relative paths
 * @returns {{ ok: boolean, escapes: Array<{ path: string, realPath: string }> }}
 */
export function checkNoLinkEscape(root, entries) {
  const resolvedRoot = path.resolve(root)
  const escapes = []
  for (const relative of entries) {
    const absolute = path.resolve(resolvedRoot, relative)
    if (!fs.existsSync(absolute)) continue
    const real = fs.realpathSync(absolute)
    if (real !== resolvedRoot && !real.startsWith(resolvedRoot + path.sep)) {
      escapes.push({ path: relative, realPath: real })
    }
  }
  return { ok: escapes.length === 0, escapes }
}
