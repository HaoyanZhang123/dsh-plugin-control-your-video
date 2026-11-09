/**
 * Integration: the review domain view in the shipped client bundle.
 *
 * This proves the shell contract C11 owns is untouched (four entries, two slot names, nine effects),
 * the review registration is disposable, and the pure view renders REAL projection data instead of
 * a fixture. It does not prove pixels; the isolated walkthrough records the visible evidence.
 *
 * @module tests/integration/editing-domain.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { createVersionStore } from '../../core/project/versions.js'
import { createDecisionLog } from '../../core/project/decisions.js'
import { readRecentEvents } from '../../core/project/events.js'
import { buildC12UnitPlan } from '../../media/fixtures/c12-unit.js'
import { normalizePlan } from '../../media/plan.js'
import { createEditingKit } from '../../editing/index.js'
import { writePlanSnapshot } from '../../editing/ids.js'
import {
  buildEditingProjection,
  publishEditingProjection,
} from '../../editing/projection.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '../../ui/plugin/client.js')
const fontFile = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'msyh.ttc')
const skip = fs.existsSync(fontFile) ? false : '需要系统中文字体构建 C12 计划；当前环境缺失，如实跳过'
const clock = new Clock({ mode: 'frozen', start: Date.UTC(2026, 10, 10, 0, 0, 0) })
const temp = createTempDir({ label: 'c14-domain' })
test.after(() => temp.dispose())

function loadBundle() {
  const source = fs.readFileSync(BUNDLE, 'utf8')
  let definition = null
  const ReactStub = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      if (typeof type === 'function') {
        const passed = { ...(props ?? {}), children: children.length === 1 ? children[0] : children }
        return type(passed)
      }
      return { type, props, children }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
  }
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
  }
  const windowStub = { __ModuleLoader__: { load(candidate) { definition = candidate } } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'require', source)(windowStub, documentStub, (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未提供 ${name}`)
  })
  return { plugin: definition.factory(() => ReactStub), windowStub, ReactStub }
}

function makeContext() {
  const registrations = []
  const injections = []
  const effects = []
  const ctx = {
    slots: {
      inject(name, factory) {
        injections.push(name)
        return factory()
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    effect(factory, label) {
      const dispose = factory()
      effects.push({ label, dispose })
      return dispose
    },
  }
  return { ctx, registrations, injections, effects }
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && 'children' in node) collectText(node.children, out)
  return out
}

/** A project with real candidate, annotation, confirmation and history facts. */
function makeProjection() {
  const projectsRoot = temp.dir('projects')
  const created = createProject({ projectsRoot, title: '审阅领域视图', clock })
  const paths = new ProjectPaths(projectsRoot, created.project.projectId)
  const versions = createVersionStore({ paths, clock })
  const decisions = createDecisionLog({ paths, clock })
  const current = versions.ensureCurrent({ actor: 'user' })
  const basePlan = normalizePlan(buildC12UnitPlan({ fontFile }), { now: () => clock.iso() })
  const snapshot = writePlanSnapshot({ paths, ownerId: 'domain-base', plan: basePlan, clock })
  versions.updateCurrentContent({ content: { planRef: snapshot.planRef } }, { actor: 'system' })
  const kit = createEditingKit({ paths, clock })
  const previewFile = path.join(temp.dir('preview'), 'preview.mp4')
  fs.mkdirSync(path.dirname(previewFile), { recursive: true })
  fs.writeFileSync(previewFile, 'placeholder')
  const session = kit.sessions.beginSession({
    target: '只改 S02 字幕',
    scope: 'object',
    targetObjectIds: ['obj-subtitle-S02'],
    plan: basePlan,
  })
  kit.sessions.applyEdit({
    sessionId: session.sessionId,
    intent: { kind: 'replace-text', objectId: 'obj-subtitle-S02', text: '领域视图里的真实修改' },
  })
  kit.sessions.attachPreview({ sessionId: session.sessionId, mediaRef: previewFile })
  const formed = kit.sessions.formCandidate({ sessionId: session.sessionId })
  const annotation = kit.annotations.addAnnotation({
    versionId: current.versionId,
    plan: basePlan,
    objectId: 'obj-subtitle-S02',
    aspect: 'text',
    body: '这一句要更短',
    author: '用户',
  })
  kit.candidates.recordPartialConfirmation({
    objectId: 'obj-subtitle-S02',
    aspect: 'object-edit',
    scope: 'part',
    versionId: current.versionId,
    humanResponse: '先认可这一条字幕',
    candidateId: formed.candidate.candidateId,
  })
  assert.equal(decisions.listConfirmations().length, 1)
  assert.equal(annotation.versionRef.planVerified, true)
  return { paths, projection: buildEditingProjection({ paths, clock }) }
}

