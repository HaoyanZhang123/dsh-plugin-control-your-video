/**
 * Render the REAL creation-domain component to a screenshot.
 *
 * The surface decision is pending 总控, so the view is not mounted in a page yet. Rather than draw a
 * second, prettier mock, this harness mounts the SAME component file with the SAME stylesheet and the
 * REAL projection read from the project's event stream, inside an isolated Chromium page, and
 * screenshots it. If the component is broken, this screenshot is broken too — which is the point.
 *
 * Usage: node orchestration/dev/domain-shot.mjs --root <projects root> --project <prj_…> --out <png>
 *
 * @module orchestration/dev/domain-shot
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readRecentEvents } from '../../core/project/events.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { latestCreationProjection } from '../../orchestration/projection.js'
import { AVW_CSS } from '../../ui/client/styles.js'
import { CreationDomainView } from '../../ui/client/domains/creation/view.js'
import { newSessionFor } from '../../ui/dev/cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** @param {string} flag @param {string|null} fallback */
function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : fallback
}

/** Escape text for HTML. */
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const STYLE_KEYS = Object.freeze({ className: 'class', htmlFor: 'for' })

/**
 * A minimal React-element serializer: enough for this component tree, and it fails loudly on a
 * shape it does not understand instead of silently dropping content.
 * @param {any} node
 * @returns {string}
 */
function serialize(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (typeof node !== 'object' || typeof node.type === 'undefined') {
    throw new Error(`无法序列化的节点：${String(node)}`)
  }
  const { type, props, children } = node
  if (typeof type === 'function') {
    return serialize(type({ ...(props ?? {}), children }))
  }
  const attributes = []
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'children' || key === 'key' || value === null || value === undefined || value === false) continue
    if (key === 'style') {
      const css = Object.entries(value).map(([name, raw]) => `${name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${raw}`).join(';')
      attributes.push(`style="${esc(css)}"`)
      continue
    }
    const name = STYLE_KEYS[key] ?? key
    if (name.startsWith('on')) continue
    attributes.push(`${name}="${esc(value)}"`)
  }
  const body = serialize(children)
  return `<${type}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>${body}</${type}>`
}

async function main() {
  const root = arg('--root')
  const projectId = arg('--project')
  const out = path.resolve(arg('--out', path.join(HERE, '../../evidence/c13-render/domain/creation-domain.png')))
  if (root === null || projectId === null) throw new Error('需要 --root 与 --project')
  const paths = new ProjectPaths(path.resolve(root), projectId)
  const events = readRecentEvents(paths.dir, 200)
  const projection = latestCreationProjection(events)
  if (projection === null) throw new Error('项目事件流里没有 creation.projection，先发布投影')

  globalThis.h = (type, props, ...children) => ({
    type,
    props,
    children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
  })
  const markup = serialize(CreationDomainView({ projection, notice: '本视图面位待总控裁定；当前不占用导航入口。' }))
  // The design system defines its colours on `.avw-root`; without that wrapper every token is
  // undefined and the screenshot renders dark-on-dark. The harness uses the same wrapper the shell
  // uses, and the same dark theme attribute, so the shot matches the real panel context.
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>创建领域视图</title><style>${AVW_CSS}
    body { margin: 0; background: #0f1115; padding: 18px; }
    .avw-creation-domain { max-width: 1180px; }
  </style></head><body data-ds-dark-theme="true"><div class="avw-root" data-mode="wide" data-panel="projects">
    <div class="avw-creation-domain">${markup}</div></div></body></html>`

  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out.replace(/\.png$/, '.html'), html, 'utf8')

  const { session, close } = await newSessionFor('about:blank', { width: 1440, height: 1500 })
  try {
    const tree = await session.send('Page.getFrameTree')
    await session.send('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html })
    await session.setViewport(1440, 1500)
    await session.screenshot(out)
    const text = await session.evaluate('document.body.innerText.slice(0, 400)')
    fs.writeFileSync(
      out.replace(/\.png$/, '.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'c13-domain-view-shot',
        generatedAt: new Date().toISOString(),
        projectId,
        component: 'ui/client/domains/creation/view.js#CreationDomainView',
        stylesheet: 'ui/client/styles.js#AVW_CSS',
        projectionGeneratedAt: projection.generatedAt,
        projectionSources: projection.sources,
        screenshot: path.basename(out),
        html: path.basename(out).replace(/\.png$/, '.html'),
        visibleTextSample: text,
        note: '同一组件源码＋同一样式表＋项目事件里的真实投影，在隔离 Chromium 中渲染；不是宿主页面截图',
      }, null, 2)}\n`,
      'utf8',
    )
    process.stdout.write(`screenshot: ${out}\n`)
    process.stdout.write(`visible text starts: ${String(text).slice(0, 80).replace(/\n/g, ' | ')}\n`)
  } finally {
    close()
  }
}

await main()
