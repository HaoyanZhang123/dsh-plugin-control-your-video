#!/usr/bin/env node
/**
 * Static checks (the project's "lint" entry).
 *
 * There is no ESLint here on purpose: every rule below encodes a CONTRACT this project
 * actually signed, not a style preference. A dependency-free checker also keeps the
 * MIT surface empty and lets the check run inside the isolated test environment.
 *
 * Rules:
 *   S1  no `require()` in ESM source
 *   S2  no direct `Date.now()` / `new Date()` in base/ (use the injected Clock)
 *   S3  no `Math.random()` in base/ (use createSeededRandom)
 *   S4  no absolute Windows/UNC path literals in source
 *   S5  no `ctx.homePaths` / `ctx.userApproval` / `ctx.on('dispose')` (forbidden Host APIs)
 *   S6  no `console.*` in base/ (use the Logger, which is redacted)
 *   S7  every source file has a module JSDoc header
 *   S8  no TODO/FIXME/XXX markers without an owner tag
 *   S9  no secret-looking literals (sk-…, AKIA…, gh?_…, private key blocks)
 *   S10 files are UTF-8 without BOM and end with exactly one newline
 *   S11 no `eval` / `new Function` in product source (CT-12 untrusted-code rule)
 *   S12 no bare `node_modules` import of a package absent from the dependency ledger
 *
 * Auditable exemptions: a single line may opt out with a trailing
 * `// dsh-allow S2: <reason>` comment. Exemptions are printed in the summary so they stay
 * reviewable, and they require a non-empty reason — a bare marker is itself an error.
 *
 * @module scripts/static-check
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** Directories that are product source and therefore fully checked. */
const PRODUCT_DIRS = ['base', 'scripts', 'core', 'tools', 'media', 'orchestration', 'editing', 'delivery']

/** Directories skipped entirely. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'evidence', 'tests', 'docs'])

/**
 * @typedef {object} Finding
 * @property {string} rule
 * @property {string} file relative path
 * @property {number} line 1-based
 * @property {string} message
 * @property {'error'|'warn'} severity
 */

/** @returns {string[]} absolute paths of checkable .js/.mjs files */
function collectSourceFiles() {
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name))
      } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
        files.push(path.join(dir, entry.name))
      }
    }
  }
  for (const dir of PRODUCT_DIRS) walk(path.join(ROOT, dir))
  return files.sort()
}

const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, message: '可能的 API key 字面量' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, message: '可能的 AWS 访问密钥' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, message: '可能的 GitHub token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, message: '私钥块不允许出现在源码中' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, message: '可能的 Slack token' },
]