test('the shell registration is disposable and changes no slot, panel or effect', { skip }, () => {
  const { plugin, windowStub } = loadBundle()
  const { ctx, registrations, injections, effects } = makeContext()
  plugin.apply(ctx)
  const sidebar = registrations.filter((entry) => entry.definition.name === 'sidebar.panellist')
  const main = registrations.filter((entry) => entry.definition.name === 'main')
  assert.equal(sidebar.length, 4)
  assert.equal(main.length, 4)
  assert.deepEqual([...new Set(injections)].sort(), ['main', 'sidebar.panellist'])
  assert.equal(effects.length, 9)
  assert.equal(windowStub.__avwCreationDomain.registered, true)
  assert.equal(windowStub.__avwReviewDomain.mode, 'shell-registry')
  assert.equal(windowStub.__avwReviewDomain.registered, true)
  const registry = plugin.__internal.REVIEW_DOMAIN_REGISTRY
  assert.equal(typeof registry.component, 'function')
  assert.equal(typeof registry.mountedAt, 'string')
  for (const effect of effects) effect.dispose()
  assert.equal(plugin.__internal.REVIEW_DOMAIN_REGISTRY.component, null, 'disposing removes the registration')
})

test('the review view renders the real projection, including the honest mounted/controls note', { skip }, () => {
  const { plugin } = loadBundle()
  const { projection } = makeProjection()
  const rendered = plugin.__internal.ReviewDomainView({ projection, notice: '只读投影' })
  const text = collectText(rendered).join(' ')
  assert.ok(text.includes('审阅、修改与回退'), `rendered text: ${text.slice(0, 240)}`)
  assert.ok(text.includes('候选'), `missing candidates: ${text.slice(-500)}`)
  assert.ok(text.includes('只改 S02 字幕'), `missing candidate target: ${text.slice(-500)}`)
  assert.ok(text.includes('这一句要更短'), `missing annotation: ${text.slice(-500)}`)
  assert.ok(text.includes('先认可这一条字幕'), `missing confirmation: ${text.slice(-500)}`)
  assert.ok(text.includes('部分确认'), `missing partial state: ${text.slice(-500)}`)
  assert.ok(text.includes('创作期历史与回退'), `missing history: ${text.slice(-500)}`)
  assert.ok(text.includes('已画入项目页'), `missing mounted honesty: ${text.slice(-500)}`)
  assert.ok(text.includes('未看、未听'), `missing ai honesty: ${text.slice(-500)}`)
})

test('the review domain mount renders the registered section inside the project notes tab', { skip }, () => {
  const { plugin } = loadBundle()
  const { ctx } = makeContext()
  plugin.apply(ctx)
  assert.equal(typeof plugin.__internal.ReviewDomainMount, 'function')
  const mount = plugin.__internal.ReviewDomainMount({})
  const text = collectText(mount).join(' ')
  assert.ok(text.includes('审阅、修改与回退'), `mount did not render the domain: ${text}`)
  assert.ok(text.includes('还没有审阅投影'), 'the section says it has no projection instead of faking data')
})

test('the client matcher reads the newest editing projection by sequence', { skip }, () => {
  const { plugin } = loadBundle()
  const { paths, projection } = makeProjection()
  const published = publishEditingProjection({ paths, clock })
  assert.equal(published.event.kind, 'editing.projection')
  const events = readRecentEvents(paths.dir, 50)
  const first = plugin.__internal.newestEditingProjection(events)
  assert.equal(first.projectId, projection.projectId)
  const older = { ...projection, generatedAt: 'older', summary: { candidates: 0 } }
  const newest = { ...projection, generatedAt: 'newest', summary: { candidates: 99 } }
  const fakeEvents = [
    { kind: 'editing.projection', sequence: 9, detail: newest },
    { kind: 'editing.projection', sequence: 3, detail: older },
    { kind: 'project.opened', sequence: 8, detail: {} },
  ]
  assert.equal(plugin.__internal.newestEditingProjection(fakeEvents).generatedAt, 'newest')
})
