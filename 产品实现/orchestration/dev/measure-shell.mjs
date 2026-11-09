/**
 * Measure the shell's registration surface after mounting the creation domain view.
 *
 * The claim to prove is narrow and checkable: rendering the domain view inside the creation page
 * adds NO sidebar entry, NO main panel, NO new slot name and NO extra effect. This script loads the
 * shipped bundle exactly as the Host would, applies it to a recording context, and prints the four
 * counts. It is a measurement, not an argument.
 *
 * Usage: node orchestration/dev/measure-shell.mjs [--out <json>]
 *
 * @module orchestration/dev/measure-shell
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = path.resolve(HERE, '../..')
const BUNDLE = path.join(PRODUCT_ROOT, 'ui', 'plugin', 'client.js')

/** @param {string} flag @param {string|null} fallback */
function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const source = fs.readFileSync(BUNDLE, 'utf8')
let definition = null
const ReactStub = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
}
const windowStub = { __ModuleLoader__: { load(candidate) { definition = candidate } } }
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
}
// eslint-disable-next-line no-new-func -- the measurement must run the shipped bundle as-is
const runBundle = new Function('window', 'document', 'require', source) // dsh-allow S11: 执行本插件自身构建产物以实测注册数
runBundle(windowStub, documentStub, (name) => {
  if (name === 'react') return ReactStub
  throw new Error(`未提供 ${name}`)
})
const plugin = definition.factory(() => ReactStub)

const sidebar = []
const main = []
const injections = []
const effects = []
const ctx = {
  slots: {
    inject(name, factory) {
      injections.push(name)
      return factory()
    },
    register(entry) {
      if (entry.name === 'sidebar.panellist') sidebar.push(entry)
      if (entry.name === 'main') main.push(entry)
      return () => {}
    },
  },
  effect(factory, label) {
    const dispose = factory()
    effects.push({ label, dispose })
    return dispose
  },
}
plugin.apply(ctx)

const measurement = {
  schemaVersion: 1,
  kind: 'c13-shell-registration-measurement',
  generatedAt: new Date().toISOString(),
  bundle: 'ui/plugin/client.js',
  packageName: definition.id,
  sidebarCount: sidebar.length,
  sidebarIds: sidebar.map((entry) => entry.id),
  mainCount: main.length,
  mainKeys: main.map((entry) => entry.key),
  injectionNames: [...new Set(injections)].sort(),
  effectCount: effects.length,
  everyEffectDisposable: effects.every((effect) => typeof effect.dispose === 'function'),
  domainRegistry: {
    registered: typeof plugin.__internal.CREATION_DOMAIN_REGISTRY.component === 'function',
    mountedAt: plugin.__internal.CREATION_DOMAIN_REGISTRY.mountedAt,
  },
  expected: { sidebarCount: 4, mainCount: 4, injectionNames: ['main', 'sidebar.panellist'], effectCount: 9 },
}
measurement.matchesExpected =
  measurement.sidebarCount === 4 &&
  measurement.mainCount === 4 &&
  measurement.effectCount === 9 &&
  measurement.injectionNames.join(',') === 'main,sidebar.panellist' &&
  measurement.domainRegistry.registered === true

const out = path.resolve(arg('--out', path.join(PRODUCT_ROOT, 'evidence', 'c13-ui', 'shell-registration.json')))
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${JSON.stringify(measurement, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({
  sidebar: measurement.sidebarCount,
  main: measurement.mainCount,
  injections: measurement.injectionNames,
  effects: measurement.effectCount,
  domainRegistered: measurement.domainRegistry.registered,
  matchesExpected: measurement.matchesExpected,
}, null, 2)}\n`)
process.exit(measurement.matchesExpected ? 0 : 1)
