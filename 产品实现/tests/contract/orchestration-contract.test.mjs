/**
 * Contract tests for the C13 public interface.
 *
 * A contract test here answers three questions a later card asks before integrating:
 * 1) is the interface version and capability statement present and shaped as documented;
 * 2) does the module expose a producer organization the card forbids (Team, Fork, per-shot agents)?
 *    It must not, and the absence is asserted rather than assumed;
 * 3) does C13 source obey the same static rules the shared lint enforces elsewhere, even though the
 *    lint's directory list predates this module? C13 cannot edit that list (it is a C04 root file),
 *    so the rules are re-asserted here instead of being silently skipped.
 *
 * @module tests/contract/orchestration-contract.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ORCHESTRATION_CAPABILITIES, ORCHESTRATION_INTERFACE_VERSION, createOrchestrationKit } from '../../orchestration/index.js'
import { ORCH_DOCUMENT } from '../../orchestration/ids.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_DIR = path.resolve(HERE, '../../orchestration')

/** Source files of the module under test. */
function sourceFiles() {
  return fs
    .readdirSync(MODULE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(MODULE_DIR, entry.name))
    .sort()
}

test('contract: the interface version is frozen and the capability areas are documented', () => {
  assert.equal(ORCHESTRATION_INTERFACE_VERSION, '1.0.0')
  const expectedAreas = [
    'brief',
    'directions',
    'units',
    'production',
    'vista',
    'methods',
    'craft',
    'pins',
    'preview',
    'legacyUiState',
  ]
  assert.deepEqual(Object.keys(ORCHESTRATION_CAPABILITIES).sort(), expectedAreas.sort())
  for (const area of Object.values(ORCHESTRATION_CAPABILITIES)) {
    assert.equal(Array.isArray(area.supported) && area.supported.length > 0, true)
    // No area may claim support without naming where it stops.
    assert.equal(Array.isArray(area.limits) && area.limits.length > 0, true)
  }
})

test('contract: the kit exposes one store per responsibility, all bound to one project', () => {
  const paths = { projectId: 'prj_TESTONLY00000000', resolve: (relative) => relative }
  const kit = createOrchestrationKit({ paths })
  assert.equal(kit.interfaceVersion, ORCHESTRATION_INTERFACE_VERSION)
  for (const name of ['brief', 'research', 'directions', 'baseline', 'series', 'references', 'units', 'production', 'vista', 'methods', 'craft', 'preview', 'pins']) {
    assert.equal(typeof kit[name], 'object', `${name} 必须是项目内存储`)
    assert.equal(kit[name].projectId, 'prj_TESTONLY00000000')
  }
  assert.equal(Object.isFrozen(kit), true, 'kit 不能被追加共享状态')
})

test('contract: no Team, Fork, critic or per-shot agent surface exists', () => {
  const forbidden = /spawn|team|fork|critic|subagent|per-?shot|multi-?agent/i
  const exportedNames = []
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/export (?:async )?(?:function|class|const)\s+([A-Za-z0-9_$]+)/g)) {
      exportedNames.push(`${path.basename(file)}:${match[1]}`)
    }
  }
  const offenders = exportedNames.filter((name) => forbidden.test(name.split(':')[1]))
  assert.deepEqual(offenders, [], `C13 不应暴露多 Agent 制作入口: ${offenders.join(',')}`)
})

test('contract: C13 documents are project-internal and separately versioned', () => {
  for (const [key, spec] of Object.entries(ORCH_DOCUMENT)) {
    assert.equal(typeof spec.kind, 'string', `${key} 需要 kind`)
    assert.equal(typeof spec.file, 'string', `${key} 需要文件路径`)
    // Every document lives under a directory C10 already reserves inside a project.
    assert.match(spec.file, /^(brief|plans|recipes|work|evidence)\//, `${key} 必须写在项目已保留目录内`)
    assert.equal(spec.file.includes('..'), false)
    assert.equal(spec.file.includes('\\'), false)
  }
})

/**
 * The same exemption the shared formatter uses: a line whose extra length comes from one quoted
 * literal (or a URL) is not a readability defect.
 * @param {string} line
 * @returns {boolean}
 */
function isExemptLongLine(line) {
  if (/https?:\/\//.test(line)) return true
  const withoutStrings = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
  return withoutStrings.length <= 120
}

test('contract: source obeys the shared static rules the lint cannot reach', () => {
  const findings = []
  for (const file of sourceFiles()) {
    const buffer = fs.readFileSync(file)
    const text = buffer.toString('utf8')
    const relative = path.basename(file)
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) findings.push(`${relative}: BOM`)
    if (!text.endsWith('\n') || text.endsWith('\n\n')) findings.push(`${relative}: 结尾换行不规范`)
    if (text.split('\n').some((line) => line.length > 120 && !isExemptLongLine(line))) {
      findings.push(`${relative}: 有超过 120 字符的行`)
    }
    if (/\brequire\s*\(/.test(text)) findings.push(`${relative}: 出现 require()`)
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) findings.push(`${relative}: 出现动态执行`)
    if (/['"`][A-Za-z]:[\\/][^'"`]*['"`]/.test(text)) findings.push(`${relative}: 出现绝对 Windows 路径`)
  }
  assert.deepEqual(findings, [])
  for (const file of sourceFiles()) {
    const first = fs.readFileSync(file, 'utf8').split('\n').slice(0, 3).join('\n')
    assert.match(first, /\/\*\*/, `${path.basename(file)} 缺少文件头注释`)
  }
})
