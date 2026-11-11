#!/usr/bin/env node
/**
 * C15 UI evidence: boot an isolated Host, open a project that really HAS a delivery projection, and
 * prove the delivery domain view renders that data on the effects page.
 *
 * Why this script exists: the shared walkthrough (C11's) proves the shell, but it has no delivery
 * facts, so it can only prove the domain view's empty state. This one creates a real project in the
 * isolated home, finalizes it, runs a real export, publishes the `delivery.projection` event, then
 * walks the real browser and asserts the rendered text — with a screenshot next to this report.
 *
 * What it does NOT do: no install, no network upload, no change to the user's profile or data.
 * Everything happens under the isolated root it prints.
 *
 * Usage: node delivery/dev/ui-evidence.mjs --root ui/dev/_tmp-c15-domain --out <dir>
 *
 * @module delivery/dev/ui-evidence
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock } from '../../base/index.js'
import { createProject, createDecisionLog, createVersionStore, openProject } from '../../core/project/index.js'
import { normalizePlan, resolveToolchain } from '../../media/index.js'
import { writePlanSnapshot } from '../../editing/index.js'
import { setupIsolated, bootIsolated } from '../../ui/dev/isolated-host.mjs'
import { newSessionFor, sleep, waitFor } from '../../ui/dev/cdp.mjs'
import {
  createDeliveryKit,
  declareCoverSpec,
  declareSpec,
  declareSubtitleSpec,
  declareUnsupportedSpec,
  evaluateClosure,
  executeDelivery,
  planCleanupScope,
  planDelivery,
  publishDeliveryProjection,
} from '../index.js'
import { buildDeliveryUnitPlan } from '../fixtures/unit.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const FONT = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', 'arial.ttf')

/** Create the project facts inside the isolated home, before the Host boots. */
function createFacts(projectsRoot, outDir) {
  const clock = new Clock()
  const toolchain = resolveToolchain({ allowPathLookup: true })
  const created = createProject({ projectsRoot, title: 'C15 交付证据项目', origin: 'blank', clock })
  const paths = created.paths
  const decisions = createDecisionLog({ paths, clock })
  const versions = createVersionStore({ paths, clock })
  const plan = normalizePlan(buildDeliveryUnitPlan({ fontFile: FONT, projectId: created.project.projectId }), {
    now: () => clock.iso(),
  })
  const snapshot = writePlanSnapshot({ paths, ownerId: 'c15-ui-evidence', plan, clock })
  versions.ensureCurrent({ actor: 'system', label: '当前版本' })
  versions.updateCurrentContent({ content: { planRef: snapshot.planRef, planVersion: plan.planVersion } })
  const confirmation = decisions.recordConfirmation({
    actor: 'user',
    objectId: `movie:${created.project.projectId}`,
    aspect: 'final-cut',
    scope: 'whole',
    versionId: versions.getCurrent().versionId,
    state: 'confirmed',
    humanResponse: '证据脚本模拟用户验收（仅用于隔离演示；真实定稿必须来自用户本人）',
  })
  const finalVersion = versions.finalize({ actor: 'user', confirmationRef: confirmation.confirmationId, label: '交付证据定稿' })

  const kit = createDeliveryKit({ paths, clock, toolchain, effectsRoot: path.join(projectsRoot, '..', 'effects') })
  const delivery = executeDelivery({
    paths,
    store: kit.store,
    exporter: kit.exporter,
    deliveryId: planDelivery({
      paths,
      versions,
      finalVersion,
      specs: [
        declareSpec({ specId: 'master', label: '主版 640×360' }),
        declareSpec({ specId: 'vertical', label: '第二画幅 360×640', binding: 'adapt-operation', target: { width: 360, height: 640 } }),
        declareCoverSpec({ specId: 'cover', fromSpecId: 'master', frame: 30 }),
        declareSubtitleSpec({}),
        declareUnsupportedSpec({}),
      ],
      store: kit.store,
      clock,
    }).deliveryId,
    finalVersion,
    clock,
  })
  const scope = planCleanupScope({ paths, versions, clock, effectReferences: [] })
  const steps = evaluateClosure({
    finalVersion,
    plan: snapshot,
    projectFiles: { materials: [], fonts: [{ family: 'Arial' }] },
    delivery,
    verifyItem: (item) => kit.exporter.verifyDeliveredItem(item),
    effects: [],
    effectDecisions: [],
    scope,
    confirmation: null,
    cleanup: null,
  })
  kit.closure.open({ finalVersionId: finalVersion.versionId, deliveryId: delivery.deliveryId })
  kit.closure.setScope(scope, { readyToClean: steps.readyToClean })
  const { projection } = publishDeliveryProjection({
    paths,
    clock,
    finalVersion,
    deliveries: kit.store.list(),
    packages: [],
    closure: kit.closure.active(),
    closureSteps: steps,
    effects: kit.effects.snapshot(),
  })
  fs.writeFileSync(
    path.join(outDir, 'delivery-projection.json'),
    `${JSON.stringify({ publishedTo: `project ${created.project.projectId} events`, deliveryState: delivery.state, steps: steps.steps, projection }, null, 2)}\n`,
  )
  return { projectId: created.project.projectId, title: created.project.title, delivery }
}

