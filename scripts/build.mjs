import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
rmSync('lib', { recursive: true, force: true })
mkdirSync('lib/host/worker', { recursive: true })
mkdirSync('lib/client', { recursive: true })
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' })
copyFileSync('src/host/worker/render-worker.mjs', 'lib/host/worker/render-worker.mjs')
const panel = 'src/client/panel.js'
if (!existsSync(panel)) throw new Error('missing ' + panel)
copyFileSync(panel, 'lib/client.js')
console.log('build ok: lib/host + lib/client.js')
