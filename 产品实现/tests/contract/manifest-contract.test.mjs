/**
 * Contract tests: the Host manifest contract (CT-01) and the root-file ownership rule (CT-00).
 *
 * These are not style checks. Each assertion pins a fact that C01 verified against the actual
 * Host implementation, so a later card cannot quietly break loading by editing the manifest.
 *
 * @module tests/contract/manifest-contract.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('manifest: package identity is the frozen plugin name (CT-01 §2)', () => {
  assert.equal(manifest.name, 'dsh-plugin-control-your-video')
  assert.match(manifest.version, /^\d+\.\d+\.\d+/)
  assert.equal(manifest.type, 'module')
})

test('manifest: engines.dsh is declared, because the Host implementation enforces it', () => {
  // CT-01 §1 records a documented conflict: one doc says it is not enforced, the app-boot
  // implementation and its README both enforce it. The contract follows the code.
  assert.equal(typeof manifest.engines?.dsh, 'string')
  assert.ok(manifest.engines.dsh.length > 0)
  assert.equal(manifest.engines.dsh, '0.2.2-rc.1', '宿主版本基线必须是 C01 核验的版本')
})

test('manifest: engines.node matches the declared toolchain baseline', () => {
  assert.equal(manifest.engines?.node, '>=24.21.0 <25')
})

test('manifest: dsh.bundle.patch points at an existing, non-empty patch layer', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  const patchPath = path.join(ROOT, manifest.dsh.bundle.patch)
  assert.ok(fs.existsSync(patchPath), 'patch 文件必须存在')
  const meaningful = fs
    .readFileSync(patchPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(meaningful.length > 0, '空 patch 会使宿主启动失败，必须含有效 YAML')
  const text = meaningful.join('\n')
  // Two legal states: the documented empty list, or real rows contributed by a delivered half.
  // A row that names this package must use the package name, because `dsh-client-modules` mounts
  // the browser half only on the row whose specifier is the package name (C01 A-6).
  if (text.trim() === '[]') return
  assert.match(text, /^-\s/m, 'patch 必须是顶层 YAML 数组')
  if (/\binsert:/.test(text)) {
    assert.match(
      text,
      /name:\s*['"]?dsh-plugin-control-your-video['"]?/,
      '插件行的 name 必须等于包名，否则 client 半不会被挂载',
    )
  }
})

test('manifest: a declared client half is web-platform with a real bundle', () => {
  // Before a client half exists this stays absent (the pre-C11 state). Once C11 declares it, the
  // loader requires `dsh.client.platform === 'web'` and an actual `exports["./client"]` target;
  // declaring it without a built bundle is a startup failure, not a feature.
  const client = manifest.dsh?.client
  if (client === undefined) return
  assert.equal(client.platform, 'web', 'dsh.client.platform 必须是 web')
  assert.ok(Array.isArray(client.inject), 'dsh.client.inject 必须是数组')
  const entry = manifest.exports?.['./client']
  assert.equal(typeof entry, 'string', 'client 半必须声明 exports["./client"]')
  assert.ok(fs.existsSync(path.join(ROOT, entry)), `client 入口不存在: ${entry}`)
})

test('manifest: platforms is absent or a list of real Node platform names', () => {
  const platforms = manifest.dsh?.bundle?.platforms
  if (platforms === undefined) return
  assert.ok(Array.isArray(platforms) && platforms.length > 0)
  const valid = new Set(['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'android'])
  for (const platform of platforms) assert.ok(valid.has(platform), `非法平台名: ${platform}`)
})

test('manifest: every declared export resolves to a real file', () => {
  const declared = []
  const collect = (value) => {
    if (typeof value === 'string') declared.push(value)
    else if (value && typeof value === 'object') for (const child of Object.values(value)) collect(child)
  }
  collect(manifest.exports)
  for (const entry of declared) {
    if (entry.includes('*')) continue
    assert.ok(fs.existsSync(path.join(ROOT, entry)), `export 指向不存在的文件: ${entry}`)
  }
})

test('manifest: scripts expose the required quality entry points', () => {
  for (const script of ['build', 'test', 'lint', 'format:check', 'verify', 'check']) {
    assert.equal(typeof manifest.scripts?.[script], 'string', `缺少脚本: ${script}`)
  }
})

test('root files are uniquely owned: only registered entries exist at the root', () => {
  // CT-00 §3 assigns the business ranges to later cards, and those ranges are directories
  // INSIDE this package (core/, tools/, ui/, media/, orchestration/, editing/, delivery/,
  // acceptance/, contracts/). They are therefore allow-listed here by name: creating one is
  // the intended future state, not a violation. Anything NOT in this list is an unregistered
  // root entry and must be raised with C04 / 总控 before it is added.
  const engineeringBase = new Set([
    'base',
    'cordis.patch.yml',
    'docs',
    'evidence',
    'LICENSE',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'README.md',
    'scripts',
    'tests',
  ])
  const reservedForLaterCards = new Set([
    'core', // C10
    'tools', // C06
    'ui', // C11
    'media', // C12
    'orchestration', // C13
    'editing', // C14
    'delivery', // C15
    'acceptance', // C16
    'contracts', // 总控
    'lib', // the plugin host/client halves (C11+)
    'locale', // plugin locale files (C11+)
  ])
  const actual = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => entry.name)
  const unexpected = actual.filter((name) => !engineeringBase.has(name) && !reservedForLaterCards.has(name))
  assert.deepEqual(unexpected, [], `根目录出现未登记条目: ${unexpected.join(', ')}`)
})

test('workspace: packages stays empty until an owner card proves a need', () => {
  const workspace = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace, /^packages:\s*\[\s*\]\s*$/m, 'packages 必须是空列表')
})

test('lockfile: exists and records the zero-dependency importer', () => {
  const lockPath = path.join(ROOT, 'pnpm-lock.yaml')
  assert.ok(fs.existsSync(lockPath), '必须提交锁文件')
  const lock = fs.readFileSync(lockPath, 'utf8')
  assert.match(lock, /lockfileVersion/)
  assert.match(lock, /\.:\s*\{\s*\}/, '根 importer 应为空对象（零依赖）')
})

test('LICENSE: the plugin declares MIT, matching the product boundary', () => {
  const licensePath = path.join(ROOT, 'LICENSE')
  assert.ok(fs.existsSync(licensePath))
  const text = fs.readFileSync(licensePath, 'utf8')
  assert.match(text, /MIT License/)
  assert.match(text, /Permission is hereby granted, free of charge/)
})

test('dependency ledger: exists and declares the zero-dependency baseline', () => {
  const ledgerPath = path.join(ROOT, 'docs', 'DEPENDENCY-LEDGER.md')
  assert.ok(fs.existsSync(ledgerPath), '依赖台账是 CT-10 的必需输入')
  const text = fs.readFileSync(ledgerPath, 'utf8')
  assert.match(text, /严格 MIT/)
  assert.match(text, /随包/)
})

test('no forbidden Host APIs appear anywhere in product source', () => {
  const forbidden = [/ctx\.homePaths/, /ctx\.userApproval/, /ctx\.on\(\s*['"]dispose['"]/]
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'evidence') continue
        walk(full)
      } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
        const text = fs.readFileSync(full, 'utf8')
        for (const pattern of forbidden) {
          if (pattern.test(text)) offenders.push(`${path.relative(ROOT, full)} <- ${pattern}`)
        }
      }
    }
  }
  walk(path.join(ROOT, 'base'))
  assert.deepEqual(offenders, [])
})
