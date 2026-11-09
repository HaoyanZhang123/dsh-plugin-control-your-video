/**
 * Shared primitives for CREATION-ORCHESTRATION: identity, validation and project-scoped documents.
 *
 * C13 writes its own facts into the C10 project directory using the layout C10 already reserves
 * (`brief/`, `plans/`, `recipes/`, `work/`, `evidence/`), never a second root and never a
 * parallel project file. Every document is written through C10's `writeDocument`, so revision
 * conflicts and schema generations behave exactly like the rest of the project.
 *
 * Identities are derived from a natural key rather than random: re-running the same step must not
 * create a second unit or a second work package for the same content (C13 card §4.5 "不重复动作").
 *
 * @module orchestration/ids
 */

import {
  Clock,
  ConflictError,
  ValidationError,
  stableStringify,
} from '../base/index.js'
import { derivedId } from '../core/project/ids.js'
import { readDocument, tryReadDocument, writeDocument } from '../core/project/store.js'

/** Document kinds C13 owns. Each is a separate file with its own schema generation. */
export const ORCH_DOCUMENT = Object.freeze({
  brief: { kind: 'creation-brief', schemaKey: 'project', file: 'brief/briefing.json' },
  research: { kind: 'creation-research', schemaKey: 'project', file: 'brief/research.json' },
  direction: { kind: 'creation-directions', schemaKey: 'project', file: 'plans/directions.json' },
  plan: { kind: 'creation-plan-baseline', schemaKey: 'project', file: 'plans/baseline.json' },
  series: { kind: 'creation-series-shares', schemaKey: 'project', file: 'plans/series-shares.json' },
  reference: { kind: 'creation-reference-scopes', schemaKey: 'project', file: 'plans/reference-scopes.json' },
  units: { kind: 'creation-units', schemaKey: 'project', file: 'recipes/units.json' },
  craft: { kind: 'creation-craft-book', schemaKey: 'project', file: 'recipes/craft.json' },
  workPackage: { kind: 'creation-work-package', schemaKey: 'project', file: 'work/work-package.json' },
  journal: { kind: 'creation-journal', schemaKey: 'project', file: 'work/journal.json' },
  vista: { kind: 'creation-vista', schemaKey: 'project', file: 'evidence/vista.json' },
  methods: { kind: 'creation-methods', schemaKey: 'project', file: 'recipes/methods.json' },
  pinSync: { kind: 'creation-pin-sync', schemaKey: 'project', file: 'work/tool-pins.json' },
  preview: { kind: 'creation-preview-state', schemaKey: 'project', file: 'work/preview-state.json' },
  migration: { kind: 'creation-legacy-migration', schemaKey: 'project', file: 'work/legacy-migration.json' },
  messages: { kind: 'creation-assistant-thread', schemaKey: 'project', file: 'work/assistant-thread.json' },
})

/** Version of the C13 document formats. Bumping it means a reader must migrate. */
export const ORCH_SCHEMA_VERSION = 1

/** Namespaces used by {@link orchestrationId}. Three letters keeps ids readable in logs. */
export const ORCH_ID_NAMESPACE = Object.freeze({
  briefEntry: 'bre',
  research: 'rsc',
  source: 'src',
  direction: 'dir',
  planItem: 'itm',
  template: 'tpl',
  seriesUpdate: 'ser',
  gap: 'gap',
  referenceScope: 'rfs',
  unit: 'unt',
  unitCheck: 'chk',
  workPackage: 'wpk',
  method: 'mth',
  route: 'rte',
  failure: 'fel',
  referenceAnalysis: 'ran',
  convergence: 'cvg',
  termSelection: 'tsl',
  seam: 'sem',
  craft: 'cft',
  observation: 'obs',
  inspection: 'isp',
  prediction: 'prd',
  decision: 'dec',
  recoveryPacket: 'rcp',
  toolCall: 'tcl',
  pinIssue: 'pin',
})

