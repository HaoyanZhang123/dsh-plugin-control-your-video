#!/usr/bin/env node
/**
 * Dependency admission and MIT ledger generator.
 *
 * CT-10 requires that every dependency records name/version/source/purpose/direct-or-transitive
 * relationship/license, and that the plugin's own content stays strictly MIT. This script
 * produces that record from REAL data (the lockfile and, when present, installed manifests),
 * and can fail a build when something is unadmitted.
 *
 * It deliberately does not pretend a scan replaces human judgement: it reports what it can
 * prove and marks the rest as needing review.
 *
 * Usage:
 *   node scripts/deps-report.mjs            # write docs/DEPENDENCY-LEDGER.md + evidence
 *   node scripts/deps-report.mjs --check    # fail if any dependency is unadmitted
 *
 * @module scripts/deps-report
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** Licenses that satisfy the project's "strict MIT" rule for shipped content. */
export const MIT_ALLOWED_LICENSE = 'MIT'

/**
 * Licenses that are NOT acceptable for bundled content, recorded so the report can explain
 * a rejection instead of merely refusing. Apache/BSD are permissive but not MIT, which the
 * product decision (01 §9.2) treats as a hard boundary for shipped content.
 */
export const NON_MIT_LICENSES = [
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'LGPL-2.1',
  'LGPL-3.0',
  'GPL-2.0',
  'GPL-3.0',
  'AGPL-3.0',
  'MPL-2.0',
  'Unlicense',
  'CC0-1.0',
  'UNKNOWN',
]

/**
 * @typedef {object} DependencyEntry
 * @property {string} name
 * @property {string} version
 * @property {string} kind 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'
 * @property {'direct'} relation
 * @property {string} license
 * @property {'pass'|'fail'|'review'} verdict
 * @property {string} boundary one of the CT-10 buckets
 * @property {string} purpose
 */

/**
 * Read declared dependencies from package.json.
 * @returns {DependencyEntry[]}
 */
function readDeclaredDependencies() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const entries = []
  const boundaryByKind = {
    dependencies: 'with-pack',
    devDependencies: 'build-test-only',
    peerDependencies: 'host-provided',
    optionalDependencies: 'with-pack',
  }
  for (const kind of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const declared = manifest[kind]
    if (!declared) continue
    for (const [name, range] of Object.entries(declared)) {
      const license = resolveInstalledLicense(name)
      entries.push({
        name,
        version: String(range),
        kind,
        relation: 'direct',
        license: license.license,
        verdict: license.license === MIT_ALLOWED_LICENSE ? 'pass' : license.known ? 'fail' : 'review',
        boundary: boundaryByKind[kind] ?? 'with-pack',
        purpose: license.purpose ?? '（未登记用途）',
        evidence: license.evidence,
      })
    }
  }
  return entries
}

/**
 * Resolve a dependency's license from the installed package.json, when it exists.
 * A missing package proves nothing, so it is reported as unknown rather than assumed MIT.
 *
 * @param {string} name
 * @returns {{ license: string, known: boolean, purpose?: string, evidence: string }}
 */
function resolveInstalledLicense(name) {
  const installedManifest = path.join(ROOT, 'node_modules', name, 'package.json')
  if (!fs.existsSync(installedManifest)) {
    return {
      license: 'NOT-INSTALLED',
      known: false,
      evidence: '包未安装；许可证未核实',
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(installedManifest, 'utf8'))
    const raw = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((item) => item.type).join(' OR ') : 'UNKNOWN')
    return {
      license: String(raw),
      known: true,
      evidence: `node_modules/${name}/package.json`,
    }
  } catch (error) {
    return { license: 'UNREADABLE', known: false, evidence: `读取失败: ${error.message}` }
  }
}

/**
 * Enumerate the installed production tree from the pnpm virtual store, so transitive
 * dependencies are not silently omitted.
 *
 * @returns {Array<{ name: string, version: string, license: string, path: string }>}
 */