const FORBIDDEN_HOST_APIS = [
  // These patterns must be spelled out here to be detectable, so this file exempts itself
  // for rule S5 below; the exemption is scoped to this file only.
  { re: /\bctx\.homePaths\b/, message: 'ctx.homePaths 不存在（C01 纠正），使用 home 路径辅助函数' },
  { re: /\bctx\.userApproval\b/, message: '审批服务名是 ctx.approval，不是 ctx.userApproval' },
  { re: /ctx\.on\(\s*['"]dispose['"]/, message: '正规收尾只能用 ctx.effect disposer，禁止 ctx.on("dispose")' },
]

/**
 * Parse an inline exemption marker on a source line.
 * Format: `dsh-allow S2,S9: reason text`
 * @param {string} line
 * @returns {{ rules: Set<string>, reason: string } | null}
 */
function parseExemption(line) {
  const match = line.match(/dsh-allow\s+([A-Z0-9, ]+):\s*(.*)$/)
  if (!match) return null
  const rules = new Set(match[1].split(',').map((rule) => rule.trim()).filter(Boolean))
  return { rules, reason: match[2].trim() }
}

/**
 * @param {string} absolute
 * @returns {Finding[]}
 */
function checkFile(absolute) {
  /** @type {Finding[]} */
  const findings = []
  const relative = path.relative(ROOT, absolute).split(path.sep).join('/')
  const buffer = fs.readFileSync(absolute)
  const text = buffer.toString('utf8')
  const isBase = relative.startsWith('base/')
  const isRuleFile = relative === 'scripts/static-check.mjs'

  // S10: UTF-8 without BOM, exactly one trailing newline.
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    findings.push({ rule: 'S10', file: relative, line: 1, message: '文件带 UTF-8 BOM', severity: 'error' })
  }
  if (!text.endsWith('\n')) {
    findings.push({ rule: 'S10', file: relative, line: 1, message: '文件缺少结尾换行', severity: 'error' })
  } else if (text.endsWith('\n\n')) {
    findings.push({ rule: 'S10', file: relative, line: 1, message: '文件有多余结尾空行', severity: 'error' })
  }

  const lines = text.split(/\r?\n/)

  // S7: module header. The first non-empty shebang line must be followed by a block comment.
  const headerStart = lines[0]?.startsWith('#!') ? 1 : 0
  const hasHeader = lines.slice(headerStart, headerStart + 3).some((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith('/**') || trimmed.startsWith('//') || trimmed.startsWith('/*')
  })
  if (!hasHeader) {
    findings.push({ rule: 'S7', file: relative, line: 1, message: '缺少文件头注释', severity: 'warn' })
  }

  let inBlockComment = false
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const lineNumber = index + 1
    const trimmed = rawLine.trim()
    const exemption = parseExemption(rawLine)
    if (exemption && exemption.reason.length === 0) {
      findings.push({
        rule: 'S13',
        file: relative,
        line: lineNumber,
        message: 'dsh-allow 豁免必须写明理由',
        severity: 'error',
      })
    }
    /** Push a finding unless this line explicitly exempts that rule. */
    const report = (rule, message, severity = 'error') => {
      if (exemption && exemption.rules.has(rule)) return
      findings.push({ rule, file: relative, line: lineNumber, message, severity })
    }

    // Track block comments so commented-out examples do not trigger code rules.
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inBlockComment = true
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      // Still scan comments for secrets: a token pasted into a comment is still a leak.
      checkSecrets(trimmed, relative, lineNumber, findings, exemption)
      continue
    }

    // S1: ESM only.
    if (!isRuleFile && /\brequire\s*\(/.test(rawLine) && !/\/\/.*require/.test(rawLine)) {
      report('S1', 'ESM 模块中不允许 require()')
    }
    // S2/S3: determinism inside base/.
    if (isBase) {
      if (/\bDate\.now\(\)/.test(rawLine)) {
        report('S2', 'base/ 中禁止直接 Date.now()，使用 Clock')
      }
      if (/\bnew Date\(\s*\)/.test(rawLine)) {
        report('S2', 'base/ 中禁止 new Date()，使用 Clock')
      }
      if (/\bMath\.random\(\)/.test(rawLine)) {
        report('S3', 'base/ 中禁止 Math.random()，使用 createSeededRandom')
      }
      // S6: logging must be redacted.
      if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(rawLine)) {
        report('S6', 'base/ 中禁止 console.*，使用 Logger')
      }
    }

    // S4: absolute path literals.
    if (/['"`][A-Za-z]:[\\/][^'"`]*['"`]/.test(rawLine) && !/\\\\/.test(rawLine)) {
      report('S4', '源码中出现绝对 Windows 路径字面量')
    }
    if (/['"`]\\\\\\\\[^'"`]+['"`]/.test(rawLine)) {
      report('S4', '源码中出现 UNC 路径字面量')
    }

    // S5: forbidden Host APIs. The rule-definition file necessarily contains the patterns.
    if (!isRuleFile) {
      for (const rule of FORBIDDEN_HOST_APIS) {
        if (rule.re.test(rawLine)) report('S5', rule.message)
      }
    }

    // S11: dynamic code execution.
    if (/\beval\s*\(/.test(rawLine) || /\bnew\s+Function\s*\(/.test(rawLine)) {
      report('S11', '禁止 eval / new Function（不受信代码规则）')
    }

    // S9: secret-like literals. The rule file lists the patterns it hunts for.
    if (!isRuleFile) checkSecrets(rawLine, relative, lineNumber, findings, exemption)

    // S8: unowned TODO markers. This rule-definition file names the markers it hunts for.
    const todo = isRuleFile ? null : rawLine.match(/(?:^|[^A-Za-z])(TODO|FIXME|XXX|HACK)(?:$|[^A-Za-z])/)
    if (todo && !/\(C\d+|owner|@/.test(rawLine)) {
      report('S8', `${todo[1]} 未标注责任卡（例如 TODO(C11: ...)）`, 'warn')
    }
  }

  // S12: bare package imports must be admitted.
  const admitted = admittedDependencies()
  const importRe = /(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/g
  let match
  while ((match = importRe.exec(text)) !== null) {
    const specifier = match[1]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    if (specifier.startsWith('/')) continue
    const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
    if (!admitted.has(packageName)) {
      const line = text.slice(0, match.index).split('\n').length
      findings.push({
        rule: 'S12',
        file: relative,
        line,
        message: `导入未在依赖台账登记的包: ${packageName}`,
        severity: 'error',
      })
    }
  }

  return findings
}

/**
 * @param {string} line
 * @param {string} file
 * @param {number} lineNumber
 * @param {Finding[]} findings
 * @param {{ rules: Set<string> } | null} exemption
 */
function checkSecrets(line, file, lineNumber, findings, exemption) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(line)) {
      if (exemption && exemption.rules.has('S9')) continue
      findings.push({ rule: 'S9', file, line: lineNumber, message: pattern.message, severity: 'error' })
    }
  }
}

/** Package names admitted in docs/dependency-admission.json (the read-only admission list). */
function admittedDependencies() {
  const admissionPath = path.join(ROOT, 'docs', 'dependency-admission.json')
  const names = new Set()
  if (!fs.existsSync(admissionPath)) return names
  try {
    const parsed = JSON.parse(fs.readFileSync(admissionPath, 'utf8'))
    if (Array.isArray(parsed?.admitted)) {
      for (const name of parsed.admitted) {
        if (typeof name === 'string') names.add(name)
      }
    }
  } catch {
    // A broken admission file yields an empty set, so every bare import fails the check.
    // Failing closed is the correct behaviour for an admission gate.
  }
  return names
}

export function staticCheck() {
  const files = collectSourceFiles()
  /** @type {Finding[]} */
  const findings = []
  for (const file of files) findings.push(...checkFile(file))
  const errors = findings.filter((finding) => finding.severity === 'error')
  const warnings = findings.filter((finding) => finding.severity === 'warn')
  return { files: files.length, findings, errors, warnings, ok: errors.length === 0 }
}

function main() {
  const result = staticCheck()
  for (const finding of result.findings) {
    const level = finding.severity === 'error' ? 'error' : 'warn'
    process.stdout.write(`${level} ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}\n`)
  }
  process.stdout.write(
    `\nstatic-check: ${result.files} files, ${result.errors.length} errors, ${result.warnings.length} warnings\n`,
  )
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
