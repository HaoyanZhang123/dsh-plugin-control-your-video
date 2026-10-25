// ProjectStore: per-project authoritative JSON state, single writer, atomic publish, commands,
// versions with content-addressed source closures, decisions, jobs and integrations.
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promises as fsp, existsSync } from 'node:fs'
import path from 'node:path'
import { ContractError, SCHEMA_VERSION, ADAPTER, assertDecisionAllowed, commandFingerprint, nowIso, sha256, validateScope, type Channel, type DecisionKind, type MediaMeta, type Principal, type Scope } from './contract.js'
import { detectCapabilities, type Capabilities } from './capabilities.js'
import { probeMedia } from './probe.js'

export interface IndexEntry { project_id: string; title: string; root: string; workspace_path: string | null; created_at: string; updated_at: string }
export interface IndexFile { schema_version: number; projects: IndexEntry[] }

export interface Artifact { artifact_id: string; kind: string; title: string; created_at: string }
export interface VersionOutput { media_rel: string; sha256: string; bytes: number; duration_seconds: number; width: number; height: number; fps: number; has_audio: boolean; probe_verified: boolean }
export interface SourceFile { rel: string; sha256: string; bytes: number }
export interface ExternalDep { kind: string; name: string; required: boolean; note?: string }
export interface SourceSnapshot { manifest_sha256: string; entry: string; files: SourceFile[]; external_deps: ExternalDep[]; closure_verified: boolean }
export interface Version {
  version_id: string; artifact_id: string; based_on: string | null; label: string
  output: VersionOutput; source_snapshot: SourceSnapshot
  recipe: { adapter: string; adapter_version: string; params: Record<string, unknown> }
  job_id: string | null; changes: string[]; checks: Array<{ kind: string; by: string; at: string; note?: string }>
  created_at: string; created_by_command_id: string
}
export interface Decision {
  decision_id: string; kind: DecisionKind; artifact_id: string | null; version_id: string | null
  scope: Scope; principal: Principal; channel: Channel
  origin: { kind: string; ref?: string; at: string }
  valid: boolean; supersedes: string[]; duplicate_of?: string | null; note: string | null
  media_ready: boolean; created_at: string; project_revision: number
}
export interface Job {
  job_id: string; kind: 'render' | 'integrate'; adapter: string
  request_fingerprint: string; base_revision: number; version_id: string | null
  source: { dir: string; entry: string; start_seconds: number; duration_seconds: number; fps: number; artifact_id?: string | null } | null
  snapshot: SourceSnapshot | null
  intent: { changes: string[]; based_on: string | null } | null
  budget: { attempts: number; max_seconds: number }; attempt: number
  status: 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  output: { media_rel: string; sha256: string } | null
  error: { code: string; message: string } | null
  pid: number | null; started_at: string | null; ended_at: string | null; reconcile_note: string | null
  created_at: string; created_by_command_id: string
}
export interface CommandRecord { fingerprint: string; base_revision: number; kind: string; principal: Principal; result: Record<string, unknown>; committed_at: string }
export interface StateEvent { seq: number; revision: number; kind: string; command_id: string; principal: Principal; at: string }
export interface State {
  schema_version: number; project_id: string; title: string; created_at: string; updated_at: string
  project_revision: number
  workspace_binding: { path: string | null }
  sessions: Array<{ session_id: string; first_seen_at: string }>
  artifacts: Artifact[]; versions: Version[]; decisions: Decision[]; jobs: Job[]
  work_basis_version_id: string | null
  commands: Record<string, CommandRecord>; events: StateEvent[]
  counters: { version: number; decision: number; job: number; event: number; artifact: number }
  capabilities: Capabilities
  creative_brief: Array<{ artifact_id: string | null; note: string; at: string; principal: Principal }>
}

export interface SubmitRequest {
  principal: Principal; channel: Channel
  command_id: string; base_revision: number; kind: string
  target?: Record<string, unknown> | null
  payload?: Record<string, unknown>
  origin?: { kind: string; ref?: string }
}

const writeAtomic = async (file: string, text: string) => {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.tmp-' + Math.random().toString(16).slice(2)
  await fsp.writeFile(temp, text, 'utf8')
  await fsp.rename(temp, file)
}
const readJson = async <T>(file: string): Promise<T | null> => {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) as T } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    if (e instanceof SyntaxError) throw new ContractError('PROJECT_STATE_CORRUPT', 'state file is not valid JSON: ' + file, 500)
    throw e
  }
}

export class ProjectStore {
  readonly dataRoot: string
  readonly allowTestChannel: boolean
  private chain = new Map<string, Promise<unknown>>()
  private roots = new Map<string, string>()

  constructor(dataRoot: string, options: { allowTestChannel: boolean }) {
    this.dataRoot = dataRoot
    this.allowTestChannel = options.allowTestChannel
  }
  get projectsDir() { return path.join(this.dataRoot, 'projects') }
  get indexPath() { return path.join(this.dataRoot, 'index.json') }
  projectRoot(id: string) { return this.roots.get(id) ?? path.join(this.projectsDir, id) }
  statePath(id: string) { return path.join(this.projectRoot(id), 'state.json') }
  objectsDir(id: string) { return path.join(this.projectRoot(id), 'objects') }
  jobsDir(id: string) { return path.join(this.projectRoot(id), 'jobs') }

