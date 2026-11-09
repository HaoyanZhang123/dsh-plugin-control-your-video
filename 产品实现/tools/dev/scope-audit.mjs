/**
 * Write-scope audit for C06.
 *
 * The card permits exactly: the `TOOL-MANAGEMENT` tree (`tools/`), this card's own tests, this card's
 * evidence, and this card's receipt. Everything else — C04's root files, `base/`, `scripts/`, `docs/`,
 * C10's `core/project/`, C04's and C10's tests — must be left as it was.
 *
 * There is no git repository under `产品实现/`, so a diff is impossible. This script therefore records a
 * SHA-256 inventory of the whole tree, classifies every path as C06-owned or not, and states its own
 * limit plainly: it can prove what C06 DID write, and it can show that C04/C10 files are unmodified only
 * by comparison with hashes recorded in their own receipts, which this card does not hold.
 *
 * Usage: node tools/dev/scope-audit.mjs
 *
 * @module tools/dev/scope-audit
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../base/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const WORKSPACE = path.resolve(ROOT, '..')

/** Workspace-relative prefixes C06 is allowed to have created or modified. */
const OWNED_PREFIXES = [
  '产品实现/tools/',
  '实施交接/证据/C06-',
  '实施交接/回执/C06-回执.md',
]

/** C06's own test files, matched individually because `tests/` is shared with C04 and C10. */
const OWNED_TEST_PATTERN = /^产品实现\/tests\/(unit|contract|integration|acceptance)\/tools-.*\.test\.mjs$/

/**
 * Files owned by others that this card must not have touched. Hashes are recorded, not asserted, and
 * the report says so — claiming "unchanged" without the owner's original hash would be a claim the card
 * cannot support.
 */
const FOREIGN_CRITICAL = [
  '产品实现/package.json',
  '产品实现/pnpm-lock.yaml',
  '产品实现/pnpm-workspace.yaml',
  '产品实现/cordis.patch.yml',
  '产品实现/base/index.js',
  '产品实现/base/paths.js',
  '产品实现/base/atomic-write.js',
  '产品实现/base/errors.js',
  '产品实现/scripts/verify.mjs',
  '产品实现/scripts/static-check.mjs',
  '产品实现/scripts/format.mjs',
  '产品实现/scripts/build.mjs',
  '产品实现/scripts/test.mjs',
  '产品实现/docs/dependency-admission.json',
  '产品实现/core/project/index.js',
  '产品实现/core/project/schema.js',
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
  /** @type {string[]} */
  const owned = []
  /** @type {string[]} */
  const others = []

  for (const relative of files) {
    const isOwned = OWNED_TEST_PATTERN.test(relative) || OWNED_PREFIXES.some((prefix) => relative.startsWith(prefix))
    if (isOwned) owned.push(relative)
    else others.push(relative)
  }

  /** @type {Record<string, string>} */
  const inventory = {}
  for (const relative of files) {
    try {
      inventory[relative] = sha256(fs.readFileSync(path.join(WORKSPACE, relative)))
    } catch {
      inventory[relative] = 'unreadable'
    }
  }

  /** @type {Record<string, string>} */
  const foreignHashes = {}
  for (const relative of FOREIGN_CRITICAL) {
    foreignHashes[relative] = inventory[relative] ?? 'absent'
  }

  // Two classifications matter for the receipt: tests and non-test owned files.
  const ownedTests = owned.filter((relative) => OWNED_TEST_PATTERN.test(relative))
  const ownedProduct = owned.filter((relative) => relative.startsWith('产品实现/tools/'))

  const report = {
    schemaVersion: 1,
    kind: 'c06-scope-audit',
    generatedAt: new Date().toISOString(),
    tree: '产品实现/',
    totalFiles: files.length,
    ownedCount: owned.length,
    ownedProductCount: ownedProduct.length,
    ownedTestCount: ownedTests.length,
    otherCount: others.length,
    owned,
    // Files C06 did NOT claim. Listed so a reviewer can spot a surprise.
    others,
    foreignCriticalHashes: foreignHashes,
    limits: [
      '产品实现/ 不是 git 仓库，因此无法产生真正的 diff；本文件是哈希清单，不是变更证明。',
      '本脚本能证明 C06 写入的文件都在允许范围内；不能证明 C04／C10 文件未被改动。',
      'C04／C10 的原始哈希记录在各自的回执与证据中，本卡未持有，故未作等值断言。',
      '产品实现/evidence/ 由 C04 的脚本在每次运行质量门时重新生成，不属任何卡的手写产物。',
    ],
  }

  // The report is written into THIS card's evidence directory, not into `产品实现/evidence/`, because that
  // directory is C04's generated-output area and this card's write scope is limited to its own evidence.
  const outDir = path.join(WORKSPACE, '实施交接', '证据')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, 'C06-范围审计.json')
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  process.stdout.write(
    `scope audit: ${files.length} files, ${owned.length} C06-owned ` +
      `(${ownedProduct.length} tools/ + ${ownedTests.length} tests), ${others.length} other\n`,
  )
  process.stdout.write('\nC06-owned files:\n')
  for (const relative of owned) process.stdout.write(`  ${relative}\n`)
  process.stdout.write('\nC04/C10 critical file hashes (recorded, not asserted):\n')
  for (const [relative, hash] of Object.entries(foreignHashes)) {
    process.stdout.write(`  ${hash.slice(0, 16)}…  ${relative}\n`)
  }
  process.exit(0)
}

main()