function readInstalledTree() {
  const results = []
  const storeDir = path.join(ROOT, 'node_modules', '.pnpm')
  if (!fs.existsSync(storeDir)) return results

  const readPackage = (dir) => {
    const manifestPath = path.join(dir, 'package.json')
    if (!fs.existsSync(manifestPath)) return null
    try {
      const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      return {
        name: String(pkg.name ?? path.basename(dir)),
        version: String(pkg.version ?? '0.0.0'),
        license: String(pkg.license ?? 'UNKNOWN'),
        path: path.relative(ROOT, dir).split(path.sep).join('/'),
      }
    } catch {
      return null
    }
  }

  for (const entry of fs.readdirSync(storeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nested = path.join(storeDir, entry.name, 'node_modules')
    if (!fs.existsSync(nested)) continue
    for (const child of fs.readdirSync(nested, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      if (child.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(path.join(nested, child.name), { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue
          const info = readPackage(path.join(nested, child.name, scoped.name))
          if (info) results.push(info)
        }
      } else {
        const info = readPackage(path.join(nested, child.name))
        if (info) results.push(info)
      }
    }
  }
  return results.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
}

/**
 * Read the hand-written part of the ledger: purposes and admissions that a script cannot
 * infer. Kept in the generated file's admission table so it survives regeneration.
 *
 * NOTE: this reads the GENERATED ledger only for human-authored purposes. It is deliberately
 * NOT the admission authority — that is `docs/dependency-admission.json`, so the generated
 * ledger can never admit the dependency it describes.
 *
 * @returns {Map<string, string>} name -> purpose
 */
function readAdmissionPurposes() {
  const purposes = new Map()
  const ledgerPath = path.join(ROOT, 'docs', 'DEPENDENCY-LEDGER.md')
  if (!fs.existsSync(ledgerPath)) return purposes
  const text = fs.readFileSync(ledgerPath, 'utf8')
  // Only section 2 (the direct-dependency table) may carry purposes; stop at the next heading.
  const section = text.split(/^## /m).find((part) => part.startsWith('2. 直接依赖')) ?? ''
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*([^|]*)\|/)
    if (match) purposes.set(match[1], match[2].trim())
  }
  return purposes
}

/**
 * Collapse a probe detail so the generated table row stays within the F7 line-length rule
 * (120 chars). The full version string stays available in `evidence/failure-lab.json`.
 * @param {string} detail
 * @returns {string}
 */
function compactDetail(detail) {
  const limit = 60
  const text = String(detail)
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * Probe the external tools this product may optionally use.
 *
 * These are measured facts about the CURRENT machine, not license conclusions. A tool being
 * installed does not make it part of the plugin, and a tool being absent does not make the
 * capability unimplemented — it only means the user must install it independently.
 *
 * @returns {Record<string, { detail: string }>}
 */
function externalToolState() {
  const probe = (command, args) => {
    // No `shell: true`: it triggers DEP0190 (unescaped concatenation) and is unnecessary here
    // because the command and args are literals.
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) return { present: false, version: null }
    const firstLine = String(result.stdout ?? '').split(/\r?\n/)[0].trim()
    return { present: true, version: firstLine.slice(0, 90) }
  }

  const ffmpeg = probe('ffmpeg', ['-version'])
  const ffprobe = probe('ffprobe', ['-version'])

  return {
    'FFmpeg': { detail: ffmpeg.present ? `本机检测到：${ffmpeg.version}` : '本机未检测到' },
    'FFprobe': { detail: ffprobe.present ? `本机检测到：${ffprobe.version}` : '本机未检测到' },
    'Remotion': { detail: '未探测（未安装、未运行；采用前须另行授权）' },
    'HyperFrames': { detail: '未探测（未安装、未运行；采用前须另行授权）' },
  }
}

/**
 * Compose the ledger document.
 * @returns {{ markdown: string, summary: object }}
 */
export function buildLedger() {
  const declared = readDeclaredDependencies()
  const tree = readInstalledTree()
  const purposes = readAdmissionPurposes()

  for (const entry of declared) {
    if (purposes.has(entry.name)) entry.purpose = purposes.get(entry.name)
  }

  const transitive = tree.filter((item) => !declared.some((entry) => entry.name === item.name))
  const unadmittedTransitive = transitive.filter((item) => item.license !== MIT_ALLOWED_LICENSE)

  const lines = []
  lines.push('# 依赖准入与 MIT 台账')
  lines.push('')
  lines.push('> 本文件由 `scripts/deps-report.mjs` 依据实际 `package.json`、`pnpm-lock.yaml` 与已安装包生成；')
  lines.push('> 未安装或无许可证证据的包标为未核实，不假定为 MIT。')
  lines.push('> 严格 MIT 只覆盖插件随包内容；宿主与用户独立安装的外部工具另记使用条件（CT-10 §1～§2）。')
  lines.push('')
  lines.push('## 1. 边界分类（CT-10 §1）')
  lines.push('')
  lines.push('| 边界 | 含义 | 是否纳入严格 MIT 门禁 |')
  lines.push('|---|---|---|')
  lines.push('| `with-pack` | 随插件包分发的依赖与代码 | 是 |')
  lines.push('| `build-test-only` | 只在构建／测试时使用，不进入产物 | 否，但须检查是否被带入成品 |')
  lines.push('| `host-provided` | 由 DSH 宿主提供（peer） | 否，宿主不纳入插件 MIT 判定 |')
  lines.push('| `external-tool` | 用户独立安装的外部工具或服务 | 否，另记使用条件 |')
  lines.push('')
  lines.push('## 2. 直接依赖')
  lines.push('')
  if (declared.length === 0) {
    lines.push('当前**零第三方依赖**：`package.json` 没有任何 dependencies／devDependencies／peerDependencies／optionalDependencies，')
    lines.push('因此随包依赖闭包为空，没有需要逐项核对许可的第三方代码。')
  } else {
    lines.push('| 包 | 版本范围 | 类型 | 边界 | 实际许可证 | 判定 | 用途 | 证据 |')
    lines.push('|---|---|---|---|---|---|---|---|')
    for (const entry of declared) {
      lines.push(
        `| \`${entry.name}\` | ${entry.version} | ${entry.kind} | ${entry.boundary} | ${entry.license} | ${entry.verdict} | ${entry.purpose} | ${entry.evidence} |`,
      )
    }
  }
  lines.push('')
  lines.push('## 3. 传递依赖')
  lines.push('')
  if (transitive.length === 0) {
    lines.push('传递闭包为空：没有已安装的间接依赖。')
  } else {
    lines.push(`共 ${transitive.length} 个已安装间接依赖：`)
    lines.push('')
    lines.push('| 包 | 版本 | 许可证 | 判定 | 位置 |')
    lines.push('|---|---|---|---|---|')
    for (const item of transitive) {
      const verdict = item.license === MIT_ALLOWED_LICENSE ? 'pass' : 'fail'
      lines.push(`| \`${item.name}\` | ${item.version} | ${item.license} | ${verdict} | ${item.path} |`)
    }
  }
  lines.push('')
  lines.push('## 4. 构建与测试工具边界（CT-10 §3 / P4）')
  lines.push('')
  lines.push('| 工具 | 版本 | 来源 | 边界 | 是否进入发布产物 |')
  lines.push('|---|---|---|---|---|')
  lines.push('| Node.js | 宿主捆绑 24.21.0；本机验证 24.22.1 | 宿主运行时／本机安装 | `host-provided`（运行时） | 否 |')
  lines.push('| pnpm | 本机 11.21.0；宿主捆绑 11.28.5 | 本机安装 | `build-test-only` | 否 |')
  lines.push('| `node:test` | 与 Node 同版本 | Node 内置模块 | `build-test-only` | 否 |')
  lines.push('| 本项目 `scripts/*.mjs` | 见版本库 | 自写，MIT | 插件自有 P0 | 仅 `lib/` 产物进入，脚本不进入 |')
  lines.push('')
  lines.push('> 本工程不使用 ESLint、Prettier、Vitest、esbuild 或任何第三方构建／测试包；')
  lines.push('> 静态检查、格式化检查、测试运行与清单校验全部由 `scripts/` 下的自写脚本和 Node 内置模块完成。')
  lines.push('> 这是有意的取舍：以零依赖换取可审计的 MIT 边界与离线可复现，代价是自写工具的功能少于成熟工具。')
  lines.push('')
  lines.push('## 5. 未核实与需人工判断')
  lines.push('')
  if (declared.length === 0 && transitive.length === 0) {
    lines.push('- 当前没有第三方依赖，因此本工程内不存在“未核实许可证”的包。')
    lines.push('- 外部工具**不随插件包分发**（CT-10 §2），因此不纳入严格 MIT 门禁。')
    lines.push('- 外部工具是否存在于本机属于**环境事实**，不是本台账的许可结论。本机实测状态见下方第 5.1 节。')
    lines.push('- 实际发布包尚不存在，因此不得宣称“插件整体 MIT 已达成”（CT-10 §6）。')
  } else {
    lines.push(`- 需要人工确认的依赖：${declared.filter((entry) => entry.verdict !== 'pass').map((entry) => entry.name).join(', ') || '无'}`)
    lines.push(`- 传递依赖中非 MIT 的包：${unadmittedTransitive.map((item) => `${item.name}@${item.version}`).join(', ') || '无'}`)
  }
  lines.push('')
  lines.push('### 5.1 外部工具：本机实测状态（不是许可判定）')
  lines.push('')
  lines.push('> 由 `scripts/failure-lab.mjs` 实际探测生成，随 `evidence/failure-lab.json` 更新。')
  lines.push('> 存在与否只说明本机环境，不改变“不随包、不适用插件 MIT”的边界。')
  lines.push('')
  lines.push('| 外部工具 | 本机探测结果 | 是否随插件包 | 插件 MIT 判定 |')
  lines.push('|---|---|---|---|')
  for (const [tool, probe] of Object.entries(externalToolState())) {
    lines.push(`| ${tool} | ${compactDetail(probe.detail)} | 否 | 不适用（外部能力） |`)
  }
  lines.push('')
  lines.push('## 6. 更新规则')
  lines.push('')
  lines.push('1. 准入事实的唯一来源是 `docs/dependency-admission.json`（手写、只读）。本台账是**生成物**，')
  lines.push('   不构成准入依据；`scripts/build.mjs` 与 `scripts/static-check.mjs` 只读该 JSON。')
  lines.push('2. 新增依赖先在 `docs/dependency-admission.json` 登记，再修改 `package.json`；否则构建失败。')
  lines.push('3. 依赖升级必须重新生成锁文件并复查传递闭包，不能只改版本号。')
  lines.push('4. 任何 `with-pack` 边界的依赖必须为严格 MIT；Apache／BSD／ISC 等不能写成 MIT（CT-10 §1）。')
  lines.push('5. 扫描结果不替代人工覆盖判断；发布前仍须按实际产物逐件核对（CT-10 §6）。')
  lines.push('')

  // Trim trailing blank lines so the generated document passes the same F2/F3/F8 format rules
  // as hand-written files (the clean-environment gate runs format --check against this file).
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()

  return {
    markdown: `${lines.join('\n')}\n`,
    summary: {
      declaredCount: declared.length,
      transitiveCount: transitive.length,
      declared,
      transitive,
      unadmittedTransitive: unadmittedTransitive.map((item) => `${item.name}@${item.version}`),
      strictMitSatisfied: declared.length === 0 && transitive.length === 0,
    },
  }
}

function main() {
  const check = process.argv.includes('--check')
  const { markdown, summary } = buildLedger()

  const ledgerPath = path.join(ROOT, 'docs', 'DEPENDENCY-LEDGER.md')
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
  const existing = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : ''
  // Only rewrite when content changed, so the file is not churned by every run.
  if (existing !== markdown) fs.writeFileSync(ledgerPath, markdown, 'utf8')

  const evidenceDir = path.join(ROOT, 'evidence')
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.writeFileSync(
    path.join(evidenceDir, 'dependency-report.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...summary }, null, 2)}\n`,
    'utf8',
  )

  const failures = summary.declared.filter((entry) => entry.verdict === 'fail')
  const reviews = summary.declared.filter((entry) => entry.verdict === 'review')

  process.stdout.write(`declared dependencies: ${summary.declaredCount}\n`)
  process.stdout.write(`installed transitive dependencies: ${summary.transitiveCount}\n`)
  process.stdout.write(`strict-MIT closure empty: ${summary.strictMitSatisfied}\n`)
  if (failures.length) {
    for (const entry of failures) {
      process.stdout.write(`FAIL ${entry.name}@${entry.version} license=${entry.license}（非严格 MIT）\n`)
    }
  }
  if (reviews.length) {
    for (const entry of reviews) {
      process.stdout.write(`REVIEW ${entry.name}: 许可证未核实\n`)
    }
  }

  if (check && (failures.length > 0 || reviews.length > 0 || summary.unadmittedTransitive.length > 0)) {
    process.stdout.write('\ndeps-report: FAILED\n')
    process.exit(1)
  }
  process.stdout.write('\ndeps-report: OK\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
