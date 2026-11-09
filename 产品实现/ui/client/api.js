/**
 * The only HTTP client the workbench UI uses.
 *
 * Same-origin fetch to the Host half's prefix. Every failure becomes an `ApiError` carrying the
 * Host's code, so the UI can branch on a code and show the Host's own words instead of inventing a
 * friendlier story (C11 card §4.6 "真实状态").
 *
 * @module ui/client/api
 */

const API_PREFIX = '/api/ai-video-workbench'

function ApiError(code, message, details) {
  this.name = 'ApiError'
  this.code = code
  this.message = message
  this.details = details
}
ApiError.prototype = Object.create(Error.prototype)
ApiError.prototype.constructor = ApiError

async function request(path, options = {}) {
  const init = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  let response
  try {
    response = await fetch(`${API_PREFIX}${path}`, init)
  } catch (cause) {
    throw new ApiError('NETWORK', '连不上插件 Host 半：页面还在，但数据接口不可用。', { cause: String(cause?.message ?? cause) })
  }
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (response.ok === true && payload?.ok === true) return payload.data
  const error = payload?.error ?? {}
  throw new ApiError(
    error.code ?? `HTTP_${response.status}`,
    error.message ?? `请求失败（HTTP ${response.status}）`,
    error.details ?? null,
  )
}

export const Api = Object.freeze({
  bootstrap: () => request('/bootstrap'),
  projects: () => request('/projects'),
  createProject: (body) => request('/projects', { method: 'POST', body }),
  openProject: (projectId) => request('/projects/open', { method: 'POST', body: { projectId } }),
  savePosition: (body) => request('/projects/position', { method: 'POST', body }),
  addMaterial: (body) => request('/projects/materials', { method: 'POST', body }),
  recordMaterialUse: (body) => request('/projects/material-use', { method: 'POST', body }),
  saveUiState: (body) => request('/projects/ui-state', { method: 'POST', body }),
  events: (projectId, limit) => request(`/projects/events?projectId=${encodeURIComponent(projectId)}&limit=${Number(limit) || 50}`),
  preferences: (projectId) => request(projectId ? `/preferences?projectId=${encodeURIComponent(projectId)}` : '/preferences'),
  setPreference: (body) => request('/preferences', { method: 'POST', body }),
  tools: () => request('/tools'),
  inspectTool: (toolId) => request(`/tools/inspect?toolId=${encodeURIComponent(toolId)}`),
  effects: () => request('/effects'),
  importCheck: () => request('/import-check'),
  assistant: (projectId) => request(`/projects/assistant?projectId=${encodeURIComponent(projectId)}`),
  postAssistant: (body) => request('/projects/assistant', { method: 'POST', body }),
})

export { ApiError }
