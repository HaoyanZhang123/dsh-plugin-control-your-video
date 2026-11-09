#!/usr/bin/env node
/**
 * Card-owned static checks for PRODUCT-UI.
 *
 * The shared `scripts/static-check.mjs` owns base/scripts/core/tools; `ui/` is a different write
 * scope, so this card checks its own tree with the rules that actually matter here:
 *
 *   U1  no `require()` in client/host source (ESM / bundler contract)
 *   U2  no `eval` / `new Function` in product UI source (CT-12 untrusted-code rule)
 *   U3  no forbidden Host APIs (`ctx.homePaths`, `ctx.userApproval`, `ctx.on('dispose')`)
 *   U4  no secret-looking literals
 *   U5  no TODO/FIXME/XXX without an owner tag
 *   U6  UTF-8 without BOM, exactly one trailing newline
 *   U7  every client bundler source is import-free (the concatenation contract)
 *   U8  no absolute Windows/UNC path literals outside dev tools
 *
 * Usage: node ui/dev/check.mjs [--quiet]
 *
 * @module ui/dev/check
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(HERE, '..')
const CLIENT_ROOT = path.join(UI_ROOT, 'client')

const SECRETS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Extracted third-party references and the throwaway isolated Host are not product source.
      if (entry.name === '_refs' || entry.name === '_tmp-dsh' || entry.name.startsWith('_tmp-dsh')) continue
      collect(full, out)
    }
    else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) out.push(full)
  }
  return out
}

function relative(file) {
  return path.relative(UI_ROOT, file).split(path.sep).join('/')
}

/** @returns {Array<{rule: string, file: string, line: number, message: string}>} */
export function runChecks() {
  const findings = []
  const files = collect(UI_ROOT)
  for (const file of files) {
    const rel = relative(file)
    const buffer = fs.readFileSync(file)
    const text = buffer.toString('utf8')
    const lines = text.split(/\r?\n/)
    const isDev = rel.startsWith('dev/')
    const isClientSource = rel.startsWith('client/') || rel.startsWith('host/')

    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      findings.push({ rule: 'U6', file: rel, line: 1, message: '文件带 UTF-8 BOM' })
    }
    if (!text.endsWith('\n') || text.endsWith('\n\n')) {
      findings.push({ rule: 'U6', file: rel, line: lines.length, message: '文件必须以单个换行结束' })
    }
    const afterShebang = text.startsWith('#!') ? text.slice(text.indexOf('\n') + 1) : text
    if (!/^\s*\/\*\*/.test(afterShebang) && !rel.startsWith('plugin/')) {
      findings.push({ rule: 'U6b', file: rel, line: 1, message: '缺少模块 JSDoc 头' })
    }

    lines.forEach((line, index) => {
      const lineNo = index + 1
      if (isClientSource && /\brequire\s*\(/.test(line)) {
        findings.push({ rule: 'U1', file: rel, line: lineNo, message: 'client/host 源码不允许 require()' })
      }
      if (!isDev && /\beval\s*\(|new\s+Function\s*\(/.test(line)) {
        findings.push({ rule: 'U2', file: rel, line: lineNo, message: '产品源码不允许 eval / new Function' })
      }
      const isSelf = rel === 'dev/check.mjs'
      if (!isSelf && /\bctx\.homePaths\b|\bctx\.userApproval\b|ctx\.on\(\s*['"]dispose['"]/.test(line)) {
        findings.push({ rule: 'U3', file: rel, line: lineNo, message: '使用了不存在的 Host API' })
      }
      for (const pattern of SECRETS) {
        if (pattern.test(line)) findings.push({ rule: 'U4', file: rel, line: lineNo, message: '疑似密钥字面量' })
      }
      if (!isSelf && /\b(TODO|FIXME|XXX)\b/.test(line) && !/dsh-owner\s+[A-Za-z0-9_-]+/.test(line)) {
        findings.push({ rule: 'U5', file: rel, line: lineNo, message: 'TODO/FIXME 需要 dsh-owner 标记' })
      }
      if (!isDev && /(?:^|['"`\s])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9])/.test(line)) {
        // Windows drive / UNC literals are allowed only in dev tools and in tests.
        findings.push({ rule: 'U8', file: rel, line: lineNo, message: '源码中出现绝对 Windows/UNC 路径' })
      }
      if (rel.startsWith('client/') && /^\s*import\s/.test(line)) {
        findings.push({ rule: 'U7', file: rel, line: lineNo, message: 'client 源码必须无 import，构建按固定顺序拼接' })
      }
    })
  }

  // The client sources must all be listed by the bundler, otherwise a file silently stops shipping.
  const builder = fs.readFileSync(path.join(HERE, 'build-client.mjs'), 'utf8')
  const listed = new Set([...builder.matchAll(/'client\/([^']+)'/g)].map((match) => match[1]))
  for (const file of collect(CLIENT_ROOT)) {
    const rel = relative(file).replace(/^client\//, '')
    if (!listed.has(rel)) {
      findings.push({ rule: 'U9', file: `client/${rel}`, line: 1, message: '客户端源文件没有进入构建清单' })
    }
  }
  return findings
}

function main() {
  const findings = runChecks()
  const quiet = process.argv.includes('--quiet')
  if (!quiet) {
    for (const finding of findings) {
      process.stdout.write(`${finding.rule} ${finding.file}:${finding.line} ${finding.message}\n`)
    }
  }
  process.stdout.write(`ui static check: ${collect(UI_ROOT).length} files, ${findings.length} findings\n`)
  process.exit(findings.length === 0 ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
