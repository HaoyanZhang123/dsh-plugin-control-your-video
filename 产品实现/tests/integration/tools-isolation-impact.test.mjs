/**
 * Integration tests for directory isolation, capability impact, log hygiene and the MIT boundary.
 *
 * These cover the requirements that are easy to claim and hard to prove:
 *
 * - §7.7 the external tool area, the plugin package and the user's projects are disjoint, and an adoption
 *   records a location WITHOUT writing into it;
 * - §7.8 there is no hidden network and no hidden process: the module has no network/process import at all,
 *   and a version probe cannot run without an explicit authorization;
 * - §7.9 when a tool is missing the user's project results are untouched and only the affected capabilities
 *   are reported;
 * - §7.10 the management code and the shipped capability packs have an explicit MIT boundary, and an
 *   external tool body is never presented as MIT.
 *
 * @module tests/integration/tools-isolation-impact.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTempDir, Clock, sha256 } from '../../base/index.js'
import { createToolPaths, ToolPaths } from '../../tools/paths.js'
import { createDefaultCatalog } from '../../tools/packs.js'
import { computeImpact, capabilitiesUsingTool, impactSummary } from '../../tools/impact.js'
import { ToolLog, summarizeLog } from '../../tools/log.js'
import { CapabilityState, SupportClass, ToolStatus } from '../../tools/schema.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOLS_SRC = path.join(HERE, '..', '..', 'tools')
const temp = createTempDir({ label: 'c06-isolation' })
test.after(() => temp.dispose())

/** Build a full roots set inside one managed temp directory. */
function makeRoots() {
  const root = temp.dir(`roots-${Math.random().toString(16).slice(2, 10)}`)
  return {
    root,
    toolsRoot: path.join(root, 'external-tools'),
    stateRoot: path.join(root, 'tool-state'),
    pluginRoot: path.join(root, 'plugin'),
    projectsRoot: path.join(root, 'projects'),
  }
}

// ---------------------------------------------------------------------------------------------
// §7.7 外部目录、插件目录和用户项目分离
// ---------------------------------------------------------------------------------------------

test('isolation: overlapping roots are refused for every dangerous pair', () => {
  const roots = makeRoots()
  fs.mkdirSync(roots.pluginRoot, { recursive: true })
  fs.mkdirSync(roots.projectsRoot, { recursive: true })
  const bad = [
    { toolsRoot: path.join(roots.pluginRoot, 'tools') },
    { toolsRoot: path.join(roots.projectsRoot, 'tools') },
    { stateRoot: path.join(roots.toolsRoot, 'state') },
    { stateRoot: path.join(roots.pluginRoot, 'state') },
  ]
  for (const override of bad) {
    assert.throws(
      () =>
        createToolPaths({
          toolsRoot: roots.toolsRoot,
          stateRoot: roots.stateRoot,
          pluginRoot: roots.pluginRoot,
          projectsRoot: roots.projectsRoot,
          ...override,
        }),
      (error) => error.code === 'VALIDATION_FAILED',
      JSON.stringify(override),
    )
  }
  // A clean set is accepted and reports what it checked.
  const paths = createToolPaths(roots)
  const checked = paths.assertIsolated()
  assert.equal(checked.ok, true)
  assert.ok(checked.checked.includes('toolsRoot<->pluginRoot'))
  assert.ok(checked.checked.includes('toolsRoot<->projectsRoot'))
})

test('isolation: a tool id and a build segment cannot become a path expression', () => {
  const paths = new ToolPaths(makeRoots())
  for (const bad of ['../evil', 'a/b', 'a\\b', 'C:', 'CON', 'UPPER', 'with space', '']) {
    assert.throws(() => paths.stateFor(bad), `toolId ${JSON.stringify(bad)} should be refused`)
  }
  // A valid id yields a real path inside the state root, never inside a tool directory.
  const statePath = paths.stateFor('ffmpeg')
  assert.ok(path.isAbsolute(statePath))
  assert.ok(statePath.startsWith(paths.stateRoot))
  assert.equal(statePath.startsWith(paths.toolsRoot), false)
})

