/**
 * Version identity, ordering and supported-version ranges for external tools.
 *
 * Why this is hand-written rather than a dependency: C04's engineering base has a ZERO third-party
 * dependency closure (`docs/dependency-admission.json` is empty), and every admitted package must be
 * strictly MIT with its whole transitive closure verified (CT-10 §1). A comparator set is ~200 lines
 * of well-understood logic, so admitting a package for it would be a rights and supply-chain cost
 * with no benefit.
 *
 * Three things this module is careful about, because getting them wrong would let a wrong tool be
 * reported as usable:
 *
 * 1. **A real build suffix is not a prerelease.** `9.0.1-full_build-www.gyan.dev` is FFmpeg's normal
 *    Gyan build, not a beta of `9.0.1`. Only a closed set of prerelease stems (`-alpha`, `-beta`,
 *    `-rc`, `-dev`, `-pre`, `-canary`, `-next`) is ordered BEFORE the release. Everything else is
 *    recorded as a build qualifier that does not change the numeric ordering. The heuristic is
 *    written down in {@link PRERELEASE_STEMS} so a surprise is debuggable rather than mysterious.
 * 2. **Same number, different build is not the same payload.** {@link sameBuild} is separate from
 *    {@link compareVersions}: verification is bound to an exact build string, because two builds of
 *    `9.0.1` can have different capabilities and a verification of one says nothing about the other.
 * 3. **An unparseable version is not "in range".** It yields `RangeVerdict.INVALID_RANGE`, so an
 *    unknown version can never be reported as compatible by accident.
 *
 * @module tools/version
 */

import { ValidationError } from '../base/index.js'
import { RangeVerdict } from './schema.js'

/**
 * Stems that make a qualifier a PRERELEASE, ordered before the corresponding release.
 *
 * Everything absent from this list is treated as build metadata (`-full_build`, `-win64`,
 * `-stable`, `-lts`), which is the behaviour real tool version strings need.
 */
const PRERELEASE_STEMS = Object.freeze([
  'alpha',
  'beta',
  'rc',
  'dev',
  'pre',
  'preview',
  'canary',
  'next',
  'snapshot',
])

/** A parsed version: numeric core plus an opaque qualifier. */
export class ToolVersion {
  /**
   * @param {number} major
   * @param {number} minor
   * @param {number} patch
   * @param {string} qualifier the raw text after the numeric core, without the leading separator
   * @param {string} raw the exact string as declared or detected
   */
  constructor(major, minor, patch, qualifier, raw) {
    this.major = major
    this.minor = minor
    this.patch = patch
    this.qualifier = qualifier
    this.raw = raw
  }

  /** `major.minor.patch`, ignoring the qualifier. */
  core() {
    return `${this.major}.${this.minor}.${this.patch}`
  }

  /** The full original string, which is what gets stored in evidence. */
  toString() {
    return this.raw
  }

  /**
   * Whether the qualifier marks a prerelease of this numeric core.
   * @returns {boolean}
   */
  isPrerelease() {
    const stem = prereleaseStem(this.qualifier)
    return stem !== null
  }

  /** A stable, serializable description for evidence files. */
  describe() {
    return {
      raw: this.raw,
      major: this.major,
      minor: this.minor,
      patch: this.patch,
      qualifier: this.qualifier,
      prerelease: this.isPrerelease(),
    }
  }
}

/**
 * Match the leading prerelease stem of a qualifier.
 * @param {string} qualifier
 * @returns {string|null}
 */
function prereleaseStem(qualifier) {
  if (typeof qualifier !== 'string' || qualifier.length === 0) return null
  const normalized = qualifier.toLowerCase().replace(/^[-_.]/, '')
  for (const stem of PRERELEASE_STEMS) {
    if (normalized === stem) return stem
    if (normalized.startsWith(`${stem}.`) || normalized.startsWith(`${stem}-`) || normalized.startsWith(`${stem}_`)) {
      return stem
    }
    if (/^\d+$/.test(normalized) === false && normalized.startsWith(stem)) {
      // e.g. `rc1`, `beta2`
      const rest = normalized.slice(stem.length)
      if (/^\d+$/.test(rest)) return stem
    }
  }
  return null
}

/**
 * Parse a version string.
 *
 * Accepted: `9`, `9.0`, `9.0.1`, `9.0.1-full_build-www.gyan.dev`, `v4.0.541`, `0.9.19`.
 * Refused: anything without a leading numeric component.
 *
 * @param {unknown} input
 * @param {{ field?: string }} [options]
 * @returns {ToolVersion}
 */
