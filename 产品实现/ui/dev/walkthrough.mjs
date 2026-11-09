#!/usr/bin/env node
/**
 * C11 isolated walkthrough: drive the real Host through the real UI.
 *
 * Steps (C11 card §6): open → create project → add material → record use → select object →
 * reference to assistant → save position → switch to 作品 → reload and continue → narrow window →
 * tools/preferences/effects entries. Every assertion is against the live DOM of the isolated Host;
 * screenshots are written next to the report.
 *
 * Usage: node ui/dev/walkthrough.mjs --url <READY_URL> --out <dir>
 *
 * @module ui/dev/walkthrough
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newSessionFor, sleep, waitFor } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const steps = []
function record(step, ok, detail) {
  steps.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? ` · ${detail}` : ''}`)
  if (!ok) throw new Error(`步骤失败：${step} · ${detail ?? ''}`)
}

/** Click the first clickable whose trimmed text equals (or starts with) the wanted label. */
const CLICK_JS = (text, exact) => `(() => {
  const wanted = ${JSON.stringify(text)}
  const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], a, .avw-tool, .avw-material, .avw-row'))
  const match = nodes.find((el) => {
    const label = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ')
    return ${exact ? 'label === wanted' : 'label.includes(wanted)'}
  })
  if (!match) return null
  match.click()
  return (match.innerText || '').trim().slice(0, 40)
})()`