  async init() {
    await fsp.mkdir(this.projectsDir, { recursive: true })
    const idx = await readJson<IndexFile>(this.indexPath)
    if (!idx) await writeAtomic(this.indexPath, JSON.stringify({ schema_version: SCHEMA_VERSION, projects: [] } satisfies IndexFile, null, 2))
    else for (const p of idx.projects) if (p.root) this.roots.set(p.project_id, p.root)
  }

  async listProjects(): Promise<IndexEntry[]> {
    const idx = await readJson<IndexFile>(this.indexPath)
    return idx?.projects ?? []
  }
  private async saveIndex(idx: IndexFile) { await writeAtomic(this.indexPath, JSON.stringify(idx, null, 2)) }

  async createProject(title: string, workspacePath: string | null): Promise<{ project_id: string; root: string }> {
    if (!title || !title.trim()) throw new ContractError('PROJECT_TITLE_REQUIRED', 'a project title is required', 400)
    const project_id = 'prj-' + Math.random().toString(16).slice(2, 10)
    const root = this.projectRoot(project_id)
    const exists = await readJson<State>(this.statePath(project_id))
    if (exists) throw new ContractError('PROJECT_ALREADY_EXISTS', 'project already exists', 409)
    const state: State = {
      schema_version: SCHEMA_VERSION, project_id, title: title.trim(), created_at: nowIso(), updated_at: nowIso(),
      project_revision: 0, workspace_binding: { path: workspacePath }, sessions: [],
      artifacts: [], versions: [], decisions: [], jobs: [], work_basis_version_id: null,
      commands: {}, events: [], counters: { version: 0, decision: 0, job: 0, event: 0, artifact: 0 },
      capabilities: detectCapabilities(), creative_brief: [],
    }
    await fsp.mkdir(this.objectsDir(project_id), { recursive: true })
    await fsp.mkdir(this.jobsDir(project_id), { recursive: true })
    this.roots.set(project_id, root)
    await this.publish(project_id, state)
    const idx = (await readJson<IndexFile>(this.indexPath)) ?? { schema_version: SCHEMA_VERSION, projects: [] }
    idx.projects.push({ project_id, title: state.title, root, workspace_path: workspacePath, created_at: state.created_at, updated_at: state.updated_at })
    await this.saveIndex(idx)
    return { project_id, root }
  }

  async readState(projectId: string): Promise<State> {
    const st = await readJson<State>(this.statePath(projectId))
    if (!st) {
      const idx = await this.listProjects()
      if (idx.some((p) => p.project_id === projectId)) throw new ContractError('PROJECT_STATE_MISSING', 'project is registered but its state file is missing', 500)
      throw new ContractError('PROJECT_NOT_FOUND', 'project not found: ' + projectId, 404)
    }
    if (st.schema_version !== SCHEMA_VERSION) throw new ContractError('SCHEMA_UNSUPPORTED', 'unsupported state schema_version ' + String(st.schema_version), 409)
    return st
  }

  private serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(projectId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chain.set(projectId, next.then(() => undefined, () => undefined))
    return next
  }

  private async withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const lock = path.join(this.projectRoot(projectId), '.lock')
    for (let i = 0; i < 200; i += 1) {
      try {
        await fsp.writeFile(lock, String(process.pid), { flag: 'wx' })
        try { return await fn() } finally { await fsp.rm(lock, { force: true }) }
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code !== 'EEXIST') throw e
        const holder = Number((await fsp.readFile(lock, 'utf8').catch(() => '')).trim())
        if (holder && holder !== process.pid) {
          try { process.kill(holder, 0) } catch (pe) {
            if ((pe as NodeJS.ErrnoException).code === 'ESRCH') { await fsp.rm(lock, { force: true }); continue }
          }
        }
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    throw new ContractError('PROJECT_LOCKED', 'could not acquire the write lock', 503)
  }

  async publish(projectId: string, state: State) {
    state.updated_at = nowIso()
    await writeAtomic(this.statePath(projectId), JSON.stringify(state, null, 2))
    const rev = path.join(this.projectRoot(projectId), 'state.rev-' + String(state.project_revision).padStart(4, '0') + '.json')
    await writeAtomic(rev, JSON.stringify({ project_revision: state.project_revision, work_basis_version_id: state.work_basis_version_id, versions: state.versions.length, decisions: state.decisions.length, at: nowIso() }, null, 2))
    const idx = (await readJson<IndexFile>(this.indexPath)) ?? { schema_version: SCHEMA_VERSION, projects: [] }
    const entry = idx.projects.find((p) => p.project_id === projectId)
    if (entry) { entry.updated_at = state.updated_at; entry.title = state.title }
    await this.saveIndex(idx)
  }

  // ---------- content ----------
  async putContent(projectId: string, buf: Buffer, ext: string): Promise<{ sha256: string; rel: string; bytes: number }> {
    const sha = sha256(buf)
    const rel = path.join('objects', sha + ext).split(path.sep).join('/')
    const abs = path.join(this.projectRoot(projectId), rel)
    if (!existsSync(abs)) await writeAtomic(abs, buf as unknown as string)
    return { sha256: sha, rel, bytes: buf.length }
  }
  async putFile(projectId: string, file: string, ext: string) {
    return this.putContent(projectId, await fsp.readFile(file), ext)
  }

