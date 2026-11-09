/**
 * Detection: find out whether a tool is present at a location the user points at, and at which version,
 * WITHOUT lying about it.
 *
 * With the manual-guidance decision (user, 2026-11-08) detection is the primary way a tool enters the
 * product: the user installs it, then the plugin looks. So detection must accept an explicitly supplied
 * location — a WinGet package directory, a hand-unzipped folder, a project-local toolchain — and must
 * never touch anything the user did not point it at.
 *
 * Two modes, deliberately separated by how much of the outside world they touch:
 *
 * - **files-only** (default) — reads declared manifests and checks declared executables under a
 *   candidate root. It starts no process and changes nothing.
 * - **version-probe** — runs the tool's own version command. Starting an external process is an
 *   environment action that needs its own authorization (C06 §2.6, CT-12 §4), so the probe only happens
 *   when the caller supplies an executor AND marks the probe authorized. The executor is injected: this
 *   module contains no process-spawning code, so "无隐藏进程冒充运行" (CT-01 §4, C06 §4.5) is structural.
 *
 * The three failure outcomes are kept apart on purpose:
 * - `not-found` means the probe looked and found nothing → status `not-installed`;
 * - `inconclusive` means it found something it cannot trust (unreadable manifest, wrong binary,
 *   unparseable version) → status `unknown`, because equating "cannot tell" with "absent" would tell a
 *   user who DID install the tool that they did not;
 * - `error` means the probe itself threw → status `unknown`, and the operation is NOT auto-retried.
 *
 * @module tools/detect
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  Clock,
  ValidationError,
  ErrorCode,
  isInside,
  resolveRealPath,
  SecurityError,
} from '../base/index.js'
import { DetectionMode, DetectionOutcome } from './schema.js'
import { parseVersion, tryParseVersion } from './version.js'
import { assertBuildSegment } from './paths.js'

/**
 * @typedef {object} ProbeCandidate
 * @property {string} root absolute directory to look in
 * @property {string} [label] how the user would recognize it, e.g. `PATH` or `外部工具目录`
 */

/**
 * @typedef {object} DetectionResult
 * @property {string} outcome one of `DetectionOutcome`
 * @property {string|null} version detected version string
 * @property {string} mode the mode actually used
 * @property {string} at ISO timestamp
 * @property {string|null} location the root that produced the answer
 * @property {string|null} reason why inconclusive, or why the probe errored
 * @property {Array<{ check: string, ok: boolean, detail: string }>} evidence per-check evidence
 */

/**
 * Normalize a user- or caller-supplied location into a candidate root.
 *
 * The plugin honours a location the user names, so this must accept any absolute directory — but it must
 * also refuse a relative one rather than resolving it against the process cwd, which belongs to whoever
 * launched the host (CT-02 §2 "不静默换路径").
 *
 * @param {unknown} location
 * @param {string} [label]
 * @returns {ProbeCandidate}
 */
export function candidateFrom(location, label) {
  if (typeof location !== 'string' || location.length === 0) {
    throw new ValidationError('检测位置必须是非空字符串', { field: 'location' })
  }
  if (!path.isAbsolute(location)) {
    throw new ValidationError('检测位置必须是绝对路径，不接受相对路径', { field: 'location' })
  }
  return { root: path.resolve(location), label: label ?? null }
}

/**
 * Make one detection run. The returned object is what gets persisted and what a caller renders.
 *
 * @param {object} input
 * @param {object} input.tool catalog tool definition
 * @param {ProbeCandidate[]} input.candidates roots to look in, in priority order
 * @param {object} [input.executor] an AUTHORIZED executor; see {@link assertExecutorIsSafe}
 * @param {boolean} [input.probeAuthorized] the user authorized running the tool's version command
 * @param {{ mode?: string, clock?: Clock, timeoutMs?: number }} [options]
 * @returns {Promise<DetectionResult>}
 */
