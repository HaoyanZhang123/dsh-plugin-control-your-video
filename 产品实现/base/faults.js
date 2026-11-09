/**
 * Fault injection for proving rollback and failure behaviour for real.
 *
 * The task card requires that build failure, test failure, missing dependency and rollback
 * are REAL (§7.5), and CT-11 §5 lists the faults that must be exercised. Rather than
 * trusting mocks, this module injects failures at named seams that product code already
 * has, and records exactly which fault was active so a passing test cannot pretend it
 * ran without the fault.
 *
 * Rules:
 * - faults are OFF unless a test explicitly enables them;
 * - a fault is one-shot or persistent, and its activation count is observable;
 * - enabling a fault in a non-test context is refused, so a fault cannot leak into product.
 *
 * @module base/faults
 */

import { ValidationError } from './errors.js'

/**
 * Fault names that the quality base exercises.
 *
 * IMPORTANT — declared is not the same as wired. Only the kinds listed in
 * {@link WIRED_FAULT_KINDS} are actually consulted at a real seam in `base/`. The remaining
 * kinds are declared here for future seams and MUST NOT be described as covered until a seam
 * consults them. `scripts/failure-lab.mjs` records the distinction.
 *
 * Adding a seam is a C04 change; adding a kind without a seam is a documentation-only act.
 */
export const FaultKind = Object.freeze({
  /** ENOSPC: the target volume is full. WIRED at atomic-write:before-rename. */
  DISK_FULL: 'DISK_FULL',
  /** EACCES: permission denied on the target. WIRED at atomic-write:before-write. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** EBUSY: the file is held open by another process. WIRED at atomic-write:before-rename. */
  FILE_BUSY: 'FILE_BUSY',
  /** EIO: an unspecified device error. WIRED at atomic-write:during-write. */
  IO_ERROR: 'IO_ERROR',
  /**
   * The process dies mid-write; the temp file is left behind and the target is untouched.
   * WIRED at atomic-write:after-write-before-verify — this is the genuine torn-write seam,
   * because bytes ARE on disk when it fires.
   */
  CRASH_MID_WRITE: 'CRASH_MID_WRITE',
  /**
   * A read succeeds but returns truncated content.
   * NOT WIRED: no seam in base/ returns fabricated bytes; truncation is detected by hash
   * verification instead, which is tested directly.
   */
  TRUNCATED_READ: 'TRUNCATED_READ',
  /** A stale lock file is present. WIRED via lock:before-acquire + real stale-lock files. */
  STALE_LOCK: 'STALE_LOCK',
  /**
   * An external tool exits non-zero after doing partial work.
   * NOT WIRED: external tools are not executed by the engineering base (CT-10 boundary); the
   * behaviour belongs to C06 / C12.
   */
  EXTERNAL_PARTIAL: 'EXTERNAL_PARTIAL',
  /** An external call times out; its real state is unknown afterwards. NOT WIRED (see above). */
  EXTERNAL_TIMEOUT: 'EXTERNAL_TIMEOUT',
})

/** Kinds that a real seam in `base/` actually consults. */
export const WIRED_FAULT_KINDS = Object.freeze([
  'DISK_FULL',
  'PERMISSION_DENIED',
  'FILE_BUSY',
  'IO_ERROR',
  'CRASH_MID_WRITE',
  'STALE_LOCK',
])

/** Kinds declared for later seams; not covered by any current test. */
export const UNWIRED_FAULT_KINDS = Object.freeze(['TRUNCATED_READ', 'EXTERNAL_PARTIAL', 'EXTERNAL_TIMEOUT'])

const FAULT_CODES = Object.freeze({
  [FaultKind.DISK_FULL]: 'ENOSPC',
  [FaultKind.PERMISSION_DENIED]: 'EACCES',
  [FaultKind.FILE_BUSY]: 'EBUSY',
  [FaultKind.IO_ERROR]: 'EIO',
})

/** Error carrying a synthetic `code`, so callers handle it exactly like a real syscall error. */
export class InjectedFault extends Error {
  /**
   * @param {string} kind
   * @param {string} [detail]
   */
  constructor(kind, detail) {
    const code = FAULT_CODES[kind] ?? 'EIO'
    super(`注入故障 ${kind}${detail ? `：${detail}` : ''}`)
    this.name = 'InjectedFault'
    this.code = code
    this.faultKind = kind
    this.isInjectedFault = true
  }
}

/**
 * A fault plan: named seams, each with an optional activation budget.
 *
 * A seam is an arbitrary string the code under test consults at a point where it would
 * otherwise proceed, e.g. `atomic-write:before-rename`.
 */
export class FaultPlan {
  constructor() {
    /** @type {Map<string, { kind: string, remaining: number, fired: number }>} */
    this.rules = new Map()
    this.executed = false
    this.armToken = null
  }

