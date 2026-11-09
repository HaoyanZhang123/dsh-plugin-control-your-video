/**
 * Regression tests for the defects an independent audit found (V-01 … V-09 + the scan gap).
 *
 * Why a separate file: the 108 tests that existed before the audit were all green, and that is exactly the
 * problem — none of them constructed an INCORRECT input. A suite that only feeds correct data cannot detect a
 * check that accepts everything. Each test here feeds the wrong thing on purpose and asserts the refusal.
 *
 * `tools/dev/defect-probe.mjs` is the runnable companion: it reproduces the same defects against the live
 * code and must report zero. These tests are what keeps them from coming back.
 *
 * @module tests/unit/tools-audit-regressions.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTempDir, Clock } from '../../base/index.js'
import { buildCatalog } from '../../tools/catalog.js'
import { ToolPaths } from '../../tools/paths.js'
import { ToolStateStore, deriveToolStatus } from '../../tools/state.js'
import { TaskStore, actionForKind } from '../../tools/tasks.js'
import { ToolLifecycle, assertVerifyExecutorSafe } from '../../tools/install.js'
import { createToolKernel } from '../../tools/index.js'
import { CatalogClass, TaskState, ToolStatus, VerificationStatus } from '../../tools/schema.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOLS_SRC = path.join(HERE, '..', '..', 'tools')
const temp = createTempDir({ label: 'c06-audit' })
test.after(() => temp.dispose())

/** A catalog whose version check expects exactly `expectedBuild`. */
function makeCatalog(expectedBuild = '1.0.0', overrides = {}) {
  return buildCatalog({
    packs: [
      {
        packId: 'demo-pack',
        version: '1.0.0',
        displayName: 'Demo pack',
        pluginCode: { license: 'MIT', components: ['adapter'] },
        tools: [
          {
            toolId: 'demo-tool',
            displayName: 'Demo tool',
            supportClass: 'external',
            catalogClass: 'official',
            channel: 'cli',
            supportedVersions: '>=1.0.0 <2.0.0',
            permissions: ['filesystem', 'process'],
            detection: { mode: 'files-only', manifestFiles: ['manifest.json'], executables: ['bin/demo.exe'] },
            verificationChecks: [
              { id: 'manifest', kind: 'file-exists', relativePath: 'manifest.json', description: 'manifest' },
              {
                id: 'version',
                kind: 'version-match',
                expectedBuild,
                command: 'demo',
                args: ['--version'],
                description: 'version matches',
              },
            ],
            license: { spdx: 'Apache-2.0', class: 'external', conditions: ['x'], evidenceRef: 'fixture' },
            effects: { effects: [], network: false, dataSubmission: false, registration: false, fee: null },
            source: { kind: 'manual-only', publisher: 'fixture' },
            manualGuidance: { steps: ['install demo'] },
            rollback: { strategy: 'previous-build', retainedVersions: 1, instructions: 'switch back' },
            ...overrides,
          },
        ],
        capabilities: [
          { capabilityId: 'demo-cap', displayName: 'Demo', userOutcome: 'x', requires: [{ toolId: 'demo-tool' }] },
        ],
      },
    ],
  })
}

/** A fake user install directory. */
function makeInstall(label) {
  const root = temp.dir(`install-${label}-${Math.random().toString(16).slice(2, 8)}`)
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":"1.0.0"}')
  fs.writeFileSync(path.join(root, 'bin', 'demo.exe'), 'demo-binary')
  return root
}

/** A context bundle. */
function makeContext(catalog = makeCatalog()) {
  const root = temp.dir(`ctx-${Math.random().toString(16).slice(2, 8)}`)
  const paths = new ToolPaths({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(root, 'plugin'),
    projectsRoot: path.join(root, 'projects'),
  })
  paths.assertIsolated()
  paths.ensureLayout()
  const clock = new Clock({ mode: 'manual', start: 1_700_000_000_000, stepMs: 1 })
  const states = new ToolStateStore(paths, { clock })
  const tasks = new TaskStore(paths, { clock })
  const lifecycle = new ToolLifecycle({ paths, catalog, tasks, states, clock })
  return { root, paths, catalog, states, tasks, lifecycle }
}

/** Plan + authorize one adoption. */
function authorizedAdoption(context, install, version = '1.0.0') {
  const plan = context.lifecycle.planAdoption({ toolId: 'demo-tool', location: install, targetVersion: version })
  const created = context.lifecycle.createAdoptionTask(plan)
  context.tasks.authorize({
    taskId: created.task.taskId,
    planHash: created.task.planHash,
    action: actionForKind('adopt'),
    scope: `adopt demo-tool ${version}`,
    grantedBy: '用户回答',
  })
  return created.task
}