export function parseVersion(input, options = {}) {
  const field = options.field ?? 'version'
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field, value: String(input) })
  }
  const raw = input.trim()
  const match = raw.match(/^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/)
  if (match === null) {
    throw new ValidationError(`${field} 不是可识别的版本号`, { field, value: truncate(raw) })
  }
  const major = Number(match[1])
  const minor = match[2] === undefined ? 0 : Number(match[2])
  const patch = match[3] === undefined ? 0 : Number(match[3])
  for (const [name, value] of [['major', major], ['minor', minor], ['patch', patch]]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${field} 的 ${name} 不是非负整数`, { field, value: truncate(raw) })
    }
  }
  const rest = match[4] ?? ''
  // Drop a single leading separator; keep the rest verbatim so evidence shows the real build name.
  const qualifier = rest.replace(/^[-+_.]/, '')
  return new ToolVersion(major, minor, patch, qualifier, raw)
}

/**
 * Try to parse, returning a structured result instead of throwing.
 *
 * Used by detection, where a tool may print a version string this module cannot read: that is an
 * `inconclusive` detection, not a crash.
 *
 * @param {unknown} input
 * @returns {{ ok: true, version: ToolVersion } | { ok: false, reason: string }}
 */
export function tryParseVersion(input) {
  try {
    return { ok: true, version: parseVersion(input) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Compare two versions by numeric core, then by prerelease ordering.
 *
 * - a release sorts AFTER its prereleases (`9.0.1-rc1 < 9.0.1`);
 * - two releases of the same core are equal regardless of build qualifier;
 * - two prereleases of the same core compare by their qualifier text (lexicographic, stable).
 *
 * @param {ToolVersion|string} left
 * @param {ToolVersion|string} right
 * @returns {-1|0|1}
 */
export function compareVersions(left, right) {
  const a = toVersion(left)
  const b = toVersion(right)
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] < b[part]) return -1
    if (a[part] > b[part]) return 1
  }
  const aPre = a.isPrerelease()
  const bPre = b.isPrerelease()
  if (aPre && !bPre) return -1
  if (!aPre && bPre) return 1
  if (aPre && bPre) {
    const aKey = a.qualifier.toLowerCase()
    const bKey = b.qualifier.toLowerCase()
    if (aKey === bKey) return 0
    return aKey < bKey ? -1 : 1
  }
  // Both are releases: the numeric core decides, and build metadata does not reorder them.
  return 0
}

/**
 * Whether two versions name exactly the same payload.
 *
 * Stricter than `compareVersions(...) === 0`: a verification of `9.0.1-full_build` says nothing about
 * `9.0.1-custom`, because a different build can carry different capabilities.
 *
 * @param {ToolVersion|string} left
 * @param {ToolVersion|string} right
 * @returns {boolean}
 */
export function sameBuild(left, right) {
  const a = toVersion(left)
  const b = toVersion(right)
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch && a.qualifier === b.qualifier
}

/**
 * A stable fingerprint of an exact build, for binding verification records.
 * @param {ToolVersion|string} version
 * @returns {string}
 */
export function buildFingerprint(version) {
  const parsed = toVersion(version)
  return `${parsed.core()}${parsed.qualifier === '' ? '' : `-${parsed.qualifier}`}`
}

/**
 * Accept either a parsed version or a raw string.
 * @param {ToolVersion|string} value
 * @returns {ToolVersion}
 */
function toVersion(value) {
  if (value instanceof ToolVersion) return value
  return parseVersion(value)
}

/**
 * One comparator inside a range: `>=`, `>`, `<=`, `<`, `=`, or a bare version meaning `>=`.
 * A caret/tilde is expanded into a closed interval at parse time.
 * @typedef {object} Comparator
 * @property {'>='|'>'|'<='|'<'|'='} operator
 * @property {ToolVersion} version
 */

/** A parsed range: a disjunction of comparator conjunctions (`a b || c`). */
export class VersionRange {
  /**
   * @param {Comparator[][]} alternatives each inner array is an AND-set
   * @param {string} raw the source text
   */
  constructor(alternatives, raw) {
    this.alternatives = alternatives
    this.raw = raw
  }

  /** Whether this range accepts every version (the `*` case). */
  isAny() {
    return this.alternatives.length === 1 && this.alternatives[0].length === 0
  }

  /** Serializable description for evidence. */
  describe() {
    return {
      raw: this.raw,
      any: this.isAny(),
      alternatives: this.alternatives.map((set) => set.map((c) => `${c.operator}${c.version.raw}`)),
    }
  }
}

/** Characters that may separate comparators inside one alternative. */
const RANGE_SEPARATOR = /\s+/

/**
 * Parse a supported-version range.
 *
 * Grammar (deliberately small, and documented so a catalog author knows what is legal):
 *
 * ```text
 * range      := alternative ('||' alternative)*
 * alternative:= term (WS term)*          # all terms must hold
 * term       := '*' | '^' version | '~' version | ('>='|'<='|'>'|'<'|'=') version | version
 * version    := 'v'? NUM ('.' NUM ('.' NUM)?)? qualifier?
 * ```
 *
 * A bare version term means `>= version` (so `"9.0.0"` means "at least 9.0.0"); use `=9.0.0` for an
 * exact pin. This mirrors how npm-style ranges read while staying explicit.
 *
 * @param {unknown} input
 * @param {{ field?: string }} [options]
 * @returns {VersionRange}
 */
export function parseRange(input, options = {}) {
  const field = options.field ?? 'supportedVersions'
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field, value: String(input) })
  }
  const raw = input.trim()
  const alternatives = []
  for (const part of raw.split('||')) {
    const text = part.trim()
    if (text.length === 0) {
      throw new ValidationError(`${field} 含空的区间分支`, { field, value: truncate(raw) })
    }
    alternatives.push(parseAlternative(text, field))
  }
  return new VersionRange(alternatives, raw)
}

/**
 * Parse one AND-set of comparators.
 * @param {string} text
 * @param {string} field
 * @returns {Comparator[]}
 */
function parseAlternative(text, field) {
  if (text === '*' || text === 'x' || text === 'any') return []
  /** @type {Comparator[]} */
  const comparators = []
  for (const token of text.split(RANGE_SEPARATOR).filter((value) => value.length > 0)) {
    if (token.startsWith('^')) {
      comparators.push(...expandCaret(token.slice(1), field))
    } else if (token.startsWith('~')) {
      comparators.push(...expandTilde(token.slice(1), field))
    } else {
      const match = token.match(/^(>=|<=|>|<|=)?(.+)$/)
      if (match === null) {
        throw new ValidationError(`${field} 含无法识别的比较项`, { field, value: truncate(token) })
      }
      const operator = /** @type {'>='|'>'|'<='|'<'|'='} */ (match[1] ?? '>=')
      const version = parseVersionOrThrow(match[2], field)
      comparators.push({ operator, version })
    }
  }
  return comparators
}

/**
 * Expand `^X.Y.Z` into `>=X.Y.Z <next-major`.
 * @param {string} text
 * @param {string} field
 * @returns {Comparator[]}
 */
function expandCaret(text, field) {
  const version = parseVersionOrThrow(text, field)
  const upper = new ToolVersion(version.major + 1, 0, 0, '', `${version.major + 1}.0.0`)
  return [
    { operator: '>=', version },
    { operator: '<', version: upper },
  ]
}

/**
 * Expand `~X.Y.Z` into `>=X.Y.Z <X.(Y+1).0`.
 * @param {string} text
 * @param {string} field
 * @returns {Comparator[]}
 */
function expandTilde(text, field) {
  const version = parseVersionOrThrow(text, field)
  const upper = new ToolVersion(version.major, version.minor + 1, 0, '', `${version.major}.${version.minor + 1}.0`)
  return [
    { operator: '>=', version },
    { operator: '<', version: upper },
  ]
}

/**
 * @param {string} text
 * @param {string} field
 * @returns {ToolVersion}
 */
function parseVersionOrThrow(text, field) {
  try {
    return parseVersion(text)
  } catch {
    throw new ValidationError(`${field} 中的版本无法解析`, { field, value: truncate(text) })
  }
}

/**
 * Check whether a version satisfies a range, with a reason that distinguishes "too old" from
 * "too new". The distinction is what the UI needs: 需更新 vs 不兼容 are the same user label but
 * different next actions, and the receipt must be able to say which happened.
 *
 * @param {VersionRange|string} range
 * @param {ToolVersion|string|null} version
 * @returns {{ verdict: string, reason: string|null, matched: boolean }}
 */
export function satisfiesRange(range, version) {
  const parsedRange = typeof range === 'string' ? parseRange(range) : range
  if (version === null || version === undefined) {
    return { verdict: RangeVerdict.INVALID_RANGE, reason: '没有版本可判断', matched: false }
  }
  let parsedVersion
  try {
    parsedVersion = toVersion(version)
  } catch {
    return { verdict: RangeVerdict.INVALID_RANGE, reason: '版本无法解析', matched: false }
  }

  if (parsedRange.isAny()) return { verdict: RangeVerdict.IN_RANGE, reason: null, matched: true }

  // Track the tightest boundary that rejected the version, so the reason is the real cause.
  let belowMinimum = null
  let aboveMaximum = null
  for (const alternative of parsedRange.alternatives) {
    let failed = false
    let localBelow = null
    let localAbove = null
    for (const comparator of alternative) {
      const order = compareVersions(parsedVersion, comparator.version)
      const ok = compareWith(comparator.operator, order)
      if (ok) continue
      failed = true
      // A `>=`/`>` failure means the version is BELOW the minimum this range wants.
      if (comparator.operator === '>=' || comparator.operator === '>') localBelow = comparator.version.raw
      // A `<=`/`<` failure means the version is ABOVE the maximum this range allows.
      if (comparator.operator === '<=' || comparator.operator === '<') localAbove = comparator.version.raw
      // An `=` failure can be either direction; compare again to say which. Reporting it as an
      // unclassified failure would make an exact-pin mismatch invisible to the caller.
      if (comparator.operator === '=') {
        if (order < 0) localBelow = comparator.version.raw
        else if (order > 0) localAbove = comparator.version.raw
      }
      break
    }
    if (!failed) return { verdict: RangeVerdict.IN_RANGE, reason: null, matched: true }
    if (localBelow !== null) belowMinimum = localBelow
    if (localAbove !== null) aboveMaximum = localAbove
  }

  if (belowMinimum !== null) {
    return { verdict: RangeVerdict.BELOW_MINIMUM, reason: `低于最低支持版本 ${belowMinimum}`, matched: false }
  }
  if (aboveMaximum !== null) {
    return { verdict: RangeVerdict.ABOVE_MAXIMUM, reason: `高于最高支持版本 ${aboveMaximum}`, matched: false }
  }
  return { verdict: RangeVerdict.INVALID_RANGE, reason: '版本不满足声明区间', matched: false }
}

/**
 * Evaluate one comparator against a precomputed ordering.
 * @param {string} operator
 * @param {number} order -1|0|1 (version vs comparator version)
 * @returns {boolean}
 */
function compareWith(operator, order) {
  switch (operator) {
    case '>=':
      return order >= 0
    case '>':
      return order > 0
    case '<=':
      return order <= 0
    case '<':
      return order < 0
    case '=':
      return order === 0
    default:
      return false
  }
}

/**
 * Decide whether a version pin recorded for an existing project blocks moving to a target version.
 *
 * This is the code-level guard for "旧项目锁定的工具版本不被静默升级" (C06 §4.2). A pin is a project's
 * statement that its output was made with a specific tool build; changing it silently could change
 * the output of a finished project, so the upgrade must be refused and the user told.
 *
 * @param {{ version: string, projectId: string }|null} pin
 * @param {ToolVersion|string} targetVersion
 * @returns {{ verdict: string, pin: object|null, reason: string|null }}
 */
export function checkVersionPin(pin, targetVersion) {
  if (pin === null || pin === undefined) {
    return { verdict: 'unpinned', pin: null, reason: null }
  }
  const pinnedVersion = String(pin.version)
  if (sameBuild(pinnedVersion, targetVersion)) {
    return { verdict: 'pinned-same', pin, reason: null }
  }
  return {
    verdict: 'pinned-conflict',
    pin,
    reason:
      `项目 ${pin.projectId} 锁定 ${pinnedVersion}；目标 ${toVersion(targetVersion).raw} 不同，` +
      '不能静默升级（CT-03 §5 旧引用继续指向当时版本）',
  }
}

/**
 * Pick the newest version in a list that satisfies a range. Used by rollback and by update planning.
 * @param {Array<string|ToolVersion>} versions
 * @param {VersionRange|string} range
 * @returns {ToolVersion|null}
 */
export function newestSatisfying(versions, range) {
  if (!Array.isArray(versions) || versions.length === 0) return null
  const parsedRange = typeof range === 'string' ? parseRange(range) : range
  const candidates = versions
    .map((value) => tryParseVersion(value))
    .filter((result) => result.ok === true)
    .map((result) => /** @type {ToolVersion} */ (result.version))
    .filter((version) => satisfiesRange(parsedRange, version).matched)
  if (candidates.length === 0) return null
  candidates.sort(compareVersions)
  return candidates.at(-1) ?? null
}

/** Keep an error message bounded so a long version string cannot bloat a log line. */
function truncate(value) {
  const text = String(value)
  return text.length <= 80 ? text : `${text.slice(0, 77)}…`
}
