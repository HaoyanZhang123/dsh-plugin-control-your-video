#!/usr/bin/env node
/**
 * Dark-theme probe: the Host decides light/dark, so force `prefers-color-scheme: dark` in the page
 * and confirm the workbench follows `body[data-ds-dark-theme]` with real screenshots.
 *
 * @module ui/dev/theme-probe
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootIsolated, setupIsolated } from './isolated-host.mjs'
import { launchChrome, sleep, waitFor } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(HERE, '_tmp-theme')
const out = path.join(root, 'shots')
fs.mkdirSync(out, { recursive: true })

const layout = setupIsolated(root)
const host = bootIsolated(layout)
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ready timeout')), 60_000)
  host.on('message', (message) => {
    if (message?.type === 'ready') {
      clearTimeout(timer)
      resolve(message.url)
    }
  })
})

const { chrome, session } = await launchChrome({ width: 1680, height: 1050 })
try {
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  })
  await session.goto(url)
  await sleep(3500)
  const dismiss = async () => {
    await session.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const cont = buttons.find((el) => (el.innerText || '').trim() === '继续')
      if (cont) { cont.click(); return 'continue' }
      const close = buttons.find((el) => /关闭|close|取消/i.test(el.getAttribute('aria-label') || el.innerText || ''))
      if (close) { close.click(); return 'close' }
      return false
    })()`)
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(300)
  }
  await dismiss()
  await session.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => (el.innerText || '').trim() === '项目'); b?.click() })()`)
  await session.waitForSelector('.avw-root', 12000)
  const dark = await session.evaluate(`(() => ({
    hostDark: document.body.hasAttribute('data-ds-dark-theme'),
    rootColor: getComputedStyle(document.querySelector('.avw-root')).colorScheme,
    bg: getComputedStyle(document.querySelector('.avw-root')).backgroundColor,
  }))()`)
  console.log(`DARK ${JSON.stringify(dark)}`)
  await session.screenshot(path.join(out, '01-dark-home.png'))

  // Create a project quickly so the work surface can be shown in dark as well.
  await session.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => (el.innerText || '').trim() === '新建项目'); b?.click() })()`)
  await sleep(500)
  await session.evaluate(`(() => {
    const input = document.querySelector('input[placeholder="项目名称（必填）"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '深色验证项目')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await session.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => (el.innerText || '').trim() === '建立项目'); b?.click() })()`)
  await waitFor(async () => session.evaluate(`document.body.innerText.includes('可编辑简报')`), { label: '项目创作面' })
  await dismiss()
  await session.screenshot(path.join(out, '02-dark-creation.png'))
  await session.evaluate(`(() => { const b = Array.from(document.querySelectorAll('.avw-tabs-surface button')).find((el) => el.innerText.trim() === '作品'); b?.click() })()`)
  await sleep(700)
  await session.screenshot(path.join(out, '03-dark-work.png'))
  console.log('theme probe complete')
} finally {
  session.close()
  chrome.kill()
  host.kill()
  setTimeout(() => process.exit(0), 400)
}
