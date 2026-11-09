/**
 * Tests for the creation-domain projection and the domain view registration.
 *
 * Two separate claims are covered:
 * - the projection is a CACHE built from real C13 documents, published into the project's own event
 *   stream, and the newest one wins regardless of the order a reader hands events back in;
 * - the view registers through the shell's disposable effect and disappears when that effect is
 *   disposed, without adding a navigation entry, a main panel or a new slot name.
 *
 * @module tests/unit/orchestration-projection.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Clock, createTempDir } from '../../base/index.js'
import { createProject } from '../../core/project/project.js'
import { ProjectPaths } from '../../core/project/paths.js'
import { readRecentEvents } from '../../core/project/events.js'
import { BriefSource, CreationBrief } from '../../orchestration/brief.js'
import { PlanBaseline } from '../../orchestration/direction.js'
import { PreviewSurface } from '../../orchestration/preview.js'
import {
  CREATION_PROJECTION_KIND,
  buildCreationProjection,
  latestCreationProjection,
  publishCreationProjection,
} from '../../orchestration/projection.js'

const temp = createTempDir({ label: 'orchestration-projection' })
test.after(() => temp.dispose())

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '../../ui/plugin/client.js')
const clock = new Clock({ mode: 'frozen', start: 1_780_000_300_000 })
let counter = 0

/** @returns {any} */
function makeProject() {
  counter += 1
  const root = temp.dir(`root-${counter}`)
  const created = createProject({ projectsRoot: root, title: `投影 ${counter}`, clock })
  return new ProjectPaths(root, created.project.projectId)
}

test('projection: a summary of the real documents, with the source revisions it was built from', () => {
  const paths = makeProject()
  const brief = new CreationBrief({ paths, clock })
  brief.addEntry({ source: BriefSource.USER, text: '不要旁白' })
  brief.addEntry({ source: BriefSource.UNKNOWN, text: '是否需要字幕' })
  const baseline = new PlanBaseline({ paths, clock })
  baseline.addItem({ kind: 'core-goal', title: '12 秒短片' })
  baseline.addItem({ kind: 'authorization', title: '允许制作' })
  new PreviewSurface({ paths, clock }).recordPreview({ basePlan: { planVersion: 'plan-v1' }, coveredRange: null, file: 'media/p.mp4' })

  const projection = buildCreationProjection({ paths, clock, currentPlanVersion: 'plan-v2' })
  assert.equal(projection.projectionVersion, 1)
  assert.equal(projection.brief.counts.user, 1)
  assert.equal(projection.brief.counts.unknown, 1)
  assert.equal(projection.baseline.items.length, 2)
  // Nothing is decided for the user, so the gate must stay closed.
  assert.equal(projection.baseline.ok, false)
  assert.equal(projection.preview.showing, 'previous-plan')
  assert.equal(projection.preview.planVersion, 'plan-v1')
  // The same plan version would be reported as the current plan.
  assert.equal(buildCreationProjection({ paths, clock, currentPlanVersion: 'plan-v1' }).preview.showing, 'current-plan')
  // Provenance is stated, not implied.
  assert.equal(typeof projection.sources.brief, 'string')
  assert.equal(projection.sources.plan !== null, true)
})

test('projection: publishing appends one real project event that the existing route can read', () => {
  const paths = makeProject()
  const { projection, event } = publishCreationProjection({ paths, clock })
  assert.equal(event.kind, CREATION_PROJECTION_KIND)
  assert.equal(event.projectId, paths.projectId)
  const events = readRecentEvents(paths.dir, 10)
  assert.equal(events[0].kind, CREATION_PROJECTION_KIND)
  assert.deepEqual(events[0].detail.brief.counts, projection.brief.counts)
})

test('projection: the newest summary wins even when events arrive newest-first', () => {
  const paths = makeProject()
  publishCreationProjection({ paths, clock })
  const brief = new CreationBrief({ paths, clock })
  brief.addEntry({ source: BriefSource.USER, text: '新增一条要求' })
  publishCreationProjection({ paths, clock })

  const newestFirst = readRecentEvents(paths.dir, 20)
  assert.equal(newestFirst[0].sequence > newestFirst[1].sequence, true)
  const latest = latestCreationProjection(newestFirst)
  assert.equal(latest.brief.counts.user, 1)

  // Reverse order must yield the same answer: sequence decides, not array position.
  assert.equal(latestCreationProjection([...newestFirst].reverse()).generatedAt, latest.generatedAt)
  assert.equal(latestCreationProjection([]), null)
  assert.equal(latestCreationProjection([{ kind: 'other', detail: {} }]), null)
})

test('domain view: registration is disposable and adds no slot or navigation entry', () => {
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
  // eslint-disable-next-line no-new-func -- the test executes the shipped bundle
  new Function('window', 'document', 'require', source)(windowStub, documentStub, (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未提供 ${name}`)
  })
  const plugin = definition.factory(() => ReactStub)

  const registrations = []
  const effects = []
  const ctx = {
    slots: {
      inject(name, factory) {
        registrations.push(name)
        return factory()
      },
      register() {
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

  // No new slot name and no fifth main panel: the four workbench entries are untouched.
  assert.deepEqual([...new Set(registrations)].sort(), ['main', 'sidebar.panellist'])
  assert.equal(registrations.filter((name) => name === 'main').length, 4)

  const registry = plugin.__internal.CREATION_DOMAIN_REGISTRY
  assert.equal(typeof registry.component, 'function')
  assert.equal(typeof registry.mountedAt, 'string')
  assert.equal(windowStub.__avwCreationDomain.mode, 'shell-registry')
  assert.equal(windowStub.__avwCreationDomain.registered, true)

  // The domain section renders with an empty projection instead of throwing (undefined helpers fail here).
  const section = registry.component({})
  assert.ok(section !== null && section !== undefined)

  for (const effect of effects) effect.dispose()
  assert.equal(registry.component, null, 'disposing the shell effect removes the registration')
  assert.equal(registry.mountedAt, null)
})

test('domain view: newestProjection ignores non-projection events and older summaries', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8')
  let definition = null
  const ReactStub = {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    Fragment: 'Fragment',
  }
  const windowStub = { __ModuleLoader__: { load(candidate) { definition = candidate } } }
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'require', source)(windowStub, documentStub, (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未提供 ${name}`)
  })
  const plugin = definition.factory(() => ReactStub)
  const events = [
    { kind: 'creation.projection', sequence: 9, detail: { id: 'new' } },
    { kind: 'project.opened', sequence: 8, detail: {} },
    { kind: 'creation.projection', sequence: 3, detail: { id: 'old' } },
  ]
  assert.equal(plugin.__internal.newestProjection(events).id, 'new')
  assert.equal(plugin.__internal.newestProjection([]), null)
  assert.equal(plugin.__internal.newestProjection([{ kind: 'project.opened', detail: {} }]), null)
})
