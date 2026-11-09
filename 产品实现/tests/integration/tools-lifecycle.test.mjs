/**
 * Integration tests for the adopt / verify / rollback lifecycle under the manual-guidance model.
 *
 * Scope and honesty boundary, stated up front because it matters:
 *
 * - **The plugin installs nothing.** Every fixture here builds a fake "user install" directory and the
 *   kernel records where it is. The tests assert that the kernel does not write inside it, which is the
 *   property that keeps a plugin bug from corrupting someone's toolchain.
 * - **The real-tool path is proven separately.** `tools/dev/ffmpeg-probe.mjs` runs the actually-authorized
 *   `ffmpeg -version` / `ffprobe -version` once each; its results are in
 *   `实施交接/证据/C06-FFmpeg真实探针.json`. These tests use DECLARED TEST DOUBLES for the executor and
 *   assert that a double never yields the `real-tool` basis — the honesty gate.
 * - **What IS proven here**: authorization is actually required, cancellation leaves nothing verified,
 *   a moved/removed install degrades honestly, a pin blocks a silent switch, and rollback re-verifies.
 *
 * @module tests/integration/tools-lifecycle.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTempDir, Clock, sha256 } from '../../base/index.js'
import { buildCatalog } from '../../tools/catalog.js'
import { ToolPaths } from '../../tools/paths.js'
import { ToolStateStore } from '../../tools/state.js'
import { TaskStore, actionForKind } from '../../tools/tasks.js'
import { ToolLifecycle } from '../../tools/install.js'
import { deriveToolStatus } from '../../tools/state.js'
import { TaskState, ToolStatus, VerificationBasis, VerificationStatus } from '../../tools/schema.js'
import { CheckKind } from '../../tools/catalog.js'

const temp = createTempDir({ label: 'c06-adopt' })
test.after(() => temp.dispose())

/** A frozen-but-advancing clock so every timestamp in a record is reproducible and ordered. */
function frozenClock(start = 1_700_000_000_000) {
  return new Clock({ mode: 'manual', start, stepMs: 1 })
}

/**
 * Build a fake "user install" of a tool: a directory the plugin did NOT create.
 *
 * The plugin must treat this as read-only, so the fixture is the ground truth for "did we write there".
 *
 * @param {string} label
 * @param {Record<string, string>} files relative path -> content
 * @returns {string} absolute directory
 */
function makeUserInstall(label, files) {
  const root = temp.dir(`install-${label}-${Math.random().toString(16).slice(2, 8)}`)
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return root
}

/** Snapshot a directory tree so "the plugin did not touch it" is comparable. */
function hashTree(root) {
  /** @type {Record<string, string>} */
  const out = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        out[path.relative(root, full).split(path.sep).join('/')] = sha256(fs.readFileSync(full))
      }
    }
  }
  walk(root)
  return out
}

/** A minimal declarable tool matching the fake install layout used below. */
function makeTool(overrides = {}) {
  return {
    toolId: 'demo-tool',
    displayName: 'Demo tool',
    supportClass: 'external',
    catalogClass: 'official',
    channel: 'cli',
    supportedVersions: '>=1.0.0 <2.0.0',
    permissions: ['filesystem', 'process'],
    detection: {
      mode: 'files-only',
      manifestFiles: ['manifest.json'],
      executables: ['bin/demo.exe', 'bin/demo'],
      versionProbe: { command: 'demo', args: ['--version'] },
    },
    verificationChecks: [
      { id: 'manifest', kind: CheckKind.FILE_EXISTS, relativePath: 'manifest.json', description: 'manifest exists' },
      { id: 'binary', kind: CheckKind.FILE_EXISTS, relativePath: 'bin/demo.exe', description: 'binary exists' },
    ],
    license: {
      spdx: 'Apache-2.0',
      class: 'external',
      conditions: ['不随插件包分发'],
      evidenceRef: 'fixture',
    },
    effects: { effects: [], network: false, dataSubmission: false, registration: false, fee: null },
    source: { kind: 'manual-only', publisher: 'fixture', obtainFrom: 'https://example.invalid' },
    manualGuidance: { steps: ['自行安装 demo'] },
    rollback: { strategy: 'previous-build', retainedVersions: 1, instructions: '可切换回上一个已采纳版本' },
    ...overrides,
  }
}