const SET_INPUT_JS = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'missing'
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus()
  return el.value
})()`

function tinyPngBase64() {
  // 16×16 PNG: a real image the browser can decode; used only as a material in the isolated home.
  return 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR42mNkYPhfz0AEYBxVSF+FjAwMDP8ZGBB4DBgYGP5TFQwAGYwMDAz/qQoGgAwGBgYGAC5bCQf9b4n1AAAAAElFTkSuQmCC'
}

async function main() {
  const url = arg('url')
  if (!url) throw new Error('需要 --url')
  const out = path.resolve(arg('out', path.join(HERE, '_tmp-dsh', 'walk')))
  const materialsDir = path.join(out, 'materials')
  fs.mkdirSync(materialsDir, { recursive: true })
  const textPath = path.join(materialsDir, '键帽结构说明.txt')
  const pngPath = path.join(materialsDir, '键帽微距.png')
  fs.writeFileSync(textPath, '定位板影响手感与声音传导；轴体段落结构带来段落感。\n', 'utf8')
  fs.writeFileSync(pngPath, Buffer.from(tinyPngBase64(), 'base64'))

  const { session, close } = await newSessionFor(url, { width: 1680, height: 1050 })
  const shot = async (name) => {
    const file = path.join(out, `${name}.png`)
    await session.screenshot(file)
    return file
  }
  /** Screenshots for evidence dismiss the Host's own account gate first (isolated profile has no account). */
  const cleanShot = async (name) => {
    await dismissHostModal()
    // A transient toast sits above the status bar; wait it out so evidence shows the real layout.
    await waitFor(async () => session.evaluate(`document.querySelector('.avw-toast') === null`), {
      timeoutMs: 6500,
      label: 'toast 消失',
    }).catch(() => null)
    return shot(name)
  }
  /** On failure, write the live DOM + console to disk so the next fix is based on facts. */
  const diagnose = async (label) => {
    const info = await session.evaluate(`(() => ({
      text: document.body.innerText.slice(0, 2500),
      avw: document.querySelector('.avw-root') !== null,
      routePanels: Array.from(document.querySelectorAll('.avw-root')).length,
      dialogs: Array.from(document.querySelectorAll('[role="dialog"], dialog')).map((d) => d.outerHTML.slice(0, 1500)),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({
        text: (b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 24),
        aria: b.getAttribute('aria-label') || '',
        cls: String(b.className || '').slice(0, 32),
      })).slice(0, 80),
    }))()`)
    fs.writeFileSync(path.join(out, `diagnose-${label}.json`), `${JSON.stringify({ info, problems: session.consoleProblems() }, null, 2)}\n`, 'utf8')
    await shot(`diagnose-${label}`).catch(() => null)
  }
  const click = async (text, exact = true) => {
    const clicked = await session.evaluate(CLICK_JS(text, exact))
    if (!clicked) throw new Error(`找不到可点击项：${text}`)
    await sleep(350)
    return clicked
  }
  /**
   * The isolated profile has no DeepSeek account, so the Host shows its own "开始使用" gate over
   * the main panel. Dismiss it so the workbench underneath can be inspected; this is a Host
   * condition of the isolated profile, not a workbench control.
   */
  const dismissHostModal = async () => {
    const clicked = await session.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('[role="dialog"] button, dialog button'))
      const close = nodes.find((el) => /关闭|close|取消/i.test(el.getAttribute('aria-label') || el.innerText || ''))
      if (close) { close.click(); return true }
      return false
    })()`)
    if (!clicked) {
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
    await sleep(400)
    return clicked
  }

  try {
    await session.send('DOM.enable')
    await sleep(3500)
    // Dismiss onboarding if it is present; its own button is part of the Host, not the workbench.
    await session.evaluate(CLICK_JS('继续', true)).catch(() => null)
    await sleep(400)

    await click('项目')
    await session.waitForSelector('.avw-root', 15000)
    record('四入口：项目面板打开', true)
    await cleanShot('01-home-empty')

    // ---------- create a real project ----------
    await click('新建项目', false)
    await session.waitForText('建立项目')
    await session.evaluate(SET_INPUT_JS('input[placeholder="项目名称（必填）"]', '45 秒机械键盘结构讲解片'))
    await session.evaluate(SET_INPUT_JS('textarea[aria-label="创作想法"]', '做一个 45 秒的机械键盘结构讲解片，冷静、克制，讲清定位板、轴体和消音结构。'))
    await click('建立项目', false)
    await waitFor(async () => session.evaluate(`document.body.innerText.includes('可编辑简报')`), { label: '项目创作面' })
    record('新建项目进入创作面', true)
    const metrics = await session.evaluate(`(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const box = element.getBoundingClientRect()
        return { x: Math.round(box.x), width: Math.round(box.width), height: Math.round(box.height) }
      }
      const root = document.querySelector('.avw-root')
      return {
        viewport: [window.innerWidth, window.innerHeight],
        mode: root?.dataset.mode,
        root: rect('.avw-root'),
        left: rect('.avw-col--left'),
        center: rect('.avw-col--center'),
        right: rect('.avw-col--right'),
        columns: document.querySelector('.avw-cols') ? getComputedStyle(document.querySelector('.avw-cols')).gridTemplateColumns : null,
        colsClass: document.querySelector('.avw-cols')?.className ?? null,
        rootStyle: root?.getAttribute('style') ?? null,
        leftDisplay: document.querySelector('.avw-col--left') ? getComputedStyle(document.querySelector('.avw-col--left')).display : null,
        rightDisplay: document.querySelector('.avw-col--right') ? getComputedStyle(document.querySelector('.avw-col--right')).display : null,
      }
    })()`)
    console.log('METRICS ' + JSON.stringify(metrics))
    await cleanShot('02-project-creation')

    // ---------- upload real materials ----------
    const root = await session.send('DOM.getDocument', { depth: -1 })
    const inputNode = await session.send('DOM.querySelector', {
      nodeId: root.root.nodeId,
      selector: '.avw-materials + div input[type="file"], input[type="file"]',
    })
    if (!inputNode.nodeId) throw new Error('找不到材料文件输入')
    await session.send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [textPath, pngPath] })
    await waitFor(async () => session.evaluate(`document.body.innerText.includes('键帽结构说明.txt')`), { label: '材料写入' })
    record('材料真实写入并显示', true, '2 个材料')
    await cleanShot('03-materials')

    // ---------- select a material, record its use ----------
    await click('键帽结构说明.txt', false)
    await session.waitForText('材料本体')
    record('材料对象选择与属性', true)
    await session.evaluate(SET_INPUT_JS('textarea[aria-label="材料用途说明"]', '只用在开头讲背景，不要裁切。'))
    await click('记录用途', false)
    await waitFor(async () => session.evaluate(`document.body.innerText.includes('记录于')`), { label: '用途记录' })
    record('自然语言用途记录', true)
    await cleanShot('04-material-use')

    // ---------- reference to the assistant ----------
    await click('助手')
    await waitFor(async () => session.evaluate(`document.querySelector('textarea[aria-label="发给项目助手的内容"]') !== null`), { label: '助手输入框' })
    await click('引用当前对象', false)
    const refs = await session.evaluate(`document.querySelectorAll('.avw-compose .avw-chip').length`)
    record('对象引用加入助手', refs > 0, `引用 ${refs} 条`)
    await session.evaluate(SET_INPUT_JS('textarea[aria-label="发给项目助手的内容"]', '开头用这个材料的说明，标题不要动。'))
    await click('保存到项目', false)
    await waitFor(async () => session.evaluate(`document.body.innerText.includes('已保存，等待制作编排接入')`), { label: '助手消息保存' })
    record('助手消息真实保存（不假装已回答）', true)
    const compose = await session.evaluate(`(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const box = element.getBoundingClientRect()
        return { x: Math.round(box.x), w: Math.round(box.width), right: Math.round(box.right), scroll: element.scrollWidth, client: element.clientWidth }
      }
      const buttons = Array.from(document.querySelectorAll('.avw-compose-bar .avw-btn')).map((el) => {
        const box = el.getBoundingClientRect()
        return { text: el.innerText.trim().slice(0, 12), x: Math.round(box.x), w: Math.round(box.width), right: Math.round(box.right) }
      })
      return {
        col: rect('.avw-col--right'),
        drawer: rect('.avw-drawer'),
        compose: rect('.avw-compose'),
        bar: rect('.avw-compose-bar'),
        textarea: rect('.avw-compose textarea'),
        buttons,
        viewport: window.innerWidth,
      }
    })()`)
    console.log('COMPOSE ' + JSON.stringify(compose))
    await cleanShot('05-assistant')

    // ---------- work surface: honest empty composition ----------
    await click('作品')
    await session.waitForText('尚无合成画面')
    const workState = await session.evaluate(`(() => ({
      canvasEmpty: document.querySelector('.avw-canvas-empty') !== null,
      hasTimelineEmpty: document.body.innerText.includes('还没有可编辑的时间线'),
      selected: document.body.innerText.includes('键帽结构说明.txt'),
      fakeTracks: document.querySelectorAll('.avw-track').length,
    }))()`)
    record('作品面无合成计划时不画假轨道', workState.canvasEmpty && workState.hasTimelineEmpty && workState.fakeTracks === 0)
    record('结构树保留真实材料选择', workState.selected)
    await cleanShot('06-work-empty')

    // ---------- save position and continue after reload ----------
    await sleep(1200)
    await session.goto(url)
    await sleep(3000)
    await session.evaluate(CLICK_JS('继续', true)).catch(() => null)
    await click('项目')
    await session.waitForSelector('.avw-root', 15000)
    await waitFor(async () => session.evaluate(`document.body.innerText.includes('45 秒机械键盘结构讲解片')`), { label: '项目出现在最近列表' })
    await click('45 秒机械键盘结构讲解片', false)
    await waitFor(async () => session.evaluate(`document.body.innerText.includes('尚无合成画面') || document.body.innerText.includes('可编辑简报')`), { label: '重新打开项目' })
    const restored = await session.evaluate(`(() => ({
      surfaceWork: document.querySelector('.avw-tabs-surface button[aria-selected="true"]')?.innerText.trim() === '作品',
      selectedMaterial: document.body.innerText.includes('键帽结构说明.txt'),
      saved: document.body.innerText.includes('已自动保存') || document.body.innerText.includes('已保存'),
    }))()`)
    record('重新打开回到上次工作面', restored.surfaceWork === true, JSON.stringify(restored))
    record('重新打开恢复选中对象', restored.selectedMaterial === true)
    await cleanShot('07-continue-after-reload')

    // ---------- narrow window ----------
    await session.setViewport(900, 800)
    await sleep(600)
    const narrow = await session.evaluate(`(() => ({
      mode: document.querySelector('.avw-root')?.dataset.mode,
      hasStructureButton: Array.from(document.querySelectorAll('button')).some((b) => b.innerText.trim() === '结构'),
    }))()`)
    record('窄窗口进入 narrow 模式并保留结构入口', narrow.mode === 'narrow' && narrow.hasStructureButton, JSON.stringify(narrow))
    await click('结构')
    await sleep(400)
    const drawer = await session.evaluate(`document.querySelector('.avw-drawer-left') !== null`)
    record('窄窗口结构抽屉可打开', drawer)
    await cleanShot('08-narrow-drawer')
    await session.setViewport(1680, 1050)
    await sleep(400)

    // ---------- other three entries ----------
    try {
      await dismissHostModal()
      await click('工具')
      await session.waitForText('插件不下载、不安装、不更新工具')
    } catch (error) {
      await diagnose('tools')
      throw error
    }
    await cleanShot('09-tools')
    const toolCount = await session.evaluate(`document.querySelectorAll('.avw-tool').length`)
    record('工具页读取 C06 真实状态', toolCount >= 1, `${toolCount} 项`)
    await click('FFmpeg', false).catch(() => null)
    await sleep(500)
    const detail = await session.evaluate(`document.body.innerText.includes('工具详情') || document.body.innerText.includes('手动指引')`)
    await shot('10-tool-detail')
    await session.evaluate(CLICK_JS('关闭', true)).catch(() => null)
    record('工具详情显示许可与手动指引', detail)

    await dismissHostModal()
    await click('偏好')
    await session.waitForText('五组设置')
    const groups = await session.evaluate(`Array.from(document.querySelectorAll('.avw-pref-group h3')).map((el) => el.innerText.trim())`)
    record('偏好仅五组', groups.length === 5, groups.join(' / '))
    await cleanShot('11-preferences')

    await dismissHostModal()
    await click('效果')
    await session.waitForText('还没有已收录的效果')
    record('效果页不伪造已收录效果', true)
    await cleanShot('12-effects')

    await dismissHostModal()
    await click('项目')
    await session.waitForSelector('.avw-root')
    await cleanShot('13-back-to-project')

    const problems = session.consoleProblems()
    record('页面无未捕获异常/console.error', problems.length === 0, problems.map((p) => p.text).join(' | ').slice(0, 300))

    fs.writeFileSync(path.join(out, 'walkthrough.json'), `${JSON.stringify({ url, steps, screenshots: fs.readdirSync(out).filter((name) => name.endsWith('.png')) }, null, 2)}\n`, 'utf8')
    console.log(`\nwalkthrough complete → ${out}`)
  } finally {
    await close()
  }
}

main().catch(async (error) => {
  console.error(error)
  process.exit(1)
})