/**
 * A stable, idempotent id for one C13 entity.
 * @param {keyof typeof ORCH_ID_NAMESPACE} namespace
 * @param {string} key natural key: content, unit or step identity
 * @returns {string}
 */
export function orchestrationId(namespace, key) {
  const prefix = ORCH_ID_NAMESPACE[namespace]
  if (prefix === undefined) throw new ValidationError(`未知编排实体: ${String(namespace)}`)
  return derivedId(prefix, key)
}

/**
 * Assert a non-empty trimmed string of bounded length.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [max]
 * @returns {string}
 */
export function requireText(value, field, max = 4000) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} 不能为空`, { field })
  }
  const trimmed = value.trim()
  if (trimmed.length > max) {
    throw new ValidationError(`${field} 超过长度上限`, { field, max, actual: trimmed.length })
  }
  return trimmed
}

/**
 * Optional bounded text; `undefined`/`null`/blank all become `null`.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [max]
 * @returns {string|null}
 */
export function optionalText(value, field, max = 4000) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new ValidationError(`${field} 必须是文本`, { field })
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > max) throw new ValidationError(`${field} 超过长度上限`, { field, max })
  return trimmed
}

/**
 * Assert a value belongs to a closed enum object.
 * @param {unknown} value
 * @param {Record<string, string>} enumObject
 * @param {string} field
 * @returns {string}
 */
export function requireOneOf(value, enumObject, field) {
  if (typeof value !== 'string' || !Object.values(enumObject).includes(value)) {
    throw new ValidationError(`${field} 不是允许的取值`, { field, allowed: Object.values(enumObject) })
  }
  return value
}

/**
 * Bounded string list with duplicates removed, order preserved.
 * @param {unknown} value
 * @param {string} field
 * @param {number} [max]
 * @returns {string[]}
 */
export function requireTextList(value, field, max = 64) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ValidationError(`${field} 必须是列表`, { field })
  if (value.length > max) throw new ValidationError(`${field} 条目过多`, { field, max })
  const out = []
  for (const entry of value) {
    const text = requireText(entry, `${field}[]`, 500)
    if (!out.includes(text)) out.push(text)
  }
  return out
}

/**
 * Deep copy, so callers never receive a live handle into a document.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function copy(value) {
  return structuredClone(value)
}

/**
 * Revision-checked access to one C13 document inside a project.
 *
 * The store never invents a second revision scheme: it reads and writes through C10's document
 * layer, so `expectedRevision` conflicts surface as `VERSION_CONFLICT` exactly like materials.
 */
export class OrchestrationDocument {
  /**
   * @param {object} input
   * @param {any} input.paths a C10 `ProjectPaths`
   * @param {{kind: string, schemaKey: string, file: string}} input.spec one entry of {@link ORCH_DOCUMENT}
   * @param {any} [input.clock]
   */
  constructor(input) {
    if (input?.paths === null || typeof input?.paths !== 'object' || typeof input.paths.resolve !== 'function') {
      throw new ValidationError('编排文档需要项目路径（ProjectPaths）', { field: 'paths' })
    }
    if (input?.spec === null || typeof input?.spec !== 'object' || typeof input.spec.file !== 'string') {
      throw new ValidationError('编排文档需要 spec', { field: 'spec' })
    }
    this.paths = input.paths
    this.spec = input.spec
    this.clock = input.clock ?? new Clock()
  }

  /** Absolute file path of this document. */
  filePath() {
    return this.paths.resolve(this.spec.file)
  }

  /**
   * Read the document and the revision it was read at.
   * @returns {{ value: any, revision: string|null }}
   */
  read() {
    const stored = tryReadDocument(this.filePath(), { kind: this.spec.kind })
    if (stored === null) {
      throw new ValidationError(`${this.spec.kind} 尚未创建`, { kind: this.spec.kind, file: this.spec.file })
    }
    return { value: stored.value, revision: stored.revision }
  }

  /**
   * Read, or `null` when the document does not exist yet.
   * @returns {{ value: any, revision: string|null }|null}
   */
  tryRead() {
    return tryReadDocument(this.filePath(), { kind: this.spec.kind })
  }

  /**
   * Read an existing document, or the fallback built when it is absent.
   * @param {() => any} create
   * @returns {{ value: any, revision: string|null }}
   */
  readOrCreate(create) {
    const stored = this.tryRead()
    if (stored !== null) return stored
    return { value: create(), revision: null }
  }

  /**
   * Write the document, refusing to overwrite a revision this call did not read.
   * @param {any} value
   * @param {string|null} expectedRevision
   * @returns {{ revision: string, sha256: string, bytes: number }}
   */
  write(value, expectedRevision) {
    if (this.spec.kind === undefined) throw new ConflictError('文档 spec 缺少 kind', { file: this.spec.file })
    return writeDocument(this.filePath(), value, {
      kind: this.spec.kind,
      schemaKey: this.spec.schemaKey,
      expectedRevision,
      clock: this.clock,
    })
  }

  /** The document's current content or `null`, without throwing on absence. */
  peek() {
    const stored = this.tryRead()
    return stored === null ? null : stored.value
  }

  /** Bytes on disk, or `null` when the document does not exist. */
  stat() {
    try {
      return { file: this.spec.file, bytes: stableStringify(this.peek()).length, exists: true }
    } catch {
      return { file: this.spec.file, bytes: 0, exists: false }
    }
  }
}

/**
 * Append one entry to a bounded in-document journal.
 *
 * The journal is C13's own trace (what was proposed, confirmed, produced and decided). It is not a
 * second project event log: C10 keeps the canonical event stream, and C13 never writes into it from
 * here because those kinds belong to C10's closed enum.
 *
 * @param {any[]} entries
 * @param {object} entry
 * @param {number} [limit]
 * @returns {any[]}
 */
export function appendJournal(entries, entry, limit = 2000) {
  const next = [...entries, { ...copy(entry), seq: entries.length + 1 }]
  if (next.length <= limit) return next
  // Bounded on purpose: a journal this long stops being evidence and starts being a data dump.
  // The oldest entries are dropped in one batch and the drop itself is recorded.
  const dropped = next.length - limit
  return next.slice(dropped).map((item, index) => ({ ...item, seq: index + 1, droppedBefore: dropped }))
}

/**
 * Read one C13 document by kind, for callers that only have the kind name.
 * @param {object} input
 * @param {any} input.paths
 * @param {keyof typeof ORCH_DOCUMENT} input.kind
 * @param {any} [input.clock]
 * @returns {{ value: any, revision: string|null }|null}
 */
export function readOrchestrationDocument(input) {
  const spec = ORCH_DOCUMENT[input.kind]
  if (spec === undefined) throw new ValidationError(`未知编排文档: ${String(input.kind)}`)
  const document = new OrchestrationDocument({ paths: input.paths, spec, clock: input.clock })
  return document.tryRead()
}

/**
 * Write one C13 document by kind, with the revision that was read.
 * @param {object} input
 * @param {any} input.paths
 * @param {keyof typeof ORCH_DOCUMENT} input.kind
 * @param {any} input.value
 * @param {string|null} input.expectedRevision
 * @param {any} [input.clock]
 * @returns {{ revision: string, sha256: string, bytes: number }}
 */
export function writeOrchestrationDocument(input) {
  const spec = ORCH_DOCUMENT[input.kind]
  if (spec === undefined) throw new ValidationError(`未知编排文档: ${String(input.kind)}`)
  const document = new OrchestrationDocument({ paths: input.paths, spec, clock: input.clock })
  return document.write(input.value, input.expectedRevision)
}

/**
 * Read the full text of a document that must exist, for a caller that needs to fail loudly.
 * @param {any} paths
 * @param {string} relative
 * @returns {any}
 */
export function readProjectJson(paths, relative) {
  return readDocument(paths.resolve(relative), { kind: relative }).value
}
