/**
 * Schema-generation migrations for PROJECT-CORE documents.
 *
 * CT-02 §6 requires that a migration: reads the source version, keeps the original bytes, refuses
 * to skip intermediate generations, writes a new generation, and leaves the old data intact on
 * failure. This module owns the CHAIN; `core/project/store.js` owns the byte handling.
 *
 * Generation 1 is the first generation this project shipped, so the chain is currently empty.
 * That is stated explicitly rather than left implicit: an empty chain is a FACT here, not an
 * oversight, and {@link migrationChain} throws when a caller asks for a step it cannot justify.
 * When generation 2 exists, its step is added to {@link MIGRATIONS} as `1->2` and every reader
 * that stored generation 1 becomes migratable without touching call sites.
 *
 * @module core/project/migrations
 */

import { ValidationError, WorkbenchError, ErrorCode } from '../../base/index.js'

/**
 * A migration step for one document kind.
 * @typedef {object} MigrationStep
 * @property {number} from source generation
 * @property {number} to target generation
 * @property {(document: any) => any} migrate pure function: same shape in, migrated shape out
 * @property {string} reason human-readable description recorded in evidence
 */

/**
 * Registered steps, keyed by document kind then by `from->to`.
 *
 * @type {Record<string, MigrationStep[]>}
 */
const MIGRATIONS = Object.freeze({
  project: [],
  materials: [],
  decisions: [],
  versions: [],
  recovery: [],
  preferences: [],
  registry: [],
})

/**
 * Find the ordered migration chain between two generations.
 *
 * Refuses a gap, because "skip a step" is how a field silently disappears: a v1 document that
 * jumped straight to v3 would never run v2's rename.
 *
 * @param {string} kind
 * @param {number} from
 * @param {number} to
 * @returns {MigrationStep[]}
 */
export function migrationChain(kind, from, to) {
  if (typeof kind !== 'string' || kind.length === 0) throw new ValidationError('migrationChain 需要文档类型')
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) {
    throw new ValidationError('迁移代次必须是整数', { from, to })
  }
  if (from === to) return []
  if (from > to) {
    throw new WorkbenchError(ErrorCode.UNSUPPORTED, '不支持向下迁移', {
      details: { kind, from, to, action: '必须用写入该项目的更新版本打开；不得降级覆盖' },
    })
  }
  const steps = MIGRATIONS[kind]
  if (steps === undefined) {
    throw new WorkbenchError(ErrorCode.CORRUPT_DATA, `未知的文档类型无法迁移`, { details: { kind, from, to } })
  }

  const chain = []
  let current = from
  while (current < to) {
    const step = steps.find((candidate) => candidate.from === current)
    if (step === undefined) {
      throw new WorkbenchError(ErrorCode.CORRUPT_DATA, '迁移链不完整，拒绝跳过中间版本', {
        details: { kind, from, to, stuckAt: current, registeredSteps: steps.map((s) => `${s.from}->${s.to}`) },
      })
    }
    chain.push(step)
    current = step.to
  }
  return chain
}

/**
 * Apply a chain to a document, without mutating the input.
 *
 * The input is deep-copied first so the caller keeps the original bytes in memory: CT-02 §6 says
 * the source must remain untouched, and a migration that edits its argument in place would make
 * that impossible to guarantee at a higher level.
 *
 * @param {any} document
 * @param {MigrationStep[]} chain
 * @returns {any}
 */
export function applyMigrationChain(document, chain) {
  let current = structuredClone(document)
  for (const step of chain) {
    const before = current
    current = step.migrate(current)
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      throw new WorkbenchError(ErrorCode.CORRUPT_DATA, '迁移结果不是对象', {
        details: { step: `${step.from}->${step.to}`, reason: step.reason },
      })
    }
    // A step that returns its input unchanged is almost always a bug; record it rather than
    // silently accepting a no-op migration as a successful upgrade.
    if (before === current) {
      throw new WorkbenchError(ErrorCode.INTERNAL, '迁移步骤没有产生新对象', {
        details: { step: `${step.from}->${step.to}` },
      })
    }
  }
  return current
}

/**
 * Whether a kind has any registered migration at all.
 * @param {string} kind
 * @returns {boolean}
 */
export function hasMigrations(kind) {
  return (MIGRATIONS[kind]?.length ?? 0) > 0
}

/**
 * Registered steps per kind, for evidence and receipts.
 * @returns {Record<string, string[]>}
 */
export function describeMigrations() {
  const out = {}
  for (const [kind, steps] of Object.entries(MIGRATIONS)) {
    out[kind] = steps.map((step) => `${step.from}->${step.to}`)
  }
  return out
}