  async mediaPath(projectId: string, versionId: string): Promise<{ abs: string; version: Version }> {
    const st = await this.readState(projectId)
    const v = st.versions.find((x) => x.version_id === versionId)
    if (!v) throw new ContractError('VERSION_NOT_FOUND', 'version not found: ' + versionId, 404)
    return { abs: path.join(this.projectRoot(projectId), v.output.media_rel), version: v }
  }

  // ---------- submit ----------
  submit(projectId: string, req: SubmitRequest): Promise<Record<string, unknown>> {
    return this.serialize(projectId, () => this.withLock(projectId, () => this.applySubmit(projectId, req)))
  }

  private async applySubmit(projectId: string, req: SubmitRequest): Promise<Record<string, unknown>> {
    if (!req.command_id) throw new ContractError('COMMAND_INVALID', 'command_id is required', 400)
    if (!Number.isInteger(req.base_revision) || req.base_revision < 0) throw new ContractError('COMMAND_INVALID', 'base_revision must be a non-negative integer', 400)
    this.assertChannel(req)
    const state = await this.readState(projectId)
    const payload = req.payload ?? {}
    const fp = commandFingerprint({ project_id: projectId, kind: req.kind, target: req.target ?? null, payload, base_revision: req.base_revision })
    await this.assertPermission(state, req)
    const prior = state.commands[req.command_id]
    if (prior) {
      if (prior.fingerprint !== fp) throw new ContractError('IDEMPOTENCY_CONFLICT', 'command_id reused with a different request', 409, { prior_command: req.command_id })
      return { ...prior.result, idempotent_replay: true }
    }
    if (req.base_revision !== state.project_revision) throw new ContractError('STALE_BASE_REVISION', 'base_revision does not match project_revision', 409, { base_revision: req.base_revision, project_revision: state.project_revision })
    const result = await this.dispatch(projectId, state, req)
    state.project_revision += 1
    state.counters.event += 1
    state.events.push({ seq: state.counters.event, revision: state.project_revision, kind: req.kind, command_id: req.command_id, principal: req.principal, at: nowIso() })
    state.commands[req.command_id] = { fingerprint: fp, base_revision: req.base_revision, kind: req.kind, principal: req.principal, result, committed_at: nowIso() }
    await this.publish(projectId, state)
    if (req.kind === 'job_create' && typeof result.job_id === 'string') void this.startJob(projectId, String(result.job_id))
    return { ...result, project_revision: state.project_revision, idempotent_replay: false }
  }

  // channel/principal consistency: principal is derived from the channel by the host, never from the client body
  private assertChannel(req: SubmitRequest) {
    const expected: Record<Channel, Principal> = { ui: 'user', test: 'synthetic_test', agent: 'agent' }
    if (req.principal !== expected[req.channel]) throw new ContractError('ACTOR_FORBIDDEN', 'principal does not match the channel', 403)
    if (req.channel === 'test' && !this.allowTestChannel) throw new ContractError('TEST_CHANNEL_DISABLED', 'the test channel is disabled in this installation', 403)
  }

  private async assertPermission(state: State, req: SubmitRequest) {
    const agentOnly = ['artifact_create', 'version_register', 'adopt_work_basis', 'integrate_artifact', 'job_create', 'job_cancel', 'job_reconcile', 'session_bind']
    const userOnly = ['intent_record']
    if (agentOnly.includes(req.kind) && req.principal !== 'agent') throw new ContractError('ACTOR_FORBIDDEN', 'this command is reserved for the agent channel', 403)
    if (userOnly.includes(req.kind) && req.principal !== 'agent') {
      // intent records may come from the user channel too (creative brief), but never from the test channel
      if (req.principal === 'synthetic_test') throw new ContractError('ACTOR_FORBIDDEN', 'the test channel may not write user intent', 403)
    }
    if (req.kind === 'decision') {
      const kind = String((req.payload ?? {}).kind ?? '') as DecisionKind
      assertDecisionAllowed(kind, req.principal)
    }
    if (req.kind === 'job_create' && state.capabilities.missing.length > 0) {
      const need = ['ffmpeg', 'ffprobe', 'browser']
      const missing = state.capabilities.missing.filter((m) => need.includes(m))
      if (missing.length) throw new ContractError('CAPABILITY_MISSING', 'render requires: ' + missing.join(', '), 400, { missing })
    }
  }

