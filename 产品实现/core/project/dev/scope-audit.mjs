/**
 * Write-scope audit: prove C10 wrote only the paths its card allows.
 *
 * The card permits exactly: `core/project/**`, C10's own tests, C10's evidence, and
 * `实施交接/回执/C10-回执.md`. Everything else in the tree — C04's root files, `base/`, `scripts/`,
 * `docs/`, and the pre-existing C04 tests — must be byte-identical to what C04 delivered.
 *
 * There is no git repository in `产品实现/`, so a diff is impossible. This script instead records a
 * SHA-256 inventory of the whole tree, classifies every path as C10-owned or not, and states the
 * counts. It cannot prove the C04 files were untouched (only C04's own recorded hashes could), so
 * it reports the hashes and says exactly that.
 *
 * Usage: node core/project/dev/scope-audit.mjs
 *
 * @module core/project/dev/scope-audit
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../../base/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const WORKSPACE = path.resolve(ROOT, '..')

/**
 * Paths C10 is allowed to have created or modified, as workspace-relative prefixes.
 * A path matching none of these is reported as OUT OF SCOPE.
 */
const OWNED_PREFIXES = [
  '产品实现/core/project/',
  '产品实现/evidence/c10-',
  '实施交接/回执/C10-回执.md',
  '实施交接/证据/C10-',
]

/** C10's own test files, matched individually because tests/ is shared with C04. */
const OWNED_TEST_PATTERN = /^产品实现\/tests\/(unit|integration|contract|acceptance)\/project-.*\.test\.mjs$/

/** Paths that must remain exactly as C04 delivered them (hashes recorded, not asserted equal). */
const C04_CRITICAL = [
  '产品实现/package.json',
  '产品实现/pnpm-lock.yaml',
  '产品实现/pnpm-workspace.yaml',
  '产品实现/cordis.patch.yml',
  '产品实现/base/index.js',
  '产品实现/base/locks.js',
  '产品实现/base/atomic-write.js',
  '产品实现/scripts/verify.mjs',
  '产品实现/scripts/verify-clean.mjs',
  '产品实现/scripts/build.mjs',
  '产品实现/scripts/static-check.mjs',
  '产品实现/scripts/format.mjs',
  '产品实现/scripts/deps-report.mjs',
  '产品实现/docs/dependency-admission.json',
]

/**
 * Walk a directory, returning workspace-relative posix paths of files.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  const visit = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) out.push(path.relative(WORKSPACE, full).split(path.sep).join('/'))
    }
  }
  visit(dir)
  return out
}

function main() {
  const files = walk(ROOT)
  const owned = []
  const outOfScope = []

  for (const relative of files) {
    const isOwned = OWNED_TEST_PATTERN.test(relative) || OWNED_PREFIXES.some((prefix) => relative.startsWith(prefix))
    if (isOwned) owned.push(relative)
    else outOfScope.push(relative)
  }

  const inventory = {}
  for (const relative of files) {
    try {
      inventory[relative] = sha256(fs.readFileSync(path.join(WORKSPACE, relative)))
    } catch {
      inventory[relative] = 'unreadable'
    }
  }

  const c04Hashes = {}
  for (const relative of C04_CRITICAL) {
    c04Hashes[relative] = inventory[relative] ?? 'absent'
  }

  const report = {
    schemaVersion: 1,
    kind: 'c10-scope-audit',
    generatedAt: new Date().toISOString(),
    tree: '产品实现/',
    totalFiles: files.length,
    ownedCount: owned.length,
    outOfScopeCount: outOfScope.length,
    owned,
    // Files C10 did NOT claim. They are listed so a reviewer can spot a surprise, and their hashes
    // are recorded below. This script can only prove what C10 DID write; proving C04's files are
    // unmodified requires C04's own recorded hashes, which this card does not have.
    outOfScope,
    c04CriticalHashes: c04Hashes,
    limits: [
      '产品实现/ 不是 git 仓库，因此无法产生真正的 diff；本文件是哈希清单，不是变更证明。',
      '本脚本只能证明 C10 写入的文件都在允许范围内；不能证明 C04 文件未被改动。',
      'C04 原始哈希由 C04 回执/证据记录，本卡未持有，故未作等值断言。',
    ],
  }

  const outDir = path.join(ROOT, 'evidence')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'c10-scope-audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  process.stdout.write(`scope audit: ${files.length} files, ${owned.length} C10-owned, ${outOfScope.length} other\n`)
  process.stdout.write('\nC10-owned files:\n')
  for (const relative of owned) process.stdout.write(`  ${relative}\n`)
  process.stdout.write('\nC04 critical file hashes (recorded, not asserted):\n')
  for (const [relative, hash] of Object.entries(c04Hashes)) {
    process.stdout.write(`  ${hash.slice(0, 16)}…  ${relative}\n`)
  }
  process.exit(0)
}

main()
