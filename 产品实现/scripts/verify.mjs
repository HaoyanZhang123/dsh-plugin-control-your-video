#!/usr/bin/env node
/**
 * One-shot quality gate: everything a later card must pass before it is integrated.
 *
 * Each step is a REAL command with a real exit code; a failure stops the run. The summary is
 * written to `evidence/verify-summary.json` so 总控 can read machine-checkable evidence
 * instead of trusting a receipt's prose.
 *
 * Note on `acceptance`: it is expected to FAIL today and that is recorded as a known,
 * intentional gap, not hidden. The gate reports `acceptance: not-runnable` and still exits 0
 * only if every runnable step passed.
 *
 * Usage: node scripts/verify.mjs [--include-acceptance]
 *
 * @module scripts/verify
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/**
 * @typedef {object} Step
 * @property {string} id
 * @property {string} label
 * @property {string[]} args
 * @property {boolean} [optional]
 * @property {boolean} [captureStdout]
 */

/** @type {Step[]} */
const STEPS = [
  { id: 'build', label: '宿主清单契约与入口校验', args: ['scripts/build.mjs'] },
  { id: 'lint', label: '静态规则检查', args: ['scripts/static-check.mjs'] },
  { id: 'format', label: '格式检查', args: ['scripts/format.mjs', '--check'] },
  { id: 'deps', label: '依赖准入与 MIT 台账', args: ['scripts/deps-report.mjs', '--check'] },
  { id: 'test-unit', label: '单元测试', args: ['scripts/test.mjs', 'unit'] },
  { id: 'test-contract', label: '契约测试', args: ['scripts/test.mjs', 'contract'] },
  { id: 'test-integration', label: '集成测试', args: ['scripts/test.mjs', 'integration'] },
  { id: 'failure-lab', label: '故障注入与回退实证', args: ['scripts/failure-lab.mjs'] },
]

/**
 * Run one step, capturing exit code and a bounded tail of output.
 * @param {Step} step
 */
function runStep(step) {
  const started = Date.now()
  const result = spawnSync(process.execPath, step.args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC', DSH_AVW_TEST_MODE: '1' },
  })
  const durationMs = Date.now() - started
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  const tail = `${stdout}${stderr}`.trim().split(/\r?\n/).slice(-12).join('\n')
  return {
    id: step.id,
    label: step.label,
    command: `node ${step.args.join(' ')}`,
    exitCode: result.status ?? 1,
    durationMs,
    ok: result.status === 0,
    outputTail: tail,
  }
}

/** Run the acceptance layer separately: it is expected to FAIL while no product exists. */
function runAcceptance() {
  const result = spawnSync(process.execPath, ['scripts/test.mjs', 'acceptance'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', DSH_AVW_TEST_MODE: '1' },
  })
  const exitCode = result.status ?? 1
  return {
    id: 'test-acceptance',
    label: '真实产品验收（当前按设计失败）',
    command: 'node scripts/test.mjs acceptance',
    exitCode,
    // 3 = the layer ran and failed by design; 0 here would mean the gate was bypassed.
    status: exitCode === 3 ? 'blocked-by-design' : exitCode === 0 ? 'unexpected-pass' : 'failed',
    ok: false,
  }
}

function main() {
  const includeAcceptance = process.argv.includes('--include-acceptance')
  process.stdout.write('quality gate\n')
  process.stdout.write(`${'='.repeat(60)}\n`)

  const results = []
  for (const step of STEPS) {
    process.stdout.write(`\n[${step.id}] ${step.label}\n`)
    const result = runStep(step)
    results.push(result)
    process.stdout.write(result.ok ? '  PASS\n' : `  FAIL (exit ${result.exitCode})\n`)
    if (!result.ok) {
      process.stdout.write(`${result.outputTail.split('\n').map((line) => `  | ${line}`).join('\n')}\n`)
      break
    }
  }

  const acceptance = runAcceptance()
  if (includeAcceptance) {
    process.stdout.write(`\n[acceptance] ${acceptance.label}\n`)
    process.stdout.write(`  ${acceptance.status}\n`)
  }

  const failed = results.filter((result) => !result.ok)
  const summary = {
    schemaVersion: 1,
    kind: 'verify-summary',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    steps: results,
    acceptance,
    ok: failed.length === 0,
  }
  fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'evidence', 'verify-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  process.stdout.write(`\n${'='.repeat(60)}\n`)
  for (const result of results) {
    process.stdout.write(`${result.id.padEnd(18)} ${result.ok ? 'pass' : 'FAIL'}\n`)
  }
  process.stdout.write(`${'acceptance'.padEnd(18)} ${acceptance.status} (按设计失败：无产品可验收)\n`)

  if (acceptance.status === 'unexpected-pass') {
    process.stdout.write('\nquality gate: FAILED（验收层意外通过，门禁被绕过）\n')
    process.exit(1)
  }
  if (failed.length > 0) {
    process.stdout.write('\nquality gate: FAILED\n')
    process.exit(1)
  }
  process.stdout.write('\nquality gate: PASSED（不含真实产品验收）\n')
  process.exit(0)
}

main()
