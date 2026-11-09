/**
 * HTTP surface for the workbench's four entries.
 *
 * The Host web server only routes; it authenticates nothing for a plugin. Every request is
 * therefore checked by the plugin's own `authorize` callback (CT-01 §5: the plug-in must own its
 * permission layer), and a refused call gets 403 without touching project data.
 *
 * Envelope: success is `{ ok: true, data }`; failure is `{ ok: false, error }` with a code that the
 * UI can branch on instead of parsing prose. No stack, no absolute path unless it is the answer the
 * user asked for (roots are shown in preferences on purpose).
 *
 * @module ui/host/routes
 */

import { ErrorCode, ValidationError, WorkbenchError, serializeError } from '../../base/index.js'

/** Prefix registered with the Host web server. */
export const ROUTE_PREFIX = '/api/ai-video-workbench'

const JSON_LIMIT_BYTES = 96 * 1024 * 1024

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

function sendError(res, error) {
  const serialized = serializeError(error)
  const status = statusFor(error)
  sendJson(res, status, { ok: false, error: serialized })
}

function statusFor(error) {
  const code = String(error?.code ?? '')
  if (code === 'VALIDATION_FAILED' || code === 'INVALID_ARGUMENT') return 400
  if (code === 'NOT_FOUND') return 404
  if (code === 'CONFLICT' || code === 'VERSION_CONFLICT') return 409
  if (code === 'FORBIDDEN' || code === 'SECURITY_DENIED') return 403
  if (code === 'RESOURCE_LIMIT') return 413
  if (code === 'ABORTED') return 499
  return 500
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > JSON_LIMIT_BYTES) {
      throw new WorkbenchError(ErrorCode.RESOURCE_LIMIT, '请求体过大', { details: { limitBytes: JSON_LIMIT_BYTES } })
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ValidationError('请求不是有效 JSON', { field: 'body' })
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`, { field })
  }
  return value
}

/**
 * @param {object} options
 * @param {object} options.service the {@link createWorkbenchService} result
 * @param {(req: import('node:http').IncomingMessage) => (number | undefined)} [options.authorize]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRequestHandler(options) {
  const { service, authorize } = options

  /** @type {Array<{method: string, path: string, run: (ctx: object) => any}>} */
  const table = [
    { method: 'GET', path: '/health', run: () => ({ ok: true, service: 'ai-video-workbench', versions: service.interfaceVersions }) },
    { method: 'GET', path: '/bootstrap', run: () => service.bootstrap() },
    { method: 'GET', path: '/projects', run: () => service.listProjects() },
    { method: 'POST', path: '/projects', run: ({ body }) => service.createProject(body) },
    { method: 'POST', path: '/projects/open', run: ({ body }) => service.openProject(requireString(body?.projectId, 'projectId')) },
    { method: 'POST', path: '/projects/position', run: ({ body }) => service.savePosition(body) },
    { method: 'POST', path: '/projects/materials', run: ({ body }) => service.addMaterial(body) },
    { method: 'POST', path: '/projects/material-use', run: ({ body }) => service.recordMaterialUse(body) },
    { method: 'POST', path: '/projects/ui-state', run: ({ body }) => service.saveUiState(body) },
    { method: 'GET', path: '/projects/ui-state', run: ({ url }) => service.readUiState(requireString(url.searchParams.get('projectId'), 'projectId')) },
    { method: 'GET', path: '/projects/assistant', run: ({ url }) => service.assistant(requireString(url.searchParams.get('projectId'), 'projectId')) },
    { method: 'POST', path: '/projects/assistant', run: ({ body }) => service.postAssistant(body) },
    { method: 'GET', path: '/projects/events', run: ({ url }) => service.events(
      requireString(url.searchParams.get('projectId'), 'projectId'),
      Number(url.searchParams.get('limit') ?? 50),
    ) },
    { method: 'GET', path: '/preferences', run: ({ url }) => service.preferences({ projectId: url.searchParams.get('projectId') ?? undefined }) },
    { method: 'POST', path: '/preferences', run: ({ body }) => service.setPreference(body) },
    { method: 'GET', path: '/tools', run: () => service.tools() },
    { method: 'GET', path: '/tools/inspect', run: ({ url }) => service.inspectTool(requireString(url.searchParams.get('toolId'), 'toolId')) },
    { method: 'GET', path: '/effects', run: () => service.effects() },
    { method: 'GET', path: '/import-check', run: () => service.importCheck() },
  ]

  return async function handle(req, res) {
    try {
      if (typeof authorize === 'function') {
        const rejection = authorize(req)
        if (rejection !== undefined && rejection !== null) {
          sendJson(res, rejection, { ok: false, error: { code: 'FORBIDDEN', message: '未授权的请求来源' } })
          return
        }
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // The Host registers a prefix route and forwards the full request URL; the table is relative
      // to that prefix, so one trim keeps route definitions independent of the mount point.
      const pathname = url.pathname.startsWith(ROUTE_PREFIX)
        ? (url.pathname.slice(ROUTE_PREFIX.length) || '/')
        : url.pathname
      const route = table.find((entry) => entry.method === req.method && entry.path === pathname)
      if (route === undefined) {
        sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `没有这个接口：${req.method} ${pathname}` } })
        return
      }
      const body = req.method === 'POST' ? await readBody(req) : {}
      const data = await route.run({ url, body, req, res })
      sendJson(res, 200, { ok: true, data })
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      sendError(res, error)
    }
  }
}
