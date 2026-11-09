/**
 * C10 clean-environment reproduction evidence.
 *
 * WHY THIS EXISTS INSTEAD OF `scripts/verify-clean.mjs`:
 * `scripts/verify-clean.mjs` is C04-owned and its INCLUDE list is
 * `['base','scripts','tests','docs', ...]` — it does not copy `core/`. That was correct for C04,
 * which had no module code, but it means the shared clean-environment check cannot verify any
 * module card: every test under `tests/` that imports `core/...` fails inside the isolated copy.
 *
 * C10 must not modify C04's script (03 §3.4: a public defect is reported as a change request, not
 * patched in place), so this script performs the SAME verification with the module directory added
 * and writes its own evidence file. It answers one question honestly: "does this tree build and
 * test from a clean copy with no node_modules and no generated evidence?"
 *
 * Usage: node core/project/dev/clean-verify.mjs
 *
 * @module core/project/dev/clean-verify
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTempDir } from '../../../base/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Repository root: this file lives at <root>/core/project/dev/. */
const ROOT = path.resolve(HERE, '..', '..', '..')

/**
 * Files and directories constituting the reproducible tree.
 *
 * Identical to `scripts/verify-clean.mjs` PLUS `core`, which is the module code this card owns.
 * `evidence` is excluded because it is generated; `node_modules` because the closure is empty.
 */
const INCLUDE = [
  'base',
  'core',
  'scripts',
  'tests',
  'docs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
]

/** Never copied: installed, generated, or VCS metadata. */
const EXCLUDE_DIRS = new Set(['node_modules', 'evidence', '.git', '.pnpm-store'])

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

/** The steps that must pass in the isolated copy. */
const STEPS = [
  ['build', ['scripts/build.mjs']],
  ['lint', ['scripts/static-check.mjs']],
  ['format', ['scripts/format.mjs', '--check']],
  ['deps', ['scripts/deps-report.mjs', '--check']],
  ['test:unit', ['scripts/test.mjs', 'unit']],
  ['test:contract', ['scripts/test.mjs', 'contract']],
  ['test:integration', ['scripts/test.mjs', 'integration']],
]

function main() {
  process.stdout.write('C10 clean-environment verification (module tree included)\n')
  process.stdout.write(`${'='.repeat(60)}\n`)

  const temp = createTempDir({ label: 'c10-clean-verify' })
  const sandbox = path.join(temp.path, 'project')
  fs.mkdirSync(sandbox, { recursive: true })
  let passed = false
  let disposed = null

  try {
    const copied = copyProject(ROOT, sandbox)
    process.stdout.write(`copied ${copied.files} files (${(copied.bytes / 1024).toFixed(1)} KiB)\n`)
    // The isolation claim must be checkable, not asserted: the copy lives outside the workspace.
    const outsideWorkspace = !path.resolve(sandbox).startsWith(path.resolve(ROOT))
    process.stdout.write(`sandbox outside workspace: ${outsideWorkspace}\n`)
    if (!outsideWorkspace) throw new Error('隔离副本必须位于工作区之外')
    if (fs.existsSync(path.join(sandbox, 'node_modules'))) throw new Error('干净副本中不应存在 node_modules')
    // The copy must really contain the module tree, or this verification proves nothing.
    if (!fs.existsSync(path.join(sandbox, 'core', 'project', 'index.js'))) {
      throw new Error('干净副本缺少 core/project/index.js')
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(sandbox, 'package.json'), 'utf8'))
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]
    const install =
      declared.length === 0
        ? { status: 'not-needed', detail: '依赖闭包为空，只使用 Node 内置模块，可离线复现' }
        : { status: 'required', detail: '存在依赖；本脚本不安装，请改用 scripts/verify-clean.mjs' }
    process.stdout.write(`install: ${install.status} — ${install.detail}\n`)

    const results = []
    for (const [id, args] of STEPS) {
      const started = Date.now()
      const run = spawnSync(process.execPath, args, {
        cwd: sandbox,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, TZ: 'UTC', DSH_AVW_TEST_MODE: '1', NODE_OPTIONS: '' },
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
      kind: 'c10-clean-verify',
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      sandboxOutsideWorkspace: outsideWorkspace,
      include: INCLUDE,
      copied,
      install,
      results,
      ok: failed.length === 0,
      note:
        'C04 的 scripts/verify-clean.mjs 不复制 core/，因此无法验证本卡；此脚本用同一方法加上 core/，' +
        '作为 C10 的干净环境证据。变更请求见 实施交接/回执/C10-回执.md。',
    }
    fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'evidence', 'c10-clean-verify.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    passed = failed.length === 0
    process.stdout.write(`${'='.repeat(60)}\n`)
    process.stdout.write(passed ? 'C10 clean environment: PASSED\n' : 'C10 clean environment: FAILED\n')
  } finally {
    // Dispose BEFORE exiting: process.exit() skips finally, which is how temp dirs leaked before.
    disposed = temp.dispose()
  }

  if (disposed?.removed !== true) {
    process.stdout.write(`\n临时目录未能清理：${disposed?.reason ?? 'unknown'}\n`)
    process.exit(1)
  }
  process.exit(passed ? 0 : 1)
}

main()
