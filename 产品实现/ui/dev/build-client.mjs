#!/usr/bin/env node
/**
 * Build the browser half of the workbench plugin.
 *
 * The Host mounts a package's client half from its `lib/client.js`-style bundle wrapped in
 * `window.__ModuleLoader__.load({ id, factory })`. That wrapper is the only stable contract; this
 * project has no bundler dependency, so the small source tree is concatenated in a fixed order and
 * each `export` keyword is stripped. That is safe because:
 *
 * - every client module is written without `import` (dependencies are visible in the fixed order
 *   below), which keeps the transform mechanical instead of a parser;
 * - the bundle is syntax-checked with `node --check` and evaluated against a stub loader in tests.
 *
 * Usage: node ui/dev/build-client.mjs [--check]
 *
 * @module ui/dev/build-client
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(HERE, '..')
const OUT = path.join(UI_ROOT, 'plugin', 'client.js')
const PACKAGE_NAME = 'dsh-plugin-control-your-video'

/** Concatenation order is the dependency order. Keep it explicit. */
const SOURCES = [
  'client/model/timecode.js',
  'client/model/format.js',
  'client/model/layout.js',
  'client/model/keyboard.js',
  'client/model/search.js',
  'client/model/labels.js',
  'client/api.js',
  'client/store.js',
  'client/styles.js',
  'client/ui.js',
  'client/domains/creation/view.js',
  'client/domains/creation/index.js',
  'client/domains/review/view.js',
  'client/domains/review/index.js',
  'client/domains/delivery/view.js',
  'client/domains/delivery/index.js',
  'client/domains/realwork/snapshot.js',
  'client/domains/realwork/view.js',
  'client/domains/realwork/index.js',
  'client/hooks.js',
  'client/actions.js',
  'client/views/home.js',
  'client/views/project.js',
  'client/views/creation.js',
  'client/views/work.js',
  'client/views/tools.js',
  'client/views/preferences.js',
  'client/views/effects.js',
  'client/app.js',
]

function stripExports(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^export\s*\{[^}]*\}\s*;?\s*$/.test(line.trim()))
    .map((line) => line.replace(/^export\s+(async\s+function|function|const|let|class)\s+/, '$1 '))
    .join('\n')
}

function build() {
  const chunks = []
  for (const relative of SOURCES) {
    const absolute = path.join(UI_ROOT, relative)
    if (!fs.existsSync(absolute)) throw new Error(`缺少源文件：${relative}`)
    const source = fs.readFileSync(absolute, 'utf8')
    if (/^\s*import\s/m.test(source)) throw new Error(`${relative} 含 import：客户端源码必须无导入`)
    if (/^export\s+default\s/m.test(source)) throw new Error(`${relative} 含 default export：不支持`)
    chunks.push(`/* ---- ${relative} ---- */\n${stripExports(source).trim()}`)
  }

  const body = chunks.join('\n\n')
  const banner = [
    '/* 由 ui/dev/build-client.mjs 生成；不要手改。 */',
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(PACKAGE_NAME)},`,
    '  factory(require) {',
    "    'use strict';",
    "    var React = require('react');",
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    '',
  ].join('\n')
  const footer = [
    '',
    '    return AVW_PLUGIN;',
    '  },',
    '});',
    '',
  ].join('\n')

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, `${banner}${body}${footer}`, 'utf8')
  return OUT
}

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '语法检查失败\n')
    process.exit(1)
  }
}

/**
 * Load the bundle in Node with a stub module loader, so a broken concatenation (duplicate names,
 * a stray export) fails here instead of in the Host page.
 */
function loaderCheck(file) {
  const source = fs.readFileSync(file, 'utf8')
  let captured = null
  const ReactStub = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    Fragment: 'fragment',
  }
  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  }
  const moduleScope = { window }
  const fn = new Function('window', 'require', `${source}\nreturn window.__ModuleLoader__.__captured ?? null;`)
  fn(window, (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未提供的模块：${name}`)
  })
  if (!captured) throw new Error('bundle 没有调用 __ModuleLoader__.load')
  if (captured.id !== PACKAGE_NAME) throw new Error(`bundle id 不匹配：${captured.id}`)
  const exported = captured.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未提供的模块：${name}`)
  })
  if (!exported || typeof exported.apply !== 'function') throw new Error('client half 没有 apply()')
  if (exported.name !== PACKAGE_NAME) throw new Error(`client half name 不匹配：${exported.name}`)
  void moduleScope
  return { id: captured.id, inject: exported.inject, actions: Object.keys(exported).length }
}

const file = build()
syntaxCheck(file)
const info = loaderCheck(file)
const bytes = fs.statSync(file).size
process.stdout.write(`built ${path.relative(process.cwd(), file)} (${bytes} B)\n`)
process.stdout.write(`loader check: id=${info.id} inject=${JSON.stringify(info.inject)}\n`)
