// AI Video Studio v0.1 host entry: HTTP routes (Workbench + media), model tools and capability wiring.
import { createReadStream, existsSync, promises as fsp, statSync } from 'node:fs'
import path from 'node:path'
import { ContractError, nowIso, type Principal } from './contract.js'
import { ProjectStore, type State, type Version } from './store.js'
import { detectCapabilities } from './capabilities.js'

export const name = 'ai-video-studio'
export const inject = ['webServer']

interface StudioConfig { dataRoot: string; allowTestChannel?: boolean; publicBase?: string }

const json = (res: any, status: number, value: unknown) => {
  const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
  res.end(body)
}
const text = (res: any, status: number, value: string, type = 'text/plain; charset=utf-8') => {
  const body = Buffer.from(value, 'utf8')
  res.writeHead(status, { 'content-type': type, 'content-length': String(body.length) })
  res.end(body)
}
async function readJsonBody(req: any): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) { size += (c as Buffer).length; if (size > 8 * 1024 * 1024) throw new ContractError('BODY_TOO_LARGE', 'body too large', 413); chunks.push(c as Buffer) }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) as Record<string, unknown> } catch { throw new ContractError('BODY_INVALID', 'request body must be JSON', 400) }
}
const errPayload = (e: unknown) => e instanceof ContractError
  ? { status: e.status, value: { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } } }
  : { status: 500, value: { error: { code: 'INTERNAL', message: String(e instanceof Error ? e.message : e) } } }

const decorate = (state: State) => {
  const base = '/studio/projects/' + state.project_id
  const versions = state.versions.map((v: Version) => ({ ...v, media_url: base + '/media/' + v.version_id, source_url: base + '/source/' + v.version_id + '?file=' + encodeURIComponent(v.source_snapshot.entry) }))
  const workBasis = state.versions.find((v) => v.version_id === state.work_basis_version_id) ?? null
  const pendingVersions = state.versions.filter((v) => v.version_id !== state.work_basis_version_id).map((v) => v.version_id)
  return {
    project: { project_id: state.project_id, title: state.title, project_revision: state.project_revision, current_version_id: state.work_basis_version_id, workspace_binding: state.workspace_binding, work_basis_version_id: state.work_basis_version_id, schema_version: state.schema_version, sessions: state.sessions, capabilities: state.capabilities },
    work_basis: workBasis,
    protection: state.versions.map((v) => ({ version_id: v.version_id, approved: state.decisions.filter((d) => d.valid && d.kind === 'partial_approval' && d.version_id === v.version_id).map((d) => d.scope), changes_requested: state.decisions.filter((d) => d.valid && d.kind === 'change_request' && d.version_id === v.version_id).map((d) => d.note) })),
    artifacts: state.artifacts,
    versions,
    decisions: state.decisions,
    jobs: state.jobs,
    creative_brief: state.creative_brief,
    next: { unadopted_versions: pendingVersions, open_change_requests: state.decisions.filter((d) => d.valid && d.kind === 'change_request').length },
    commands_count: Object.keys(state.commands).length,
    events_tail: state.events.slice(-8),
  }
}

