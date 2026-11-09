/**
 * Host half of `dsh-plugin-control-your-video`.
 *
 * The Host half owns data and permissions; the client half owns every pixel. This file is the
 * only place that touches `ctx.webServer` and `ctx.connection`, and it cleans up through
 * `ctx.effect` (CT-01 §4: the only sanctioned teardown path).
 *
 * @module ui/host/index
 */

import { createWorkbenchService } from './service.js'
import { createRequestHandler, ROUTE_PREFIX } from './routes.js'

export const name = 'dsh-plugin-control-your-video'

/** The Host services this half genuinely injects. */
export const inject = ['webServer', 'connection']

/** Resolve DSH home through the public-ish `dshHomePath` service when the Host provides it. */
function resolveHome(ctx) {
  try {
    const homePath = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : null
    if (typeof homePath === 'function') {
      const resolved = homePath()
      if (typeof resolved === 'string' && resolved.length > 0) return resolved
    }
  } catch {
    // A missing helper is not an error: DSH_HOME / the user profile default is the documented fallback.
  }
  return undefined
}

/** Host-side request gate. Refuse when the connection service cannot vouch for the caller. */
function makeAuthorizer(ctx) {
  return (req) => {
    let connection = null
    try {
      connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
    } catch {
      connection = null
    }
    if (connection === null || typeof connection?.requestRejection !== 'function') return 403
    return connection.requestRejection({ headers: req.headers })
  }
}

export default {
  name,
  inject,
  apply(ctx) {
    const service = createWorkbenchService({ home: resolveHome(ctx) })
    const handler = createRequestHandler({ service, authorize: makeAuthorizer(ctx) })
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'ai-video-workbench: project, material, preference and tool routes',
    )
  },
}
