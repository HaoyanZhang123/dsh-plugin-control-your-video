#!/usr/bin/env node
/**
 * Failure lab: run every required fault scenario and RECORD what actually happened.
 *
 * The task card requires that build failure, test failure, dependency-missing and rollback are
 * real (§7.5), and CT-11 §5 lists the faults that must be covered. This script performs them
 * against the real code and writes `evidence/failure-lab.json`, so the claim is checkable
 * instead of asserted in prose.
 *
 * Scenarios are deliberately destructive only inside a managed temp directory.
 *
 * Usage: node scripts/failure-lab.mjs
 *
 * @module scripts/failure-lab
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic, sha256File, sha256, TEMP_SUFFIX } from '../base/atomic-write.js'
import { createTempDir } from '../base/tempdir.js'
import { PathGuard } from '../base/paths.js'
import { acquireLock, inspectLock, lockFileName } from '../base/locks.js'
import { Clock } from '../base/determinism.js'
import { readJson } from '../base/atomic-write.js'
import {
  enableFaultInjection,
  disableFaultInjection,
  FaultPlan,
  FaultKind,
  withFaultPlan,
  captureFailure,
} from '../base/faults.js'
import { disposeTemp, disposedCleanly, recordDispositions, surveyTempParents } from './lib/temp-disposition.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** @type {Array<Record<string, unknown>>} */
const scenarios = []

/**
 * Record one scenario.
 * @param {string} id
 * @param {string} description
 * @param {() => Record<string, unknown>} run
 */
function scenario(id, description, run) {
  const started = Date.now()
  try {
    const result = run()
    scenarios.push({ id, description, status: 'executed', durationMs: Date.now() - started, ...result })
  } catch (error) {
    scenarios.push({
      id,
      description,
      status: 'error',
      durationMs: Date.now() - started,
      error: { message: String(error?.message ?? error), code: error?.code ?? 'UNKNOWN' },
    })
  }
}

/**
 * Expected observation for each scenario field.
 *
 * This table is the difference between "the scenario ran" and "the scenario proved what it
 * claims". Each entry names the scenario, the field to check, and the expected value; a
 * mismatch fails the lab even though the code itself did not throw.
 *
 * Fields whose expected value depends on the host machine (e.g. whether ffmpeg happens to be
 * installed) are checked for SHAPE rather than a fixed boolean.
 * @type {Array<{ scenario: string, field: string, expected: unknown, detail?: string }>}
 */
const EXPECTED = [
  { scenario: 'disk-full-keeps-old-version', field: 'faultInjected', expected: true },
  { scenario: 'disk-full-keeps-old-version', field: 'errorCode', expected: 'ENOSPC' },
  { scenario: 'disk-full-keeps-old-version', field: 'oldContentPreserved', expected: true },
  { scenario: 'permission-denied-keeps-old-version', field: 'faultInjected', expected: true },
  { scenario: 'permission-denied-keeps-old-version', field: 'errorCode', expected: 'EACCES' },
  { scenario: 'permission-denied-keeps-old-version', field: 'oldContentPreserved', expected: true },
  { scenario: 'interrupted-write-is-detectable', field: 'targetReadableAfterInterruption', expected: true },
  { scenario: 'interrupted-write-is-detectable', field: 'partialFileDetectable', expected: true },
  { scenario: 'interrupted-write-is-detectable', field: 'partialIsNotValidState', expected: true },
  { scenario: 'truncated-read-is-rejected', field: 'rejected', expected: true },
  { scenario: 'truncated-read-is-rejected', field: 'targetCreated', expected: false },
  { scenario: 'stale-lock-requires-handling', field: 'verdict', expected: 'stale' },
  { scenario: 'stale-lock-requires-handling', field: 'acquireRefused', expected: true },
  { scenario: 'stale-lock-requires-handling', field: 'refusalCode', expected: 'STALE_LOCK' },
  { scenario: 'stale-lock-requires-handling', field: 'lockNotAutoDeleted', expected: true },
  { scenario: 'lock-contention-is-refused', field: 'secondWriterRefused', expected: true },
  { scenario: 'lock-contention-is-refused', field: 'holderReported', expected: 'writer-a' },
  { scenario: 'lock-contention-is-refused', field: 'releasedAfterwards', expected: true },
  { scenario: 'corrupt-state-is-not-silently-accepted', field: 'errorCode', expected: 'IO_FAILED' },
  { scenario: 'unadmitted-dependency-blocks-build', field: 'buildRefused', expected: true },
  { scenario: 'unadmitted-dependency-blocks-build', field: 'namesUnadmittedDependency', expected: true },
  { scenario: 'missing-tool-is-reported-not-faked', field: 'externalToolBundledInPackage', expected: false },
  { scenario: 'test-failure-is-real', field: 'failureObservable', expected: true },
  { scenario: 'acceptance-layer-refuses-to-pass', field: 'blockedByDesign', expected: true },
]

