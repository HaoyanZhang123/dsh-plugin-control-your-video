/**
 * Integration test for the built client bundle.
 *
 * The bundle is what the Host actually serves to the browser. This test evaluates it with a stub
 * module loader and a stub React, then runs `apply` against a recording Context. It proves the
 * loader contract (id + factory), the four sidebar entries and the four keyed main panels, and that
 * every registration is returned through an effect disposer.
 *
 * It does not prove pixels: no browser is opened here. Visual verification is recorded separately
 * in the card evidence.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '../../ui/plugin/client.js')

function loadBundle() {
  const source = fs.readFileSync(BUNDLE, 'utf8')
  let definition = null
  const window = {
    __ModuleLoader__: {
      load(candidate) {
        definition = candidate
      },
    },
  }
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    Fragment: 'Fragment',
  }
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
  }
  // eslint-disable-next-line no-new-func -- the test must execute the shipped bundle as-is
  const run = new Function('window', 'document', 'require', `${source}\nreturn window.__ModuleLoader__;`)
  run(window, documentStub, (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`bundle 请求了未提供的模块：${name}`)
  })
  return { definition, ReactStub }
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

test('bundle calls the module loader with the package id and a factory', () => {
  const { definition, ReactStub } = loadBundle()
  assert.ok(definition, 'bundle 没有调用 __ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-plugin-control-your-video')
  assert.equal(typeof definition.factory, 'function')
  const plugin = definition.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未提供 ${name}`)
  })
  assert.equal(plugin.name, 'dsh-plugin-control-your-video')
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers four sidebar entries and four keyed main panels', () => {
  const { definition, ReactStub } = loadBundle()
  const plugin = definition.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未提供 ${name}`)
  })
  const { ctx, registrations, injections, effects } = makeContext()
  plugin.apply(ctx)

  const sidebar = registrations.filter((entry) => entry.definition.name === 'sidebar.panellist')
  const main = registrations.filter((entry) => entry.definition.name === 'main')
  assert.equal(sidebar.length, 4)
  assert.equal(main.length, 4)
  assert.deepEqual(sidebar.map((entry) => entry.definition.id), ['avw-projects', 'avw-effects', 'avw-tools', 'avw-preferences'])
  assert.deepEqual(main.map((entry) => entry.definition.key), ['avw-projects', 'avw-effects', 'avw-tools', 'avw-preferences'])
  assert.deepEqual([...new Set(injections)].sort(), ['main', 'sidebar.panellist'])
  assert.deepEqual(sidebar.map((entry) => entry.definition.label()), ['项目', '效果', '工具', '偏好'])
  assert.equal(effects.length, 9)
  assert.ok(effects.every((effect) => typeof effect.dispose === 'function'))
  assert.ok(effects.some((effect) => effect.label.includes('stylesheet')))
})

test('sidebar and main entries stay paired by id', () => {
  const { definition, ReactStub } = loadBundle()
  const plugin = definition.factory(() => ReactStub)
  const { ctx, registrations } = makeContext()
  plugin.apply(ctx)
  const sidebarIds = registrations.filter((entry) => entry.definition.name === 'sidebar.panellist').map((entry) => entry.definition.id)
  const mainKeys = registrations.filter((entry) => entry.definition.name === 'main').map((entry) => entry.definition.key)
  assert.deepEqual(sidebarIds, mainKeys)
})

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

test('every registered main panel renders once with a stub React (undefined helpers fail here)', () => {
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
  const window = { __ModuleLoader__: { load(candidate) { definition = candidate } } }
  // eslint-disable-next-line no-new-func -- the test executes the shipped bundle
  new Function('window', 'document', 'require', source)(window, documentStub, (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未提供 ${name}`)
  })
  const plugin = definition.factory(() => ReactStub)

  const registrations = []
  const ctx = {
    slots: {
      inject(_name, factory) { return factory() },
      register(definitionEntry, component) {
        registrations.push({ definition: definitionEntry, component })
        return () => {}
      },
    },
    effect(factory) { return factory() },
  }
  plugin.apply(ctx)
  const panels = registrations.filter((entry) => entry.definition.name === 'main')
  assert.equal(panels.length, 4)
  const expectedTitle = {
    'avw-projects': '项目',
    'avw-effects': '效果',
    'avw-tools': '工具',
    'avw-preferences': '偏好',
  }
  for (const panel of panels) {
    let rendered
    assert.doesNotThrow(() => { rendered = panel.component({}) }, `${panel.definition.key} 渲染失败（空状态）`)
    const text = collectText(rendered).join(' ')
    assert.ok(text.includes(expectedTitle[panel.definition.key]), `${panel.definition.key} 渲染成了空面板`)
  }

  // Seed real-shaped data so the list rows render, not just the empty states.
  const store = plugin.__internal.Store
  store.set({
    status: 'ready',
    bootstrap: {
      projects: [{
        projectId: 'project_a',
        title: 'A',
        phase: 'intake',
        phaseLabel: '接收输入',
        executionLabel: '空闲',
        updatedAt: '2026-11-08T00:00:00.000Z',
        needsAttention: false,
        lastPosition: null,
      }],
      waiting: [],
      latest: null,
      roots: {},
    },
    tools: {
      available: true,
      interfaceVersion: '2.0.0',
      tools: [{
        toolId: 'ffmpeg',
        displayName: 'FFmpeg',
        purpose: '读取真实时长、剪切与编码',
        status: 'not-installed',
        userState: '未安装',
        usable: false,
        supportClass: 'external',
        packId: 'base',
        versions: { supported: '*', installed: null, detected: null },
        license: { spdx: 'GPL-3.0', pluginMit: false },
        effects: { network: false, dataSubmission: false, fee: false },
        source: { description: '用户自行安装' },
        manualGuidance: ['从官网下载后放到工具目录'],
      }],
      note: null,
    },
    preferences: {
      corrupt: false,
      spec: { 'creation.aspect-ratio': { kind: 'enum', values: ['16:9', '9:16'] } },
      items: [{ key: 'creation.aspect-ratio', group: 'creation', value: '16:9', source: 'default', label: '内置默认' }],
      values: { 'creation.aspect-ratio': '16:9' },
      sources: { 'creation.aspect-ratio': 'default' },
      projectScoped: false,
    },
    effects: { effects: [], note: 'C15' },
  })
  for (const panel of panels) {
    let rendered
    assert.doesNotThrow(() => { rendered = panel.component({}) }, `${panel.definition.key} 渲染失败（有数据）`)
    const text = collectText(rendered).join(' ')
    assert.ok(text.includes(expectedTitle[panel.definition.key]), `${panel.definition.key} 渲染成了空面板（有数据）`)
    if (panel.definition.key === 'avw-tools') {
      assert.ok(text.includes('FFmpeg'), '工具页没有渲染真实工具行')
      assert.ok(text.includes('插件不下载'), '工具页没有渲染边界说明')
    }
  }
})
