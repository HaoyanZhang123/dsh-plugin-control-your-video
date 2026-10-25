import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectStore } from '../lib/host/store.js'
import { ContractError } from '../lib/host/contract.js'

const root = () => mkdtempSync(path.join(tmpdir(), 'studio-test-'))
const req = (kind, payload, extra = {}) => ({ principal: 'agent', channel: 'agent', command_id: extra.command_id ?? kind + '-' + Math.random(), base_revision: extra.base_revision ?? 0, kind, payload, target: extra.target ?? null, origin: { kind: 'tool_call' } })

async function fixtureMedia(dir, name = 'clip.mp4') {
  const file = path.join(dir, name)
  // a tiny real mp4 is not needed for store-level tests: the store only records bytes it is given
  writeFileSync(file, Buffer.from('fake-mp4-bytes'))
  return file
}

test('project isolation: two projects never share state or commands', async () => {
  const store = new ProjectStore(root(), { allowTestChannel: false })
  await store.init()
  const a = await store.createProject('A', 'workspace-a')
  const b = await store.createProject('B', 'workspace-b')
  const sa = await store.readState(a.project_id)
  const r1 = await store.submit(a.project_id, req('artifact_create', { title: 'scene A', artifact_kind: 'scene' }, { base_revision: sa.project_revision }))
  assert.equal(r1.project_revision, 1)
  const sb = await store.readState(b.project_id)
  assert.equal(sb.project_revision, 0)
  assert.equal(sb.artifacts.length, 0)
  // the same command id may exist in another project (per-project namespace), but must not carry the other project's result
  const r2 = await store.submit(b.project_id, req('artifact_create', { title: 'scene B' }, { command_id: String(r1.command_id), base_revision: 0 }))
  const sa2 = await store.readState(a.project_id)
  const sb2 = await store.readState(b.project_id)
  assert.equal(sa2.artifacts.length, 1)
  assert.equal(sb2.artifacts.length, 1)
  assert.equal(sa2.artifacts[0].title, 'scene A')
  assert.equal(sb2.artifacts[0].title, 'scene B')
  assert.equal(r2.project_revision, 1)
})

test('command semantics: idempotent replay, conflict, stale base, permission before idempotency', async () => {
  const store = new ProjectStore(root(), { allowTestChannel: false })
  await store.init()
  const { project_id } = await store.createProject('C', null)
  const body = { title: 'scene' }
  const first = await store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'cmd-1', base_revision: 0, kind: 'artifact_create', payload: body, origin: { kind: 'tool_call' } })
  const replay = await store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'cmd-1', base_revision: 0, kind: 'artifact_create', payload: body, origin: { kind: 'tool_call' } })
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.artifact_id, first.artifact_id)
  await assert.rejects(() => store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'cmd-1', base_revision: 0, kind: 'artifact_create', payload: { title: 'other' }, origin: { kind: 'tool_call' } }), (e) => e.code === 'IDEMPOTENCY_CONFLICT')
  await assert.rejects(() => store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'cmd-2', base_revision: 0, kind: 'artifact_create', payload: { title: 'x' }, origin: { kind: 'tool_call' } }), (e) => e.code === 'STALE_BASE_REVISION')
  // the user channel may not run an agent-only command, and an existing key must not be replayable through it
  await assert.rejects(() => store.submit(project_id, { principal: 'user', channel: 'ui', command_id: 'cmd-1', base_revision: 0, kind: 'artifact_create', payload: body, origin: { kind: 'ui_action' } }), (e) => e.code === 'ACTOR_FORBIDDEN')
})

test('concurrency: same base revision accepts exactly one write', async () => {
  const store = new ProjectStore(root(), { allowTestChannel: false })
  await store.init()
  const { project_id } = await store.createProject('D', null)
  const results = await Promise.allSettled([
    store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'c-a', base_revision: 0, kind: 'artifact_create', payload: { title: 'a' }, origin: { kind: 'tool_call' } }),
    store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'c-b', base_revision: 0, kind: 'artifact_create', payload: { title: 'b' }, origin: { kind: 'tool_call' } }),
  ])
  const ok = results.filter((r) => r.status === 'fulfilled').length
  const conflicts = results.filter((r) => r.status === 'rejected' && r.reason.code === 'STALE_BASE_REVISION').length
  assert.equal(ok, 1)
  assert.equal(conflicts, 1)
})

test('decisions: user approval needs media_ready, agent cannot create user decisions, scope validated', async () => {
  const store = new ProjectStore(root(), { allowTestChannel: false })
  await store.init()
  const { project_id } = await store.createProject('E', null)
  const state = await store.readState(project_id)
  // register a version with a fake mp4 (probe disabled → no measured media)
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-media-'))
  const media = await fixtureMedia(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src', 'index.html'), '<html></html>')
  const reg = await store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'reg-1', base_revision: state.project_revision, kind: 'version_register', payload: { media_path: media, source_dir: path.join(dir, 'src'), entry: 'index.html', label: 'v1', probe: false }, origin: { kind: 'tool_call' } })
  const versionId = String(reg.version_id)
  await assert.rejects(() => store.submit(project_id, { principal: 'user', channel: 'ui', command_id: 'dec-1', base_revision: Number(reg.project_revision), kind: 'decision', payload: { kind: 'partial_approval', version_id: versionId, scope: { kind: 'full_version' }, media_ready: false }, origin: { kind: 'ui_action' } }), (e) => e.code === 'MEDIA_NOT_PLAYED')
  const approved = await store.submit(project_id, { principal: 'user', channel: 'ui', command_id: 'dec-1b', base_revision: Number(reg.project_revision), kind: 'decision', payload: { kind: 'partial_approval', version_id: versionId, scope: { kind: 'full_version' }, media_ready: true }, origin: { kind: 'ui_action' } })
  assert.equal(approved.valid, true)
  await assert.rejects(() => store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'dec-2', base_revision: Number(reg.project_revision), kind: 'decision', payload: { kind: 'partial_approval', version_id: versionId, scope: { kind: 'full_version' }, media_ready: true }, origin: { kind: 'tool_call' } }), (e) => e.code === 'DECISION_NOT_PERMITTED_FOR_AGENT')
  const ai = await store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'dec-3', base_revision: Number(approved.project_revision), kind: 'decision', payload: { kind: 'ai_check', version_id: versionId, scope: { kind: 'full_version' }, media_ready: true }, origin: { kind: 'tool_call' } })
  assert.match(String(ai.decision_id), /^dec-\d+$/)
  await assert.rejects(() => store.submit(project_id, { principal: 'agent', channel: 'agent', command_id: 'dec-4', base_revision: Number(ai.project_revision), kind: 'decision', payload: { kind: 'final', version_id: versionId, scope: { kind: 'full_version' } }, origin: { kind: 'tool_call' } }), (e) => e.code === 'DECISION_UNSUPPORTED')
})

test('state corruption is not silently reset', async () => {
  const dir = root()
  const store = new ProjectStore(dir, { allowTestChannel: false })
  await store.init()
  const { project_id } = await store.createProject('F', null)
  const statePath = path.join(dir, 'projects', project_id, 'state.json')
  writeFileSync(statePath, '{ broken json')
  await assert.rejects(() => store.readState(project_id), (e) => e.code === 'PROJECT_STATE_CORRUPT')
  rmSync(statePath)
  await assert.rejects(() => store.readState(project_id), (e) => e.code === 'PROJECT_STATE_MISSING')
})