export async function detectTool(input, options = {}) {
  const tool = input?.tool
  if (tool === null || typeof tool !== 'object' || typeof tool.toolId !== 'string') {
    throw new ValidationError('detectTool 需要目录中的工具定义', { field: 'tool' })
  }
  const clock = options.clock ?? new Clock()
  const candidates = Array.isArray(input?.candidates) ? input.candidates : []
  const requestedMode = options.mode ?? tool.detection.mode ?? DetectionMode.FILES_ONLY
  const evidence = []
  const at = () => clock.iso()

  const wantsProbe = requestedMode === DetectionMode.VERSION_PROBE
  if (wantsProbe) {
    if (input?.executor === undefined || input?.executor === null) {
      // A probe was asked for but no authorized executor exists. That is a real, honest dead end: report
      // it rather than silently falling back to a weaker check that could not prove the version.
      return {
        outcome: DetectionOutcome.INCONCLUSIVE,
        version: null,
        mode: DetectionMode.VERSION_PROBE,
        at: at(),
        location: null,
        reason: '需要运行工具的版本命令，但没有获得授权的执行器',
        evidence: [{ check: 'executor', ok: false, detail: '未提供授权执行器' }],
      }
    }
    assertExecutorIsSafe(input.executor, { probeAuthorized: input.probeAuthorized })
  }

  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    if (typeof candidate.root !== 'string' || !path.isAbsolute(candidate.root)) {
      throw new ValidationError('检测候选根必须是绝对路径', { field: 'candidates.root' })
    }
    const root = path.resolve(candidate.root)
    if (!fs.existsSync(root)) {
      evidence.push({ check: `root:${candidate.label ?? 'candidate'}`, ok: false, detail: '目录不存在' })
      continue
    }

    // Files-only facts first: they are cheap, side-effect free, and they tell us whether this root even
    // looks like an installation of the declared tool.
    const manifestFacts = inspectManifests(tool, root)
    evidence.push(...manifestFacts.evidence)
    if (!manifestFacts.present) continue

    if (!wantsProbe) {
      // Without a probe, the version must come from a declared fact. If the catalog did not declare one,
      // we honestly do not know the version, and that is an inconclusive detection.
      const version = readDeclaredVersion(tool, root)
      if (version === null) {
        return {
          outcome: DetectionOutcome.INCONCLUSIVE,
          version: null,
          mode: DetectionMode.FILES_ONLY,
          at: at(),
          location: root,
          reason: '发现了工具文件，但没有可读的版本声明；需要授权的版本探针才能确定版本',
          evidence,
        }
      }
      const parsed = tryParseVersion(version)
      if (parsed.ok !== true) {
        return {
          outcome: DetectionOutcome.INCONCLUSIVE,
          version,
          mode: DetectionMode.FILES_ONLY,
          at: at(),
          location: root,
          reason: `版本声明无法解析：${parsed.reason}`,
          evidence,
        }
      }
      return {
        outcome: DetectionOutcome.FOUND,
        version: parsed.version.raw,
        mode: DetectionMode.FILES_ONLY,
        at: at(),
        location: root,
        reason: null,
        evidence,
      }
    }

    const probe = tool.detection.versionProbe
    let probeResult
    try {
      probeResult = await input.executor.runVersionProbe({
        command: probe.command,
        args: probe.args ?? [],
        cwd: root,
        timeoutMs: options.timeoutMs ?? 15_000,
      })
    } catch (error) {
      // A throwing probe leaves the state unknowable. It is recorded as `error` and NEVER retried
      // automatically, because a second attempt could duplicate an external action.
      return {
        outcome: DetectionOutcome.ERROR,
        version: null,
        mode: DetectionMode.VERSION_PROBE,
        at: at(),
        location: root,
        reason: describeProbeError(error),
        evidence: [...evidence, { check: 'version-probe', ok: false, detail: '执行探针时抛出异常' }],
      }
    }
    if (probeResult?.authorizationId === undefined || probeResult.authorizationId === null) {
      // The executor must prove the probe ran under a recorded authorization.
      return {
        outcome: DetectionOutcome.INCONCLUSIVE,
        version: null,
        mode: DetectionMode.VERSION_PROBE,
        at: at(),
        location: root,
        reason: '执行器没有提供本次探针的授权记录，不能采信其结果',
        evidence: [...evidence, { check: 'version-probe-authorization', ok: false, detail: '缺少授权记录' }],
      }
    }
    evidence.push({
      check: 'version-probe',
      ok: probeResult.exitCode === 0,
      detail: `exit=${String(probeResult.exitCode)}`,
    })
    if (probeResult.exitCode !== 0) {
      return {
        outcome: DetectionOutcome.INCONCLUSIVE,
        version: null,
        mode: DetectionMode.VERSION_PROBE,
        at: at(),
        location: root,
        reason: `版本命令以 ${String(probeResult.exitCode)} 退出`,
        evidence,
      }
    }
    const parsed = parseVersionFromOutput(probeResult.stdout ?? '')
    if (parsed === null) {
      return {
        outcome: DetectionOutcome.INCONCLUSIVE,
        version: null,
        mode: DetectionMode.VERSION_PROBE,
        at: at(),
        location: root,
        reason: '版本命令的输出中没有可识别的版本号',
        evidence,
      }
    }
    return {
      outcome: DetectionOutcome.FOUND,
      version: parsed,
      mode: DetectionMode.VERSION_PROBE,
      at: at(),
      location: root,
      reason: null,
      evidence,
    }
  }

  return {
    outcome: DetectionOutcome.NOT_FOUND,
    version: null,
    mode: wantsProbe ? DetectionMode.VERSION_PROBE : DetectionMode.FILES_ONLY,
    at: at(),
    location: null,
    reason: candidates.length === 0 ? '没有可检测的位置' : '在给定位置没有找到该工具',
    evidence: [...evidence, { check: 'candidates', ok: false, detail: `检查了 ${candidates.length} 个位置` }],
  }
}

