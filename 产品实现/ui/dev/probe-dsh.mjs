#!/usr/bin/env node
/**
 * Open the isolated DSH page, activate the workbench entry, and report what is really there.
 *
 * This is a diagnostic step in the C11 walkthrough: it prints the page's own labels, clicks the
 * sidebar entry, waits for the workbench root, records console problems and saves screenshots.
 *
 * Usage: node ui/dev/probe-dsh.mjs --url <authenticated url> --out <dir>
 *
 * @module ui/dev/probe-dsh
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newSessionFor, sleep } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

async function main() {
  const url = arg('url')
  if (!url) throw new Error('需要 --url（隔离实例的 READY_URL）')
  const out = path.resolve(arg('out', path.join(HERE, '_tmp-dsh', 'probe')))
  const { session, close } = await newSessionFor(url, { width: 1680, height: 1050 })
  try {
    await sleep(3500)
    const info = await session.evaluate(`(() => {
      const text = document.body.innerText.slice(0, 4000)
      const buttons = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], a'))
        .map((el) => ({
          text: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 30),
          title: el.getAttribute('title') || '',
          cls: String(el.className || '').slice(0, 40),
        }))
        .filter((row) => row.text.length > 0)
      return { text, buttons, hasAvw: document.querySelector('.avw-root') !== null }
    })()`)
    console.log('=== page text ===')
    console.log(info.text)
    console.log('=== buttons ===')
    for (const button of info.buttons) console.log(JSON.stringify(button))
    await session.screenshot(path.join(out, 'root.png'))

    if (!info.hasAvw) {
      const clicked = await session.evaluate(`(() => {
        const wanted = ['项目', '效果', '工具', '偏好']
        const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], a'))
        for (const node of nodes) {
          const text = (node.innerText || node.getAttribute('aria-label') || '').trim()
          if (wanted.includes(text)) {
            node.click()
            return text
          }
        }
        return null
      })()`)
      console.log(`clicked: ${clicked}`)
      await sleep(2000)
      const after = await session.evaluate(`(() => ({
        hasAvw: document.querySelector('.avw-root') !== null,
        bodyText: document.body.innerText.slice(0, 1200),
        stylePresent: document.querySelector('style[data-avw-style]') !== null,
      }))()`)
      console.log('=== after click ===')
      console.log(JSON.stringify(after, null, 2))
      await session.screenshot(path.join(out, 'after-click.png'))
    }

    const problems = session.consoleProblems()
    console.log(`=== console problems: ${problems.length} ===`)
    for (const problem of problems.slice(0, 20)) console.log(`${problem.kind}: ${problem.text}`)
    console.log(`screenshots: ${out}`)
  } finally {
    await close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