  private async dispatch(projectId: string, state: State, req: SubmitRequest): Promise<Record<string, unknown>> {
    const payload = req.payload ?? {}
    const target = req.target ?? {}
    const commandId = req.command_id
    switch (req.kind) {
      case 'artifact_create': {
        const title = String(payload.title ?? '').trim()
        if (!title) throw new ContractError('ARTIFACT_TITLE_REQUIRED', 'artifact title is required', 400)
        state.counters.artifact += 1
        const artifact: Artifact = { artifact_id: 'art-' + state.counters.artifact, kind: String(payload.artifact_kind ?? 'scene'), title, created_at: nowIso() }
        state.artifacts.push(artifact)
        return { command_id: commandId, artifact_id: artifact.artifact_id }
      }
      case 'version_register': return this.registerVersion(projectId, state, payload, commandId)
      case 'adopt_work_basis': {
        const versionId = String(payload.version_id ?? '')
        const v = state.versions.find((x) => x.version_id === versionId)
        if (!v) throw new ContractError('VERSION_NOT_FOUND', 'version not found: ' + versionId, 404)
        state.work_basis_version_id = v.version_id
        return { command_id: commandId, work_basis_version_id: v.version_id }
      }
      case 'integrate_artifact': return this.integrate(projectId, state, payload, commandId)
      case 'decision': return this.recordDecision(state, req)
      case 'version_check': {
        const versionId = String(payload.version_id ?? '')
        const v = state.versions.find((x) => x.version_id === versionId)
        if (!v) throw new ContractError('VERSION_NOT_FOUND', 'version not found: ' + versionId, 404)
        const check = { kind: String(payload.check_kind ?? 'visual_check'), by: req.principal, at: nowIso(), note: (payload.note as string) ?? undefined }
        v.checks.push(check)
        return { command_id: commandId, version_id: v.version_id, checks: v.checks.length }
      }
      case 'intent_record': {
        state.creative_brief.push({ artifact_id: (payload.artifact_id as string) ?? null, note: String(payload.note ?? ''), at: nowIso(), principal: req.principal })
        return { command_id: commandId, recorded: true }
      }
      case 'session_bind': {
        const sid = String(payload.session_id ?? '').trim()
        if (!sid) throw new ContractError('SESSION_ID_REQUIRED', 'session_id is required', 400)
        if (!state.sessions.some((s) => s.session_id === sid)) state.sessions.push({ session_id: sid, first_seen_at: nowIso() })
        return { command_id: commandId, session_id: sid }
      }
      case 'job_create': return this.createJob(projectId, state, req)
      case 'job_cancel': {
        const jobId = String(payload.job_id ?? '')
        const job = state.jobs.find((j) => j.job_id === jobId)
        if (!job) throw new ContractError('JOB_NOT_FOUND', 'job not found: ' + jobId, 404)
        return { command_id: commandId, job_id: job.job_id, status: job.status }
      }
      case 'job_reconcile': return this.reconcile(state, String(payload.job_id ?? ''))
      default:
        throw new ContractError('COMMAND_UNSUPPORTED', 'unsupported command kind: ' + req.kind, 400)
    }
  }

  private async registerVersion(projectId: string, state: State, payload: Record<string, unknown>, commandId: string): Promise<Record<string, unknown>> {
    const mediaPath = String(payload.media_path ?? '')
    const sourceDir = String(payload.source_dir ?? '')
    const entry = String(payload.entry ?? 'index.html')
    if (!mediaPath || !existsSync(mediaPath)) throw new ContractError('MEDIA_NOT_FOUND', 'media file not found: ' + mediaPath, 400)
    if (!sourceDir || !existsSync(sourceDir)) throw new ContractError('SOURCE_NOT_FOUND', 'source directory not found: ' + sourceDir, 400)
    const media = await this.putFile(projectId, mediaPath, path.extname(mediaPath) || '.mp4')
    const snapshot = await this.snapshotSource(projectId, sourceDir, entry, (payload.external_deps as ExternalDep[] | undefined) ?? [])
    const probe = payload.probe === true ? probeMedia(state.capabilities.ffprobe.path, path.join(this.projectRoot(projectId), media.rel)) : { duration_seconds: 0, width: 0, height: 0, fps: 0, has_audio: false, verified: false, error: 'probe disabled' }
    state.counters.version += 1
    const version: Version = {
      version_id: 'v' + state.counters.version,
      artifact_id: String(payload.artifact_id ?? state.artifacts[0]?.artifact_id ?? 'art-1'),
      based_on: (payload.based_on as string) ?? null,
      label: String(payload.label ?? 'version'),
      output: { media_rel: media.rel, sha256: media.sha256, bytes: media.bytes, duration_seconds: probe.duration_seconds, width: probe.width, height: probe.height, fps: probe.fps, has_audio: probe.has_audio, probe_verified: probe.verified },
      source_snapshot: snapshot,
      recipe: { adapter: ADAPTER.adapter, adapter_version: ADAPTER.adapter_version, params: (payload.recipe_params as Record<string, unknown> | undefined) ?? {} },
      job_id: (payload.job_id as string) ?? null,
      changes: (payload.changes as string[] | undefined) ?? [],
      checks: [], created_at: nowIso(), created_by_command_id: commandId,
    }
    state.versions.push(version)
    return { command_id: commandId, version_id: version.version_id, media_sha256: media.sha256, source_manifest_sha256: snapshot.manifest_sha256, probe_verified: probe.verified, closure_verified: snapshot.closure_verified }
  }

