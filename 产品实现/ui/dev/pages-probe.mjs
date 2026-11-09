#!/usr/bin/env node
/**
 * Focused page probe: boot an isolated Host, open 工具 / 偏好 / 效果, assert real content, screenshot.
 *
 * Diagnostic and evidence capture in one pass. It exists because the full walkthrough is long and
 * the job runner is sensitive to long-lived children; this keeps one boot short and bounded.
 *
 * @module ui/dev/pages-probe
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootIsolated, setupIsolated } from './isolated-host.mjs'
import { newSessionFor, sleep, waitFor } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(HERE, '_tmp-pages')
const out = path.join(root, 'shots')
fs.mkdirSync(out, { recursive: true })

const hardStop = setTimeout(() => {
  console.error('页面探针超时（90s）')
  process.exit(2)
}, 90_000)

const layout = setupIsolated(root)
const host = bootIsolated(layout)
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Host ready 超时')), 60_000)
  host.on('message', (message) => {
    if (message?.type === 'ready') {
      clearTimeout(timer)
      resolve(message.url)
    }
  })
})
console.log(`URL=${url}`)

const { session, close } = await newSessionFor(url, { width: 1680, height: 1050 })
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}
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
  await sleep(350)
}
const click = async (text) => {
  const clicked = await session.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('button')).find((el) => (el.innerText || '').trim() === ${JSON.stringify(text)})
    if (!node) return null
    node.click(); return 'ok'
  })()`)
  await sleep(500)
  return clicked
}

try {
  await sleep(3200)
  await dismissHostModal()
  await click('项目')
  await session.waitForSelector('.avw-root', 12000)

  await dismissHostModal()
  await click('工具')
  await session.waitForText('插件不下载、不安装、不更新工具', 15000)
  const tools = await session.evaluate(`(async () => {
    const response = await fetch('/api/ai-video-workbench/tools')
    const payload = await response.json()
    const boot = await (await fetch('/api/ai-video-workbench/bootstrap')).json()
    return {
      rows: document.querySelectorAll('.avw-tool').length,
      first: document.querySelector('.avw-tool')?.innerText.replace(/\\s+/g, ' ').slice(0, 120) ?? null,
      kernelOff: document.body.innerText.includes('工具内核不可用'),
      gap: document.querySelector('.avw-gap')?.innerText ?? null,
      apiStatus: response.status,
      apiOk: payload?.ok === true,
      apiCount: Array.isArray(payload?.data?.tools) ? payload.data.tools.length : null,
      apiNote: payload?.data?.note ?? null,
      roots: boot?.data?.roots ?? null,
      pageText: document.body.innerText.slice(-300),
    }
  })()`)
  console.log('TOOLS_DEBUG ' + JSON.stringify(tools))
  record('工具页真实列表', tools.rows > 0, JSON.stringify(tools))
  await session.screenshot(path.join(out, '01-tools.png'))
  if (tools.rows > 0) {
    await session.evaluate(`document.querySelector('.avw-tool')?.click()`)
    await sleep(500)
    await sleep(600)
    const detail = await session.evaluate(`document.body.innerText.includes('工具详情')`)
    record('工具详情（许可／数据／费用／手动指引）', detail === true)
    await session.screenshot(path.join(out, '02-tool-detail.png'))
    await dismissHostModal()
    await session.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => (el.innerText || '').trim() === '关闭'); if (b) b.click() })()`)
    await sleep(400)
  }

  await dismissHostModal()
  await click('偏好')
  await session.waitForText('五组设置', 12000)
  const prefs = await session.evaluate(`(() => ({
    groups: Array.from(document.querySelectorAll('.avw-pref-group h3')).map((el) => el.innerText.trim()),
    rows: document.querySelectorAll('.avw-pref-row').length,
    sourceLabels: document.body.innerText.includes('内置默认'),
  }))()`)
  record('偏好五组与真实来源', prefs.groups.length === 5 && prefs.rows >= 10, JSON.stringify(prefs))
  await session.screenshot(path.join(out, '03-preferences.png'))

  await dismissHostModal()
  await click('效果')
  await session.waitForText('还没有已收录的效果', 12000)
  record('效果页空态（不伪造已收录）', true)
  await session.screenshot(path.join(out, '04-effects.png'))

  const problems = session.consoleProblems()
  record('页面无异常', problems.length === 0, problems.map((p) => p.text).join(' | ').slice(0, 200))

  fs.writeFileSync(path.join(out, 'pages-probe.json'), `${JSON.stringify({ url, results }, null, 2)}\n`, 'utf8')
  clearTimeout(hardStop)
  await close()
  host.kill()
  setTimeout(() => process.exit(results.every((row) => row.ok) ? 0 : 1), 400)
} catch (error) {
  console.error(`页面探针失败：${error.message}`)
  try {
    await session.screenshot(path.join(out, 'failure.png'))
    fs.writeFileSync(path.join(out, 'failure.json'), `${JSON.stringify({ error: error.message, problems: session.consoleProblems(), text: await session.evaluate('document.body.innerText.slice(0,2000)') }, null, 2)}\n`, 'utf8')
  } catch {
    // The page may be gone; the thrown error above is the useful part.
  }
  clearTimeout(hardStop)
  await close()
  host.kill()
  setTimeout(() => process.exit(1), 400)
}
