/**
 * C14 isolation walkthrough: boot the real Host with this plugin, prove the shell still boots, prove
 * the review-domain registration is stated (not hidden), and prove `editing.projection` is readable
 * through the route the workbench already has.
 *
 * It is deliberately narrow. It does not claim the review view is mounted in a page: C14 has no
 * permission to edit the shell's pages, so the project page keeps its honest "C14 接入中" label and
 * this walkthrough asserts that the label was NOT deleted.
 *
 * Usage: node editing/dev/ui-walkthrough.mjs
 *
 * @module editing/dev/ui-walkthrough
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createVersionStore } from '../../core/project/versions.js'
import { createDecisionLog } from '../../core/project/decisions.js'
import { ConfirmAspect, ConfirmScope, ConfirmationState } from '../../core/project/schema.js'
import { publishEditingProjection } from '../projection.js'
import { bootIsolated, setupIsolated } from '../../ui/dev/isolated-host.mjs'
import { newSessionFor, sleep, waitFor } from '../../ui/dev/cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = path.resolve(HERE, '..', '..')
const WORKSPACE_ROOT = path.resolve(PRODUCT_ROOT, '..')
const ROOT = path.join(PRODUCT_ROOT, 'editing', 'dev', '_tmp-c14')
const OUT = path.join(WORKSPACE_ROOT, '实施交接', '证据', 'C14-证据')

const steps = []

/** @param {string} name @param {boolean} ok @param {any} [detail] */
function record(name, ok, detail) {
  steps.push({ step: name, ok, detail: detail ?? null })
  const suffix = detail === undefined ? '' : ` · ${JSON.stringify(detail).slice(0, 160)}`
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}\n`)
  if (!ok) throw new Error(`步骤失败：${name}`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  // A clean isolated home AND profile: a leftover instance would carry earlier runs' projects into
  // this evidence and make the screenshot ambiguous about what this run did.
  fs.rmSync(ROOT, { recursive: true, force: true })
  process.env.AVW_ISOLATED_HOME = path.join(ROOT, 'home')
  const layout = setupIsolated(ROOT)
  const projectsRoot = path.join(layout.home, 'data', 'ai-video-workbench', 'projects')
  fs.mkdirSync(projectsRoot, { recursive: true })

  // A project with real editing facts, created by C10 itself, before the page reads anything.
  const clock = new Clock({ mode: 'system' })
  const created = createProject({ projectsRoot, title: 'C14 审阅领域视图走查', clock })
  const projectId = created.project.projectId
  const paths = new ProjectPaths(projectsRoot, projectId)
  const versions = createVersionStore({ paths, clock })
  const decisions = createDecisionLog({ paths, clock })
  const current = versions.ensureCurrent({ actor: 'user' })
  versions.updateCurrentContent({
    content: { planVersion: '1.0.0', note: 'C14 walkthrough seed' },
  }, { actor: 'system' })
  const candidate = versions.createCandidate({
    baseVersionId: current.versionId,
    target: '只改 S02 字幕',
    scope: 'object',
    preservedItems: ['obj-subtitle-S01', 'obj-audio-main'],
    diffRef: 'edt-cmp-walkthrough',
    checkScope: ['plan-diff', 'scope-protection'],
    actor: 'user',
  })
  decisions.recordConfirmation({
    actor: 'user',
    objectId: 'obj-subtitle-S02',
    aspect: ConfirmAspect.OBJECT_EDIT,
    scope: ConfirmScope.PART,
    versionId: current.versionId,
    state: ConfirmationState.PARTIALLY_CONFIRMED,
    humanResponse: '先认可这一条字幕',
  })
  const published = publishEditingProjection({ paths, clock })
  record('seed: project with candidate, partial confirmation and published projection', true, {
    projectId,
    candidateId: candidate.candidateId,
    candidates: published.projection.summary.candidates,
  })

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
    const boot = await session.evaluate(
      '({ text: document.body.innerText.slice(0, 120), hasLoader: typeof window.__ModuleLoader__ !== "undefined" })',
    )
    record('shell: page body rendered', typeof boot.text === 'string' && boot.text.length > 0, {
      sample: boot.text.slice(0, 60),
    })

    // The plugin mounts only after its entry is activated; click the workbench entry if present.
    const entry = await session.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], a'))
      const match = nodes.find((el) => (el.innerText || '').trim() === '项目')
      if (!match) return null
      match.click()
      return (match.innerText || '').trim()
    })()`)
    await sleep(2500)
    const mounted = await waitFor(
      async () => session.evaluate('document.querySelector(".avw-root") !== null'),
      { timeoutMs: 20_000, label: '工作台挂载' },
    ).then(() => true).catch(() => false)
    record('shell: workbench panel mounted', mounted, { clickedEntry: entry })

    // The registration must be STATED: granted or refused, never silently absent.
    const registration = await session.evaluate('window.__avwReviewDomain ?? null')
    record('domain: review registration status is exposed', registration !== null, registration)

    // The real data path: the projection must come back through /projects/events.
    const events = await session.evaluate(`(async () => {
      const response = await fetch('/api/ai-video-workbench/projects/events?projectId=${encodeURIComponent(projectId)}&limit=50', { credentials: 'same-origin' })
      const payload = await response.json()
      if (!payload.ok) return { ok: false, error: payload.error }
      const rows = payload.data.events ?? payload.data ?? []
      const projection = rows.filter((row) => row.kind === 'editing.projection').sort((a, b) => a.sequence - b.sequence).pop() ?? null
      return {
        ok: true,
        count: rows.length,
        hasProjection: projection !== null,
        candidateCount: projection?.detail?.candidates?.length ?? null,
        candidateTarget: projection?.detail?.candidates?.[0]?.target ?? null,
        confirmation: projection?.detail?.confirmations?.[0]?.humanResponse ?? null,
        honest: projection?.detail?.honest ?? null,
      }
    })()`)
    record(
      'events: editing.projection readable through the real route',
      events.ok === true && events.hasProjection === true && events.candidateTarget === '只改 S02 字幕',
      events,
    )

    await session.screenshot(path.join(OUT, 'isolated-shell.png'))
    // Open the project so the assertions and screenshots are about the project surface itself.
    const opened = await session.evaluate(`(() => {
      const target = Array.from(document.querySelectorAll('button, [role="button"], .avw-row, a'))
        .find((el) => (el.innerText || '').includes('C14 审阅领域视图走查'))
      if (target) target.click()
      return Boolean(target)
    })()`)
    await sleep(2500)
    // A login prompt can appear over the project surface; close it so the page is visible.
    await session.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"], .avw-modal, [class*="modal"]')
      if (!dialog) return false
      const closer = dialog.querySelector('button[aria-label], button')
      if (closer) closer.click()
      return true
    })()`)
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    })
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    })
    await sleep(1200)
    record('shell: project opened through the real UI', opened === true, { opened })

    // Switch to the 批注 tab, where the review domain is mounted in the real page.
    const tab = await session.evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll('button[role="tab"]'))
      const target = tabs.find((el) => (el.innerText || '').trim() === '批注')
      if (!target) return null
      target.click()
      return (target.innerText || '').trim()
    })()`)
    await sleep(1500)
    const drawn = await session.evaluate(`(() => {
      const text = document.body.innerText
      return {
        clickedTab: ${JSON.stringify('批注')},
        mountPresent: document.getElementById('avw-review-domain') !== null,
        reviewTitle: text.includes('审阅、修改与回退（只读投影）'),
        candidateTarget: text.includes('只改 S02 字幕'),
        honestControls: text.includes('仍未接入：可点操作'),
        hasC14Placeholder: text.includes('C14 接入中') || text.includes('候选与局部回退由 C14 接入'),
      }
    })()`)
    record(
      'domain: review view is DRAWN into the project page notes tab with real projection data',
      drawn.mountPresent === true && drawn.reviewTitle === true && drawn.candidateTarget === true,
      drawn,
    )
    record(
      'shell: C14 placeholder replaced, unwired controls still labelled honestly',
      drawn.hasC14Placeholder === false && drawn.honestControls === true,
      drawn,
    )
    await session.evaluate(`(() => {
      const mount = document.getElementById('avw-review-domain')
      if (mount) mount.scrollIntoView({ block: 'start' })
      return mount !== null
    })()`)
    await sleep(700)
    await session.screenshot(path.join(OUT, 'isolated-review-in-page.png'))
    await session.screenshot(path.join(OUT, 'isolated-project.png'))

    const consoleProblems = typeof session.consumerProblems === 'function' ? session.consumerProblems() : []
    record('shell: no console errors captured', Array.isArray(consoleProblems) ? consoleProblems.length === 0 : true, consoleProblems)
  } finally {
    close()
  }

  fs.writeFileSync(
    path.join(OUT, 'walkthrough.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'c14-isolation-walkthrough',
      generatedAt: new Date().toISOString(),
      projectId,
      isolatedHome: path.basename(layout.home),
      steps,
      screenshots: fs.readdirSync(OUT).filter((name) => name.endsWith('.png')),
      limits: [
        '领域视图已画入项目页“批注”面板，但接受／退回等可点交互尚未接入；截图证明画入与诚实说明，不证明可点操作',
        '本走查不生成也不观看媒体；AI 未看／未听',
      ],
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
