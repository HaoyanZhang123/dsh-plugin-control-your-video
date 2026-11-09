/**
 * Integration tests for the workbench Host service.
 *
 * These run against a REAL temporary workbench home: C10 creates project documents, C10 writes
 * material bytes and catalogs, C10 saves the work position, C06 answers tool status. Nothing is
 * mocked except the home path (so the user's data is never touched) and the clock.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createWorkbenchService } from '../../ui/host/service.js'

function makeService() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'avw-ui-service-'))
  const service = createWorkbenchService({ home, dataRoot: path.join(home, 'data') })
  return { home, service, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('bootstrap starts empty and honest, without fake projects or waiting items', () => {
  const { service, cleanup } = makeService()
  try {
    const boot = service.bootstrap()
    assert.deepEqual(boot.projects, [])
    assert.deepEqual(boot.waiting.filter((item) => item.kind === 'waiting-user'), [])
    assert.equal(boot.latest, null)
    assert.equal(boot.effects.effects.length, 0)
    assert.match(boot.effects.note, /C15/)
    assert.ok(boot.preferences.items.length >= 13)
    assert.ok(boot.preferences.spec['creation.aspect-ratio'])
    assert.equal(boot.interfaceVersions.projectCore, '1.0.0')
  } finally {
    cleanup()
  }
})

test('create → add material → record use → save position survives a fresh read', () => {
  const { service, cleanup } = makeService()
  try {
    const created = service.createProject({ title: '45 秒机械键盘结构讲解片', idea: '冷静克制，讲清结构。' })
    const projectId = created.project.projectId
    assert.equal(created.project.phase, 'intake')

    const bytes = Buffer.from('这是一份真实的文本材料。', 'utf8')
    const added = service.addMaterial({
      projectId,
      filename: 'notes.txt',
      dataBase64: bytes.toString('base64'),
    })
    assert.equal(added.material.kind, 'text')
    assert.equal(added.material.byteSize, bytes.length)
    assert.equal(added.material.observation, 'unread')
    assert.equal(added.material.contentSha256.length, 64)

    const use = service.recordMaterialUse({ projectId, materialId: added.material.materialId, userText: '只用在开头，讲背景。' })
    assert.equal(use.use.userText, '只用在开头，讲背景。')
    assert.match(use.use.projectVersion, /^rev-[0-9a-z]{8,12}$/)

    const saved = service.savePosition({
      projectId,
      position: {
        workSurface: 'work',
        selectedObjectId: added.material.materialId,
        playheadFrame: 42,
        panelState: { rightTab: 'properties' },
      },
    })
    assert.ok(saved.savedAt)

    const opened = service.openProject(projectId)
    assert.equal(opened.materials.materials.length, 1)
    assert.equal(opened.materials.uses.length, 1)
    assert.equal(opened.position.workSurface, 'work')
    assert.equal(opened.position.playheadFrame, 42)
    assert.equal(opened.position.selectedObjectId, added.material.materialId)
    assert.ok(opened.recovery && typeof opened.recovery.canContinue === 'boolean')
    assert.equal(opened.uiState.surface, 'work')
  } finally {
    cleanup()
  }
})

test('listing and bootstrap read the real registry, newest first', () => {
  const { service, cleanup } = makeService()
  try {
    const first = service.createProject({ title: '第一个项目' })
    const second = service.createProject({ title: '第二个项目' })
    const listed = service.listProjects()
    assert.equal(listed.projects.length, 2)
    const ids = listed.projects.map((project) => project.projectId)
    assert.ok(ids.includes(first.project.projectId))
    assert.ok(ids.includes(second.project.projectId))
    assert.equal(service.bootstrap().projects.length, 2)
    assert.equal(service.bootstrap().latest.projectId, listed.projects[0].projectId)
  } finally {
    cleanup()
  }
})

test('material size limit is enforced before writing', () => {
  const { service, cleanup } = makeService()
  try {
    const created = service.createProject({ title: '大文件测试' })
    const big = Buffer.alloc(65 * 1024 * 1024, 1)
    assert.throws(() => service.addMaterial({
      projectId: created.project.projectId,
      filename: 'big.bin',
      dataBase64: big.toString('base64'),
    }), (error) => error.code === 'RESOURCE_LIMIT')
  } finally {
    cleanup()
  }
})

test('preferences resolve defaults, then the stored global value', () => {
  const { service, cleanup } = makeService()
  try {
    const before = service.preferences({})
    assert.equal(before.values['creation.aspect-ratio'], '16:9')
    assert.equal(before.sources['creation.aspect-ratio'], 'default')

    service.setPreference({ key: 'creation.aspect-ratio', value: '9:16' })
    const after = service.preferences({})
    assert.equal(after.values['creation.aspect-ratio'], '9:16')
    assert.equal(after.sources['creation.aspect-ratio'], 'global')

    assert.throws(() => service.setPreference({ key: 'data-authorization.default', value: 'always-allow' }))
  } finally {
    cleanup()
  }
})

test('assistant messages and references are saved for C13, never answered', () => {
  const { service, cleanup } = makeService()
  try {
    const created = service.createProject({ title: '引用测试' })
    const projectId = created.project.projectId
    const result = service.postAssistant({
      projectId,
      text: '开头用小样 02，标题不要动。',
      refs: [{ objectId: 'material_abc', objectLabel: '键盘实拍', versionId: 'abc123', surface: 'creation', range: null }],
    })
    assert.equal(result.message.status, 'queued-for-orchestration')
    assert.match(result.message.note, /C13/)
    const stored = service.assistant(projectId)
    assert.equal(stored.messages.length, 1)
    assert.equal(stored.messages[0].refs[0].objectLabel, '键盘实拍')
    assert.equal(service.openProject(projectId).assistant.messages.length, 1)
  } finally {
    cleanup()
  }
})

test('events are real C10 events, not UI-invented history', () => {
  const { service, cleanup } = makeService()
  try {
    const created = service.createProject({ title: '事件测试' })
    const projectId = created.project.projectId
    service.addMaterial({ projectId, filename: 'a.txt', dataBase64: Buffer.from('x').toString('base64') })
    const events = service.events(projectId, 20).events
    assert.ok(events.length >= 2)
    assert.ok(events.some((event) => /PROJECT_CREATED|project\.created|created/i.test(String(event.kind))))
  } finally {
    cleanup()
  }
})

test('import is reported as a C15 capability, not faked', () => {
  const { service, cleanup } = makeService()
  try {
    const result = service.importCheck()
    assert.equal(result.supported, false)
    assert.match(result.reason, /C15/)
  } finally {
    cleanup()
  }
})
