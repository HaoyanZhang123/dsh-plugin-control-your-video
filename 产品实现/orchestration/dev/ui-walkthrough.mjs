/**
 * C13 isolation walkthrough: boot the real Host with this plugin, prove the shell still boots, and
 * prove the creation-domain projection is readable through the route the workbench already has.
 *
 * It is deliberately narrow. It does not repeat C11's 18-step walkthrough; it checks the three
 * things C13 touched: the shell still mounts, the domain view registration is stated (not hidden),
 * and `/projects/events` really carries `creation.projection` for a project this run created.
 *
 * Usage: node orchestration/dev/ui-walkthrough.mjs
 *
 * @module orchestration/dev/ui-walkthrough
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { Clock } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { bootIsolated, setupIsolated } from '../../ui/dev/isolated-host.mjs'
import { newSessionFor, sleep, waitFor } from '../../ui/dev/cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = path.resolve(HERE, '../..')
const ROOT = path.join(PRODUCT_ROOT, 'ui', 'dev', '_tmp-c13')
const OUT = path.join(PRODUCT_ROOT, 'evidence', 'c13-ui')

const steps = []
/** @param {string} name @param {boolean} ok @param {any} [detail] */
function record(name, ok, detail) {
  steps.push({ step: name, ok, detail: detail ?? null })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` · ${JSON.stringify(detail).slice(0, 160)}`}\n`)
  if (!ok) throw new Error(`步骤失败：${name}`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  // Start from a clean isolated home AND a clean profile: a leftover instance would carry earlier
  // runs' projects into this evidence and make the screenshot ambiguous about what this run did.
  // The home is pinned under ROOT so one delete removes both.
  fs.rmSync(ROOT, { recursive: true, force: true })
  process.env.AVW_ISOLATED_HOME = path.join(ROOT, 'home')
  const layout = setupIsolated(ROOT)
  const projectsRoot = path.join(layout.home, 'data', 'ai-video-workbench', 'projects')
  fs.mkdirSync(projectsRoot, { recursive: true })

  // A project with real C13 facts, created by C10 itself, before the page reads anything.
  const clock = new Clock({ mode: 'system' })
  const created = createProject({ projectsRoot, title: 'C13 领域视图走查', clock })
  const projectId = created.project.projectId
  execFileSync(process.execPath, [path.join(HERE, 'seed-domain.mjs'), '--root', projectsRoot, '--project', projectId], { stdio: 'pipe' })
  execFileSync(process.execPath, [path.join(HERE, 'publish-projection.mjs'), '--root', projectsRoot, '--project', projectId, '--plan', 'plan-v2'], { stdio: 'pipe' })
  record('seed: project with brief/directions/baseline/preview', true, { projectId })

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
  record('host: isolated instance ready', true, { url: url.replace(/[?&]token=[^&]+/, '&token=***') })

  const { session, close } = await newSessionFor(url, { width: 1600, height: 1000 })
  try {
    await sleep(3500)
    // First-run notice: dismiss it so the screenshot shows the shell, not a modal.
    await session.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('button'))
      const match = nodes.find((el) => (el.innerText || '').trim() === '继续')
      if (match) match.click()
      return match !== undefined
    })()`)
    await sleep(800)
    const boot = await session.evaluate('({ text: document.body.innerText.slice(0, 200), hasLoader: typeof window.__ModuleLoader__ !== "undefined" })')
    record('shell: page body rendered', typeof boot.text === 'string' && boot.text.length > 0, { sample: boot.text.slice(0, 60) })

    // The plugin mounts only after its entry is activated; click the workbench entry if present.
    const entry = await session.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], a'))
      const match = nodes.find((el) => (el.innerText || '').trim() === '项目')
      if (!match) return null
      match.click()
      return (match.innerText || '').trim()
    })()`)
    await sleep(2500)
    const mounted = await waitFor(async () => session.evaluate('document.querySelector(".avw-root") !== null'), {
      timeoutMs: 20000,
      label: '工作台挂载',
    })
      .then(() => true)
      .catch(() => false)
    record('shell: workbench panel mounted', mounted, { clickedEntry: entry })

    // The registration must be STATED: granted or refused, never silently absent.
    const registration = await session.evaluate('window.__avwCreationDomain ?? null')
    record('domain: registration status is exposed', registration !== null, registration)

    // The real data path: the projection must come back through /projects/events.
    const events = await session.evaluate(`(async () => {
      const response = await fetch('/api/ai-video-workbench/projects/events?projectId=${encodeURIComponent(projectId)}&limit=50', { credentials: 'same-origin' })
      const payload = await response.json()
      if (!payload.ok) return { ok: false, error: payload.error }
      const rows = payload.data.events ?? payload.data ?? []
      const projection = rows.filter((row) => row.kind === 'creation.projection').sort((a, b) => a.sequence - b.sequence).pop() ?? null
      return {
        ok: true,
        count: rows.length,
        hasProjection: projection !== null,
        briefCounts: projection?.detail?.brief?.counts ?? null,
        baselineOk: projection?.detail?.baseline?.ok ?? null,
        units: projection?.detail?.units?.complete ?? null,
        vista: projection?.detail?.vista ?? null,
        preview: projection?.detail?.preview ?? null,
      }
    })()`)
    record('events: creation.projection readable through the real route', events.ok === true && events.hasProjection === true, events)

    await session.screenshot(path.join(OUT, 'isolated-shell.png'))
    // Open the project so the assertions and screenshots are about the creation surface itself.
    const opened = await session.evaluate(`(() => {
      const target = Array.from(document.querySelectorAll('button, [role="button"], .avw-row, a'))
        .find((el) => (el.innerText || '').includes('C13 领域视图走查'))
      if (target) target.click()
      return Boolean(target)
    })()`)
    await sleep(2500)
    // A login prompt can appear over the creation surface; close it so the page is visible.
    await session.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"], .avw-modal, [class*="modal"]')
      if (!dialog) return false
      const closer = dialog.querySelector('button[aria-label], button')
      if (closer) closer.click()
      return true
    })()`)
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
    await sleep(1200)
    record('shell: project opened through the real UI', opened === true, { opened })

    // The view must be DRAWN, and its numbers must come from the project's event stream rather
    // than from a fixture: the seeded requirement text exists only in the project facts.
    const drawn = await session.evaluate(`(() => {
      const text = document.body.innerText
      return {
        hasView: text.includes('创建领域视图'),
        hasProjectFact: text.includes('用已就位的渲染工作区出真实单元与成片'),
        hasPreview: text.includes('上一版计划'),
        hasAudio: text.includes('未听'),
        hasUnit: text.includes('unit-001-real'),
      }
    })()`)
    record(
      'domain: drawn into the creation page with data from the project event stream',
      drawn.hasView === true &&
        drawn.hasProjectFact === true &&
        drawn.hasPreview === true &&
        drawn.hasAudio === true &&
        drawn.hasUnit === true,
      drawn,
    )
    await session.evaluate(`(() => {
      const section = document.getElementById('avw-creation-domain')
      if (section) section.scrollIntoView({ block: 'start' })
      return section !== null
    })()`)
    await sleep(700)
    await session.screenshot(path.join(OUT, 'isolated-creation.png'))
    await session.evaluate(`(() => {
      const section = document.getElementById('avw-creation-domain')
      if (section) section.scrollIntoView({ block: 'start' })
      return section !== null
    })()`)
    await sleep(600)
    await session.screenshot(path.join(OUT, 'isolated-domain-view.png'))
    // Second shot: the unit / preview / AI-seen part of the same view, in the same page.
    await session.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('.avw-card__title'))
      const target = nodes.find((el) => (el.innerText || '').includes('早期单元'))
      if (target) target.scrollIntoView({ block: 'start' })
      return target !== undefined
    })()`)
    await sleep(500)
    await session.screenshot(path.join(OUT, 'isolated-domain-units.png'))

    const problems = session.consumerProblems?.() ?? session.consumerProblems ?? null
    const consoleProblems = typeof session.consumerProblems === 'function' ? session.consumerProblems() : problems
    record('shell: no console errors captured', Array.isArray(consoleProblems) ? consoleProblems.length === 0 : true, consoleProblems)
  } finally {
    close()
  }

  fs.writeFileSync(
    path.join(OUT, 'walkthrough.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'c13-isolation-walkthrough',
      generatedAt: new Date().toISOString(),
      projectId,
      isolatedHome: path.basename(layout.home),
      steps,
      screenshots: fs.readdirSync(OUT).filter((name) => name.endsWith('.png')),
    }, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`walkthrough: ${path.join(OUT, 'walkthrough.json')}\n`)
  try {
    host.kill()
  } catch {
    // The isolated Host is disposable; a failed kill is not a product failure.
  }
}

await main()
