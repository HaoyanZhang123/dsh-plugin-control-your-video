#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol driver (no dependencies).
 *
 * Why this exists: verifying a real Host needs a real page — click the sidebar entries, read the
 * DOM, resize the window, press keys, take screenshots. `chrome --screenshot` cannot do that, and
 * the DSH page keeps a websocket open, so waiting for a load event is not enough.
 *
 * Node 24 provides a global WebSocket, so the whole driver is ~120 lines.
 *
 * @module ui/dev/cdp
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 250, label = 'condition' } = {}) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label} 超时${lastError ? `：${lastError.message}` : ''}`)
}

async function fetchJson(url, options) {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  return response.json()
}

/** Launch a headless Chrome and return a CDP session for its first page. */
export async function launchChrome(options = {}) {
  const port = options.port ?? 9333
  const userDataDir = options.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'avw-cdp-'))
  fs.mkdirSync(userDataDir, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--force-device-scale-factor=1',
    `--window-size=${options.width ?? 1680},${options.height ?? 1050}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' })

  await waitFor(async () => {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`)
      return true
    } catch {
      return false
    }
  }, { label: 'Chrome 调试端口' })

  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`)
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('Chrome 没有可用的页面目标')
  const session = new CDPSession(page.webSocketDebuggerUrl)
  await session.connect()
  return { chrome, session, port, userDataDir }
}

export class CDPSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.listeners = new Map()
  }

  async connect() {
    this.socket = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
        else entry.resolve(message.result)
        return
      }
      this.events.push(message)
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
    })
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(listener)
    return () => this.listeners.get(method)?.delete(listener)
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`页面脚本异常：${text}`)
    }
    return result.result?.value
  }

  async waitForSelector(selector, timeoutMs = 20000) {
    return waitFor(async () => this.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`), {
      timeoutMs,
      label: `选择器 ${selector}`,
    })
  }

  async waitForText(text, timeoutMs = 20000) {
    return waitFor(async () => this.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), {
      timeoutMs,
      label: `文本「${text}」`,
    })
  }

  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })
  }

  async goto(url) {
    await this.send('Page.navigate', { url })
    return waitFor(async () => {
      const state = await this.evaluate('document.readyState')
      return state === 'complete' || state === 'interactive'
    }, { label: '页面加载' })
  }

  consoleProblems() {
    const problems = []
    for (const event of this.events) {
      if (event.method === 'Runtime.exceptionThrown') {
        problems.push({ kind: 'exception', text: String(event.params.exceptionDetails?.text ?? '') })
      }
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        problems.push({ kind: 'console.error', text: (event.params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' ') })
      }
      if (event.method === 'Log.entryAdded' && event.params.entry?.level === 'error') {
        problems.push({ kind: 'log.error', text: String(event.params.entry.text ?? '') })
      }
    }
    return problems
  }

  close() {
    try {
      this.socket?.close()
    } catch {
      // The page may already be gone; nothing to clean up.
    }
  }
}

export async function newSessionFor(url, options = {}) {
  const { chrome, session, port } = await launchChrome(options)
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Log.enable')
  await session.goto(url)
  return {
    chrome,
    session,
    port,
    async close() {
      session.close()
      chrome.kill()
    },
  }
}