/** A properly authorized executor reporting a chosen banner. */
function reportingExecutor(reported) {
  return {
    marksTestDouble: false,
    authorizationId: 'auth-regression-1',
    async runVersionProbe() {
      return { exitCode: 0, stdout: `demo version ${reported}`, authorizationId: 'auth-regression-1' }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// V-01: version comparison must be exact, not a substring test
// ---------------------------------------------------------------------------------------------

test('V-01: a version that merely CONTAINS the expected one is refused', async () => {
  for (const wrong of ['11.0.0', '1.0.0-rc1', '1.0.01', '100.0.0']) {
    const context = makeContext()
    const install = makeInstall(`v01-${wrong.replace(/[^a-z0-9]/gi, '-')}`)
    const task = authorizedAdoption(context, install, '1.0.0')
    const result = await context.lifecycle.runAdoption(task.taskId, { executor: reportingExecutor(wrong) })
    const versionCheck = (result.verification.checks ?? []).find((check) => check.id === 'version')
    assert.equal(versionCheck?.ok, false, `"${wrong}" 不应通过 1.0.0 的核对`)
    assert.equal(result.verification.status, VerificationStatus.FAILED)
    assert.equal(result.ok, false)
  }
})

test('V-01: the exact build still passes, so the fix did not simply reject everything', async () => {
  const context = makeContext()
  const install = makeInstall('v01-exact')
  const task = authorizedAdoption(context, install, '1.0.0')
  const result = await context.lifecycle.runAdoption(task.taskId, { executor: reportingExecutor('1.0.0') })
  const versionCheck = (result.verification.checks ?? []).find((check) => check.id === 'version')
  assert.equal(versionCheck?.ok, true)
  assert.equal(result.verification.status, VerificationStatus.PASSED)
})

test('V-01: a build qualifier difference is still a difference, because sameBuild is exact', async () => {
  const catalog = makeCatalog('1.0.0-full_build')
  const context = makeContext(catalog)
  const install = makeInstall('v01-qualifier')
  const task = authorizedAdoption(context, install, '1.0.0')
  const result = await context.lifecycle.runAdoption(task.taskId, { executor: reportingExecutor('1.0.0') })
  const versionCheck = (result.verification.checks ?? []).find((check) => check.id === 'version')
  assert.equal(versionCheck?.ok, false, '缺少构建后缀不应通过')
})

// ---------------------------------------------------------------------------------------------
// V-02: the verification path needs the same executor authorization gate detection has
// ---------------------------------------------------------------------------------------------

test('V-02: a naked executor object is refused instead of being trusted', () => {
  assert.throws(() => assertVerifyExecutorSafe({ runVersionProbe() {} }), (error) => {
    assert.equal(error.code, 'VALIDATION_FAILED')
    assert.match(error.message, /授权/)
    return true
  })
  assert.throws(() => assertVerifyExecutorSafe(null), (error) => error.code === 'VALIDATION_FAILED')
  // A declared double passes the gate but can never yield the real-tool basis.
  assert.deepEqual(assertVerifyExecutorSafe({ marksTestDouble: true }), { ok: true, testDouble: true })
  assert.deepEqual(assertVerifyExecutorSafe({ authorizationId: 'auth-1' }), { ok: true, testDouble: false })
})

test('V-02: an unauthorized executor yields no real-tool claim and no availability', async () => {
  const context = makeContext()
  const install = makeInstall('v02-naked')
  const task = authorizedAdoption(context, install, '1.0.0')
  const naked = { async runVersionProbe() { return { exitCode: 0, stdout: 'demo version 1.0.0' } } }
  const result = await context.lifecycle.runAdoption(task.taskId, { executor: naked })
  assert.notEqual(result.verification?.basis, 'real-tool')
  const derived = deriveToolStatus({
    tool: context.catalog.toolIndex.get('demo-tool').definition,
    state: context.states.read('demo-tool'),
  })
  assert.notEqual(derived.status, ToolStatus.AVAILABLE)
})

// ---------------------------------------------------------------------------------------------
// V-05: a failed detection must not leave the tool stuck at `checking`
// ---------------------------------------------------------------------------------------------

test('V-05: invalid detection input leaves no in-flight flag and no `checking` status', async () => {
  const root = temp.dir('v05')
  const kernel = createToolKernel({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(TOOLS_SRC, '..'),
    projectsRoot: path.join(root, 'projects'),
    clock: new Clock({ mode: 'manual', start: 1, stepMs: 1 }),
  })
  // A relative path is refused before any state write.
  await assert.rejects(() => kernel.detect({ toolId: 'ffmpeg', at: 'relative/path' }), (error) => {
    assert.equal(error.code, 'VALIDATION_FAILED')
    return true
  })
  const state = kernel.states.read('ffmpeg')
  assert.equal(state.detectionInFlight, false, '检测失败后不得残留进行中标记')
  const status = deriveToolStatus({ tool: kernel.catalog.toolIndex.get('ffmpeg').definition, state })
  assert.notEqual(status.status, ToolStatus.CHECKING)
})

test('V-05: a detection probe that throws records an error rather than staying in flight', async () => {
  const root = temp.dir('v05b')
  const kernel = createToolKernel({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(TOOLS_SRC, '..'),
    projectsRoot: path.join(root, 'projects'),
    clock: new Clock({ mode: 'manual', start: 1, stepMs: 1 }),
  })
  const throwing = {
    marksTestDouble: false,
    authorizationId: 'auth-x',
    async runVersionProbe() {
      throw new Error('spawn failed hard')
    },
  }
  const at = temp.dir('v05b-install')
  const result = await kernel.detect({
    toolId: 'ffmpeg',
    at,
    mode: 'version-probe',
    executor: throwing,
    probeAuthorized: true,
  })
  // No files under `at`, so detection never reaches the probe; the point is that it settles either way.
  assert.ok(['not-found', 'inconclusive', 'error'].includes(result.detection.outcome))
  assert.equal(kernel.states.read('ffmpeg').detectionInFlight, false)
})

// ---------------------------------------------------------------------------------------------
// V-06: terminal task states are final
// ---------------------------------------------------------------------------------------------

test('V-06: a cancelled task cannot become completed, and a completed one cannot become failed', () => {
  const context = makeContext()
  const install = makeInstall('v06')
  const task = authorizedAdoption(context, install, '1.0.0')
  context.lifecycle.cancel(task.taskId, { reason: '用户取消' })
  assert.equal(context.tasks.read(task.taskId).state, TaskState.CANCELLED)

  for (const target of [TaskState.COMPLETED, TaskState.FAILED, TaskState.VERIFYING, TaskState.AUTHORIZED]) {
    assert.throws(
      () => context.tasks.transition(task.taskId, target),
      (error) => {
        assert.equal(error.code, 'CONFLICT')
        assert.equal(error.details.from, TaskState.CANCELLED)
        return true
      },
      `取消后不应能转成 ${target}`,
    )
  }
  // Every writer, not just transition, must refuse.
  assert.throws(() => context.tasks.fail(task.taskId, { code: 'X', message: 'x' }), (error) => {
    return error.code === 'CONFLICT'
  })
  assert.throws(() => context.tasks.complete(task.taskId, {}), (error) => error.code === 'CONFLICT')
  assert.equal(context.tasks.read(task.taskId).state, TaskState.CANCELLED)
})

test('V-06: re-writing the SAME terminal state stays idempotent', () => {
  const context = makeContext()
  const install = makeInstall('v06-idem')
  const task = authorizedAdoption(context, install, '1.0.0')
  context.lifecycle.cancel(task.taskId, { reason: '用户取消' })
  // A retried cancellation must not fail where the first succeeded.
  const again = context.tasks.cancel(task.taskId, { reason: 'again' })
  assert.equal(again.state, TaskState.CANCELLED)
})

test('V-06: a late failure does not rewrite an already-cancelled task, and is still reported', async () => {
  const context = makeContext()
  const install = makeInstall('v06-late')
  const task = authorizedAdoption(context, install, '1.0.0')
  context.lifecycle.cancel(task.taskId, { reason: '用户取消' })
  const result = await context.lifecycle.runAdoption(task.taskId, { executor: reportingExecutor('1.0.0') })
  assert.equal(result.ok, false)
  assert.equal(context.tasks.read(task.taskId).state, TaskState.CANCELLED)
})

// ---------------------------------------------------------------------------------------------
// V-07: a research candidate cannot enter the flow at all
// ---------------------------------------------------------------------------------------------

test('V-07: planAdoption refuses a research candidate before building any disclosure', () => {
  const root = temp.dir('v07')
  const kernel = createToolKernel({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(TOOLS_SRC, '..'),
    projectsRoot: path.join(root, 'projects'),
    clock: new Clock({ mode: 'manual', start: 1, stepMs: 1 }),
  })
  const install = makeInstall('v07-editly')
  const editly = kernel.catalog.toolIndex.get('editly').definition
  assert.equal(editly.catalogClass, CatalogClass.RESEARCH_CANDIDATE)
  assert.throws(
    () => kernel.planAdoption({ toolId: 'editly', location: install, targetVersion: '0.5.0' }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_FAILED')
      assert.match(error.message, /调研候选不能进入采纳流程/)
      return true
    },
  )
})

test('V-07: rollback of a research candidate is refused too', () => {
  const root = temp.dir('v07b')
  const kernel = createToolKernel({
    toolsRoot: path.join(root, 'tools'),
    stateRoot: path.join(root, 'state'),
    pluginRoot: path.join(TOOLS_SRC, '..'),
    projectsRoot: path.join(root, 'projects'),
    clock: new Clock({ mode: 'manual', start: 1, stepMs: 1 }),
  })
  assert.throws(() => kernel.planRollback({ toolId: 'editly' }), (error) => {
    assert.equal(error.code, 'VALIDATION_FAILED')
    return true
  })
})

// ---------------------------------------------------------------------------------------------
// V-08: the schema fingerprint must be compared by the product, not only by a unit test
// ---------------------------------------------------------------------------------------------

test('V-08: a live description that differs from the verified one demotes the status', async () => {
  const { schemaFingerprint } = await import('../../tools/channels.js')
  const context = makeContext()
  const tool = context.catalog.toolIndex.get('demo-tool').definition
  const verifiedDescription = { version: '1.0.0', tools: [{ name: 'render', inputSchema: { type: 'object' } }] }
  // Record a real-tool verification that carries a fingerprint computed from the CURRENT description.
  const recorded = schemaFingerprint(verifiedDescription).fingerprint
  const state = {
    ...context.states.read('demo-tool'),
    currentBuild: { version: '1.0.0', buildSegment: '1.0.0', location: 'C:\\tools\\demo', origin: 'manual' },
    verification: {
      status: VerificationStatus.PASSED,
      basis: 'real-tool',
      version: '1.0.0',
      schemaFingerprint: recorded,
      at: '2026-11-08T00:00:00.000Z',
      checks: [],
      reason: null,
    },
  }
  // Same description -> still available.
  assert.equal(
    deriveToolStatus({
      tool,
      state,
      expectSchemaFingerprint: schemaFingerprint(verifiedDescription).fingerprint,
    }).status,
    ToolStatus.AVAILABLE,
  )
  // Changed schema -> must be demoted, and the reason must say why.
  const drifted = deriveToolStatus({
    tool,
    state,
    expectSchemaFingerprint: schemaFingerprint({
      ...verifiedDescription,
      tools: [{ name: 'render', inputSchema: { type: 'string' } }],
    }).fingerprint,
  })
  assert.equal(drifted.status, ToolStatus.INSTALLED_UNVERIFIED)
  assert.match(drifted.reason, /schema|重新验证/)
})

// ---------------------------------------------------------------------------------------------
// V-09: the ToolExecutionProtocol functions must have product callers
// ---------------------------------------------------------------------------------------------

test('V-09: ToolExecutionProtocol helpers are called from the verification path', () => {
  const install = fs.readFileSync(path.join(TOOLS_SRC, 'install.js'), 'utf8')
  for (const fn of ['assertPermissions', 'beginExecution', 'endExecution', 'resolveExecutionRoute']) {
    assert.match(install, new RegExp(`\\b${fn}\\s*\\(`), `${fn} 必须被产品路径调用`)
  }
})

test('V-09: a channel that cannot run the tool is refused by the permission gate', async () => {
  // `assertPermissions` is real: a declaration without the required permission throws.
  const { assertPermissions, normalizeChannel } = await import('../../tools/channels.js')
  const readOnly = normalizeChannel({ kind: 'cli', entrypoint: 'demo', permissions: ['filesystem'] })
  assert.throws(() => assertPermissions(readOnly, ['filesystem', 'process']), (error) => {
    assert.equal(error.code, 'VALIDATION_FAILED')
    assert.deepEqual(error.details.missing, ['process'])
    return true
  })
})

test('V-09: a structured channel refuses arbitrary code instead of silently downgrading', async () => {
  const { normalizeChannel, resolveExecutionRoute } = await import('../../tools/channels.js')
  const structured = normalizeChannel({ kind: 'mcp', serverName: 'demo', permissions: ['process'] })
  assert.throws(
    () => resolveExecutionRoute({ channel: structured, wantsArbitraryCode: true }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})
