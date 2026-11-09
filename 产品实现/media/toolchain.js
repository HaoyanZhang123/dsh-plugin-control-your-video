/**
 * Locating and identifying the external media toolchain.
 *
 * Contract (CT-06 §1, CT-06 §8, CT-12): FFmpeg/FFprobe are user-installed external tools, never
 * bundled with the plugin, and a missing or unexpected build is a "needs handling" state — not a
 * reason to quietly switch to another encoder. The resolution source is always recorded so a
 * receipt can say which binary actually ran.
 *
 * @module media/toolchain
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ExternalError, ValidationError } from '../base/index.js'

/** Executable names tried per platform when a directory is given. */
const EXECUTABLE_NAMES = Object.freeze({
  ffmpeg: ['ffmpeg.exe', 'ffmpeg'],
  ffprobe: ['ffprobe.exe', 'ffprobe'],
})

/** Cache of `-version` probes, so a render that spawns 40 processes reads the banner once. */
const versionCache = new Map()

/** @param {string} file */
function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a tool either as a file path, or inside a directory's `bin/`.
 * @param {string} candidate absolute path (a file or a directory)
 * @param {'ffmpeg'|'ffprobe'} tool
 * @returns {string|null}
 */
function resolveCandidate(candidate, tool) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null
  const absolute = path.resolve(candidate)
  if (!path.isAbsolute(absolute)) return null
  if (isExecutableFile(absolute)) return absolute
  for (const name of EXECUTABLE_NAMES[tool]) {
    const direct = path.join(absolute, name)
    if (isExecutableFile(direct)) return direct
    const inBin = path.join(absolute, 'bin', name)
    if (isExecutableFile(inBin)) return inBin
  }
  return null
}

/**
 * Find a tool on PATH without a shell.
 * @param {'ffmpeg'|'ffprobe'} tool
 * @param {string} [pathValue]
 * @returns {string|null}
 */