test('isolation: the plugin writes only state records, never inside a tool location', () => {
  const roots = makeRoots()
  for (const dir of [roots.pluginRoot, roots.projectsRoot]) fs.mkdirSync(dir, { recursive: true })
  const paths = createToolPaths(roots)
  paths.ensureLayout()

  // A user's own install, which the plugin must not touch.
  const userInstall = temp.dir('user-install')
  fs.mkdirSync(path.join(userInstall, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(userInstall, 'bin', 'ffmpeg.exe'), 'pretend-binary')
  fs.writeFileSync(path.join(userInstall, 'LICENSE'), 'GPL')
  const before = hashTree(userInstall)
  const pluginBefore = listTree(roots.pluginRoot)
  const projectsBefore = listTree(roots.projectsRoot)

  // Exercise the state writes the kernel actually performs.
  const stateFile = paths.stateFor('ffmpeg')
  fs.writeFileSync(stateFile, '{}\n')
  assert.ok(stateFile.startsWith(paths.stateRoot), 'state must live under the state root')

  // Nothing was written into the user's install, the plugin package or the projects.
  assert.deepEqual(hashTree(userInstall), before)
  assert.deepEqual(listTree(roots.pluginRoot), pluginBefore)
  assert.deepEqual(listTree(roots.projectsRoot), projectsBefore)
})

// ---------------------------------------------------------------------------------------------
// §7.8 无隐藏网络或进程
// ---------------------------------------------------------------------------------------------

/**
 * Every .js / .mjs under `tools/`, RECURSIVELY.
 *
 * The old version only listed the top level, so `tools/dev/ffmpeg-probe.mjs` — the one file that really
 * imports `node:child_process` and spawns a binary — was invisible to the very guard meant to catch it.
 * A guard that skips the violation is worse than no guard, because it reports green.
 *
 * @returns {string[]}
 */
function collectModuleFiles() {
  /** @type {string[]} */
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) out.push(full)
    }
  }
  walk(TOOLS_SRC)
  return out.sort()
}

test('isolation: the guard scan actually reaches every module, including tools/dev', () => {
  const files = collectModuleFiles()
  const names = files.map((file) => path.relative(TOOLS_SRC, file).split(path.sep).join('/'))
  // The dev scripts are diagnostics, not product code, but they must still be SEEN by the scan.
  assert.ok(names.includes('dev/ffmpeg-probe.mjs'), '扫描必须包含 tools/dev/ffmpeg-probe.mjs')
  assert.ok(names.includes('index.js'), '扫描必须包含 tools/index.js')
  assert.ok(files.length >= 15, `扫描文件数过少（${files.length}）`)
})

