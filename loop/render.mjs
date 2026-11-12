#!/usr/bin/env node
/**
 * 最小渲染器 —— 一个可 seek 的 Web 场景 → 帧序列 → MP4 + 接触表 + 实测规格。
 *
 * 这个文件是整个方案的"代码那一半"，只做四件模型做不了的事：
 *   1. 把时间注入场景（而不是让浏览器自己播放）
 *   2. 逐帧取像素
 *   3. 按真实帧率编码
 *   4. 读回真实规格，并出一张接触表给模型看
 *
 * 创作那一半在模型手里：它写场景、它看图、它改。
 *
 * 用法：
 *   node render.mjs --scene <html> [--out out.mp4] [--duration 5] [--fps 30]
 *                   [--width 1280] [--height 720] [--keep-frames]
 *
 * 场景协议（任选其一，自动探测）：
 *   window.__seek(t)              外部按秒定位（gongnyang 卡用的就是这个）
 *   window.__YOI__.setTime(t)     花园.html
 *   window.__UMI__                海滩3渲2.html（无 setTime，走时钟注入）
 *   （都没有）                     走时钟注入：覆写 performance.now + rAF
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

// ───────────────────────── 参数 ─────────────────────────

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) o[k] = true
    else { o[k] = v; i++ }
  }
  return o
}

const a = parseArgs(process.argv.slice(2))
if (!a.scene) {
  console.error('用法: node render.mjs --scene <html> [--out out.mp4] [--duration 5] [--fps 30]')
  process.exit(2)
}

const SCENE = path.resolve(a.scene)
const FPS = Number(a.fps ?? 30)
const DURATION = Number(a.duration ?? 5)
const WIDTH = Number(a.width ?? 1280)
const HEIGHT = Number(a.height ?? 720)
const FRAMES = Math.round(FPS * DURATION)
const OUTDIR = a.out ? path.dirname(path.resolve(a.out)) : path.dirname(SCENE)
const BASE = path.basename(a.out ?? 'out.mp4', '.mp4')
const OUTMP4 = path.resolve(a.out ?? path.join(OUTDIR, `${BASE}.mp4`))
const FRAMEDIR = path.join(OUTDIR, `${BASE}.frames`)
const CONTACT = path.join(OUTDIR, `${BASE}.contact.png`)
const PROBE = path.join(OUTDIR, `${BASE}.probe.json`)

// ───────────────────────── Chrome ─────────────────────────

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

async function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { await fs.access(p); return p } catch {}
  }
  throw new Error('找不到 Chrome / Edge')
}

const PORT = 9400 + Math.floor(Math.random() * 400)

/** 注入时钟接管脚本（页面加载前执行）。让 rAF 循环可被外部推进。 */
const CLOCK_PATCH = `
(() => {
  let t = 0;
  const q = [];
  const realRAF = window.requestAnimationFrame.bind(window);
  Object.defineProperty(performance, 'now', { configurable: true, value: () => t });
  window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  window.cancelAnimationFrame = () => {};
  window.__pump = (frames) => {
    for (let i = 0; i < frames; i++) {
      t += 1000 / 60;
      const batch = q.splice(0, q.length);
      for (const cb of batch) { try { cb(t) } catch (e) {} }
    }
    return t;
  };
  window.__setClock = (sec) => { t = sec * 1000; };
})();
`

async function launchChrome() {
  const exe = await findChrome()
  const profile = path.join(process.env.TEMP ?? '/tmp', `loop-chrome-${PORT}`)
  const child = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=1',
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: 'ignore' })

  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return child
    } catch {}
    await sleep(120)
  }
  child.kill()
  throw new Error('Chrome 启动超时')
}

// ───────────────────────── CDP ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有可用页面')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  const send = (method, params = {}) => {
    const my = ++id
    return new Promise((res, rej) => {
      pending.set(my, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)))
      ws.send(JSON.stringify({ id: my, method, params }))
    })
  }
  return { ws, send }
}

async function evaluate(send, expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true,
  })
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)
    throw new Error(d)
  }
  return r.result.value
}

// ───────────────────────── 场景协议探测 ─────────────────────────

/** 探测场景怎么被驱动。返回 'seek' | 'yoi' | 'clock' */
async function detectMode(send) {
  for (let i = 0; i < 200; i++) {
    const st = await evaluate(send, `({
      ready: !!window.__ready,
      seek: typeof window.__seek,
      yoi: typeof (window.__YOI__ && window.__YOI__.setTime),
      umi: typeof window.__UMI__,
      pump: typeof window.__pump,
    })`, false)
    if (!st) { await sleep(50); continue }
    if (st.seek === 'function') return { mode: 'seek', st }
    if (st.yoi === 'function') return { mode: 'yoi', st }
    if (st.pump === 'function') return { mode: 'clock', st }
    if (st.ready === true && i > 40) return { mode: 'none', st }
    await sleep(50)
  }
  return { mode: 'none', st: null }
}

