// Render worker: deterministic frame capture of a local HTML scene (headless Chrome seek + FFmpeg).
// Adapted from the PoC-003 local adapter; no upstream toolchain is copied or required.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cfg = JSON.parse(process.argv[2] ?? '{}')
const { html, browser, ffmpeg, out, start = 0, duration = 4, fps = 30, work } = cfg
if (!html || !browser || !ffmpeg || !out) { console.error('missing args'); process.exit(2) }
const framesDir = path.join(work, 'frames')
rmSync(framesDir, { recursive: true, force: true })
mkdirSync(framesDir, { recursive: true })

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const port = await freePort()
const profile = path.join(work, 'browser-profile')
mkdirSync(profile, { recursive: true })
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=1920,1080', '--force-device-scale-factor=1', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, pathToFileURL(html).href], { stdio: 'ignore', windowsHide: true })

const waitVersion = async () => {
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 250))
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) return await r.json() } catch { /* retry */ }
  }
  throw new Error('cdp not reachable')
}
const ver = await waitVersion()
const ws = new WebSocket(ver.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
let id = 1
const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } })
const raw = (method, params, sessionId) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })) })
const { targetId } = await raw('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true })
const send = (m, p) => raw(m, p, sessionId)
await send('Page.enable', {})
await send('Runtime.enable', {})
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: pathToFileURL(html).href })
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('evaluate failed'); return r.result.value }
let ready = false
for (let i = 0; i < 100; i += 1) { await new Promise((r) => setTimeout(r, 200)); ready = await evalJs('typeof tl !== "undefined" && tl && typeof tl.seek === "function"').catch(() => false); if (ready) break }
if (!ready) throw new Error('timeline (tl) not found in the scene')
const frames = Math.round(duration * fps)
for (let i = 0; i < frames; i += 1) {
  const t = start + i / fps
  await evalJs('tl.seek(' + t.toFixed(4) + '); true')
  await new Promise((r) => setTimeout(r, 45))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(framesDir, String(i).padStart(5, '0') + '.png'), Buffer.from(shot.data, 'base64'))
}
await raw('Browser.close', {}).catch(() => {})
try { child.kill('SIGKILL') } catch { /* ignore */ }
mkd: {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(framesDir, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(3)
}
console.log('rendered ' + frames + ' frames → ' + out)
