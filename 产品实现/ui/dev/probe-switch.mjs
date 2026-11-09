#!/usr/bin/env node
/**
 * Focused probe: why does the 工具 entry render a blank main area?
 *
 * Boots a throwaway Host, opens 项目 (known good), switches to 工具, then reports the main area's
 * real DOM state, window errors and console output. Diagnostic only.
 *
 * @module ui/dev/probe-switch
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootIsolated, setupIsolated } from './isolated-host.mjs'
import { newSessionFor, sleep } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(HERE, '_tmp-probe-switch')
const layout = setupIsolated(root)
const host = bootIsolated(layout)
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ready timeout')), 90_000)
  host.on('message', (message) => {
    if (message?.type === 'ready') {
      clearTimeout(timer)
      resolve(message.url)
    }
  })
})
process.stdout.write(`URL=${url}\n`)

const { session, close } = await newSessionFor(url, { width: 1680, height: 1050 })
try {
  await sleep(3500)
  await session.evaluate(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)));`)
  const click = async (text) => {
    const result = await session.evaluate(`(() => {
      const node = Array.from(document.querySelectorAll('button')).find((el) => (el.innerText || '').trim() === ${JSON.stringify(text)})
      if (!node) return null
      node.click(); return 'ok'
    })()`)
    await sleep(900)
    return result
  }
  console.log('project click:', await click('项目'))
  await sleep(1200)
  console.log('tools click:', await click('工具'))
  await sleep(1800)
  const info = await session.evaluate(`(() => {
    const roots = Array.from(document.querySelectorAll('.avw-root')).map((el) => ({
      display: getComputedStyle(el).display,
      visibility: getComputedStyle(el).visibility,
      width: el.offsetWidth,
      height: el.offsetHeight,
      textLength: (el.innerText || '').length,
      textHead: (el.innerText || '').slice(0, 160),
      parentClass: String(el.parentElement?.className || '').slice(0, 60),
      parentDisplay: el.parentElement ? getComputedStyle(el.parentElement).display : null,
      childCount: el.children.length,
    }))
    return {
      bodyText: document.body.innerText.slice(0, 900),
      roots,
      errors: window.__errs ?? [],
      activeSidebar: Array.from(document.querySelectorAll('.wtg9ga_panelRow')).filter((el) => /panelActi/.test(el.className)).map((el) => (el.innerText || '').trim()),
      mainHtmlLen: document.querySelector('.avw-root')?.outerHTML.length ?? 0,
      stylePresent: document.querySelector('style[data-avw-style]') !== null,
    }
  })()`)
  console.log(JSON.stringify(info, null, 2))
  const problems = session.consoleProblems()
  console.log('problems:', JSON.stringify(problems.slice(0, 10), null, 2))
  await session.screenshot(path.join(root, 'probe-switch.png'))
} finally {
  await close()
  host.kill()
  setTimeout(() => process.exit(0), 500)
}