async function seekTo(send, mode, frame) {
  const t = frame / FPS
  if (mode === 'seek') await evaluate(send, `window.__seek(${t})`, false)
  else if (mode === 'yoi') await evaluate(send, `window.__YOI__.setTime(${t})`, false)
  else if (mode === 'clock') {
    // 时钟注入：重置到 0，再推进到目标帧（模拟状态不可回卷时，只能顺序推进）
    await evaluate(send, `window.__pump(1)`, false)
  }
  // 等两帧绘制
  await sleep(16)
}

// ───────────────────────── 取帧 ─────────────────────────

async function captureFrame(send, file) {
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
    captureBeyondViewport: false,
  })
  const buf = Buffer.from(shot.data, 'base64')
  await fs.writeFile(file, buf)
  return buf
}

// ───────────────────────── ffmpeg ─────────────────────────

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exit ${code}\n${err.slice(-2000)}`))))
  })
}

// ───────────────────────── 主流程 ─────────────────────────

const t0 = Date.now()
let chrome, ws
try {
  await fs.mkdir(FRAMEDIR, { recursive: true })
  for (const f of await fs.readdir(FRAMEDIR)) await fs.unlink(path.join(FRAMEDIR, f))

  chrome = await launchChrome()
  const conn = await connect()
  ws = conn.ws
  const { send } = conn

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  })
  // 时钟接管先于页面脚本
  await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_PATCH })

  const url = 'file:///' + SCENE.replace(/\\/g, '/') + '?render=1&embed=1&freeze=1'
  await send('Page.navigate', { url })
  await sleep(1500)

  let { mode } = await detectMode(send)
  if (mode === 'none') {
    // 保底：用 clock 模式强推
    const hasPump = await evaluate(send, `typeof window.__pump`, false)
    mode = hasPump === 'function' ? 'clock' : 'none'
  }
  if (mode === 'none') throw new Error('场景没有可用的时间注入接口（__seek / __YOI__.setTime / __pump 都没有）')

  // 时钟模式：先归零，顺序推进
  if (mode === 'clock') {
    for (let f = 0; f < FRAMES; f++) {
      await evaluate(send, `window.__pump(1)`, false)
      await sleep(8)
      await captureFrame(send, path.join(FRAMEDIR, `${String(f).padStart(6, '0')}.png`))
      if ((f + 1) % 30 === 0) process.stderr.write(`  帧 ${f + 1}/${FRAMES}\n`)
    }
  } else {
    for (let f = 0; f < FRAMES; f++) {
      await seekTo(send, mode, f)
      await captureFrame(send, path.join(FRAMEDIR, `${String(f).padStart(6, '0')}.png`))
      if ((f + 1) % 30 === 0) process.stderr.write(`  帧 ${f + 1}/${FRAMES}\n`)
    }
  }

  // 编码
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-framerate', String(FPS),
    '-i', path.join(FRAMEDIR, '%06d.png'),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    OUTMP4,
  ])

  // 接触表：每秒 2 帧，5 列
  const tileCols = 5
  const rows = Math.max(1, Math.ceil((DURATION * 2) / tileCols))
  await run('ffmpeg', [
    '-y', '-v', 'error', '-i', OUTMP4,
    '-vf', `fps=2,scale=320:-1,tile=${tileCols}x${rows}:padding=4:margin=4`,
    '-frames:v', '1', CONTACT,
  ])

  // 实测
  const prob = await run('ffprobe', [
    '-v', 'error', '-show_entries',
    'stream=codec_name,width,height,r_frame_rate,nb_frames,duration',
    '-show_entries', 'format=duration,size',
    '-of', 'json', OUTMP4,
  ])
  const probed = JSON.parse(prob.out)
  const bytes = (await fs.stat(OUTMP4)).size
  const sha = crypto.createHash('sha256').update(await fs.readFile(OUTMP4)).digest('hex')
  const vs = probed.streams.find((s) => s.width)

  const report = {
    scene: SCENE,
    mode,
    requested: { fps: FPS, duration: DURATION, frames: FRAMES, width: WIDTH, height: HEIGHT },
    probed: {
      codec: vs?.codec_name, width: vs?.width, height: vs?.height,
      rFrameRate: vs?.r_frame_rate, nbFrames: vs?.nb_frames,
      durationSec: probed.format?.duration,
    },
    bytes,
    sha256: sha,
    contactSheet: CONTACT,
    framesDir: a['keep-frames'] ? FRAMEDIR : null,
    elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
  }
  await fs.writeFile(PROBE, JSON.stringify(report, null, 2), 'utf8')

  const framesOk = String(vs?.nb_frames) === String(FRAMES)
  console.log(JSON.stringify({ ...report, framesOk }, null, 2))

  if (!a['keep-frames']) await fs.rm(FRAMEDIR, { recursive: true, force: true })
} catch (e) {
  console.error('RENDER FAILED:', e.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  try { chrome?.kill() } catch {}
}
