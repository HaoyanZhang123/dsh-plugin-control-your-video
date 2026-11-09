#!/usr/bin/env node
/**
 * Boot an ISOLATED DeepSeek Harness host for C11 verification.
 *
 * Why this exists: the running DSH (127.0.0.1:1254) belongs to the user; loading an unfinished
 * plugin into it would disturb their session and profile. This launcher creates a throwaway
 * DSH_HOME, a throwaway profile that lists only `dsh-base`, `dsh-web-app` and this plugin, links
 * the plugin by junction (no copy), and starts the same Host entry the Desktop bundle uses — with
 * an ephemeral port and the IPC channel kept open, so the authenticated URL can be read.
 *
 * What it does NOT do: no install, no network, no changes to the user's profile or its data.
 *
 * Usage:
 *   node ui/dev/isolated-host.mjs --root <dir>            # create profile + boot, print URL
 *   node ui/dev/isolated-host.mjs --root <dir> --setup    # only create the isolated layout
 *
 * @module ui/dev/isolated-host
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(HERE, '..')
const PLUGIN_ROOT = path.resolve(UI_ROOT, '..')

const DSH_APP_ROOT = process.env.DSH_APP_ROOT ?? 'E:/DSH-desktop'
const ELECTRON_EXE = process.env.DSH_ELECTRON ?? path.join(DSH_APP_ROOT, 'DeepSeek Harness.exe')
const DSH_ROOT = path.join(DSH_APP_ROOT, 'resources/app.asar/dsh')
const HOST_ENTRY = path.join(DSH_ROOT, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')
const RUNTIME_DIR = path.join(DSH_APP_ROOT, 'resources/runtime/primary-runtime')
const PNPM = path.join(RUNTIME_DIR, 'dependencies/pnpm/bin/pnpm.mjs')
const RUNTIME_BIN = path.join(DSH_APP_ROOT, 'resources/runtime/bin')
const PACKAGE_NAME = 'dsh-plugin-control-your-video'

function parseArgs() {
  const args = { root: path.join(UI_ROOT, 'dev/_tmp-dsh'), setupOnly: false }
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') args.root = path.resolve(argv[index + 1])
    if (argv[index] === '--setup') args.setupOnly = true
  }
  return args
}

export function setupIsolated(root) {
  // DSH_HOME must live OUTSIDE the plugin checkout: the C06 kernel refuses a tools tree inside the
  // plugin root, and the real DSH_HOME is outside too. The profile itself stays under `root`.
  const home = process.env.AVW_ISOLATED_HOME ?? path.join(os.tmpdir(), `avw-dsh-home-${path.basename(root)}`)
  const profile = path.join(root, 'profile')
  const nodeModules = path.join(profile, 'node_modules')
  fs.mkdirSync(nodeModules, { recursive: true })
  fs.mkdirSync(home, { recursive: true })

  const manifest = {
    name: 'dsh-profile-c11-isolated',
    private: true,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PACKAGE_NAME],
      },
    },
  }
  fs.writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.writeFileSync(
    path.join(profile, 'cordis.patch.yml'),
    '# C11 isolated verification profile: no user overlays.\n[]\n',
    'utf8',
  )

  const linkPath = path.join(nodeModules, PACKAGE_NAME)
  let linked = false
  try {
    const stats = fs.lstatSync(linkPath)
    linked = stats.isSymbolicLink() || stats.isDirectory()
    if (!linked) linked = true
  } catch {
    linked = false
  }
  if (!linked) {
    fs.symlinkSync(PLUGIN_ROOT, linkPath, 'junction')
  }

  return { root, home, profile, linkPath }
}

export function bootIsolated(layout) {
  if (!fs.existsSync(ELECTRON_EXE)) throw new Error(`找不到 Electron 可执行文件：${ELECTRON_EXE}`)
  // app.asar is a file only Electron's loader can traverse, so plain Node cannot stat HOST_ENTRY.
  // Checking the archive itself is the honest precondition this launcher can verify.
  if (!fs.existsSync(path.join(DSH_APP_ROOT, 'resources/app.asar'))) {
    throw new Error(`找不到 DSH 安装归档：${path.join(DSH_APP_ROOT, 'resources/app.asar')}`)
  }
  const child = spawn(ELECTRON_EXE, [
    '--expose-internals',
    HOST_ENTRY,
    DSH_ROOT,
    layout.profile,
    RUNTIME_DIR,
    PNPM,
    RUNTIME_BIN,
  ], {
    cwd: layout.root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: layout.home,
      DSH_DESKTOP_NODE_EXECUTABLE: ELECTRON_EXE,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  child.stdout.on('data', (chunk) => process.stdout.write(`[host] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[host] ${chunk}`))
  return child
}

function main() {
  const args = parseArgs()
  const layout = setupIsolated(args.root)
  process.stdout.write(`isolated root : ${layout.root}\n`)
  process.stdout.write(`DSH_HOME      : ${layout.home}\n`)
  process.stdout.write(`profile       : ${layout.profile}\n`)
  process.stdout.write(`plugin link   : ${layout.linkPath}\n`)
  if (args.setupOnly) return

  const child = bootIsolated(layout)
  let ready = false
  const timeout = setTimeout(() => {
    if (!ready) {
      process.stderr.write('Host 在 60 秒内没有报告 ready\n')
      child.kill()
      process.exitCode = 1
    }
  }, 60_000)

  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'starting') process.stdout.write(`[host] starting runId=${String(message.runId).slice(0, 8)}\n`)
    if (message.type === 'ready') {
      ready = true
      clearTimeout(timeout)
      process.stdout.write(`READY_URL=${message.url}\n`)
      process.stdout.write(`READY_INJECTIONS=${JSON.stringify(message.injections ?? [])}\n`)
    }
  })
  child.on('exit', (code, signal) => {
    process.stdout.write(`[host] exited code=${code} signal=${signal}\n`)
    process.exit(code ?? 0)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