/**
 * Add a `version-match` check for one exact build.
 *
 * Kept separate so a test can choose whether the fixture needs the tool to RUN: a file-only fixture proves
 * `declared-only`, and an executor fixture proves the double-versus-real distinction.
 *
 * @param {string} expectedBuild
 * @returns {object[]}
 */
function withVersionCheck(expectedBuild) {
  return [
    { id: 'manifest', kind: CheckKind.FILE_EXISTS, relativePath: 'manifest.json', description: 'manifest exists' },
    { id: 'binary', kind: CheckKind.FILE_EXISTS, relativePath: 'bin/demo.exe', description: 'binary exists' },
    {
      id: 'version',
      kind: CheckKind.VERSION_MATCH,
      expectedBuild,
      command: 'demo',
      args: ['--version'],
      description: 'real version matches (needs an authorized executor)',
    },
  ]
}

/** Build a catalog with one tool. */
function makeCatalog(toolOverrides = {}) {
  return buildCatalog({
    packs: [
      {
        packId: 'demo-pack',
        version: '1.0.0',
        displayName: 'Demo pack',
        pluginCode: { license: 'MIT', components: ['adapter'] },
        tools: [makeTool(toolOverrides)],
        capabilities: [
          {
            capabilityId: 'demo-cap',
            displayName: 'Demo capability',
            userOutcome: 'do the thing',
            requires: [{ toolId: 'demo-tool' }],
          },
        ],
      },
    ],
  })
}

/** Build a catalog whose verification requires RUNNING the tool, so the basis can be observed. */
function makeRunCatalog(expectedBuild = '1.0.0') {
  return makeCatalog({ verificationChecks: withVersionCheck(expectedBuild) })
}

/** An isolated paths + stores + lifecycle bundle. */
function makeContext(options = {}) {
  const root = temp.dir(`ctx-${Math.random().toString(16).slice(2, 8)}`)
  const paths = new ToolPaths({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(root, 'plugin'),
    projectsRoot: path.join(root, 'projects'),
  })
  paths.assertIsolated()
  paths.ensureLayout()
  const clock = frozenClock()
  const catalog = options.catalog ?? makeCatalog()
  const states = new ToolStateStore(paths, { clock })
  const tasks = new TaskStore(paths, { clock })
  const lifecycle = new ToolLifecycle({ paths, catalog, tasks, states, clock })
  return { root, paths, clock, catalog, states, tasks, lifecycle }
}

/** Plan → create task → authorize, as a UI would after the user answered. */
function prepareTask(context, plan, answers = {}) {
  const created = context.lifecycle.createAdoptionTask(plan)
  context.tasks.authorize({
    taskId: created.task.taskId,
    planHash: created.task.planHash,
    action: actionForKind(plan.kind),
    scope: `${plan.kind} ${plan.toolId} ${plan.targetVersion}`,
    grantedBy: answers.grantedBy ?? '用户明确回答：允许这一次',
    projectRef: answers.projectRef,
  })
  return created.task
}

