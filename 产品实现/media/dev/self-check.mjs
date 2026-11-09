#!/usr/bin/env node
/**
 * Scope-local static check for `product/media`.
 *
 * The shared checker (`scripts/static-check.mjs`) scans a fixed list of directories owned by C04 and
 * does not include `media/`; adding a directory there would be a root-file change belonging to
 * another card. So this module carries the same rules for its own tree, and the receipt states that
 * the shared gate does not cover it.
 *
 * Rules (subset of the shared S-rules that apply here):
 *   M1 no `require()` in ESM
 *   M2 no absolute Windows/UNC path literals in source
 *   M3 every source file starts with a module header comment
 *   M4 no TODO/FIXME/XXX without an owner tag
 *   M5 UTF-8 without BOM and exactly one trailing newline
 *   M6 no eval / new Function (CT-12 untrusted-code rule)
 *   M7 no `console.*` in module source (tests/dev scripts may print)
 *
 * Usage: node media/dev/self-check.mjs [--json]
 *
 * @module media/dev/self-check
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_ROOT = path.resolve(HERE, '..')

/** Files exempt from M7 because printing is their job. */
const PRINTERS = new Set(['dev/self-check.mjs', 'dev/evidence-run.mjs'])

/** @param {string} dir @param {string[]} out */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'evidence' || entry.name === 'node_modules') continue
      walk(full, out)
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      out.push(full)
    }
  }
  return out
}

/**
 * @returns {{
 *   ok: boolean,
 *   findings: Array<{ rule: string, file: string, line: number, message: string }>,
 *   checkedFiles: number,
 * }}
 */
export function checkModule() {
  const findings = []
  const files = walk(MODULE_ROOT)
  for (const absolute of files) {
    const relative = path.relative(MODULE_ROOT, absolute).split(path.sep).join('/')
    const buffer = fs.readFileSync(absolute)
    const text = buffer.toString('utf8')
    const lines = text.split(/\r?\n/)

    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      findings.push({ rule: 'M5', file: relative, line: 1, message: '文件带 UTF-8 BOM' })
    }
    if (!text.endsWith('\n')) {
      findings.push({ rule: 'M5', file: relative, line: lines.length, message: '缺少结尾换行' })
    } else if (text.endsWith('\n\n')) {
      findings.push({ rule: 'M5', file: relative, line: lines.length, message: '多余结尾空行' })
    }

    const bodyLines = lines[0]?.startsWith('#!') ? lines.slice(1) : lines
    const headerLines = bodyLines.slice(0, 4).filter((line) => line.trim().length > 0)
    if (headerLines.length === 0 || !/^(\/\*\*|\/\/|\/\*)/.test(headerLines[0].trim())) {
      findings.push({ rule: 'M3', file: relative, line: 1, message: '缺少模块头注释' })
    }
    const isRuleFile = relative === 'dev/self-check.mjs'

    let inBlock = false
    for (const [index, raw] of lines.entries()) {
      const trimmed = raw.trim()
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false
        continue
      }
      if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
        inBlock = true
        continue
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
      const line = index + 1
      // 本行是检测器要匹配的规则字面量，不是真的要写 CommonJS 调用；改写成拆字拼接只会让规则更难审计。
      if (!isRuleFile && /\brequire\s*\(/.test(raw) && !/\/\/.*require/.test(raw)) { // dsh-allow S1: 规则字面量
        findings.push({ rule: 'M1', file: relative, line, message: 'ESM 中不允许 CommonJS 的 require 调用' })
      }
      if (/['"`][A-Za-z]:[\\/][^'"`]*['"`]/.test(raw) && !/\\\\.*:\\/.test(raw)) {
        // Paths under test fixtures are computed at runtime; a literal drive path is still suspicious.
        findings.push({ rule: 'M2', file: relative, line, message: '源码中出现绝对 Windows 路径字面量' })
      }
      if (/\b(eval|new Function)\s*\(/.test(raw)) {
        findings.push({ rule: 'M6', file: relative, line, message: '禁止 eval/new Function' })
      }
      if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(raw) && !PRINTERS.has(relative)) {
        findings.push({ rule: 'M7', file: relative, line, message: '模块源码中不应直接 console，请交给调用方' })
      }
      if (!isRuleFile && /\b(TODO|FIXME|XXX)\b/.test(raw) && !/\[(C1[0-9]|C0[0-9])\]/.test(raw)) {
        findings.push({ rule: 'M4', file: relative, line, message: '待办标记必须带负责卡标签，如 [C12]' })
      }
    }
  }
  return { ok: findings.length === 0, findings, checkedFiles: files.length }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkModule()
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    for (const finding of result.findings) {
      process.stdout.write(`${finding.rule} ${finding.file}:${finding.line} ${finding.message}\n`)
    }
    process.stdout.write(
      `media 自检：${result.checkedFiles} 个文件，${result.findings.length} 个问题（${result.ok ? '通过' : '失败'}）\n`,
    )
  }
  process.exit(result.ok ? 0 : 1)
}
