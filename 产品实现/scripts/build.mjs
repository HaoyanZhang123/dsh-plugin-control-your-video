#!/usr/bin/env node
/**
 * Build entry for the AI video workbench plugin.
 *
 * What "build" means here is deliberately narrow and honest: it validates the package
 * manifest against the ACTUAL Host contract that C01 verified, checks that every declared
 * entry file exists, and emits a build record with content hashes. It does NOT claim to
 * produce a working plugin surface, because C11 owns the UI and no client half exists yet.
 *
 * Host facts this build enforces (from C01 证据, `dsh-package-manifest` + `dsh-app-boot`):
 * - `dsh.bundle.patch` is read and enforced;
 * - `engines.dsh` is read and enforced by the implementation (documented conflict recorded
 *   in CT-01 §1: the docs disagree, the implementation enforces — we follow the code);
 * - `dsh.bundle.platforms`, if present, must be Node platform names;
 * - a cordis patch that is empty or comments-only terminates startup, so the file must
 *   contain a real YAML list.
 *
 * Usage: node scripts/build.mjs [--allow-missing-client] [--quiet]
 *
 * @module scripts/build
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../base/atomic-write.js'
import { checkDeclared } from './lib/admission.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** Valid Node platform names accepted by `dsh.bundle.platforms`. */
const NODE_PLATFORMS = new Set(['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'android'])

/** The Host version the plugin declares. Upgrading the Host requires re-verifying C01 facts. */
export const DECLARED_DSH_VERSION = '0.2.2-rc.1'

/** The Node version this project builds and tests against. */
export const DECLARED_NODE_VERSION = '24.21.0'

/**
 * @typedef {object} CheckResult
 * @property {string} id
 * @property {'pass'|'fail'|'warn'|'skip'} status
 * @property {string} detail
 */

/** @returns {CheckResult[]} */
function checkManifest() {
  /** @type {CheckResult[]} */
  const results = []
  const manifestPath = path.join(ROOT, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    return [{ id: 'manifest.exists', status: 'fail', detail: '缺少根 package.json' }]
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return [{ id: 'manifest.parse', status: 'fail', detail: `package.json 不是合法 JSON: ${error.message}` }]
  }
  results.push({ id: 'manifest.parse', status: 'pass', detail: '根清单可解析' })

  if (typeof manifest.name === 'string' && manifest.name.length > 0) {
    results.push({ id: 'manifest.name', status: 'pass', detail: manifest.name })
  } else {
    results.push({ id: 'manifest.name', status: 'fail', detail: '缺少 name' })
  }

  if (typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version)) {
    results.push({ id: 'manifest.version', status: 'pass', detail: manifest.version })
  } else {
    results.push({ id: 'manifest.version', status: 'fail', detail: 'version 不是 semver' })
  }

  // engines.dsh is enforced by the Host implementation; record the declared value.
  const declaredDsh = manifest.engines?.dsh
  if (typeof declaredDsh === 'string' && declaredDsh.length > 0) {
    results.push({ id: 'manifest.engines.dsh', status: 'pass', detail: `声明 ${declaredDsh}` })
    if (declaredDsh !== DECLARED_DSH_VERSION) {
      results.push({
        id: 'manifest.engines.dsh.exact',
        status: 'warn',
        detail: `与 C04 冻结基线 ${DECLARED_DSH_VERSION} 不同；宿主升级必须重跑 C01 与 C04 检查`,
      })
    }
  } else {
    results.push({ id: 'manifest.engines.dsh', status: 'fail', detail: '缺少 engines.dsh（宿主会强制检查）' })
  }

  const declaredNode = manifest.engines?.node
  if (typeof declaredNode === 'string' && declaredNode.length > 0) {
    results.push({ id: 'manifest.engines.node', status: 'pass', detail: declaredNode })
  } else {
    results.push({ id: 'manifest.engines.node', status: 'warn', detail: '未声明 engines.node' })
  }

  const patchRel = manifest.dsh?.bundle?.patch
  if (typeof patchRel === 'string') {
    const patchPath = path.join(ROOT, patchRel)
    if (!fs.existsSync(patchPath)) {
      results.push({ id: 'manifest.bundle.patch', status: 'fail', detail: `patch 文件不存在: ${patchRel}` })
    } else {
      const text = fs.readFileSync(patchPath, 'utf8')
      const meaningful = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
      if (meaningful.length === 0) {
        // Documented Host behaviour: an empty or comments-only patch terminates startup.
        results.push({
          id: 'manifest.bundle.patch.content',
          status: 'fail',
          detail: 'patch 为空或仅含注释，宿主启动会失败',
        })
      } else {
        results.push({
          id: 'manifest.bundle.patch',
          status: 'pass',
          detail: `${patchRel} 含 ${meaningful.length} 行有效 YAML`,
        })
      }
    }
  } else {
    results.push({ id: 'manifest.bundle.patch', status: 'warn', detail: '未声明 dsh.bundle.patch' })
  }

  const platforms = manifest.dsh?.bundle?.platforms
  if (platforms === undefined) {
    results.push({ id: 'manifest.bundle.platforms', status: 'skip', detail: '未声明（允许所有平台）' })
  } else if (!Array.isArray(platforms) || platforms.length === 0) {
    results.push({ id: 'manifest.bundle.platforms', status: 'fail', detail: 'platforms 必须是非空数组' })
  } else {
    const invalid = platforms.filter((item) => !NODE_PLATFORMS.has(item))
    results.push(
      invalid.length === 0
        ? { id: 'manifest.bundle.platforms', status: 'pass', detail: platforms.join(',') }
        : { id: 'manifest.bundle.platforms', status: 'fail', detail: `非法平台名: ${invalid.join(',')}` },
    )
  }

  // The client half is owned by C11; absence is a warning now, but the field shape is checked
  // when present so a later card cannot ship a malformed declaration.
  const client = manifest.dsh?.client
  if (client === undefined) {
    results.push({ id: 'manifest.dsh.client', status: 'skip', detail: '尚无 client 半（C11 负责）' })
  } else {
    const problems = []
    if (client.platform !== 'web') problems.push('platform 必须是 web')
    if (!Array.isArray(client.inject)) problems.push('inject 必须是数组')
    results.push(
      problems.length === 0
        ? { id: 'manifest.dsh.client', status: 'pass', detail: `platform=${client.platform}` }
        : { id: 'manifest.dsh.client', status: 'fail', detail: problems.join('; ') },
    )
  }

  return results
}

/** Verify every declared entry exists (main/exports), so the Host never meets a dangling path. */
function checkEntries() {
  /** @type {CheckResult[]} */
  const results = []
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const declared = new Set()
  if (typeof manifest.main === 'string') declared.add(manifest.main)
  const collectExports = (value) => {
    if (typeof value === 'string') declared.add(value)
    else if (value && typeof value === 'object') for (const child of Object.values(value)) collectExports(child)
  }
  collectExports(manifest.exports)

  for (const entry of [...declared].sort()) {
    if (entry.includes('*')) {
      results.push({ id: `entry ${entry}`, status: 'skip', detail: '通配导出，构建不静态展开' })
      continue
    }
    const exists = fs.existsSync(path.join(ROOT, entry))
    results.push({
      id: `entry ${entry}`,
      status: exists ? 'pass' : 'fail',
      detail: exists ? '存在' : '声明的入口文件不存在',
    })
  }
  return results
}

/**
 * Verify no third-party runtime dependency slipped in without admission.
 *
 * The admission list is a separate read-only file (`docs/dependency-admission.json`) rather
 * than the generated ledger, because the ledger contains a backticked taxonomy table whose
 * cells (`with-pack`, `host-provided`, …) would otherwise be read as admitted package names.
 *
 * @returns {CheckResult[]}
 */
function checkDependencies() {
  /** @type {CheckResult[]} */
  const results = []
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const groups = [
    ['dependencies', Object.keys(manifest.dependencies ?? {})],
    ['devDependencies', Object.keys(manifest.devDependencies ?? {})],
    ['peerDependencies', Object.keys(manifest.peerDependencies ?? {})],
    ['optionalDependencies', Object.keys(manifest.optionalDependencies ?? {})],
  ]
  const declared = groups.flatMap(([, names]) => /** @type {string[]} */ (names))
  const { admitted, unadmitted, problems } = checkDeclared(declared)

  // A broken admission file must fail the gate closed, never open.
  for (const problem of problems) {
    results.push({ id: 'admission.file', status: 'fail', detail: problem })
  }

  const unadmittedSet = new Set(unadmitted)
  for (const [kind, names] of groups) {
    for (const name of /** @type {string[]} */ (names)) {
      results.push({
        id: `${kind} ${name}`,
        status: unadmittedSet.has(name) ? 'fail' : 'pass',
        detail: unadmittedSet.has(name) ? '未在依赖准入清单登记，禁止进入构建' : '已在准入清单登记',
      })
    }
  }

  if (declared.length === 0) {
    results.push({
      id: 'dependencies',
      status: problems.length === 0 ? 'pass' : 'fail',
      detail: `零第三方依赖（准入清单登记 ${admitted.length} 项，传递闭包为空）`,
    })
  }
  return results
}

/**
 * Verify the toolchain version is the declared one, so "works on my machine" is visible.
 * @param {{ strict?: boolean }} [options]
 */
function checkToolchain(options = {}) {
  /** @type {CheckResult[]} */
  const results = []
  const major = DECLARED_NODE_VERSION.split('.')[0]
  const actual = process.versions.node
  const sameMajor = actual.split('.')[0] === major
  results.push({
    id: 'toolchain.node',
    status: sameMajor ? 'pass' : options.strict ? 'fail' : 'warn',
    detail: `实际 ${actual}，声明基线 ${DECLARED_NODE_VERSION}`,
  })
  return results
}

/**
 * Describe what actually exists on disk, so a build record never claims more than the tree.
 *
 * `registeredInHost` stays `false` on purpose: registering the bundle in a profile is a
 * per-profile action performed by the user, not something this repository can assert.
 * `verifiedToLoad` is `true` only when both halves exist AND a walkthrough artifact proves a
 * real host loaded them; the walkthrough result lives outside this script, so it stays false
 * here rather than being inferred.
 *
 * @returns {{ hostEntry: string, hostHalf: string, clientHalf: string, clientDeclared: boolean,
 *   registeredInHost: boolean, verifiedToLoad: boolean, note: string }}
 */
function describeProductSurface() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const hostEntry = typeof pkg.main === 'string' ? pkg.main : null
  const clientEntry =
    pkg.exports && typeof pkg.exports['./client'] === 'string' ? pkg.exports['./client'] : null
  const hostExists = hostEntry !== null && fs.existsSync(path.join(ROOT, hostEntry))
  const clientExists = clientEntry !== null && fs.existsSync(path.join(ROOT, clientEntry))
  const clientDeclared = pkg.dsh?.client !== undefined
  return {
    hostEntry: hostEntry ?? '(no main)',
    hostHalf: hostExists ? 'present' : 'absent',
    clientHalf: clientExists ? 'present' : clientDeclared ? 'declared-but-missing' : 'absent',
    clientDeclared,
    // Registering the bundle is a user/profile action; this repository must not claim it.
    registeredInHost: false,
    verifiedToLoad: false,
    note: 'presence on disk only; loading, pages and product behaviour are receipt/evidence claims, not build claims',
  }
}

