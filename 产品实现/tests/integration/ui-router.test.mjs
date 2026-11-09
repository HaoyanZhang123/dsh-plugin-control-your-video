/**
 * Integration tests for the workbench HTTP handler.
 *
 * The handler is exercised with fabricated Node request/response objects, which is enough to prove
 * routing, the permission gate, JSON envelopes and error codes without opening a port. Opening a
 * port would be an environment action this card did not ask for.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createWorkbenchService } from '../../ui/host/service.js'
import { createRequestHandler, ROUTE_PREFIX } from '../../ui/host/routes.js'

function makeRequest(method, pathname, body) {
  const url = `${ROUTE_PREFIX}${pathname}`
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    setHeader(name, value) { this.headers[name] = value },
    end(data) { this.body = data === undefined ? '' : String(data) },
  }
  return response
}

async function call(handler, method, pathname, body) {
  const response = makeResponse()
  await handler(makeRequest(method, pathname, body), response)
  return {
    status: response.statusCode,
    json: response.body ? JSON.parse(response.body) : null,
    headers: response.headers,
  }
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'avw-ui-router-'))
  const service = createWorkbenchService({ home, dataRoot: path.join(home, 'data') })
  const handler = createRequestHandler({ service, authorize: () => undefined })
  return { home, service, handler, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('health and bootstrap answer with the success envelope', async () => {
  const { handler, cleanup } = setup()
  try {
    const health = await call(handler, 'GET', '/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)
    assert.equal(health.json.data.service, 'ai-video-workbench')

    const boot = await call(handler, 'GET', '/bootstrap')
    assert.equal(boot.status, 200)
    assert.equal(boot.json.ok, true)
    assert.ok(Array.isArray(boot.json.data.projects))
    assert.ok(boot.json.data.preferences.spec)
  } finally {
    cleanup()
  }
})

test('create/open/save round-trips through the handler', async () => {
  const { handler, cleanup } = setup()
  try {
    const created = await call(handler, 'POST', '/projects', { title: '接口测试项目', idea: '一句话。' })
    assert.equal(created.status, 200)
    assert.equal(created.json.ok, true)
    const projectId = created.json.data.project.projectId

    const opened = await call(handler, 'POST', '/projects/open', { projectId })
    assert.equal(opened.status, 200)
    assert.equal(opened.json.data.project.title, '接口测试项目')

    const saved = await call(handler, 'POST', '/projects/position', {
      projectId,
      position: { workSurface: 'creation', playheadFrame: 0, selectedObjectId: null },
    })
    assert.equal(saved.status, 200)
    assert.ok(saved.json.data.savedAt)
  } finally {
    cleanup()
  }
})

test('validation failures use a stable code and 400, not a stack trace', async () => {
  const { handler, cleanup } = setup()
  try {
    const missing = await call(handler, 'POST', '/projects', {})
    assert.equal(missing.status, 400)
    assert.equal(missing.json.ok, false)
    assert.equal(missing.json.error.code, 'VALIDATION_FAILED')
    assert.equal(missing.json.error.message.includes('项目需要名称'), true)

    const badJson = makeResponse()
    const req = makeRequest('POST', '/projects', undefined)
    req[Symbol.asyncIterator] = async function* iterator() { yield Buffer.from('{oops') }
    await handler(req, badJson)
    assert.equal(badJson.statusCode, 400)
    assert.equal(JSON.parse(badJson.body).error.code, 'VALIDATION_FAILED')
  } finally {
    cleanup()
  }
})

test('unknown routes are 404 and refused callers are 403', async () => {
  const { service, cleanup } = setup()
  try {
    const handler = createRequestHandler({ service, authorize: () => undefined })
    const notFound = await call(handler, 'GET', '/does-not-exist')
    assert.equal(notFound.status, 404)
    assert.equal(notFound.json.error.code, 'NOT_FOUND')

    const guarded = createRequestHandler({ service, authorize: () => 403 })
    const refused = await call(guarded, 'GET', '/bootstrap')
    assert.equal(refused.status, 403)
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'FORBIDDEN')
  } finally {
    cleanup()
  }
})

test('tools and preferences endpoints answer the shapes the UI renders', async () => {
  const { handler, cleanup } = setup()
  try {
    const tools = await call(handler, 'GET', '/tools')
    assert.equal(tools.status, 200)
    assert.equal(typeof tools.json.data.available, 'boolean')
    assert.ok(Array.isArray(tools.json.data.tools))

    const prefs = await call(handler, 'GET', '/preferences')
    assert.equal(prefs.status, 200)
    assert.equal(prefs.json.data.values['creation.aspect-ratio'], '16:9')
    assert.equal(prefs.json.data.spec['creation.aspect-ratio'].kind, 'enum')

    const saved = await call(handler, 'POST', '/preferences', { key: 'creation.frame-rate', value: 25 })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.data.value, 25)
  } finally {
    cleanup()
  }
})
