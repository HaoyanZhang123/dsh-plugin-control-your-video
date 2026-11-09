#!/usr/bin/env node
/**
 * Layered test entry for the AI video workbench.
 *
 * Layers follow CT-11 §2 exactly, and each layer refuses to be mistaken for a stronger one:
 *
 *   unit        pure functions, no filesystem outside a managed temp dir
 *   contract    public interface shape, versions and error codes from CT-01..CT-14
 *   integration multiple modules working together (project + storage + locks)
 *   acceptance  REAL product journeys; requires a running product, so today it fails loudly
 *
 * `acceptance` deliberately exits non-zero with an explicit reason: there is no product to
 * accept yet, and a green "acceptance" run would be exactly the "骨架能构建冒充产品完成"
 * failure the task card forbids.
 *
 * Usage:
 *   node scripts/test.mjs [unit|contract|integration|acceptance|all] [--concurrency=N] [--verbose]
 *
 * @module scripts/test
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TESTS = path.join(ROOT, 'tests')

/** Layer definitions: directory, what it may prove, and whether it can run today. */
export const LAYERS = Object.freeze({
  unit: {
    dir: 'unit',
    pattern: '*.test.mjs',
    proves: '纯函数、模式、时间、锁、迁移逻辑',
    cannotProve: '页面、作品、跨模块流程',
    runnable: true,
  },
  contract: {
    dir: 'contract',
    pattern: '*.test.mjs',
    proves: 'CT-01..CT-14 公开接口、版本、错误码与适配边界',
    cannotProve: '跨模块流程与真实产品行为',
    runnable: true,
  },
  integration: {
    dir: 'integration',
    pattern: '*.test.mjs',
    proves: '多模块共同工作：项目、存储、锁、原子写与故障注入',
    cannotProve: '审美、真实作品与长期体验',
    runnable: true,
  },
  acceptance: {
    dir: 'acceptance',
    pattern: '*.test.mjs',
    proves: '真实产品旅程与整片结果（需要产品存在且用户实际验收）',
    cannotProve: '用户审美判断',
    // The layer RUNS, and its tests fail with an explicit blocker while no product exists.
    // Running (rather than skipping) proves the layer is wired correctly and that the failure
    // is real, instead of hiding the gap behind a skip.
    runnable: true,
    expectFailure: true,
    failureReason:
      '真实产品验收需要可运行的产品与用户实际验收；当前产品尚不存在，本层必须失败，' +
      '不得用工程骨架冒充产品完成。',
  },
})

/**
 * @param {string[]} args
 */
function parseArgs(args) {
  const options = { layer: 'all', concurrency: 1, verbose: false }
  for (const arg of args) {
    if (arg.startsWith('--concurrency=')) {
      options.concurrency = Number(arg.slice('--concurrency='.length))
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true
    } else if (!arg.startsWith('-')) {
      options.layer = arg
    }
  }
  return options
}