/**
 * Read declared manifests under a candidate root.
 *
 * A manifest is evidence of presence, not of usability: a `package.json` proves a package directory
 * exists, nothing more.
 *
 * @param {object} tool
 * @param {string} root
 * @returns {{ present: boolean, evidence: Array<{ check: string, ok: boolean, detail: string }> }}
 */
function inspectManifests(tool, root) {
  const evidence = []
  const manifests = Array.isArray(tool?.detection?.manifestFiles) ? tool.detection.manifestFiles : []
  const executables = Array.isArray(tool?.detection?.executables) ? tool.detection.executables : []
  let present = false

  for (const relative of manifests) {
    const target = safeJoin(root, relative)
    if (target === null) {
      evidence.push({ check: `manifest:${relative}`, ok: false, detail: '路径不安全，已拒绝' })
      continue
    }
    if (fs.existsSync(target)) {
      present = true
      evidence.push({ check: `manifest:${relative}`, ok: true, detail: '存在' })
    } else {
      evidence.push({ check: `manifest:${relative}`, ok: false, detail: '缺失' })
    }
  }
  for (const relative of executables) {
    const target = safeJoin(root, relative)
    if (target === null) {
      evidence.push({ check: `executable:${relative}`, ok: false, detail: '路径不安全，已拒绝' })
      continue
    }
    const kind = describeFile(target)
    if (kind !== null) {
      present = true
      evidence.push({ check: `executable:${relative}`, ok: true, detail: kind })
    } else {
      evidence.push({ check: `executable:${relative}`, ok: false, detail: '缺失' })
    }
  }
  return { present, evidence }
}

/**
 * Read a version from a declared, plain-text version file, if the catalog declares one.
 *
 * Only a `version` manifest is read, and only its first line, so an arbitrary large file is never pulled
 * into memory.
 *
 * @param {object} tool
 * @param {string} root
 * @returns {string|null}
 */