export function apply(ctx: any, config: StudioConfig) {
  const dataRoot = path.resolve(config.dataRoot)
  const store = new ProjectStore(dataRoot, { allowTestChannel: Boolean(config.allowTestChannel) })
  const ready = store.init()
  const toolNames: string[] = []

  const admission = (req: any) => {
    const c = ctx.get('connection')
    if (!c) return { ok: false, code: 'NO_CONNECTION_SERVICE' }
    const r = c.admit(req)
    if ('rejection' in r) return { ok: false, code: 'HTTP_' + r.rejection }
    if (r.peer !== c.browserPeer) return { ok: false, code: 'NOT_BROWSER_PEER' }
    return { ok: true }
  }

  const projectCmd = async (projectId: string, body: Record<string, unknown>, principal: Principal, channel: 'ui' | 'test' | 'agent', origin: { kind: string; ref?: string }) => {
    return store.submit(projectId, {
      principal, channel, origin,
      command_id: String(body.command_id ?? ''),
      base_revision: Number(body.base_revision),
      kind: String(body.kind ?? ''),
      target: (body.target as Record<string, unknown> | undefined) ?? null,
      payload: (body.payload as Record<string, unknown> | undefined) ?? {},
    })
  }

  const handler = async (req: any, res: any) => {
    try {
      await ready
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const p = url.pathname
      const method = String(req.method ?? 'GET').toUpperCase()

      if (p === '/studio/health') return json(res, 200, { ok: true, at: nowIso(), data_root: dataRoot, tools: toolNames, allow_test_channel: store.allowTestChannel, capabilities: detectCapabilities() })
      if (p === '/studio/projects' && method === 'GET') return json(res, 200, { projects: await store.listProjects() })
      if (p === '/studio/projects/attach' && method === 'POST') {
        const body = await readJsonBody(req)
        const attached = await store.attachProject(String(body.root ?? ''))
        return json(res, 200, attached)
      }
      if (p === '/studio/projects' && method === 'POST') {
        const body = await readJsonBody(req)
        const created = await store.createProject(String(body.title ?? ''), body.workspace_path ? String(body.workspace_path) : null)
        return json(res, 200, created)
      }

      const m = /^\/studio\/projects\/([^/]+)(\/.*)?$/.exec(p)
      if (!m) return text(res, 404, 'not found')
      const projectId = decodeURIComponent(m[1] as string)
      const rest = m[2] ?? ''

      if (rest === '/state' && method === 'GET') return json(res, 200, decorate(await store.readState(projectId)))

      const media = /^\/media\/([^/]+)$/.exec(rest)
      if (media) {
        const { abs } = await store.mediaPath(projectId, decodeURIComponent(media[1] as string))
        let size: number
        try { size = statSync(abs).size } catch { return text(res, 404, 'media not found') }
        const range = req.headers?.range as string | undefined
        if (method === 'HEAD') { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(size), 'accept-ranges': 'bytes' }); return res.end() }
        if (range) {
          const rm = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (!rm) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end() }
          const start = rm[1] ? Number(rm[1]) : 0
          const end = rm[2] ? Math.min(Number(rm[2]), size - 1) : size - 1
          if (start > end || start >= size) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end() }
          res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': String(end - start + 1), 'content-range': 'bytes ' + start + '-' + end + '/' + size, 'accept-ranges': 'bytes' })
          return createReadStream(abs, { start, end }).pipe(res)
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(size), 'accept-ranges': 'bytes' })
        return createReadStream(abs).pipe(res)
      }

      const src = /^\/source\/([^/]+)$/.exec(rest)
      if (src && method === 'GET') {
        const state = await store.readState(projectId)
        const v = state.versions.find((x) => x.version_id === decodeURIComponent(src[1] as string))
        if (!v) return json(res, 404, { error: { code: 'VERSION_NOT_FOUND', message: 'version not found' } })
        const file = url.searchParams.get('file') ?? v.source_snapshot.entry
        const hit = v.source_snapshot.files.find((f) => f.rel === file)
        if (!hit) return json(res, 404, { error: { code: 'SOURCE_FILE_NOT_FOUND', message: 'source file not in the recorded snapshot' } })
        const abs = path.join(store.projectRoot(projectId), 'objects', hit.sha256 + path.extname(hit.rel))
        const buf = await fsp.readFile(abs)
        const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream'
        res.writeHead(200, { 'content-type': type, 'content-length': String(buf.length) })
        return res.end(buf)
      }

      if (rest === '/ui/decision' && method === 'POST') {
        const a = admission(req)
        if (!a.ok) throw new ContractError('UI_CHANNEL_UNTRUSTED', 'the user channel requires the authenticated Workbench browser peer: ' + a.code, 403)
        const body = await readJsonBody(req)
        const out = await projectCmd(projectId, {
          command_id: body.command_id, base_revision: body.base_revision, kind: 'decision', target: (body.target as Record<string, unknown>) ?? null,
          payload: { kind: body.decision_kind, version_id: body.version_id, scope: body.scope, note: body.note, media_ready: body.media_ready, artifact_id: body.artifact_id },
        }, 'user', 'ui', { kind: 'ui_action' })
        return json(res, 200, out)
      }
      if (rest === '/ui/intent' && method === 'POST') {
        const a = admission(req)
        if (!a.ok) throw new ContractError('UI_CHANNEL_UNTRUSTED', 'the user channel requires the authenticated Workbench browser peer: ' + a.code, 403)
        const body = await readJsonBody(req)
        const out = await projectCmd(projectId, {
          command_id: body.command_id, base_revision: body.base_revision, kind: 'intent_record', target: null,
          payload: { kind: body.intent_kind ?? 'creative_brief', artifact_id: body.artifact_id ?? null, note: body.note },
        }, 'user', 'ui', { kind: 'ui_action' })
        return json(res, 200, out)
      }
      if (rest === '/ui/render' && method === 'POST') {
        const a = admission(req)
        if (!a.ok) throw new ContractError('UI_CHANNEL_UNTRUSTED', 'the user channel requires the authenticated Workbench browser peer: ' + a.code, 403)
        const body = await readJsonBody(req)
        const out = await projectCmd(projectId, {
          command_id: body.command_id, base_revision: body.base_revision, kind: 'job_create', target: null,
          payload: { source_dir: body.source_dir, entry: body.entry ?? 'index.html', start_seconds: body.start_seconds ?? 0, duration_seconds: body.duration_seconds ?? 4, fps: body.fps ?? 30 },
        }, 'user', 'ui', { kind: 'ui_action' })
        return json(res, 200, out)
      }
      if (rest === '/ui/session' && method === 'POST') {
        const a = admission(req)
        if (!a.ok) throw new ContractError('UI_CHANNEL_UNTRUSTED', 'the user channel requires the authenticated Workbench browser peer: ' + a.code, 403)
        const body = await readJsonBody(req)
        const out = await projectCmd(projectId, {
          command_id: body.command_id, base_revision: body.base_revision, kind: 'session_bind', target: null,
          payload: { session_id: body.session_id },
        }, 'user', 'ui', { kind: 'ui_action' })
        return json(res, 200, out)
      }
      const exp = /^\/agent\/export\/([^/]+)$/.exec(rest)
      if (exp && method === 'POST') {
        const body = await readJsonBody(req)
        const state = await store.readState(projectId)
        const versionId = decodeURIComponent(exp[1] as string)
        const v = state.versions.find((x) => x.version_id === versionId)
        if (!v) return json(res, 404, { error: { code: 'VERSION_NOT_FOUND', message: 'version not found' } })
        const targetDir = String(body.target_dir ?? '')
        if (!targetDir) return json(res, 400, { error: { code: 'TARGET_DIR_REQUIRED', message: 'target_dir is required' } })
        const written = await store.exportSourceSnapshot(projectId, v, targetDir)
        return json(res, 200, written)
      }
      const fr = /^\/agent\/frames\/([^/]+)$/.exec(rest)
      if (fr && method === 'POST') {
        const body = await readJsonBody(req)
        const out = await store.extractFrame(projectId, decodeURIComponent(fr[1] as string), Number(body.seconds ?? 0), String(body.out_dir ?? ''))
        return json(res, 200, out)
      }
      if (rest === '/agent/command' && method === 'POST') {
        const body = await readJsonBody(req)
        const out = await projectCmd(projectId, body, 'agent', 'agent', { kind: 'tool_call' })
        return json(res, 200, out)
      }
      if (rest === '/jobs/cancel' && method === 'POST') {
        const body = await readJsonBody(req)
        const out = await store.cancelJob(projectId, String(body.job_id ?? ''))
        return json(res, 200, out)
      }
      return text(res, 404, 'not found')
    } catch (e) {
      const { status, value } = errPayload(e)
      json(res, status, value)
    }
  }

  if (store.allowTestChannel) {
    // dev/test only: the test channel can never produce a user decision
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/studio/test/decision', handler: async (req: any, res: any) => {
      try {
        await ready
        const body = await readJsonBody(req)
        const projectId = String(body.project_id ?? '')
        const out = await projectCmd(projectId, {
          command_id: body.command_id, base_revision: body.base_revision, kind: 'decision', target: null,
          payload: { kind: body.decision_kind, version_id: body.version_id, scope: body.scope, note: body.note, media_ready: body.media_ready, artifact_id: body.artifact_id },
        }, 'synthetic_test', 'test', { kind: 'test_action' })
        json(res, 200, out)
      } catch (e) { const { status, value } = errPayload(e); json(res, status, value) }
    } }), 'studio: test channel')
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/studio', handler }), 'studio: routes')

  // ---------- model tools ----------
  const renderJson = (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]
  const wrap = async (fn: () => Promise<Record<string, unknown>>) => {
    try { return { ok: true, ...(await fn()) } } catch (e) { return e instanceof ContractError ? { ok: false, code: e.code, message: e.message } : { ok: false, code: 'INTERNAL', message: String(e instanceof Error ? e.message : e) } }
  }
  const cmd = (projectId: string, body: Record<string, unknown>) => projectCmd(projectId, body, 'agent', 'agent', { kind: 'tool_call' })

  const tools = [
    {
      name: 'studio_project_state',
      description: 'Read one Studio project overview: current work basis, versions with measured media metadata, decisions, jobs, open change requests, capabilities and what to do next. Pass include="full" only when you need every version.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id'], properties: { project_id: { type: 'string' }, include: { type: 'string', enum: ['overview', 'full'] } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; include?: string }) {
        return wrap(async () => {
          const state = await store.readState(a.project_id)
          const full = a.include === 'full'
          return {
            project: { project_id: state.project_id, title: state.title, project_revision: state.project_revision, work_basis_version_id: state.work_basis_version_id, workspace_binding: state.workspace_binding, sessions: state.sessions },
            artifacts: state.artifacts,
            versions: (full ? state.versions : state.versions.slice(-5)).map((v) => ({ version_id: v.version_id, label: v.label, artifact_id: v.artifact_id, based_on: v.based_on, sha256: v.output.sha256, duration_seconds: v.output.duration_seconds, width: v.output.width, height: v.output.height, fps: v.output.fps, has_audio: v.output.has_audio, probe_verified: v.output.probe_verified, source_manifest_sha256: v.source_snapshot.manifest_sha256, closure_verified: v.source_snapshot.closure_verified, job_id: v.job_id, changes: v.changes })),
            decisions: state.decisions.filter((d) => d.valid).map((d) => ({ decision_id: d.decision_id, kind: d.kind, version_id: d.version_id, scope: d.scope, principal: d.principal, note: d.note, at: d.created_at })),
            open_change_requests: state.decisions.filter((d) => d.valid && d.kind === 'change_request').map((d) => ({ decision_id: d.decision_id, version_id: d.version_id, note: d.note, scope: d.scope })),
            jobs: state.jobs.slice(-5).map((j) => ({ job_id: j.job_id, status: j.status, version_id: j.version_id, error: j.error })),
            capabilities: { missing: state.capabilities.missing, browser: state.capabilities.browser.path, ffmpeg: state.capabilities.ffmpeg.path },
            next: 'adopt a version with studio_adopt_work_basis, render with studio_render_job, integrate exact child versions with studio_integrate_artifact',
          }
        })
      },
    },
    {
      name: 'studio_project_create',
      description: 'Create an independent Studio project bound to a workspace path. Returns project_id and its root directory.',
      parameters: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, workspace_path: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { title: string; workspace_path?: string }) { return wrap(async () => await store.createProject(a.title, a.workspace_path ?? null)) },
    },
    {
      name: 'studio_artifact_create',
      description: 'Create a logical artifact (scene, cut, poster, reference) inside a project. Command-based and idempotent.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'base_revision', 'title'], properties: { project_id: { type: 'string' }, base_revision: { type: 'integer' }, command_id: { type: 'string' }, title: { type: 'string' }, artifact_kind: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; base_revision: number; command_id?: string; title: string; artifact_kind?: string }) {
        return wrap(async () => await cmd(a.project_id, { command_id: a.command_id ?? 'art-' + Date.now(), base_revision: a.base_revision, kind: 'artifact_create', payload: { title: a.title, artifact_kind: a.artifact_kind ?? 'scene' } }))
      },
    },
    {
      name: 'studio_version_register',
      description: 'Register an immutable candidate version from a local MP4 plus the full editable source directory. Hashes every source file (dependency closure), probes media metadata with ffprobe and records the recipe. Does NOT change the work basis.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'base_revision', 'media_path', 'source_dir', 'label'], properties: { project_id: { type: 'string' }, base_revision: { type: 'integer' }, command_id: { type: 'string' }, media_path: { type: 'string' }, source_dir: { type: 'string' }, entry: { type: 'string' }, label: { type: 'string' }, artifact_id: { type: 'string' }, based_on: { type: 'string' }, changes_json: { type: 'string' }, external_deps_json: { type: 'string' }, recipe_params_json: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: Record<string, string | number | undefined>) {
        return wrap(async () => await cmd(String(a.project_id), {
          command_id: (a.command_id as string) ?? 'reg-' + Date.now(), base_revision: Number(a.base_revision), kind: 'version_register',
          payload: {
            media_path: a.media_path, source_dir: a.source_dir, entry: a.entry ?? 'index.html', label: a.label, probe: true,
            artifact_id: a.artifact_id, based_on: a.based_on,
            changes: a.changes_json ? JSON.parse(String(a.changes_json)) : [],
            external_deps: a.external_deps_json ? JSON.parse(String(a.external_deps_json)) : [],
            recipe_params: a.recipe_params_json ? JSON.parse(String(a.recipe_params_json)) : {},
          },
        }))
      },
    },
    {
      name: 'studio_adopt_work_basis',
      description: 'Promote an existing version to the current work basis. Does not create media and does not record any user approval.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'base_revision', 'version_id'], properties: { project_id: { type: 'string' }, base_revision: { type: 'integer' }, command_id: { type: 'string' }, version_id: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; base_revision: number; command_id?: string; version_id: string }) {
        return wrap(async () => await cmd(a.project_id, { command_id: a.command_id ?? 'adopt-' + Date.now(), base_revision: a.base_revision, kind: 'adopt_work_basis', payload: { version_id: a.version_id } }))
      },
    },
    {
      name: 'studio_integrate_artifact',
      description: 'Integrate exact child versions into one playable version. The manifest fixes each child version_id, role, order and in/out seconds; later child updates never change this integrated version.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'base_revision', 'label', 'items_json'], properties: { project_id: { type: 'string' }, base_revision: { type: 'integer' }, command_id: { type: 'string' }, artifact_id: { type: 'string' }, label: { type: 'string' }, items_json: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; base_revision: number; command_id?: string; artifact_id?: string; label: string; items_json: string }) {
        return wrap(async () => await cmd(a.project_id, { command_id: a.command_id ?? 'int-' + Date.now(), base_revision: a.base_revision, kind: 'integrate_artifact', payload: { artifact_id: a.artifact_id, label: a.label, items: JSON.parse(a.items_json) } }))
      },
    },
    {
      name: 'studio_decision_submit',
      description: 'Record an AI self-check on an exact version (the only decision kind an agent may create). User approvals and change requests can only come from the Workbench user channel.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'base_revision', 'version_id', 'scope_json'], properties: { project_id: { type: 'string' }, base_revision: { type: 'integer' }, command_id: { type: 'string' }, version_id: { type: 'string' }, scope_json: { type: 'string' }, note: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; base_revision: number; command_id?: string; version_id: string; scope_json: string; note?: string }) {
        return wrap(async () => await cmd(a.project_id, { command_id: a.command_id ?? 'dec-' + Date.now(), base_revision: a.base_revision, kind: 'decision', payload: { kind: 'ai_check', version_id: a.version_id, scope: JSON.parse(a.scope_json), note: a.note } }))
      },
    },
    {
      name: 'studio_render_job',
      description: 'Start a managed local render of an HTML scene (headless Chrome seek + FFmpeg). On success a candidate version is registered; the work basis and user approvals are untouched.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'base_revision', 'source_dir'], properties: { project_id: { type: 'string' }, base_revision: { type: 'integer' }, command_id: { type: 'string' }, source_dir: { type: 'string' }, entry: { type: 'string' }, start_seconds: { type: 'number' }, duration_seconds: { type: 'number' }, fps: { type: 'number' }, artifact_id: { type: 'string' }, based_on: { type: 'string' }, changes_json: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; base_revision: number; command_id?: string; source_dir: string; entry?: string; start_seconds?: number; duration_seconds?: number; fps?: number; artifact_id?: string; based_on?: string; changes_json?: string }) {
        return wrap(async () => await cmd(a.project_id, { command_id: a.command_id ?? 'job-' + Date.now(), base_revision: a.base_revision, kind: 'job_create', payload: { source_dir: a.source_dir, entry: a.entry ?? 'index.html', start_seconds: a.start_seconds ?? 0, duration_seconds: a.duration_seconds ?? 4, fps: a.fps ?? 30, artifact_id: a.artifact_id, based_on: a.based_on, changes: a.changes_json ? JSON.parse(a.changes_json) : [] } }))
      },
    },
    {
      name: 'studio_job_status',
      description: 'Read a job and reconcile it after a restart (a job left running becomes unknown instead of being silently re-run).',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'job_id'], properties: { project_id: { type: 'string' }, job_id: { type: 'string' }, reconcile: { type: 'boolean' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; job_id: string; reconcile?: boolean }) {
        return wrap(async () => {
          if (a.reconcile) await cmd(a.project_id, { command_id: 'recon-' + Date.now() + '-' + a.job_id, base_revision: (await store.readState(a.project_id)).project_revision, kind: 'job_reconcile', payload: { job_id: a.job_id } })
          const state = await store.readState(a.project_id)
          const job = state.jobs.find((j) => j.job_id === a.job_id)
          if (!job) throw new ContractError('JOB_NOT_FOUND', 'job not found', 404)
          return { job_id: job.job_id, status: job.status, version_id: job.version_id, output: job.output, error: job.error, reconcile_note: job.reconcile_note }
        })
      },
    },
    {
      name: 'studio_frame_extract',
      description: 'Extract one still frame of an exact version at a given second (ffmpeg) so you can look at the real output. Returns a local PNG path and its hash; it does not change project state.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'version_id', 'seconds', 'out_dir'], properties: { project_id: { type: 'string' }, version_id: { type: 'string' }, seconds: { type: 'number' }, out_dir: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; version_id: string; seconds: number; out_dir: string }) { return wrap(async () => await store.extractFrame(a.project_id, a.version_id, a.seconds, a.out_dir)) },
    },
    {
      name: 'studio_inspect_record',
      description: 'Record that you actually inspected an exact version (for example read the extracted frame). This is an ai_check-style coverage record on the version; it never creates a user decision.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'base_revision', 'version_id', 'note'], properties: { project_id: { type: 'string' }, base_revision: { type: 'integer' }, command_id: { type: 'string' }, version_id: { type: 'string' }, note: { type: 'string' }, check_kind: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; base_revision: number; command_id?: string; version_id: string; note: string; check_kind?: string }) {
        return wrap(async () => await cmd(a.project_id, { command_id: a.command_id ?? 'insp-' + Date.now(), base_revision: a.base_revision, kind: 'version_check', payload: { version_id: a.version_id, note: a.note, check_kind: a.check_kind ?? 'visual_check' } }))
      },
    },
    {
      name: 'studio_source_export',
      description: 'Materialize the exact editable source tree of a version into a directory (all files come from the content-addressed store and are hash-verified). Use it to rebuild, migrate or continue editing outside the plugin.',
      parameters: { type: 'object', additionalProperties: false, required: ['project_id', 'version_id', 'target_dir'], properties: { project_id: { type: 'string' }, version_id: { type: 'string' }, target_dir: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { project_id: string; version_id: string; target_dir: string }) {
        return wrap(async () => {
          const state = await store.readState(a.project_id)
          const v = state.versions.find((x) => x.version_id === a.version_id)
          if (!v) throw new ContractError('VERSION_NOT_FOUND', 'version not found', 404)
          return await store.exportSourceSnapshot(a.project_id, v, a.target_dir)
        })
      },
    },
    {
      name: 'studio_project_attach',
      description: 'Register an existing project directory (for example a copy moved to another authorized root) without recreating it. Validates schema and state before attaching.',
      parameters: { type: 'object', additionalProperties: false, required: ['root'], properties: { root: { type: 'string' } } },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute(a: { root: string }) { return wrap(async () => await store.attachProject(a.root)) },
    },
    {
      name: 'studio_capabilities',
      description: 'Report the local capabilities the plugin can actually use (node, ffmpeg, ffprobe, browser) and what is missing.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'object' }, render: renderJson },
      async execute() { return { ok: true, capabilities: detectCapabilities() } },
    },
  ]

  ctx.effect(() => {
    const t = ctx.get('tools')
    if (!t) return () => {}
    const disposers = tools.map((d) => { const x = t.register(d); toolNames.push(d.name); return x })
    return () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } toolNames.length = 0 }
  }, 'studio: model tools')

  ctx.logger?.info?.('studio: ready, data=' + dataRoot + ', test channel=' + String(store.allowTestChannel))
}