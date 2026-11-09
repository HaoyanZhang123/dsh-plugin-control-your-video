/**
 * Read the hand-maintained dependency admission list.
 *
 * The admission list is a SEPARATE read-only file (`docs/dependency-admission.json`) for a
 * concrete reason: the generated ledger (`docs/DEPENDENCY-LEDGER.md`) contains a boundary
 * taxonomy table whose cells are also backticked, so parsing "any backticked table cell" as an
 * admitted package name admitted the words `with-pack`, `host-provided` and `external-tool` —
 * and because `deps-report.mjs` regenerates that ledger, any declared dependency would then be
 * written into the very table used to admit it (a self-clearing gate).
 *
 * Rules:
 * - only this module reads the list; no script writes it;
 * - an empty list means "no third-party dependency is admitted";
 * - `package.json` and `pnpm-lock.yaml` remain the source of truth for what IS declared,
 *   so the gate compares DECLARED against ADMITTED.
 *
 * @module scripts/lib/admission
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')

/** Path of the admission list, relative to the project root. */
export const ADMISSION_FILE = 'docs/dependency-admission.json'

/**
 * @typedef {object} AdmissionList
 * @property {number} schemaVersion
 * @property {string[]} admitted exact package names allowed to appear in package.json
 * @property {string[]} problems structural problems that make the file unusable
 */

/**
 * Load and validate the admission list.
 *
 * A malformed or missing file yields an EMPTY admission list plus problems, which fails the
 * gate closed rather than open: an unusable file must never mean "everything is allowed".
 *
 * @returns {AdmissionList}
 */
export function loadAdmission() {
  const filePath = path.join(ROOT, ADMISSION_FILE)
  /** @type {string[]} */
  const problems = []
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 0, admitted: [], problems: [`缺少准入清单: ${ADMISSION_FILE}`] }
  }

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    return { schemaVersion: 0, admitted: [], problems: [`准入清单不是合法 JSON: ${error.message}`] }
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { schemaVersion: 0, admitted: [], problems: ['准入清单必须是 JSON 对象'] }
  }
  if (parsed.schemaVersion !== 1) {
    problems.push(`未知 schemaVersion: ${String(parsed.schemaVersion)}`)
  }
  if (!Array.isArray(parsed.admitted)) {
    problems.push('admitted 必须是数组')
    return { schemaVersion: parsed.schemaVersion ?? 0, admitted: [], problems }
  }

  /** @type {string[]} */
  const admitted = []
  for (const entry of parsed.admitted) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      problems.push(`admitted 含非法条目: ${JSON.stringify(entry)}`)
      continue
    }
    // A package name is a bare name; a specifier or path here would be ambiguous.
    if (/[\s/\\]/.test(entry.trim())) {
      problems.push(`admitted 条目必须是包名而不是路径或说明符: ${entry}`)
      continue
    }
    admitted.push(entry.trim())
  }

  return { schemaVersion: 1, admitted: [...new Set(admitted)], problems }
}

/**
 * Compare declared dependency names against admitted ones.
 *
 * @param {string[]} declared
 * @returns {{ admitted: string[], unadmitted: string[], problems: string[] }}
 */
export function checkDeclared(declared) {
  const { admitted, problems } = loadAdmission()
  const allowed = new Set(admitted)
  return {
    admitted,
    unadmitted: declared.filter((name) => !allowed.has(name)),
    problems,
  }
}
