/**
 * C06 self-check for the `tools/` tree.
 *
 * Why this exists: C04's `scripts/static-check.mjs` and `scripts/format.mjs` cover
 * `base`, `scripts`, `core`, `tests` and `docs`. `tools/` was created by THIS card, and adding it to
 * those root-owned scripts is a C04 change (CT-00 §5.2 / docs/ENGINEERING-BOUNDARY.md §1 "scripts/ 只读").
 * Until that change request is accepted, nobody would check this tree — so this card checks its own
 * output against the SAME rules, using C04's exported `checkText` for the format half, and reports the
 * result as evidence.
 *
 * This is NOT a replacement for C04's gate. It is explicitly scoped to `tools/`, it reports that scope,
 * and it says in its own output that `tools/` is not yet covered by the root gate.
 *
 * Usage: node tools/dev/self-check.mjs
 *
 * @module tools/dev/self-check
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkText } from '../../scripts/format.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const TOOLS = path.join(ROOT, 'tools')

/** Format-fixable rules are reported separately, because they are also the ones a formatter can fix. */
const FORMAT_RULES = new Set(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F8'])

/**
 * The subset of C04's static rules that applies to product source in this tree.
 *
 * Deliberately a SUBSET: rules about `base/` internals (S2 clock, S3 random, S6 console) exist because
 * `base/` must be deterministic and redacted. `tools/` uses the injected Clock and an injected transport
 * instead, so the equivalent guarantees are structural there rather than textual. Every rule kept here
 * is one this tree can actually violate.
 */
const RULES = [
  {
    id: 'S1',
    message: 'ESM 模块中不允许 CommonJS 的 require 调用',
    // dsh-allow S1: 规则定义本身必须写出该模式，才能检测它
    test: (line) => /\brequire\s*\(/.test(line) && !/\/\/.*require/.test(line),
  },
  {
    id: 'S4',
    message: '源码中出现绝对 Windows 路径字面量',
    test: (line) => /['"`][A-Za-z]:[\\/][^'"`]*['"`]/.test(line) && !/\\\\/.test(line),
  },
  {
    id: 'S5',
    message: '使用了禁止的宿主 API',
    test: (line) => /\bctx\.homePaths\b/.test(line) || /\bctx\.userApproval\b/.test(line),
  },
  {
    id: 'S11',
    message: '禁止 eval / new Function',
    test: (line) => /\beval\s*\(/.test(line) || /\bnew\s+Function\s*\(/.test(line),
  },
  {
    id: 'S9',
    message: '可能的秘密字面量',
    test: (line) => /\bsk-[A-Za-z0-9_-]{16,}/.test(line) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line),
  },
  {
    id: 'S8',
    message: '遗留标记未标注责任卡',
    // dsh-allow S8: 规则定义本身必须写出这些标记
    test: (line) =>
      /(?:^|[^A-Za-z])(TODO|FIXME|XXX|HACK)(?:$|[^A-Za-z])/.test(line) && !/\(C\d+|owner|@/.test(line),
    severity: 'warn',
  },
]

/**
 * Parse an inline exemption marker, exactly like C04's checker so the two read the same.
 * Format: `dsh-allow S2,S9: reason`
 * @param {string} line
 * @returns {{ rules: Set<string>, reason: string } | null}
 */
function parseExemption(line) {
  const match = line.match(/dsh-allow\s+([A-Z0-9, ]+):\s*(.*)$/)
  if (!match) return null
  return { rules: new Set(match[1].split(',').map((rule) => rule.trim()).filter(Boolean)), reason: match[2].trim() }
}

/** @returns {string[]} absolute paths of every .js under tools/ */
function collectFiles() {
  /** @type {string[]} */
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) out.push(full)
    }
  }
  walk(TOOLS)
  return out.sort()
}

/**
 * Check one file against the rules above.
 * @param {string} absolute
 * @returns {Array<{ rule: string, line: number, message: string, severity: string }>}
 */
function checkStatic(absolute) {
  /** @type {Array<{ rule: string, line: number, message: string, severity: string }>} */
  const findings = []
  const text = fs.readFileSync(absolute, 'utf8')

  // S7: module header within the first three lines.
  const lines = text.split(/\r?\n/)
  const headerStart = lines[0]?.startsWith('#!') ? 1 : 0
  const hasHeader = lines.slice(headerStart, headerStart + 3).some((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith('/**') || trimmed.startsWith('//') || trimmed.startsWith('/*')
  })
  if (!hasHeader) findings.push({ rule: 'S7', line: 1, message: '缺少文件头注释', severity: 'error' })

  let inBlockComment = false
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    const exemption = parseExemption(raw)
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inBlockComment = true
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    for (const rule of RULES) {
      if (exemption !== null && exemption.rules.has(rule.id)) continue
      if (rule.test(raw)) {
        findings.push({ rule: rule.id, line: index + 1, message: rule.message, severity: rule.severity ?? 'error' })
      }
    }
  }
  return findings
}

/**
 * Run the whole self-check.
 * @returns {{ files: number, findings: Array<object>, errors: number, warnings: number, ok: boolean }}
 */
export function selfCheck() {
  const files = collectFiles()
  /** @type {Array<object>} */
  const findings = []
  for (const absolute of files) {
    const relative = path.relative(ROOT, absolute).split(path.sep).join('/')
    const buffer = fs.readFileSync(absolute)
    for (const format of checkText(relative, buffer)) {
      findings.push({
        rule: format.rule,
        file: relative,
        line: format.line,
        message: format.message,
        severity: FORMAT_RULES.has(format.rule) ? 'error' : 'error',
        fixable: format.fixable,
      })
    }
    for (const stat of checkStatic(absolute)) {
      findings.push({ ...stat, file: relative, fixable: false })
    }
  }
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warn').length
  return { files: files.length, findings, errors, warnings, ok: errors === 0 }
}

function main() {
  const result = selfCheck()
  for (const finding of result.findings) {
    const level = finding.severity === 'error' ? 'error' : 'warn'
    process.stdout.write(`${level} ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}\n`)
  }
  process.stdout.write(
    `\nself-check: ${result.files} files, ${result.errors} errors, ${result.warnings} warnings\n`,
  )
  process.stdout.write(
    'scope: tools/ only. C04 的 static-check.mjs 与 format.mjs 尚未覆盖 tools/，' +
      '把 tools/ 加入其目标目录是 C04 的根文件变更（本卡已提交变更请求）。\n',
  )
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