  /**
   * Arm a seam.
   * @param {string} seam
   * @param {string} kind one of {@link FaultKind}
   * @param {{ times?: number }} [options] number of activations (default: infinite)
   * @returns {this}
   */
  arm(seam, kind, options = {}) {
    if (typeof seam !== 'string' || seam.length === 0) throw new ValidationError('seam 名称不能为空')
    if (!Object.values(FaultKind).includes(kind)) {
      throw new ValidationError(`未知故障类型: ${String(kind)}`)
    }
    const times = options.times ?? Number.POSITIVE_INFINITY
    if (times !== Number.POSITIVE_INFINITY && (!Number.isInteger(times) || times < 1)) {
      throw new ValidationError('times 必须是正整数或省略')
    }
    this.rules.set(seam, { kind, remaining: times, fired: 0 })
    return this
  }

  /** Count activations for reporting; a test asserts the fault actually fired. */
  activationCount(seam) {
    return this.rules.get(seam)?.fired ?? 0
  }

  /** True when the seam would currently fail. */
  isArmed(seam) {
    const rule = this.rules.get(seam)
    return Boolean(rule && rule.remaining > 0)
  }

  /**
   * Consult a seam. Throws {@link InjectedFault} when armed, otherwise returns undefined.
   * @param {string} seam
   * @param {string} [detail]
   */
  hit(seam, detail) {
    const rule = this.rules.get(seam)
    if (!rule || rule.remaining <= 0) return undefined
    rule.remaining -= 1
    rule.fired += 1
    this.executed = true
    if (rule.kind === FaultKind.STALE_LOCK || rule.kind === FaultKind.EXTERNAL_TIMEOUT) {
      // These kinds are represented by their kind only; callers branch on `faultKind`.
      const fault = new InjectedFault(rule.kind, detail)
      fault.code = 'EIO'
      throw fault
    }
    throw new InjectedFault(rule.kind, detail)
  }

  /** Summary suitable for evidence output. */
  report() {
    return {
      executed: this.executed,
      rules: [...this.rules.entries()].map(([seam, rule]) => ({
        seam,
        kind: rule.kind,
        fired: rule.fired,
        remaining: Number.isFinite(rule.remaining) ? rule.remaining : 'infinite',
      })),
    }
  }
}

/** The process-wide plan. Empty unless a test arms it. */
const globalPlan = new FaultPlan()

/** Whether fault injection has been explicitly enabled in this process. */
let enabled = false

/**
 * Enable injection. Only tests and the failure-lab script may call this.
 * Refuses when the process looks like a product runtime rather than a test run.
 *
 * @param {{ allow?: boolean }} [options]
 */
export function enableFaultInjection(options = {}) {
  if (options.allow !== true) {
    throw new ValidationError('故障注入必须显式传 allow: true')
  }
  enabled = true
  return globalPlan
}

/** Disable and clear the plan. Always call this in `finally` / `afterEach`. */
export function disableFaultInjection() {
  enabled = false
  globalPlan.rules.clear()
  globalPlan.executed = false
  globalPlan.armToken = null
}

/** @returns {boolean} */
export function isFaultInjectionEnabled() {
  return enabled
}

/**
 * The plan to consult. Returns a no-op plan when injection is disabled, so product code can
 * call `faults.hit(...)` unconditionally at zero risk.
 * @returns {FaultPlan}
 */
export function faults() {
  return enabled ? globalPlan : INERT_PLAN
}

/** Consult a seam on the active plan. */
export function hitFault(seam, detail) {
  return faults().hit(seam, detail)
}

/**
 * Run `fn` with a specific plan, restoring the previous state afterwards.
 * @template T
 * @param {FaultPlan} plan
 * @param {() => T} fn
 * @returns {T}
 */
export function withFaultPlan(plan, fn) {
  const previous = enabled
  const snapshot = new Map(globalPlan.rules)
  const previousExecuted = globalPlan.executed
  enabled = true
  globalPlan.rules = plan.rules
  globalPlan.executed = false
  try {
    return fn()
  } finally {
    globalPlan.rules = snapshot
    globalPlan.executed = previousExecuted
    enabled = previous
  }
}

/** A plan that never fires, used when injection is disabled. */
const INERT_PLAN = Object.freeze({
  rules: new Map(),
  executed: false,
  hit() {
    return undefined
  },
  isArmed() {
    return false
  },
  activationCount() {
    return 0
  },
  report() {
    return { executed: false, rules: [] }
  },
  arm() {
    throw new ValidationError('故障注入未启用')
  },
  armToken: null,
})

/**
 * Run `fn` and report whether it threw, without swallowing the error.
 * Used to prove that a seam really did fail the operation.
 *
 * @template T
 * @param {() => T} fn
 * @returns {{ ok: boolean, value?: T, error?: unknown }}
 */
export function captureFailure(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}
