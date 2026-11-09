#!/usr/bin/env node
/**
 * One-shot isolated verification run: boot a throwaway Host, walk the real UI, tear the Host down.
 *
 * Splitting boot and walk into two shell calls proved fragile (the managed job runner sometimes
 * waits on a still-running Host), so this script owns the whole lifecycle and reports one exit code.
 *
 * Usage: node ui/dev/isolated-walk.mjs --root ui/dev/_tmp-dshN [--out <dir>]
 *
 * @module ui/dev/isolated-walk
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootIsolated, setupIsolated } from './isolated-host.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const root = path.resolve(arg('root', path.join(HERE, '_tmp-dsh-walk')))
const out = path.resolve(arg('out', path.join(root, 'walk')))
const layout = setupIsolated(root)
process.stdout.write(`isolated root: ${layout.root}\nprofile: ${layout.profile}\n`)

const host = bootIsolated(layout)
let url = null
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Host 在 90 秒内没有报告 ready')), 90_000)
  host.on('message', (message) => {
    if (message?.type === 'ready') {
      clearTimeout(timer)
      resolve(message.url)
    }
  })
  host.on('exit', (code) => {
    if (url === null) reject(new Error(`Host 提前退出 code=${code}`))
  })
})
url = await ready
process.stdout.write(`READY_URL=${url}\n`)

const walker = spawn(process.execPath, [path.join(HERE, 'walkthrough.mjs'), '--url', url, '--out', out], {
  stdio: 'inherit',
  cwd: path.dirname(HERE),
})
const code = await new Promise((resolve) => walker.on('exit', (exitCode) => resolve(exitCode ?? 1)))

host.kill()
setTimeout(() => process.exit(code), 300)
