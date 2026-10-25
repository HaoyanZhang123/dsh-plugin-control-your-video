import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist/host/worker', { recursive: true })
mkdirSync('dist/client', { recursive: true })
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' })
copyFileSync('src/host/worker/render-worker.mjs', 'dist/host/worker/render-worker.mjs')
copyFileSync('cordis.patch.yml', 'dist/cordis.patch.yml')
const panel = 'src/client/panel.js'
if (!existsSync(panel)) throw new Error('missing ' + panel)
copyFileSync(panel, 'dist/client/panel.js')
console.log('build ok: dist/host + dist/client')