export function findOnPath(tool, pathValue = process.env.PATH ?? '') {
  const separator = path.delimiter
  for (const directory of pathValue.split(separator)) {
    if (directory.trim().length === 0) continue
    for (const name of EXECUTABLE_NAMES[tool]) {
      const candidate = path.join(directory, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * Read `<stateRoot>/tools/<toolId>.json` written by C06 and return the adopted build's location.
 * A missing file means "not adopted", which is different from "adopted but broken".
 * @param {string} stateRoot
 * @param {string} toolId
 */
export function readAdoptedToolLocation(stateRoot, toolId) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0) return null
  const statePath = path.join(path.resolve(stateRoot), 'tools', `${toolId}.json`)
  if (!fs.existsSync(statePath)) return null
  try {
    const document = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    const location = document?.currentBuild?.location
    return typeof location === 'string' && path.isAbsolute(location) ? location : null
  } catch {
    return null
  }
}

/**
 * Read the version banner of a media binary.
 * @param {string} executable absolute path
 * @returns {{ version: string|null, banner: string, status: number|null }}
 */
export function probeBinaryVersion(executable) {
  const cached = versionCache.get(executable)
  if (cached !== undefined) return cached
  const result = spawnSync(executable, ['-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  const stdout = result.stdout ?? ''
  const banner = String(stdout).split(/\r?\n/)[0] ?? ''
  // The banner carries a distributor suffix (`9.0.1-full_build-www.gyan.dev`); the numeric version is
  // what a plan can meaningfully declare, and the whole banner is kept so a receipt can quote it.
  const full = banner.match(/(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/)
  const numeric = banner.match(/(\d+\.\d+(?:\.\d+)?)/)
  const record = {
    version: numeric === null ? null : numeric[1],
    build: full === null ? (numeric === null ? null : numeric[1]) : full[1],
    banner,
    status: result.status,
  }
  versionCache.set(executable, record)
  return record
}

/**
 * Resolve both binaries and prove they run.
 *
 * @param {object} [options]
 * @param {string} [options.ffmpegPath] explicit file or install directory
 * @param {string} [options.ffprobePath] explicit file or install directory
 * @param {string} [options.toolStateRoot] C06 state root that may record an adopted FFmpeg build
 * @param {boolean} [options.allowPathLookup] allow resolving from PATH (recorded as its own source)
 * @returns {{ ffmpeg: any, ffprobe: any, source: string, notes: string[] }}
 */
export function resolveToolchain(options = {}) {
  const notes = []
  /** @type {Record<string, any>} */
  const resolved = {}

  const attempts = {
    ffmpeg: [
      { source: 'explicit', candidate: options.ffmpegPath },
      { source: 'tool-state', candidate: readAdoptedToolLocation(options.toolStateRoot, 'ffmpeg') },
      { source: 'path', candidate: options.allowPathLookup ? findOnPath('ffmpeg', options.pathValue) : null },
    ],
    ffprobe: [
      { source: 'explicit', candidate: options.ffprobePath },
      { source: 'tool-state', candidate: readAdoptedToolLocation(options.toolStateRoot, 'ffmpeg') },
      { source: 'path', candidate: options.allowPathLookup ? findOnPath('ffprobe', options.pathValue) : null },
    ],
  }

  for (const tool of ['ffmpeg', 'ffprobe']) {
    let found = null
    for (const attempt of attempts[tool]) {
      const file = resolveCandidate(attempt.candidate, tool)
      if (file !== null) {
        found = { file, source: attempt.source }
        break
      }
    }
    if (found === null) {
      throw new ExternalError(`${tool} 不可用：没有配置路径、没有 C06 采纳记录、也不在 PATH 上`, {
        code: 'TOOL_MISSING',
        details: {
          tool,
          remedy: '在工具管理中检测并采纳 FFmpeg 构建，或显式提供 ffmpegPath/ffprobePath',
        },
      })
    }
    const version = probeBinaryVersion(found.file)
    if (version.status !== 0 || version.version === null) {
      throw new ExternalError(`${tool} 存在但不能正常运行`, {
        code: 'TOOL_UNUSABLE',
        details: { tool, file: found.file, status: version.status, banner: version.banner },
      })
    }
    resolved[tool] = {
      path: found.file,
      version: version.version,
      build: version.build,
      banner: version.banner,
      source: found.source,
    }
    if (found.source !== 'explicit') {
      notes.push(`${tool} 由 ${found.source} 解析到 ${path.basename(found.file)} ${version.version}`)
    }
  }

  if (path.dirname(resolved.ffmpeg.path) !== path.dirname(resolved.ffprobe.path)) {
    notes.push('ffmpeg 与 ffprobe 不在同一目录，可能不是同一构建；使用条件需要单独记录')
  }
  // The GPL build on this machine cannot be redistributed with the plugin. That is a fact about the
  // tool, not about the plugin's own MIT surface, and it must stay visible in every receipt.
  notes.push('外部 FFmpeg 构建的许可与分发条件由用户自行遵守；其本体不随插件发布')

  return {
    ffmpeg: resolved.ffmpeg,
    ffprobe: resolved.ffprobe,
    source: resolved.ffmpeg.source === resolved.ffprobe.source ? resolved.ffmpeg.source : 'mixed',
    notes,
    describe() {
      return {
        ffmpeg: { version: resolved.ffmpeg.version, build: resolved.ffmpeg.build, source: resolved.ffmpeg.source },
        ffprobe: { version: resolved.ffprobe.version, build: resolved.ffprobe.build, source: resolved.ffprobe.source },
        sameBuild: path.dirname(resolved.ffmpeg.path) === path.dirname(resolved.ffprobe.path),
        notes: [...notes],
      }
    },
  }
}

/**
 * Assert a toolchain matches the build a plan was written against.
 * A different minor build is not a fatal error, but it must be reported instead of assumed away.
 * @param {any} toolchain
 * @param {{ runtimeId?: string, runtimeVersion?: string }} plan
 */
export function checkRuntimeVersion(toolchain, plan) {
  if (plan?.runtimeId !== undefined && plan.runtimeId !== 'ffmpeg') {
    throw new ValidationError('该计划声明的运行时不是 ffmpeg，不能用 ffmpeg 适配器执行', {
      runtimeId: String(plan.runtimeId),
    })
  }
  const declared = plan?.runtimeVersion
  const actual = toolchain?.ffmpeg?.version
  if (declared === undefined || declared === null) {
    return { matches: true, declared: null, actual, note: '计划未声明运行时版本，按当前构建执行并记录实际版本' }
  }
  const same = String(declared) === String(actual)
  return {
    matches: same,
    declared: String(declared),
    actual,
    note: same ? '运行时版本与计划一致' : '运行时版本与计划不同：需要按新版本重新验证，不能沿用旧结论',
  }
}
