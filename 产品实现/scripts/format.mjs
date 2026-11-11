#!/usr/bin/env node
/**
 * Formatting check and fix, with no formatter dependency.
 *
 * The rules are the ones this project actually cares about for reviewable diffs and clean
 * evidence — not a full style guide:
 *   F1 UTF-8 without BOM
 *   F2 LF line endings only (no CRLF in committed source)
 *   F3 exactly one trailing newline
 *   F4 no trailing whitespace
 *   F5 no tab characters in indentation
 *   F6 JSON files parse and use 2-space indentation
 *   F7 no line longer than 120 characters (excluding URLs and long string literals)
 *   F8 no two consecutive blank lines
 *
 * `--write` fixes what is mechanically fixable (F1..F5, F8) and reports the rest.
 *
 * Usage: node scripts/format.mjs [--check|--write]
 *
 * @module scripts/format
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** Directories included in formatting. */
const TARGET_DIRS = ['base', 'scripts', 'tests', 'core', 'tools', 'media', 'orchestration', 'editing', 'delivery']

/** Root-level files included in formatting. */
const TARGET_FILES = ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md'])

/**
 * Directories skipped entirely.
 *
 * `docs` is NOT skipped: the engineering documents are deliverables and must obey the same
 * F1/F2/F3/F4/F8 rules as code (a CRLF or trailing space in a receipt is still a defect).
 * `evidence` is skipped because it is regenerated output.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'evidence'])

/** Extra directories walked in addition to TARGET_DIRS. */
const EXTRA_DIRS = ['docs']

/** Maximum accepted line length. */
export const MAX_LINE_LENGTH = 120

/**
 * @typedef {object} FormatFinding
 * @property {string} rule
 * @property {string} file
 * @property {number} line
 * @property {string} message
 * @property {boolean} fixable
 */

/** @returns {string[]} */
function collectFiles() {
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(full)
      }
    }
  }
  for (const dir of [...TARGET_DIRS, ...EXTRA_DIRS]) walk(path.join(ROOT, dir))
  for (const file of TARGET_FILES) {
    const full = path.join(ROOT, file)
    if (fs.existsSync(full)) files.push(full)
  }
  return files.sort()
}

/**
 * Decide whether a long line is allowed (URLs and long string literals are).
 * @param {string} line
 * @returns {boolean}
 */
function isExemptLongLine(line) {
  if (/https?:\/\//.test(line)) return true
  // A line whose length comes from one quoted literal is not a readability problem.
  const withoutStrings = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
  return withoutStrings.length <= MAX_LINE_LENGTH
}

/**
 * Check one file's text.
 * @param {string} relative
 * @param {string} buffer
 * @returns {FormatFinding[]}
 */
export function checkText(relative, buffer) {
  /** @type {FormatFinding[]} */
  const findings = []
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8')

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    findings.push({ rule: 'F1', file: relative, line: 1, message: '带 UTF-8 BOM', fixable: true })
  }

  const text = bytes.toString('utf8')
  if (text.includes('\r\n')) {
    findings.push({ rule: 'F2', file: relative, line: 1, message: '含 CRLF 行尾', fixable: true })
  }
  if (text.includes('\r') && !text.includes('\r\n')) {
    findings.push({ rule: 'F2', file: relative, line: 1, message: '含孤立 CR 行尾', fixable: true })
  }

  if (!text.endsWith('\n')) {
    findings.push({ rule: 'F3', file: relative, line: 1, message: '缺少结尾换行', fixable: true })
  } else if (/\n\s*\n$/.test(text)) {
    findings.push({ rule: 'F3', file: relative, line: 1, message: '结尾有多余空行', fixable: true })
  }

  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines.at(-1) === '') lines.pop()

  let previousBlank = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1

    if (/\s+$/.test(line)) {
      findings.push({ rule: 'F4', file: relative, line: lineNumber, message: '行尾空白', fixable: true })
    }
    if (/^\t/.test(line)) {
      findings.push({ rule: 'F5', file: relative, line: lineNumber, message: '缩进使用 Tab', fixable: true })
    }
    const isBlank = line.trim().length === 0
    if (isBlank && previousBlank) {
      findings.push({ rule: 'F8', file: relative, line: lineNumber, message: '连续空行', fixable: true })
    }
    previousBlank = isBlank

    if (line.length > MAX_LINE_LENGTH && !isExemptLongLine(line)) {
      findings.push({
        rule: 'F7',
        file: relative,
        line: lineNumber,
        message: `行过长（${line.length} > ${MAX_LINE_LENGTH}）`,
        fixable: false,
      })
    }
  }

  if (relative.endsWith('.json')) {
    try {
      const parsed = JSON.parse(text)
      const expected = `${JSON.stringify(parsed, null, 2)}\n`
      if (text !== expected) {
        findings.push({ rule: 'F6', file: relative, line: 1, message: 'JSON 未使用 2 空格缩进或键序不规范', fixable: true })
      }
    } catch (error) {
      findings.push({ rule: 'F6', file: relative, line: 1, message: `JSON 无法解析: ${error.message}`, fixable: false })
    }
  }

  return findings
}

/**
 * Mechanically fix the fixable issues.
 * @param {string} relative
 * @param {Buffer} buffer
 * @returns {string}
 */
export function fixText(relative, buffer) {
  let text = buffer.toString('utf8')
  text = text.replace(/^\uFEFF/, '')
  text = text.replace(/\r\n?/g, '\n')
  const lines = text.split('\n').map((line) => line.replace(/[ \t]+$/, '').replace(/^\t+/, (tabs) => '  '.repeat(tabs.length)))
  // Collapse runs of blank lines.
  const collapsed = []
  let blankRun = 0
  for (const line of lines) {
    if (line.length === 0) {
      blankRun += 1
      if (blankRun > 1) continue
    } else {
      blankRun = 0
    }
    collapsed.push(line)
  }
  while (collapsed.length > 0 && collapsed.at(-1) === '') collapsed.pop()
  let output = `${collapsed.join('\n')}\n`
  if (relative.endsWith('.json')) {
    try {
      output = `${JSON.stringify(JSON.parse(output), null, 2)}\n`
    } catch {
      // Leave an unparseable JSON alone so the caller still reports it.
    }
  }
  return output
}

function main() {
  const write = process.argv.includes('--write')
  const check = process.argv.includes('--check') || !write
  const files = collectFiles()
  /** @type {FormatFinding[]} */
  const all = []
  let fixed = 0

  for (const absolute of files) {
    const relative = path.relative(ROOT, absolute).split(path.sep).join('/')
    const buffer = fs.readFileSync(absolute)
    const findings = checkText(relative, buffer)
    if (write && findings.some((finding) => finding.fixable)) {
      const fixedText = fixText(relative, buffer)
      if (fixedText !== buffer.toString('utf8')) {
        fs.writeFileSync(absolute, fixedText, 'utf8')
        fixed += 1
        const remaining = checkText(relative, Buffer.from(fixedText, 'utf8'))
        all.push(...remaining)
        continue
      }
    }
    all.push(...findings)
  }

  for (const finding of all) {
    process.stdout.write(`${finding.fixable ? 'fixable' : 'manual '} ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}\n`)
  }
  const manual = all.filter((finding) => !finding.fixable)
  process.stdout.write(
    `\nformat: ${files.length} files, ${all.length} issues (${fixed} fixed), ${manual.length} need manual edit\n`,
  )

  if (check && !write) process.exit(all.length === 0 ? 0 : 1)
  process.exit(manual.length === 0 ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