/**
 * Run the whole build and write the record when it succeeds.
 * @param {{ strict?: boolean, quiet?: boolean }} [options]
 */
 export function build(options = {}) {
  const checks = [...checkToolchain(options), ...checkManifest(), ...checkEntries(), ...checkDependencies()]
  const failed = checks.filter((check) => check.status === 'fail')
  const ok = failed.length === 0

  const artifacts = []
  const collect = (relPath) => {
    const absolute = path.join(ROOT, relPath)
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      artifacts.push({ path: relPath, bytes: fs.statSync(absolute).size, sha256: sha256(fs.readFileSync(absolute)) })
    }
  }
  collect('package.json')
  collect('cordis.patch.yml')
  collect('LICENSE')
  collect('pnpm-lock.yaml')

  const record = {
    schemaVersion: 1,
    kind: 'build-record',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    packageName: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name,
    ok,
    checks,
    artifacts,
    // Stated plainly so no reader infers a working product from a green build. These are
    // derived from the manifest and the files that actually exist, not from a fixed story:
    // a stale claim here is worse than no claim, because receipts quote it.
    productSurface: describeProductSurface(),
  }

  if (ok) {
    const outDir = path.join(ROOT, 'evidence')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'build-record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  }

  if (!options.quiet) {
    for (const check of checks) {
      const marker = check.status === 'pass' ? 'ok  ' : check.status === 'warn' ? 'warn' : check.status === 'skip' ? 'skip' : 'FAIL'
      process.stdout.write(`${marker}  ${check.id.padEnd(34)} ${check.detail}\n`)
    }
    process.stdout.write(ok ? '\nbuild: OK\n' : `\nbuild: FAILED (${failed.length} failing checks)\n`)
  }
  return { ok, checks, record }
}

function main() {
  const strict = process.argv.includes('--strict')
  const quiet = process.argv.includes('--quiet')
  const { ok } = build({ strict, quiet })
  process.exit(ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