/** A declared test double that reports whatever version it is told to. */
function makeDoubleExecutor(version = '1.0.0') {
  const calls = []
  return {
    marksTestDouble: true,
    calls,
    async runVersionProbe(request) {
      calls.push({ command: request.command, args: request.args })
      return { exitCode: 0, stdout: `demo ${version}`, authorizationId: 'auth-double' }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// §7.1 未安装 → 检测 → 手动指引
// ---------------------------------------------------------------------------------------------

test('adopt: an empty location finds nothing and the user is given manual guidance', async () => {
  const context = makeContext()
  const { detectTool, buildCandidates, buildManualGuidance } = await import('../../tools/detect.js')
  const tool = context.catalog.toolIndex.get('demo-tool').definition
  const empty = temp.dir('empty-install')
  const result = await detectTool(
    { tool, candidates: buildCandidates({ ownRoot: path.join(context.paths.toolsRoot, 'demo-tool'), extra: [{ root: empty }] }) },
    { clock: context.clock },
  )
  assert.equal(result.outcome, 'not-found')
  const guidance = buildManualGuidance(tool)
  assert.equal(guidance.steps.length, 1)
  assert.match(guidance.title, /尚未安装/)
})

test('adopt: detection reads a user install it is pointed at, without running anything', async () => {
  const context = makeContext()
  const { detectTool, buildCandidates } = await import('../../tools/detect.js')
  const tool = context.catalog.toolIndex.get('demo-tool').definition
  const install = makeUserInstall('detect', { 'manifest.json': '{"version":"1.2.3"}', 'bin/demo.exe': 'binary' })
  const before = hashTree(install)
  const candidates = buildCandidates({
    ownRoot: path.join(context.paths.toolsRoot, 'demo-tool'),
    extra: [{ root: install }],
  })
  const result = await detectTool({ tool, candidates }, { clock: context.clock })
  assert.equal(result.outcome, 'found')
  assert.equal(result.version, '1.2.3')
  // Files-only detection reads; it does not write into the user's install.
  assert.deepEqual(hashTree(install), before)
})

// ---------------------------------------------------------------------------------------------
// §7.2 授权采纳 → 核实
// §7.5 已安装未验证与可用不能混淆
// ---------------------------------------------------------------------------------------------

test('adopt: an authorized adopt records the location and verifies the real build', async () => {
  const context = makeContext({ catalog: makeRunCatalog('1.0.0') })
  const install = makeUserInstall('adopt', { 'manifest.json': '{"version":"1.0.0"}', 'bin/demo.exe': 'demo-v1' })
  const before = hashTree(install)
  const plan = context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.0.0' })
  const task = prepareTask(context, plan)

  const executor = makeDoubleExecutor('1.0.0')
  const result = await context.lifecycle.runAdoption(task.taskId, { executor })
  assert.equal(result.ok, true, JSON.stringify(result.failure ?? {}))
  assert.equal(result.verification.status, VerificationStatus.PASSED)

  // The adoption record points at the user's own directory.
  const state = context.states.read('demo-tool')
  assert.equal(state.currentBuild.version, '1.0.0')
  assert.equal(path.resolve(state.currentBuild.location), path.resolve(install))
  assert.equal(state.currentBuild.origin, 'manual')

  // The plugin wrote NOTHING inside the user's install.
  assert.deepEqual(hashTree(install), before)

  // §7.5: the verification ran on a declared double, so it must stay unverified.
  assert.equal(result.verification.basis, VerificationBasis.TEST_DOUBLE)
  const tool = context.catalog.toolIndex.get('demo-tool').definition
  const derived = deriveToolStatus({ tool, state })
  assert.equal(derived.status, ToolStatus.INSTALLED_UNVERIFIED)
  assert.match(derived.reason, /测试替身/)
  assert.notEqual(derived.status, ToolStatus.AVAILABLE)

  // A real-tool record is what would promote it; the derivation (not the lifecycle) owns that decision.
  const promoted = deriveToolStatus({
    tool,
    state: { ...state, verification: { ...state.verification, basis: VerificationBasis.REAL_TOOL } },
  })
  assert.equal(promoted.status, ToolStatus.AVAILABLE)
})

test('adopt: file-only verification yields declared-only and never claims a real tool', async () => {
  const context = makeContext()
  const install = makeUserInstall('files-only', { 'manifest.json': '{"version":"1.0.0"}', 'bin/demo.exe': 'demo' })
  const plan = context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.0.0' })
  const task = prepareTask(context, plan)
  const result = await context.lifecycle.runAdoption(task.taskId)
  assert.equal(result.verification.basis, VerificationBasis.DECLARED_ONLY)
  const derived = deriveToolStatus({
    tool: context.catalog.toolIndex.get('demo-tool').definition,
    state: context.states.read('demo-tool'),
  })
  assert.equal(derived.status, ToolStatus.INSTALLED_UNVERIFIED)
})

// ---------------------------------------------------------------------------------------------
// §7.3 未授权不得执行；取消不留假状态
// ---------------------------------------------------------------------------------------------

test('adopt: without an authorization nothing is recorded and nothing is run', async () => {
  const context = makeContext()
  const install = makeUserInstall('unauthorized', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  const created = context.lifecycle.createAdoptionTask(
    context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.0.0' }),
  )
  assert.equal(created.task.state, TaskState.AWAITING_AUTHORIZATION)

  const result = await context.lifecycle.runAdoption(created.task.taskId, { executor: makeDoubleExecutor() })
  assert.equal(result.ok, false)
  assert.equal(result.needsAuthorization, true)
  assert.equal(result.failure.code, 'CONFLICT')
  assert.equal(context.states.read('demo-tool').currentBuild, null)

  // A premature run must NOT bury the task: the user can still answer and proceed.
  assert.equal(context.tasks.read(created.task.taskId).state, TaskState.AWAITING_AUTHORIZATION)
  context.tasks.authorize({
    taskId: created.task.taskId,
    planHash: created.task.planHash,
    action: actionForKind('adopt'),
    scope: 'adopt demo-tool 1.0.0',
    grantedBy: '用户回答：现在可以',
  })
  assert.equal(context.tasks.read(created.task.taskId).state, TaskState.AUTHORIZED)
})

test('adopt: an AI cannot author the authorization, and a stale plan hash is refused', async () => {
  const context = makeContext()
  const install = makeUserInstall('ai-auth', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  const created = context.lifecycle.createAdoptionTask(
    context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.0.0' }),
  )
  assert.throws(
    () =>
      context.tasks.authorize({
        taskId: created.task.taskId,
        planHash: created.task.planHash,
        action: actionForKind('adopt'),
        scope: 'adopt demo',
        grantedBy: 'AI 自己决定',
        actor: 'ai',
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  assert.throws(
    () =>
      context.tasks.authorize({
        taskId: created.task.taskId,
        planHash: 'not-the-plan-hash',
        action: actionForKind('adopt'),
        scope: 'adopt demo',
        grantedBy: '用户回答',
      }),
    (error) => error.code === 'CONFLICT',
  )
  assert.throws(
    () =>
      context.tasks.authorize({
        taskId: created.task.taskId,
        planHash: created.task.planHash,
        action: '任何操作',
        scope: '所有操作',
        grantedBy: '用户回答',
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('adopt: cancelling leaves no adoption and no verified-looking state', async () => {
  const context = makeContext()
  const install = makeUserInstall('cancel', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  const task = prepareTask(
    context,
    context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.0.0' }),
  )
  const cancelled = context.lifecycle.cancel(task.taskId, { reason: '用户取消' })
  assert.equal(cancelled.state, TaskState.CANCELLED)
  assert.equal(context.states.read('demo-tool').currentBuild, null)
  const run = await context.lifecycle.runAdoption(task.taskId, { executor: makeDoubleExecutor() })
  assert.equal(run.ok, false)
})

test('adopt: a cancelled run reports cancellation rather than a failure', async () => {
  const context = makeContext()
  const install = makeUserInstall('cancel-run', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  const task = prepareTask(
    context,
    context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.0.0' }),
  )
  const result = await context.lifecycle.runAdoption(task.taskId, { signal: { aborted: true } })
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
  assert.equal(context.tasks.read(task.taskId).state, TaskState.CANCELLED)
  assert.equal(context.states.read('demo-tool').currentBuild, null)
})

// ---------------------------------------------------------------------------------------------
// §7.4 位置变化、缺失与旧记录保护
// ---------------------------------------------------------------------------------------------

test('adopt: a location that does not exist is refused with a real reason', () => {
  const context = makeContext()
  const missing = path.join(context.root, 'nope')
  const plan = context.lifecycle.planAdoption({ toolId: 'demo-tool', location: missing, targetVersion: '1.0.0' })
  const task = prepareTask(context, plan)
  return context.lifecycle.runAdoption(task.taskId).then((result) => {
    assert.equal(result.ok, false)
    // A missing location is a validation-level failure, not an unknown external state.
    assert.ok(['VALIDATION_FAILED', 'IO_FAILED'].includes(result.failure.code), result.failure.code)
    assert.equal(context.states.read('demo-tool').currentBuild, null)
  })
})

test('adopt: a location without the tool is refused instead of being adopted', async () => {
  const context = makeContext()
  const wrong = makeUserInstall('wrong', { 'readme.txt': 'this is not the tool' })
  const plan = context.lifecycle.planAdoption({ toolId: 'demo-tool', location: wrong, targetVersion: '1.0.0' })
  const task = prepareTask(context, plan)
  const result = await context.lifecycle.runAdoption(task.taskId)
  assert.equal(result.ok, false)
  assert.match(result.failure.message, /可执行文件|没有找到/)
  assert.equal(context.states.read('demo-tool').currentBuild, null)
})

test('adopt: an out-of-range version is refused at plan time, so no unverifiable task exists', () => {
  const context = makeContext()
  const install = makeUserInstall('range', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  assert.throws(
    () => context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '0.9.0' }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('adopt: re-adopting at a NEW location discards the old verification', async () => {
  const context = makeContext()
  const first = makeUserInstall('loc-a', { 'manifest.json': '{}', 'bin/demo.exe': 'demo-a' })
  const second = makeUserInstall('loc-b', { 'manifest.json': '{}', 'bin/demo.exe': 'demo-b' })

  const taskA = prepareTask(
    context,
    context.lifecycle.planAdoption({ toolId: 'demo-tool', location: first, targetVersion: '1.0.0' }),
  )
  await context.lifecycle.runAdoption(taskA.taskId, { executor: makeDoubleExecutor() })
  assert.notEqual(context.states.read('demo-tool').verification, null)

  // The user moved the install. The old verification was about the old bytes, so it must not carry over.
  context.states.recordAdoption('demo-tool', {
    version: '1.0.0',
    buildSegment: '1.0.0',
    location: second,
    origin: 'manual',
    taskId: taskA.taskId,
    files: [],
  })
  assert.equal(context.states.read('demo-tool').verification, null)
  const derived = deriveToolStatus({
    tool: context.catalog.toolIndex.get('demo-tool').definition,
    state: context.states.read('demo-tool'),
  })
  assert.equal(derived.status, ToolStatus.INSTALLED_UNVERIFIED)
})

// ---------------------------------------------------------------------------------------------
// §7.6 过旧／不兼容 → 切换 → 重新验证 → 回退
// ---------------------------------------------------------------------------------------------

test('adopt: an outdated adopted build reads needs-update before any verification helps it', async () => {
  const context = makeContext()
  const old = makeUserInstall('old', { 'manifest.json': '{}', 'bin/demo.exe': 'demo-old' })
  // Record an out-of-range build directly, as if the user had it before this version of the catalog.
  context.states.recordAdoption('demo-tool', {
    version: '0.9.0',
    buildSegment: '0.9.0',
    location: old,
    origin: 'manual',
    taskId: 'task-1700000000000-aaaaaaaa',
    files: [],
  })
  const derived = deriveToolStatus({
    tool: context.catalog.toolIndex.get('demo-tool').definition,
    state: context.states.read('demo-tool'),
  })
  assert.equal(derived.status, ToolStatus.NEEDS_UPDATE)
  assert.notEqual(derived.status, ToolStatus.AVAILABLE)
})

test('adopt: rollback switches to the previously adopted build and re-verifies it', async () => {
  // This tool accepts either adopted build, so the rollback's own verification can pass against the old
  // location instead of failing on a version the fixture pinned to one exact number.
  const catalog = makeCatalog({
    verificationChecks: [
      { id: 'manifest', kind: CheckKind.FILE_EXISTS, relativePath: 'manifest.json', description: 'manifest exists' },
      { id: 'binary', kind: CheckKind.FILE_EXISTS, relativePath: 'bin/demo.exe', description: 'binary exists' },
    ],
    supportedVersions: '>=1.0.0 <2.0.0',
  })
  const context = makeContext({ catalog })
  const v1 = makeUserInstall('v1', { 'manifest.json': '{"version":"1.0.0"}', 'bin/demo.exe': 'demo-v1' })
  const v15 = makeUserInstall('v15', { 'manifest.json': '{"version":"1.5.0"}', 'bin/demo.exe': 'demo-v15' })

  const adopt1 = prepareTask(
    context,
    context.lifecycle.planAdoption({ toolId: 'demo-tool', location: v1, targetVersion: '1.0.0' }),
  )
  assert.equal((await context.lifecycle.runAdoption(adopt1.taskId, { executor: makeDoubleExecutor('1.0.0') })).ok, true)

  const adopt2 = prepareTask(
    context,
    context.lifecycle.planAdoption({ toolId: 'demo-tool', location: v15, targetVersion: '1.5.0' }),
  )
  const updated = await context.lifecycle.runAdoption(adopt2.taskId, { executor: makeDoubleExecutor('1.5.0') })
  assert.equal(updated.ok, true, JSON.stringify(updated.failure ?? {}))
  assert.equal(context.states.read('demo-tool').currentBuild.version, '1.5.0')

  // Rollback needs its own plan, disclosure and authorization.
  const rollbackPlan = context.lifecycle.planRollback({ toolId: 'demo-tool' })
  assert.equal(rollbackPlan.kind, 'rollback')
  assert.equal(rollbackPlan.targetVersion, '1.0.0')
  const rollbackTask = prepareTask(context, rollbackPlan)
  const rolled = await context.lifecycle.runRollback(rollbackTask.taskId, { executor: makeDoubleExecutor('1.0.0') })
  assert.equal(rolled.ok, true, JSON.stringify(rolled.failure ?? {}))
  assert.equal(rolled.rolledBack, true)
  assert.equal(context.states.read('demo-tool').currentBuild.version, '1.0.0')
  // The rollback ran its own verification against the old location.
  assert.equal(context.states.read('demo-tool').verification.version, '1.0.0')
})

test('adopt: an active pin on another build blocks a silent switch', () => {
  const context = makeContext()
  const install = makeUserInstall('pinned', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  // The recorded build must match the pin's build for the switch to be about a DIFFERENT build.
  context.states.recordAdoption('demo-tool', {
    version: '1.0.0',
    buildSegment: '1.0.0',
    location: install,
    origin: 'manual',
    taskId: 'task-1700000000000-aaaaaaaa',
    files: [],
  })
  context.states.recordPin('demo-tool', {
    projectId: 'project-locked',
    projectVersion: 'v-1',
    version: '1.0.0',
  })
  const plan = context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.5.0' })
  assert.equal(plan.pinBlocked, true)
  assert.equal(plan.pin.projectId, 'project-locked')
  assert.throws(() => context.lifecycle.createAdoptionTask(plan), (error) => {
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /不能静默切换/)
    return true
  })
})

test('adopt: a SUPERSEDED pin no longer blocks, because that project version is history', () => {
  const context = makeContext()
  const install = makeUserInstall('pinned-old', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  context.states.recordAdoption('demo-tool', {
    version: '1.0.0',
    buildSegment: '1.0.0',
    location: install,
    origin: 'manual',
    taskId: 'task-1700000000000-aaaaaaaa',
    files: [],
  })
  context.states.recordPin('demo-tool', {
    projectId: 'project-locked',
    projectVersion: 'v-1',
    version: '1.0.0',
  })
  // C13 syncs the project to v-2 on the same build, then the project later moves to 1.5.0.
  context.states.advanceProjectPin('demo-tool', {
    projectId: 'project-locked',
    fromProjectVersion: 'v-1',
    toProjectVersion: 'v-2',
    version: '1.0.0',
  })
  // Both pins are on 1.0.0, so a switch to 1.5.0 is still blocked while v-2 actively uses 1.0.0.
  assert.equal(context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.5.0' }).pinBlocked, true)

  // Once v-2 itself moves to 1.5.0, the predecessor is superseded and no longer freezes the tool.
  context.states.advanceProjectPin('demo-tool', {
    projectId: 'project-locked',
    fromProjectVersion: 'v-2',
    toProjectVersion: 'v-3',
    version: '1.5.0',
  })
  const plan = context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.5.0' })
  assert.equal(plan.pinBlocked, false)
})

// ---------------------------------------------------------------------------------------------
// §7.8 状态未知不重复动作
// ---------------------------------------------------------------------------------------------

test('adopt: a task abandoned by a dead process reads unknown, not "running"', () => {
  const context = makeContext()
  const install = makeUserInstall('dead-runner', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  const task = prepareTask(
    context,
    context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.0.0' }),
  )
  assert.equal(context.tasks.isRunning(task.taskId), false)
  context.tasks.transition(task.taskId, TaskState.VERIFYING)
  context.tasks.markRunning(task.taskId, process.pid)
  assert.equal(context.tasks.isRunning(task.taskId), true)

  // A crash leaves `verifying` with a runner that is gone: that must not read as running.
  context.tasks.markRunning(task.taskId, process.pid + 100_000)
  assert.equal(context.tasks.isRunning(task.taskId), false)
  assert.equal(context.tasks.reconcile(task.taskId).reconciled, true)
  assert.equal(context.tasks.read(task.taskId).state, TaskState.UNKNOWN_STATE)
})

test('adopt: an authorized re-verify of a removed install does not silently succeed', async () => {
  const context = makeContext()
  const install = makeUserInstall('removed', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  const task = prepareTask(
    context,
    context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: '1.0.0' }),
  )
  assert.equal((await context.lifecycle.runAdoption(task.taskId, { executor: makeDoubleExecutor() })).ok, true)

  // The user removes the tool. A re-verify must fail rather than keep the old "verified" claim.
  fs.rmSync(path.join(install, 'bin'), { recursive: true, force: true })
  const reverify = context.tasks.create({
    kind: 'reverify',
    toolId: 'demo-tool',
    targetVersion: '1.0.0',
    targetBuildSegment: '1.0.0',
    targetLocation: install,
    disclosure: {
      source: '本机已记录位置',
      version: '1.0.0',
      location: install,
      data: '不联网',
      fee: '无费用',
      environment: '只读取文件',
      rollback: '不改变安装',
    },
  })
  context.tasks.authorize({
    taskId: reverify.taskId,
    planHash: reverify.planHash,
    action: actionForKind('reverify'),
    scope: 'reverify demo-tool 1.0.0',
    grantedBy: '用户请求重新验证',
  })
  const result = await context.lifecycle.runReverify(reverify.taskId, { executor: makeDoubleExecutor() })
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'VALIDATION_FAILED')
})

// ---------------------------------------------------------------------------------------------
// CR-5: project reference only, never project facts
// ---------------------------------------------------------------------------------------------

test('adopt: a project reference carries an id and version only, and refuses extra fields', async () => {
  const context = makeContext()
  const install = makeUserInstall('project-ref', { 'manifest.json': '{}', 'bin/demo.exe': 'demo' })
  const plan = context.lifecycle.planAdoption({
    toolId: 'demo-tool',
    location: install,
    targetVersion: '1.0.0',
    projectRef: { projectId: 'project-abc', projectVersion: 'v-12' },
  })
  assert.deepEqual(plan.projectRef, { projectId: 'project-abc', projectVersion: 'v-12' })
  const task = prepareTask(context, plan)
  const stored = context.tasks.read(task.taskId)
  assert.deepEqual(stored.projectRef, { projectId: 'project-abc', projectVersion: 'v-12' })
  // Nothing else about the project may have been copied in.
  const serialized = JSON.stringify(stored.projectRef)
  assert.equal(serialized.includes('title'), false)
  assert.equal(serialized.includes('phase'), false)

  // A caller trying to smuggle project facts across the boundary is refused, not quietly accepted.
  assert.throws(
    () =>
      context.tasks.create({
        kind: 'adopt',
        toolId: 'demo-tool',
        targetVersion: '1.0.0',
        targetBuildSegment: '1.0.0',
        targetLocation: install,
        disclosure: {
          source: 's',
          version: 'v',
          location: install,
          data: 'd',
          fee: 'f',
          environment: 'e',
          rollback: 'r',
        },
        projectRef: { projectId: 'project-abc', title: 'my film' },
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('adopt: a pin stores the project reference only, not project content', () => {
  const context = makeContext()
  const state = context.states.recordPin('demo-tool', {
    projectId: 'project-abc',
    projectVersion: 'v-3',
    version: '1.0.0',
  })
  const pin = state.pins[0]
  assert.equal(pin.projectId, 'project-abc')
  assert.equal(pin.projectVersion, 'v-3')
  assert.equal(pin.version, '1.0.0')
  // No project content may have crossed the boundary: only identity, the build, and pin bookkeeping.
  const allowed = new Set([
    'pinId',
    'projectId',
    'projectVersion',
    'version',
    'at',
    'state',
    'supersedes',
    'supersededBy',
    'supersededAt',
    'supersedeReason',
    'note',
  ])
  for (const key of Object.keys(pin)) {
    assert.equal(allowed.has(key), true, `pin 不应包含字段 ${key}`)
  }
})