  private async integrate(projectId: string, state: State, payload: Record<string, unknown>, commandId: string): Promise<Record<string, unknown>> {
    const items = (payload.items as Array<{ version_id: string; role?: string; order?: number; in_seconds?: number; out_seconds?: number }> | undefined) ?? []
    if (!items.length) throw new ContractError('INTEGRATION_EMPTY', 'integration needs at least one exact child version', 400)
    const manifest = items.map((it, i) => {
      const child = state.versions.find((v) => v.version_id === it.version_id)
      if (!child) throw new ContractError('VERSION_NOT_FOUND', 'child version not found: ' + it.version_id, 404)
      const start = it.in_seconds ?? 0
      const end = it.out_seconds ?? child.output.duration_seconds
      if (!(start >= 0 && end > start && (child.output.duration_seconds === 0 || end <= child.output.duration_seconds + 0.001))) throw new ContractError('INTEGRATION_RANGE_INVALID', 'child range invalid for ' + it.version_id, 400)
      return { version_id: child.version_id, role: it.role ?? 'scene', order: it.order ?? i, in_seconds: start, out_seconds: end, media_rel: child.output.media_rel }
    })
    const ffmpeg = state.capabilities.ffmpeg.path
    if (!ffmpeg) throw new ContractError('CAPABILITY_MISSING', 'integrate needs ffmpeg', 400, { missing: ['ffmpeg'] })
    const jobId = 'job-' + (state.counters.job + 1)
    const outRel = 'objects/' + sha256(Buffer.from(jobId + nowIso())).slice(0, 16) + '-integration.mp4'
    const outAbs = path.join(this.projectRoot(projectId), outRel)
    const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y']
    for (const m of manifest) { args.push('-ss', String(m.in_seconds), '-t', String(m.out_seconds - m.in_seconds), '-i', path.join(this.projectRoot(projectId), m.media_rel)) }
    const filter = manifest.map((_, i) => '[' + i + ':v]').join('') + 'concat=n=' + manifest.length + ':v=1:a=0[v]'
    args.push('-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outAbs)
    const { spawnSync } = await import('node:child_process')
    const run = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 300000 })
    if (run.status !== 0) throw new ContractError('INTEGRATION_FAILED', 'ffmpeg integration failed: ' + String(run.stderr ?? '').slice(0, 400), 500)
    const probe = probeMedia(state.capabilities.ffprobe.path, outAbs)
    const buf = await fsp.readFile(outAbs)
    const stored = await this.putContent(projectId, buf, '.mp4')
    const srcManifest = { entry: 'integration.json', adapter: 'ffmpeg-concat', items: manifest }
    const srcStored = await this.putContent(projectId, Buffer.from(JSON.stringify(srcManifest, null, 2)), '.json')
    state.counters.version += 1
    const version: Version = {
      version_id: 'v' + state.counters.version,
      artifact_id: String(payload.artifact_id ?? 'art-1'), based_on: null,
      label: String(payload.label ?? 'integration'),
      output: { media_rel: stored.rel, sha256: stored.sha256, bytes: stored.bytes, duration_seconds: probe.duration_seconds, width: probe.width, height: probe.height, fps: probe.fps, has_audio: probe.has_audio, probe_verified: probe.verified },
      source_snapshot: { manifest_sha256: srcStored.sha256, entry: 'integration.json', files: [], external_deps: [], closure_verified: true },
      recipe: { adapter: 'ffmpeg-concat', adapter_version: '1', params: { items: manifest } },
      job_id: null, changes: ['integrated from exact child versions'], checks: [], created_at: nowIso(), created_by_command_id: commandId,
    }
    state.versions.push(version)
    return { command_id: commandId, version_id: version.version_id, media_sha256: stored.sha256, items: manifest }
  }

  private async recordDecision(state: State, req: SubmitRequest): Promise<Record<string, unknown>> {
    const p = req.payload ?? {}
    const kind = String(p.kind ?? '') as DecisionKind
    const versionId = String(p.version_id ?? '')
    const version = state.versions.find((v) => v.version_id === versionId)
    if (!version) throw new ContractError('VERSION_NOT_FOUND', 'version not found: ' + versionId, 404)
    const media: MediaMeta | null = version.output.probe_verified ? { duration_seconds: version.output.duration_seconds, width: version.output.width, height: version.output.height, fps: version.output.fps, has_audio: version.output.has_audio } : null
    const scope = validateScope(p.scope, media, Boolean((p.scope as Record<string, unknown> | undefined)?.end_inclusive))
    const mediaReady = Boolean(p.media_ready)
    if (kind === 'partial_approval') {
      if (!mediaReady) throw new ContractError('MEDIA_NOT_PLAYED', 'a partial approval requires the media to be loaded in the reviewing UI', 400)
      const abs = path.join(this.projectRoot(state.project_id), version.output.media_rel)
      try {
        const st = await fsp.stat(abs)
        if (st.size !== version.output.bytes) throw new ContractError('MEDIA_UNAVAILABLE', 'the recorded media does not match the version bytes', 409)
      } catch (e) {
        if (e instanceof ContractError) throw e
        throw new ContractError('MEDIA_UNAVAILABLE', 'the recorded media file is missing for this version', 409)
      }
    }
    state.counters.decision += 1
    const decision: Decision = {
      decision_id: 'dec-' + state.counters.decision, kind, artifact_id: (p.artifact_id as string) ?? version.artifact_id, version_id: version.version_id,
      scope, principal: req.principal, channel: req.channel,
      origin: { kind: req.origin?.kind ?? 'ui_action', ref: req.origin?.ref, at: nowIso() },
      valid: true, supersedes: [], note: (p.note as string) ?? null, media_ready: mediaReady,
      created_at: nowIso(), project_revision: state.project_revision + 1,
    }
    if (kind === 'withdraw') {
      const target = String((req.target as Record<string, unknown> | null)?.decision_id ?? '')
      const prev = state.decisions.find((d) => d.decision_id === target && d.version_id === version.version_id)
      if (!prev) throw new ContractError('DECISION_NOT_FOUND', 'decision to withdraw not found: ' + target, 404)
      prev.valid = false
      decision.supersedes = [prev.decision_id]
    }
    const dup = state.decisions.find((d) => d.valid && d.kind === kind && d.version_id === decision.version_id && JSON.stringify(d.scope) === JSON.stringify(scope) && d.principal === decision.principal)
    if (dup) decision.duplicate_of = dup.decision_id
    state.decisions.push(decision)
    return { command_id: req.command_id, decision_id: decision.decision_id, valid: true, duplicate_of: decision.duplicate_of ?? null }
  }

  private async createJob(projectId: string, state: State, req: SubmitRequest): Promise<Record<string, unknown>> {
    const p = req.payload ?? {}
    const sourceDir = String(p.source_dir ?? '')
    if (!sourceDir || !existsSync(sourceDir)) throw new ContractError('SOURCE_NOT_FOUND', 'source directory not found: ' + sourceDir, 400)
    const start = Number(p.start_seconds ?? 0)
    const duration = Number(p.duration_seconds ?? 0)
    const fps = Number(p.fps ?? 30)
    if (!(duration > 0 && duration <= 20)) throw new ContractError('JOB_BUDGET_INVALID', 'duration must be within (0, 20] seconds', 400)
    if (!(fps >= 24 && fps <= 30)) throw new ContractError('JOB_BUDGET_INVALID', 'fps must be within [24, 30]', 400)
    const snapshot = await this.snapshotSource(projectId, sourceDir, String(p.entry ?? 'index.html'), (p.external_deps as ExternalDep[] | undefined) ?? [])
    state.counters.job += 1
    const jobId = 'job-' + state.counters.job
    const jobDir = path.join(this.jobsDir(projectId), jobId)
    await fsp.mkdir(jobDir, { recursive: true })
    const job: Job = {
      job_id: jobId, kind: 'render', adapter: ADAPTER.adapter, request_fingerprint: sha256(Buffer.from(JSON.stringify({ projectId, jobId, start, duration, fps, sourceDir }))),
      base_revision: req.base_revision, version_id: null,
      source: { dir: sourceDir, entry: String(p.entry ?? 'index.html'), start_seconds: start, duration_seconds: duration, fps, artifact_id: (p.artifact_id as string) ?? null },
      snapshot,
      intent: { changes: (p.changes as string[] | undefined) ?? [], based_on: (p.based_on as string | undefined) ?? null },
      budget: { attempts: 1, max_seconds: Math.ceil(duration * 3 + 60) }, attempt: 0,
      status: 'queued', output: null, error: null, pid: null, started_at: null, ended_at: null, reconcile_note: null,
      created_at: nowIso(), created_by_command_id: req.command_id,
    }
    state.jobs.push(job)
    return { command_id: req.command_id, job_id: jobId, status: 'queued' }
  }

  private async startJob(projectId: string, jobId: string) {
    try {
      const state = await this.readState(projectId)
      const job = state.jobs.find((j) => j.job_id === jobId)
      if (!job || job.status !== 'queued' || !job.source) return
      if (!state.capabilities.browser.path || !state.capabilities.ffmpeg.path) {
        await this.finish(projectId, jobId, { status: 'failed', error: { code: 'CAPABILITY_MISSING', message: 'browser or ffmpeg missing' } })
        return
      }
      const dir = this.jobsDir(projectId)
      const outFile = path.join(dir, jobId + '.mp4')
      const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker', 'render-worker.mjs'),
        JSON.stringify({ html: path.join(job.source.dir, job.source.entry), browser: state.capabilities.browser.path, ffmpeg: state.capabilities.ffmpeg.path, out: outFile, start: job.source.start_seconds, duration: job.source.duration_seconds, fps: job.source.fps, work: dir })]
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const log: string[] = []
      child.stdout?.on('data', (d) => log.push(String(d)))
      child.stderr?.on('data', (d) => log.push(String(d)))
      await this.patchJob(projectId, jobId, (j) => { j.status = 'running'; j.pid = child.pid ?? null; j.started_at = nowIso(); j.attempt += 1 })
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, job.budget.max_seconds * 1000)
      child.on('close', (code) => {
        clearTimeout(timer)
        void (async () => {
          if (code === 0 && existsSync(outFile)) {
            await this.finish(projectId, jobId, { status: 'succeeded', outFile, log: log.join('') })
          } else {
            await this.finish(projectId, jobId, { status: 'failed', error: { code: 'RENDER_FAILED', message: 'worker exited with ' + String(code) + ': ' + log.join('').slice(-400) } })
          }
        })()
      })
    } catch (e) {
      await this.finish(projectId, jobId, { status: 'failed', error: { code: 'JOB_START_FAILED', message: String(e instanceof Error ? e.message : e) } })
    }
  }

  private async patchJob(projectId: string, jobId: string, fn: (j: Job) => void) {
    await this.serialize(projectId, () => this.withLock(projectId, async () => {
      const state = await this.readState(projectId)
      const job = state.jobs.find((j) => j.job_id === jobId)
      if (!job) return
      fn(job)
      // job progress is tracked by the store, but it must not advance the creative project revision
      state.counters.event += 1
      state.events.push({ seq: state.counters.event, revision: state.project_revision, kind: 'job_status', command_id: job.created_by_command_id, principal: 'agent', at: nowIso() })
      await this.publish(projectId, state)
    }))
  }

  private async finish(projectId: string, jobId: string, outcome: { status: Job['status']; outFile?: string; log?: string; error?: { code: string; message: string } }) {
    await this.serialize(projectId, () => this.withLock(projectId, async () => {
      const state = await this.readState(projectId)
      const job = state.jobs.find((j) => j.job_id === jobId)
      if (!job) return
      job.status = outcome.status
      job.ended_at = nowIso()
      job.reconcile_note = outcome.log ? outcome.log.slice(-1000) : job.reconcile_note
      if (outcome.error) job.error = outcome.error
      if (outcome.status === 'succeeded' && outcome.outFile) {
        const probe = probeMedia(state.capabilities.ffprobe.path, outcome.outFile)
        const buf = await fsp.readFile(outcome.outFile)
        const stored = await this.putContent(projectId, buf, '.mp4')
        job.output = { media_rel: stored.rel, sha256: stored.sha256 }
        state.counters.version += 1
        const version: Version = {
          version_id: 'v' + state.counters.version, artifact_id: String(job.source?.artifact_id ?? state.artifacts[0]?.artifact_id ?? 'art-1'),
          based_on: job.intent?.based_on ?? state.work_basis_version_id, label: 'render ' + job.job_id,
          output: { media_rel: stored.rel, sha256: stored.sha256, bytes: stored.bytes, duration_seconds: probe.duration_seconds, width: probe.width, height: probe.height, fps: probe.fps, has_audio: probe.has_audio, probe_verified: probe.verified },
          source_snapshot: job.snapshot ?? { manifest_sha256: sha256(Buffer.from(job.source?.dir ?? '')), entry: job.source?.entry ?? 'index.html', files: [], external_deps: [], closure_verified: false },
          recipe: { adapter: ADAPTER.adapter, adapter_version: ADAPTER.adapter_version, params: { job_id: job.job_id, fps: job.source?.fps ?? 30 } },
          job_id: job.job_id, changes: job.intent?.changes ?? [], checks: [], created_at: nowIso(), created_by_command_id: job.created_by_command_id,
        }
        state.versions.push(version)
        job.version_id = version.version_id
        state.project_revision += 1
      }
      state.counters.event += 1
      state.events.push({ seq: state.counters.event, revision: state.project_revision, kind: 'job_finish', command_id: job.created_by_command_id, principal: 'agent', at: nowIso() })
      await this.publish(projectId, state)
    }))
  }

  private async reconcile(state: State, jobId: string) {
    const job = state.jobs.find((j) => j.job_id === jobId)
    if (!job) throw new ContractError('JOB_NOT_FOUND', 'job not found: ' + jobId, 404)
    if (job.status === 'running' || job.status === 'queued' || job.status === 'preparing') {
      job.status = 'unknown'
      job.reconcile_note = 'process state unknown after restart; output verified manually before any retry'
      job.ended_at = nowIso()
    }
    return { job_id: jobId, status: job.status, version_id: job.version_id }
  }

  async extractFrame(projectId: string, versionId: string, seconds: number, outDir: string): Promise<Record<string, unknown>> {
    const state = await this.readState(projectId)
    const v = state.versions.find((x) => x.version_id === versionId)
    if (!v) throw new ContractError('VERSION_NOT_FOUND', 'version not found: ' + versionId, 404)
    const ffmpeg = state.capabilities.ffmpeg.path
    if (!ffmpeg) throw new ContractError('CAPABILITY_MISSING', 'frame extraction needs ffmpeg', 400, { missing: ['ffmpeg'] })
    if (!(seconds >= 0 && (v.output.duration_seconds === 0 || seconds <= v.output.duration_seconds))) throw new ContractError('FRAME_TIME_OUT_OF_BOUNDS', 'frame time outside the version', 400)
    const dir = path.resolve(outDir)
    await fsp.mkdir(dir, { recursive: true })
    const out = path.join(dir, versionId + '-' + seconds.toFixed(3) + '.png')
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(seconds), '-i', path.join(this.projectRoot(projectId), v.output.media_rel), '-frames:v', '1', out], { encoding: 'utf8', timeout: 60000 })
    if (r.status !== 0) throw new ContractError('FRAME_EXTRACT_FAILED', String(r.stderr ?? '').slice(0, 300), 500)
    const buf = await fsp.readFile(out)
    return { frame_path: out, frame_sha256: sha256(buf), bytes: buf.length, version_id: versionId, frame_seconds: seconds, width: v.output.width, height: v.output.height }
  }

  async snapshotSource(projectId: string, sourceDir: string, entry: string, externalDeps: ExternalDep[] = []): Promise<SourceSnapshot> {
    const files: SourceFile[] = []
    const texts = new Map<string, string>()
    const walk = async (dir: string, prefix: string) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, e.name)
        const rel = prefix ? prefix + '/' + e.name : e.name
        if (e.isDirectory()) { await walk(abs, rel); continue }
        const buf = await fsp.readFile(abs)
        const stored = await this.putContent(projectId, buf, path.extname(e.name) || '.bin')
        files.push({ rel, sha256: stored.sha256, bytes: stored.bytes })
        if (/\.(html|css)$/i.test(rel) && buf.length < 4 * 1024 * 1024) texts.set(rel, buf.toString('utf8'))
      }
    }
    await walk(sourceDir, '')
    if (!files.some((f) => f.rel === entry)) throw new ContractError('SOURCE_ENTRY_MISSING', 'entry file missing from the source snapshot: ' + entry, 400)

    // deterministic closure check: every local src/href/url() must resolve to a file inside the snapshot
    const known = new Set(files.map((f) => f.rel))
    const missing = new Set<string>()
    const refRe = /(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/g
    for (const [rel, text] of texts) {
      let m: RegExpExecArray | null
      refRe.lastIndex = 0
      while ((m = refRe.exec(text))) {
        const raw = (m[1] ?? m[2] ?? '').trim()
        if (!raw || raw.startsWith('#') || /^(https?:|data:|mailto:|javascript:|\/\/)/i.test(raw)) continue
        const clean = raw.split('?')[0]?.split('#')[0] ?? ''
        if (!clean) continue
        const dir = path.posix.dirname(rel)
        const target = path.posix.normalize(dir === '.' ? clean : dir + '/' + clean)
        if (target.startsWith('..')) { missing.add(clean); continue }
        if (!known.has(target)) missing.add(target)
      }
    }
    const deps: ExternalDep[] = [...externalDeps, ...[...missing].sort().map((name) => ({ kind: 'missing_asset', name, required: true, note: 'referenced by the snapshot but not bundled' }))]
    const manifest = { entry, adapter: ADAPTER.adapter, adapter_version: ADAPTER.adapter_version, files, external_deps: deps, closure_verified: files.length > 0 && missing.size === 0 }
    const stored = await this.putContent(projectId, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), '.json')
    return { manifest_sha256: stored.sha256, entry, files, external_deps: deps, closure_verified: files.length > 0 && missing.size === 0 }
  }

  // ---------- source export / project attach (rebuild & migration) ----------
  async exportSourceSnapshot(projectId: string, version: Version, targetDir: string): Promise<Record<string, unknown>> {
    const abs = path.resolve(targetDir)
    await fsp.mkdir(abs, { recursive: true })
    let verified = 0
    for (const f of version.source_snapshot.files) {
      const objPath = path.join(this.projectRoot(projectId), 'objects', f.sha256 + path.extname(f.rel))
      const buf = await fsp.readFile(objPath)
      const got = sha256(buf)
      if (got !== f.sha256) throw new ContractError('SOURCE_HASH_MISMATCH', 'stored object does not match the recorded hash: ' + f.rel, 500)
      const outPath = path.join(abs, ...f.rel.split('/'))
      await fsp.mkdir(path.dirname(outPath), { recursive: true })
      await fsp.writeFile(outPath, buf)
      const written = sha256(await fsp.readFile(outPath))
      if (written !== f.sha256) throw new ContractError('SOURCE_WRITE_MISMATCH', 'written file hash mismatch: ' + f.rel, 500)
      verified += 1
    }
    return { target_dir: abs, entry: version.source_snapshot.entry, files: version.source_snapshot.files.length, verified, manifest_sha256: version.source_snapshot.manifest_sha256, closure_verified: version.source_snapshot.closure_verified }
  }

  async attachProject(root: string): Promise<Record<string, unknown>> {
    if (!root) throw new ContractError('PROJECT_ROOT_REQUIRED', 'root is required', 400)
    const abs = path.resolve(root)
    const stateFile = path.join(abs, 'state.json')
    const state = await readJson<State>(stateFile)
    if (!state) throw new ContractError('PROJECT_STATE_MISSING', 'no state.json in ' + abs, 404)
    if (state.schema_version !== SCHEMA_VERSION) throw new ContractError('SCHEMA_UNSUPPORTED', 'unsupported schema_version ' + String(state.schema_version), 409)
    if (!state.project_id) throw new ContractError('PROJECT_STATE_CORRUPT', 'state has no project_id', 500)
    this.roots.set(state.project_id, abs)
    const idx = (await readJson<IndexFile>(this.indexPath)) ?? { schema_version: SCHEMA_VERSION, projects: [] }
    const existing = idx.projects.find((p) => p.project_id === state.project_id)
    if (existing) { existing.root = abs; existing.title = state.title; existing.updated_at = nowIso() }
    else idx.projects.push({ project_id: state.project_id, title: state.title, root: abs, workspace_path: state.workspace_binding.path, created_at: state.created_at, updated_at: nowIso() })
    await this.saveIndex(idx)
    return { project_id: state.project_id, root: abs, project_revision: state.project_revision, versions: state.versions.length, attached: !existing }
  }

  async cancelJob(projectId: string, jobId: string): Promise<Record<string, unknown>> {
    const state = await this.readState(projectId)
    const job = state.jobs.find((j) => j.job_id === jobId)
    if (!job) throw new ContractError('JOB_NOT_FOUND', 'job not found: ' + jobId, 404)
    if (job.pid && (job.status === 'running' || job.status === 'queued')) {
      try { process.kill(job.pid, 'SIGKILL') } catch { /* already gone */ }
      await this.patchJob(projectId, jobId, (j) => { j.status = 'cancelled'; j.ended_at = nowIso(); j.reconcile_note = 'cancelled by explicit request' })
      return { job_id: jobId, status: 'cancelled', unknown_result: false }
    }
    return { job_id: jobId, status: job.status, unknown_result: job.status === 'running' }
  }
}