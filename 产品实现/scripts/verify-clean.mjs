#!/usr/bin/env node
/**
 * Clean-environment verification.
 *
 * The task card's first minimum check is: a clean copy in a declared, isolated environment can
 * build and test. This script proves it for real by copying ONLY the source-controlled files
 * into a fresh temporary directory (no node_modules, no evidence) and running the full gate
 * there with a separate working directory.
 *
 * What it deliberately does not do: it does not install anything, because the dependency
 * closure is empty. If a future dependency is admitted, `pnpm install --frozen-lockfile`
 * becomes a required step and this script must fail when it cannot run offline.
 *
 * Usage: node scripts/verify-clean.mjs
 *
 * @module scripts/verify-clean
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTempDir } from '../base/tempdir.js'
import { disposeTemp, disposedCleanly, recordDispositions } from './lib/temp-disposition.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** Files and directories that constitute the reproducible project. */
const INCLUDE = ['base', 'scripts', 'tests', 'docs', 'core', 'tools', 'media', 'orchestration', 'editing', 'delivery', 'ui', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'LICENSE', 'README.md']

/**
 * Never copied: generated, machine-specific, or build output.
 *
 * `design-drafts` and `_refs` are design exploration and read-only extracts of host
 * documentation; `_tmp*` are isolated DSH homes from walkthroughs. None of them are part of the
 * product, and copying a walkthrough home into a "clean" verification would carry session data
 * into a scratch directory — the opposite of a clean run.
 */
const EXCLUDE_DIRS = new Set(['node_modules', 'evidence', '.git', '.pnpm-store', 'design-drafts', '_refs'])

/** Prefix-based exclusions for generated scratch directories (walkthrough homes, logs). */
const EXCLUDE_PREFIXES = ['_tmp']

/**
 * Recursively copy the project subset.
 * @param {string} source
 * @param {string} destination
 * @returns {{ files: number, bytes: number }}
 */
function copyProject(source, destination) {
  let files = 0
  let bytes = 0
  const walk = (from, to) => {
    const stat = fs.statSync(from)
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true })
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        if (EXCLUDE_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue
        walk(path.join(from, entry.name), path.join(to, entry.name))
      }
      return
    }
    if (!stat.isFile()) return
    fs.copyFileSync(from, to)
    files += 1
    bytes += stat.size
  }
  for (const entry of INCLUDE) {
    const from = path.join(source, entry)
    if (!fs.existsSync(from)) continue
    walk(from, path.join(destination, entry))
  }
  return { files, bytes }
}

function main() {
  process.stdout.write('clean-environment verification\n')
  process.stdout.write(`${'='.repeat(60)}\n`)

  // The clean copy lives OUTSIDE the workspace, so nothing can accidentally resolve back
  // into the original tree (a real isolation property, not a naming claim).
  const temp = createTempDir({ label: 'clean-verify' })
  const sandbox = path.join(temp.path, 'project')
  fs.mkdirSync(sandbox, { recursive: true })
  /** @type {Array<Record<string, unknown>>} */
  const dispositions = []
  let passed = false

  try {
    const copied = copyProject(ROOT, sandbox)
    process.stdout.write(`copied ${copied.files} files (${(copied.bytes / 1024).toFixed(1)} KiB) to an isolated temp dir\n`)
    process.stdout.write(`sandbox: ${path.relative(process.cwd(), sandbox) || sandbox}\n`)

    assertNoNodeModules(sandbox)

    const install = installDependencies(sandbox)
    process.stdout.write(`install: ${install.status} — ${install.detail}\n`)

    const steps = [
      ['build', ['scripts/build.mjs']],
      ['lint', ['scripts/static-check.mjs']],
      ['format', ['scripts/format.mjs', '--check']],
      ['deps', ['scripts/deps-report.mjs', '--check']],
      ['test:unit', ['scripts/test.mjs', 'unit']],
      ['test:contract', ['scripts/test.mjs', 'contract']],
      ['test:integration', ['scripts/test.mjs', 'integration']],
    ]

    const results = []
    for (const [id, args] of steps) {
      const started = Date.now()
      const run = spawnSync(process.execPath, args, {
        cwd: sandbox,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          // A clean environment must not inherit the developer's shell settings.
          TZ: 'UTC',
          DSH_AVW_TEST_MODE: '1',
          NODE_OPTIONS: '',
        },
      })
      const ok = run.status === 0
      results.push({ id, ok, exitCode: run.status ?? 1, durationMs: Date.now() - started })
      process.stdout.write(`${id.padEnd(18)} ${ok ? 'pass' : 'FAIL'}\n`)
      if (!ok) {
        const tail = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split(/\r?\n/).slice(-15).join('\n')
        process.stdout.write(`${tail}\n`)
        break
      }
    }

    const failed = results.filter((result) => !result.ok)
    const summary = {
      schemaVersion: 1,
      kind: 'clean-verify',
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      sandboxOutsideWorkspace: !path.resolve(sandbox).startsWith(path.resolve(ROOT)),
      copied,
      install,
      results,
      ok: failed.length === 0,
    }
    fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'evidence', 'clean-verify.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

    process.stdout.write(`${'='.repeat(60)}\n`)
    process.stdout.write(failed.length === 0 ? 'clean environment: PASSED\n' : 'clean environment: FAILED\n')
    passed = failed.length === 0
  } finally {
    // `process.exit()` skips `finally`, so the temp dir is disposed here FIRST and the exit
    // code is decided afterwards. This previously leaked one directory per run.
    dispositions.push(disposeTemp(temp, 'verify-clean'))
  }

  recordDispositions(dispositions)
  if (!disposedCleanly(dispositions)) {
    process.stdout.write('\n临时目录未能清理，见 evidence/temp-disposition.json\n')
    process.exit(1)
  }
  process.exit(passed ? 0 : 1)
}

/** A clean copy must not contain installed dependencies. */
function assertNoNodeModules(sandbox) {
  const forbidden = path.join(sandbox, 'node_modules')
  if (fs.existsSync(forbidden)) {
    throw new Error('干净副本中不应存在 node_modules')
  }
}

/**
 * Install locked dependencies when the project actually has any.
 *
 * With an empty closure this is a no-op and is reported as such; it does not fake an install.
 * @param {string} sandbox
 * @returns {{ status: string, detail: string }}
 */
function installDependencies(sandbox) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sandbox, 'package.json'), 'utf8'))
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
  if (declared.length === 0) {
    return {
      status: 'not-needed',
      detail: '依赖闭包为空，无需安装；构建与测试只使用 Node 内置模块，因此可离线复现',
    }
  }

  const run = spawnSync('pnpm', ['install', '--frozen-lockfile', '--offline'], {
    cwd: sandbox,
    encoding: 'utf8',
    // `shell: true` is required here: on Windows `pnpm` is a `.cmd` shim that cannot be
    // spawned directly. All arguments are literals, so there is no injection surface.
    shell: true,
    windowsHide: true,
  })
  return {
    status: run.status === 0 ? 'ok' : 'failed',
    detail: run.status === 0 ? '已从锁文件离线安装' : `离线安装失败: ${String(run.stderr ?? '').trim().split(/\r?\n/).at(-1)}`,
  }
}

main()