async function main() {
  const root = path.resolve(arg('root', path.join(HERE, '..', '..', 'ui', 'dev', '_tmp-c15-domain')))
  const out = path.resolve(arg('out', path.join(HERE, '..', '..', 'ui', 'dev', '_tmp-c15-domain', 'walk')))
  fs.mkdirSync(out, { recursive: true })
  const layout = setupIsolated(root)
  const projectsRoot = path.join(layout.home, 'data', 'ai-video-workbench', 'projects')
  fs.mkdirSync(projectsRoot, { recursive: true })
  const facts = createFacts(projectsRoot, out)
  process.stdout.write(`isolated home: ${layout.home}\nproject: ${facts.projectId} ${facts.title}\n`)

  const host = bootIsolated(layout)
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Host 在 90 秒内没有 ready')), 90_000)
    host.on('message', (message) => {
      if (message?.type === 'ready') {
        clearTimeout(timer)
        resolve(message.url)
      }
    })
    host.on('exit', (code) => {
      if (code !== null && code !== undefined) reject(new Error(`Host 提前退出 code=${code}`))
    })
  })
  process.stdout.write(`READY_URL=${url}\n`)

  const steps = []
  const record = (step, ok, detail) => {
    steps.push({ step, ok, detail })
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? ` · ${detail}` : ''}\n`)
    if (!ok) throw new Error(`步骤失败：${step} · ${detail ?? ''}`)
  }

  const { session, close } = await newSessionFor(url, { width: 1680, height: 1050 })
  try {
    await session.send('DOM.enable')
    await sleep(3500)
    await session.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('[role="dialog"] button, dialog button'))
      const close = nodes.find((el) => /关闭|close|取消/i.test(el.getAttribute('aria-label') || el.innerText || ''))
      if (close) { close.click(); return true }
      return false
    })()`).catch(() => null)
    await sleep(500)
    await session.evaluate(`(() => {
      const wanted = '项目'
      const nodes = Array.from(document.querySelectorAll('button, [role="tab"]'))
      const match = nodes.find((el) => (el.innerText || '').trim() === wanted)
      if (match) match.click()
      return Boolean(match)
    })()`)
    await session.waitForSelector('.avw-root', 15000)
    record('四入口：项目面板打开', true)

    await waitFor(
      async () => session.evaluate(`document.body.innerText.includes(${JSON.stringify(facts.title)})`),
      { label: '项目出现在列表' },
    )
    record('隔离项目出现在真实项目列表', true)
    await session.evaluate(`(() => {
      const wanted = ${JSON.stringify(facts.title)}
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, .avw-row'))
      const match = nodes.find((el) => (el.innerText || '').trim().replace(/\\s+/g, ' ').includes(wanted))
      if (match) match.click()
      return Boolean(match)
    })()`)
    await session.waitForSelector('.avw-topbar', 15000)
    const opened = await session.evaluate(`(() => ({
      topbar: document.querySelector('.avw-topbar') !== null,
      title: document.querySelector('.avw-title b')?.innerText ?? null,
      creation: document.body.innerText.includes('创作'),
    }))()`)
    record('打开项目进入项目页（标题匹配）', opened.topbar === true && opened.title === facts.title, JSON.stringify(opened))
    await sleep(600)

    await session.evaluate(`(() => {
      const wanted = '效果'
      const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"]'))
      const match = nodes.find((el) => (el.innerText || '').trim() === wanted)
      if (match) match.click()
      return Boolean(match)
    })()`)
    await session.waitForSelector('#avw-delivery-domain', 15000)
    await sleep(1200)
    const debugInfo = await session.evaluate(`(async () => {
      const domain = document.querySelector('#avw-delivery-domain')
      let eventsCount = null
      let eventKinds = []
      try {
        const response = await fetch('/api/ai-video-workbench/projects/events?projectId=' + encodeURIComponent(${JSON.stringify(facts.projectId)}) + '&limit=200')
        const payload = await response.json()
        eventsCount = payload?.data?.events?.length ?? null
        eventKinds = (payload?.data?.events ?? []).slice(0, 12).map((entry) => entry.kind)
      } catch (error) {
        eventsCount = 'ERR ' + String(error?.message ?? error)
      }
      return {
        text: domain ? domain.innerText.slice(0, 1200) : null,
        registration: window.__avwDeliveryDomain ?? null,
        eventsCount,
        eventKinds,
      }
    })()`)
    fs.writeFileSync(path.join(out, 'ui-delivery-domain-debug.json'), `${JSON.stringify(debugInfo, null, 2)}\n`)
    process.stdout.write(`DEBUG ${JSON.stringify(debugInfo).slice(0, 600)}\n`)
    await waitFor(
      async () => session.evaluate(`document.querySelector('#avw-delivery-domain')?.innerText.includes('交付、项目包、效果与结项') === true`),
      { label: '交付域视图出现' },
    )
    record('效果页出现交付域视图（不是空白占位）', true)

    const text = await session.evaluate(`document.querySelector('#avw-delivery-domain').innerText`)
    for (const expected of [
      '定稿与成片交付',
      '全部可用规格已导出并检查',
      '第二画幅 360×640',
      'AdaptOperation',
      '封面',
      '字幕',
      '本卡不可用',
      '效果库',
      '结项与清理',
      '等待你决定',
      '只读投影',
      '不画假按钮',
    ]) {
      record(`交付域视图包含真实内容：${expected}`, text.includes(expected), '')
    }
    const state = await session.evaluate(`(() => ({
      domain: document.querySelector('#avw-delivery-domain') !== null,
      gapCard: Array.from(document.querySelectorAll('.avw-gap')).some((el) => el.innerText.includes('C15 尚未接入')),
      fakeButtons: Array.from(document.querySelectorAll('#avw-delivery-domain button')).length,
      screenshotsReady: true,
    }))()`)
    record('外壳“尚未接入”标注保留', state.gapCard, JSON.stringify({ fakeButtons: state.fakeButtons }))
    record('域视图里没有假按钮', state.fakeButtons === 0, `${state.fakeButtons} 个按钮`)

    const shot = path.join(out, '14-delivery-domain.png')
    // The isolated profile has no account, so the Host shows its own preview note over the panel;
    // it is a Host condition, not a workbench control, so dismiss it for a readable screenshot.
    await session.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('[role="dialog"] button, dialog button'))
      const target = nodes.find((el) => /继续|关闭|close|知道了|取消|skip|later/i.test(el.getAttribute('aria-label') || el.innerText || ''))
      if (target) { target.click(); return true }
      return false
    })()`).catch(() => null)
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(700)
    await session.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('[role="dialog"] button, dialog button'))
      const close = nodes.find((el) => /关闭|close/i.test(el.getAttribute('aria-label') || ''))
      if (close) { close.click(); return true }
      return false
    })()`).catch(() => null)
    await sleep(700)
    await session.screenshot(shot)
    record('截图写出', fs.existsSync(shot), shot)
    const problems = session.consoleProblems()
    record('页面无未捕获异常/console.error', problems.length === 0, problems.map((entry) => entry.text).join(' | ').slice(0, 200))

    fs.writeFileSync(
      path.join(out, 'ui-delivery-domain.json'),
      `${JSON.stringify({ url, projectId: facts.projectId, steps, screenshot: shot }, null, 2)}\n`,
    )
    process.stdout.write(`ui evidence complete → ${out}\n`)
  } finally {
    await close()
    host.kill()
  }
}

const timeout = setTimeout(() => {
  process.stderr.write('C15 UI 证据超时\n')
  process.exit(1)
}, 240_000)

main()
  .then(() => {
    clearTimeout(timeout)
    setTimeout(() => process.exit(0), 400)
  })
  .catch((error) => {
    clearTimeout(timeout)
    process.stderr.write(`${String(error?.stack ?? error)}\n`)
    process.exit(1)
  })