/** Collect test files for a layer. */
function collectTests(layer) {
  const definition = LAYERS[layer]
  if (!definition) throw new Error(`未知测试层: ${layer}`)
  const dir = path.join(TESTS, definition.dir)
  if (!fs.existsSync(dir)) return []
  const out = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

/**
 * Run one layer with the built-in Node test runner.
 * @param {string} layer
 * @param {{ concurrency: number, verbose: boolean }} options
 */
function runLayer(layer, options) {
  const definition = LAYERS[layer]
  const files = collectTests(layer)

  if (files.length === 0) {
    return {
      layer,
      status: 'empty',
      files: 0,
      reason: `本层没有任何测试文件（tests/${definition.dir}）`,
      exitCode: 1,
    }
  }

  // Node's `json` reporter is unavailable in this build; junit works and is machine-readable,
  // so evidence can be parsed without scraping human output.
  const evidenceDir = path.join(ROOT, 'evidence', 'test-runs')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const junitPath = path.join(evidenceDir, `${layer}.junit.xml`)

  // `spec` keeps per-test names visible (useful when a failure must be attributable);
  // `--verbose` is accepted for symmetry but intentionally changes nothing about selection.
  const reporter = 'spec'
  const args = [
    '--test',
    `--test-concurrency=${options.concurrency}`,
    `--test-reporter=${reporter}`,
    `--test-reporter-destination=stdout`,
    `--test-reporter=junit`,
    `--test-reporter-destination=${junitPath}`,
  ]
  for (const file of files) args.push(file)

  const started = Date.now()
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Force a deterministic clock and a managed temp root for every test process.
      TZ: 'UTC',
      DSH_AVW_TEST_MODE: '1',
    },
  })
  const durationMs = Date.now() - started
  const passed = result.status === 0

  // An expected-failure layer (acceptance today) reports 'blocked-by-design' when it fails,
  // and 'unexpected-pass' when it passes: a green acceptance run with no product would be
  // exactly the fake-completion failure the task card forbids.
  if (definition.expectFailure === true) {
    return {
      layer,
      status: passed ? 'unexpected-pass' : 'blocked-by-design',
      files: files.length,
      exitCode: passed ? 0 : 3,
      durationMs,
      evidence: path.relative(ROOT, junitPath).split(path.sep).join('/'),
      reason: definition.failureReason,
      realExitCode: result.status ?? 1,
    }
  }

  return {
    layer,
    status: passed ? 'passed' : 'failed',
    files: files.length,
    exitCode: result.status ?? 1,
    durationMs,
    evidence: path.relative(ROOT, junitPath).split(path.sep).join('/'),
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const layers = options.layer === 'all' ? Object.keys(LAYERS) : [options.layer]

  /** @type {Array<Record<string, unknown>>} */
  const results = []
  for (const layer of layers) {
    if (!LAYERS[layer]) {
      console.error(`未知测试层: ${layer}`)
      console.error(`可用层: ${Object.keys(LAYERS).join(', ')}, all`)
      process.exit(2)
    }
    process.stdout.write(`\n=== test layer: ${layer} ===\n`)
    const result = runLayer(layer, options)
    results.push(result)
    if (result.reason) process.stdout.write(`(${result.reason})\n`)
    if (result.status === 'passed' || result.status === 'empty') {
      process.stdout.write(`layer ${layer}: ${result.status} (${result.files} files)\n`)
    } else {
      process.stdout.write(`layer ${layer}: ${result.status} (exit ${result.exitCode})\n`)
    }
  }

  const failed = results.filter(
    (result) => result.status === 'failed' || result.status === 'empty' || result.status === 'unexpected-pass',
  )

  // CRITICAL: the summary must never let a PARTIAL run look like a whole-suite pass.
  // Running one layer (e.g. `node scripts/test.mjs acceptance`) writes a separate per-layer
  // file; only a full `all` run may write `test-summary.json`, and only then may it claim
  // `passed: true` — otherwise a reader would see a green suite that never executed.
  const isFullRun = options.layer === 'all'
  const allLayers = Object.keys(LAYERS)
  const executedLayers = results.map((result) => result.layer)
  const missingLayers = allLayers.filter((layer) => !executedLayers.includes(layer))
  const summaryPath = path.join(ROOT, 'evidence', isFullRun ? 'test-summary.json' : `test-summary.${options.layer}.json`)
  fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true })
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        scope: isFullRun ? 'all-layers' : 'partial',
        layers: results,
        // `passed` means "the whole declared suite passed", so a partial run is never passed.
        passed: isFullRun && failed.length === 0 && missingLayers.length === 0,
        complete: isFullRun && missingLayers.length === 0,
        missingLayers,
        note: isFullRun
          ? '全量分层运行'
          : `部分运行（只执行 ${executedLayers.join(', ')}）；不可作为整套测试通过的证据`,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  process.stdout.write(`\n${'-'.repeat(50)}\n`)
  for (const result of results) {
    process.stdout.write(`${String(result.layer).padEnd(12)} ${result.status}\n`)
  }

  const runnableLayers = results.filter((result) => result.status !== 'blocked-by-design')
  const runnableFailed = runnableLayers.filter((result) => result.status !== 'passed')
  const blocked = results.filter((result) => result.status === 'blocked-by-design')
  const unexpectedPass = results.filter((result) => result.status === 'unexpected-pass')

  if (unexpectedPass.length > 0) {
    process.stdout.write('\n真实产品验收层意外通过：没有产品却通过，说明门禁被绕过。\n')
    process.exit(1)
  }
  if (runnableFailed.length > 0) process.exit(1)
  if (blocked.length > 0) {
    process.stdout.write('\nacceptance 层按设计失败（已实际运行并失败，不是跳过）：没有可运行的产品，也没有用户实际验收。\n')
    process.exit(3)
  }
  process.exit(0)
}

main()