function readDeclaredVersion(tool, root) {
  const manifests = Array.isArray(tool?.detection?.manifestFiles) ? tool.detection.manifestFiles : []
  for (const relative of manifests) {
    const target = safeJoin(root, relative)
    if (target === null || !fs.existsSync(target)) continue
    let text
    try {
      const stat = fs.statSync(target)
      if (!stat.isFile() || stat.size > 64 * 1024) continue
      text = fs.readFileSync(target, 'utf8')
    } catch {
      continue
    }
    const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
    if (/^\d+\.\d+/.test(firstLine)) return firstLine
    // A package.json-style manifest: read its `version` field rather than scraping the whole file.
    if (firstLine.startsWith('{')) {
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed?.version === 'string') return parsed.version
      } catch {
        // A manifest that does not parse is not a version source; keep looking.
      }
    }
  }
  return null
}

/**
 * Extract the first plausible version number from a tool's version banner.
 *
 * Tools print wildly different banners (`ffmpeg version 9.0.1-full_build …`, `4.0.541`, `v0.9.19`), so
 * this returns the first token that parses as a version and lets `version.js` validate it.
 *
 * @param {string} output
 * @returns {string|null}
 */
export function parseVersionFromOutput(output) {
  if (typeof output !== 'string') return null
  const firstLine = output.split(/\r?\n/, 1)[0] ?? ''
  const tokens = firstLine.split(/\s+/).filter((token) => token.length > 0)
  for (const token of tokens) {
    const cleaned = token.replace(/^[vV]/, '').replace(/[),;]$/, '')
    if (!/^\d+\.\d+/.test(cleaned)) continue
    const parsed = tryParseVersion(cleaned)
    if (parsed.ok === true) return parsed.version.raw
  }
  // Some tools put the version on a later line; scan a bounded number of lines.
  const lines = output.split(/\r?\n/).slice(0, 5)
  for (const line of lines) {
    const match = line.match(/(?:version|版本)\s*[:= ]\s*([vV]?\d+\.\d+[^\s,)]*)/i)
    if (match !== null) {
      const parsed = tryParseVersion(match[1])
      if (parsed.ok === true) return parsed.version.raw
    }
  }
  return null
}

/**
 * Join a declared relative path to a root, refusing anything that escapes it.
 *
 * Detection reads files under a location that may be any user-chosen directory, so the declared relative
 * path is confined exactly like untrusted input (CT-12 §3).
 *
 * @param {string} root
 * @param {string} relative
 * @returns {string|null} null when the path is unsafe
 */
function safeJoin(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0) return null
  const rootReal = resolveRealPath(root).real
  const target = path.resolve(rootReal, relative)
  if (!isInside(rootReal, target)) return null
  return target
}

/**
 * Describe a file without executing it.
 * @param {string} target
 * @returns {string|null}
 */
function describeFile(target) {
  try {
    const stat = fs.statSync(target)
    if (stat.isFile()) return `文件（${stat.size} 字节）`
    if (stat.isDirectory()) return '目录'
    return null
  } catch {
    return null
  }
}

/**
 * Refuse an executor that has not been explicitly authorized to run an external process.
 *
 * C06 §2.6 and CT-12 §4 both say the same thing: an external process is an environment action with its
 * own authorization. Making the executor carry `probeAuthorized: true` means a caller cannot reach the
 * probe path by accident.
 *
 * @param {unknown} executor
 * @param {{ probeAuthorized?: boolean }} [options]
 */
export function assertExecutorIsSafe(executor, options = {}) {
  if (executor === null || typeof executor !== 'object') {
    throw new ValidationError('执行器必须是对象', { field: 'executor' })
  }
  if (typeof executor.runVersionProbe !== 'function') {
    throw new ValidationError('执行器缺少 runVersionProbe', { field: 'executor' })
  }
  if (options.probeAuthorized !== true) {
    throw new ValidationError('运行外部进程需要单独的授权（外部进程属于环境动作）', {
      field: 'probeAuthorized',
      action: '请用户明确授权后再传入 probeAuthorized: true',
    })
  }
  if (executor.marksTestDouble === true) {
    // Allowed, because a test double is legitimate — it just must never be reported as real.
    return { ok: true, testDouble: true }
  }
  return { ok: true, testDouble: false }
}