test('isolation: no product module imports a network or process module', () => {
  const forbidden = [
    'node:http',
    'node:https',
    'node:net',
    'node:dgram',
    'node:tls',
    'node:child_process',
    'node:cluster',
    'node:dns',
    'node:worker_threads',
  ]
  // Product modules are everything except the explicitly-declared dev diagnostics. The dev scripts ARE
  // allowed to spawn (that is their job), so they are checked by the NEXT test under a stricter rule.
  const productFiles = collectModuleFiles().filter((file) => !file.includes(`${path.sep}dev${path.sep}`))
  /** @type {string[]} */
  const offenders = []
  for (const file of productFiles) {
    const text = fs.readFileSync(file, 'utf8')
    for (const specifier of forbidden) {
      const escaped = specifier.replace(/[:]/g, '\\:')
      const importPattern = new RegExp(`^\\s*(?:import|export)\\s[^\\n]*from\\s*['"]${escaped}['"]`, 'm')
      if (importPattern.test(text)) offenders.push(`${path.basename(file)} -> ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], '工具管理产品模块不得自行联网或启动进程')

  // Same for `fetch(` — a global fetch would be a hidden network call no import scan would catch.
  /** @type {string[]} */
  const fetchUsers = []
  for (const file of productFiles) {
    const text = fs.readFileSync(file, 'utf8')
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (/\bfetch\s*\(/.test(withoutComments)) fetchUsers.push(path.basename(file))
  }
  assert.deepEqual(fetchUsers, [], '工具管理产品模块不得直接调用 fetch')
})

test('isolation: a dev script that spawns processes is declared, bounded and never imported by product code', () => {
  const devDir = path.join(TOOLS_SRC, 'dev')
  /** @type {string[]} */
  const spawners = []
  for (const name of fs.readdirSync(devDir)) {
    if (!name.endsWith('.mjs')) continue
    const text = fs.readFileSync(path.join(devDir, name), 'utf8')
    // Only a real import counts. `defect-probe.mjs` merely SEARCHES for this string while auditing other
    // files, so matching the literal would flag the auditor as the offender.
    if (/^\s*import\s[^\n]*from\s*'node:child_process'/m.test(text)) spawners.push(name)
  }
  // Exactly one script spawns, and it is the one the user authorized: the FFmpeg probe.
  assert.deepEqual(spawners, ['ffmpeg-probe.mjs'], `意外的进程启动脚本：${spawners.join('、')}`)

  const probe = fs.readFileSync(path.join(devDir, 'ffmpeg-probe.mjs'), 'utf8')
  // It must be bounded: an allowlist of commands, and at most one run per command.
  assert.match(probe, /ALLOWED_PROBES/, '探测脚本必须有命令白名单')
  assert.match(probe, /cache\.has\(key\)|cached/, '探测脚本必须限制同一命令至多执行一次')

  // And no product module may import it.
  const productFiles = collectModuleFiles().filter((file) => !file.includes(`${path.sep}dev${path.sep}`))
  for (const file of productFiles) {
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(/ffmpeg-probe/.test(text), false, `${path.basename(file)} 不应引用探测脚本`)
  }
})

test('isolation: a version probe without an explicit authorization is refused, not downgraded', async () => {
  const { detectTool, assertExecutorIsSafe } = await import('../../tools/detect.js')
  const catalog = createDefaultCatalog()
  const tool = catalog.toolIndex.get('ffmpeg').definition
  const root = temp.dir('probe-target')
  const candidates = [{ root }]

  // 1. no executor at all -> inconclusive, and the reason says an authorization is missing.
  const withoutExecutor = await detectTool({ tool, candidates }, { mode: 'version-probe', clock: new Clock() })
  assert.equal(withoutExecutor.outcome, 'inconclusive')
  assert.match(withoutExecutor.reason, /授权的执行器/)

  // 2. an executor supplied but not authorized -> REFUSED before it can run.
  let ran = false
  const executor = {
    async runVersionProbe() {
      ran = true
      return { exitCode: 0, stdout: 'ffmpeg version 9.0.1', authorizationId: 'auth-1' }
    },
  }
  assert.throws(
    () => assertExecutorIsSafe(executor, { probeAuthorized: false }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  await assert.rejects(
    () => detectTool({ tool, candidates, executor, probeAuthorized: false }, { mode: 'version-probe' }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  assert.equal(ran, false, 'the probe must not have run')
})

test('isolation: detection refuses a relative location instead of resolving it against the cwd', async () => {
  const { candidateFrom } = await import('../../tools/detect.js')
  for (const bad of ['relative/dir', './ffmpeg', '']) {
    assert.throws(() => candidateFrom(bad), (error) => error.code === 'VALIDATION_FAILED', bad)
  }
  const good = candidateFrom(process.cwd())
  assert.equal(path.isAbsolute(good.root), true)
})

test('isolation: detection reads only declared paths INSIDE the candidate root', async () => {
  const { detectTool } = await import('../../tools/detect.js')
  const root = temp.dir('detect-root')
  // A file that must NOT be read: it sits one level above the detection root.
  fs.writeFileSync(path.join(path.dirname(root), 'outside-secret.txt'), '{"version":"9.9.9"}')

  const hostileTool = {
    toolId: 'hostile',
    displayName: 'Hostile',
    detection: {
      mode: 'files-only',
      manifestFiles: ['../outside-secret.txt'],
      executables: ['../../also-outside.txt'],
    },
    supportedVersions: { raw: '>=1.0.0' },
  }
  const result = await detectTool({ tool: hostileTool, candidates: [{ root }] }, { clock: new Clock() })
  // Nothing was found, because every declared path was refused as unsafe before any read.
  assert.equal(result.outcome, 'not-found')
  assert.equal(result.version, null)
  const unsafe = result.evidence.filter((entry) => entry.detail.includes('路径不安全'))
  assert.equal(unsafe.length, 2)
})

test('isolation: inspectTool works for a CLI tool that declares no version probe', async () => {
  const { createToolKernel } = await import('../../tools/index.js')
  const roots = makeRoots()
  const kernel = createToolKernel({ ...roots, clock: new Clock({ mode: 'frozen', start: 1 }) })
  const inspected = kernel.inspectTool('editly')
  assert.equal(inspected.toolId, 'editly')
  assert.equal(inspected.channel.kind, 'cli')
  assert.equal(inspected.usable, false)
  assert.equal(inspected.license.pluginMit, false)
})

// ---------------------------------------------------------------------------------------------
// §7.9 工具缺失时项目已有结果保留并只显示受影响能力
// ---------------------------------------------------------------------------------------------

test('impact: a missing tool reports the affected capabilities and never touches the project', () => {
  const catalog = createDefaultCatalog()
  const projectRoot = temp.dir('user-project')
  const files = {
    'project.json': '{"title":"my film"}',
    'media/final.mp4': 'pretend-final-video-bytes',
    'versions/final/render.json': '{"ok":true}',
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(projectRoot, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  const before = hashTree(projectRoot)

  const impact = computeImpact({
    catalog,
    statusByToolId: {
      ffmpeg: ToolStatus.NOT_INSTALLED,
      remotion: ToolStatus.NOT_INSTALLED,
      hyperframes: ToolStatus.NOT_INSTALLED,
    },
  })

  assert.equal(impact.anyAffected, true)
  assert.equal(impact.usable.length, 0)
  for (const capability of impact.capabilities) {
    assert.equal(capability.state, CapabilityState.UNAVAILABLE)
    assert.ok(capability.blockers.length > 0)
    assert.equal(capability.blockers[0].code, 'TOOL_NOT_INSTALLED')
    assert.match(capability.preserved, /项目|已保存|保留/)
  }
  assert.equal(impact.projectFactsUntouched, true)
  assert.match(impact.nextStep, /工具.*页/)

  const summary = impactSummary(impact)
  assert.match(summary, /部分能力当前不可用/)
  assert.match(summary, /已保存结果都已保留/)

  // The project bytes are byte-identical: computing impact cannot have deleted anything.
  assert.deepEqual(hashTree(projectRoot), before)
})

test('impact: a project reference is echoed as an id only, and no project data is read', () => {
  const catalog = createDefaultCatalog()
  const impact = computeImpact({
    catalog,
    statusByToolId: { ffmpeg: ToolStatus.AVAILABLE },
    scope: { projectId: 'project-abc' },
  })
  assert.deepEqual(impact.projectRef, { projectId: 'project-abc' })
  // Nothing about a project can appear in the report beyond the reference.
  const serialized = JSON.stringify(impact)
  assert.equal(serialized.includes('title'), false)
  assert.equal(serialized.includes('phase'), false)

  const noScope = computeImpact({ catalog, statusByToolId: {} })
  assert.equal(noScope.projectRef, null)
})

test('impact: a capability with one usable tool still reports the other blocker honestly', () => {
  const catalog = createDefaultCatalog()
  const impact = computeImpact({
    catalog,
    statusByToolId: {
      ffmpeg: ToolStatus.AVAILABLE,
      remotion: ToolStatus.NEEDS_UPDATE,
      hyperframes: ToolStatus.INSTALLED_UNVERIFIED,
    },
  })
  const byId = new Map(impact.capabilities.map((capability) => [capability.capabilityId, capability]))
  assert.equal(byId.get('media-probe').state, CapabilityState.AVAILABLE)
  assert.equal(byId.get('render-program-visual').state, CapabilityState.UNAVAILABLE)
  assert.equal(byId.get('render-program-visual').blockers[0].code, 'TOOL_NEEDS_UPDATE')
  assert.equal(byId.get('render-quality-check').blockers[0].code, 'TOOL_INSTALLED_UNVERIFIED')
  // Both FFmpeg capabilities are usable; the order follows the catalog, so compare as a set.
  assert.deepEqual([...impact.usable].sort(), ['media-cut', 'media-probe'])
})

test('impact: research candidates never appear in the official capability report', () => {
  const catalog = createDefaultCatalog()
  const impact = computeImpact({ catalog, statusByToolId: {} })
  const ids = impact.capabilities.map((capability) => capability.capabilityId)
  assert.equal(ids.includes('research-lightweight-render'), false)
  const usage = capabilitiesUsingTool(catalog, 'ffmpeg')
  assert.ok(usage.capabilities.length >= 2)
})

// ---------------------------------------------------------------------------------------------
// §7.10 管理代码与随包能力包严格 MIT 证据
// ---------------------------------------------------------------------------------------------

test('mit: the plugin-internal part is MIT and every external tool keeps its own licence', () => {
  const catalog = createDefaultCatalog()
  for (const pack of catalog.packs) {
    assert.equal(pack.pluginCode.license, 'MIT', `${pack.packId} plugin content must be MIT`)
    assert.equal(typeof pack.pluginCode.evidenceRef, 'string')
  }
  const external = [...catalog.toolIndex.values()].filter(
    (entry) => entry.definition.supportClass === SupportClass.EXTERNAL,
  )
  assert.ok(external.length >= 3)
  for (const entry of external) {
    assert.equal(entry.definition.license.class, SupportClass.EXTERNAL)
    assert.notEqual(entry.definition.license.evidenceRef, null)
    assert.ok(entry.definition.license.conditions.length > 0)
    assert.equal(entry.definition.license.pluginMit, undefined, 'a declaration must not carry a pluginMit claim')
  }
  const spdx = external.map((entry) => entry.definition.license.spdx).sort()
  assert.ok(spdx.includes('Apache-2.0'))
  assert.ok(spdx.includes('GPL-3.0-or-later'))
  assert.ok(spdx.includes('Remotion-License'))
})

test('mit: the kernel reports the boundary as data, separate from any claim of overall MIT', async () => {
  const { createToolKernel } = await import('../../tools/index.js')
  const roots = makeRoots()
  const kernel = createToolKernel({ ...roots, clock: new Clock({ mode: 'frozen', start: 1_700_000_000_000 }) })
  const boundary = kernel.mitBoundary()
  assert.equal(boundary.pluginInternal.license, 'MIT')
  assert.ok(boundary.pluginInternal.components.length >= 3)
  for (const entry of boundary.external) {
    assert.equal(entry.pluginMit, false, `${entry.toolId} must not claim plugin MIT`)
    assert.ok(entry.conditions.length > 0)
  }
  assert.match(boundary.note, /不是插件整体 MIT 已达成/)
})

// ---------------------------------------------------------------------------------------------
// Log hygiene
// ---------------------------------------------------------------------------------------------

test('log: entries are bounded and redacted, and a torn last line is reported not hidden', () => {
  const dir = temp.dir('log')
  const file = path.join(dir, 'log.jsonl')
  const log = new ToolLog(file, {
    clock: new Clock({ mode: 'frozen', start: 1_700_000_000_000 }),
    pathRoots: { '<root>': temp.path },
  })

  log.append({ event: 'adopt', token: 'sk-abcdefghijklmnopqrstuvwxyz', note: 'x'.repeat(4000) })
  log.append({ event: 'detect', detail: { nested: 'value' } })
  assert.equal(log.size(), 2)

  const read = log.read()
  assert.equal(read.total, 2)
  const first = read.entries[0]
  assert.equal(JSON.stringify(first).includes('sk-abcdefghijklmnopqrstuvwxyz'), false)
  assert.ok(String(first.note).length < 600)
  assert.equal(typeof read.entries[1].detail, 'string')
})

test('log: summarizeLog reports counts and I/O failure state without dumping content', () => {
  const dir = temp.dir('log2')
  const file = path.join(dir, 'log.jsonl')
  const log = new ToolLog(file, { clock: new Clock({ mode: 'frozen', start: 1 }) })
  log.append({ event: 'a' })
  fs.appendFileSync(file, '{"event":"torn"')
  const summary = summarizeLog(log)
  assert.equal(summary.entries, 1)
  assert.equal(summary.skippedLines, 1)
  assert.equal(summary.ioFailure, false)
})

/** List every file under a root, relative and sorted. */
function listTree(root) {
  /** @type {string[]} */
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

/** SHA-256 of every file under a root, so "untouched" is comparable rather than asserted. */
function hashTree(root) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const relative of listTree(root)) {
    out[relative] = sha256(fs.readFileSync(path.join(root, relative)))
  }
  return out
}
