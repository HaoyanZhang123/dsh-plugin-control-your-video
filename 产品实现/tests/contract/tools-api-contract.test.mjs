/**
 * Contract tests for the TOOL-MANAGEMENT facade.
 *
 * Later cards (C11, C12, C13, C16) import ONLY `tools/index.js`. These tests pin the exported surface, the
 * frozen interface version, the status vocabulary and the five user-facing states the UI blueprint fixes,
 * so an internal refactor cannot silently change what a caller or a user sees.
 *
 * They also pin the two scope decisions of 2026-11-08:
 * - CR-4: no download/install capability exists on the surface (manual guidance only);
 * - CR-5: only a project REFERENCE crosses the boundary, never project facts.
 *
 * @module tests/contract/tools-api-contract.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as tools from '../../tools/index.js'
import {
  DISCLOSURE_FIELDS,
  PRODUCTION_USABLE_STATUSES,
  TOOL_STATUS_LABELS,
  ToolStatus,
  simplifiedUserState,
  userStatusLabel,
} from '../../tools/schema.js'

test('facade: exports the documented surface, and the interface version is frozen', () => {
  assert.equal(tools.TOOL_MANAGEMENT_INTERFACE_VERSION, '2.0.0')
  const required = [
    'createToolKernel',
    'createDefaultCatalog',
    'createToolPaths',
    'ToolPaths',
    'deriveToolStatus',
    'buildCatalog',
    'PACKS',
    'TOOL_STATUS_LABELS',
    'ToolStatus',
    'TaskState',
    'TaskKind',
    'VerificationBasis',
    'DisclosureField',
    'DISCLOSURE_FIELDS',
    'userStatusLabel',
    'simplifiedUserState',
    'isProductionUsable',
    'TOOL_MANAGEMENT_CAPABILITIES',
    'actionForKind',
    'normalizeProjectRef',
    'candidateFrom',
  ]
  for (const name of required) {
    assert.notEqual(tools[name], undefined, `缺少导出: ${name}`)
  }
})

test('facade: the surface offers no way to download or install a tool', () => {
  // CR-4: manual guidance only. A caller must not find an installer even by inspection.
  for (const forbidden of ['installTool', 'downloadTool', 'fetchArtifact', 'unpackArtifact', 'updateTool']) {
    assert.equal(tools[forbidden], undefined, `不应存在下载／安装入口: ${forbidden}`)
  }
  assert.deepEqual(Object.values(tools.TaskKind).sort(), ['adopt', 'reverify', 'rollback'])
})

test('schema: exactly one status may produce real output, and it is `available`', () => {
  assert.deepEqual([...PRODUCTION_USABLE_STATUSES], [ToolStatus.AVAILABLE])
  for (const status of Object.values(ToolStatus)) {
    assert.equal(tools.isProductionUsable(status), status === ToolStatus.AVAILABLE, status)
  }
})

test('schema: every internal status has a Chinese label, so no surface invents one', () => {
  for (const status of Object.values(ToolStatus)) {
    const label = TOOL_STATUS_LABELS[status]
    assert.equal(typeof label, 'string', `缺少标签: ${status}`)
    assert.ok(label.length > 0, `标签为空: ${status}`)
  }
  // The UI blueprint fixes these five user-facing states; the combined one must be spelled exactly.
  assert.equal(TOOL_STATUS_LABELS[ToolStatus.NEEDS_UPDATE], '需更新／不兼容')
  assert.equal(TOOL_STATUS_LABELS[ToolStatus.INCOMPATIBLE], '需更新／不兼容')
  assert.equal(TOOL_STATUS_LABELS[ToolStatus.INSTALLED_UNVERIFIED], '已安装未验证')
  assert.equal(TOOL_STATUS_LABELS[ToolStatus.VERIFICATION_FAILED], '验证失败')
  assert.equal(TOOL_STATUS_LABELS[ToolStatus.AVAILABLE], '可用')
  assert.equal(TOOL_STATUS_LABELS[ToolStatus.NOT_INSTALLED], '未安装')
})

test('schema: the simplified user state is a closed set of five plus the three honest extras', () => {
  const seen = new Set()
  for (const status of Object.values(ToolStatus)) seen.add(simplifiedUserState(status))
  assert.deepEqual(
    [...seen].sort(),
    [
      'available',
      'checking',
      'installed-unverified',
      'needs-update-or-incompatible',
      'not-installed',
      'research-candidate',
      'unknown',
      'verification-failed',
    ].sort(),
  )
  // Nothing but `available` may report as available.
  for (const status of Object.values(ToolStatus)) {
    if (status !== ToolStatus.AVAILABLE) assert.notEqual(simplifiedUserState(status), 'available', status)
  }
})

test('schema: the seven pre-execution disclosures are a closed, ordered list', () => {
  assert.deepEqual([...DISCLOSURE_FIELDS], ['source', 'version', 'location', 'data', 'fee', 'environment', 'rollback'])
})

test('schema: a status label reports usability and actionability without a caller guessing', () => {
  const available = userStatusLabel(ToolStatus.AVAILABLE)
  assert.equal(available.usable, true)
  assert.equal(available.actionable, false)

  const notInstalled = userStatusLabel(ToolStatus.NOT_INSTALLED)
  assert.equal(notInstalled.usable, false)
  assert.equal(notInstalled.actionable, true)

  // `checking` is transient: it must not be presented as something the user has to fix.
  const checking = userStatusLabel(ToolStatus.CHECKING)
  assert.equal(checking.usable, false)
  assert.equal(checking.actionable, false)

  assert.throws(() => userStatusLabel('invented-status'), (error) => error.code === 'VALIDATION_FAILED')
})

test('capabilities: the module states its own limits instead of implying unlimited support', () => {
  const capabilities = tools.TOOL_MANAGEMENT_CAPABILITIES
  for (const key of ['catalog', 'detection', 'installLifecycle', 'statusTruth', 'channels', 'isolation']) {
    assert.ok(Array.isArray(capabilities[key]?.supported), `${key}.supported`)
    assert.ok(Array.isArray(capabilities[key]?.limits), `${key}.limits`)
    assert.ok(capabilities[key].limits.length > 0, `${key} 必须写出限制`)
  }
  const installLimits = capabilities.installLifecycle.limits.join(' ')
  // CR-4 is stated in the module's own self-description, not only in a receipt.
  assert.match(installLimits, /插件不下载|不安装|不更新/)
})

test('facade: kernel construction refuses overlapping roots instead of writing into a project', () => {
  assert.throws(
    () =>
      tools.createToolKernel({
        toolsRoot: 'relative/tools',
        stateRoot: 'C:\\tmp\\state',
        pluginRoot: 'C:\\tmp\\plugin',
        projectsRoot: 'C:\\tmp\\projects',
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  // A tools root inside the plugin package is refused: external tools never live in the plugin.
  assert.throws(
    () =>
      tools.createToolKernel({
        toolsRoot: 'C:\\tmp\\plugin\\tools',
        stateRoot: 'C:\\tmp\\state',
        pluginRoot: 'C:\\tmp\\plugin',
        projectsRoot: 'C:\\tmp\\projects',
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  // A tools root inside the projects root is refused: a tool must never own project facts.
  assert.throws(
    () =>
      tools.createToolKernel({
        toolsRoot: 'C:\\tmp\\projects\\tools',
        stateRoot: 'C:\\tmp\\state',
        pluginRoot: 'C:\\tmp\\plugin',
        projectsRoot: 'C:\\tmp\\projects',
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
  // State inside the tools root would be destroyed by clearing plugin records.
  assert.throws(
    () =>
      tools.createToolKernel({
        toolsRoot: 'C:\\tmp\\tools',
        stateRoot: 'C:\\tmp\\tools\\state',
        pluginRoot: 'C:\\tmp\\plugin',
        projectsRoot: 'C:\\tmp\\projects',
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('CR-5: a project reference carries ids only, and refuses project facts', () => {
  // The boundary is enforced by the normalizer, so a caller cannot widen it by adding fields.
  assert.deepEqual(tools.normalizeProjectRef({ projectId: 'project-abc', projectVersion: 'v-1' }), {
    projectId: 'project-abc',
    projectVersion: 'v-1',
  })
  assert.deepEqual(tools.normalizeProjectRef({ projectId: 'project-abc' }), {
    projectId: 'project-abc',
    projectVersion: null,
  })
  assert.equal(tools.normalizeProjectRef(null), null)

  for (const extra of [{ title: 'my film' }, { phase: 'producing' }, { path: 'C:\\p' }, { materials: [] }]) {
    assert.throws(
      () => tools.normalizeProjectRef({ projectId: 'project-abc', ...extra }),
      (error) => error.code === 'VALIDATION_FAILED',
      `应拒绝把项目事实写进引用: ${JSON.stringify(extra)}`,
    )
  }
  assert.throws(() => tools.normalizeProjectRef({ projectId: 'UPPER' }), (error) => error.code === 'VALIDATION_FAILED')
})

test('CR-5: each task kind maps to exactly one authorizable action', () => {
  assert.equal(tools.actionForKind('adopt'), 'adopt-install')
  assert.equal(tools.actionForKind('reverify'), 'verify-install')
  assert.equal(tools.actionForKind('rollback'), 'rollback-build')
  assert.throws(() => tools.actionForKind('install'), (error) => error.code === 'VALIDATION_FAILED')
})

test('CR-6: the pin responsibility boundary is exported and stated as data', () => {
  // C13 needs these to know what to call; C06 must not keep them private knowledge.
  for (const name of [
    'PinCheck',
    'PinState',
    'SupersedeReason',
    'recheckPin',
    'pinHistory',
    'assertProjectId',
    'assertProjectVersion',
  ]) {
    assert.notEqual(tools[name], undefined, `缺少导出: ${name}`)
  }
  assert.deepEqual(Object.values(tools.PinCheck).sort(), ['ahead', 'current', 'missing', 'stale'])
  assert.deepEqual(Object.values(tools.PinState).sort(), ['active', 'superseded'])
})

test('CR-6: the kernel exposes the sync surface C13 needs, and nothing that advances a version itself', () => {
  const kernel = tools.createToolKernel({
    toolsRoot: 'C:\\tmp\\tk-tools',
    stateRoot: 'C:\\tmp\\tk-state',
    pluginRoot: 'C:\\tmp\\tk-plugin',
    projectsRoot: 'C:\\tmp\\tk-projects',
    clock: { now: () => 0, iso: () => '2026-11-08T00:00:00.000Z', describe: () => ({}) },
  })
  for (const method of [
    'pinForProject',
    'advanceProjectPin',
    'rechooseProjectPin',
    'recheckProjectPin',
    'projectPinHistory',
    'unpinForProject',
  ]) {
    assert.equal(typeof kernel[method], 'function', `缺少方法: ${method}`)
  }
  // There must be no method that bumps a project version: that is C10's fact and C13's sync, never C06's.
  for (const forbidden of ['bumpProjectVersion', 'advanceProjectVersion', 'nextProjectVersion', 'setProjectVersion']) {
    assert.equal(typeof kernel[forbidden], 'undefined', `不应存在推进项目版本的入口: ${forbidden}`)
  }
})