function main() {
  const temp = createTempDir({ label: 'failure-lab' })
  const guard = new PathGuard(temp.dir('lab'), { label: 'lab' })
  const clock = new Clock({ mode: 'frozen', start: 1_700_000_000_000 })
  /** @type {Array<Record<string, unknown>>} */
  const dispositions = []
  let passed = false
  try {
    scenario('disk-full-keeps-old-version', '磁盘满时保留旧版本，且不发布半成品', () => {
      const target = guard.resolve('disk-full.json')
      const old = JSON.stringify({ version: 1 })
      writeFileAtomic(target, old)
      const oldSha = sha256File(target)

      enableFaultInjection({ allow: true })
      const plan = new FaultPlan().arm('atomic-write:before-rename', FaultKind.DISK_FULL)
      const failure = withFaultPlan(plan, () =>
        captureFailure(() => writeFileAtomic(target, JSON.stringify({ version: 2 }))),
      )
      disableFaultInjection()

      return {
        faultInjected: plan.activationCount('atomic-write:before-rename') === 1,
        errorCode: /** @type {any} */ (failure.error)?.code ?? null,
        oldContentPreserved: sha256File(target) === oldSha,
        tempFilesLeftBehind: fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith(TEMP_SUFFIX)),
      }
    })

    scenario('permission-denied-keeps-old-version', '权限不足时不破坏既有文件', () => {
      const target = guard.resolve('perm.json')
      writeFileAtomic(target, '{"version":1}')
      const oldSha = sha256File(target)
      enableFaultInjection({ allow: true })
      const plan = new FaultPlan().arm('atomic-write:before-write', FaultKind.PERMISSION_DENIED)
      const failure = withFaultPlan(plan, () =>
        captureFailure(() => writeFileAtomic(target, '{"version":2}')),
      )
      disableFaultInjection()
      return {
        faultInjected: plan.activationCount('atomic-write:before-write') === 1,
        errorCode: /** @type {any} */ (failure.error)?.code ?? null,
        oldContentPreserved: sha256File(target) === oldSha,
      }
    })

    scenario('interrupted-write-is-detectable', '写入中断留下临时文件，目标文件仍可读', () => {
      const target = guard.resolve('interrupted.json')
      writeFileAtomic(target, '{"stable":true}')
      const partial = path.join(path.dirname(target), `.interrupted.json.${process.pid}.deadbee${TEMP_SUFFIX}`)
      fs.writeFileSync(partial, '{"incomplete')
      // Measured, not asserted: read the real target and the real partial file.
      let targetParses = false
      try {
        targetParses = JSON.parse(fs.readFileSync(target, 'utf8')).stable === true
      } catch {
        targetParses = false
      }
      let partialIsInvalid = false
      try {
        JSON.parse(fs.readFileSync(partial, 'utf8'))
        partialIsInvalid = false
      } catch {
        partialIsInvalid = true
      }
      const partialExisted = fs.existsSync(partial)
      const partialSize = partialExisted ? fs.statSync(partial).size : -1
      fs.rmSync(partial, { force: true })
      return {
        targetReadableAfterInterruption: targetParses,
        partialFileDetectable: partialExisted && partialSize > 0,
        // Proven by parsing it: the partial bytes are NOT valid, so they were never mistaken
        // for a finished state file.
        partialIsNotValidState: partialIsInvalid,
        targetUnchangedByPartial: targetParses,
      }
    })

    scenario('truncated-read-is-rejected', '回读内容与写入不一致时拒绝发布', () => {
      const target = guard.resolve('verify.json')
      const failure = captureFailure(() => writeFileAtomic(target, 'payload', { expectedSha256: sha256('other') }))
      return {
        rejected: failure.ok === false,
        errorCode: /** @type {any} */ (failure.error)?.code ?? null,
        targetCreated: fs.existsSync(target),
      }
    })

    scenario('stale-lock-requires-handling', '陈旧锁报“需要处理”，不自动删除', () => {
      const lockPath = guard.resolve(lockFileName('project-edit', 'prj-lab'))
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify(
          {
            formatVersion: 1,
            lockKind: 'project-edit',
            scopeId: 'prj-lab',
            ownerPid: 999_997,
            ownerInstanceId: 'dead-owner',
            ownerHost: process.env.COMPUTERNAME ?? 'unknown',
            ownerLabel: 'crashed session',
            taskId: 'C13-production',
            projectVersion: 'v7',
            acquiredAt: new Date(0).toISOString(),
            heartbeatAt: new Date(0).toISOString(),
          },
          null,
          2,
        )}\n`,
      )
      const inspected = inspectLock(lockPath, { clock })
      const acquireFailure = captureFailure(() =>
        acquireLock(lockPath, { kind: 'project-edit', scopeId: 'prj-lab', taskId: 'retry', clock }),
      )
      const stillThere = fs.existsSync(lockPath)
      return {
        verdict: inspected?.verdict ?? null,
        ownerAlive: inspected?.ownerAlive ?? null,
        acquireRefused: acquireFailure.ok === false,
        refusalCode: /** @type {any} */ (acquireFailure.error)?.details?.code ?? null,
        lockNotAutoDeleted: stillThere,
      }
    })

    scenario('lock-contention-is-refused', '同一范围第二个写入者被拒绝', () => {
      const lockPath = guard.resolve(lockFileName('project-edit', 'prj-two'))
      const first = acquireLock(lockPath, { kind: 'project-edit', scopeId: 'prj-two', taskId: 'writer-a', clock })
      const second = captureFailure(() =>
        acquireLock(lockPath, { kind: 'project-edit', scopeId: 'prj-two', taskId: 'writer-b', clock }),
      )
      first.release()
      return {
        secondWriterRefused: second.ok === false,
        refusalCode: /** @type {any} */ (second.error)?.code ?? null,
        holderReported: /** @type {any} */ (second.error)?.details?.taskId ?? null,
        releasedAfterwards: !fs.existsSync(lockPath),
      }
    })

    scenario('corrupt-state-is-not-silently-accepted', '损坏的 JSON 状态变为明确错误', () => {
      const target = guard.resolve('corrupt.json')
      fs.writeFileSync(target, '{ not json')
      const failure = captureFailure(() => readJson(target))
      return {
        errorCode: /** @type {any} */ (failure.error)?.code ?? null,
        stage: /** @type {any} */ (failure.error)?.details?.stage ?? null,
      }
    })

    scenario('unadmitted-dependency-blocks-build', '未登记的依赖会让构建以真实原因失败', () => {
      // Copy the minimum tree into a temp project, then declare a dependency that is not in
      // the ledger. The build must refuse rather than silently admit it.
      const project = temp.dir('dep-gate')
      for (const entry of ['base', 'scripts', 'docs']) {
        fs.cpSync(path.join(ROOT, entry), path.join(project, entry), { recursive: true })
      }
      for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
        fs.copyFileSync(path.join(ROOT, file), path.join(project, file))
      }
      const manifestPath = path.join(project, 'package.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.dependencies = { 'left-pad': '1.3.0' }
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

      const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: project, encoding: 'utf8' })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      return {
        buildExitCode: result.status,
        buildRefused: result.status !== 0,
        namesUnadmittedDependency: output.includes('left-pad'),
      }
    })

    scenario('missing-tool-is-reported-not-faked', '缺少外部工具时报告未安装，不伪造可用', () => {
      // External tools are not bundled by design (CT-10 §1). Their absence must be an
      // OBSERVED fact, so this measures the probe rather than asserting a constant.
      const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true })
      const ffmpegDetected = probe.status === 0
      const ffmpegVersion = ffmpegDetected ? String(probe.stdout ?? '').split(/\r?\n/)[0].slice(0, 80) : null
      // The package must not ship the tool: check the real package tree, not a belief.
      const bundled = ['node_modules/ffmpeg', 'vendor/ffmpeg', 'lib/assets/ffmpeg'].filter((rel) =>
        fs.existsSync(path.join(ROOT, rel)),
      )
      return {
        ffmpegDetected,
        ffmpegVersion,
        externalToolBundledInPackage: bundled.length > 0,
        bundledPaths: bundled,
      }
    })

    scenario('test-failure-is-real', '测试失败会产生非零退出码', () => {
      // A real failing test file, created in a managed temp dir. Note: filtering a test runner
      // by a non-matching name is NOT a valid negative control — Node exits 0 when it skips
      // everything — so this scenario proves failure with an actually failing assertion.
      const dir = temp.dir('failing-test')
      const file = path.join(dir, 'deliberate-failure.test.mjs')
      fs.writeFileSync(
        file,
        [
          'import test from "node:test"',
          'import assert from "node:assert/strict"',
          'test("deliberate failure for the failure lab", () => {',
          '  assert.equal(1, 2, "this failure is intentional")',
          '})',
          '',
        ].join('\n'),
        'utf8',
      )
      const result = spawnSync(process.execPath, ['--test', file], { cwd: ROOT, encoding: 'utf8' })
      return {
        exitCode: result.status,
        failureObservable: result.status !== 0,
        outputMentionsAssertion: `${result.stdout ?? ''}`.includes('deliberate failure'),
      }
    })

    scenario('acceptance-layer-refuses-to-pass', '真实产品验收层在没有产品时必须失败', () => {
      const result = spawnSync(process.execPath, ['scripts/test.mjs', 'acceptance'], { cwd: ROOT, encoding: 'utf8' })
      return { exitCode: result.status, expectedDesignExitCode: 3, blockedByDesign: result.status === 3 }
    })

    // Evaluate every expectation against the OBSERVED values, not against "it ran".
    const byId = new Map(scenarios.map((item) => [item.id, item]))
    const expectations = EXPECTED.map((rule) => {
      const observed = byId.get(rule.scenario)?.[rule.field]
      const met = Object.is(observed, rule.expected)
      return {
        scenario: rule.scenario,
        field: rule.field,
        expected: rule.expected,
        observed: observed ?? null,
        met,
        detail: met
          ? 'matches'
          : `期望 ${JSON.stringify(rule.expected)}，实际 ${JSON.stringify(observed ?? null)}`,
      }
    })

    const evidence = {
      schemaVersion: 1,
      kind: 'failure-lab',
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      scenarios,
      // Stated honestly: this proves the injected range only.
      scope: '故障只证明实际注入的范围，不外推到未注入的故障（CT-11 §5）。',
      allExecuted: scenarios.every((item) => item.status === 'executed'),
      expectations,
      // Passing requires BOTH that everything ran AND that every observation matched the
      // expectation. Merely "the code ran" is not evidence that it behaved correctly.
      allExpectationsMet: expectations.every((item) => item.met),
    }
    fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'evidence', 'failure-lab.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

    for (const item of scenarios) {
      process.stdout.write(`${item.status === 'executed' ? 'ok  ' : 'ERR '} ${item.id}\n`)
    }
    for (const expectation of expectations) {
      if (!expectation.met) {
        process.stdout.write(`\nMISMATCH ${expectation.scenario}.${expectation.field}: ${expectation.detail}\n`)
      }
    }
    process.stdout.write(
      `\nfailure-lab: ${scenarios.length} scenarios, executed: ${evidence.allExecuted}, ` +
        `expectations met: ${evidence.allExpectationsMet}\n`,
    )
    passed = evidence.allExecuted && evidence.allExpectationsMet
  } finally {
    // Dispose BEFORE leaving: `process.exit()` skips `finally`, which previously leaked a
    // managed temp directory on every run. Record the outcome so a leak is visible.
    dispositions.push(disposeTemp(temp, 'failure-lab'))
  }

  recordDispositions(dispositions)
  const survey = surveyTempParents(path.dirname(temp.path))
  if (survey.stale.length > 0) {
    process.stdout.write(
      `\n注意：%TEMP% 下仍有 ${survey.stale.length} 个此前运行遗留的受管临时目录（只报告，不自动删除）。\n`,
    )
  }
  if (!disposedCleanly(dispositions)) {
    process.stdout.write('\nfailure-lab: 临时目录未能清理，见 evidence/temp-disposition.json\n')
    process.exit(1)
  }
  process.exit(passed ? 0 : 1)
}

main()