/** Turn an executor error into a bounded, safe reason string. */
function describeProbeError(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return `探针失败（${error.code}）`
  }
  const message = error instanceof Error ? error.message : String(error)
  const safe = message.replace(/[A-Za-z]:[\\/][^\s]*/g, '<path>')
  return safe.length <= 200 ? safe : `${safe.slice(0, 197)}…`
}

/**
 * Build the candidate list for one tool.
 *
 * Order matters and encodes a policy: locations the CALLER explicitly supplied (the user pointed there)
 * are tried first, then the documented tools folder. Nothing else is ever probed — a tool outside both
 * is simply not found until the user names it, which is the honest answer rather than a filesystem crawl.
 *
 * @param {{ ownRoot: string, extra?: ProbeCandidate[] }} input
 * @returns {ProbeCandidate[]}
 */
export function buildCandidates(input) {
  if (typeof input?.ownRoot !== 'string' || !path.isAbsolute(input.ownRoot)) {
    throw new ValidationError('需要外部工具根目录', { field: 'ownRoot' })
  }
  /** @type {ProbeCandidate[]} */
  const out = []
  const seen = new Set()
  const push = (root, label) => {
    const resolved = path.resolve(root)
    const key = resolved.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ root: resolved, label: label ?? null })
  }
  for (const candidate of input.extra ?? []) {
    if (candidate === null || typeof candidate !== 'object') continue
    if (typeof candidate.root !== 'string' || !path.isAbsolute(candidate.root)) continue
    push(candidate.root, candidate.label ?? '你指定的位置')
  }
  push(path.join(path.resolve(input.ownRoot), ''), '外部工具目录')
  return out
}

/**
 * Build a build segment (a stable key for one exact build) from a detected version.
 *
 * Kept as a named function so the same normalization is used when recording an adoption and when
 * looking the record up later; a mismatch would make an adopted build invisible.
 *
 * @param {string} version
 * @returns {string}
 */
export function buildSegmentFor(version) {
  const parsed = parseVersion(version)
  const raw = `${parsed.core()}${parsed.qualifier === '' ? '' : `-${parsed.qualifier}`}`
  // `assertBuildSegment` is the same guard the path layer applies, so a version with a slash cannot
  // become a directory escape here.
  return assertBuildSegment(raw)
}

/**
 * Build the `not-installed` guidance result a surface renders.
 *
 * This is the "未安装→检测→手动指引" path from C06 §7.1. With the manual-only decision the guidance IS the
 * install path, so a tool with no manual steps cannot be guided and that is reported plainly rather
 * than padded with invented instructions.
 *
 * @param {object} tool
 * @param {string} [toolsRootLabel]
 * @returns {{ title: string, steps: string[], verifyHint: string|null, suggestedLocation: string|null }}
 */
export function buildManualGuidance(tool, toolsRootLabel = null) {
  const steps = Array.isArray(tool?.manualGuidance?.steps) ? [...tool.manualGuidance.steps] : []
  return {
    title: `${tool?.displayName ?? '该工具'} 尚未安装`,
    steps,
    verifyHint: tool?.manualGuidance?.verifyHint ?? null,
    suggestedLocation: toolsRootLabel,
  }
}

/**
 * Stable code for a detection failure, so callers branch on a code and not on message text.
 * @param {string} outcome
 * @returns {string}
 */
export function detectionErrorCode(outcome) {
  if (outcome === DetectionOutcome.ERROR) return ErrorCode.EXTERNAL_UNKNOWN
  if (outcome === DetectionOutcome.INCONCLUSIVE) return ErrorCode.EXTERNAL_UNKNOWN
  return ErrorCode.NOT_FOUND
}

/** Re-exported so a caller can throw the same security error detection uses. */
export { SecurityError }
